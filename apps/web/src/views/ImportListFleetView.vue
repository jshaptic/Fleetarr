<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BaseInstanceBadge from '@/components/base/BaseInstanceBadge.vue';
import EmptyState from '@/components/base/EmptyState.vue';
import FleetBar from '@/components/fleet/FleetBar.vue';
import IconImportList from '@/components/base/icons/IconImportList.vue';
import { qualityProfileLabel, type ImportListRow } from '@/lib/import-lists';
import { stagedIntent } from '@/lib/staging';
import { useMatrixStore } from '@/stores/matrix';
import { useQueueStore } from '@/stores/queue';

/**
 * Import lists, one row per (list, instance).
 *
 * Read-only on purpose. A list is edited in the *Arr app that owns it; the only writes
 * Fleetarr makes to one are consequences of work started elsewhere - a root folder remap
 * re-points it (`importList.update`), a folder delete disables it first
 * (`importList.setEnabled`). Both still show here as a staged glyph, because a pending
 * operation must be visible on the page that shows the resource.
 *
 * `enabled` has three answers, not two. Radarr's list has an Enabled switch; Sonarr's has
 * none at all, and saying "on" for it would be inventing a setting the app does not have.
 */
const matrix = useMatrixStore();
const queue = useQueueStore();

const search = ref('');

const rows = computed(() => {
  const needle = search.value.trim().toLowerCase();
  // An empty selection is the whole fleet, not none of it - FleetBar's own convention,
  // and `isSelected` alone would read it the other way round.
  const wholeFleet = matrix.selectedInstanceIds.length === 0;

  return matrix.importListRows.filter((row) => {
    if (!wholeFleet && !matrix.isSelected(row.instanceId)) return false;
    if (needle.length === 0) return true;
    return (
      row.name.toLowerCase().includes(needle) || row.implementation.toLowerCase().includes(needle)
    );
  });
});

function stagedFor(row: ImportListRow) {
  return stagedIntent(queue.stagedForImportList(row.instanceId, row.listId));
}

onMounted(() => {
  if (matrix.columns.length === 0 || matrix.lastLoadedAt === null) void matrix.load();
});
</script>

<template>
  <div class="space-y-4">
    <FleetBar mode="filter" />

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="search"
        type="search"
        placeholder="Filter lists…"
        class="h-9 w-48 rounded-md border border-line bg-raised px-3 text-sm text-ink outline-none focus:border-accent"
      />
      <span class="text-xs text-muted">
        What every instance's import lists are configured to do. Edit a list in Radarr or
        Sonarr itself.
      </span>
    </div>

    <EmptyState
      v-if="matrix.columns.length === 0"
      title="No instances connected"
      description="Import lists come from every connected Radarr and Sonarr. Connect one to compare what its lists add, and where."
      :icon="IconImportList"
    />

    <EmptyState
      v-else-if="rows.length === 0"
      :title="matrix.loading ? 'Loading the fleet…' : 'No import lists match this filter'"
      :description="
        matrix.loading
          ? 'Reading import lists from every instance in parallel.'
          : 'Clear the filter, or add a list in Radarr/Sonarr and refresh the fleet.'
      "
      :icon="IconImportList"
    />

    <div v-else class="space-y-2">
      <p
        v-if="matrix.failedColumns.length > 0"
        class="text-[11px] text-danger"
        data-testid="unknown-instances"
      >
        {{ matrix.failedColumns.length }} instance(s) did not answer
        ({{ matrix.failedColumns.map((column) => column.instance.name).join(', ') }}) - they
        have no rows below. Unknown, deliberately not "no lists".
      </p>

      <div class="overflow-x-auto rounded-lg border border-line">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="text-left text-[11px] font-semibold text-muted">
              <th scope="col" class="min-w-[18rem] border-b border-line bg-raised px-3 py-2">
                Import list ({{ rows.length }})
              </th>
              <th scope="col" class="border-b border-l border-line bg-raised px-3 py-2">
                Instance
              </th>
              <th scope="col" class="border-b border-l border-line bg-raised px-3 py-2">
                Enabled
              </th>
              <th scope="col" class="border-b border-l border-line bg-raised px-3 py-2">
                Auto add
              </th>
              <th scope="col" class="border-b border-l border-line bg-raised px-3 py-2">
                Root folder
              </th>
              <th scope="col" class="border-b border-l border-line bg-raised px-3 py-2">
                Profile
              </th>
              <th scope="col" class="border-b border-l border-line bg-raised px-3 py-2">Tags</th>
            </tr>
          </thead>

          <tbody>
            <tr v-for="row in rows" :key="row.key" class="hover:bg-raised/40">
              <th
                scope="row"
                class="border-b border-line bg-surface px-3 py-1.5 text-left font-normal"
              >
                <span class="flex items-center gap-2">
                  <component
                    :is="stagedFor(row)?.icon"
                    v-if="stagedFor(row)"
                    size="xs"
                    class="shrink-0 text-staged"
                    data-testid="row-staged"
                    :title="`${stagedFor(row)?.label} staged for ${row.name}`"
                  />
                  <span class="min-w-0">
                    <span data-name class="block truncate text-ink">{{ row.name }}</span>
                    <span class="block truncate text-[10px] text-faint">
                      {{ row.implementation }}
                    </span>
                  </span>
                </span>
              </th>

              <td class="border-b border-l border-line px-3 py-1.5 whitespace-nowrap">
                <span class="flex items-center gap-2">
                  <BaseInstanceBadge :name="row.instanceName" :kind="row.kind" size="sm" />
                  <span data-instance class="text-muted">{{ row.instanceName }}</span>
                </span>
              </td>

              <!-- Three answers, not two: on, off, or an app with no such switch at all. -->
              <td class="border-b border-l border-line px-3 py-1.5 whitespace-nowrap" data-enabled>
                <span
                  v-if="row.enabled === null"
                  class="text-faint"
                  title="Sonarr import lists have no Enabled switch - only Auto add"
                >
                  n/a
                </span>
                <span v-else-if="row.enabled" class="text-sync">on</span>
                <span v-else class="text-faint">off</span>
              </td>

              <td class="border-b border-l border-line px-3 py-1.5 whitespace-nowrap" data-auto-add>
                <span v-if="row.automatic" class="text-sync">on</span>
                <span v-else class="text-faint">off</span>
              </td>

              <td class="border-b border-l border-line px-3 py-1.5" data-root-folder>
                <span v-if="row.rootFolderPath.length > 0" class="text-muted">
                  {{ row.rootFolderPath }}
                </span>
                <span v-else class="text-faint">none set</span>
              </td>

              <td class="border-b border-l border-line px-3 py-1.5 whitespace-nowrap" data-profile>
                <span :class="row.qualityProfileName === null ? 'text-faint' : 'text-muted'">
                  {{ qualityProfileLabel(row) }}
                </span>
              </td>

              <td class="border-b border-l border-line px-3 py-1.5">
                <span v-if="row.tags.length === 0" class="text-faint" data-tag="none">—</span>
                <span v-else class="flex flex-wrap gap-1">
                  <span
                    v-for="tag in row.tags"
                    :key="tag"
                    data-tag
                    class="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted"
                  >
                    {{ tag }}
                  </span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
