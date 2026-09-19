import type {
  FsAssumeResolved,
  FsDirectoriesResponse,
  FsMeasurement,
  PathFilterMode,
  FsOp,
  FsPreflight,
  FsRootsResponse,
  PathMatrixResponse,
  PathSelector,
  QueuePayloadFor,
} from '@fleetarr/shared';
import { api } from './client';

export interface MatrixParams {
  /** Directories to expand. Empty asks for the spine: mounts down to each root folder. */
  readonly paths?: readonly string[];
  readonly only?: readonly PathSelector[];
  readonly filter?: string;
  /** `exclude` inverts the filter. Absent means `include`. */
  readonly filterMode?: PathFilterMode;
  readonly limit?: number;
  readonly offset?: number;
  /** Show only these instances' folders. Empty means the whole fleet. */
  readonly instanceIds?: readonly number[];
  readonly refresh?: boolean;
}

/** Repeatable `path`, so refetching every expanded level costs one request. */
function matrixQuery(params: MatrixParams): string {
  const query = new URLSearchParams();
  for (const target of params.paths ?? []) query.append('path', target);
  if (params.only !== undefined && params.only.length > 0) query.set('only', params.only.join(','));
  if (params.filter !== undefined && params.filter.length > 0) {
    query.set('q', params.filter);
    if (params.filterMode !== undefined) query.set('qmode', params.filterMode);
  }
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined && params.offset > 0) query.set('offset', String(params.offset));
  // Repeatable too: one filtered request for every open level, not one per instance.
  for (const instanceId of params.instanceIds ?? []) query.append('instance', String(instanceId));
  if (params.refresh === true) query.set('refresh', 'true');

  const serialised = query.toString();
  return serialised.length === 0 ? '' : `?${serialised}`;
}

export const storageApi = {
  roots: () => api.get<FsRootsResponse>('/storage/roots'),

  /** The joined view: disk truth and *Arr truth, one directory level at a time. */
  matrix: (params: MatrixParams = {}) =>
    api.get<PathMatrixResponse>(`/storage/matrix${matrixQuery(params)}`),

  /**
   * Every directory that could be a destination, flat. One request, not a crawl: the
   * pickers filter it in the browser, so nothing is asked for per keystroke.
   */
  directories: (params: { under?: string; refresh?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.under !== undefined) query.set('under', params.under);
    if (params.refresh === true) query.set('refresh', 'true');
    const serialised = query.toString();
    return api.get<FsDirectoriesResponse>(
      `/storage/directories${serialised.length === 0 ? '' : `?${serialised}`}`,
    );
  },

  measure: (path: string) =>
    api.get<FsMeasurement>(`/storage/measure?path=${encodeURIComponent(path)}`),

  /**
   * What would happen if this ran, asked before anything is staged.
   *
   * `assumeResolved` says which *Arr claims the caller is about to stage a fix for, so the
   * answer is the verdict that will hold once it has. It never reaches the queue: the
   * executor's own re-run asks with no assumptions at all.
   */
  preflight: <K extends FsOp>(
    op: K,
    payload: QueuePayloadFor<K>,
    assumeResolved?: FsAssumeResolved,
  ) =>
    api.post<FsPreflight>('/storage/preflight', {
      op,
      payload,
      ...(assumeResolved === undefined ? {} : { assumeResolved }),
    }),

};
