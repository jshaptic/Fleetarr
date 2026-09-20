import type {
  MediaFilterVocabulary,
  MediaFleetColumn,
  MediaFleetTotals,
  MediaIdsResponse,
  MediaRow,
  MediaSort,
  MediaSortDirection,
  MediaUndecidedMode,
  MediaUndecidedReason,
} from '@fleetarr/shared';
import { parseMediaFilter } from '@fleetarr/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiRequestError } from '@/api/client';
import { mediaApi } from '@/api/media';
import type { MediaTarget } from './queue';
import { useUiStore } from './ui';

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Request failed';
}

function emptyTotals(): MediaFleetTotals {
  return {
    rows: 0,
    movies: 0,
    series: 0,
    facets: 0,
    onOneInstance: 0,
    onMultipleInstances: 0,
    monitored: 0,
    withFiles: 0,
    sizeOnDisk: null,
    unreachableInstances: 0,
    importListsUnknownInstances: 0,
    weakIdentityRows: 0,
  };
}

function emptyVocabulary(): MediaFilterVocabulary {
  return {
    instances: [],
    tags: [],
    lists: [],
    qualityProfiles: [],
    genres: [],
    certifications: [],
    collections: [],
    rootFolders: [],
  };
}

const PAGE_SIZE = 100;

/**
 * Every title across the fleet, judged by the server.
 *
 * Modelled on the paths store rather than the matrix one: the join, the filter, the sort and
 * the counts all happen server-side, so a filter change is a reload rather than a local
 * `.filter()` over a page. **Nothing here narrows `rows`** - the moment it did, the summary
 * above the table would be describing rows it had just removed.
 *
 * The browser parses the expression but never evaluates it. The parse drives the error line,
 * the typo hint and completion; the verdicts arrive with the rows.
 */
