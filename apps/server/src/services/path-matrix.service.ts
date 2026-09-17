import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PATH_SEVERITIES, PATH_USES, parsePathFilter, passesPathFilter } from '@fleetarr/shared';
import type {
  ArrRootFolder,
  FsDirectoriesResponse,
  PathFilter,
  PathFilterMode,
  FsRoot,
  MappingMismatch,
  PathFlag,
  PathMatrixColumn,
  PathMatrixLevel,
  PathMatrixResponse,
  PathMatrixTotals,
  PathNode,
  PathNodeKind,
  PathNodeOrigin,
  PathOwner,
  PathRollup,
  PathSelector,
  PathSeverity,
  PathUse,
} from '@fleetarr/shared';
import { isLowSpace, type LowSpaceThresholds } from '../config.js';
import type { FilesystemService } from '../fs/filesystem.service.js';
import {
  ACCESS_READ,
  ACCESS_WRITE,
  canAccess,
  describePath,
  statfsAt,
  type FilesystemSpace,
} from '../fs/paths.js';
import {
  isAtOrUnder,
  normalisePath,
  parentPath,
  type InstancePathIndex,
  type PathIndexService,
} from './path-index.service.js';

export interface PathMatrixServiceDeps {
  readonly index: PathIndexService;
  readonly filesystem: FilesystemService;
  readonly lowSpace: LowSpaceThresholds;
}

export interface PathMatrixQuery {
  /** Directories to expand. Empty means "the spine": mounts down to each root folder. */
  readonly paths?: readonly string[];
  readonly only?: readonly PathSelector[];
  /**
   * The folder filter: whitespace-separated brace patterns, expanded here rather than in
   * the browser because selection happens before anything is stat'd (see {@link assemble}).
   */
  readonly filter?: string;
  /** `exclude` inverts the filter - the negation toggle. Defaults to `include`. */
  readonly filterMode?: PathFilterMode;
  readonly limit?: number;
  readonly offset?: number;
  readonly sort?: PathSort;
  /**
   * Show only these instances' folders. Empty or absent means the whole fleet.
   *
   * Scoping happens here rather than in the browser because everything the client would
   * need to filter on is server-derived: the spine itself is built from the selected
   * instances' root folders, and `matched`, `truncated` and every rollup count come from
   * the full candidate set. A client-side filter would leave the summary row describing
   * rows it had just removed.
   */
  readonly instanceIds?: readonly number[];
  readonly refresh?: boolean;
}

export const PATH_SORTS = ['name', 'interesting'] as const;
export type PathSort = (typeof PATH_SORTS)[number];

/**
 * Per-request state that travels with the scoped index set.
 *
 * `space` is a memo, so the numbers are consistent across every level in one response and
 * a fleet on one volume pays for one statfs, not one per row.
 */
interface LevelContext {
  /** The instances in scope - already narrowed by `instanceIds`. */
  readonly indexes: readonly InstancePathIndex[];
  readonly space: SpaceResolver;
  /** True when an instance filter is on, so folders nobody selected has an opinion on drop out. */
  readonly scoped: boolean;
  /** Expanded once per request: every level is filtered by the same patterns. */
  readonly filter: PathFilter;
}

export const DEFAULT_LIMIT = 200;

/**
 * At or below this, a level is served whole with a readdir per child - which is what
 * today's explorer costs, and covers any hand-curated folder (movies, tv, downloads).
 * Above it, the level defaults to problems-only so a library is summarised, not listed.
 */
export const FULL_LEVEL_ENTRIES = 64;

/**
 * How long a walked directory list stays good for. Short, because the pickers fed by it
 * also stage `fs.mkdir`: a folder created through Fleetarr should appear in the next
 * dialog rather than after a page reload, and re-walking a tree of names is cheap.
 */
const DIRECTORY_CACHE_MS = 60_000;

/** What a level knows about one child before anything is stat'd. */
interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly origin: PathNodeOrigin;
  readonly kind: PathNodeKind;
  readonly exists: boolean;
  readonly inScope: boolean;
  /** Media at or under it, summed across reachable instances. */
  readonly mediaUnder: number;
  /** Only known once a node has been probed; null before that. */
  readonly childCountHint: number | null;
  readonly isRootFolder: boolean;
  /** At least one reachable instance in scope has no root folder here. */
  readonly canAddRootFolder: boolean;
  readonly insideRootFolder: boolean;
  readonly containsRootFolder: boolean;
}

/**
 * Joins disk truth to *Arr truth, one directory level at a time.
 *
 * The rule that makes this affordable: `only`, `filter` and `limit` are applied BEFORE
 * any per-child stat. Selecting from the dirent list plus the index costs one readdir,
 * so an 812-entry library is summarised for the price of one syscall and only the
 * handful of rows actually returned are ever probed.
 */
