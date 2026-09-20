import {
  arrCollectionSchema,
  arrImportListMovieSchema,
  arrImportListSchema,
  arrMediaSchema,
  arrQualityProfileSchema,
  arrRootFolderSchema,
  arrTagDetailSchema,
  type ArrCollection,
  type ArrImportList,
  type ArrImportListMovie,
  type ArrJson,
  type ArrMedia,
  type ArrQualityProfile,
  type ArrRootFolder,
  type ArrTagDetail,
  type InstanceWithKey,
  type MediaPageResponse,
  type ResourceSnapshotResponse,
} from '@fleetarr/shared';
import { ArrClient, pageMedia, type MediaQuery } from '../arr/client.js';
import type { ArrDispatcherPool } from '../arr/http.js';
import type { InstancesRepository } from '../repositories/instances.repo.js';
import { nowIso } from '../db/mappers.js';
import { ArrApiError, ValidationError } from '../lib/errors.js';
import type { SnapshotResource, SnapshotsRepository } from '../repositories/snapshots.repo.js';

/**
 * Runaway guard on one instance's import-list contents.
 *
 * The projection is already bounded by library size, so reaching this means something is
 * very wrong. Exceeding it makes the whole resource unknown rather than a silent partial:
 * half a list looks exactly like a list that does not contain something.
 */
export const MAX_IMPORT_LIST_ITEMS = 20_000;

export interface ResourcesServiceDeps {
  readonly instances: InstancesRepository;
  readonly snapshots: SnapshotsRepository;
  readonly dispatchers: ArrDispatcherPool;
}

interface CachedFetch<T> {
  readonly payload: readonly T[];
  readonly fetchedAt: string;
}

/**
 * A read that is allowed to come back unanswerable.
 *
 * Only collections need this so far: Radarr gained `/collection` in v4, so an older one
 * answers 404, and that is "we cannot tell" rather than "there are none". Every caller has
 * to carry the distinction, which is why it is a union rather than an empty array.
 */
export type KnownCollections =
  | { readonly known: true; readonly items: readonly ArrCollection[]; readonly fetchedAt: string }
  | { readonly known: false; readonly reason: string };

/**
 * Reads *Arr resources through the snapshot cache.
 *
 * Browsing a 5000-movie library should not re-hit the instance on every keystroke, and
 * the UI needs to know how old the view is before bulk edits are staged against it.
 */
export class ResourcesService {
  constructor(private readonly deps: ResourcesServiceDeps) {}

  private client(instance: InstanceWithKey): ArrClient {
    return new ArrClient(instance, { dispatcher: this.deps.dispatchers.get(instance) });
  }

  private async cached<T>(
    instance: InstanceWithKey,
    resource: SnapshotResource,
    refresh: boolean,
    fetch: (client: ArrClient) => Promise<readonly ArrJson[]>,
    parse: (raw: ArrJson) => T,
  ): Promise<CachedFetch<T>> {
    if (!refresh) {
      const snapshot = this.deps.snapshots.get<ArrJson[]>(instance.id, resource);
      if (snapshot !== null) {
        return { payload: snapshot.payload.map(parse), fetchedAt: snapshot.fetchedAt };
      }
    }

    const raw = await fetch(this.client(instance));
    const stored = this.deps.snapshots.put(instance.id, resource, raw);
    return { payload: raw.map(parse), fetchedAt: stored.fetchedAt };
  }

  /** Tags, root folders, import lists and quality profiles in one round trip. */
  async getResources(instanceId: number, refresh = false): Promise<ResourceSnapshotResponse> {
    const instance = this.deps.instances.requireWithKey(instanceId);

    const [tags, rootFolders, importLists, qualityProfiles, collections] = await Promise.all([
      this.cached<ArrTagDetail>(
        instance,
        'tagDetail',
        refresh,
        async (client) => (await client.listTagDetails()).map((entry) => entry.raw),
        (raw) => arrTagDetailSchema.parse(raw),
      ),
      this.cached<ArrRootFolder>(
        instance,
        'rootFolder',
        refresh,
        async (client) => (await client.listRootFolders()).map((entry) => entry.raw),
        (raw) => arrRootFolderSchema.parse(raw),
      ),
      this.cached<ArrImportList>(
        instance,
        'importList',
        refresh,
        async (client) => (await client.listImportLists()).map((entry) => entry.raw),
        (raw) => arrImportListSchema.parse(raw),
      ),
      this.cached<ArrQualityProfile>(
        instance,
        'qualityProfile',
        refresh,
        async (client) => (await client.listQualityProfiles()).map((entry) => entry.raw),
        (raw) => arrQualityProfileSchema.parse(raw),
      ),
      this.collections(instanceId, refresh),
    ]);

    // The oldest of the four is the honest "as of" for the whole view.
    const fetchedAt =
      [tags.fetchedAt, rootFolders.fetchedAt, importLists.fetchedAt, qualityProfiles.fetchedAt]
        .sort()
        .at(0) ?? tags.fetchedAt;

    return {
      instanceId,
      fetchedAt,
      tags: tags.payload,
      rootFolders: rootFolders.payload,
      importLists: importLists.payload,
      qualityProfiles: qualityProfiles.payload,
      // Null, not [], when this Radarr cannot answer - and never a thrown 404 taking the
      // whole snapshot with it, which is why `collections` swallows exactly that one code.
      collections: collections.known ? collections.items : null,
    };
  }

