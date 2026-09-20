import {
  MEDIA_KIND_BY_INSTANCE,
  matchMediaFilter,
  mediaEpisodeCounts,
  mediaHasFile,
  mediaIdentity,
  mediaSizeOnDisk,
  disambiguateMediaKey,
  normaliseMediaTitle,
  parseMediaFilter,
  type ArrMedia,
  type ArrQualityProfile,
  type ArrTag,
  type Instance,
  type InstanceKind,
  type MediaFacet,
  type MediaFilter,
  type MediaFilterVocabulary,
  type MediaFleetColumn,
  type MediaFleetResponse,
  type MediaFleetTotals,
  type MediaFlag,
  type MediaIdentityBasis,
  type MediaIdsResponse,
  type MediaKind,
  type MediaRow,
  type MediaSort,
  type MediaSortDirection,
  type MediaUndecidedMode,
  type MediaUndecidedReason,
} from '@fleetarr/shared';
import { serialiseError, ValidationError } from '../lib/errors.js';
import type { InstancesRepository } from '../repositories/instances.repo.js';
import { isAtOrUnder, normalisePath } from './path-index.service.js';
import type { ResourcesService } from './resources.service.js';

export interface MediaFleetServiceDeps {
  readonly instances: InstancesRepository;
  readonly resources: ResourcesService;
}

/**
 * How long a built fleet index is reused.
 *
 * The cold cost is dominated by parsing four 5 000-item libraries out of SQLite; every
 * paging click, sort flip and filter change after that is one pass over rows already in
 * memory. Mirrors `PathIndexService.CACHE_MS` for the same reason.
 */
export const MEDIA_FLEET_CACHE_MS = 30_000;

export const DEFAULT_MEDIA_PAGE_SIZE = 100;
export const MAX_MEDIA_PAGE_SIZE = 500;

/** Ceiling on one "apply to everything matching" answer. */
export const MAX_SELECTION_IDS = 20_000;

interface InstanceMediaIndex {
  readonly instance: Instance;
  readonly mediaKind: MediaKind;
  /** False when the live read failed. Cached facets may still be present - see `known`. */
  readonly reachable: boolean;
  /** True when there was a snapshot to read, however old. */
  readonly known: boolean;
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly fetchedAt: string | null;
  readonly items: readonly ArrMedia[];
  readonly tags: readonly ArrTag[];
  readonly tagLabels: ReadonlyMap<number, string>;
  readonly qualityProfiles: readonly ArrQualityProfile[];
  readonly profileNames: ReadonlyMap<number, string>;
  readonly rootFolders: readonly string[];
  readonly importLists: readonly { id: number; name: string }[];
  /** tmdbId -> the list names holding it. Null when this instance cannot say. */
  readonly listsByTmdbId: ReadonlyMap<number, readonly string[]> | null;
  /** The same membership as ids, for a dialog that has to address a list. */
  readonly listIdsByTmdbId: ReadonlyMap<number, readonly number[]> | null;
  readonly excludedTmdbIds: ReadonlySet<number> | null;
  readonly importListsKnown: boolean;
  readonly importListsUnknownReason: 'unsupported' | 'error' | null;
}

interface MediaFleetIndex {
  readonly indexes: readonly InstanceMediaIndex[];
  readonly rows: readonly MediaRow[];
  readonly builtAt: string;
}

export interface MediaFleetQuery {
  readonly filter?: string;
  readonly undecided?: MediaUndecidedMode;
  readonly sort?: MediaSort;
  readonly direction?: MediaSortDirection;
  readonly page?: number;
  readonly pageSize?: number;
  readonly refresh?: boolean;
}

/**
 * Every title across the fleet, as rows the browser can render without holding the library.
 *
 * A title is one row with a chip per instance that holds it, which is the whole reason this
 * lives on the server: grouping across instances needs every library at once, and so does
 * an honest count. Filtering, sorting and paging all happen here for the same reason - a
 * filter applied in the browser would leave the summary describing rows it had removed.
 */
export class MediaFleetService {
  private cache: { index: MediaFleetIndex; at: number } | null = null;

  constructor(private readonly deps: MediaFleetServiceDeps) {}

