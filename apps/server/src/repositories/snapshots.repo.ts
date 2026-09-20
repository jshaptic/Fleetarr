import type { SqliteDatabase } from '../db/client.js';
import { nowIso } from '../db/mappers.js';
import type { ResourceSnapshotRow } from '../db/rows.js';

export type SnapshotResource =
  | 'tag'
  | 'tagDetail'
  | 'rootFolder'
  | 'importList'
  | 'qualityProfile'
  | 'media'
  /**
   * What Radarr's import lists currently hold, joined to the library on tmdbId.
   *
   * The one snapshot whose payload is a **projection** rather than the verbatim body:
   * `/importlist/movie` carries poster URLs with no parameter to strip them, so it is
   * reduced and filtered to library items before storing, which bounds it by library size
   * however large the list. Safe because nothing is ever written back - the keep-raw rule
   * is there so a PUT can round-trip via `mergeForPut`.
   *
   * Radarr only. Sonarr exposes no equivalent endpoint, so list membership there is
   * unknown, deliberately not empty.
   */
  | 'importListMovie'
  /**
   * Radarr collections. **Radarr only**, and a verbatim body - unlike `importListMovie`,
   * because `collectionTags.*` reads one back and PUTs it through `mergeForPut`, which is
   * precisely what the keep-raw rule exists for.
   *
   * A missing snapshot here means unknown, never "no collections": a Radarr older than v4
   * has no `/collection` endpoint at all, and Sonarr has no collections as a matter of
   * fact rather than of access.
   */
  | 'collection';

export interface Snapshot<T> {
  readonly payload: T;
  readonly fetchedAt: string;
}

/**
 * Cache of raw *Arr responses. The grid renders from here so browsing does not hammer
 * the instance, and the UI can show how stale the view is before bulk edits are staged.
 */
export class SnapshotsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get<T>(instanceId: number, resource: SnapshotResource): Snapshot<T> | null {
    const row = this.db
      .prepare('SELECT * FROM resource_snapshots WHERE instance_id = ? AND resource = ?')
      .get(instanceId, resource) as ResourceSnapshotRow | undefined;
    if (row === undefined) return null;
    return { payload: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at };
  }

  put<T>(instanceId: number, resource: SnapshotResource, payload: T): Snapshot<T> {
    const fetchedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO resource_snapshots (instance_id, resource, payload, fetched_at)
         VALUES (@instanceId, @resource, @payload, @fetchedAt)
         ON CONFLICT (instance_id, resource)
         DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run({ instanceId, resource, payload: JSON.stringify(payload), fetchedAt });
    return { payload, fetchedAt };
  }

  /** Called after a run mutates an instance - the cached view is now wrong. */
  invalidate(instanceId: number, resources?: readonly SnapshotResource[]): void {
    if (resources === undefined) {
      this.db.prepare('DELETE FROM resource_snapshots WHERE instance_id = ?').run(instanceId);
      return;
    }
    if (resources.length === 0) return;
    const placeholders = resources.map(() => '?').join(', ');
    this.db
      .prepare(`DELETE FROM resource_snapshots WHERE instance_id = ? AND resource IN (${placeholders})`)
      .run(instanceId, ...resources);
  }
}
