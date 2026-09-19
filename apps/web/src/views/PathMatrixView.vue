<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { matchPathFilter, type PathNode } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import EmptyState from '@/components/base/EmptyState.vue';
import FleetBar from '@/components/fleet/FleetBar.vue';
import NewFoldersDialog from '@/components/paths/NewFoldersDialog.vue';
import PathFilterBar from '@/components/paths/PathFilterBar.vue';
import PathRowView from '@/components/paths/PathRowView.vue';
import AddPathDialog from '@/components/roots/AddPathDialog.vue';
import RemapDialog from '@/components/roots/RemapDialog.vue';
import RemoveRootFoldersDialog from '@/components/roots/RemoveRootFoldersDialog.vue';
import BulkDeleteDialog from '@/components/storage/BulkDeleteDialog.vue';
import DiskOperationModal, { type DiskOperation } from '@/components/storage/DiskOperationModal.vue';
import { basename, breadcrumbs, parentOf } from '@/lib/fs-tree';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { quoteFolderName } from '@/lib/new-folders';
import {
  absorbedFolders,
  alignTargetsFor,
  prunableFolders,
  rootFolderTargets,
  trackedBy,
  unknownColumns,
  type PathAction,
  type PathRow,
} from '@/lib/path-matrix';
import { useMatrixStore } from '@/stores/matrix';
import { usePathsStore } from '@/stores/paths';
import { useQueueStore, type RootFolderTarget } from '@/stores/queue';
import IconStorage from '@/components/base/icons/IconStorage.vue';
import IconSearch from '@/components/base/icons/IconSearch.vue';
import IconFolderOpen from '@/components/base/icons/IconFolderOpen.vue';
import IconBack from '@/components/base/icons/IconBack.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';

const paths = usePathsStore();
const queue = useQueueStore();
const matrix = useMatrixStore();

const adding = ref<{ path: string; paths: string[]; preselect: number[] } | null>(null);
const remapping = ref<string | null>(null);
const removing = ref<RootFolderTarget[] | null>(null);
const operation = ref<{ operation: DiskOperation; target: string } | null>(null);
const creating = ref<{ parent: string; source: string } | null>(null);
const pruning = ref<PathNode[] | null>(null);

const selected = ref<string[]>([]);

const columns = computed(() => paths.columns);

/**
 * The instances that could not be read.
 *
 * This is where the per-instance `?` cell went. A folder has one owner, so the grid that
 * used to state "this instance did not answer" per row is gone - but the distinction it
 * carried is not optional, so the view says it once, above the table.
 */
const unknown = computed(() => unknownColumns(columns.value));

/**
 * A row kept only because a pattern *might* continue below it.
 *
 * The server cannot tell whether a match lies under a level it was not asked to read, so
 * it keeps the way down open. Saying which rows are the answer and which are the road to
 * it is the browser's job, and it is the same verdict on both sides - see
 * `paths.parsedFilter`.
 */
function onTheWay(node: PathNode): boolean {
  const filter = paths.parsedFilter;
  if (!filter.active || filter.mode === 'exclude') return false;
  return matchPathFilter(filter, node.path) !== 'full';
}

const crumbs = computed(() =>
  paths.focus === null ? [] : breadcrumbs(paths.focus, paths.rootPaths),
);

const selectedNodes = computed(() =>
  selected.value.map((path) => paths.nodeAt(path)).filter((node): node is PathNode => node !== null),
);

/** Selected folders that could take a root folder. Which instances is the dialog's job. */
const rootable = computed(() => selectedNodes.value.filter((node) => node.canAddRootFolder));

const deletable = computed<RootFolderTarget[]>(() =>
  selectedNodes.value.flatMap((node) => rootFolderTargets(node)),
);

/**
 * The selected folders a delete may actually be staged for.
 *
 * Usually fewer than are selected - a mount, or a folder an instance still holds media under,
 * is not deletable - so the button says how many and the toolbar says how many were left out.
 */
const prunable = computed(() => prunableFolders(selectedNodes.value));

/** What `prunable` dropped as covered by a parent - the batch names them rather than hiding them. */
const absorbed = computed(() => absorbedFolders(selectedNodes.value));

function toggleSelected(path: string): void {
  selected.value = selected.value.includes(path)
    ? selected.value.filter((entry) => entry !== path)
    : [...selected.value, path];
}