  async index(options: { refresh?: boolean } = {}): Promise<MediaFleetIndex> {
    if (
      options.refresh !== true &&
      this.cache !== null &&
      Date.now() - this.cache.at < MEDIA_FLEET_CACHE_MS
    ) {
      return this.cache.index;
    }

    const indexes = await this.build(options.refresh === true);
    const index: MediaFleetIndex = {
      indexes,
      rows: buildRows(indexes),
      builtAt: new Date().toISOString(),
    };
    this.cache = { index, at: Date.now() };
    return index;
  }

  invalidate(): void {
    this.cache = null;
  }

  async query(query: MediaFleetQuery = {}): Promise<MediaFleetResponse> {
    const index = await this.index({ refresh: query.refresh === true });
    const filter = this.parse(query.filter);

    const matched: MediaRow[] = [];
    const undecided: MediaRow[] = [];
    const reasonCounts = new Map<string, number>();

    for (const row of index.rows) {
      const result = matchMediaFilter(filter, row);
      if (result.verdict === 'no') continue;

      const judged: MediaRow = {
        ...row,
        matchedInstanceIds: result.matchedInstanceIds,
        facets: row.facets.map((facet) => ({
          ...facet,
          matched: result.matchedInstanceIds.includes(facet.instanceId),
        })),
        ...(result.verdict === 'unknown' ? { reasons: result.reasons } : {}),
      };

      if (result.verdict === 'match') {
        matched.push(judged);
        continue;
      }
      undecided.push(judged);
      for (const reason of result.reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }

    const sort = query.sort ?? 'title';
    const direction = query.direction ?? 'asc';
    const mode: MediaUndecidedMode = query.undecided ?? 'hide';
    // `show` lists the undecided rows *instead of* the matches, so "show them" is a place to
    // go rather than a longer list to scroll past.
    const listed = sortRows(mode === 'show' ? undecided : matched, sort, direction);

    const pageSize = Math.min(MAX_MEDIA_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_MEDIA_PAGE_SIZE));
    const page = Math.max(1, query.page ?? 1);
    const start = (page - 1) * pageSize;
    const rows = listed.slice(start, start + pageSize);

    const columns = index.indexes.map(toColumn);
    const fetchedAts = columns
      .map((column) => column.fetchedAt)
      .filter((value): value is string => value !== null)
      .sort();

    return {
      scannedAt: index.builtAt,
      oldestFetchedAt: fetchedAts.at(0) ?? null,
      columns,
      rows,
      listing: mode,
      totals: buildTotals(index),
      counts: {
        matched: matched.length,
        undecided: undecided.length,
        total: index.rows.length,
      },
      undecidedReasons: [...reasonCounts]
        .map(([reason, count]): MediaUndecidedReason => ({ reason, rows: count }))
        .sort((left, right) => right.rows - left.rows),
      page,
      pageSize,
      truncated: listed.length > start + rows.length,
      sort,
      direction,
      filter: { source: filter.source, error: filter.error },
      vocabulary: buildVocabulary(index.indexes),
    };
  }

  /**
   * The per-instance id sets for a query, so a bulk operation can act on the whole match.
   *
   * The honest source of targets: derived from the filter rather than from whichever page
   * the browser happens to have, because acting on a page and reporting a filter is the
   * same lie as a summary describing rows it removed.
   */
  async ids(query: MediaFleetQuery = {}): Promise<MediaIdsResponse> {
    const index = await this.index({ refresh: query.refresh === true });
    const filter = this.parse(query.filter);
    const reachable = new Set(
      index.indexes.filter((entry) => entry.reachable).map((entry) => entry.instance.id),
    );

    const groups = new Map<number, { kind: InstanceKind; mediaIds: number[] }>();
    let matched = 0;
    let total = 0;
    let truncated = false;

    for (const row of index.rows) {
      const result = matchMediaFilter(filter, row);
      if (result.verdict !== 'match') continue;
      matched += 1;

      for (const facet of row.facets) {
        // Only the copies that matched, and only on instances a run may touch.
        if (!result.matchedInstanceIds.includes(facet.instanceId)) continue;
        if (!reachable.has(facet.instanceId)) continue;
        if (total >= MAX_SELECTION_IDS) {
          truncated = true;
          continue;
        }
        const group = groups.get(facet.instanceId) ?? { kind: facet.kind, mediaIds: [] };
        group.mediaIds.push(facet.mediaId);
        groups.set(facet.instanceId, group);
        total += 1;
      }
    }

    return {
      matched,
      truncated,
      groups: [...groups].map(([instanceId, group]) => ({
        instanceId,
        kind: group.kind,
        mediaIds: group.mediaIds,
      })),
    };
  }

