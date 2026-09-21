import {
  isFsOp,
  type OnErrorPolicy,
  type QueueItem,
  type QueueRun,
  type RunEvent,
} from '@fleetarr/shared';
import type { FastifyBaseLogger } from 'fastify';
import { ArrClient } from '../arr/client.js';
import type { ArrDispatcherPool, ArrHttpTrace } from '../arr/http.js';
import type { FilesystemService, FsTrace } from '../fs/filesystem.service.js';
import { ConflictError, serialiseError, ValidationError } from '../lib/errors.js';
import type { InstancesRepository } from '../repositories/instances.repo.js';
import type { QueueRepository } from '../repositories/queue.repo.js';
import type { RunsRepository } from '../repositories/runs.repo.js';
import type { SnapshotsRepository } from '../repositories/snapshots.repo.js';
import type { RunEventBus } from './events.js';
import {
  arrHandlers,
  fsHandlers,
  type ArrHandlerContext,
  type FsHandlerContext,
  type HandlerContext,
  type QueueHandlerResult,
} from './handlers.js';

export interface QueueExecutorDeps {
  readonly instances: InstancesRepository;
  readonly filesystem: FilesystemService;
  readonly queue: QueueRepository;
  readonly runs: RunsRepository;
  readonly snapshots: SnapshotsRepository;
  readonly dispatchers: ArrDispatcherPool;
  readonly events: RunEventBus;
  readonly logger: FastifyBaseLogger;
  /** Called after a filesystem item succeeds, so cached scans can be dropped. */
  readonly onFilesystemChanged?: () => void;
  /**
   * Called after an *Arr item succeeds. Invalidating that instance's snapshots is not
   * enough on its own: anything that joins *Arr truth to the disk keeps its own cache,
   * and a root folder created by a run must show up in the next read.
   */
  readonly onInstanceChanged?: (instanceId: number) => void;
}

export interface StartRunOptions {
  readonly onError?: OnErrorPolicy;
  /** Restrict the run to a subset of pending items. Omit to apply everything. */
  readonly itemIds?: readonly number[];
}

export interface ResumeRunOptions {
  /** Put failed items back in the queue before continuing. */
  readonly retryFailed?: boolean;
  /** Mark failed items as skipped so the run can move past them. */
  readonly skipFailed?: boolean;
}

export interface RunSnapshot {
  readonly run: QueueRun;
  readonly items: readonly QueueItem[];
}

type ItemOutcome = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** Handler dispatch: TS cannot correlate `item.op` with the map lookup, so cast once. */
type AnyArrHandler = (ctx: ArrHandlerContext, item: QueueItem) => Promise<QueueHandlerResult>;
type AnyFsHandler = (ctx: FsHandlerContext, item: QueueItem) => Promise<QueueHandlerResult>;

interface ActiveRun {
  readonly runId: number;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/**
 * Executes the staged queue one item at a time.
 *
 * The safety property this class exists for: when step N fails, nothing after it runs.
 * The run is marked `paused`, the failed item keeps its error, and every later item is
 * left `pending` so the user can fix the cause and resume - or cancel and lose nothing.
 */
export class QueueExecutor {
  private active: ActiveRun | null = null;

  constructor(private readonly deps: QueueExecutorDeps) {}

  get activeRunId(): number | null {
    return this.active?.runId ?? null;
  }

  /** Called at boot: a process that died mid-run leaves rows claiming to be running. */
  recoverInterrupted(): void {
    const interrupted = this.deps.runs.list(100).filter((run) => run.status === 'running');

    for (const run of interrupted) {
      for (const item of this.deps.queue.list({ runId: run.id })) {
        if (item.status !== 'running') continue;
        this.deps.queue.markFailed(item.id, {
          code: 'interrupted',
          message: 'Interrupted by an Fleetarr restart - the *Arr instance may have applied it',
          httpStatus: null,
        });
      }
      this.deps.runs.syncCounters(run.id);
      this.deps.runs.update(run.id, {
        status: 'paused',
        currentItemId: null,
        error: 'Interrupted by an Fleetarr restart',
      });
      this.deps.logger.warn({ runId: run.id }, 'recovered interrupted run as paused');
    }
  }