/**
 * What "all" means here: the rows in the table right now.
 *
 * Not "every folder on disk", and not even every folder the browser has cached. Levels are
 * fetched lazily, so a tree-wide claim would either be a lie or an `expandAll()` crawl
 * hiding behind a checkbox. The rows already are the filtered, focused, expanded answer -
 * the same "the rows are what they are" the table itself works on - so selecting them is
 * both honest and exactly what a filter was narrowed down for.
 *
 * Only leaves, because only leaves have a checkbox.
 */
const selectableRows = computed(() => paths.rows.filter((row) => row.leaf));

const allSelected = computed(
  () =>
    selectableRows.value.length > 0 &&
    selectableRows.value.every((row) => selected.value.includes(row.node.path)),
);

/** Drives the header checkbox's third state - some of the visible rows, not all. */
const someSelected = computed(
  () =>
    !allSelected.value && selectableRows.value.some((row) => selected.value.includes(row.node.path)),
);

/**
 * Select-all adds the visible rows; deselect-all removes exactly those again, leaving any
 * selection made elsewhere - inside a branch since collapsed, or before the filter was
 * narrowed - alone. `Clear` beside the count is the one that drops everything, which is
 * why the count is a button.
 */
function toggleAll(): void {
  const visible = selectableRows.value.map((row) => row.node.path);
  selected.value = allSelected.value
    ? selected.value.filter((path) => !visible.includes(path))
    : [...new Set([...selected.value, ...visible])];
}

function clearSelection(): void {
  selected.value = [];
}

/**
 * Expanding a folder is the moment the tree learns it is a parent, and a parent is not a
 * selection target - so anything now rendered without a checkbox leaves the selection.
 *
 * Deliberately only that: a row that merely left the table (collapsed away, filtered out)
 * keeps its selection, or narrowing a filter to review one branch would silently discard
 * everything picked before it.
 */
watch(
  () => paths.rows,
  (rows: PathRow[]) => {
    const parents = new Set(rows.filter((row) => !row.leaf).map((row) => row.node.path));
    if (parents.size === 0) return;
    const next = selected.value.filter((path) => !parents.has(path));
    if (next.length !== selected.value.length) selected.value = next;
  },
);

function instanceName(instanceId: number): string {
  return (
    columns.value.find((column) => column.instanceId === instanceId)?.name ??
    `instance ${String(instanceId)}`
  );
}

function runAction(node: PathNode, action: PathAction): void {
  switch (action) {
    case 'addRoot':
      // No preselection: the folder has no owner to infer one from, and the dialog already
      // marks every instance that has it.
      adding.value = { path: node.path, paths: [], preselect: [] };
      return;
    case 'remap':
      remapping.value = node.path;
      return;
    case 'rename':
      operation.value = { operation: 'rename', target: node.path };
      return;
    case 'move':
      operation.value = { operation: 'move', target: node.path };
      return;
    case 'prune':
      operation.value = { operation: 'delete', target: node.path };
      return;
    case 'focus':
      void paths.focusOn(node.path);
      return;
  }
}

/**
 * Where "New folder(s)…" starts from.
 *
 * Creating folders is not a row action any more - one dialog per folder is the wrong shape
 * for `{movies,series}/{russian,western}/4k` - but the row still knows the answer people
 * usually want, so a single selected folder becomes the directory to create in. A selected
 * folder that does *not* exist is the other case worth keeping: it is a path only *Arr
 * believes in, and the fix is to create exactly it, so the box opens pre-filled with its
 * name inside its parent.
 */
function openCreate(): void {
  const only = selectedNodes.value.length === 1 ? selectedNodes.value[0] : undefined;

  if (only !== undefined && !only.exists && only.inScope) {
    creating.value = {
      parent: parentOf(only.path) ?? '',
      source: quoteFolderName(basename(only.path)),
    };
  } else if (only !== undefined && only.exists && only.kind === 'directory') {
    creating.value = { parent: only.path, source: '' };
  } else {
    creating.value = { parent: paths.focus ?? paths.rootPaths[0] ?? '', source: '' };
  }
}

/** Clicking an owning root-folder chip stages its removal from that instance alone. */
function removeOwner(node: PathNode, target: { instanceId: number; rootFolderId: number | null }): void {
  removing.value = [
    { instanceId: target.instanceId, rootFolderId: target.rootFolderId ?? 0, path: node.path },
  ];
}

