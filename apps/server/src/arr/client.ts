import {
  arrCollectionSchema,
  arrCommandSchema,
  arrImportListMovieSchema,
  arrImportListSchema,
  arrMediaSchema,
  arrQualityProfileSchema,
  arrRootFolderSchema,
  arrSystemStatusSchema,
  arrTagDetailSchema,
  arrTagSchema,
  mergeForPut,
  toResource,
  toResources,
  type ArrCollection,
  type ArrCommand,
  type ArrImportList,
  type ArrImportListMovie,
  type ArrJson,
  type ArrMedia,
  type ArrQualityProfile,
  type ArrResource,
  type ArrRootFolder,
  type ArrSystemStatus,
  type ArrTag,
  type ArrTagDetail,
  type ConnectionTestResult,
  type InstanceWithKey,
  type MediaKind,
} from '@fleetarr/shared';
import { ArrApiError, ValidationError } from '../lib/errors.js';
import {
  arrRequest,
  type ArrHttpTrace,
  type ArrRequestOptions,
  type ArrTransportDeps,
} from './http.js';

/** Radarr and Sonarr expose the same shape under different resource names. */
const MEDIA_PATH: Record<MediaKind, string> = {
  movie: '/movie',
  series: '/series',
};

const MEDIA_EDITOR_PATH: Record<MediaKind, string> = {
  movie: '/movie/editor',
  series: '/series/editor',
};

/** The editor endpoint keys the id list by media kind: movieIds vs seriesIds. */
const MEDIA_EDITOR_ID_KEY: Record<MediaKind, string> = {
  movie: 'movieIds',
  series: 'seriesIds',
};

/**
 * The same flag, spelled differently by each app - the enableAuto/enableAutomaticAdd family.
 *
 * Worth a constant rather than a guess: *Arr ignores a key it does not recognise, so a
 * misspelling here deletes the item without recording the exclusion and the next list sync
 * brings it straight back.
 */
const MEDIA_EXCLUSION_KEY: Record<MediaKind, string> = {
  movie: 'addImportExclusion',
  series: 'addImportListExclusion',
};

/** Query params that keep the media list payload small. */
const MEDIA_LIGHT_QUERY: Record<MediaKind, Record<string, string>> = {
  movie: { excludeLocalCovers: 'true' },
  series: { includeSeasonImages: 'false' },
};

export type ApplyTagsMode = 'add' | 'remove' | 'replace';

export interface BulkEditParams {
  readonly mediaIds: readonly number[];
  readonly tags?: readonly number[];
  readonly applyTags?: ApplyTagsMode;
  readonly rootFolderPath?: string;
  /** Radarr/Sonarr only relocate files on disk when this is true. */
  readonly moveFiles?: boolean;
  readonly monitored?: boolean;
  readonly qualityProfileId?: number;
}

/**
 * The Radarr collection editor's body, minus the id list.
 *
 * No `tags` key, and none is possible: `PUT /collection` has no `tags` and no `applyTags`,
 * so a collection's tags are reachable only through the single-resource PUT. That is what
 * splits `collection.update` from `collectionTags.*`, not a preference.
 */
export interface BulkEditCollectionParams {
  readonly collectionIds: readonly number[];
  readonly rootFolderPath?: string;
  readonly qualityProfileId?: number;
  readonly minimumAvailability?: string;
  readonly monitored?: boolean;
  readonly monitorMovies?: boolean;
  readonly searchOnAdd?: boolean;
}

export interface BulkDeleteParams {
  readonly mediaIds: readonly number[];
  /** The destructive one: the files leave the disk and Fleetarr cannot put them back. */
  readonly deleteFiles: boolean;
  /** Without it, the next import-list sync may re-add everything just removed. */
  readonly addImportExclusion: boolean;
}

export interface MediaPage {
  readonly items: readonly ArrMedia[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface MediaQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly tagId?: number;
  readonly rootFolderPath?: string;
}

export interface ArrClientOptions {
  readonly signal?: AbortSignal;
  readonly onTrace?: (trace: ArrHttpTrace) => void;
}

/**
 * Typed client for one Radarr or Sonarr instance.
 *
 * Two conventions hold throughout:
 * - list methods return `ArrResource<T>` (validated view + the untouched body), because
 *   every *Arr v3 PUT replaces the whole resource and needs the raw object back;
 * - nothing here mutates state implicitly - callers decide when to write.
 */
export class ArrClient {
  private readonly transport: ArrTransportDeps;