  /**
   * A filter nobody can read is a filter nobody can debug, so it is refused rather than
   * ignored. The route rejects it first; this is the backstop.
   */
  private parse(source: string | undefined): MediaFilter {
    const filter = parseMediaFilter(source ?? '', { now: Date.now() });
    if (filter.error !== null) throw new ValidationError(filter.error);
    return filter;
  }

  private async build(refresh: boolean): Promise<readonly InstanceMediaIndex[]> {
    const enabled = this.deps.instances
      .list()
      .filter((instance) => instance.enabled)
      .sort((left, right) => left.id - right.id);

    return Promise.all(enabled.map((instance) => this.buildOne(instance, refresh)));
  }

  private async buildOne(instance: Instance, refresh: boolean): Promise<InstanceMediaIndex> {
    const mediaKind = MEDIA_KIND_BY_INSTANCE[instance.kind];

    let core: Awaited<ReturnType<MediaFleetService['readCore']>>;
    let reachable = true;
    let error: string | null = null;
    let errorCode: string | null = null;

    try {
      core = await this.readCore(instance.id, refresh);
    } catch (caught) {
      const serialised = serialiseError(caught);
      reachable = false;
      error = serialised.message;
      errorCode = serialised.code;
      // A failed *refresh* is not the same as never having read this instance. Falling back
      // to the snapshot keeps the last known truth on screen with its age stated, and
      // leaves `reachable` to mean exactly one thing: excluded from every bulk fan-out.
      try {
        core = refresh ? await this.readCore(instance.id, false) : emptyCore();
      } catch {
        core = emptyCore();
      }
    }

    const lists = await this.readLists(instance, mediaKind, refresh);

    return {
      instance,
      mediaKind,
      reachable,
      known: core.fetchedAt !== null,
      error,
      errorCode,
      fetchedAt: core.fetchedAt,
      items: core.items,
      tags: core.tags,
      tagLabels: new Map(core.tags.map((tag) => [tag.id, tag.label])),
      qualityProfiles: core.profiles,
      profileNames: new Map(core.profiles.map((profile) => [profile.id, profile.name])),
      rootFolders: core.rootFolders,
      importLists: core.importLists,
      ...lists,
    };
  }

  private async readCore(
    instanceId: number,
    refresh: boolean,
  ): Promise<{
    items: readonly ArrMedia[];
    fetchedAt: string | null;
    tags: readonly ArrTag[];
    profiles: readonly ArrQualityProfile[];
    rootFolders: readonly string[];
    importLists: readonly { id: number; name: string }[];
  }> {
    const [library, tags, profiles, rootFolders, importLists] = await Promise.all([
      this.deps.resources.mediaLibrary(instanceId, refresh),
      this.deps.resources.tagDetails(instanceId, refresh),
      this.deps.resources.qualityProfiles(instanceId, refresh),
      this.deps.resources.rootFolders(instanceId, refresh),
      this.deps.resources.importLists(instanceId, refresh),
    ]);

    return {
      items: library.items,
      fetchedAt: library.fetchedAt,
      tags: tags.map((tag) => ({ id: tag.id, label: tag.label })),
      profiles,
      rootFolders: rootFolders.map((folder) => normalisePath(folder.path)),
      importLists: importLists.map((list) => ({ id: list.id, name: list.name })),
    };
  }

