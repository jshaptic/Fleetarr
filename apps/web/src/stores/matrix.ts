import type { Instance } from '@fleetarr/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiRequestError } from '@/api/client';
import { resourcesApi } from '@/api/resources';
import {
  buildFleetStats,
  buildImportListRows,
  buildRootFolderRows,
  buildTagRows,
  previewFindReplace,
  sortSnapshots,
  type InstanceSnapshot,
  type ReplacementPreview,
} from '@/lib/matrix';
import { useInstancesStore } from './instances';

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Request failed';
}

function placeholderSnapshot(instance: Instance, status: InstanceSnapshot['status']): InstanceSnapshot {
  return {
    instance,
    status,
    fetchedAt: null,
    error: instance.lastError,
    tags: [],
    rootFolders: [],
    importLists: [],
    qualityProfiles: [],
    // Null, not []: a placeholder has not asked yet, and `[]` would claim it had.
    collections: null,
  };
}

/**
 * The fleet view model.
 *
 * There is deliberately no "current instance" here. Every instance is loaded in parallel
 * and normalised into comparison rows, so the views only ever render the whole fleet.
 */
export const useMatrixStore = defineStore('matrix', () => {
  const instancesStore = useInstancesStore();

  const snapshots = ref<Record<number, InstanceSnapshot>>({});
  const loading = ref(false);
  const lastLoadedAt = ref<string | null>(null);
  /** Batch actions target these instances; empty means "the whole fleet". */
  const selectedInstanceIds = ref<number[]>([]);
  const mediaIdCache = ref<Record<string, number[]>>({});

  const columns = computed<InstanceSnapshot[]>(() =>
    sortSnapshots(
      instancesStore.enabled.map(
        (instance) => snapshots.value[instance.id] ?? placeholderSnapshot(instance, 'loading'),
      ),
    ),
  );

  const healthyColumns = computed(() => columns.value.filter((column) => column.status === 'ok'));
  const failedColumns = computed(() => columns.value.filter((column) => column.status === 'error'));

  const tagRows = computed(() => buildTagRows(columns.value));
  const rootFolderRows = computed(() => buildRootFolderRows(columns.value));
  const importListRows = computed(() => buildImportListRows(columns.value));

  const stats = computed(() => buildFleetStats(columns.value, tagRows.value, rootFolderRows.value));

  const allPaths = computed(() => rootFolderRows.value.map((row) => row.path));

  /** Instances a batch action should hit: the explicit selection, or every healthy one. */
  const targetInstanceIds = computed<number[]>(() =>
    selectedInstanceIds.value.length > 0
      ? selectedInstanceIds.value
      : healthyColumns.value.map((column) => column.instance.id),
  );

  const isSelected = (instanceId: number): boolean =>
    selectedInstanceIds.value.includes(instanceId);

  function toggleInstance(instanceId: number): void {
    selectedInstanceIds.value = isSelected(instanceId)
      ? selectedInstanceIds.value.filter((id) => id !== instanceId)
      : [...selectedInstanceIds.value, instanceId];
  }

  function selectInstances(instanceIds: readonly number[]): void {
    selectedInstanceIds.value = [...instanceIds];
  }

  function clearSelection(): void {
    selectedInstanceIds.value = [];
  }

  function snapshotFor(instanceId: number): InstanceSnapshot | null {
    return snapshots.value[instanceId] ?? null;
  }

  async function loadInstance(instance: Instance, refresh: boolean): Promise<void> {
    snapshots.value = {
      ...snapshots.value,
      [instance.id]: placeholderSnapshot(instance, 'loading'),
    };

    try {
      const response = await resourcesApi.snapshot(instance.id, refresh);
      snapshots.value = {
        ...snapshots.value,
        [instance.id]: {
          instance,
          status: 'ok',
          fetchedAt: response.fetchedAt,
          error: null,
          tags: response.tags,
          rootFolders: response.rootFolders,
          importLists: response.importLists,
          qualityProfiles: response.qualityProfiles,
          collections: response.collections,
        },
      };
    } catch (caught) {
      snapshots.value = {
        ...snapshots.value,
        [instance.id]: {
          ...placeholderSnapshot(instance, 'error'),
          error: messageOf(caught),
        },
      };
    }
  }

  /** Loads every enabled instance at once - one slow instance never blocks the others. */
  async function load(options: { refresh?: boolean } = {}): Promise<void> {
    loading.value = true;
    try {
      if (!instancesStore.loadedOnce) await instancesStore.load();
      if (options.refresh === true) mediaIdCache.value = {};

      await Promise.all(
        instancesStore.enabled.map((instance) => loadInstance(instance, options.refresh === true)),
      );
      lastLoadedAt.value = new Date().toISOString();
    } finally {
      loading.value = false;
    }
  }

  async function reload(instanceId: number, refresh = true): Promise<void> {
    const instance = instancesStore.byId.get(instanceId);
    if (!instance) return;
    await loadInstance(instance, refresh);
  }

  /** Drops cached snapshots for instances that no longer exist. */
  function prune(): void {
    const live = new Set(instancesStore.items.map((instance) => instance.id));
    snapshots.value = Object.fromEntries(
      Object.entries(snapshots.value).filter(([id]) => live.has(Number(id))),
    );
    selectedInstanceIds.value = selectedInstanceIds.value.filter((id) => live.has(id));
  }

  /**
   * Media ids under a root folder, needed before a re-map can be staged. Cached because a
   * remap dialog asks for several instances at once and the answer is stable per snapshot.
   */
  async function mediaIdsInRootFolder(instanceId: number, path: string): Promise<number[]> {
    const key = `${instanceId}|${path}`;
    const cached = mediaIdCache.value[key];
    if (cached !== undefined) return cached;

    const ids = await resourcesApi.allMediaIdsInRootFolder(instanceId, path);
    mediaIdCache.value = { ...mediaIdCache.value, [key]: ids };
    return ids;
  }

  function findReplacePreview(
    find: string,
    replace: string,
    options: { caseSensitive?: boolean; onlySelected?: boolean } = {},
  ): ReplacementPreview[] {
    return previewFindReplace(columns.value, find, replace, {
      ...(options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
      ...(options.onlySelected === true ? { instanceIds: targetInstanceIds.value } : {}),
    });
  }

  return {
    snapshots,
    loading,
    lastLoadedAt,
    selectedInstanceIds,
    columns,
    healthyColumns,
    failedColumns,
    tagRows,
    rootFolderRows,
    importListRows,
    stats,
    allPaths,
    targetInstanceIds,
    isSelected,
    toggleInstance,
    selectInstances,
    clearSelection,
    snapshotFor,
    load,
    reload,
    prune,
    mediaIdsInRootFolder,
    findReplacePreview,
  };
});
