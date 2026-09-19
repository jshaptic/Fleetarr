import type {
  FsAssumeResolved,
  FsMeasurement,
  FsOp,
  FsPreflight,
  FsRoot,
  MappingMismatch,
  PathFilterMode,
  PathMatrixColumn,
  PathMatrixLevel,
  PathMatrixResponse,
  PathMatrixTotals,
  PathNode,
  QueuePayloadFor,
} from '@fleetarr/shared';
import { parsePathFilter } from '@fleetarr/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiRequestError } from '@/api/client';
import { storageApi } from '@/api/storage';
import {
  flattenLeaves,
  flattenLevels,
  levelKey,
  rootFolderTargets,
  TOP_LEVEL,
  type PathRow,
  type RootFolderCellTarget,
} from '@/lib/path-matrix';
import { useUiStore } from './ui';

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Request failed';
}

function emptyTotals(): PathMatrixTotals {
  return {
    rootFolderPaths: 0,
    unseenRootFolders: 0,
    unmanaged: 0,
    untracked: 0,
    missing: 0,
  };
}

/**
 * The joined storage view: mounts, root folders and what is on disk, in one tree.
 *
 * Levels are fetched lazily and cached by path. Nothing here walks a library - the
 * server summarises a big directory and returns only the rows worth showing, which is
 * why expanding a folder with 812 films costs one request and a handful of rows.
 */
