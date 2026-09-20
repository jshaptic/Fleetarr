<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MediaRow } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';
import BasePagination from '@/components/base/BasePagination.vue';
import EmptyState from '@/components/base/EmptyState.vue';
import IconInstance from '@/components/base/icons/IconInstance.vue';
import IconSearch from '@/components/base/icons/IconSearch.vue';
import IconUnknown from '@/components/base/icons/IconUnknown.vue';
import FleetBar from '@/components/fleet/FleetBar.vue';
import MediaDeleteDialog from '@/components/media/MediaDeleteDialog.vue';
import MediaExternalLinks from '@/components/media/MediaExternalLinks.vue';
import MediaFilterBar from '@/components/media/MediaFilterBar.vue';
import MediaFlagBadge from '@/components/media/MediaFlagBadge.vue';
import MediaInstanceChips from '@/components/media/MediaInstanceChips.vue';
import MediaQualityProfileDialog from '@/components/media/MediaQualityProfileDialog.vue';
import MediaRootFolderDialog from '@/components/media/MediaRootFolderDialog.vue';
import MediaTagsDialog from '@/components/media/MediaTagsDialog.vue';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { rootFolderGroups, rowFlags, rowSize } from '@/lib/media';
import type { OpPresentation, OpTone } from '@/lib/staging';
import { useMatrixStore } from '@/stores/matrix';
import { useMediaStore } from '@/stores/media';
import { useQueueStore } from '@/stores/queue';

/**
 * Every title across the fleet, for finding things and acting on them in bulk.
 *
 * Rows are titles; instances are chips. Not a column per instance - the tag matrix is the
 * only fleet-column grid in this app, and a library is far too long to read sideways.
 *
 * This view has its own badge vocabulary and reports **no parity**: two instances holding a
 * title at different paths, with different tags, under different profiles is a normal
 * layout rather than drift. Comparing configuration is what `/tags` is for. Nothing here
 * ever renders "missing on", and `no file yet` is informational - a monitored item nobody
 * has downloaded has a path that is *meant* not to exist.
 *
 * There are no row actions at all. Every change is a bulk operation from the toolbar, staged
 * into the queue and applied only from Apply All.
 */
const media = useMediaStore();
const matrix = useMatrixStore();
const queue = useQueueStore();

const TONE_RANK: Record<OpTone, number> = { destroy: 3, move: 2, create: 1, update: 0 };

type Dialog = 'tags' | 'root' | 'profile' | 'delete' | null;
const dialog = ref<Dialog>(null);

/** The instances a bulk operation may touch: the fleet bar's selection, minus the silent. */
const targets = computed(() => media.targetsFor(matrix.targetInstanceIds));
const skipped = computed(() => media.skippedFor(matrix.targetInstanceIds));

const selectedItems = computed(() =>
  targets.value.reduce((sum, target) => sum + target.mediaIds.length, 0),
);

/** Truncated ids would mean acting on part of a match while reporting all of it. */
const blocked = computed(() => media.selectionTruncated);
const canAct = computed(() => targets.value.length > 0 && !blocked.value);

const unreachableNames = computed(() =>
  media.unreachableColumns.map((column) => column.name).join(', '),
);
const listUnknownNames = computed(() =>
  media.listUnknownColumns.map((column) => column.name).join(', '),
);

function flagsOf(row: MediaRow) {
  return rowFlags(row);
}

function rootsOf(row: MediaRow) {
  return rootFolderGroups(row);
}

function sizeOf(row: MediaRow) {
  return rowSize(row);
}

/** Quoted, because a path, a tag or a status is one value however many spaces it has. */
function filterEquals(field: string, value: string): void {
  void media.setFilter(`${field}:"${value}"`);
}

function filterByRoot(path: string): void {
  filterEquals('root', path);
}

function filterByTag(tag: string): void {
  filterEquals('tags', tag);
}

function filterByStatus(status: string): void {
  filterEquals('status', status);
}

function filterByNone(field: string): void {
  // Unquoted: `none` is the known-absence sentinel. Quoting it would look for a value
  // actually called "none".
  void media.setFilter(`${field}:none`);
}

/**
 * The worst thing staged against any copy of this title.
 *
 * Across every copy, not just the first: a delete staged on the 4K copy has to show beside
 * the name even when the HD copy has nothing pending.
 */
function stagedFor(row: MediaRow): OpPresentation | null {
  let worst: OpPresentation | null = null;
  for (const facet of row.facets) {
    const intent = queue.stagedIntentForMedia(facet.instanceId, facet.mediaId);
    if (intent === null) continue;
    worst = worst === null || TONE_RANK[intent.tone] > TONE_RANK[worst.tone] ? intent : worst;
  }
  return worst;
}