export const useMediaStore = defineStore('media', () => {
  const ui = useUiStore();

  const rows = ref<readonly MediaRow[]>([]);
  const columns = ref<readonly MediaFleetColumn[]>([]);
  const totals = ref<MediaFleetTotals>(emptyTotals());
  const vocabulary = ref<MediaFilterVocabulary>(emptyVocabulary());
  const counts = ref({ matched: 0, undecided: 0, total: 0 });
  const undecidedReasons = ref<readonly MediaUndecidedReason[]>([]);
  const scannedAt = ref<string | null>(null);
  const oldestFetchedAt = ref<string | null>(null);

  const filter = ref('');
  const undecided = ref<MediaUndecidedMode>('hide');
  const sort = ref<MediaSort>('title');
  const direction = ref<MediaSortDirection>('asc');
  const page = ref(1);
  const truncated = ref(false);

  const selectedKeys = ref<string[]>([]);
  /**
   * The whole match set, straight from the server.
   *
   * Set only by `selectAllMatching`, and defined *by* the current filter - so it has to die
   * with it. A stale one would let a bulk operation act on rows the summary no longer
   * describes, which is the same dishonesty as a client-side filter wearing a different hat.
   */
  const allMatching = ref<MediaIdsResponse | null>(null);

  const loading = ref(false);
  const loadedOnce = ref(false);

  /**
   * The filter, parsed.
   *
   * The server parses the very same source string for the very same reason, and the two must
   * agree - which is why the parser lives in `@fleetarr/shared`. Here it drives the error
   * line, the typo hint, and the decision not to send a request at all.
   */
  const parsedFilter = computed(() => parseMediaFilter(filter.value));

  const listedCount = computed(() =>
    undecided.value === 'show' ? counts.value.undecided : counts.value.matched,
  );

  const totalPages = computed(() => Math.max(1, Math.ceil(listedCount.value / PAGE_SIZE)));

  const selectedRows = computed(() =>
    allMatching.value !== null
      ? rows.value
      : rows.value.filter((row) => selectedKeys.value.includes(row.key)),
  );

  /** The header checkbox: on only for the whole match, never "every row on this page". */
  const allMatchingSelected = computed(() => allMatching.value !== null);

  /** Hand-picked rows on this page, so the header can sit in the middle state. */
  const somePageSelected = computed(
    () => allMatching.value === null && selectedKeys.value.length > 0,
  );

  const selectedTitleCount = computed(() =>
    allMatching.value !== null ? allMatching.value.matched : selectedKeys.value.length,
  );

  const unreachableColumns = computed(() => columns.value.filter((column) => !column.reachable));

  /** Instances that cannot answer a list question at all - stated once, never per row. */
  const listUnknownColumns = computed(() =>
    columns.value.filter((column) => !column.importListsKnown),
  );

  const reachableIds = computed(
    () => new Set(columns.value.filter((column) => column.reachable).map((c) => c.instanceId)),
  );

  const columnFor = (instanceId: number): MediaFleetColumn | undefined =>
    columns.value.find((column) => column.instanceId === instanceId);

  function isRowSelected(key: string): boolean {
    return allMatching.value !== null || selectedKeys.value.includes(key);
  }

  async function request(next: { page: number; refresh?: boolean }): Promise<void> {
    loading.value = true;
    try {
      const response = await mediaApi.list({
        // An unreadable filter is never sent; `setFilter` refuses earlier, and this is the
        // backstop for a programmatic caller.
        ...(parsedFilter.value.error === null && parsedFilter.value.active
          ? { filter: filter.value }
          : {}),
        undecided: undecided.value,
        sort: sort.value,
        direction: direction.value,
        page: next.page,
        pageSize: PAGE_SIZE,
        ...(next.refresh === true ? { refresh: true } : {}),
      });

      rows.value = response.rows;
      columns.value = response.columns;
      totals.value = response.totals;
      vocabulary.value = response.vocabulary;
      counts.value = response.counts;
      undecidedReasons.value = response.undecidedReasons;
      scannedAt.value = response.scannedAt;
      oldestFetchedAt.value = response.oldestFetchedAt;
      truncated.value = response.truncated;
      page.value = response.page;
      loadedOnce.value = true;
    } catch (caught) {
      // The previous rows stay on screen. Blanking the table would hide the work in
      // progress, and an unreadable filter never got this far - so a failure here is a
      // server disagreement worth reading rather than a reason to clear everything.
      ui.notify('error', `Could not read the fleet: ${messageOf(caught)}`);
    } finally {
      loading.value = false;
    }
  }

  function load(options: { refresh?: boolean } = {}): Promise<void> {
    return request({ page: 1, ...(options.refresh === true ? { refresh: true } : {}) });
  }

  async function goToPage(next: number): Promise<void> {
    const clamped = Math.min(totalPages.value, Math.max(1, next));
    if (clamped === page.value) return;
    const keepMatch = allMatching.value !== null;
    await request({ page: clamped });
    // A hand-picked page cannot describe copies the table no longer holds.
    if (!keepMatch) selectedKeys.value = [];
  }

  function clearSelection(): void {
    selectedKeys.value = [];
    allMatching.value = null;
  }

  /**
   * Apply a new filter.
   *
   * Clears the selection, deliberately unlike the paths store: selections there feed a
   * dialog you review, while these feed a fan-out whose count is printed and then executed.
   * Keeping rows the summary no longer describes is not a convenience.
   */
  async function setFilter(source: string): Promise<void> {
    filter.value = source;
    if (parseMediaFilter(source).error !== null) return;
    clearSelection();
    await load();
  }

  async function setUndecided(mode: MediaUndecidedMode): Promise<void> {
    undecided.value = mode;
    clearSelection();
    await load();
  }

  async function setSort(next: MediaSort, nextDirection?: MediaSortDirection): Promise<void> {
    // The match set is about the filter, not the order. A hand-picked page is not.
    sort.value = next;
    direction.value =
      nextDirection ?? (sort.value === next && direction.value === 'asc' ? 'desc' : 'asc');
    if (allMatching.value === null) selectedKeys.value = [];
    await load();
  }

  function toggleRow(key: string): void {
    if (allMatching.value !== null) {
      // Leaving the whole match: keep the rest of this page, drop this row.
      allMatching.value = null;
      selectedKeys.value = rows.value.map((row) => row.key).filter((entry) => entry !== key);
      return;
    }
    selectedKeys.value = selectedKeys.value.includes(key)
      ? selectedKeys.value.filter((entry) => entry !== key)
      : [...selectedKeys.value, key];
  }

  /** Every id the current filter matches, from the server - never from the loaded page. */
  async function selectAllMatching(): Promise<void> {
    try {
      allMatching.value = await mediaApi.ids(
        parsedFilter.value.error === null && parsedFilter.value.active
          ? { filter: filter.value }
          : {},
      );
      selectedKeys.value = rows.value.map((row) => row.key);
    } catch (caught) {
      ui.notify('error', `Could not read the whole match: ${messageOf(caught)}`);
    }
  }

  /** The header checkbox: the whole match, or nothing. */
  async function toggleAllMatching(): Promise<void> {
    if (allMatching.value !== null) {
      clearSelection();
      return;
    }
    await selectAllMatching();
  }

  /** True while the server could only hand back part of the match. */
  const selectionTruncated = computed(() => allMatching.value?.truncated === true);

  /**
   * The selection as one operation per instance.
   *
   * Two things are dropped here, and both are stated in the toolbar rather than hidden:
   * a copy the filter did not match, and an instance that did not answer.
   */
  function targetsFor(instanceIds: readonly number[]): MediaTarget[] {
    const allowed = new Set(instanceIds.filter((id) => reachableIds.value.has(id)));
    const groups = new Map<number, number[]>();

    const pairs: Array<readonly [number, number]> =
      allMatching.value === null
        ? selectedRows.value.flatMap((row) =>
            row.facets
              .filter((facet) => facet.matched)
              .map((facet) => [facet.instanceId, facet.mediaId] as const),
          )
        : allMatching.value.groups.flatMap((group) =>
            group.mediaIds.map((id) => [group.instanceId, id] as const),
          );

    for (const [instanceId, mediaId] of pairs) {
      if (!allowed.has(instanceId)) continue;
      groups.set(instanceId, [...(groups.get(instanceId) ?? []), mediaId]);
    }

    return [...groups].map(([instanceId, mediaIds]) => ({ instanceId, mediaIds }));
  }

  /**
   * Selected copies on instances that are targeted but silent.
   *
   * Exactly what `targetsFor` left out, so the toolbar can say it out loud: unknown is not
   * "nothing to do". `/media/ids` omits the silent, so a whole-match still walks the page
   * for copies the id set never named.
   */
  function skippedFor(instanceIds: readonly number[]): Array<{ name: string; items: number }> {
    const targeted = new Set(instanceIds);
    const skipped = new Map<number, number>();

    if (allMatching.value !== null) {
      for (const group of allMatching.value.groups) {
        if (!targeted.has(group.instanceId)) continue;
        if (reachableIds.value.has(group.instanceId)) continue;
        skipped.set(group.instanceId, group.mediaIds.length);
      }
    }

    // `/media/ids` never names a silent instance, so the page still has to speak for it.
    const named = new Set(skipped.keys());
    for (const row of selectedRows.value) {
      for (const facet of row.facets) {
        if (!facet.matched) continue;
        if (!targeted.has(facet.instanceId)) continue;
        if (reachableIds.value.has(facet.instanceId)) continue;
        if (named.has(facet.instanceId)) continue;
        skipped.set(facet.instanceId, (skipped.get(facet.instanceId) ?? 0) + 1);
      }
    }

    return [...skipped].map(([instanceId, items]) => ({
      name: columnFor(instanceId)?.name ?? `instance ${String(instanceId)}`,
      items,
    }));
  }

  /**
   * The counts the toolbar prints.
   *
   * Read off the response, never off `rows.length`: the whole point of filtering on the
   * server is that "page 1 of 35" stays true.
   */
  const summary = computed(() => ({
    loaded: rows.value.length,
    matched: counts.value.matched,
    listed: listedCount.value,
    undecided: counts.value.undecided,
    total: counts.value.total,
    page: page.value,
    totalPages: totalPages.value,
    truncated: truncated.value,
  }));

  return {
    rows,
    columns,
    totals,
    vocabulary,
    counts,
    undecidedReasons,
    scannedAt,
    oldestFetchedAt,
    filter,
    parsedFilter,
    undecided,
    sort,
    direction,
    page,
    totalPages,
    truncated,
    selectedKeys,
    selectedRows,
    selectedTitleCount,
    allMatchingSelected,
    somePageSelected,
    allMatching,
    selectionTruncated,
    unreachableColumns,
    listUnknownColumns,
    loading,
    loadedOnce,
    busy: loading,
    summary,
    columnFor,
    isRowSelected,
    load,
    goToPage,
    setFilter,
    setUndecided,
    setSort,
    toggleRow,
    toggleAllMatching,
    clearSelection,
    selectAllMatching,
    targetsFor,
    skippedFor,
  };
});