export const usePathsStore = defineStore('paths', () => {
  const ui = useUiStore();

  const enabled = ref(false);
  const roots = ref<readonly FsRoot[]>([]);
  const columns = ref<readonly PathMatrixColumn[]>([]);
  const levels = ref<Record<string, PathMatrixLevel>>({});
  /** The flat list's own cache - see `loadFlatView`. Never shares state with `levels`. */
  const flatLevels = ref<Record<string, PathMatrixLevel>>({});
  /** Every directory the server could walk to, for the pickers - see `loadDirectories`. */
  const walkedDirectories = ref<readonly string[]>([]);
  const directoriesTruncated = ref(false);
  const directoriesLoadedAt = ref<number | null>(null);
  const directoriesLoading = ref(false);
  const totals = ref<PathMatrixTotals>(emptyTotals());
  const mismatches = ref<readonly MappingMismatch[]>([]);
  const scannedAt = ref<string | null>(null);

  const expanded = ref<string[]>([]);
  const focus = ref<string | null>(null);
  const flatView = ref(false);
  const filter = ref('');
  /** `exclude` turns the filter into "everything but this". */
  const filterMode = ref<PathFilterMode>('include');
  /** Which instances' folders to show. Empty means the whole fleet. */
  const instanceFilter = ref<number[]>([]);

  /**
   * The filter, expanded.
   *
   * The server expands the very same source string for the very same reason, and the two
   * must agree - which is why the expander lives in `@fleetarr/shared` rather than in
   * either of them. Here it drives the flat list's own pruning, the "on the way to a
   * match" dimming and everything the filter bar reports back to the user.
   */
  const parsedFilter = computed(() => parsePathFilter(filter.value, filterMode.value));

  const measurements = ref<Record<string, FsMeasurement>>({});
  const measuring = ref<Record<string, boolean>>({});

  const loading = ref(false);
  const loadingPaths = ref<Record<string, boolean>>({});
  const loadedOnce = ref(false);

  /** Anything in flight - drives the one visible "working" signal in the toolbar. */
  const busy = computed(
    () => loading.value || Object.keys(loadingPaths.value).length > 0,
  );

  const isLoadingPath = (path: string): boolean => loadingPaths.value[path] === true;

  const rows = computed<PathRow[]>(() =>
    flatView.value
      ? flattenLeaves({
          levels: flatLevels.value,
          expanded: [],
          focus: focus.value,
          filter: parsedFilter.value,
        })
      : flattenLevels({ levels: levels.value, expanded: expanded.value, focus: focus.value }),
  );

  const usableRoots = computed(() => roots.value.filter((root) => root.exists));
  const rootPaths = computed(() => usableRoots.value.map((root) => root.path));

  /**
   * Every directory a picker may offer: the walk, the mounts, and anything a level added.
   *
   * The walk is the substance and the levels are a bonus - a level is fetched for the tree
   * view, which summarises a directory of 812 films down to its problems, so on its own it
   * offered a handful of folders out of hundreds and called it the filesystem. What the
   * walk cannot reach is stated rather than hidden: it stops at a root folder, and says so
   * when it hits its cap. Typing a path that is in neither stays allowed; the preflight is
   * the authority on whether a path exists, not this list.
   */
  const knownDirectories = computed<string[]>(() => {
    const known = new Set<string>([...rootPaths.value, ...walkedDirectories.value]);
    for (const level of [...Object.values(levels.value), ...Object.values(flatLevels.value)]) {
      for (const node of level.nodes) {
        if (node.exists && node.inScope && node.kind === 'directory') known.add(node.path);
      }
    }
    return [...known].sort((a, b) => a.localeCompare(b));
  });

  /**
   * What the folder list does not hold, in one sentence, for every picker that shows it.
   *
   * Here rather than in each dialog because it is a fact about the walk, not about the
   * field: if the policy changes, three pickers stop lying at once. Both limits are the
   * kind this app states rather than hides - a capped list that looked complete would send
   * someone hunting for a folder that is there.
   */
  const directoryListNote = computed(() =>
    directoriesTruncated.value
      ? 'Too many folders to list them all - a path this list does not show can still be typed, and will still be checked.'
      : 'Folders inside a root folder are not listed - that is the library, never a destination.',
  );

  const unwritableRoots = computed(() =>
    roots.value.filter((root) => root.exists && !root.writable),
  );
  const brokenRoots = computed(() => roots.value.filter((root) => !root.exists));

  /** Root folders this container cannot see - rendered as rows *and* explained. */
  const unseenNodes = computed<PathNode[]>(
    () => levels.value[TOP_LEVEL]?.nodes.filter((node) => !node.inScope) ?? [],
  );

  const reachableColumns = computed(() => columns.value.filter((column) => column.reachable));

  /** What the nav badge counts: things that need a decision. */
  const problemCount = computed(
    () =>
      totals.value.untracked +
      totals.value.missing +
      totals.value.unseenRootFolders +
      totals.value.unmanaged,
  );

  const isExpanded = (path: string): boolean => expanded.value.includes(path);

  /**
   * The node behind a path, from whichever cache the current view is reading.
   *
   * The flat list has a cache of its own (`flatLevels`) that deliberately never shares
   * state with `levels`, and its rows come only from there - so looking in `levels` alone
   * left every selection made in that view resolving to nothing, and with it every toolbar
   * action the selection feeds. The active view is asked first; the other is a fallback,
   * since a path can legitimately sit in both.
   */
  function nodeAt(path: string): PathNode | null {
    const caches = flatView.value
      ? [flatLevels.value, levels.value]
      : [levels.value, flatLevels.value];
    for (const cache of caches) {
      for (const level of Object.values(cache)) {
        const found = level.nodes.find((node) => node.path === path);
        if (found !== undefined) return found;
      }
    }
    return null;
  }

  function rootFolderTargetsFor(path: string): RootFolderCellTarget[] {
    const node = nodeAt(path);
    return node === null ? [] : rootFolderTargets(node);
  }

  function mergeLevels(response: PathMatrixResponse): void {
    const next = { ...levels.value };
    for (const level of response.levels) next[levelKey(level.path)] = level;
    levels.value = next;
    columns.value = response.columns;
    roots.value = response.roots;
    enabled.value = response.enabled;
  }

  function requestFor(paths: readonly string[]): Parameters<typeof storageApi.matrix>[0] {
    // An unreadable filter is never sent: the server rejects it, and a toast saying
    // "validation failed" is a worse answer than the bar's own "unclosed {".
    const active = parsedFilter.value.active;
    return {
      paths,
      ...(active ? { filter: filter.value.trim(), filterMode: filterMode.value } : {}),
      ...(instanceFilter.value.length === 0 ? {} : { instanceIds: instanceFilter.value }),
    };
  }

  /** The spine: every mount and the chain down to each root folder, in one request. */
  async function load(options: { refresh?: boolean } = {}): Promise<void> {
    loading.value = true;
    try {
      const response = await storageApi.matrix({
        ...requestFor([]),
        ...(options.refresh === true ? { refresh: true } : {}),
      });

      levels.value = Object.fromEntries(
        response.levels.map((level) => [levelKey(level.path), level]),
      );
      columns.value = response.columns;
      roots.value = response.roots;
      enabled.value = response.enabled;
      totals.value = response.totals;
      mismatches.value = response.mismatches;
      scannedAt.value = response.scannedAt;

      // Everything the spine returned is open: the user lands on their root folders.
      expanded.value = response.levels
        .map((level) => level.path)
        .filter((path): path is string => path !== null);
      loadedOnce.value = true;
    } catch (caught) {
      // A disabled filesystem is not an error worth shouting about; the view explains it.
      if (caught instanceof ApiRequestError && caught.code === 'fs_disabled') {
        enabled.value = false;
      } else {
        ui.notify('error', `Could not read storage: ${messageOf(caught)}`);
      }
    } finally {
      loading.value = false;
    }
  }

  /**
   * Fetches one or more levels in a single request. Batching matters: changing a filter
   * refetches every open level, and that has to stay one round trip.
   */
  async function fetchLevels(
    paths: readonly string[],
    overrides: { offset?: number; refresh?: boolean } = {},
  ): Promise<void> {
    if (paths.length === 0) return;
    loadingPaths.value = { ...loadingPaths.value, ...Object.fromEntries(paths.map((p) => [p, true])) };

    try {
      const response = await storageApi.matrix({ ...requestFor(paths), ...overrides });
      mergeLevels(response);
      scannedAt.value = response.scannedAt;
    } catch (caught) {
      ui.notify('error', `Could not read ${paths.join(', ')}: ${messageOf(caught)}`);
    } finally {
      const next = { ...loadingPaths.value };
      for (const path of paths) delete next[path];
      loadingPaths.value = next;
    }
  }

  async function expand(path: string): Promise<void> {
    if (!expanded.value.includes(path)) expanded.value = [...expanded.value, path];
    if (levels.value[path] === undefined) await fetchLevels([path]);
  }

  function collapse(path: string): void {
    // Descendants stay cached but leave the tree, so re-expanding is instant.
    expanded.value = expanded.value.filter(
      (entry) => entry !== path && !entry.startsWith(`${path}/`),
    );
  }

  async function toggle(path: string): Promise<void> {
    if (isExpanded(path)) collapse(path);
    else await expand(path);
  }

  /**
   * Opens every expandable node reachable from the current root, fetching whatever level
   * that takes - one batched request per depth, since a level's children are unknown until
   * the level itself is fetched. Bounded the same way ordinary browsing is: a level that
   * summarises a big directory still only returns the rows worth showing.
   */
  async function expandAll(): Promise<void> {
    for (;;) {
      const known = Object.values(levels.value).flatMap((level) => level.nodes);
      const expandable = known.filter((node) => node.expandable);

      const notYetOpen = expandable.map((node) => node.path).filter((path) => !isExpanded(path));
      if (notYetOpen.length > 0) expanded.value = [...expanded.value, ...notYetOpen];

      const unfetched = expandable
        .map((node) => node.path)
        .filter((path) => levels.value[path] === undefined);
      if (unfetched.length === 0) break;
      await fetchLevels(unfetched);
    }
  }

  /** Descendants stay cached, same as a single `collapse` - only the tree closes. */
  function collapseAll(): void {
    expanded.value = [];
  }

  /**
   * Fetches a whole depth of levels for the flat list in one request - `path` is
   * repeatable, and the crawl now visits every folder, so one request per folder would be
   * a request storm on a wide tree.
   *
   * `only: ['all']` so a big directory is not narrowed to problems-only, which would hide
   * ordinary subfolders and make a branch look like a leaf. Anything still truncated is
   * then paged on its own - one extra request per oversized directory, not per path.
   */
  async function fetchFlatLevels(paths: readonly string[]): Promise<PathMatrixLevel[]> {
    if (paths.length === 0) return [];
    const response = await storageApi.matrix({ ...requestFor(paths), only: ['all'], limit: 1000 });

    return Promise.all(
      response.levels.map(async (fetched) => {
        let level = fetched;
        while (level.truncated && level.path !== null) {
          const path = level.path;
          const more = await storageApi.matrix({
            ...requestFor([path]),
            only: ['all'],
            limit: 1000,
            offset: level.offset + level.nodes.length,
          });
          const next = more.levels.find((entry) => entry.path === path);
          if (next === undefined) break;
          level = { ...next, offset: level.offset, nodes: [...level.nodes, ...next.nodes] };
        }
        return level;
      }),
    );
  }

  /**
   * Crawls the whole tree from the current root for the flat list, breadth-first, into a
   * cache of its own (`flatLevels`) rather than the hierarchical `levels` the tree view
   * reads. That separation is deliberate: showing every leaf means asking every big
   * directory for everything rather than the light "problems only" default a normal
   * expand click gets, and that fuller (file-inclusive) listing must never end up where
   * the tree view would render it.
   *
   * The top level (mounts) is reused as-is from the already-loaded spine - it is never
   * large enough to need the "full" treatment, and re-deriving it here would just be a
   * second copy of the same handful of rows.
   */
  async function loadFlatView(): Promise<void> {
    const startPath = focus.value;
    const next: Record<string, PathMatrixLevel> = {};
    let frontier: string[];

    if (startPath === null) {
      const topLevel = levels.value[TOP_LEVEL];
      if (topLevel !== undefined) next[TOP_LEVEL] = topLevel;
      frontier = (topLevel?.nodes ?? [])
        .filter((node) => node.kind === 'directory' && node.expandable)
        .map((node) => node.path);
    } else {
      frontier = [startPath];
    }

    loading.value = true;
    try {
      const visited = new Set<string>();
      while (frontier.length > 0) {
        const fetched = await fetchFlatLevels(frontier);
        const nextFrontier: string[] = [];
        for (const level of fetched) {
          next[levelKey(level.path)] = level;
          for (const node of level.nodes) {
            // Every folder is visited: whether it is a leaf is decided by what its own
            // level holds, and a folder full of files looks identical from up here.
            if (node.kind !== 'directory' || !node.expandable) continue;
            if (visited.has(node.path)) continue;
            visited.add(node.path);
            nextFrontier.push(node.path);
          }
        }
        frontier = nextFrontier;
      }
      flatLevels.value = next;
    } catch (caught) {
      ui.notify('error', `Could not read the flat list: ${messageOf(caught)}`);
    } finally {
      loading.value = false;
    }
  }

  /** Turning flat view on crawls the whole tree first - see `loadFlatView`. */
  async function setFlatView(value: boolean): Promise<void> {
    flatView.value = value;
    if (value) await loadFlatView();
  }

  /**
   * Applying a filter is a reload, not a refetch of the open levels.
   *
   * The spine - every mount down to every root folder - is filtered server-side too, so a
   * pattern like `movies/{4k,main}` narrows the whole tree on the way down rather than
   * only the levels that happen to be open. The flat list is its own crawl, so it re-runs
   * instead (see `loadFlatView`).
   */
  async function setFilter(value: string, mode?: PathFilterMode): Promise<void> {
    filter.value = value;
    if (mode !== undefined) filterMode.value = mode;
    if (parsedFilter.value.error !== null) return;
    if (flatView.value) await loadFlatView();
    else await reload({ refresh: false });
  }

  /** The negation toggle: same patterns, opposite answer. */
  async function setFilterMode(mode: PathFilterMode): Promise<void> {
    if (filterMode.value === mode) return;
    await setFilter(filter.value, mode);
  }

  /**
   * A whole reload, not a refetch of the open levels: the spine itself is scoped to the
   * selected instances, so which levels exist changes with the filter. `refresh: false`
   * keeps it off the *Arr APIs - the cached index already knows who roots where.
   */
  async function setInstanceFilter(ids: readonly number[]): Promise<void> {
    const next = [...ids].sort((a, b) => a - b);
    if (next.join(',') === instanceFilter.value.join(',')) return;
    instanceFilter.value = next;
    await reload({ refresh: false });
  }

  async function focusOn(path: string): Promise<void> {
    focus.value = path;
    await expand(path);
  }

  function clearFocus(): void {
    focus.value = null;
  }

  /**
   * The folder list every picker offers, walked once per session.
   *
   * One request rather than a crawl, and nothing per keystroke: the server returns names
   * only, so a whole tree costs about what one expanded level used to, and the filtering
   * happens in the browser where it is instant. Safe to call from a dialog that has never
   * touched `/paths` - which is how the `/media` dialogs ended up offering an empty list.
   *
   * A failure is deliberately quiet. The picker still works, because a typed path is
   * always allowed and the preflight is what judges it; a toast for something the user did
   * not ask for would be noise over a field that is behaving.
   */
  async function loadDirectories(options: { refresh?: boolean } = {}): Promise<void> {
    const fresh = directoriesLoadedAt.value !== null && Date.now() - directoriesLoadedAt.value < 60_000;
    if (directoriesLoading.value || (fresh && options.refresh !== true)) return;

    directoriesLoading.value = true;
    try {
      const response = await storageApi.directories(
        options.refresh === true ? { refresh: true } : {},
      );
      walkedDirectories.value = response.directories;
      directoriesTruncated.value = response.truncated;
      directoriesLoadedAt.value = Date.now();
    } catch {
      // Left to the levels and the mounts, which is what the pickers had before.
    } finally {
      directoriesLoading.value = false;
    }
  }

  /** Recursive size, on demand only - this is the expensive call. */
  async function measure(target: string): Promise<void> {
    measuring.value = { ...measuring.value, [target]: true };
    try {
      measurements.value = { ...measurements.value, [target]: await storageApi.measure(target) };
    } catch (caught) {
      ui.notify('error', `Could not measure ${target}: ${messageOf(caught)}`);
    } finally {
      const next = { ...measuring.value };
      delete next[target];
      measuring.value = next;
    }
  }

  function preflight<K extends FsOp>(
    op: K,
    payload: QueuePayloadFor<K>,
    assumeResolved?: FsAssumeResolved,
  ): Promise<FsPreflight> {
    return storageApi.preflight(op, payload, assumeResolved);
  }

  /**
   * Reload the spine while keeping whatever the user had open, open.
   *
   * `load()` alone would collapse the tree back to the spine, which is the wrong answer
   * both after a run and after a filter change: the levels below are still the levels
   * being worked on.
   */
  async function reload(options: { refresh?: boolean } = {}): Promise<void> {
    const open = [...expanded.value];
    await load(options);
    // Re-open whatever the user had open that the new spine did not already cover.
    const missing = open.filter((path) => levels.value[path] === undefined);
    if (missing.length > 0) {
      expanded.value = [...new Set([...expanded.value, ...missing])];
      await fetchLevels(missing);
    }
  }

  /** Called after a run touched the disk or an instance. */
  async function refreshAll(): Promise<void> {
    measurements.value = {};
    await reload({ refresh: true });
  }

  return {
    enabled,
    roots,
    columns,
    levels,
    flatLevels,
    totals,
    mismatches,
    scannedAt,
    expanded,
    focus,
    flatView,
    filter,
    filterMode,
    parsedFilter,
    instanceFilter,
    measurements,
    measuring,
    loading,
    loadingPaths,
    loadedOnce,
    busy,
    isLoadingPath,
    rows,
    usableRoots,
    rootPaths,
    knownDirectories,
    directoriesTruncated,
    directoriesLoading,
    directoryListNote,
    unwritableRoots,
    brokenRoots,
    unseenNodes,
    reachableColumns,
    problemCount,
    isExpanded,
    nodeAt,
    rootFolderTargetsFor,
    load,
    loadDirectories,
    fetchLevels,
    expand,
    collapse,
    toggle,
    expandAll,
    collapseAll,
    setFlatView,
    setFilter,
    setFilterMode,
    setInstanceFilter,
    focusOn,
    clearFocus,
    measure,
    preflight,
    reload,
    refreshAll,
  };
});