async function setMonitored(monitored: boolean): Promise<void> {
  await queue.setMediaMonitored(targets.value, monitored);
  media.clearSelection();
}

async function rescan(): Promise<void> {
  await queue.refreshMediaAcross(targets.value);
  media.clearSelection();
}

function closeDialog(): void {
  dialog.value = null;
  media.clearSelection();
}

onMounted(() => {
  // Not in App.vue's bootstrap: nothing outside this route reads the store, and a whole-fleet
  // library read is the most expensive request in the app.
  if (!media.loadedOnce) void media.load();
  if (matrix.columns.length === 0 || matrix.lastLoadedAt === null) void matrix.load();
});
</script>

<template>
  <div class="space-y-4">
    <FleetBar mode="target" />

    <MediaFilterBar />

    <!-- Three facts, three sentences. Collapsing them would lose which is which. -->
    <p
      v-if="media.counts.undecided > 0"
      class="text-[11px] text-drift"
      data-testid="undecided"
    >
      <IconUnknown size="xs" />
      {{ media.counts.undecided }} title(s) could not be judged by this filter:
      {{ media.undecidedReasons.map((entry) => entry.reason).join('; ') }}. Unknown, deliberately
      not "no match".
      <BaseButton
        v-if="media.undecided === 'hide'"
        size="sm"
        variant="ghost"
        data-testid="show-undecided"
        @click="media.setUndecided('show')"
      >
        show them
      </BaseButton>
      <BaseButton v-else size="sm" variant="ghost" @click="media.setUndecided('hide')">
        back to the matches
      </BaseButton>
    </p>

    <p
      v-if="media.unreachableColumns.length > 0"
      class="text-[11px] text-danger"
      data-testid="unknown-instances"
    >
      {{ media.unreachableColumns.length }} instance(s) did not answer ({{ unreachableNames }}) -
      their rows come from the last snapshot ({{ formatRelativeTime(media.oldestFetchedAt) }}) and
      bulk operations skip them. Unknown, deliberately not "missing".
    </p>

    <p
      v-if="media.listUnknownColumns.length > 0"
      class="text-[11px] text-muted"
      data-testid="importlist-unknown"
    >
      Import-list membership is read from Radarr only. Sonarr exposes no importlist/series
      endpoint, so membership on {{ listUnknownNames }} is unknown - deliberately not "in no
      list".
    </p>

    <EmptyState
      v-if="media.columns.length === 0 && media.loadedOnce"
      title="No instances connected"
      description="Titles come from every connected Radarr and Sonarr. Add one, then come back here to tag, move or delete across the fleet."
      :icon="IconInstance"
    />

    <template v-else>
      <!-- The toolbar. Reversible work is a button; the irreversible kind opens a dialog. -->
      <div class="flex flex-wrap items-center gap-2">
        <span v-if="selectedItems > 0 || media.selectedTitleCount > 0" class="text-xs text-staged" data-testid="summary">
          {{ media.selectedTitleCount }} title(s) · {{ selectedItems }} cop(ies) across
          {{ targets.length }} instance(s)
          <BaseButton size="sm" variant="ghost" @click="media.clearSelection()">clear</BaseButton>
        </span>
        <span v-else class="text-xs text-muted">
          Select titles to tag, move, monitor or delete them across the fleet
        </span>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <BaseButton size="sm" :disabled="!canAct" @click="dialog = 'tags'">Tags…</BaseButton>
          <BaseButton size="sm" :disabled="!canAct" @click="dialog = 'root'">
            Root folder…
          </BaseButton>
          <BaseButton size="sm" :disabled="!canAct" @click="dialog = 'profile'">Profile…</BaseButton>
          <BaseButton size="sm" :disabled="!canAct" @click="setMonitored(true)">Monitor</BaseButton>
          <BaseButton size="sm" :disabled="!canAct" @click="setMonitored(false)">
            Unmonitor
          </BaseButton>
          <BaseButton
            size="sm"
            :disabled="!canAct"
            title="Ask *Arr to look at the files again - not the same as re-reading the fleet"
            @click="rescan()"
          >
            Rescan on *Arr
          </BaseButton>
          <span class="mx-1 h-5 w-px bg-line" aria-hidden="true"></span>
          <BaseButton size="sm" variant="danger" :disabled="!canAct" @click="dialog = 'delete'">
            Delete…
          </BaseButton>
        </div>
      </div>

      <p v-if="skipped.length > 0" class="text-[11px] text-danger" data-testid="skipped-instances">
        {{ skipped.map((entry) => `${entry.name} did not answer - its ${String(entry.items)} selected item(s) are not part of this operation`).join('; ') }}.
        Unknown, deliberately not "missing".
      </p>

      <p v-if="blocked" class="text-[11px] text-danger" data-testid="selection-truncated">
        The server returned {{ media.allMatching?.groups.reduce((sum, group) => sum + group.mediaIds.length, 0) ?? 0 }}
        of {{ media.counts.matched }} matching item(s) - narrow the filter before staging, so the
        operation matches what this says it does.
      </p>

      <EmptyState
        v-if="media.rows.length === 0"
        :title="media.loading ? 'Reading the fleet…' : 'No titles match this filter'"
        :description="
          media.loading
            ? 'Grouping every instance\'s library into one row per title.'
            : 'Clear the filter, or widen it - the count above says how many the filter judged.'
        "
        :icon="IconSearch"
      >
        <BaseButton v-if="!media.loading && media.filter.length > 0" size="sm" @click="media.setFilter('')">
          Clear the filter
        </BaseButton>
      </EmptyState>

      <div v-else class="space-y-2">
        <div class="overflow-x-auto rounded-lg border border-line">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th
                  scope="col"
                  class="sticky left-0 z-20 min-w-[26rem] border-b border-line bg-raised px-3 py-2 text-left"
                >
                  <label class="flex items-center gap-2 text-[11px] font-semibold text-muted">
                    <BaseCheckbox
                      :model-value="media.allMatchingSelected"
                      :indeterminate="media.somePageSelected"
                      data-testid="select-all"
                      @change="media.toggleAllMatching()"
                    />
                    Title ({{ media.counts.matched }})
                  </label>
                </th>
                <th
                  v-for="header in [
                    'Kind',
                    'Links',
                    'Instances',
                    'Size',
                    'Status',
                    'Tags',
                    'Collection',
                    'Root folder',
                  ]"
                  :key="header"
                  scope="col"
                  class="border-b border-l border-line bg-raised px-3 py-2 text-left text-[11px] font-semibold text-muted whitespace-nowrap"
                >
                  {{ header }}
                </th>
              </tr>
            </thead>

            <tbody>
              <tr
                v-for="row in media.rows"
                :key="row.key"
                :class="media.isRowSelected(row.key) ? 'bg-accent/5' : 'hover:bg-raised/40'"
              >
                <th
                  scope="row"
                  class="sticky left-0 z-10 border-b border-line px-3 py-1.5 text-left font-normal"
                  :class="media.isRowSelected(row.key) ? 'bg-[#16202b]' : 'bg-surface'"
                >
                  <div class="flex items-center gap-2">
                    <label class="flex min-w-0 items-center gap-2">
                      <BaseCheckbox
                        :model-value="media.isRowSelected(row.key)"
                        @change="media.toggleRow(row.key)"
                      />
                      <component
                        :is="stagedFor(row)?.icon"
                        v-if="stagedFor(row)"
                        size="sm"
                        class="shrink-0 text-staged"
                        data-testid="row-staged"
                        :title="`${stagedFor(row)?.label} staged for ${row.title}`"
                      />
                      <span data-name class="truncate text-ink">
                        {{ row.title }}<template v-if="row.year"> ({{ row.year }})</template>
                      </span>
                    </label>
                    <!-- Outside the checkbox label so a click filters rather than selecting. -->
                    <button
                      v-if="row.status"
                      type="button"
                      data-status
                      class="shrink-0 text-[10px] text-faint transition-colors hover:text-accent"
                      :title="`Filter by status:${row.status}`"
                      @click="filterByStatus(row.status)"
                    >
                      {{ row.status }}
                    </button>
                  </div>
                </th>

                <td class="border-b border-l border-line px-2 py-1.5 text-[10px] text-faint">
                  {{ row.kind }}
                </td>

                <td class="border-b border-l border-line px-2 py-1.5 whitespace-nowrap">
                  <MediaExternalLinks :row="row" />
                </td>

                <MediaInstanceChips :row="row" :staged-for="queue.stagedIntentForMedia" />

                <!-- Three answers, not two: a number, a known absence, or nobody could say. -->
                <td class="border-b border-l border-line px-2 py-1.5 whitespace-nowrap" data-size>
                  <span v-if="sizeOf(row).kind === 'size'" class="text-muted">
                    {{ formatBytes(row.sizeOnDisk) }}
                  </span>
                  <span
                    v-else-if="sizeOf(row).kind === 'none'"
                    class="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted"
                    title="Nothing on disk for it yet - its path is meant not to exist, and that is not a fault"
                  >
                    no file
                  </span>
                  <span
                    v-else
                    class="text-[10px] text-drift"
                    title="No copy reported a size - unknown, deliberately not zero"
                  >
                    <IconUnknown size="xs" /> unknown
                  </span>
                </td>

                <td class="border-b border-l border-line px-2 py-1.5">
                  <span class="flex flex-wrap gap-1">
                    <MediaFlagBadge
                      v-for="flag in flagsOf(row)"
                      :key="flag"
                      :flag="flag"
                      :row="row"
                      @filter="media.setFilter($event)"
                    />
                  </span>
                </td>

                <td class="border-b border-l border-line px-2 py-1.5">
                  <!-- Clicking one filters by it, the same way a root folder does. -->
                  <button
                    v-if="row.tags.length === 0"
                    type="button"
                    data-tag="none"
                    class="text-faint transition-colors hover:text-accent"
                    title="Filter by tags:none"
                    @click="filterByNone('tags')"
                  >
                    —
                  </button>
                  <span v-else class="flex flex-wrap gap-1">
                    <button
                      v-for="tag in row.tags"
                      :key="tag"
                      type="button"
                      data-tag
                      class="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-accent hover:text-accent"
                      :title="`Filter by ${tag} (on ${row.facets.filter((facet) => facet.tags.includes(tag)).map((facet) => facet.name).join(', ')})`"
                      @click="filterByTag(tag)"
                    >
                      {{ tag }}
                    </button>
                  </span>
                </td>

                <td class="border-b border-l border-line px-2 py-1.5">
                  <!--
                    A row-scope value: the collection comes from TMDB, so every copy of the
                    film agrees on it. A series has none ever, which is why the dash filters
                    by `collection:none` rather than reading as "we did not ask".
                  -->
                  <button
                    v-if="row.collection === null"
                    type="button"
                    data-collection="none"
                    class="text-faint transition-colors hover:text-accent"
                    title="Filter by collection:none"
                    @click="filterByNone('collection')"
                  >
                    —
                  </button>
                  <button
                    v-else
                    type="button"
                    data-collection
                    class="block max-w-[14rem] truncate text-left text-[11px] text-muted transition-colors hover:text-accent"
                    :title="`Filter by ${row.collection}`"
                    @click="filterEquals('collection', row.collection)"
                  >
                    {{ row.collection }}
                  </button>
                </td>

                <td class="border-b border-l border-line px-2 py-1.5">
                  <!-- Clicking one filters by it: the fastest way to ask "what else is here". -->
                  <button
                    v-for="group in rootsOf(row)"
                    :key="group.path"
                    type="button"
                    data-root
                    class="block max-w-[18rem] truncate text-left font-mono text-[10px] text-muted transition-colors hover:text-accent"
                    :title="`Filter by ${group.path} (on ${group.instances.join(', ')})`"
                    @click="filterByRoot(group.path)"
                  >
                    <span v-if="rootsOf(row).length > 1" class="mr-1 text-faint">
                      {{ group.instances.join('/') }}
                    </span>
                    {{ group.path }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- The counts are the server's, never rows.length: that is the whole point of
             filtering server-side. -->
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span data-testid="listing-summary">
            Page {{ media.summary.page }} of {{ media.summary.totalPages }} · {{ media.summary.listed }}
            {{ media.undecided === 'show' ? 'undecided' : 'matching' }} title(s)
          </span>
          <BasePagination
            v-if="media.summary.totalPages > 1"
            :page="media.page"
            :total-pages="media.totalPages"
            :loading="media.loading"
            @page="media.goToPage($event)"
          />
          <BaseButton
            size="sm"
            variant="ghost"
            class="ml-auto"
            :loading="media.loading"
            title="Drop the cached snapshots and read every instance again"
            @click="media.load({ refresh: true })"
          >
            Re-read the fleet
          </BaseButton>
        </div>
      </div>
    </template>

    <MediaTagsDialog v-if="dialog === 'tags'" :targets="targets" @close="closeDialog()" />
    <MediaRootFolderDialog v-if="dialog === 'root'" :targets="targets" @close="closeDialog()" />
    <MediaQualityProfileDialog
      v-if="dialog === 'profile'"
      :targets="targets"
      @close="closeDialog()"
    />
    <MediaDeleteDialog v-if="dialog === 'delete'" :targets="targets" @close="closeDialog()" />
  </div>
</template>