export class PathMatrixService {
  /** Walked trees, keyed by subtree. Short-lived: a folder made elsewhere should show up. */
  private readonly directoryWalks = new Map<string, { at: number; value: FsDirectoriesResponse }>();

  constructor(private readonly deps: PathMatrixServiceDeps) {}

  async matrix(query: PathMatrixQuery = {}): Promise<PathMatrixResponse> {
    const rootsResponse = this.deps.filesystem.roots();
    const indexes = await this.deps.index.index({ refresh: query.refresh === true });
    const scannedAt = new Date().toISOString();

    if (!rootsResponse.enabled) {
      return {
        enabled: false,
        scannedAt,
        roots: rootsResponse.roots,
        columns: this.columns(indexes),
        levels: [],
        totals: emptyTotals(),
        mismatches: [],
      };
    }

    // `columns` and `mismatches` always describe the whole fleet: the filter bar has to
    // keep listing every instance, and a volume mapping difference is not a per-selection
    // fact. Everything that shapes the tree uses the scoped set.
    const wanted = query.instanceIds ?? [];
    const ctx: LevelContext = {
      indexes: wanted.length > 0
        ? indexes.filter((index) => wanted.includes(index.instanceId))
        : indexes,
      space: new SpaceResolver(rootsResponse.roots),
      scoped: wanted.length > 0,
      filter: parsePathFilter(query.filter ?? '', query.filterMode ?? 'include'),
    };

    const requested = (query.paths ?? []).map((entry) => normalisePath(entry));
    const targets = requested.length > 0 ? requested : this.spine(ctx.indexes);

    const levels = await Promise.all(targets.map((target) => this.level(target, ctx, query)));

    // The synthetic top level carries the mounts and the paths this container cannot
    // see, so an unmapped root folder is a row rather than a footnote.
    const topLevel = requested.length > 0 ? null : await this.topLevel(ctx, query);

    return {
      enabled: true,
      scannedAt,
      roots: rootsResponse.roots,
      columns: this.columns(indexes),
      levels: topLevel === null ? levels : [topLevel, ...levels],
      totals: this.totals(indexes, [...(topLevel === null ? [] : [topLevel]), ...levels]),
      mismatches: this.mismatches(indexes),
    };
  }

