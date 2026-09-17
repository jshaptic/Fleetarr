import type {
  ImportListChanges,
  NewFsQueueItem,
  NewQueueItem,
  OnErrorPolicy,
  QueueItem,
  QueueOp,
  QueueRun,
  RunEvent,
  TargetKind,
} from '@fleetarr/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiRequestError } from '@/api/client';
import { queueApi } from '@/api/queue';
import type { ReplacementPreview } from '@/lib/matrix';
import { worseIntent, type OpPresentation } from '@/lib/staging';
import { useInstancesStore } from './instances';
import { useUiStore } from './ui';

export interface QueueImpact {
  readonly operations: number;
  readonly instances: number;
  readonly affectedItems: number;
  readonly byKind: ReadonlyArray<{ kind: TargetKind; targets: number }>;
  readonly byOp: ReadonlyArray<{ op: QueueOp; count: number }>;
}

export interface RunLogEntry {
  readonly at: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

export interface TagTarget {
  readonly instanceId: number;
  readonly tagId: number;
  readonly label: string;
}

export interface RootFolderTarget {
  readonly instanceId: number;
  readonly rootFolderId: number;
  readonly path: string;
}

/** One import list to aim at the new folder, with the path it should fill instead. */
export interface RemapListTarget {
  readonly importListId: number;
  readonly name: string;
  readonly toRootFolderPath: string;
}

export interface RemapTarget {
  readonly instanceId: number;
  readonly mediaIds: readonly number[];
  /** Set when the destination path does not exist on this instance yet. */
  readonly needsRootFolder: boolean;
  /** Set to also remove the old root folder once the move succeeds. */
  readonly removeRootFolderId: number | null;
  /**
   * Lists that fill the folder being left, and where each should point instead.
   *
   * Omitted when the switch is not re-pointing them. Left unaimed, a list refills the folder
   * the media just left, one sync at a time - which is the switch quietly undoing itself.
   */
  readonly importLists?: readonly RemapListTarget[];
}

export interface ImportListTarget {
  readonly instanceId: number;
  readonly importListId: number;
}

/**
 * One instance's share of a media selection.
 *
 * Always batched: a 300-title selection across two Radarrs is two queue items, not six
 * hundred. The ids come from the server's answer to the current filter, never from the
 * page the browser happens to be holding.
 */
export interface MediaTarget {
  readonly instanceId: number;
  readonly mediaIds: readonly number[];
}

/** What tags to end up with on one instance, once its missing labels have been created. */
export interface MediaTagTarget extends MediaTarget {
  /** Ids that already exist on this instance. */
  readonly tagIds: readonly number[];
  /** Labels this instance does not have yet - each becomes a `tag.create` to depend on. */
  readonly missingLabels: readonly string[];
}

/** Where one instance's copies should end up. Paths are never translated between them. */
export interface MediaMoveTarget extends MediaTarget {
  readonly toRootFolderPath: string;
  /** Set when that path is not a root folder on this instance yet. */
  readonly needsRootFolder: boolean;
}

/** The profile id this instance resolved the chosen *name* to. */
export interface MediaProfileTarget extends MediaTarget {
  readonly qualityProfileId: number;
}

const STAGED_STATUSES = new Set<QueueItem['status']>(['pending', 'running', 'failed']);

/** "12 item(s) on 2 instance(s)" - both numbers, because either alone reads as the other. */
function countOf(targets: readonly { mediaIds: readonly number[] }[]): string {
  const items = targets.reduce((sum, target) => sum + target.mediaIds.length, 0);
  return `${String(items)} item(s) on ${String(targets.length)} instance(s)`;
}

/** Filesystem work has no instance, so it groups under one pseudo-instance in the UI. */
export const LOCAL_STORAGE_GROUP = -1;

function stageKey(instanceId: number | null, kind: TargetKind, label: string): string {
  return `${instanceId ?? 'local'}|${kind}|${label}`;
}

/**
 * Which fleet cells an item is about, so the matrix can mark them as staged. A rename
 * touches two labels: the one disappearing and the one arriving.
 */
/**
 * The media ids an operation names.
 *
 * A second exhaustive switch, and the `default` here is the only acceptable one in this
 * file: it enumerates the ops that carry no media id at all. A new *media* op still has to
 * be listed, because forgetting it means the row shows no staged cue - which the store test
 * asserts one op at a time.
 */
function mediaIdsOf(item: QueueItem): readonly number[] {
  switch (item.op) {
    case 'mediaTags.add':
    case 'mediaTags.remove':
    case 'mediaTags.set':
    case 'media.moveRootFolder':
    case 'media.refresh':
    case 'media.setMonitored':
    case 'media.setQualityProfile':
    case 'media.delete':
      return item.payload.mediaIds;
    default:
      return [];
  }
}

function stageKeysFor(item: QueueItem): string[] {
  switch (item.op) {
    case 'tag.create':
      return [stageKey(item.instanceId, 'tag', item.payload.label)];
    case 'tag.rename':
      return [
        stageKey(item.instanceId, 'tag', item.payload.from),
        stageKey(item.instanceId, 'tag', item.payload.to),
      ];
    case 'tag.delete':
      return [stageKey(item.instanceId, 'tag', item.payload.label)];
    case 'tag.merge':
      return [stageKey(item.instanceId, 'tag', item.targetLabel)];
    // Two keys each: the owner chip in the Used by column reads the per-instance one, and
    // the folder row's own staged glyph reads the path one. Without the second, a root-folder
    // switch that stages no disk step at all marks neither folder as pending.
    case 'rootFolder.create':
    case 'rootFolder.delete':
      return [
        stageKey(item.instanceId, 'rootFolder', item.payload.path),
        stageKey(null, 'path', item.payload.path),
      ];
    case 'media.moveRootFolder':
      // Only the destination: the source path is not in the payload, and putting it there
      // would be a queue contract change plus a migration for a second glyph. The old folder
      // is already marked by the `rootFolder.delete` that follows.
      return [
        stageKey(item.instanceId, 'rootFolder', item.payload.toRootFolderPath),
        stageKey(null, 'path', item.payload.toRootFolderPath),
      ];
    case 'importList.create':
      return [stageKey(item.instanceId, 'importList', item.payload.name)];
    case 'importList.update':
    case 'importList.delete':
    case 'importList.setEnabled':
      return [stageKey(item.instanceId, 'importList', String(item.payload.importListId))];
    case 'mediaTags.add':
    case 'mediaTags.remove':
    case 'mediaTags.set':
      return item.payload.tagIds.map((tagId) =>
        stageKey(item.instanceId, 'tag', `#${String(tagId)}`),
      );
    // These name media ids, not fleet cells. Fanning this index out over thousands of them
    // would rebuild a map of concatenated strings on every queue change, for the benefit of
    // views that do not read it - `stagedMediaIntent` below answers the media question.
    case 'media.refresh':
    case 'media.setMonitored':
    case 'media.setQualityProfile':
    case 'media.delete':
      return [];
    case 'fs.mkdir':
    case 'fs.delete':
      return [stageKey(null, 'path', item.payload.path)];
    case 'fs.rename':
    case 'fs.move':
      // Both ends light up: the folder that is leaving and the name that is arriving.
      return [stageKey(null, 'path', item.payload.from), stageKey(null, 'path', item.payload.to)];
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Request failed';
}

/**
 * The staging queue.
 *
 * A single user action here is a *fleet* action: "propagate this tag" or "re-map this
 * path" expands into one operation per target instance, pushed as one atomic batch, and
 * only applied when the user says so.
 */
export const useQueueStore = defineStore('queue', () => {
  const ui = useUiStore();
  const instancesStore = useInstancesStore();

  const items = ref<QueueItem[]>([]);
  const activeRun = ref<QueueRun | null>(null);
  const runItems = ref<QueueItem[]>([]);
  const runLog = ref<RunLogEntry[]>([]);
  const currentItemId = ref<number | null>(null);
  const failedItemId = ref<number | null>(null);
  const streaming = ref(false);
  const busy = ref(false);
  const loading = ref(false);

  let closeStream: (() => void) | null = null;

  const staged = computed(() => items.value.filter((item) => STAGED_STATUSES.has(item.status)));
  const pending = computed(() => items.value.filter((item) => item.status === 'pending'));
  const failed = computed(() => items.value.filter((item) => item.status === 'failed'));
  const finished = computed(() =>
    items.value.filter((item) => item.status === 'succeeded' || item.status === 'skipped' || item.status === 'cancelled'),
  );

  const impact = computed<QueueImpact>(() => {
    const list = staged.value;
    const kinds = new Map<TargetKind, Set<string>>();
    const ops = new Map<QueueOp, number>();

    for (const item of list) {
      const targets = kinds.get(item.targetKind) ?? new Set<string>();
      targets.add(item.targetLabel);
      kinds.set(item.targetKind, targets);
      ops.set(item.op, (ops.get(item.op) ?? 0) + 1);
    }

    return {
      operations: list.length,
      instances: new Set(list.map((item) => item.instanceId).filter((id) => id !== null)).size,
      affectedItems: list.reduce((sum, item) => sum + item.affectedCount, 0),
      byKind: [...kinds.entries()].map(([kind, targets]) => ({ kind, targets: targets.size })),
      byOp: [...ops.entries()].map(([op, count]) => ({ op, count })),
    };
  });

  /** Drawer grouping: by target instance, with disk work in its own group. */
  const groupedByInstance = computed(() => {
    const groups = new Map<number, QueueItem[]>();
    for (const item of staged.value) {
      const key = item.instanceId ?? LOCAL_STORAGE_GROUP;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()]
      .map(([instanceId, group]) => ({
        instanceId,
        instance: instancesStore.byId.get(instanceId) ?? null,
        label:
          instanceId === LOCAL_STORAGE_GROUP
            ? 'Local storage'
            : (instancesStore.byId.get(instanceId)?.name ?? `instance ${String(instanceId)}`),
        items: group,
      }))
      // Disk work runs first in a mixed recipe, so it reads first too.
      .sort((a, b) =>
        a.instanceId === LOCAL_STORAGE_GROUP
          ? -1
          : b.instanceId === LOCAL_STORAGE_GROUP
            ? 1
            : a.label.localeCompare(b.label, 'en'),
      );
  });

  /** Drawer grouping: execution order, which is what Apply All will actually do. */
  const executionOrder = computed(() =>
    [...staged.value].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
  );

  const stagedIndex = computed(() => {
    const index = new Map<string, QueueItem[]>();
    for (const item of staged.value) {
      for (const key of stageKeysFor(item)) {
        index.set(key, [...(index.get(key) ?? []), item]);
      }
    }
    return index;
  });

  /**
   * What is staged against one media item on one instance.
   *
   * A second index rather than more keys in `stagedIndex`, because a single move can name
   * five thousand ids: minting a concatenated string and an array per id would rebuild that
   * much garbage on every queue change, for a lookup only this one view performs. Here each
   * entry is a number key pointing at one of the ~20 module-level presentation objects, so
   * the whole thing is one pass and an O(1) read.
   */
  const stagedMediaIntent = computed(() => {
    const index = new Map<number, Map<number, OpPresentation>>();
    for (const item of staged.value) {
      const instanceId = item.instanceId;
      if (instanceId === null) continue;
      const mediaIds = mediaIdsOf(item);
      if (mediaIds.length === 0) continue;

      const perInstance = index.get(instanceId) ?? new Map<number, OpPresentation>();
      for (const mediaId of mediaIds) {
        perInstance.set(mediaId, worseIntent(perInstance.get(mediaId) ?? null, item.op));
      }
      index.set(instanceId, perInstance);
    }
    return index;
  });

  const stagedIntentForMedia = (instanceId: number, mediaId: number): OpPresentation | null =>
    stagedMediaIntent.value.get(instanceId)?.get(mediaId) ?? null;

  const stagedForTag = (instanceId: number, label: string): QueueItem[] =>
    stagedIndex.value.get(stageKey(instanceId, 'tag', label)) ?? [];

  const stagedForRootFolder = (instanceId: number, path: string): QueueItem[] =>
    stagedIndex.value.get(stageKey(instanceId, 'rootFolder', path)) ?? [];

  const stagedForImportList = (instanceId: number, listId: number): QueueItem[] =>
    stagedIndex.value.get(stageKey(instanceId, 'importList', String(listId))) ?? [];

  /** A create has no dest id yet, so it is keyed by the list name. */
  const stagedForImportListName = (instanceId: number, name: string): QueueItem[] =>
    stagedIndex.value.get(stageKey(instanceId, 'importList', name)) ?? [];

  /**
   * Staged work touching a path - drives the folder rows' pending glyph.
   *
   * Not only disk work: a root folder added or dropped at a path is a staged change to that
   * folder as far as the tree is concerned, even though nothing on disk moves.
   */
  const stagedForPath = (target: string): QueueItem[] =>
    stagedIndex.value.get(stageKey(null, 'path', target)) ?? [];

  const runProgress = computed(() => {
    const run = activeRun.value;
    if (run === null || run.totalItems === 0) return 0;
    const done = run.succeededItems + run.failedItems + run.skippedItems;
    return Math.min(100, Math.round((done / run.totalItems) * 100));
  });

  const currentItem = computed(() =>
    currentItemId.value === null
      ? null
      : (runItems.value.find((item) => item.id === currentItemId.value) ?? null),
  );

  const currentInstance = computed(() => {
    const item = currentItem.value;
    if (item === null || item.instanceId === null) return null;
    return instancesStore.byId.get(item.instanceId) ?? null;
  });

  const isRunning = computed(() => activeRun.value?.status === 'running');
  const isPaused = computed(() => activeRun.value?.status === 'paused');

  // ------------------------------------------------------------------- loading

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const response = await queueApi.list();
      items.value = [...response.items];
      activeRun.value = response.activeRun;

      if (response.activeRun !== null) {
        const detail = await queueApi.run(response.activeRun.id);
        runItems.value = [...detail.items];
        activeRun.value = detail.run;
        if (detail.run.status === 'running') attachStream(detail.run.id);
      }
    } catch (caught) {
      ui.notify('error', `Could not load the queue: ${messageOf(caught)}`);
    } finally {
      loading.value = false;
    }
  }

  async function push(batch: readonly NewQueueItem[], description: string): Promise<QueueItem[]> {
    if (batch.length === 0) {
      ui.notify('info', 'Nothing to stage - no instance needed that change');
      return [];
    }

    busy.value = true;
    try {
      const response = await queueApi.push(batch);
      await load();
      ui.notify(
        'success',
        `Staged ${description} (${String(response.items.length)} operation${response.items.length === 1 ? '' : 's'})`,
      );
      ui.openDrawer();
      return response.items;
    } catch (caught) {
      ui.notify('error', `Could not stage ${description}: ${messageOf(caught)}`);
      return [];
    } finally {
      busy.value = false;
    }
  }

  // ------------------------------------------------------------- fleet actions

  /** "Propagate missing tag": one create per instance that lacks it. */
  function propagateTag(label: string, instanceIds: readonly number[]): Promise<QueueItem[]> {
    return push(
      instanceIds.map((instanceId) => ({
        instanceId,
        op: 'tag.create' as const,
        payload: { label },
      })),
      `tag "${label}" on ${String(instanceIds.length)} instance(s)`,
    );
  }

  /** "Bulk rename across selected instances": one rename per instance holding the tag. */
  function renameTagAcross(targets: readonly TagTarget[], to: string): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'tag.rename' as const,
        payload: { tagId: target.tagId, from: target.label, to },
      })),
      `rename to "${to}" on ${String(targets.length)} instance(s)`,
    );
  }

  function deleteTagAcross(
    targets: readonly TagTarget[],
    detachFromMedia: boolean,
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'tag.delete' as const,
        payload: { tagId: target.tagId, label: target.label, detachFromMedia },
      })),
      `deletion of "${targets[0]?.label ?? 'tag'}" on ${String(targets.length)} instance(s)`,
    );
  }

  /**
   * Find &amp; replace across the fleet. Where the new label already exists on that
   * instance, a rename would fail with "Label already exists" - so those become a merge
   * into the existing tag instead, which is what the user actually means.
   */
  function applyFindReplace(
    previews: readonly ReplacementPreview[],
    collisions: ReadonlyMap<string, number>,
  ): Promise<QueueItem[]> {
    const batch = previews.map((preview): NewQueueItem => {
      const existingId = collisions.get(`${preview.instanceId}|${preview.to}`);
      if (existingId !== undefined) {
        return {
          instanceId: preview.instanceId,
          op: 'tag.merge',
          payload: { sourceTagIds: [preview.tagId], targetTagId: existingId, deleteSources: true },
        };
      }
      return {
        instanceId: preview.instanceId,
        op: 'tag.rename',
        payload: { tagId: preview.tagId, from: preview.from, to: preview.to },
      };
    });

    return push(batch, `${String(batch.length)} tag replacement(s) across the fleet`);
  }

  function createRootFolderAcross(
    path: string,
    instanceIds: readonly number[],
  ): Promise<QueueItem[]> {
    return push(
      instanceIds.map((instanceId) => ({
        instanceId,
        op: 'rootFolder.create' as const,
        payload: { path },
      })),
      `root folder ${path} on ${String(instanceIds.length)} instance(s)`,
    );
  }

  function deleteRootFolderAcross(targets: readonly RootFolderTarget[]): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'rootFolder.delete' as const,
        payload: { rootFolderId: target.rootFolderId, path: target.path },
      })),
      `removal of ${targets[0]?.path ?? 'root folder'} from ${String(targets.length)} instance(s)`,
    );
  }

  /**
   * Switch a root folder to another folder, staged as a dependent chain per instance:
   *   create the folder on disk (if it is not there) -> create the destination root folder
   *   -> move the media -> re-aim the import lists -> remove the old root folder.
   *
   * Each step depends on the previous one, so a failed move can never be followed by the
   * removal of the folder the media is still in. The disk step is shared: one `fs.mkdir` that
   * every instance's `rootFolder.create` waits on, because *Arr refuses to register a root
   * folder at a path that does not exist.
   */
  async function remapRootFolder(params: {
    targets: readonly RemapTarget[];
    /** The root folder being left, named so the queue rows and the tree agree on which one. */
    fromPath: string;
    toPath: string;
    moveFiles: boolean;
    /**
     * Set when the destination is not on disk yet. Null when it already is - `fs.mkdir`
     * treats an existing target as a blocker, so staging one anyway would pause the run at
     * step one and skip the whole chain behind it.
     */
    mkdirPath: string | null;
  }): Promise<void> {
    const { targets, fromPath, toPath, moveFiles, mkdirPath } = params;
    if (targets.length === 0) {
      ui.notify('info', 'Nothing to switch');
      return;
    }

    busy.value = true;
    try {
      // Step 0: the folder itself, once for the fleet.
      let mkdirId: number | undefined;
      if (mkdirPath !== null) {
        const response = await queueApi.push([
          { op: 'fs.mkdir' as const, payload: { path: mkdirPath, recursive: true } },
        ]);
        mkdirId = response.items[0]?.id;
      }

      // Step 1: destinations that do not exist yet. Their ids are needed as dependencies,
      // so this batch goes first and on its own.
      const creators = targets.filter((target) => target.needsRootFolder);
      const created = new Map<number, number>();

      if (creators.length > 0) {
        const response = await queueApi.push(
          creators.map((target) => ({
            instanceId: target.instanceId,
            op: 'rootFolder.create' as const,
            payload: { path: toPath },
            ...(mkdirId === undefined ? {} : { dependsOnId: mkdirId }),
          })),
        );
        for (const item of response.items) {
          if (item.instanceId !== null) created.set(item.instanceId, item.id);
        }
      }

      // Step 2: the moves, each depending on its instance's create when there was one.
      const moveResponse = await queueApi.push(
        targets
          .filter((target) => target.mediaIds.length > 0)
          .map((target): NewQueueItem => {
            const dependsOnId = created.get(target.instanceId);
            return {
              instanceId: target.instanceId,
              op: 'media.moveRootFolder',
              payload: {
                mediaIds: [...target.mediaIds],
                toRootFolderPath: toPath,
                moveFiles,
              },
              ...(dependsOnId === undefined ? {} : { dependsOnId }),
            };
          }),
      );

      const moveByInstance = new Map(moveResponse.items.map((item) => [item.instanceId, item.id]));

      /**
       * What the next step waits on, per instance.
       *
       * The move when there was one; otherwise that instance's `rootFolder.create`, or the
       * shared mkdir. An instance rooting at an empty folder has nothing to move, and hanging
       * its cleanup off nothing would let the old root folder go before the new one existed.
       */
      const gate = (target: RemapTarget): number | undefined =>
        moveByInstance.get(target.instanceId) ?? created.get(target.instanceId) ?? mkdirId;

      // Step 3: aim the import lists at the new folder, gated the same way. A list that
      // still fills the old folder is what refills it after the media leaves.
      const relists = targets.flatMap((target) =>
        (target.importLists ?? []).map((list) => ({ target, list })),
      );
      if (relists.length > 0) {
        await queueApi.push(
          relists.map(({ target, list }): NewQueueItem => {
            const dependsOnId = gate(target);
            return {
              instanceId: target.instanceId,
              op: 'importList.update',
              payload: {
                importListId: list.importListId,
                changes: { rootFolderPath: list.toRootFolderPath },
              },
              ...(dependsOnId === undefined ? {} : { dependsOnId }),
            };
          }),
        );
      }

      // Step 4: optional cleanup of the old root folder, gated on its move succeeding.
      const removals = targets.filter((target) => target.removeRootFolderId !== null);
      if (removals.length > 0) {
        await queueApi.push(
          removals.map((target): NewQueueItem => {
            const dependsOnId = gate(target);
            return {
              instanceId: target.instanceId,
              op: 'rootFolder.delete',
              payload: {
                rootFolderId: target.removeRootFolderId ?? 0,
                // The real path, not a placeholder: it is what the queue row reads and what
                // the old folder's row and owner chip match on to show the change as pending.
                path: fromPath,
              },
              ...(dependsOnId === undefined ? {} : { dependsOnId }),
            };
          }),
        );
      }

      await load();
      ui.notify(
        'success',
        `Staged the switch from ${fromPath} to ${toPath} across ${String(targets.length)} instance(s)${moveFiles ? ' - *Arr will move the files' : ''}`,
      );
      ui.openDrawer();
    } catch (caught) {
      ui.notify('error', `Could not stage the switch: ${messageOf(caught)}`);
      await load();
    } finally {
      busy.value = false;
    }
  }

  // ------------------------------------------------------- filesystem actions

  /** One disk operation, staged like any other change. */
  function stageFsOperation(item: NewFsQueueItem, description: string): Promise<QueueItem[]> {
    return push([item], description);
  }

  /**
   * Several disk operations in one batch.
   *
   * One `fs.delete` per folder rather than a list in one payload: each one carries its own
   * preflight, its own result and its own row, so a folder that turns out to be unsafe by the
   * time the run reaches it fails alone instead of taking the others with it.
   */
  function stageFsOperations(
    items: readonly NewFsQueueItem[],
    description: string,
  ): Promise<QueueItem[]> {
    return push([...items], description);
  }

  /**
   * Reconcile & Align: rename a folder on disk, then point each selected root folder at
   * its rewritten path *without* asking *Arr to move anything - the bytes are already there.
   *
   * One target is one (instance, root folder) pair. A parent rename therefore stages a
   * create/move/delete per nested registration, not one create at the parent path.
   *
   * Staged as a dependency chain, so a failed disk step means no instance is touched.
   */
  async function stageReconcile(params: {
    from: string;
    to: string;
    targets: ReadonlyArray<{
      instanceId: number;
      fromPath: string;
      toPath: string;
      mediaIds: readonly number[];
      oldRootFolderId: number | null;
    }>;
    removeOldRootFolder: boolean;
  }): Promise<void> {
    busy.value = true;
    try {
      // Step 1: the disk. Everything else hangs off this item.
      const renamed = await queueApi.push([
        { op: 'fs.rename', payload: { from: params.from, to: params.to } },
      ]);
      const renameId = renamed.items[0]?.id;
      if (renameId === undefined) throw new Error('The rename step was not staged');

      for (const target of params.targets) {
        // Step 2: the destination root folder, once the rename has happened.
        const created = await queueApi.push([
          {
            instanceId: target.instanceId,
            op: 'rootFolder.create',
            payload: { path: target.toPath },
            dependsOnId: renameId,
          },
        ]);
        const rootFolderId = created.items[0]?.id ?? renameId;

        // Step 3: realign the media. moveFiles is false by design.
        //
        // An instance with nothing under the folder skips this: a root folder can be
        // configured before a single download (see `PathOwner.use`), and a
        // bulk edit with no ids is a request *Arr has no reason to accept. Re-pointing it
        // is still the create-and-drop pair below, so the instance is never left out.
        let realignId = rootFolderId;

        if (target.mediaIds.length > 0) {
          const realigned = await queueApi.push([
            {
              instanceId: target.instanceId,
              op: 'media.moveRootFolder',
              payload: {
                mediaIds: [...target.mediaIds],
                toRootFolderPath: target.toPath,
                moveFiles: false,
              },
              dependsOnId: rootFolderId,
            },
          ]);
          realignId = realigned.items[0]?.id ?? rootFolderId;
        }

        // Step 4: drop the old root folder, only if its move succeeded.
        if (params.removeOldRootFolder && target.oldRootFolderId !== null) {
          await queueApi.push([
            {
              instanceId: target.instanceId,
              op: 'rootFolder.delete',
              payload: { rootFolderId: target.oldRootFolderId, path: target.fromPath },
              dependsOnId: realignId,
            },
          ]);
        }
      }

      await load();
      ui.notify(
        'success',
        `Staged the rename of ${params.from} plus ${String(params.targets.length)} instance realignment(s) - no files will be copied`,
      );
      ui.openDrawer();
    } catch (caught) {
      ui.notify('error', `Could not stage the reconcile: ${messageOf(caught)}`);
      await load();
    } finally {
      busy.value = false;
    }
  }

  function setImportListEnabled(
    targets: readonly ImportListTarget[],
    enabled: boolean,
    enableAutomaticAdd: boolean,
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'importList.setEnabled' as const,
        payload: { importListId: target.importListId, enabled, enableAutomaticAdd },
      })),
      `${enabled ? 'enable' : 'disable'} on ${String(targets.length)} import list(s)`,
    );
  }

  function updateImportListsAcross(
    targets: readonly ImportListTarget[],
    changes: ImportListChanges,
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'importList.update' as const,
        payload: { importListId: target.importListId, changes },
      })),
      `import list changes on ${String(targets.length)} instance(s)`,
    );
  }

  function createImportListAcross(
    targets: ReadonlyArray<{
      instanceId: number;
      name: string;
      sourceInstanceId: number;
      sourceImportListId: number;
    }>,
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'importList.create' as const,
        payload: {
          name: target.name,
          sourceInstanceId: target.sourceInstanceId,
          sourceImportListId: target.sourceImportListId,
        },
      })),
      `copy "${targets[0]?.name ?? 'import list'}" onto ${String(targets.length)} instance(s)`,
    );
  }

  // -------------------------------------------------------------- queue admin

  async function reorder(itemIds: readonly number[]): Promise<void> {
    try {
      await queueApi.reorder(itemIds);
      await load();
    } catch (caught) {
      ui.notify('error', `Could not reorder: ${messageOf(caught)}`);
    }
  }

  /** Moves one operation up or down in the execution order. */
  async function move(itemId: number, direction: -1 | 1): Promise<void> {
    const order = pending.value.map((item) => item.id);
    const index = order.indexOf(itemId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= order.length) return;

    const next = [...order];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    await reorder(next);
  }

  async function removeItem(itemId: number): Promise<void> {
    try {
      await queueApi.remove(itemId);
      await load();
    } catch (caught) {
      ui.notify('error', `Could not remove the operation: ${messageOf(caught)}`);
    }
  }

  async function retryItem(itemId: number): Promise<void> {
    try {
      await queueApi.retry(itemId);
      await load();
    } catch (caught) {
      ui.notify('error', `Could not retry: ${messageOf(caught)}`);
    }
  }

  async function clearFinished(): Promise<void> {
    try {
      await queueApi.clear();
      await load();
    } catch (caught) {
      ui.notify('error', `Could not clear the queue: ${messageOf(caught)}`);
    }
  }

  async function discardAll(): Promise<void> {
    const ids = pending.value.map((item) => item.id);
    for (const id of ids) await queueApi.remove(id);
    await load();
    ui.notify('info', `Discarded ${String(ids.length)} staged operation(s)`);
  }

  // ---------------------------------------------------------------- execution

  function detachStream(): void {
    closeStream?.();
    closeStream = null;
    streaming.value = false;
  }

  function upsertItem(item: QueueItem): void {
    items.value = items.value.map((entry) => (entry.id === item.id ? item : entry));
    const known = runItems.value.some((entry) => entry.id === item.id);
    runItems.value = known
      ? runItems.value.map((entry) => (entry.id === item.id ? item : entry))
      : [...runItems.value, item];
  }

  function applyEvent(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        activeRun.value = event.run;
        break;
      case 'item.started':
        currentItemId.value = event.item.id;
        upsertItem(event.item);
        break;
      case 'item.finished':
        activeRun.value = event.run;
        upsertItem(event.item);
        break;
      case 'log':
        runLog.value = [
          ...runLog.value.slice(-199),
          { at: new Date().toISOString(), level: event.level, message: event.message },
        ];
        break;
      case 'run.paused':
        activeRun.value = event.run;
        failedItemId.value = event.failedItemId;
        currentItemId.value = null;
        detachStream();
        void load();
        break;
      case 'run.finished':
        activeRun.value = event.run;
        currentItemId.value = null;
        detachStream();
        void load();
        break;
    }
  }

  function attachStream(runId: number): void {
    detachStream();
    streaming.value = true;
    closeStream = queueApi.openStream(runId, {
      onEvent: applyEvent,
      onError: () => {
        // EventSource retries on its own; a hard failure falls back to one poll.
        void queueApi
          .run(runId)
          .then((detail) => {
            activeRun.value = detail.run;
            runItems.value = [...detail.items];
          })
          .catch(() => undefined);
      },
    });
  }

  async function start(onError: OnErrorPolicy = 'pause'): Promise<void> {
    busy.value = true;
    runLog.value = [];
    failedItemId.value = null;
    try {
      const response = await queueApi.start({ onError });
      activeRun.value = response.run;
      runItems.value = [...response.items];
      ui.openExecution();
      attachStream(response.run.id);
    } catch (caught) {
      ui.notify('error', `Could not start the run: ${messageOf(caught)}`);
    } finally {
      busy.value = false;
    }
  }

  async function resume(options: { retryFailed?: boolean; skipFailed?: boolean }): Promise<void> {
    const run = activeRun.value;
    if (run === null) return;

    busy.value = true;
    try {
      const response = await queueApi.resume(run.id, options);
      activeRun.value = response.run;
      runItems.value = [...response.items];
      failedItemId.value = null;
      attachStream(run.id);
    } catch (caught) {
      ui.notify('error', `Could not resume: ${messageOf(caught)}`);
    } finally {
      busy.value = false;
    }
  }

  async function cancel(): Promise<void> {
    const run = activeRun.value;
    if (run === null) return;

    busy.value = true;
    try {
      const response = await queueApi.cancel(run.id);
      activeRun.value = response.run;
      runItems.value = [...response.items];
      detachStream();
      await load();
      ui.notify('info', `Run ${String(run.id)} cancelled`);
    } catch (caught) {
      ui.notify('error', `Could not cancel: ${messageOf(caught)}`);
    } finally {
      busy.value = false;
    }
  }

  // ------------------------------------------------------------------ media bulk work

  function setMediaMonitored(
    targets: readonly MediaTarget[],
    monitored: boolean,
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'media.setMonitored' as const,
        payload: { mediaIds: [...target.mediaIds], monitored },
      })),
      `${monitored ? 'monitor' : 'unmonitor'} ${countOf(targets)}`,
    );
  }

  function refreshMediaAcross(targets: readonly MediaTarget[]): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'media.refresh' as const,
        payload: { mediaIds: [...target.mediaIds] },
      })),
      `a rescan of ${countOf(targets)}`,
    );
  }

  function setMediaQualityProfile(
    targets: readonly MediaProfileTarget[],
    profileName: string,
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'media.setQualityProfile' as const,
        payload: {
          mediaIds: [...target.mediaIds],
          // Resolved per instance: the same name is a different id on each of them.
          qualityProfileId: target.qualityProfileId,
          profileName,
        },
      })),
      `quality profile "${profileName}" on ${countOf(targets)}`,
    );
  }

  function deleteMediaAcross(
    targets: readonly MediaTarget[],
    options: { deleteFiles: boolean; addImportExclusion: boolean },
  ): Promise<QueueItem[]> {
    return push(
      targets.map((target) => ({
        instanceId: target.instanceId,
        op: 'media.delete' as const,
        payload: {
          mediaIds: [...target.mediaIds],
          deleteFiles: options.deleteFiles,
          addImportExclusion: options.addImportExclusion,
        },
      })),
      `deletion of ${countOf(targets)}${options.deleteFiles ? ' and their files' : ''}`,
    );
  }

  /**
   * Tag work, with the missing labels created first.
   *
   * The same label is a different id on every instance, and may not exist at all - so a
   * label nobody has becomes a `tag.create` that the tag edit then depends on. Two batches,
   * sequentially, because a dependency id only exists once the first batch is inserted;
   * and one dependent item per missing label, because `dependsOnId` is a single column.
   */
  async function applyMediaTags(params: {
    mode: 'add' | 'remove' | 'replace';
    targets: readonly MediaTagTarget[];
  }): Promise<void> {
    const { mode, targets } = params;
    if (targets.length === 0) {
      ui.notify('info', 'Nothing to tag - no instance was in range');
      return;
    }

    busy.value = true;
    try {
      // Removing cannot create: a label an instance does not have is nothing to take away.
      const creating = mode === 'remove' ? [] : targets.flatMap((target) =>
        target.missingLabels.map((label) => ({ instanceId: target.instanceId, label })),
      );
      const createdIds = new Map<string, number>();

      if (creating.length > 0) {
        const response = await queueApi.push(
          creating.map((entry) => ({
            instanceId: entry.instanceId,
            op: 'tag.create' as const,
            payload: { label: entry.label },
          })),
        );
        response.items.forEach((item, index) => {
          const entry = creating[index];
          if (entry !== undefined) {
            createdIds.set(`${String(entry.instanceId)}|${entry.label}`, item.id);
          }
        });
      }

      const batch: NewQueueItem[] = [];
      for (const target of targets) {
        const op =
          mode === 'add' ? 'mediaTags.add' : mode === 'remove' ? 'mediaTags.remove' : 'mediaTags.set';

        // The ids that already exist go in one item. `set` needs it even when the list is
        // empty - that is how "clear everything else" is said - while add and remove have
        // nothing to do without one.
        if (target.tagIds.length > 0 || mode === 'replace') {
          batch.push({
            instanceId: target.instanceId,
            op,
            payload: { mediaIds: [...target.mediaIds], tagIds: [...target.tagIds] },
          } as NewQueueItem);
        }

        // Then one dependent add per label being created, since each can wait on only one.
        for (const label of mode === 'remove' ? [] : target.missingLabels) {
          const dependsOnId = createdIds.get(`${String(target.instanceId)}|${label}`);
          if (dependsOnId === undefined) continue;
          batch.push({
            instanceId: target.instanceId,
            op: 'mediaTags.add',
            payload: { mediaIds: [...target.mediaIds], tagIds: [] },
            dependsOnId,
          });
        }
      }

      await push(batch, `tag changes on ${countOf(targets)}`);
    } catch (caught) {
      ui.notify('error', `Could not stage the tag changes: ${messageOf(caught)}`);
      await load();
    } finally {
      busy.value = false;
    }
  }

  /**
   * Move copies to a root folder chosen **per instance**.
   *
   * `remapRootFolder` cannot serve here: it takes one destination for the whole fleet, and
   * paths are never translated between instances, so each one names its own.
   */
  async function moveMediaAcross(params: {
    targets: readonly MediaMoveTarget[];
    moveFiles: boolean;
  }): Promise<void> {
    const { targets, moveFiles } = params;
    if (targets.length === 0) {
      ui.notify('info', 'Nothing to move - no instance was in range');
      return;
    }

    busy.value = true;
    try {
      const creators = targets.filter((target) => target.needsRootFolder);
      const created = new Map<number, number>();

      if (creators.length > 0) {
        const response = await queueApi.push(
          creators.map((target) => ({
            instanceId: target.instanceId,
            op: 'rootFolder.create' as const,
            payload: { path: target.toRootFolderPath },
          })),
        );
        for (const item of response.items) {
          if (item.instanceId !== null) created.set(item.instanceId, item.id);
        }
      }

      await push(
        targets.map((target): NewQueueItem => {
          const dependsOnId = created.get(target.instanceId);
          return {
            instanceId: target.instanceId,
            op: 'media.moveRootFolder',
            payload: {
              mediaIds: [...target.mediaIds],
              toRootFolderPath: target.toRootFolderPath,
              moveFiles,
            },
            ...(dependsOnId === undefined ? {} : { dependsOnId }),
          };
        }),
        `a move of ${countOf(targets)}${moveFiles ? ' - files will move on disk' : ''}`,
      );
    } catch (caught) {
      ui.notify('error', `Could not stage the move: ${messageOf(caught)}`);
      await load();
    } finally {
      busy.value = false;
    }
  }

  return {
    items,
    activeRun,
    runItems,
    runLog,
    currentItemId,
    failedItemId,
    streaming,
    busy,
    loading,
    staged,
    pending,
    failed,
    finished,
    impact,
    groupedByInstance,
    executionOrder,
    stagedForTag,
    stagedIntentForMedia,
    applyMediaTags,
    moveMediaAcross,
    setMediaMonitored,
    setMediaQualityProfile,
    deleteMediaAcross,
    refreshMediaAcross,
    stagedForRootFolder,
    stagedForImportList,
    stagedForImportListName,
    stagedForPath,
    runProgress,
    currentItem,
    currentInstance,
    isRunning,
    isPaused,
    load,
    stage: push,
    propagateTag,
    renameTagAcross,
    deleteTagAcross,
    applyFindReplace,
    createRootFolderAcross,
    deleteRootFolderAcross,
    remapRootFolder,
    setImportListEnabled,
    updateImportListsAcross,
    createImportListAcross,
    stageFsOperation,
    stageFsOperations,
    stageReconcile,
    reorder,
    move,
    removeItem,
    retryItem,
    clearFinished,
    discardAll,
    start,
    resume,
    cancel,
  };
});
