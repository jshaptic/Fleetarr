import type {
  ArrCollection,
  ArrImportList,
  ArrRootFolder,
  FsPathReference,
  InstanceKind,
  PathCollection,
  PathImportList,
} from '@fleetarr/shared';
import type { InstancesRepository } from '../repositories/instances.repo.js';
import type { ResourcesService } from './resources.service.js';

export interface PathIndexServiceDeps {
  readonly instances: InstancesRepository;
  readonly resources: ResourcesService;
}

/**
 * One instance's paths, indexed for O(1) answers at any depth.
 *
 * `mediaUnder` is the piece that matters: a nested layout - root folder `/data/media`
 * with films at `/data/media/movies/Dune (2021)` - has to report `movies` as a folder
 * in use, not an orphan. Only a closure over every media path's ancestors can say that,
 * which is why this lives on the server: the browser would need the whole library.
 */
export interface InstancePathIndex {
  readonly instanceId: number;
  readonly name: string;
  readonly kind: InstanceKind;
  /** False when the instance did not answer: all of its cells are 'unknown'. */
  readonly reachable: boolean;
  readonly error: string | null;
  readonly fetchedAt: string | null;
  /** Normalised path -> the folder, so a cell can carry id, accessible and free space. */
  readonly rootFolders: ReadonlyMap<string, ArrRootFolder>;
  /** Normalised media path -> title. */
  readonly mediaAt: ReadonlyMap<string, string>;
  /**
   * The subset of `mediaAt` the instance says it actually holds files for.
   *
   * A monitored film nobody has downloaded yet has a path that is *meant* not to exist,
   * so only these paths can honestly be called missing from disk.
   */
  readonly mediaWithFiles: ReadonlySet<string>;
  /** Path -> media items at or under it. Every ancestor of every media path is a key. */
  readonly mediaUnder: ReadonlyMap<string, number>;
  /** The same closure over `mediaWithFiles` only - what is actually on disk below a path. */
  readonly mediaWithFilesUnder: ReadonlyMap<string, number>;
  /**
   * Every configured import list, each carrying the folder it adds to.
   *
   * A flat list rather than a path index: the question asked of it is "what adds at or
   * under this folder", which is a prefix scan over a handful of rows, and answering it
   * from a map would mean walking the map anyway.
   */
  readonly importLists: readonly PathImportList[];
  /**
   * Whether `importLists` is an answer or merely an absence.
   *
   * A live build always fetches them, so it is true there. The cache-only build does not
   * make a missing snapshot fatal the way it does for media and root folders - that would
   * silence the relocation warning every time one expired - so it records the miss here
   * instead, and `referencedBy` folds it into `complete`. Without this an uncached
   * instance would report "no list adds here" with full confidence, which is the
   * unknown-as-cleared failure this whole file is written to prevent.
   */
  readonly importListsKnown: boolean;
  /**
   * Every Radarr collection, each carrying the root folder it adds to. Flat, for the same
   * prefix-scan reason `importLists` is. Always empty on a Sonarr instance.
   */
  readonly collections: readonly PathCollection[];
  /**
   * Whether `collections` is an answer or merely an absence.
   *
   * **True for Sonarr**, which has no collections to be ignorant of - vacuously known, and
   * load-bearing: `false` there would make `complete` false for every fleet containing a
   * Sonarr and block every folder delete in the app. False only for a Radarr that predates
   * `/collection` or whose snapshot was never cached.
   */
  readonly collectionsKnown: boolean;
  /** Parent -> child paths this instance believes in - media paths and root folders. */
  readonly childrenByParent: ReadonlyMap<string, ReadonlySet<string>>;
  /** Sorted, for the inside/outside test. */
  readonly rootFolderPrefixes: readonly string[];
}

/** The answer a safety guard gets, including whether it could be trusted. */
export interface PathReferences {
  /**
   * Per instance, every claim it has on the path - required, never optional.
   *
   * An optional field defaulting to `[]` would read as "no root folders, no lists" to a
   * caller that forgot it, and a destructive guard must never mistake a gap for a clear.
   */
  readonly instances: readonly FsPathReference[];
  /** Any instance with any claim at all. The flat answer the relocation warning wants. */
  readonly instanceIds: readonly number[];
  /** False when at least one enabled instance had nothing cached to check against. */
  readonly complete: boolean;
}