  constructor(
    readonly instance: InstanceWithKey,
    transport: ArrTransportDeps,
    private readonly options: ArrClientOptions = {},
  ) {
    this.transport = {
      dispatcher: transport.dispatcher,
      onTrace: options.onTrace ?? transport.onTrace,
    };
  }

  get mediaKind(): MediaKind {
    return this.instance.kind === 'radarr' ? 'movie' : 'series';
  }

  private request<T>(options: ArrRequestOptions): Promise<T> {
    return arrRequest<T>(
      this.instance,
      { ...options, ...(this.options.signal ? { signal: this.options.signal } : {}) },
      this.transport,
    );
  }

  // ---------------------------------------------------------------- connectivity

  async getSystemStatus(): Promise<ArrSystemStatus> {
    const body = await this.request<unknown>({ path: '/system/status' });
    return arrSystemStatusSchema.parse(body);
  }

  /**
   * Never throws: a failed connection test is a result, not an exception - the UI
   * shows it inline on the instance form.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const status = await this.getSystemStatus();
      return {
        ok: true,
        appVersion: status.version,
        ...(status.instanceName === undefined ? {} : { instanceName: status.instanceName }),
      };
    } catch (error) {
      if (error instanceof ArrApiError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'unknown_error',
          message: error instanceof Error ? error.message : 'Connection test failed',
        },
      };
    }
  }

  // ----------------------------------------------------------------------- tags

  async listTags(): Promise<ArrResource<ArrTag>[]> {
    return toResources(arrTagSchema, await this.request<unknown>({ path: '/tag' }));
  }

  /** /tag/detail is the only endpoint that reports what a tag is attached to. */
  async listTagDetails(): Promise<ArrResource<ArrTagDetail>[]> {
    return toResources(arrTagDetailSchema, await this.request<unknown>({ path: '/tag/detail' }));
  }

  async getTagDetail(tagId: number): Promise<ArrResource<ArrTagDetail>> {
    return toResource(arrTagDetailSchema, await this.request<unknown>({ path: `/tag/detail/${tagId}` }));
  }

  async createTag(label: string): Promise<ArrTag> {
    const body = await this.request<unknown>({ method: 'POST', path: '/tag', body: { label } });
    return arrTagSchema.parse(body);
  }

  /**
   * Round-trips the raw tag so nothing the API added is dropped, which is the rule for
   * every *Arr PUT.
   */
  async renameTag(tagId: number, label: string): Promise<ArrTag> {
    const current = toResource(arrTagSchema, await this.request<unknown>({ path: `/tag/${tagId}` }));
    const body = await this.request<unknown>({
      method: 'PUT',
      path: `/tag/${tagId}`,
      body: mergeForPut(current.raw, { label }),
    });
    return arrTagSchema.parse(body ?? { id: tagId, label });
  }

  async deleteTag(tagId: number): Promise<void> {
    await this.request<void>({ method: 'DELETE', path: `/tag/${tagId}` });
  }

  // --------------------------------------------------------------- root folders

  async listRootFolders(): Promise<ArrResource<ArrRootFolder>[]> {
    return toResources(arrRootFolderSchema, await this.request<unknown>({ path: '/rootfolder' }));
  }

  async createRootFolder(path: string): Promise<ArrRootFolder> {
    const body = await this.request<unknown>({ method: 'POST', path: '/rootfolder', body: { path } });
    return arrRootFolderSchema.parse(body);
  }

  async deleteRootFolder(rootFolderId: number): Promise<void> {
    await this.request<void>({ method: 'DELETE', path: `/rootfolder/${rootFolderId}` });
  }

  // ---------------------------------------------------------------------- media

  /**
   * v3 has no server-side paging for /movie or /series - both return the full library.
   * We ask for the lightest representation the app offers, project it to the fields the
   * grid needs, and page in memory.
   */
  async listMedia(): Promise<ArrResource<ArrMedia>[]> {
    const body = await this.request<unknown>({
      path: MEDIA_PATH[this.mediaKind],
      query: MEDIA_LIGHT_QUERY[this.mediaKind],
    });
    return toResources(arrMediaSchema, body);
  }

  async getMedia(mediaId: number): Promise<ArrResource<ArrMedia>> {
    const body = await this.request<unknown>({ path: `${MEDIA_PATH[this.mediaKind]}/${mediaId}` });
    return toResource(arrMediaSchema, body);
  }

