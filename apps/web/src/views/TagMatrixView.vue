<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { NewQueueItem } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import EmptyState from '@/components/base/EmptyState.vue';
import FleetBar from '@/components/fleet/FleetBar.vue';
import InstanceColumnHeader from '@/components/fleet/InstanceColumnHeader.vue';
import ParityBadge from '@/components/fleet/ParityBadge.vue';
import TagCellView from '@/components/fleet/TagCellView.vue';
import AddTagDialog from '@/components/tags/AddTagDialog.vue';
import DeleteTagsDialog from '@/components/tags/DeleteTagsDialog.vue';
import FindReplaceDialog from '@/components/tags/FindReplaceDialog.vue';
import RenameTagsDialog from '@/components/tags/RenameTagsDialog.vue';
import type { TagMatrixRow } from '@/lib/matrix';
import { useMatrixStore } from '@/stores/matrix';
import { useQueueStore, type TagTarget } from '@/stores/queue';
import IconTag from '@/components/base/icons/IconTag.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';

type Filter = 'all' | 'drift' | 'unused';

const matrix = useMatrixStore();
const queue = useQueueStore();

const search = ref('');
const filter = ref<Filter>('all');
const selectedLabels = ref<string[]>([]);

const showFindReplace = ref(false);
const adding = ref(false);
const renaming = ref<{ label: string; targets: TagTarget[] } | null>(null);
const deleting = ref<TagTarget[] | null>(null);

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All tags' },
  { value: 'drift', label: 'Drift only' },
  { value: 'unused', label: 'Unused everywhere' },
];

const rows = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return matrix.tagRows.filter((row) => {
    if (needle.length > 0 && !row.label.toLowerCase().includes(needle)) return false;
    if (filter.value === 'drift') return row.parity !== 'full';
    if (filter.value === 'unused') return row.unusedEverywhere;
    return true;
  });
});

const selectedRows = computed(() =>
  rows.value.filter((row) => selectedLabels.value.includes(row.label)),
);

const allVisibleSelected = computed(
  () => rows.value.length > 0 && selectedRows.value.length === rows.value.length,
);

/**
 * The header's third state. An empty box sitting above three ticked rows reads as a bug
 * now that the box is drawn rather than native - the unfilled system tick was quietly
 * wrong about the same thing. What clicking it does is unchanged: still all-or-nothing.
 */
const someVisibleSelected = computed(
  () => !allVisibleSelected.value && selectedRows.value.length > 0,
);

/** Instances a batch action may touch: the fleet, or the explicit selection. */
const targets = computed(() => matrix.targetInstanceIds);

const propagatable = computed(() =>
  selectedRows.value.flatMap((row) =>
    row.missingOn.filter((instanceId) => targets.value.includes(instanceId)),
  ),
);

const deletable = computed<TagTarget[]>(() =>
  selectedRows.value.flatMap((row) =>
    row.cells
      .filter((cell) => cell.known && cell.present && targets.value.includes(cell.instanceId))
      .map((cell) => ({
        instanceId: cell.instanceId,
        tagId: cell.tagId ?? 0,
        label: row.label,
      })),
  ),
);

function toggleRow(label: string): void {
  selectedLabels.value = selectedLabels.value.includes(label)
    ? selectedLabels.value.filter((entry) => entry !== label)
    : [...selectedLabels.value, label];
}

function toggleAllVisible(): void {
  selectedLabels.value = allVisibleSelected.value ? [] : rows.value.map((row) => row.label);
}

function instanceName(instanceId: number): string {
  return (
    matrix.columns.find((column) => column.instance.id === instanceId)?.instance.name ??
    `instance ${String(instanceId)}`
  );
}

/** "Propagate missing tag to all": one create per instance that lacks it. */
async function propagateSelected(): Promise<void> {
  const batch: NewQueueItem[] = selectedRows.value.flatMap((row) =>
    row.missingOn
      .filter((instanceId) => targets.value.includes(instanceId))
      .map((instanceId) => ({
        instanceId,
        op: 'tag.create' as const,
        payload: { label: row.label },
      })),
  );

  await queue.stage(
    batch,
    `${String(selectedRows.value.length)} tag(s) on ${String(new Set(batch.map((item) => item.instanceId)).size)} instance(s)`,
  );
  selectedLabels.value = [];
}

function renameRow(row: TagMatrixRow): void {
  renaming.value = {
    label: row.label,
    targets: row.cells
      .filter((cell) => cell.known && cell.present && targets.value.includes(cell.instanceId))
      .map((cell) => ({ instanceId: cell.instanceId, tagId: cell.tagId ?? 0, label: row.label })),
  };
}

/** Clicking a missing cell stages that one create - the fastest way to close a gap. */
function stageCellCreate(row: TagMatrixRow, instanceId: number): void {
  void queue.propagateTag(row.label, [instanceId]);
}

function stageCellDelete(row: TagMatrixRow, instanceId: number, tagId: number | null): void {
  deleting.value = [{ instanceId, tagId: tagId ?? 0, label: row.label }];
}

onMounted(() => {
  if (matrix.columns.length === 0 || matrix.lastLoadedAt === null) void matrix.load();
});
</script>

