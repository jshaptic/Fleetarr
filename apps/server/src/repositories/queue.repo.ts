import {
  affectedCountForOp,
  describeQueueTarget,
  kindOfOp,
  summariseQueueOp,
  targetKindForOp,
  type InstanceKind,
  type NewQueueItem,
  type QueueItem,
  type QueueItemStatus,
} from '@fleetarr/shared';
import type { SqliteDatabase } from '../db/client.js';
import { nowIso, rowToQueueItem } from '../db/mappers.js';
import type { QueueItemRow } from '../db/rows.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

export interface QueueListFilter {
  readonly status?: QueueItemStatus;
  readonly instanceId?: number;
  readonly runId?: number;
}

export interface QueueItemFailure {
  readonly code: string;
  readonly message: string;
  readonly httpStatus?: number | null;
}

/** Resolves the instance kind for an item being staged - media ops differ per flavour. */
export type InstanceKindResolver = (instanceId: number) => InstanceKind;

export class QueueRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Stages one or more actions. Runs in a single transaction so a rejected item cannot
   * leave a half-written batch behind, and so sort_order stays contiguous.
   */
  push(items: readonly NewQueueItem[], resolveKind: InstanceKindResolver): QueueItem[] {
    if (items.length === 0) return [];

    const insert = this.db.prepare(`
      INSERT INTO queue_items (
        instance_id, kind, depends_on_id, sort_order, op, target_kind, target_id,
        target_label, summary, payload, affected_count
      ) VALUES (
        @instanceId, @kind, @dependsOnId, @sortOrder, @op, @targetKind, @targetId,
        @targetLabel, @summary, @payload, @affectedCount
      ) RETURNING *
    `);

    const insertAll = this.db.transaction((batch: readonly NewQueueItem[]): QueueItem[] => {
      let sortOrder = this.nextSortOrder();
      const created: QueueItem[] = [];

      for (const item of batch) {
        // Filesystem work has no instance, so there is no flavour to resolve.
        const instanceId = item.instanceId ?? null;
        const instanceKind = instanceId === null ? null : resolveKind(instanceId);
        const target = describeQueueTarget(item);

        if (item.dependsOnId !== undefined && this.findRow(item.dependsOnId) === null) {
          throw new ValidationError(`Queue item ${item.dependsOnId} referenced by dependsOnId does not exist`);
        }

        // `mediaTags.set` is deliberately absent from this guard: an empty list there means
        // "clear every tag", which is a real instruction rather than a missing id. For add
        // and remove an empty list can only be a mistake, unless a tag.create step is about
        // to produce the id.
        if (
          (item.op === 'mediaTags.add' || item.op === 'mediaTags.remove') &&
          item.payload.tagIds.length === 0 &&
          item.dependsOnId === undefined
        ) {
          throw new ValidationError(
            `${item.op} needs at least one tag id, or a dependsOnId pointing at the tag.create step that produces one`,
          );
        }

        const row = insert.get({
          instanceId,
          kind: kindOfOp(item.op),
          dependsOnId: item.dependsOnId ?? null,
          sortOrder: sortOrder++,
          op: item.op,
          targetKind: targetKindForOp(item.op, instanceKind),
          targetId: target.targetId,
          targetLabel: target.targetLabel,
          summary: summariseQueueOp(item),
          payload: JSON.stringify(item.payload),
          affectedCount: affectedCountForOp(item),
        }) as QueueItemRow;

        created.push(rowToQueueItem(row));
      }

      return created;
    });

    return insertAll(items);
  }

  list(filter: QueueListFilter = {}): QueueItem[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (filter.status !== undefined) {
      conditions.push('status = @status');
      params['status'] = filter.status;
    }
    if (filter.instanceId !== undefined) {
      conditions.push('instance_id = @instanceId');
      params['instanceId'] = filter.instanceId;
    }
    if (filter.runId !== undefined) {
      conditions.push('run_id = @runId');
      params['runId'] = filter.runId;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM queue_items ${where} ORDER BY sort_order, id`)
      .all(params) as QueueItemRow[];
    return rows.map(rowToQueueItem);
  }

  get(id: number): QueueItem | null {
    const row = this.findRow(id);
    return row === null ? null : rowToQueueItem(row);
  }

  require(id: number): QueueItem {
    const item = this.get(id);
    if (!item) throw new NotFoundError(`Queue item ${id}`);
    return item;
  }

  /** Full reorder: the caller sends every pending id in the order it should execute. */
  reorder(itemIds: readonly number[]): QueueItem[] {
    const pending = this.list({ status: 'pending' });
    const pendingIds = new Set(pending.map((item) => item.id));

    if (itemIds.length !== pendingIds.size || !itemIds.every((id) => pendingIds.has(id))) {
      throw new ValidationError('Reorder must list every pending item exactly once', {
        expected: [...pendingIds],
        received: itemIds,
      });
    }

    // The executor takes items strictly in sort_order and never defers: a dependent whose
    // producer has not run yet is *skipped*, permanently, not retried. So an order that
    // puts one before the other does not reorder the chain, it silently deletes half of
    // it - and the half that survives is whichever the user did not think about.
    const position = new Map(itemIds.map((id, index) => [id, index]));
    for (const item of pending) {
      if (item.dependsOnId === null) continue;
      const producer = position.get(item.dependsOnId);
      const dependent = position.get(item.id);
      if (producer === undefined || dependent === undefined) continue;
      if (producer > dependent) {
        throw new ValidationError(
          `Queue item ${String(item.id)} depends on ${String(item.dependsOnId)} and cannot run before it`,
          { item: item.id, dependsOnId: item.dependsOnId },
        );
      }
    }

    const update = this.db.prepare('UPDATE queue_items SET sort_order = @sortOrder, updated_at = @at WHERE id = @id');
    const apply = this.db.transaction((ids: readonly number[]): void => {
      const at = nowIso();
      // Two passes with an offset: sort_order has no unique index, but keeping the
      // intermediate values out of the target range avoids surprises if one is added.
      ids.forEach((id, index) => update.run({ id, sortOrder: -(index + 1), at }));
      ids.forEach((id, index) => update.run({ id, sortOrder: index + 1, at }));
    });

    apply(itemIds);
    return this.list({ status: 'pending' });
  }

  remove(id: number): void {
    const item = this.require(id);
    if (item.status === 'running') {
      throw new ValidationError('Cannot remove an item while it is running');
    }
    this.db.prepare('DELETE FROM queue_items WHERE id = ?').run(id);
  }

  /** Clears finished work by default; pass statuses to be explicit. */
  clear(statuses: readonly QueueItemStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled']): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(`DELETE FROM queue_items WHERE status IN (${placeholders})`)
      .run(...statuses);
    return result.changes;
  }

  /** Puts a failed or skipped item back in line without losing its position. */
  resetToPending(id: number): QueueItem {
    const item = this.require(id);
    if (item.status === 'running') {
      throw new ValidationError('Cannot retry an item while it is running');
    }
    this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'pending', run_id = NULL, error_code = NULL, error_message = NULL,
                http_status = NULL, result = NULL, started_at = NULL, finished_at = NULL,
                updated_at = @at
          WHERE id = @id`,
      )
      .run({ id, at: nowIso() });
    return this.require(id);
  }

  /**
   * Attaches pending items to a run. Returns them in execution order; an explicit
   * itemIds list restricts the run to a subset.
   */
  claimForRun(runId: number, itemIds?: readonly number[]): QueueItem[] {
    const claim = this.db.transaction((): QueueItem[] => {
      const pending = this.list({ status: 'pending' });
      const selected =
        itemIds === undefined
          ? pending
          : pending.filter((item) => itemIds.includes(item.id));

      const update = this.db.prepare(
        'UPDATE queue_items SET run_id = @runId, updated_at = @at WHERE id = @id',
      );
      const at = nowIso();
      for (const item of selected) update.run({ id: item.id, runId, at });

      return selected.map((item) => ({ ...item, runId }));
    });

    return claim();
  }

  /** The next item the executor should run: lowest sort_order still pending in this run. */
  nextPendingForRun(runId: number): QueueItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_items
          WHERE run_id = ? AND status = 'pending'
          ORDER BY sort_order, id LIMIT 1`,
      )
      .get(runId) as QueueItemRow | undefined;
    return row === undefined ? null : rowToQueueItem(row);
  }

  markCancelled(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'cancelled', error_code = 'cancelled', error_message = @reason,
                finished_at = @at, updated_at = @at
          WHERE id = @id`,
      )
      .run({ id, at: nowIso(), reason });
  }

  markRunning(id: number): void {
    this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'running', attempts = attempts + 1, started_at = @at, updated_at = @at,
                error_code = NULL, error_message = NULL, http_status = NULL
          WHERE id = @id`,
      )
      .run({ id, at: nowIso() });
  }

  markSucceeded(id: number, result: Record<string, unknown> | null): void {
    this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'succeeded', result = @result, finished_at = @at, updated_at = @at
          WHERE id = @id`,
      )
      .run({ id, at: nowIso(), result: result === null ? null : JSON.stringify(result) });
  }

  markFailed(id: number, failure: QueueItemFailure): void {
    this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'failed', error_code = @code, error_message = @message,
                http_status = @httpStatus, finished_at = @at, updated_at = @at
          WHERE id = @id`,
      )
      .run({
        id,
        at: nowIso(),
        code: failure.code,
        message: failure.message,
        httpStatus: failure.httpStatus ?? null,
      });
  }

  markSkipped(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'skipped', error_code = 'skipped', error_message = @reason,
                finished_at = @at, updated_at = @at
          WHERE id = @id`,
      )
      .run({ id, at: nowIso(), reason });
  }

  /** Used when a run is cancelled: anything still pending in that run stands down. */
  markCancelledForRun(runId: number): number {
    const result = this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'cancelled', finished_at = @at, updated_at = @at
          WHERE run_id = @runId AND status IN ('pending','running')`,
      )
      .run({ runId, at: nowIso() });
    return result.changes;
  }

  /** Releases items of a halted run so they can be staged into the next one. */
  releaseFromRun(runId: number): number {
    const result = this.db
      .prepare(
        `UPDATE queue_items SET run_id = NULL, updated_at = @at
          WHERE run_id = @runId AND status = 'pending'`,
      )
      .run({ runId, at: nowIso() });
    return result.changes;
  }

  private nextSortOrder(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM queue_items').get() as {
      max: number;
    };
    return row.max + 1;
  }

  private findRow(id: number): QueueItemRow | null {
    const row = this.db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as
      | QueueItemRow
      | undefined;
    return row ?? null;
  }
}