/** The node the disk dialog is about, once - both of its instance lists come from it. */
const operationNode = computed(() => {
  const target = operation.value?.target;
  return target === undefined ? null : paths.nodeAt(target);
});

/** The instances a relocation would leave dangling, passed to the disk dialog. */
const operationTrackedBy = computed(() =>
  operationNode.value === null ? [] : trackedBy(operationNode.value),
);

/**
 * The instances a rename can carry with it: anyone rooting at this folder or under it,
 * never the fleet bar's selection. This is what used to be a second row action, `align`;
 * it is the *Arr half of the one rename dialog now, chosen per instance in there.
 */
const operationAlignTargets = computed(() =>
  operationNode.value === null ? [] : alignTargetsFor(operationNode.value),
);

/**
 * Free space is a property of a filesystem, not of an instance. The number lives on
 * the mount row. This strip is only the fallback for a view that has no mount in it
 * - the flat list, or a focused subtree - so the figure does not vanish.
 *
 * The old footer summed each instance's root folders' free space, which double-counted
 * the same disk whenever two instances rooted on one mount. One line per mount instead.
 */
const filesystems = computed(() =>
  paths.roots
    .filter((root) => root.exists && root.freeSpace !== null)
    .map((root) => ({
      path: root.path,
      freeSpace: root.freeSpace,
      totalSpace: root.totalSpace,
      share:
        root.totalSpace === null || root.totalSpace === 0 || root.freeSpace === null
          ? null
          : Math.round((root.freeSpace / root.totalSpace) * 100),
    })),
);

const mountInView = computed(() => paths.rows.some((row) => row.node.flags.includes('mount')));

// The fleet bar is a filter here, not an action target: selecting instances narrows the
// tree to their folders. Scoping is server-side, because the spine itself is built from
// the selected instances' root folders.
watch(
  () => matrix.selectedInstanceIds,
  (ids) => {
    if (paths.loadedOnce) void paths.setInstanceFilter(ids);
  },
  { deep: true },
);

/** A rescan resets the tree to the spine, same as a fresh load - the flat list is its own
 *  crawl (see `loadFlatView`), so re-run that too if it was on. */
async function rescan(): Promise<void> {
  await paths.load({ refresh: true });
  if (paths.flatView) await paths.setFlatView(true);
}

onMounted(async () => {
  if (!paths.loadedOnce) await paths.load();
  if (matrix.columns.length === 0 || matrix.lastLoadedAt === null) void matrix.load();
});
</script>

<template>
  <div class="space-y-4">
    <FleetBar mode="filter" />

    <EmptyState
      v-if="!paths.enabled && !paths.loading"
      title="Filesystem access is off"
      description="Fleetarr can inspect and reorganise media folders once it can see them. Mount your media at the same path the *Arr containers use, then set FS_ROOTS."
      :icon="IconStorage"
    >
      <pre class="mt-1 overflow-x-auto rounded-md border border-line bg-raised px-3 py-2 text-left font-mono text-[11px] text-muted">volumes:
  - /mnt/user/data:/data:rw    # the same path Radarr/Sonarr see
