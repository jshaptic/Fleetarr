import type { ArrCollection, ArrImportList, ArrMedia, ArrQualityProfile, ArrRootFolder, ArrTagDetail } from './arr.js';
import type { ConnectionTestResult, Instance } from './instance.js';
import type { NewQueueItem, QueueItem, QueueItemStatus } from './queue.js';
import type { OnErrorPolicy, QueueEvent, QueueRun } from './run.js';

/** Every non-2xx response from /api has this shape. */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ApiErrorResponse {
  readonly error: ApiError;
}

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly database: 'ok' | 'error';
  readonly schemaVersion: number;
}

export interface InstanceListResponse {
  readonly instances: readonly Instance[];
}

/**
 * A snapshot of one instance's editable objects. `fetchedAt` is surfaced in the UI
 * so the user knows how stale the grid is before staging bulk changes.
 */
export interface ResourceSnapshotResponse {
  readonly instanceId: number;
  readonly fetchedAt: string;
  readonly tags: readonly ArrTagDetail[];
  readonly rootFolders: readonly ArrRootFolder[];
  readonly importLists: readonly ArrImportList[];
  readonly qualityProfiles: readonly ArrQualityProfile[];
  /**
   * Radarr collections. **`null` is unknown, `[]` is genuinely none.**
   *
   * Null on every Sonarr instance would be wrong - Sonarr has no collections, which is an
   * answer. Null is for a Radarr too old to expose `/collection` and for a read that
   * failed, so a caller counting tag usage never reports "nothing uses this tag" on
   * behalf of an instance it could not ask.
   */
  readonly collections: readonly ArrCollection[] | null;
}

export interface QueueListResponse {
  readonly items: readonly QueueItem[];
  readonly activeRun: QueueRun | null;
}

export interface ReorderQueueRequest {
  /** Item ids in the order they should execute. */
  readonly itemIds: readonly number[];
}

export interface StartRunRequest {
  readonly onError?: OnErrorPolicy;
  /** Restrict the run to a subset of pending items. Omit to apply everything. */
  readonly itemIds?: readonly number[];
}

export interface RunResponse {
  readonly run: QueueRun;
  readonly items: readonly QueueItem[];
}

export interface RunEventsResponse {
  readonly events: readonly QueueEvent[];
}

export interface InstanceResponse {
  readonly instance: Instance;
  /** Present when the write was accompanied by a connectivity probe. */
  readonly test?: ConnectionTestResult;
}

/** Body of POST /api/instances/test - checks credentials that are not saved yet. */
export interface ConnectionTestRequest {
  readonly kind: Instance['kind'];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly verifySsl?: boolean;
  readonly timeoutMs?: number;
}

/** Body of POST /api/queue - one item or a batch, staged atomically. */
export interface PushQueueRequest {
  readonly items: readonly NewQueueItem[];
}

export interface MediaPageResponse {
  readonly instanceId: number;
  readonly fetchedAt: string;
  readonly items: readonly ArrMedia[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface ResumeRunRequest {
  readonly retryFailed?: boolean;
  readonly skipFailed?: boolean;
}

export interface RunListResponse {
  readonly runs: readonly QueueRun[];
}

/** Full audit detail for one queue item, including the raw *Arr exchanges. */
export interface QueueItemDetailResponse {
  readonly item: QueueItem;
  readonly events: ReadonlyArray<
    QueueEvent & { readonly requestBody: string | null; readonly responseBody: string | null }
  >;
}

export interface ClearQueueResponse {
  readonly removed: number;
  readonly statuses: readonly QueueItemStatus[];
}