  /** v3 has no server-side paging for movie/series, so page the cached library. */
  async getMedia(
    instanceId: number,
    query: MediaQuery & { refresh?: boolean },
  ): Promise<MediaPageResponse> {
    const instance = this.deps.instances.requireWithKey(instanceId);

    const media = await this.cached<ArrMedia>(
      instance,
      'media',
      query.refresh === true,
      async (client) => (await client.listMedia()).map((entry) => entry.raw),
      (raw) => arrMediaSchema.parse(raw),
    );

    const page = pageMedia(media.payload, query);
    return {
      instanceId,
      fetchedAt: media.fetchedAt,
      items: page.items,
      page: page.page,
      pageSize: page.pageSize,
      totalItems: page.totalItems,
      totalPages: page.totalPages,
    };
  }

  /**
   * The whole cached library, unpaged. The path index needs every path at once to build
   * its ancestor closure - paging that would be pointless work.
   */
  async mediaLibrary(
    instanceId: number,
    refresh = false,
  ): Promise<{ items: readonly ArrMedia[]; fetchedAt: string }> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    const media = await this.cached<ArrMedia>(
      instance,
      'media',
      refresh,
      async (client) => (await client.listMedia()).map((entry) => entry.raw),
      (raw) => arrMediaSchema.parse(raw),
    );
    return { items: media.payload, fetchedAt: media.fetchedAt };
  }

  /**
   * Cached snapshots only, parsed - null when nothing is cached.
   *
   * The safety guards read through these: a preflight that phoned an *Arr instance
   * could hang or fail for reasons that have nothing to do with the disk, so it must
   * never turn a cache miss into a request.
   */
  peekMediaLibrary(instanceId: number): readonly ArrMedia[] | null {
    return this.peek(instanceId, 'media', (raw) => arrMediaSchema.parse(raw));
  }

  peekRootFolders(instanceId: number): readonly ArrRootFolder[] | null {
    return this.peek(instanceId, 'rootFolder', (raw) => arrRootFolderSchema.parse(raw));
  }

  peekImportLists(instanceId: number): readonly ArrImportList[] | null {
    return this.peek(instanceId, 'importList', (raw) => arrImportListSchema.parse(raw));
  }

  private peek<T>(
    instanceId: number,
    resource: SnapshotResource,
    parse: (raw: ArrJson) => T,
  ): readonly T[] | null {
    const snapshot = this.deps.snapshots.get<ArrJson[]>(instanceId, resource);
    return snapshot === null ? null : snapshot.payload.map(parse);
  }

  /** Cached root folders only - no request when a snapshot exists. */
  async rootFolders(instanceId: number, refresh = false): Promise<readonly ArrRootFolder[]> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    const folders = await this.cached<ArrRootFolder>(
      instance,
      'rootFolder',
      refresh,
      async (client) => (await client.listRootFolders()).map((entry) => entry.raw),
      (raw) => arrRootFolderSchema.parse(raw),
    );
    return folders.payload;
  }

  /** Cached import lists only - the path index reads these to say what fills a folder. */
  async importLists(instanceId: number, refresh = false): Promise<readonly ArrImportList[]> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    const lists = await this.cached<ArrImportList>(
      instance,
      'importList',
      refresh,
      async (client) => (await client.listImportLists()).map((entry) => entry.raw),
      (raw) => arrImportListSchema.parse(raw),
    );
    return lists.payload;
  }

  /**
   * Radarr's collections, or a stated reason they could not be read.
   *
   * Sonarr is answered without a request: it has no collections, and that is a fact about
   * the app, so it is `known` with an empty list rather than an unknown. A Radarr that
   * 404s `/collection` predates the endpoint and is `known: false`.
   *
   * **Only `arr_not_found` is caught.** A timeout, a 401 or an unreachable host must keep
   * propagating, or an instance that is simply down would come back as a reachable one
   * with no collections - which is the exact failure the known/unknown split exists to
   * prevent. The 404 verdict is deliberately not cached: it is one cheap request, the
   * callers memoise above this layer, and a sentinel in the snapshot table would be
   * indistinguishable from an empty fleet on the next `peek`.
   */
  async collections(instanceId: number, refresh = false): Promise<KnownCollections> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    if (instance.kind !== 'radarr') {
      return { known: true, items: [], fetchedAt: nowIso() };
    }
    try {
      const collections = await this.cached<ArrCollection>(
        instance,
        'collection',
        refresh,
        async (client) => (await client.listCollections()).map((entry) => entry.raw),
        (raw) => arrCollectionSchema.parse(raw),
      );
      return { known: true, items: collections.payload, fetchedAt: collections.fetchedAt };
    } catch (error) {
      if (error instanceof ArrApiError && error.code === 'arr_not_found') {
        return { known: false, reason: `${instance.name} has no collections endpoint` };
      }
      throw error;
    }
  }

  /**
   * Cached collections only - null is unknown.
   *
   * Sonarr answers `[]` here too, for the same reason `collections()` does: the guards
   * read this to decide whether the fleet's view is complete, and a Sonarr reported as
   * unknown would block every folder delete in the app.
   */
  peekCollections(instanceId: number): readonly ArrCollection[] | null {
    const instance = this.deps.instances.requireWithKey(instanceId);
    if (instance.kind !== 'radarr') return [];
    return this.peek(instanceId, 'collection', (raw) => arrCollectionSchema.parse(raw));
  }

  /** Cached tag details only - `/media` joins per-instance tag ids to their labels. */
  async tagDetails(instanceId: number, refresh = false): Promise<readonly ArrTagDetail[]> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    const tags = await this.cached<ArrTagDetail>(
      instance,
      'tagDetail',
      refresh,
      async (client) => (await client.listTagDetails()).map((entry) => entry.raw),
      (raw) => arrTagDetailSchema.parse(raw),
    );
    return tags.payload;
  }

  /** Cached quality profiles only - ids are per-instance, so only the name travels. */
  async qualityProfiles(instanceId: number, refresh = false): Promise<readonly ArrQualityProfile[]> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    const profiles = await this.cached<ArrQualityProfile>(
      instance,
      'qualityProfile',
      refresh,
      async (client) => (await client.listQualityProfiles()).map((entry) => entry.raw),
      (raw) => arrQualityProfileSchema.parse(raw),
    );
    return profiles.payload;
  }

  /**
   * What Radarr's import lists hold, reduced before it is stored.
   *
   * The single place in this service that does not keep the raw body, and the reason is
   * specific: `/importlist/movie` carries a poster URL per entry with no parameter to strip
   * them, and a large Trakt list is thousands of entries. Only items already in the library
   * can be joined to a row, so filtering to those first bounds the payload by library size
   * whatever the list does - and nothing is ever PUT back, which is the only reason the
   * keep-raw rule exists.
   *
   * Radarr only; the caller must not ask a Sonarr instance.
   */
  async importListMovies(
    instanceId: number,
    refresh = false,
  ): Promise<readonly ArrImportListMovie[]> {
    const instance = this.deps.instances.requireWithKey(instanceId);
    const items = await this.cached<ArrImportListMovie>(
      instance,
      'importListMovie',
      refresh,
      async (client) => {
        const all = await client.listImportListMovies();
        const projected: ArrJson[] = all
          .filter((entry) => entry.view.isExisting === true)
          .map((entry) => ({
            tmdbId: entry.view.tmdbId,
            lists: [...entry.view.lists],
            isExcluded: entry.view.isExcluded ?? false,
          }));
        if (projected.length > MAX_IMPORT_LIST_ITEMS) {
          throw new ValidationError(
            `${instance.name} reported more than ${String(MAX_IMPORT_LIST_ITEMS)} import list items`,
          );
        }
        return projected;
      },
      (raw) => arrImportListMovieSchema.parse(raw),
    );
    return items.payload;
  }

  invalidate(instanceId: number): void {
    this.deps.snapshots.invalidate(instanceId);
  }
}