environment:
  FS_ROOTS: /data
  PUID: "99"                   # must match the *Arr containers
  PGID: "100"
  UMASK: "002"</pre>
    </EmptyState>

    <template v-else>
      <!-- mapping mismatch: the diagnosis that saves an hour -->
      <section
        v-if="paths.mismatches.length > 0"
        class="rounded-lg border border-drift/40 bg-drift/5 px-4 py-3"
      >
        <h2 class="mb-2 text-sm font-semibold text-drift">
          <IconWarning size="xl" /> {{ paths.mismatches.length }} instance(s) describe paths this container cannot see
        </h2>
        <ul class="space-y-2 text-[11px]">
          <li v-for="mismatch in paths.mismatches" :key="mismatch.instanceId">
            <p class="text-ink">{{ instanceName(mismatch.instanceId) }}</p>
            <p class="text-muted">
              reports {{ mismatch.mediaPathCount }} media path(s) under
              <span class="font-mono">{{ mismatch.reportedPaths.join(', ') || 'no root folders' }}</span>
            </p>
            <p class="text-muted">
              this container has <span class="font-mono">{{ mismatch.checkedRoots.join(', ') }}</span>
            </p>
          </li>
        </ul>
        <p class="mt-2 text-[11px] leading-relaxed text-muted">
          That is a volume mapping difference, not missing media. Fleetarr deliberately does
          not translate paths: mount the same host directory at the same container path as the
          *Arr apps, and this panel disappears. Those root folders are listed below as rows
          marked <span class="font-mono">not mounted here</span>.
        </p>
      </section>

      <section
        v-if="paths.unwritableRoots.length > 0 || paths.brokenRoots.length > 0"
        class="rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-[11px] text-danger"
      >
        <p v-for="root in paths.unwritableRoots" :key="root.path">
          {{ root.path }} is readable but not writable - check PUID/PGID and UMASK against the
          *Arr containers.
        </p>
        <p v-for="root in paths.brokenRoots" :key="root.path">
          {{ root.path }} is not reachable: {{ root.error ?? 'missing' }}
        </p>
      </section>

      <!-- free space, per filesystem: only when no mount row is on screen to carry it -->
      <div
        v-if="filesystems.length > 0 && !mountInView"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-raised/40 px-3 py-2 text-[11px]"
        data-testid="filesystem-space"
      >
        <span class="font-semibold tracking-wide text-faint uppercase">Free space</span>
        <span
          v-for="fs in filesystems"
          :key="fs.path"
          class="flex items-center gap-1.5"
          :title="`Every folder under ${fs.path} shares this filesystem`"
        >
          <span class="font-mono text-muted">{{ fs.path }}</span>
          <span class="text-ink">{{ formatBytes(fs.freeSpace) }} free</span>
          <span v-if="fs.totalSpace !== null" class="text-faint">
            of {{ formatBytes(fs.totalSpace) }}<template v-if="fs.share !== null"> ({{ fs.share }}%)</template>
          </span>
        </span>
      </div>

      <!-- the filter gets its own row: it expands into a pattern list and a syntax card,
           neither of which belongs squeezed between the buttons -->
      <PathFilterBar />

      <!-- toolbar -->
      <div class="flex flex-wrap items-center gap-2">
        <div v-if="!paths.flatView" class="flex items-center gap-1">
          <BaseButton size="sm" variant="ghost" :disabled="paths.busy" @click="paths.expandAll()">
            Expand all
          </BaseButton>
          <BaseButton size="sm" variant="ghost" @click="paths.collapseAll()">
            Collapse all
          </BaseButton>
        </div>
        <BaseButton
          size="sm"
          variant="ghost"
          :disabled="paths.busy"
          :title="
            paths.flatView
              ? 'Back to the folder tree'
              : 'List every leaf folder with its full path, without the tree'
          "
          @click="paths.setFlatView(!paths.flatView)"
        >
          {{ paths.flatView ? 'Tree view' : 'Flat list' }}
        </BaseButton>

        <span v-if="paths.busy" class="flex items-center gap-1.5 text-[11px] text-accent">
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          Reading storage…
        </span>
        <span v-else class="text-[11px] text-faint">
          scanned {{ formatRelativeTime(paths.scannedAt) }}
        </span>

        <button
          v-if="selected.length > 0"
          type="button"
          class="text-xs text-staged transition-colors hover:text-ink"
          data-testid="clear-selection"
          title="Clear the whole selection, including folders no longer in view"
          @click="clearSelection()"
        >
          {{ selected.length }} row(s) selected - clear
        </button>
        <span
          v-if="selected.length > 0 && prunable.length < selected.length"
          class="text-[11px] text-faint"
          data-testid="prunable-count"
          title="A mount, or a folder an instance still holds media under, is not deletable - and a folder inside another selected one goes with its parent"
        >
          {{ prunable.length }} of them can be deleted
        </span>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <BaseButton size="sm" :loading="paths.loading" @click="rescan">
            Rescan
          </BaseButton>
          <BaseButton
            size="sm"
            data-testid="new-folders-open"
            title="Create one folder, or a whole shape at once - the same syntax mkdir -p takes"
            @click="openCreate()"
          >
            New folder(s)…
          </BaseButton>
          <BaseButton
            size="sm"
            variant="success"
            :disabled="rootable.length === 0"
            :title="
              rootable.length === 0
                ? 'Select folders that could take a root folder'
                : `Choose the instances for ${rootable.length} folder(s)`
            "
            @click="adding = { path: '', paths: rootable.map((node) => node.path), preselect: [] }"
          >
            Assign ({{ rootable.length }})
          </BaseButton>
          <BaseButton
            size="sm"
            variant="danger"
            :disabled="deletable.length === 0"
            :title="
              deletable.length === 0
                ? 'Select folders an instance roots at'
                : `Unassign ${deletable.length} root folder(s) from the instances that own them`
            "
            @click="removing = deletable"
          >
            Unassign ({{ deletable.length }})
          </BaseButton>
          <BaseButton
            size="sm"
            variant="danger"
            data-testid="bulk-delete-open"
            :disabled="prunable.length === 0"
            :title="
              prunable.length === 0
                ? 'Select folders nothing roots at and no instance holds media under'
                : `Delete ${prunable.length} folder(s) from disk`
            "
            @click="pruning = prunable"
          >
            Delete ({{ prunable.length }})
          </BaseButton>
        </div>
      </div>

      <!-- focus breadcrumb -->
      <nav v-if="paths.focus" class="flex flex-wrap items-center gap-1 text-[11px] text-muted">
        <BaseButton size="sm" variant="ghost" @click="paths.clearFocus()">
          <IconBack size="sm" /> back to mounts
        </BaseButton>
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <span v-if="index > 0" class="text-faint">/</span>
          <button
            type="button"
            class="rounded px-1 font-mono transition-colors hover:text-ink"
            :class="index === crumbs.length - 1 ? 'text-ink' : ''"
            @click="paths.focusOn(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </nav>

      <!-- first paint reads every mount and root folder, so say so rather than
           flashing an empty table -->
      <div
        v-if="paths.rows.length === 0 && paths.loading"
        class="space-y-2 rounded-lg border border-line p-3"
        role="status"
        aria-live="polite"
      >
        <p class="flex items-center gap-2 text-xs text-muted">
          <span
            class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          Reading every mount and root folder…
        </p>
        <div
          v-for="row in 6"
          :key="row"
          class="h-7 animate-pulse rounded bg-raised"
          :style="{ width: `${String(90 - row * 6)}%` }"
        />
      </div>

      <!-- a filter that matched nothing is a different answer from an empty tree, and the
           way out of it is a button, not a paragraph about FS_ROOTS -->
      <EmptyState
        v-else-if="paths.rows.length === 0 && paths.parsedFilter.active"
        :title="`No folder ${paths.filterMode === 'exclude' ? 'is left by' : 'matches'} this filter`"
        :description="
          paths.filterMode === 'exclude'
            ? `All ${paths.parsedFilter.patterns.length} pattern(s) together hide everything in view.`
            : `${paths.parsedFilter.patterns.length} pattern(s), none of them naming a folder in view. Patterns match whole folder names once they contain a “/” - “movies/4k”, not “movies/4”.`
        "
        :icon="IconSearch"
      >
        <BaseButton size="sm" @click="paths.setFilter('')">Clear the filter</BaseButton>
      </EmptyState>

      <EmptyState
        v-else-if="paths.rows.length === 0"
        title="Nothing to show"
        description="Root folders come from each instance, folders come from the mounts in FS_ROOTS. If both are empty, add an instance or check your mounts."
        :icon="IconFolderOpen"
      />

      <div v-else class="space-y-2">
        <!-- the statement the per-instance `?` cell used to carry, said once -->
        <p v-if="unknown.length > 0" class="text-[11px] text-danger" data-testid="unknown-instances">
          {{ unknown.length }} instance(s) did not answer
          ({{ unknown.map((column) => column.name).join(', ') }}) - the Used by column below is
          incomplete for them, and a folder with no owner may still be one of theirs. Unknown,
          deliberately not "nobody".
        </p>

        <div class="overflow-x-auto rounded-lg border border-line transition-opacity" :class="paths.busy ? 'opacity-60' : ''">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th
                  scope="col"
                  class="sticky left-0 z-20 min-w-[24rem] border-b border-line bg-raised px-3 py-2 text-left text-[11px] font-semibold text-muted"
                >
                  <span class="flex items-center gap-1.5">
                    <BaseCheckbox
                      data-testid="select-all"
                      :model-value="allSelected"
                      :indeterminate="someSelected"
                      :disabled="selectableRows.length === 0"
                      :aria-label="allSelected ? 'Deselect every row in the table' : 'Select every row in the table'"
                      :title="
                        selectableRows.length === 0
                          ? 'No selectable folder in the table - only leaf folders can be selected'
                          : allSelected
                            ? `Deselect the ${selectableRows.length} row(s) in the table`
                            : `Select the ${selectableRows.length} row(s) in the table - exactly what is in view, filter and all`
                      "
                      @change="toggleAll()"
                    />
                    <!-- Same width as the row twisty, so "Path" lines up with depth-0 names. -->
                    <span v-if="!paths.flatView" class="w-4 shrink-0" aria-hidden="true"></span>
                    <span
                      title="A filesystem mount is blue, and carries that disk's free space. A root folder is green. What is wrong with a folder is stated at the right of this column, next to the name it describes"
                    >
                      Path
                    </span>
                  </span>
                </th>
                <th
                  class="border-b border-l border-line bg-raised px-2 py-2 text-left text-[11px] font-semibold text-muted"
                  title="The instances that root at, track, or hold media under this folder"
                >
                  Used by
                </th>
                <th class="border-b border-l border-line bg-raised px-2 py-2 text-left text-[11px] font-semibold text-muted">
                  Media
                </th>
                <th class="border-b border-l border-line bg-raised px-2 py-2 text-left text-[11px] font-semibold text-muted">
                  Size
                </th>
                <th class="border-b border-l border-line bg-raised px-2 py-2 text-left text-[11px] font-semibold text-muted">
                  Modified
                </th>
              </tr>
            </thead>

            <tbody>
              <PathRowView
                v-for="row in paths.rows"
                :key="row.key"
                :node="row.node"
                :depth="row.depth"
                :flat="paths.flatView"
                :unknown-count="unknown.length"
                :expanded="row.expanded"
                :on-the-way="onTheWay(row.node)"
                :child-severity="row.childSeverity"
                :busy="queue.busy"
                :loading="paths.isLoadingPath(row.node.path)"
                :selectable="row.leaf"
                :selected="selected.includes(row.node.path)"
                :measured="paths.measurements[row.node.path]?.sizeOnDisk ?? null"
                :measuring="paths.measuring[row.node.path] === true"
                :staged-for-path="queue.stagedForPath(row.node.path)"
                :staged-for-cell="queue.stagedForRootFolder"
                @toggle="paths.toggle(row.node.path)"
                @select="toggleSelected(row.node.path)"
                @measure="paths.measure(row.node.path)"
                @action="runAction(row.node, $event)"
                @owner-remove="removeOwner(row.node, $event)"
              />
            </tbody>
          </table>
        </div>
      </div>

      <p class="text-[11px] leading-relaxed text-muted">
        Folders are managed here in their own right - this view does not compare a folder
        across instances, because a folder normally belongs to one. Only leaf folders can be
        selected: a folder with subfolders under it is a place to look, not a thing to act
        on, and the header checkbox takes exactly the rows in view. Deleting a selection stages
        one operation per folder, each with its own preflight, so a folder that has changed by
        the time the run reaches it fails alone rather than taking the batch with it. Disk
        operations are staged like any other change: they land in Pending Fleet Changes, run in
        order with the *Arr steps, and their preflight runs again immediately before execution.
        Symlinks are shown but never followed or modified.
      </p>
    </template>

    <AddPathDialog
      v-if="adding"
      :path="adding.path"
      :paths="adding.paths"
      :preselect="adding.preselect"
      @close="adding = null"
    />
    <NewFoldersDialog
      v-if="creating"
      :parent="creating.parent"
      :source="creating.source"
      @close="creating = null"
    />
    <RemapDialog v-if="remapping" :from-path="remapping" @close="remapping = null" />
    <RemoveRootFoldersDialog v-if="removing" :targets="removing" @close="removing = null" />
    <BulkDeleteDialog
      v-if="pruning"
      :targets="pruning"
      :absorbed="absorbed"
      @staged="selected = selected.filter((path) => !$event.includes(path))"
      @close="pruning = null"
    />
    <DiskOperationModal
      v-if="operation"
      :operation="operation.operation"
      :target="operation.target"
      :tracked-by="operationTrackedBy"
      :align-targets="operationAlignTargets"
      @close="operation = null"
    />
  </div>
</template>