  /**
   * Import-list membership, and why it might be absent.
   *
   * Read and caught on its own: Sonarr has no endpoint to call, and a Radarr read that
   * fails should cost the instance its list column rather than its whole row set.
   */
  private async readLists(
    instance: Instance,
    mediaKind: MediaKind,
    refresh: boolean,
  ): Promise<
    Pick<
      InstanceMediaIndex,
      | 'listsByTmdbId'
      | 'listIdsByTmdbId'
      | 'excludedTmdbIds'
      | 'importListsKnown'
      | 'importListsUnknownReason'
    >
  > {
    if (mediaKind !== 'movie') {
      return {
        listsByTmdbId: null,
        listIdsByTmdbId: null,
        excludedTmdbIds: null,
        importListsKnown: false,
        importListsUnknownReason: 'unsupported',
      };
    }

    try {
      const [items, lists] = await Promise.all([
        this.deps.resources.importListMovies(instance.id, refresh),
        this.deps.resources.importLists(instance.id, refresh),
      ]);
      const nameById = new Map(lists.map((list) => [list.id, list.name]));
      const byTmdbId = new Map<number, readonly string[]>();
      const idsByTmdbId = new Map<number, readonly number[]>();
      const excluded = new Set<number>();

      for (const item of items) {
        idsByTmdbId.set(item.tmdbId, [...item.lists]);
        byTmdbId.set(
          item.tmdbId,
          // A list we have no name for stays out rather than becoming "list 7": the row
          // carries names, and inventing one is the same class of lie as inventing a label.
          item.lists.map((id) => nameById.get(id)).filter((name): name is string => name !== undefined),
        );
        if (item.isExcluded === true) excluded.add(item.tmdbId);
      }

      return {
        listsByTmdbId: byTmdbId,
        listIdsByTmdbId: idsByTmdbId,
        excludedTmdbIds: excluded,
        importListsKnown: true,
        importListsUnknownReason: null,
      };
    } catch {
      return {
        listsByTmdbId: null,
        listIdsByTmdbId: null,
        excludedTmdbIds: null,
        importListsKnown: false,
        importListsUnknownReason: 'error',
      };
    }
  }
}

function emptyCore(): {
  items: readonly ArrMedia[];
  fetchedAt: string | null;
  tags: readonly ArrTag[];
  profiles: readonly ArrQualityProfile[];
  rootFolders: readonly string[];
  importLists: readonly { id: number; name: string }[];
} {
  return { items: [], fetchedAt: null, tags: [], profiles: [], rootFolders: [], importLists: [] };
}

function toColumn(index: InstanceMediaIndex): MediaFleetColumn {
  return {
    instanceId: index.instance.id,
    name: index.instance.name,
    kind: index.instance.kind,
    reachable: index.reachable,
    error: index.error,
    errorCode: index.errorCode,
    fetchedAt: index.fetchedAt,
    itemCount: index.items.length,
    importListsKnown: index.importListsKnown,
    importListsUnknownReason: index.importListsUnknownReason,
    tags: index.tags,
    qualityProfiles: index.qualityProfiles,
    rootFolders: index.rootFolders,
    importLists: index.importLists,
  };
}

/** Row badges, decided here so the words on screen cannot drift from the data. */
function flagsFor(
  item: ArrMedia,
  index: InstanceMediaIndex,
  profileName: string | null,
): MediaFlag[] {
  const flags: MediaFlag[] = [];
  if (!item.monitored) flags.push('unmonitored');
  // Nothing here for "no file on disk": that is a size, and the Size column says it as a
  // number, `no file`, or `unknown`. A monitored item nobody has downloaded is an ordinary
  // state, and a badge next to the real faults would read like one of them.
  if (profileName === null) flags.push('no-quality-profile');
  if (
    index.rootFolders.length > 0 &&
    item.path.length > 0 &&
    !index.rootFolders.some((root) => isAtOrUnder(item.path, root))
  ) {
    flags.push('outside-root-folders');
  }
  return flags;
}

interface RowDraft {
  key: string;
  basis: MediaIdentityBasis;
  kind: MediaKind;
  source: ArrMedia;
  facets: MediaFacet[];
}