  /**
   * Every directory a picker may offer, walked once and cached.
   *
   * Separate from `matrix` on purpose. The matrix answers "what is going on in this
   * folder", which is why it summarises a big level down to its problems and stops at 200
   * rows - both right for reading a fleet, and both the reason a destination field built
   * on it showed a handful of folders out of hundreds. This answers "where could this go",
   * so it walks the whole tree and returns nothing but names.
   *
   * The one policy it shares: a root folder is a leaf. Below one lies the library, and
   * offering ten thousand media folders as destinations would bury the folders that are.
   */
  async directories(query: { under?: string; limit?: number; refresh?: boolean } = {}): Promise<FsDirectoriesResponse> {
    const rootsResponse = this.deps.filesystem.roots();
    const scannedAt = new Date().toISOString();
    const under = query.under === undefined ? null : normalisePath(query.under);

    if (!rootsResponse.enabled) return { under, directories: [], truncated: false, scannedAt };

    const cacheKey = `${under ?? ''} ${String(query.limit ?? 0)}`;
    const cached = this.directoryWalks.get(cacheKey);
    if (query.refresh !== true && cached !== undefined && Date.now() - cached.at < DIRECTORY_CACHE_MS) {
      return cached.value;
    }

    const indexes = await this.deps.index.index({ refresh: query.refresh === true });
    const stopAt = (directory: string): boolean => isRootFolderPath(directory, indexes);
    const targets =
      under === null ? rootsResponse.roots.filter((root) => root.exists).map((root) => root.path) : [under];

    const found = new Set<string>();
    let truncated = false;
    for (const target of targets) {
      // A mount is itself a destination, and a root folder at one is a leaf we still list.
      found.add(target);
      const walk = await this.deps.filesystem.walkDirectories(target, {
        stopAt,
        ...(query.limit === undefined ? {} : { maxEntries: query.limit }),
      });
      for (const directory of walk.directories) found.add(directory);
      if (walk.truncated) truncated = true;
    }

    const value: FsDirectoriesResponse = {
      under,
      directories: [...found].sort((left, right) => left.localeCompare(right)),
      truncated,
      scannedAt,
    };
    this.directoryWalks.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  // ------------------------------------------------------------------ one level

  private async level(
    target: string,
    ctx: LevelContext,
    query: PathMatrixQuery,
  ): Promise<PathMatrixLevel> {
    const resolved = await this.deps.filesystem.guard.resolve(target);
    let candidates: Candidate[];
    let error: string | null = null;

    if (isRootFolderPath(resolved, ctx.indexes)) {
      // Expansion stops at a root folder. Below it is the library - hundreds of media
      // folders this view does not manage - and reading them is the expensive part.
      candidates = [];
    } else {
      try {
        candidates = await this.candidatesOf(resolved, ctx);
      } catch (caught) {
        candidates = [];
        error = caught instanceof Error ? caught.message : 'Could not read this directory';
      }
    }

    return this.assemble(resolved, candidates, ctx, query, { error });
  }

  /** The mounts, plus every *Arr root folder this container cannot see. */
  private async topLevel(ctx: LevelContext, query: PathMatrixQuery): Promise<PathMatrixLevel> {
    const mounts = this.deps.filesystem.roots().roots.map((root) => root.path);
    const unseen = this.unseenRootFolders(ctx.indexes);

    const candidates: Candidate[] = [
      ...mounts.map((mount) => this.classify(mount, ctx, {
        origin: 'disk',
        kind: 'directory',
        exists: true,
        inScope: true,
      })),
      ...unseen.map((folder) => this.classify(folder, ctx, {
        origin: 'arr',
        kind: 'directory',
        exists: false,
        inScope: false,
      })),
    ];

    return this.assemble(null, candidates, ctx, query, { error: null });
  }

  private async assemble(
    levelPath: string | null,
    candidates: readonly Candidate[],
    ctx: LevelContext,
    query: PathMatrixQuery,
    context: { error: string | null },
  ): Promise<PathMatrixLevel> {
    const rollup = rollupOf(candidates, ctx.indexes, levelPath);

    // Small levels behave exactly like the old explorer: everything, fully probed.
    const small = candidates.length <= FULL_LEVEL_ENTRIES;
    // Naming folders is an explicit request for them, whatever state they are in: a
    // pattern must never be ANDed with the "problems only" default and come back empty.
    // Excluding is not such a request - it says nothing about the rows it leaves behind -
    // so a big level stays summarised there.
    const named = ctx.filter.active && ctx.filter.mode === 'include';
    const selectors = query.only ?? (small || named ? ['all'] : ['problems']);
    const wantsProbe = small || selectors.some((s) => s === 'empty' || s === 'unreadable');

    // do not reorder: selecting before probing is the whole performance story.
    const matched = candidates.filter((candidate) => {
      // A mount, and anything with a root folder below it, is how the tree reaches the
      // folders a pattern names - a pattern starting deeper says nothing about them.
      const navigable = (levelPath === null && candidate.inScope) || candidate.containsRootFolder;
      if (!passesPathFilter(ctx.filter, candidate.path, { navigable })) return false;
      if (ctx.scoped && !inScopedTree(candidate)) return false;
      return selectors.some((selector) => matchesSelector(candidate, selector));
    });

    const sorted = sortCandidates(matched, query.sort ?? 'name');
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(1000, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const page = sorted.slice(offset, offset + limit);

    const nodes = await Promise.all(
      page.map((candidate) => this.enrich(candidate, ctx, { probe: wantsProbe })),
    );

    return {
      path: levelPath,
      parent: levelPath === null ? null : this.parentInScope(levelPath),
      nodes,
      rollup,
      selection: selectors,
      matched: matched.length,
      offset,
      limit,
      truncated: matched.length > offset + nodes.length,
      childCountsResolved: wantsProbe,
      error: context.error,
    };
  }

  // -------------------------------------------------------------- candidates

  /** One readdir, plus the *Arr children the index already knows about. */
  private async candidatesOf(target: string, ctx: LevelContext): Promise<Candidate[]> {
    const dirents = await readdir(target, { withFileTypes: true });
    const seen = new Set<string>();
    const candidates: Candidate[] = [];

    for (const dirent of dirents) {
      const child = path.join(target, dirent.name);
      seen.add(child);
      candidates.push(
        this.classify(child, ctx, {
          origin: 'disk',
          kind: kindOf(dirent),
          exists: true,
          inScope: true,
        }),
      );
    }

    // *Arr paths that should be here and are not - shown in tree position, at any depth.
    //
    // Only paths an instance holds *files* for count. A monitored film nobody has
    // downloaded yet has a path that is meant not to exist; surfacing those would bury
    // the real signal under every unreleased title in the library.
    for (const index of ctx.indexes) {
      if (!index.reachable) continue;
      for (const child of index.childrenByParent.get(normalisePath(target)) ?? []) {
        if (seen.has(child)) continue;
        if (index.mediaAt.has(child) && !index.mediaWithFiles.has(child)) continue;
        seen.add(child);
        candidates.push(
          this.classify(child, ctx, {
            origin: 'arr',
            kind: 'directory',
            exists: false,
            inScope: true,
          }),
        );
      }
    }

    return candidates;
  }

  /** Everything derivable from the index alone - no syscall. */
  private classify(
    target: string,
    ctx: LevelContext,
    facts: { origin: PathNodeOrigin; kind: PathNodeKind; exists: boolean; inScope: boolean },
  ): Candidate {
    const normalised = normalisePath(target);
    const reachable = ctx.indexes.filter((index) => index.reachable);

    const rootFolderOn = reachable.filter((index) => index.rootFolders.has(normalised));
    const mediaUnder = reachable.reduce(
      (sum, index) => sum + (index.mediaUnder.get(normalised) ?? 0),
      0,
    );


    const knownToArr =
      rootFolderOn.length > 0 || reachable.some((index) => index.mediaAt.has(normalised));

    return {
      path: normalised,
      name: path.basename(normalised) || normalised,
      origin: facts.exists ? (knownToArr ? 'both' : 'disk') : 'arr',
      kind: facts.kind,
      exists: facts.exists,
      inScope: facts.inScope,
      mediaUnder,
      childCountHint: null,
      isRootFolder: rootFolderOn.length > 0,
      // A directory an instance could root at but does not. True for a media folder deep
      // inside a root folder too - the same latitude the old per-cell "click a gap to add
      // one here" had, so this is not a new footgun.
      canAddRootFolder:
        facts.exists &&
        facts.inScope &&
        facts.kind === 'directory' &&
        reachable.some((index) => !index.rootFolders.has(normalised)),
      insideRootFolder: reachable.some((index) =>
        index.rootFolderPrefixes.some(
          (prefix) => prefix !== normalised && isAtOrUnder(normalised, prefix),
        ),
      ),
      containsRootFolder: reachable.some((index) =>
        index.rootFolderPrefixes.some(
          (prefix) => prefix !== normalised && isAtOrUnder(prefix, normalised),
        ),
      ),
    };
  }

  // ---------------------------------------------------------------- enrichment

  /** The only place a per-child syscall happens, and only for rows being returned. */
  private async enrich(
    candidate: Candidate,
    ctx: LevelContext,
    options: { probe: boolean },
  ): Promise<PathNode> {
    const base = this.baseNode(candidate, ctx);
    if (!candidate.exists || !candidate.inScope || !options.probe) return base;

    // Counting a root folder's children means reading a directory with hundreds of media
    // folders in it, and the answer is now unusable: a root folder never expands. The
    // instances already report how many items they track under it, for free.
    const countable = candidate.kind === 'directory' && !candidate.isRootFolder;

    const [stats, readable, writable, childCount] = await Promise.all([
      describePath(candidate.path),
      canAccess(candidate.path, ACCESS_READ),
      canAccess(candidate.path, ACCESS_WRITE),
      countable ? countChildren(candidate.path) : Promise.resolve(null),
    ]);

    const measurement = this.deps.filesystem.cachedMeasurement(candidate.path);
    // Probed, so there is a device id to key the memo on: one statfs per filesystem per
    // request, and none at all when every row sits on the mount that seeded it.
    const space = await ctx.space.forDevice(stats.deviceId, candidate.path);

    const flags = this.flagsFor(candidate, { childCount, readable, writable });
    const lowSpace = this.lowSpaceFor(candidate, space);

    return {
      ...base,
      exists: stats.exists,
      modifiedAt: stats.modifiedAt,
      childCount,
      readable,
      writable,
      deviceId: stats.deviceId,
      freeSpace: space.freeSpace,
      totalSpace: space.totalSpace,
      lowSpace,
      sizeOnDisk: measurement?.sizeOnDisk ?? (candidate.kind === 'file' ? stats.size : null),
      flags,
      severity: severityOf(flags, base.owners, lowSpace),
      expandable: expandableOf(candidate, childCount),
    };
  }

  private baseNode(
    candidate: Candidate,
    ctx: LevelContext,
  ): PathNode {
    // Not probed, so there is no device id yet: inherit the containing mount's numbers.
    // A nested bind-mount below a mount therefore reports the outer filesystem until the
    // row is probed - honest for the spine, which is always probed.
    const space = this.mountSpaceFor(candidate.path);
    const owners = this.ownersFor(candidate, ctx.indexes);
    const flags = this.flagsFor(candidate, { childCount: null, readable: true, writable: true });
    const lowSpace = this.lowSpaceFor(candidate, space);

    return {
      path: candidate.path,
      name: candidate.name,
      origin: candidate.origin,
      exists: candidate.exists,
      kind: candidate.kind,
      inScope: candidate.inScope,
      modifiedAt: null,
      childCount: null,
      readable: candidate.exists,
      writable: false,
      deviceId: null,
      freeSpace: space.freeSpace,
      totalSpace: space.totalSpace,
      lowSpace,
      sizeOnDisk: this.deps.filesystem.cachedMeasurement(candidate.path)?.sizeOnDisk ?? null,
      error: null,
      owners,
      flags,
      severity: severityOf(flags, owners, lowSpace),
      canAddRootFolder: candidate.canAddRootFolder,
      rollup: null,
      expandable: expandableOf(candidate, candidate.childCountHint),
    };
  }

  /** The mount this path sits under, for a row that was never stat'd. */
  private mountSpaceFor(target: string): FilesystemSpace {
    const root = this.deps.filesystem.guard.rootFor(target);
    if (root === null) return { freeSpace: null, totalSpace: null };
    const mount = this.deps.filesystem
      .roots()
      .roots.find((entry) => entry.path === root.configured);
    return { freeSpace: mount?.freeSpace ?? null, totalSpace: mount?.totalSpace ?? null };
  }

  /**
   * Only a mount or a root folder carries the warning.
   *
   * Every row under a root folder shares its filesystem, so flagging them all would paint
   * a whole library amber and tell you nothing you could act on.
   */
  private lowSpaceFor(candidate: Candidate, space: FilesystemSpace): boolean {
    const decisive = candidate.isRootFolder || this.deps.filesystem.guard.isRoot(candidate.path);
    if (!decisive) return false;
    return isLowSpace(space.freeSpace, space.totalSpace, this.deps.lowSpace);
  }

  // -------------------------------------------------------------------- owners

  /**
   * The instances that use this path, and everything the owner card states about each.
   *
   * "Use" is deliberately wider than "something of yours sits at exactly this path". A
   * parent folder is in use by every instance that roots *below* it, whether or not a
   * single item has been downloaded yet - a fresh library with no media would otherwise
   * report no owner at all, which is the one thing this column must never say wrongly.
   *
   * An unreachable instance is skipped entirely rather than contributing an `unknown`
   * entry: it is never an owner, and the response says so once, in `columns`.
   */
  private ownersFor(
    candidate: Candidate,
    indexes: readonly InstancePathIndex[],
  ): readonly PathOwner[] {
    const owners: PathOwner[] = [];

    for (const index of indexes) {
      if (!index.reachable) continue;

      const folder: ArrRootFolder | undefined = index.rootFolders.get(candidate.path);
      const title = index.mediaAt.get(candidate.path) ?? null;
      const mediaUnder = index.mediaUnder.get(candidate.path) ?? 0;
      // A linear scan over one instance's root folders, which are a handful of paths -
      // and only for the rows actually returned, never for the whole candidate set.
      const rootFoldersUnder = index.rootFolderPrefixes
        .filter((prefix) => prefix !== candidate.path && isAtOrUnder(prefix, candidate.path))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .map((path) => ({ id: index.rootFolders.get(path)?.id ?? 0, path }));
      // Named, and including the ones aimed below: the card lists them, because a list
      // is what refills a folder after it is pruned or re-pointed.
      const importLists = index.importLists.filter((list) =>
        isAtOrUnder(list.path, candidate.path),
      );

      const use: PathUse | null =
        folder !== undefined
          ? 'rootFolder'
          : title !== null
            ? 'tracked'
            : rootFoldersUnder.length > 0
              ? 'containsRoot'
              : mediaUnder > 0
                ? 'ancestor'
                // Only a list aimed at *exactly* this folder is a claim on it. One aimed
                // below says something about that folder, not about this one.
                : importLists.some((list) => list.path === candidate.path)
                  ? 'importList'
                  : null;
      if (use === null) continue;

      owners.push({
        instanceId: index.instanceId,
        name: index.name,
        kind: index.kind,
        use,
        rootFolderId: folder?.id ?? null,
        accessible: folder?.accessible ?? null,
        mediaUnder,
        mediaWithFiles: index.mediaWithFilesUnder.get(candidate.path) ?? 0,
        title,
        rootFoldersUnder,
        importLists,
        freeSpace: folder?.freeSpace ?? null,
        totalSpace: folder?.totalSpace ?? null,
      });
    }

    // The decisive claim leads, so a row's first chip is the one its actions apply to.
    return owners.sort((a, b) => PATH_USES.indexOf(b.use) - PATH_USES.indexOf(a.use));
  }

  // --------------------------------------------------------------------- flags

  private flagsFor(
    candidate: Candidate,
    probe: { childCount: number | null; readable: boolean; writable: boolean },
  ): readonly PathFlag[] {
    const flags: PathFlag[] = [];

    if (this.deps.filesystem.guard.isRoot(candidate.path)) flags.push('mount');
    if (candidate.isRootFolder) flags.push('rootFolder');

    if (!candidate.inScope) flags.push('unseen');
    else if (!candidate.exists) flags.push('missing');

    if (candidate.exists && candidate.inScope && candidate.kind !== 'file') {
      if (!candidate.isRootFolder && candidate.insideRootFolder && candidate.mediaUnder === 0) {
        flags.push('untracked');
      }
      // Media under here is managed if any root folder sits at, above, or below this
      // path; only a folder unrelated to every root folder is genuinely unmanaged.
      if (
        candidate.mediaUnder > 0 &&
        !candidate.isRootFolder &&
        !candidate.insideRootFolder &&
        !candidate.containsRootFolder
      ) {
        flags.push('unmanaged');
      }
      if (probe.childCount === 0) flags.push('empty');
      if (!probe.readable) flags.push('unreadable');
      else if (!probe.writable) flags.push('readOnly');
    }

    if (candidate.kind === 'symlink') flags.push('symlink');

    return flags;
  }

  // ------------------------------------------------------------------ overview

  /** Mounts, plus the directory chain down to each root folder inside them. */
  private spine(indexes: readonly InstancePathIndex[]): string[] {
    const guard = this.deps.filesystem.guard;
    const mounts = this.deps.filesystem.rootPaths;
    const spine = new Set(mounts);
    const rootFolders = new Set(this.rootFolderPaths(indexes));

    for (const folder of rootFolders) {
      if (guard.rootFor(folder) === null) continue;
      // Every strict ancestor between the mount and the root folder, so the tree connects.
      let current = parentPath(folder);
      while (current !== null && guard.rootFor(current) !== null) {
        spine.add(current);
        current = parentPath(current);
      }
    }

    // A root folder is where expansion stops: below it lies the library.
    return [...spine].filter((entry) => !rootFolders.has(entry)).sort();
  }

  private rootFolderPaths(indexes: readonly InstancePathIndex[]): string[] {
    const paths = new Set<string>();
    for (const index of indexes) {
      if (!index.reachable) continue;
      for (const folder of index.rootFolders.keys()) paths.add(folder);
    }
    return [...paths];
  }

  private unseenRootFolders(indexes: readonly InstancePathIndex[]): string[] {
    return this.rootFolderPaths(indexes)
      .filter((folder) => this.deps.filesystem.guard.rootFor(folder) === null)
      .sort();
  }

  private parentInScope(target: string): string | null {
    if (this.deps.filesystem.guard.isRoot(target)) return null;
    const parent = parentPath(target);
    return parent !== null && this.deps.filesystem.guard.rootFor(parent) !== null ? parent : null;
  }

  private columns(indexes: readonly InstancePathIndex[]): readonly PathMatrixColumn[] {
    const guard = this.deps.filesystem.guard;
    return indexes.map((index) => ({
      instanceId: index.instanceId,
      name: index.name,
      kind: index.kind,
      reachable: index.reachable,
      error: index.error,
      fetchedAt: index.fetchedAt,
      rootFolderCount: index.rootFolders.size,
      mediaPathCount: index.mediaAt.size,
      unseenRootFolders: [...index.rootFolders.keys()]
        .filter((folder) => guard.enabled && guard.rootFor(folder) === null)
        .sort(),
    }));
  }

  /**
   * An instance none of whose paths exist here has a volume mapping difference, not
   * missing media. Reported as such, exactly as the reconcile report did.
   */
  private mismatches(indexes: readonly InstancePathIndex[]): readonly MappingMismatch[] {
    const guard = this.deps.filesystem.guard;
    const checkedRoots = this.deps.filesystem.rootPaths;

    return indexes
      .filter((index) => {
        if (!index.reachable || index.mediaAt.size === 0) return false;
        return [...index.rootFolders.keys()].every((folder) => guard.rootFor(folder) === null);
      })
      .map((index) => ({
        instanceId: index.instanceId,
        reportedPaths: [...index.rootFolders.keys()].sort(),
        checkedRoots,
        mediaPathCount: index.mediaAt.size,
      }));
  }

  private totals(
    indexes: readonly InstancePathIndex[],
    levels: readonly PathMatrixLevel[],
  ): PathMatrixTotals {
    const reachable = indexes.filter((index) => index.reachable);
    const rootFolders = this.rootFolderPaths(indexes);

    // Summed from the levels actually read: honest about being a view, not a full walk.
    const sum = (pick: (rollup: PathRollup) => number): number =>
      levels.reduce((total, level) => total + pick(level.rollup), 0);

    // Exact and free: a media path that sits under none of its own instance's root
    // folders is unmanaged whatever the disk looks like. Counted as distinct paths.
    const unmanaged = new Set<string>();
    for (const index of reachable) {
      for (const mediaPath of index.mediaAt.keys()) {
        const rooted = index.rootFolderPrefixes.some((prefix) => isAtOrUnder(mediaPath, prefix));
        if (!rooted) unmanaged.add(mediaPath);
      }
    }

    return {
      rootFolderPaths: rootFolders.length,
      unseenRootFolders: this.unseenRootFolders(indexes).length,
      untracked: sum((rollup) => rollup.untracked),
      missing: sum((rollup) => rollup.missing),
      unmanaged: unmanaged.size,
    };
  }
}

/**
 * Free/total space per filesystem, memoised for one request.
 *
 * Promises, not values: `enrich` runs the whole page under `Promise.all`, so two rows on
 * one filesystem must share a single in-flight statfs rather than race to issue two.
 */
class SpaceResolver {
  private readonly byDevice = new Map<string, Promise<FilesystemSpace>>();

  constructor(roots: readonly FsRoot[]) {
    // The mounts are already probed, so the normal single-`/data`-volume layout answers
    // every row for free.
    for (const root of roots) {
      if (root.deviceId === null) continue;
      this.byDevice.set(root.deviceId, Promise.resolve({
        freeSpace: root.freeSpace,
        totalSpace: root.totalSpace,
      }));
    }
  }

  forDevice(deviceId: string | null, target: string): Promise<FilesystemSpace> {
    if (deviceId === null) return statfsAt(target);
    const known = this.byDevice.get(deviceId);
    if (known !== undefined) return known;

    const pending = statfsAt(target);
    this.byDevice.set(deviceId, pending);
    return pending;
  }
}

// ----------------------------------------------------------------- pure helpers

/**
 * The worst thing known about a path.
 *
 * `untracked` is deliberately only `info`: it fires on every non-media folder inside a
 * root folder, so promoting it would paint a healthy library amber and destroy the signal
 * `unmanaged` carries. That is the question this view exists to answer, so it is what
 * `warn` means here.
 */
export function severityOf(
  flags: readonly PathFlag[],
  owners: readonly PathOwner[],
  lowSpace: boolean,
): PathSeverity {
  const has = (flag: PathFlag): boolean => flags.includes(flag);

  if (has('unseen') || has('missing') || has('unreadable')) return 'error';
  if (has('unmanaged') || has('readOnly') || lowSpace) return 'warn';
  if (owners.some((owner) => owner.use === 'rootFolder' && owner.accessible === false)) return 'warn';
  if (has('untracked') || has('empty') || has('symlink')) return 'info';
  return 'ok';
}

/** The worst severity in a set - `PATH_SEVERITIES` is ordered, so this is a max. */
export function worstSeverity(severities: readonly PathSeverity[]): PathSeverity {
  return severities.reduce<PathSeverity>(
    (worst, entry) => (PATH_SEVERITIES.indexOf(entry) > PATH_SEVERITIES.indexOf(worst) ? entry : worst),
    'ok',
  );
}

/**
 * With an instance filter on, a folder none of the selected instances has an opinion about
 * is not in their tree at all.
 *
 * `containsRootFolder` is what keeps `/data` and `/data/media` visible when the selection
 * roots four levels down - without it the tree could not connect to its own leaves.
 */
function inScopedTree(candidate: Candidate): boolean {
  return (
    candidate.isRootFolder ||
    candidate.insideRootFolder ||
    candidate.containsRootFolder ||
    candidate.mediaUnder > 0
  );
}

/**
 * A root folder is a leaf. Its children are media folders, which this view neither
 * manages nor wants to pay a readdir for.
 */
function expandableOf(candidate: Candidate, childCount: number | null): boolean {
  if (candidate.kind !== 'directory' || !candidate.exists || !candidate.inScope) return false;
  if (candidate.isRootFolder) return false;
  return childCount !== 0;
}

function isRootFolderPath(target: string, indexes: readonly InstancePathIndex[]): boolean {
  const normalised = normalisePath(target);
  return indexes.some((index) => index.reachable && index.rootFolders.has(normalised));
}

function kindOf(dirent: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): PathNodeKind {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  return 'other';
}

async function countChildren(target: string): Promise<number | null> {
  try {
    return (await readdir(target)).length;
  } catch {
    return null;
  }
}

function rollupOf(
  candidates: readonly Candidate[],
  indexes: readonly InstancePathIndex[],
  levelPath: string | null,
): PathRollup {
  const folders = candidates.filter((candidate) => candidate.kind !== 'file');

  const mediaUnder =
    levelPath === null
      ? candidates.reduce((sum, candidate) => sum + candidate.mediaUnder, 0)
      : indexes
          .filter((index) => index.reachable)
          .reduce((sum, index) => sum + (index.mediaUnder.get(levelPath) ?? 0), 0);

  // tracked/untracked/neutral describe what is *on disk*; a path an instance believes in
  // that is not there is counted once, as missing, and never as tracked.
  const onDisk = folders.filter((candidate) => candidate.exists);

  return {
    entries: candidates.length,
    tracked: onDisk.filter((candidate) => candidate.mediaUnder > 0).length,
    untracked: onDisk.filter(
      (candidate) =>
        candidate.mediaUnder === 0 && candidate.insideRootFolder && !candidate.isRootFolder,
    ).length,
    neutral: onDisk.filter(
      (candidate) =>
        candidate.mediaUnder === 0 && !candidate.insideRootFolder && !candidate.isRootFolder,
    ).length,
    missing: candidates.filter((candidate) => !candidate.exists && candidate.inScope).length,
    rootFolders: candidates.filter((candidate) => candidate.isRootFolder).length,
    symlinks: candidates.filter((candidate) => candidate.kind === 'symlink').length,
    empty: null,
    unreadable: null,
    mediaUnder,
    severity: levelSeverityOf(candidates),
  };
}

/**
 * The worst severity among a level's entries, from the dirent list and the index alone.
 *
 * Deliberately built from the same predicates the flags are, but without the ones that
 * need a syscall per child - `empty`, `unreadable`, `readOnly` and `lowSpace`. Probing 814
 * children to colour one collapsed row is the cost this whole design exists to avoid, and
 * a level already says whether it probed, via `childCountsResolved`.
 */
function levelSeverityOf(
  candidates: readonly Candidate[],
): PathSeverity {
  let severity: PathSeverity = 'ok';

  for (const candidate of candidates) {
    if (!candidate.exists) return 'error';
    if (!candidate.inScope) return 'error';

    const unmanaged =
      candidate.mediaUnder > 0 &&
      !candidate.isRootFolder &&
      !candidate.insideRootFolder &&
      !candidate.containsRootFolder;

    if (unmanaged) {
      severity = 'warn';
      continue;
    }
    if (severity === 'ok') {
      const untracked =
        candidate.mediaUnder === 0 && candidate.insideRootFolder && !candidate.isRootFolder;
      if (untracked || candidate.kind === 'symlink') severity = 'info';
    }
  }

  return severity;
}

function matchesSelector(
  candidate: Candidate,
  selector: PathSelector,
): boolean {
  switch (selector) {
    case 'all':
      return true;
    case 'problems':
      return (
        (!candidate.exists && candidate.inScope) ||
        !candidate.inScope ||
        candidate.kind === 'symlink' ||
        (candidate.exists && candidate.insideRootFolder && candidate.mediaUnder === 0 && !candidate.isRootFolder)
      );
    case 'rootFolders':
      return candidate.isRootFolder;
    case 'tracked':
      return candidate.mediaUnder > 0;
    case 'untracked':
      return candidate.exists && candidate.mediaUnder === 0 && candidate.insideRootFolder;
    case 'missing':
      return !candidate.exists;
    case 'symlinks':
      return candidate.kind === 'symlink';
    // Not free: these need a readdir/access per child, so the level probes first and
    // the caller is told through `childCountsResolved`.
    case 'empty':
    case 'unreadable':
      return true;
  }
}

/**
 * Directories first, then the requested order - the explorer's habit, kept.
 *
 * There is deliberately no `modified` order. A candidate comes from a dirent, which
 * carries no mtime, so ordering a level by it would mean statting every entry *before*
 * paging - one stat per child on an 814-entry library, which is precisely the cost
 * `only`/`q`/`limit`-before-probe exists to avoid. The Modified column still reports the
 * fact for the rows that were probed; it just cannot be sorted on.
 */
function sortCandidates(candidates: readonly Candidate[], sort: PathSort): Candidate[] {
  const weight = (candidate: Candidate): number => {
    if (sort !== 'interesting') return 0;
    if (!candidate.exists) return 0;
    if (candidate.insideRootFolder && candidate.mediaUnder === 0) return 1;
    return 2;
  };

  return [...candidates].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    const byWeight = weight(a) - weight(b);
    if (byWeight !== 0) return byWeight;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
}

function emptyTotals(): PathMatrixTotals {
  return {
    rootFolderPaths: 0,
    unseenRootFolders: 0,
    untracked: 0,
    missing: 0,
    unmanaged: 0,
  };
}