  start(options: StartRunOptions = {}): RunSnapshot {
    this.assertIdle();

    const pending = this.deps.queue.list({ status: 'pending' });
    const selected =
      options.itemIds === undefined
        ? pending
        : pending.filter((item) => options.itemIds?.includes(item.id) === true);

    if (selected.length === 0) {
      throw new ValidationError('Nothing to apply - no pending items match this request');
    }

    const run = this.deps.runs.create({
      onError: options.onError ?? 'pause',
      totalItems: selected.length,
    });
    const items = this.deps.queue.claimForRun(
      run.id,
      selected.map((item) => item.id),
    );

    this.launch(run.id);
    return { run, items };
  }

  resume(runId: number, options: ResumeRunOptions = {}): RunSnapshot {
    this.assertIdle(runId);

    const run = this.deps.runs.require(runId);
    if (run.status !== 'paused') {
      throw new ValidationError(`Run ${runId} is ${run.status} - only a paused run can be resumed`);
    }

    const failed = this.deps.queue.list({ runId }).filter((item) => item.status === 'failed');

    if (options.retryFailed === true) {
      // resetToPending detaches the item from the run, so re-claim it afterwards.
      const retried = failed.map((item) => this.deps.queue.resetToPending(item.id).id);
      this.deps.queue.claimForRun(runId, retried);
    } else if (options.skipFailed === true) {
      for (const item of failed) {
        this.deps.queue.markSkipped(item.id, 'Skipped by the user after a failure');
      }
    }

    this.deps.runs.syncCounters(runId);
    const resumed = this.deps.runs.update(runId, { status: 'running', error: null });

    this.launch(runId);
    return { run: resumed, items: this.deps.queue.list({ runId }) };
  }

  /** Stops a run and stands down everything still queued in it. */
  async cancel(runId: number): Promise<QueueRun> {
    const run = this.deps.runs.require(runId);

    if (this.active?.runId === runId) {
      this.active.controller.abort();
      await this.active.done;
      return this.deps.runs.require(runId);
    }

    if (run.status !== 'running' && run.status !== 'paused') {
      throw new ValidationError(`Run ${runId} is already ${run.status}`);
    }

    this.deps.queue.markCancelledForRun(runId);
    this.deps.runs.syncCounters(runId);
    const cancelled = this.deps.runs.update(runId, {
      status: 'cancelled',
      currentItemId: null,
      finished: true,
    });
    this.publish(runId, { type: 'run.finished', run: cancelled });
    return cancelled;
  }

  /** Graceful shutdown: let the in-flight item finish before the process exits. */
  async waitForIdle(): Promise<void> {
    await this.active?.done;
  }

  // ------------------------------------------------------------------ internals

  private assertIdle(allowRunId?: number): void {
    if (this.active !== null) {
      throw new ConflictError(`Run ${this.active.runId} is already in progress`);
    }
    const active = this.deps.runs.findActive();
    if (active !== null && active.id !== allowRunId) {
      throw new ConflictError(
        `Run ${active.id} is ${active.status} - resume or cancel it before starting another`,
      );
    }
  }

  private launch(runId: number): void {
    const controller = new AbortController();
    const done = this.execute(runId, controller.signal)
      .catch((error: unknown) => {
        this.deps.logger.error({ err: error, runId }, 'run failed unexpectedly');
        const serialised = serialiseError(error);
        const failed = this.deps.runs.update(runId, {
          status: 'failed',
          currentItemId: null,
          error: serialised.message,
          finished: true,
        });
        this.publish(runId, { type: 'run.finished', run: failed });
      })
      .finally(() => {
        if (this.active?.controller === controller) this.active = null;
      });

    this.active = { runId, controller, done };
  }