  /**
   * PUT /{movie|series}/editor - the bulk endpoint. Only the keys present in the body
   * are touched, so tag edits and root-folder moves stay independent.
   */
  async bulkEditMedia(params: BulkEditParams): Promise<number> {
    if (params.mediaIds.length === 0) return 0;

    const body: ArrJson = {
      [MEDIA_EDITOR_ID_KEY[this.mediaKind]]: [...params.mediaIds],
    };
    if (params.tags !== undefined) {
      body['tags'] = [...params.tags];
      body['applyTags'] = params.applyTags ?? 'add';
    }
    if (params.rootFolderPath !== undefined) {
      body['rootFolderPath'] = params.rootFolderPath;
      // Omitting moveFiles makes *Arr default to false; be explicit either way.
      body['moveFiles'] = params.moveFiles ?? false;
    }
    if (params.monitored !== undefined) body['monitored'] = params.monitored;
    if (params.qualityProfileId !== undefined) body['qualityProfileId'] = params.qualityProfileId;

    const response = await this.request<unknown>({
      method: 'PUT',
      path: MEDIA_EDITOR_PATH[this.mediaKind],
      body,
    });

    // Radarr returns the updated resources; Sonarr may return an empty body.
    return Array.isArray(response) ? response.length : params.mediaIds.length;
  }

  /**
   * DELETE /{movie|series}/editor - the only bulk delete.
   *
   * Both flags are always sent explicitly. `deleteFiles` decides whether this is a
   * bookkeeping change or an irreversible one, and defaulting either of them would leave
   * that to whatever the *Arr version happens to assume.
   */
  async bulkDeleteMedia(params: BulkDeleteParams): Promise<number> {
    if (params.mediaIds.length === 0) return 0;

    await this.request<void>({
      method: 'DELETE',
      path: MEDIA_EDITOR_PATH[this.mediaKind],
      body: {
        [MEDIA_EDITOR_ID_KEY[this.mediaKind]]: [...params.mediaIds],
        deleteFiles: params.deleteFiles,
        [MEDIA_EXCLUSION_KEY[this.mediaKind]]: params.addImportExclusion,
      },
    });

    // Both apps answer with an empty body, so the request is the only acknowledgement.
    return params.mediaIds.length;
  }

  // ----------------------------------------------------------- quality profiles

  async listQualityProfiles(): Promise<ArrResource<ArrQualityProfile>[]> {
    return toResources(arrQualityProfileSchema, await this.request<unknown>({ path: '/qualityprofile' }));
  }

  // --------------------------------------------------------------- import lists

  async listImportLists(): Promise<ArrResource<ArrImportList>[]> {
    return toResources(arrImportListSchema, await this.request<unknown>({ path: '/importlist' }));
  }

  /**
   * What this instance's import lists currently hold. **Radarr only.**
   *
   * Sonarr's V3 API exposes list configuration and exclusions but no list *contents*, so
   * there is nothing to call there - which is why `/media` reports list membership on a
   * Sonarr instance as unknown rather than empty. Asking a Sonarr client is a bug, so it
   * throws rather than returning a plausible empty array.
   *
   * The three discovery flags are sent explicitly even though they default false: with them
   * off, Radarr answers from its own cached list entries and reaches nothing upstream.
   */
  async listImportListMovies(): Promise<ArrResource<ArrImportListMovie>[]> {
    if (this.mediaKind !== 'movie') {
      throw new ValidationError('import list contents are only available on Radarr');
    }
    return toResources(
      arrImportListMovieSchema,
      await this.request<unknown>({
        path: '/importlist/movie',
        query: {
          includeRecommendations: 'false',
          includeTrending: 'false',
          includePopular: 'false',
        },
      }),
    );
  }

  async getImportList(importListId: number): Promise<ArrResource<ArrImportList>> {
    const body = await this.request<unknown>({ path: `/importlist/${importListId}` });
    return toResource(arrImportListSchema, body);
  }

  /** Takes the full merged body - see mergeForPut. */
  async putImportList(importListId: number, body: ArrJson): Promise<ArrResource<ArrImportList>> {
    const response = await this.request<unknown>({
      method: 'PUT',
      path: `/importlist/${importListId}`,
      body,
    });
    return toResource(arrImportListSchema, response ?? body);
  }

  async deleteImportList(importListId: number): Promise<void> {
    await this.request<void>({ method: 'DELETE', path: `/importlist/${importListId}` });
  }