const CACHE_MS = 30_000;

/**
 * A runaway guard, not a real limit: media paths are a handful of segments deep, so this
 * only ever trips on pathological input.
 */
const MAX_ANCESTOR_DEPTH = 64;

/** Trailing separators carry no meaning here and would break every path comparison. */
export function normalisePath(target: string): string {
  const trimmed = target.replace(/[/\\]+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

export function parentPath(target: string): string | null {
  const normalised = normalisePath(target);
  const index = normalised.lastIndexOf('/');
  if (index < 0) return null;
  if (index === 0) return normalised === '/' ? null : '/';
  return normalised.slice(0, index);
}

/**
 * True when `candidate` is `ancestor` or sits beneath it.
 *
 * Separator-aware on purpose. A bare `startsWith` makes `/data/movies` swallow
 * `/data/movies-4k`, which is the class of bug that moves the wrong media.
 */
export function isAtOrUnder(candidate: string, ancestor: string): boolean {
  const target = normalisePath(candidate);
  const root = normalisePath(ancestor);
  if (target === root) return true;
  return root === '/' ? target.startsWith('/') : target.startsWith(`${root}/`);
}

/**
 * Joins *Arr truth into indexes the matrix can query per directory level.
 *
 * Cached for 30 s over the snapshot cache underneath, so expanding a tree never fans
 * out into one *Arr request per level.
 */
export class PathIndexService {
  private cache: { indexes: readonly InstancePathIndex[]; at: number } | null = null;

  constructor(private readonly deps: PathIndexServiceDeps) {}

  async index(options: { refresh?: boolean } = {}): Promise<readonly InstancePathIndex[]> {
    if (options.refresh !== true && this.cache !== null && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.indexes;
    }

    const indexes = await this.build({ refresh: options.refresh === true });
    this.cache = { indexes, at: Date.now() };
    return indexes;
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Instances that still point at `target` or anything under it. Powers the delete and
   * relocation guards, so it reads cached snapshots *only*: a preflight that phoned an
   * *Arr instance could hang or fail for reasons that have nothing to do with the disk.
   *
   * `complete` is the price of that. An instance with nothing cached cannot be checked,
   * and "I could not tell" must never reach a destructive guard looking like "nothing
   * references it" - so the answer says which of the two it is.
   */
  referencedBy = async (
    target: string,
    options: { allowFetch?: boolean } = {},
  ): Promise<PathReferences> => {
    const enabled = this.deps.instances.list().filter((instance) => instance.enabled);
    const normalised = normalisePath(target);

    // `allowFetch` is chosen by how the answer is used, not by convenience. A delete
    // blocker needs the truth, so it may fetch and treats an unreachable instance as
    // unknown. A relocation only raises a hint, so it stays strictly cache-only and
    // never makes a staged rename wait on an *Arr instance.
    const indexes =
      options.allowFetch === true ? await this.index() : await this.build({ cacheOnly: true });

    const usable = indexes.filter((index) => index.reachable);

    const instances = usable
      .map((index): FsPathReference => {
        // At or *under*: deleting a parent takes every root folder below it, so each one
        // is named with its id - that is what a staged unassign needs, and what
        // `PathNode.owners` cannot give (a `containsRoot` owner has a null rootFolderId).
        const rootFolders = index.rootFolderPrefixes
          .filter((prefix) => isAtOrUnder(prefix, normalised))
          .sort((a, b) => a.length - b.length || a.localeCompare(b))
          .map((path) => ({ id: index.rootFolders.get(path)?.id ?? 0, path }));

        return {
          instanceId: index.instanceId,
          instanceName: index.name,
          rootFolders,
          mediaUnder: index.mediaUnder.get(normalised) ?? 0,
          importLists: index.importLists.filter((list) => isAtOrUnder(list.path, normalised)),
          collections: index.collections.filter((entry) => isAtOrUnder(entry.path, normalised)),
        };
      })
      .filter(
        (reference) =>
          reference.rootFolders.length > 0 ||
          reference.mediaUnder > 0 ||
          reference.importLists.length > 0 ||
          // Without this an instance whose only claim is a collection is dropped here and
          // `collection_under` then counts nothing - a folder a collection refills would
          // pass the guard clean.
          reference.collections.length > 0,
      );

    return {
      instances,
      instanceIds: instances.map((reference) => reference.instanceId),
      // An instance whose import lists were never cached is checked for everything else
      // and unknown for this one, which is still an unknown: it cannot clear the path.
      complete:
        usable.length === enabled.length &&
        usable.every((index) => index.importListsKnown && index.collectionsKnown),
    };
  };

  private async build(
    options: { refresh?: boolean; cacheOnly?: boolean } = {},
  ): Promise<readonly InstancePathIndex[]> {
    const indexes: InstancePathIndex[] = [];

    for (const instance of this.deps.instances.list()) {
      if (!instance.enabled) continue;

      if (options.cacheOnly === true) {
        const media = this.deps.resources.peekMediaLibrary(instance.id);
        const rootFolders = this.deps.resources.peekRootFolders(instance.id);
        // A cache miss contributes nothing rather than becoming a request. Import lists
        // are the softer case: a guard does read them now, but making a miss fatal would
        // drop the whole instance out of the relocation warning every time that one
        // snapshot expired - so the miss is recorded as `importListsKnown: false` and
        // reaches the guard as incompleteness instead.
        if (media === null || rootFolders === null) continue;
        const importLists = this.deps.resources.peekImportLists(instance.id);
        // Sonarr answers `[]` here without a snapshot, so this is `known` for it.
        const collections = this.deps.resources.peekCollections(instance.id);
        indexes.push(
          buildIndex(instance, rootFolders, media, importLists ?? [], collections ?? [], {
            reachable: true,
            error: null,
            fetchedAt: null,
            importListsKnown: importLists !== null,
            collectionsKnown: collections !== null,
          }),
        );
        continue;
      }

      try {
        // Three cached reads, not two. Import lists are a handful of rows behind the same
        // snapshot cache as the root folders, and they answer the question a root folder
        // alone cannot: what keeps putting media in this folder.
        const [library, rootFolders, importLists, collections] = await Promise.all([
          this.deps.resources.mediaLibrary(instance.id, options.refresh === true),
          this.deps.resources.rootFolders(instance.id, options.refresh === true),
          this.deps.resources.importLists(instance.id, options.refresh === true),
          // Never throws for a Radarr too old to have the endpoint - it answers
          // `known: false`, which reaches the guard as incompleteness rather than as a
          // dead instance. Every other *Arr error still propagates to the catch below.
          this.deps.resources.collections(instance.id, options.refresh === true),
        ]);
        indexes.push(
          buildIndex(
            instance,
            rootFolders,
            library.items,
            importLists,
            collections.known ? collections.items : [],
            {
              reachable: true,
              error: null,
              fetchedAt: library.fetchedAt,
              importListsKnown: true,
              collectionsKnown: collections.known,
            },
          ),
        );
      } catch (caught) {
        // Unreachable is *unknown*, never "missing": the instance still gets a column,
        // and it contributes to no rollup, total or flag.
        indexes.push(
          buildIndex(instance, [], [], [], [], {
            reachable: false,
            error: caught instanceof Error ? caught.message : 'Instance did not answer',
            fetchedAt: null,
            // Moot: an unreachable instance is never `usable`, so nothing reads these.
            importListsKnown: false,
            collectionsKnown: false,
          }),
        );
      }
    }

    return indexes;
  }
}

function buildIndex(
  instance: { id: number; name: string; kind: InstanceKind },
  rootFolders: readonly ArrRootFolder[],
  media: readonly { path: string; title: string; hasFile?: boolean; sizeOnDisk?: number }[],
  importLists: readonly ArrImportList[],
  collections: readonly ArrCollection[],
  status: {
    reachable: boolean;
    error: string | null;
    fetchedAt: string | null;
    importListsKnown: boolean;
    collectionsKnown: boolean;
  },
): InstancePathIndex {
  const rootFolderMap = new Map<string, ArrRootFolder>();
  const mediaAt = new Map<string, string>();
  const mediaWithFiles = new Set<string>();
  const mediaUnder = new Map<string, number>();
  const mediaWithFilesUnder = new Map<string, number>();
  const importListEntries: PathImportList[] = [];
  const collectionEntries: PathCollection[] = [];
  const childrenByParent = new Map<string, Set<string>>();

  const remember = (child: string): void => {
    const parent = parentPath(child);
    if (parent === null) return;
    const known = childrenByParent.get(parent);
    if (known === undefined) childrenByParent.set(parent, new Set([child]));
    else known.add(child);
  };

  for (const folder of rootFolders) {
    if (folder.path.length === 0) continue;
    const normalised = normalisePath(folder.path);
    rootFolderMap.set(normalised, folder);
    remember(normalised);
  }

  // *Arr stores an import list's target as a plain string, and an unconfigured list
  // carries an empty one - which must never normalise into a claim on `/`.
  for (const list of importLists) {
    if (list.rootFolderPath.length === 0) continue;
    const normalised = normalisePath(list.rootFolderPath);
    importListEntries.push({
      id: list.id,
      name: list.name,
      enabled: list.enabled,
      // Radarr and Sonarr spell the same switch differently; either one being on means
      // the list adds media on its own.
      automatic: (list.enableAuto ?? false) || (list.enableAutomaticAdd ?? false),
      path: normalised,
    });
  }

  // Same guard as the import lists above: Radarr stores an unset collection root folder as
  // an empty string, which must never normalise into a claim on `/`.
  for (const entry of collections) {
    if (entry.rootFolderPath.length === 0) continue;
    collectionEntries.push({
      id: entry.id,
      title: entry.title,
      monitored: entry.monitored,
      searchOnAdd: entry.searchOnAdd ?? false,
      path: normalisePath(entry.rootFolderPath),
    });
  }

  for (const item of media) {
    if (item.path.length === 0) continue;
    const normalised = normalisePath(item.path);
    mediaAt.set(normalised, item.title);
    const hasFile = item.hasFile ?? (item.sizeOnDisk ?? 0) > 0;
    if (hasFile) mediaWithFiles.add(normalised);
    remember(normalised);

    // The ancestor closure. One walk per media path credits the folder itself and every
    // directory above it, which is what makes rollups correct at any depth. The
    // with-files closure rides along in the same walk: a second pass would double the
    // cost of the only loop in this file that scales with library size.
    let current: string | null = normalised;
    for (let depth = 0; current !== null && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      mediaUnder.set(current, (mediaUnder.get(current) ?? 0) + 1);
      if (hasFile) mediaWithFilesUnder.set(current, (mediaWithFilesUnder.get(current) ?? 0) + 1);
      current = parentPath(current);
    }
  }

  return {
    instanceId: instance.id,
    name: instance.name,
    kind: instance.kind,
    reachable: status.reachable,
    importListsKnown: status.importListsKnown,
    collectionsKnown: status.collectionsKnown,
    error: status.error,
    fetchedAt: status.fetchedAt,
    rootFolders: rootFolderMap,
    mediaAt,
    mediaWithFiles,
    mediaUnder,
    mediaWithFilesUnder,
    // Shallowest target first, so a card lists what lands here before what lands below.
    importLists: importListEntries.sort(
      (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
    ),
    // Same ordering rule as the lists: shallowest first, so a card names what roots here
    // before what roots below.
    collections: collectionEntries.sort(
      (a, b) =>
        a.path.length - b.path.length || a.path.localeCompare(b.path) || a.title.localeCompare(b.title),
    ),
    childrenByParent,
    rootFolderPrefixes: [...rootFolderMap.keys()].sort(),
  };
}