  private async execute(runId: number, signal: AbortSignal): Promise<void> {
    this.publish(runId, { type: 'run.started', run: this.deps.runs.require(runId) });

    for (;;) {
      if (signal.aborted) {
        this.finishCancelled(runId);
        return;
      }

      const item = this.deps.queue.nextPendingForRun(runId);
      if (item === null) break;

      const outcome = await this.executeItem(runId, item, signal);

      if (outcome === 'cancelled') {
        this.finishCancelled(runId);
        return;
      }

      if (outcome === 'failed') {
        const policy = this.deps.runs.require(runId).onError;

        if (policy === 'pause') {
          // The safety halt: stop here, leave everything after this item pending.
          const paused = this.deps.runs.update(runId, {
            status: 'paused',
            currentItemId: item.id,
            error: this.deps.queue.require(item.id).error?.message ?? 'Step failed',
          });
          this.deps.logger.warn({ runId, itemId: item.id }, 'run paused after a failed step');
          this.publish(runId, { type: 'run.paused', run: paused, failedItemId: item.id });
          return;
        }

        if (policy === 'abort') {
          this.deps.queue.markCancelledForRun(runId);
          this.deps.runs.syncCounters(runId);
          const aborted = this.deps.runs.update(runId, {
            status: 'failed',
            currentItemId: null,
            error: this.deps.queue.require(item.id).error?.message ?? 'Step failed',
            finished: true,
          });
          this.publish(runId, { type: 'run.finished', run: aborted });
          return;
        }
        // policy === 'continue' falls through to the next item.
      }
    }

    const counted = this.deps.runs.syncCounters(runId);
    const finished = this.deps.runs.update(runId, {
      status: counted.failedItems > 0 ? 'failed' : 'completed',
      currentItemId: null,
      finished: true,
    });
    this.deps.logger.info(
      { runId, succeeded: finished.succeededItems, failed: finished.failedItems },
      'run finished',
    );
    this.publish(runId, { type: 'run.finished', run: finished });
  }

  private async executeItem(
    runId: number,
    item: QueueItem,
    signal: AbortSignal,
  ): Promise<ItemOutcome> {
    const dependencyResult = this.resolveDependency(runId, item);
    if (dependencyResult === 'blocked') return this.finishItem(runId, item.id, 'skipped');

    this.deps.queue.markRunning(item.id);
    this.deps.runs.update(runId, { currentItemId: item.id });
    this.publish(runId, { type: 'item.started', runId, item: this.deps.queue.require(item.id) });

    const onTrace = (trace: ArrHttpTrace): void => {
      this.deps.runs.appendEvent({
        runId,
        itemId: item.id,
        level: trace.error === null ? 'debug' : 'error',
        message: trace.error ?? `${trace.method} ${trace.status ?? '-'} (${trace.durationMs}ms)`,
        httpMethod: trace.method,
        httpUrl: trace.url,
        httpStatus: trace.status,
        requestBody: trace.requestBody,
        // GET bodies are large and uninteresting unless something went wrong.
        responseBody: trace.error !== null || trace.method !== 'GET' ? trace.responseBody : null,
      });
    };

    const base: HandlerContext = {
      signal,
      dependencyResult,
      log: (level, message) => {
        this.deps.runs.appendEvent({ runId, itemId: item.id, level, message });
        this.publish(runId, { type: 'log', runId, level, message });
      },
    };

    try {
      const result = isFsOp(item.op)
        ? await this.runFsItem(runId, item, base)
        : await this.runArrItem(item, base, onTrace);

      this.deps.queue.markSucceeded(item.id, result ?? null);

      if (item.instanceId !== null) {
        // The instance just changed underneath the cached view.
        this.deps.snapshots.invalidate(item.instanceId);
        this.deps.onInstanceChanged?.(item.instanceId);
      } else {
        // The disk changed: cached sizes and the orphan report are now stale.
        this.deps.filesystem.invalidateMeasurements();
        this.deps.onFilesystemChanged?.();
      }

      return this.finishItem(runId, item.id, 'succeeded');
    } catch (error) {
      if (signal.aborted) {
        this.deps.queue.markCancelled(item.id, 'Run cancelled while this step was running');
        return this.finishItem(runId, item.id, 'cancelled');
      }

      const serialised = serialiseError(error);
      this.deps.queue.markFailed(item.id, {
        code: serialised.code,
        message: serialised.message,
        httpStatus: serialised.httpStatus,
      });
      this.deps.runs.appendEvent({
        runId,
        itemId: item.id,
        level: 'error',
        message: `${serialised.code}: ${serialised.message}`,
      });
      this.deps.logger.warn(
        { runId, itemId: item.id, op: item.op, code: serialised.code },
        'queue item failed',
      );
      return this.finishItem(runId, item.id, 'failed');
    }
  }