function facetFor(item: ArrMedia, index: InstanceMediaIndex): MediaFacet {
  const profileName = index.profileNames.get(item.qualityProfileId) ?? null;
  const tmdbId = item.tmdbId ?? 0;
  const lists = index.listsByTmdbId === null ? null : (index.listsByTmdbId.get(tmdbId) ?? []);

  return {
    instanceId: index.instance.id,
    name: index.instance.name,
    kind: index.instance.kind,
    mediaId: item.id,
    monitored: item.monitored,
    hasFile: mediaHasFile(item),
    sizeOnDisk: mediaSizeOnDisk(item),
    episodes: mediaEpisodeCounts(item),
    path: item.path,
    rootFolderPath: item.rootFolderPath === undefined ? null : item.rootFolderPath,
    qualityProfileId: item.qualityProfileId,
    qualityProfileName: profileName,
    tagIds: item.tags,
    tags: item.tags
      .map((id) => index.tagLabels.get(id))
      .filter((label): label is string => label !== undefined)
      .sort((left, right) => left.localeCompare(right)),
    added: item.added ?? null,
    lists,
    listIds: index.listIdsByTmdbId === null ? null : (index.listIdsByTmdbId.get(tmdbId) ?? []),
    excludedFromLists:
      index.excludedTmdbIds === null ? null : index.excludedTmdbIds.has(tmdbId),
    flags: flagsFor(item, index, profileName),
    // Set once the filter has run; an unfiltered row has every copy matching.
    matched: true,
  };
}

function buildRows(indexes: readonly InstanceMediaIndex[]): readonly MediaRow[] {
  const drafts = new Map<string, RowDraft>();
  /** Guards the weakest identity rung: two different films on one instance stay two rows. */
  const claimed = new Set<string>();

  for (const index of indexes) {
    for (const item of index.items) {
      const identity = mediaIdentity(item, index.mediaKind);
      const perInstance = `${identity.key}|${String(index.instance.id)}`;
      const key =
        identity.basis === 'title' && claimed.has(perInstance)
          ? disambiguateMediaKey(identity.key, index.instance.id, item.id)
          : identity.key;
      claimed.add(perInstance);

      const draft = drafts.get(key);
      if (draft === undefined) {
        drafts.set(key, {
          key,
          basis: identity.basis,
          kind: index.mediaKind,
          source: item,
          facets: [facetFor(item, index)],
        });
        continue;
      }
      // One facet per instance: the first claim wins, so a re-keyed duplicate cannot
      // smuggle a second copy onto a row.
      if (draft.facets.some((facet) => facet.instanceId === index.instance.id)) continue;
      draft.facets.push(facetFor(item, index));
    }
  }

  const unknownByKind = new Map<MediaKind, number[]>();
  for (const index of indexes) {
    if (index.known) continue;
    const list = unknownByKind.get(index.mediaKind) ?? [];
    list.push(index.instance.id);
    unknownByKind.set(index.mediaKind, list);
  }

  return [...drafts.values()].map((draft) => toRow(draft, unknownByKind.get(draft.kind) ?? []));
}

function toRow(draft: RowDraft, unknownInstanceIds: readonly number[]): MediaRow {
  const item = draft.source;
  const sizes = draft.facets
    .map((facet) => facet.sizeOnDisk)
    .filter((size): size is number => size !== null);
  const addedDates = draft.facets
    .map((facet) => facet.added)
    .filter((added): added is string => added !== null)
    .sort();

  return {
    key: draft.key,
    kind: draft.kind,
    identityBasis: draft.basis,
    title: item.title,
    sortTitle: item.sortTitle ?? item.title,
    year: item.year ?? null,
    status: item.status ?? null,
    genres: item.genres ?? [],
    certification: item.certification ?? null,
    runtime: item.runtime ?? null,
    studio: item.studio ?? item.network ?? null,
    // Read off the film itself rather than joined to the `/collection` resource: TMDB is
    // the source either way, so two Radarr copies agree by construction, and the column
    // keeps working on a Radarr too old to have that endpoint. An empty title is no
    // collection - Radarr never sends a half-filled one, but `''` would render as a chip.
    collection:
      item.collection?.title !== undefined && item.collection.title.length > 0
        ? item.collection.title
        : null,
    tmdbId: item.tmdbId ?? null,
    tvdbId: item.tvdbId ?? null,
    imdbId: item.imdbId ?? null,
    titleSlug: item.titleSlug ?? null,
    seriesType: item.seriesType ?? null,
    minimumAvailability: item.minimumAvailability ?? null,
    facets: draft.facets,
    tags: [...new Set(draft.facets.flatMap((facet) => facet.tags))].sort((left, right) =>
      left.localeCompare(right),
    ),
    instanceCount: draft.facets.length,
    monitoredCount: draft.facets.filter((facet) => facet.monitored).length,
    fileCount: draft.facets.filter((facet) => facet.hasFile === true).length,
    sizeOnDisk: sizes.length === 0 ? null : sizes.reduce((sum, size) => sum + size, 0),
    addedFirst: addedDates.at(0) ?? null,
    unknownInstanceIds,
    matchedInstanceIds: draft.facets.map((facet) => facet.instanceId),
  };
}