  // ------------------------------------------------------------------ collections

  /**
   * **Radarr only.** Sonarr has no collections, so asking a Sonarr client is a bug rather
   * than a question with an empty answer - the same rule `listImportListMovies` follows.
   *
   * A Radarr older than v4 answers 404 here. That is *not* caught: the caller decides
   * whether a missing endpoint means unknown, because only it knows whether an unknown is
   * survivable, and swallowing it here would make a timeout look like an empty fleet.
   */
  async listCollections(): Promise<ArrResource<ArrCollection>[]> {
    this.requireCollections();
    return toResources(arrCollectionSchema, await this.request<unknown>({ path: '/collection' }));
  }

  async getCollection(collectionId: number): Promise<ArrResource<ArrCollection>> {
    this.requireCollections();
    return toResource(
      arrCollectionSchema,
      await this.request<unknown>({ path: `/collection/${String(collectionId)}` }),
    );
  }

  /** Takes the full merged body - see mergeForPut. The only way to write a collection's tags. */
  async putCollection(collectionId: number, body: ArrJson): Promise<ArrResource<ArrCollection>> {
    this.requireCollections();
    const response = await this.request<unknown>({
      method: 'PUT',
      path: `/collection/${String(collectionId)}`,
      body,
    });
    return toResource(arrCollectionSchema, response ?? body);
  }

  /**
   * PUT /collection - the collection editor.
   *
   * Partial by design, exactly like `/{movie,series}/editor`: only the keys present in the
   * body are touched, so this is one of the two endpoints the merge-before-PUT rule does
   * not apply to. Merging a whole collection resource in would be meaningless - the
   * endpoint has no field to receive one.
   */
  async bulkEditCollections(params: BulkEditCollectionParams): Promise<number> {
    this.requireCollections();
    if (params.collectionIds.length === 0) return 0;

    const body: ArrJson = { collectionIds: [...params.collectionIds] };
    if (params.rootFolderPath !== undefined) body['rootFolderPath'] = params.rootFolderPath;
    if (params.qualityProfileId !== undefined) body['qualityProfileId'] = params.qualityProfileId;
    if (params.minimumAvailability !== undefined)
      body['minimumAvailability'] = params.minimumAvailability;
    if (params.monitored !== undefined) body['monitored'] = params.monitored;
    if (params.monitorMovies !== undefined) body['monitorMovies'] = params.monitorMovies;
    if (params.searchOnAdd !== undefined) body['searchOnAdd'] = params.searchOnAdd;

    const response = await this.request<unknown>({ method: 'PUT', path: '/collection', body });
    return Array.isArray(response) ? response.length : params.collectionIds.length;
  }

  private requireCollections(): void {
    if (this.mediaKind !== 'movie') {
      throw new ValidationError('collections are only available on Radarr');
    }
  }

  // -------------------------------------------------------------------- commands

  /** e.g. RefreshMovie / RefreshSeries after a root folder move. */
  async runCommand(name: string, payload: ArrJson = {}): Promise<ArrCommand> {
    const body = await this.request<unknown>({
      method: 'POST',
      path: '/command',
      body: { name, ...payload },
    });
    return arrCommandSchema.parse(body);
  }
}

function trimTrailingSlashes(target: string): string {
  const trimmed = target.replace(/\/+$/, '');
  return trimmed.length === 0 ? target : trimmed;
}

/** In-memory paging + filtering over a fetched library. */
export function pageMedia(all: readonly ArrMedia[], query: MediaQuery): MediaPage {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 100));
  const search = query.search?.trim().toLowerCase();

  const filtered = all.filter((media) => {
    if (search && !media.title.toLowerCase().includes(search)) return false;
    if (query.tagId !== undefined && !media.tags.includes(query.tagId)) return false;
    if (query.rootFolderPath !== undefined) {
      // Separator-aware on purpose: a bare startsWith makes /data/movies match
      // /data/movies-4k/Title, and this filter picks the ids a re-map moves.
      const prefix = trimTrailingSlashes(query.rootFolderPath);
      const target = trimTrailingSlashes(media.path);
      const matchesRoot =
        trimTrailingSlashes(media.rootFolderPath ?? '') === prefix ||
        target === prefix ||
        target.startsWith(`${prefix}/`);
      if (!matchesRoot) return false;
    }
    return true;
  });

  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems: filtered.length,
    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
  };
}