  private async runArrItem(
    item: QueueItem,
    base: HandlerContext,
    onTrace: (trace: ArrHttpTrace) => void,
  ): Promise<QueueHandlerResult> {
    if (item.instanceId === null) {
      throw new ValidationError(`Queue item ${String(item.id)} targets ${item.op} without an instance`);
    }

    const instance = this.deps.instances.requireWithKey(item.instanceId);
    const client = new ArrClient(
      instance,
      { dispatcher: this.deps.dispatchers.get(instance) },
      { signal: base.signal, onTrace },
    );

    const handler = arrHandlers[item.op as keyof typeof arrHandlers] as unknown as AnyArrHandler;
    return handler({ ...base, client, instance }, item);
  }

  /** Disk work is traced into the same audit trail as an HTTP exchange. */
  private async runFsItem(
    runId: number,
    item: QueueItem,
    base: HandlerContext,
  ): Promise<QueueHandlerResult> {
    const onFsTrace = (trace: FsTrace): void => {
      this.deps.runs.appendEvent({
        runId,
        itemId: item.id,
        level: trace.error === null ? 'debug' : 'error',
        message:
          trace.error ??
          `${trace.op} ${trace.path}${trace.detail === null ? '' : ` ${trace.detail}`} (${String(trace.durationMs)}ms)`,
        httpMethod: null,
        httpUrl: null,
        httpStatus: null,
        requestBody: JSON.stringify(item.payload),
        responseBody: trace.detail,
      });
    };

    const filesystem = this.deps.filesystem.withTraceSink(onFsTrace);
    const handler = fsHandlers[item.op as keyof typeof fsHandlers] as unknown as AnyFsHandler;
    return handler({ ...base, fs: filesystem }, item);
  }

  /**
   * Returns the dependency's result for the handler, or 'blocked' when the item it
   * depends on did not succeed - in which case this item is skipped rather than run
   * against stale assumptions.
   */
  private resolveDependency(
    runId: number,
    item: QueueItem,
  ): Record<string, unknown> | null | 'blocked' {
    if (item.dependsOnId === null) return null;

    const dependency = this.deps.queue.get(item.dependsOnId);
    if (dependency === null || dependency.status !== 'succeeded') {
      const reason =
        dependency === null
          ? `Depends on item ${item.dependsOnId}, which no longer exists`
          : `Depends on item ${item.dependsOnId}, which is ${dependency.status}`;
      this.deps.queue.markSkipped(item.id, reason);
      this.deps.runs.appendEvent({ runId, itemId: item.id, level: 'warn', message: reason });
      return 'blocked';
    }

    return dependency.result === null ? null : { ...dependency.result };
  }

  private finishItem(runId: number, itemId: number, outcome: ItemOutcome): ItemOutcome {
    const run = this.deps.runs.syncCounters(runId);
    this.publish(runId, {
      type: 'item.finished',
      runId,
      item: this.deps.queue.require(itemId),
      run,
    });
    return outcome;
  }

  private finishCancelled(runId: number): void {
    this.deps.queue.markCancelledForRun(runId);
    this.deps.runs.syncCounters(runId);
    const cancelled = this.deps.runs.update(runId, {
      status: 'cancelled',
      currentItemId: null,
      finished: true,
    });
    this.deps.logger.info({ runId }, 'run cancelled');
    this.publish(runId, { type: 'run.finished', run: cancelled });
  }

  private publish(runId: number, event: RunEvent): void {
    this.deps.events.publish(runId, event);
  }
}