const SORT_KEYS: Record<MediaSort, (row: MediaRow) => number | string> = {
  title: (row) => row.sortTitle.toLowerCase() || normaliseMediaTitle(row.title),
  year: (row) => row.year ?? Number.NEGATIVE_INFINITY,
  added: (row) => row.addedFirst ?? '',
  size: (row) => row.sizeOnDisk ?? Number.NEGATIVE_INFINITY,
  instances: (row) => row.instanceCount,
};

/** Stable: the key first, then the row key, so two equal rows never swap between pages. */
function sortRows(
  rows: readonly MediaRow[],
  sort: MediaSort,
  direction: MediaSortDirection,
): readonly MediaRow[] {
  const read = SORT_KEYS[sort];
  const sign = direction === 'desc' ? -1 : 1;

  return [...rows].sort((left, right) => {
    const a = read(left);
    const b = read(right);
    if (a !== b) {
      const order =
        typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : a < b ? -1 : 1;
      return order * sign;
    }
    return left.key.localeCompare(right.key);
  });
}

function buildTotals(index: MediaFleetIndex): MediaFleetTotals {
  const sizes = index.rows
    .map((row) => row.sizeOnDisk)
    .filter((size): size is number => size !== null);

  return {
    rows: index.rows.length,
    movies: index.rows.filter((row) => row.kind === 'movie').length,
    series: index.rows.filter((row) => row.kind === 'series').length,
    facets: index.rows.reduce((sum, row) => sum + row.facets.length, 0),
    onOneInstance: index.rows.filter((row) => row.instanceCount === 1).length,
    onMultipleInstances: index.rows.filter((row) => row.instanceCount > 1).length,
    monitored: index.rows.filter((row) => row.monitoredCount > 0).length,
    withFiles: index.rows.filter((row) => row.fileCount > 0).length,
    sizeOnDisk: sizes.length === 0 ? null : sizes.reduce((sum, size) => sum + size, 0),
    unreachableInstances: index.indexes.filter((entry) => !entry.reachable).length,
    importListsUnknownInstances: index.indexes.filter((entry) => !entry.importListsKnown).length,
    weakIdentityRows: index.rows.filter((row) => row.identityBasis === 'title').length,
  };
}

function buildVocabulary(indexes: readonly InstanceMediaIndex[]): MediaFilterVocabulary {
  const sorted = (values: Iterable<string>): readonly string[] =>
    [...new Set(values)].sort((left, right) => left.localeCompare(right));

  return {
    instances: sorted(indexes.map((index) => index.instance.name)),
    tags: sorted(indexes.flatMap((index) => index.tags.map((tag) => tag.label))),
    lists: sorted(indexes.flatMap((index) => index.importLists.map((list) => list.name))),
    qualityProfiles: sorted(
      indexes.flatMap((index) => index.qualityProfiles.map((profile) => profile.name)),
    ),
    genres: sorted(indexes.flatMap((index) => index.items.flatMap((item) => item.genres ?? []))),
    rootFolders: sorted(indexes.flatMap((index) => index.rootFolders)),
    certifications: sorted(
      indexes.flatMap((index) =>
        index.items
          .map((item) => item.certification)
          .filter((value): value is string => value !== undefined && value.length > 0),
      ),
    ),
    // The fleet's own collections, from the library rather than from `/collection` - the
    // same source the column reads, so the help card can never offer a value no row has.
    collections: sorted(
      indexes.flatMap((index) =>
        index.items
          .map((item) => item.collection?.title)
          .filter((value): value is string => value !== undefined && value.length > 0),
      ),
    ),
  };
}