<template>
  <div class="space-y-4">
    <FleetBar />

    <!-- toolbar -->
    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="search"
        type="search"
        placeholder="Filter tags…"
        class="h-9 w-48 rounded-md border border-line bg-raised px-3 text-sm text-ink outline-none focus:border-accent"
      />
      <div class="flex rounded-md border border-line p-0.5 text-[11px]">
        <button
          v-for="entry in FILTERS"
          :key="entry.value"
          type="button"
          class="rounded px-2 py-1 transition-colors"
          :class="filter === entry.value ? 'bg-raised text-ink' : 'text-muted hover:text-ink'"
          @click="filter = entry.value"
        >
          {{ entry.label }}
        </button>
      </div>

      <span v-if="selectedRows.length > 0" class="text-xs text-staged">
        {{ selectedRows.length }} row(s) selected
      </span>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <BaseButton size="sm" variant="primary" @click="adding = true">New tag…</BaseButton>
        <BaseButton
          size="sm"
          variant="success"
          :disabled="propagatable.length === 0"
          :title="
            propagatable.length === 0
              ? 'Select rows that are missing on at least one targeted instance'
              : `Stage ${propagatable.length} create(s)`
          "
          @click="propagateSelected()"
        >
          Propagate missing ({{ propagatable.length }})
        </BaseButton>
        <BaseButton
          size="sm"
          :disabled="selectedRows.length !== 1"
          title="Rename one tag across every targeted instance that has it"
          @click="selectedRows[0] && renameRow(selectedRows[0])"
        >
          Bulk rename…
        </BaseButton>
        <BaseButton size="sm" @click="showFindReplace = true">Find &amp; replace…</BaseButton>
        <BaseButton
          size="sm"
          variant="danger"
          :disabled="deletable.length === 0"
          @click="deleting = deletable"
        >
          Delete ({{ deletable.length }})
        </BaseButton>
      </div>
    </div>

    <EmptyState
      v-if="matrix.columns.length === 0"
      title="No instances connected"
      description="Fleetarr compares tags across every connected Radarr and Sonarr. Add at least one instance to see the parity matrix."
      :icon="IconTag"
    >
      <RouterLink to="/instances">
        <BaseButton variant="primary" size="sm">Connect an instance</BaseButton>
      </RouterLink>
    </EmptyState>

    <EmptyState
      v-else-if="rows.length === 0"
      :title="matrix.loading ? 'Loading the fleet…' : 'No tags match this filter'"
      :description="
        matrix.loading
          ? 'Reading tags, root folders and import lists from every instance in parallel.'
          : 'Clear the filter, or add a tag on one instance and propagate it from here.'
      "
    />

    <!-- the matrix -->
    <div v-else class="overflow-x-auto rounded-lg border border-line">
      <table class="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th
              scope="col"
              class="sticky left-0 z-20 min-w-[16rem] border-b border-line bg-raised px-3 py-2 text-left"
            >
              <label class="flex items-center gap-2 text-[11px] font-semibold text-muted">
                <BaseCheckbox
                  :model-value="allVisibleSelected"
                  :indeterminate="someVisibleSelected"
                  @change="toggleAllVisible()"
                />
                Tag ({{ rows.length }})
              </label>
            </th>
            <InstanceColumnHeader
              v-for="column in matrix.columns"
              :key="column.instance.id"
              :column="column"
            />
          </tr>
        </thead>

        <tbody>
          <tr
            v-for="row in rows"
            :key="row.label"
            class="group"
            :class="selectedLabels.includes(row.label) ? 'bg-accent/5' : 'hover:bg-raised/40'"
          >
            <th
              scope="row"
              class="sticky left-0 z-10 border-b border-line px-3 py-1.5 text-left font-normal"
              :class="selectedLabels.includes(row.label) ? 'bg-[#16202b]' : 'bg-surface'"
            >
              <label class="flex items-center gap-2">
                <BaseCheckbox
                  :model-value="selectedLabels.includes(row.label)"
                  @change="toggleRow(row.label)"
                />
                <span data-name class="min-w-0 flex-1 truncate font-mono text-ink" :title="row.label">
                  {{ row.label }}
                </span>
                <ParityBadge
                  :parity="row.parity"
                  :present-on="row.presentOn.length"
                  :total="matrix.healthyColumns.length"
                />
                <span
                  v-if="row.unusedEverywhere"
                  class="rounded border border-line px-1 py-0.5 text-[10px] text-faint"
                  title="Not attached to any media, config or collection on any instance"
                >
                  unused
                </span>
              </label>
            </th>

            <TagCellView
              v-for="cell in row.cells"
              :key="cell.instanceId"
              :cell="cell"
              :label="row.label"
              :instance-name="instanceName(cell.instanceId)"
              :staged="queue.stagedForTag(cell.instanceId, row.label)"
              @create="stageCellCreate(row, cell.instanceId)"
              @remove="stageCellDelete(row, cell.instanceId, cell.tagId)"
            />
          </tr>
        </tbody>
      </table>
    </div>

    <AddTagDialog v-if="adding" @close="adding = false" />
    <FindReplaceDialog v-if="showFindReplace" @close="showFindReplace = false" />
    <RenameTagsDialog
      v-if="renaming"
      :label="renaming.label"
      :targets="renaming.targets"
      @close="renaming = null"
    />
    <DeleteTagsDialog v-if="deleting" :targets="deleting" @close="deleting = null" />
  </div>
</template>
