import type {
  FsDirectoriesResponse,
  PathMatrixLevel,
  PathMatrixResponse,
  PathNode,
  PathRollup,
} from '@fleetarr/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/api/client';
import type { MatrixParams } from '@/api/storage';

function rollup(overrides: Partial<PathRollup> = {}): PathRollup {
  return {
    entries: 0,
    tracked: 0,
    untracked: 0,
    neutral: 0,
    missing: 0,
    rootFolders: 0,
    symlinks: 0,
    empty: null,
    unreadable: null,
    mediaUnder: 0,
    severity: 'ok',
    ...overrides,
  };
}

function node(path: string, overrides: Partial<PathNode> = {}): PathNode {
  return {
    path,
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    origin: 'disk',
    exists: true,
    kind: 'directory',
    inScope: true,
    modifiedAt: null,
    childCount: 1,
    readable: true,
    writable: true,
    deviceId: '1',
    freeSpace: null,
    totalSpace: null,
    sizeOnDisk: null,
    lowSpace: false,
    error: null,
    owners: [],
    flags: [],
    severity: 'ok',
    canAddRootFolder: true,
    rollup: null,
    expandable: true,
    ...overrides,
  };
}

function level(path: string | null, nodes: PathNode[], overrides: Partial<PathMatrixLevel> = {}): PathMatrixLevel {
  return {
    path,
    parent: null,
    nodes,
    rollup: rollup({ entries: nodes.length }),
    selection: ['all'],
    matched: nodes.length,
    offset: 0,
    limit: 200,
    truncated: false,
    childCountsResolved: true,
    error: null,
    ...overrides,
  };
}

function response(levels: PathMatrixLevel[], overrides: Partial<PathMatrixResponse> = {}): PathMatrixResponse {
  return {
    enabled: true,
    scannedAt: '2026-09-01T00:00:00.000Z',
    roots: [],
    columns: [],
    levels,
    totals: {
      rootFolderPaths: 1,
      unseenRootFolders: 1,
      unmanaged: 0,
      untracked: 3,
      missing: 2,
    },
    mismatches: [],
    ...overrides,
  };
}

const calls: MatrixParams[] = [];
const directoryCalls: { under?: string; refresh?: boolean }[] = [];
let directoryHandler: () => Promise<FsDirectoriesResponse> = () =>
  Promise.resolve({ under: null, directories: [], truncated: false, scannedAt: '' });
let handler: (params: MatrixParams) => Promise<PathMatrixResponse> = () =>
  Promise.resolve(response([]));

vi.mock('@/api/storage', () => ({
  storageApi: {
    matrix: (params: MatrixParams = {}) => {
      calls.push(params);
      return handler(params);
    },
    directories: (params: { under?: string; refresh?: boolean } = {}) => {
      directoryCalls.push(params);
      return directoryHandler();
    },
    measure: vi.fn(),
    preflight: vi.fn(),
    roots: vi.fn(),
  },
}));

const { usePathsStore } = await import('./paths');

beforeEach(() => {
  setActivePinia(createPinia());
  calls.length = 0;
  directoryCalls.length = 0;
  handler = () => Promise.resolve(response([]));
  directoryHandler = () =>
    Promise.resolve({ under: null, directories: [], truncated: false, scannedAt: '' });
});

/**
 * The picker's folder list. It used to be assembled from whatever levels the tree view had
 * fetched, which meant a dialog opened from `/media` offered nothing and a dialog opened on
 * a big directory offered the handful of rows the server had summarised it down to.
 */
describe('the directory list the pickers offer', () => {
  it('walks once and serves every picker after that from the same answer', async () => {
    directoryHandler = () =>
      Promise.resolve({
        under: null,
        directories: ['/data/media', '/data/media/movies'],
        truncated: false,
        scannedAt: '2026-09-01T00:00:00.000Z',
      });

    const store = usePathsStore();
    await store.loadDirectories();
    await store.loadDirectories();

    expect(directoryCalls).toHaveLength(1);
    expect(store.knownDirectories).toEqual(['/data/media', '/data/media/movies']);
  });

  it('walks again when asked to refresh', async () => {
    const store = usePathsStore();
    await store.loadDirectories();
    await store.loadDirectories({ refresh: true });

    expect(directoryCalls).toEqual([{}, { refresh: true }]);
  });

  /** A capped walk is a lower bound, and the picker says so rather than looking complete. */
  it('carries the truncation through so the picker can state it', async () => {
    directoryHandler = () =>
      Promise.resolve({ under: null, directories: ['/data'], truncated: true, scannedAt: '' });

    const store = usePathsStore();
    await store.loadDirectories();

    expect(store.directoriesTruncated).toBe(true);
  });

  it('adds to what the levels know rather than replacing it', async () => {
    directoryHandler = () =>
      Promise.resolve({ under: null, directories: ['/mnt/archive'], truncated: false, scannedAt: '' });
    handler = () => Promise.resolve(response([level(null, [node('/data')])]));

    const store = usePathsStore();
    await store.load();
    await store.loadDirectories();

    expect(store.knownDirectories).toEqual(['/data', '/mnt/archive']);
  });

  /**
   * Quiet on purpose: a typed path is always allowed and the preflight judges it, so a
   * toast about a list nobody asked for would be noise over a field that still works.
   */
  it('leaves the picker with the levels when the walk fails, and says nothing', async () => {
    directoryHandler = () => Promise.reject(new Error('nope'));
    handler = () => Promise.resolve(response([level(null, [node('/data')])]));

    const store = usePathsStore();
    await store.load();
    await store.loadDirectories();

    expect(store.knownDirectories).toEqual(['/data']);
    expect(store.directoriesLoading).toBe(false);
  });
});

describe('usePathsStore', () => {
  it('opens every level the spine returned', async () => {
    handler = () =>
      Promise.resolve(
        response([level(null, [node('/data')]), level('/data', [node('/data/media')])]),
      );

    const store = usePathsStore();
    await store.load();

    expect(store.expanded).toEqual(['/data']);
    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data', '/data/media']);
    expect(store.loadedOnce).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('fetches a level once, then serves the expansion from cache', async () => {
    handler = (params) =>
      Promise.resolve(
        response(
          (params.paths ?? []).length === 0
            ? [level(null, [node('/data')])]
            : [level('/data', [node('/data/media')])],
        ),
      );

    const store = usePathsStore();
    await store.load();
    await store.expand('/data');
    const afterFirst = calls.length;

    store.collapse('/data');
    await store.expand('/data');
    expect(calls.length).toBe(afterFirst);
  });

  it('collapsing a path also drops its descendants from the tree', async () => {
    handler = () =>
      Promise.resolve(
        response([
          level(null, [node('/data')]),
          level('/data', [node('/data/media')]),
          level('/data/media', [node('/data/media/movies')]),
        ]),
      );

    const store = usePathsStore();
    await store.load();
    expect(store.expanded).toEqual(['/data', '/data/media']);

    store.collapse('/data');
    expect(store.expanded).toEqual([]);
    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data']);
  });

  it('re-reads the spine when the filter changes, so the whole tree narrows', async () => {
    handler = (params) =>
      Promise.resolve(
        response(
          (params.paths ?? []).length === 0
            ? [level(null, [node('/data')]), level('/data', [node('/data/media')])]
            : (params.paths ?? []).map((path) => level(path, [])),
        ),
      );

    const store = usePathsStore();
    await store.load();
    calls.length = 0;

    await store.setFilter('movies/4k');

    // The spine is filtered server-side too, so a pattern narrows every level on the way
    // down - not only the ones that happened to be open.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.paths).toEqual([]);
    expect(calls[0]?.filter).toBe('movies/4k');
    expect(calls[0]?.filterMode).toBe('include');
    expect(store.parsedFilter.patterns).toEqual(['movies/4k']);
  });

  it('the negation toggle re-asks with the same patterns', async () => {
    handler = () => Promise.resolve(response([level(null, [node('/data')])]));

    const store = usePathsStore();
    await store.load();
    await store.setFilter('movies/{4k,main}');
    calls.length = 0;

    await store.setFilterMode('exclude');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.filter).toBe('movies/{4k,main}');
    expect(calls[0]?.filterMode).toBe('exclude');
    expect(store.parsedFilter.patterns).toEqual(['movies/4k', 'movies/main']);

    // Asking for the mode it is already in is not a request.
    await store.setFilterMode('exclude');
    expect(calls).toHaveLength(1);
  });

  it('never sends a filter it could not read', async () => {
    handler = () => Promise.resolve(response([level(null, [node('/data')])]));

    const store = usePathsStore();
    await store.load();
    calls.length = 0;

    await store.setFilter('movies/{4k,main');

    expect(calls).toHaveLength(0);
    expect(store.parsedFilter.error).toMatch(/unclosed/);
  });

  it('the flat list drops folders kept only as a way down to a match', async () => {
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      return Promise.resolve(
        response(
          paths.map((path) =>
            path === '/data'
              ? // `/data/movies` is on the way to a match; `/data/series` is one itself.
                level('/data', [
                  node('/data/movies', { expandable: false }),
                  node('/data/series', { expandable: false }),
                ])
              : level(path, []),
          ),
        ),
      );
    };

    const store = usePathsStore();
    await store.load();
    await store.setFilter('series');
    await store.setFlatView(true);

    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data/series']);
  });

  it('re-roots at a focused path', async () => {
    handler = () =>
      Promise.resolve(
        response([
          level(null, [node('/data')]),
          level('/data', [node('/data/media')]),
          level('/data/media', [node('/data/media/movies')]),
        ]),
      );

    const store = usePathsStore();
    await store.load();
    await store.focusOn('/data/media');

    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data/media/movies']);

    store.clearFocus();
    expect(store.rows.length).toBeGreaterThan(1);
  });

  it('counts the things that need a decision for the nav badge', async () => {
    handler = () => Promise.resolve(response([level(null, [])]));

    const store = usePathsStore();
    await store.load();

    // untracked 3 + missing 2 + unseen 1 + unmanaged 0
    expect(store.problemCount).toBe(6);
  });

  it('an instance filter reloads the spine and keeps open levels open', async () => {
    handler = () =>
      Promise.resolve(
        response([level(null, [node('/data')]), level('/data', [node('/data/media')])]),
      );

    const store = usePathsStore();
    await store.load();
    await store.expand('/data/media');
    calls.length = 0;

    // The spine itself is scoped to the selection, so this is a reload, not a refetch of
    // the levels that happen to be open.
    await store.setInstanceFilter([2, 1]);

    expect(store.instanceFilter).toEqual([1, 2]);
    expect(calls[0]?.instanceIds).toEqual([1, 2]);
    // A reload asks for the spine, and never re-hits the *Arr APIs to do it.
    expect(calls[0]?.paths).toEqual([]);
    expect(calls[0]?.refresh).toBeUndefined();
    // What the user had open stays open.
    expect(store.expanded).toContain('/data/media');
    expect(calls.at(-1)?.paths).toEqual(['/data/media']);
  });

  it('an unchanged instance filter does not reload', async () => {
    const store = usePathsStore();
    await store.load();
    calls.length = 0;

    await store.setInstanceFilter([]);
    expect(calls).toEqual([]);
  });

  it('expandAll opens every expandable node, fetching one level per depth', async () => {
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      return Promise.resolve(
        response(
          paths.map((path) =>
            path === '/data'
              ? level('/data', [node('/data/media'), node('/data/other', { expandable: false })])
              : level('/data/media', [node('/data/media/movies', { expandable: false })]),
          ),
        ),
      );
    };

    const store = usePathsStore();
    await store.load();
    // Nothing below the spine is fetched yet - the point of the test.
    expect(store.expanded).toEqual([]);

    await store.expandAll();

    expect(store.expanded).toEqual(['/data', '/data/media']);
    expect(store.rows.map((row) => row.node?.path)).toEqual([
      '/data',
      '/data/media',
      '/data/media/movies',
      '/data/other',
    ]);
    // load() + one batched fetch per depth, never one request per node.
    expect(calls).toHaveLength(3);
  });

  it('the flat list re-fetches a level the tree defaulted to problems-only, without touching the tree', async () => {
    // Simulates a big directory: a plain expand() gets the "problems" default and misses
    // an ordinary folder entirely, not just a later page of it.
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      if (params.only?.includes('all') === true) {
        return Promise.resolve(
          response(
            paths.map((path) =>
              level(path, [node('/data/onepiece', { expandable: false })], {
                selection: ['all'],
                matched: 1,
              }),
            ),
          ),
        );
      }
      return Promise.resolve(
        response(paths.map((path) => level(path, [], { selection: ['problems'], matched: 0 }))),
      );
    };

    const store = usePathsStore();
    await store.load();
    await store.expand('/data');
    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data']);

    await store.setFlatView(true);

    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data/onepiece']);
    expect(calls.at(-1)?.only).toEqual(['all']);
    // The tree's own cache never saw the full listing - still the stale problems-only page.
    expect(store.levels['/data']?.nodes).toEqual([]);
  });

  it('the flat list pages through a truncated level until nothing is left out', async () => {
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      const onFirstPage = (params.offset ?? 0) === 0;
      return Promise.resolve(
        response(
          paths.map((path) =>
            level(path, [node(onFirstPage ? '/data/a' : '/data/b', { expandable: false })], {
              selection: ['all'],
              matched: 2,
              offset: onFirstPage ? 0 : 1,
              limit: 1,
              truncated: onFirstPage,
            }),
          ),
        ),
      );
    };

    const store = usePathsStore();
    await store.load();

    await store.setFlatView(true);

    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data/a', '/data/b']);
    expect(store.flatLevels['/data']?.truncated).toBe(false);
  });

  it('the flat list never shows files, even when a directory would otherwise return one', async () => {
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      return Promise.resolve(
        response(
          paths.map((path) =>
            level(path, [
              node('/data/folder', { expandable: false }),
              node('/data/movie.mkv', { kind: 'file', expandable: false }),
            ]),
          ),
        ),
      );
    };

    const store = usePathsStore();
    await store.load();
    await store.setFlatView(true);

    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data/folder']);
  });

  it('collapseAll closes the whole tree, not just what was fetched last', async () => {
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      return Promise.resolve(response(paths.map((path) => level(path, [node('/data/media')]))));
    };

    const store = usePathsStore();
    await store.load();
    await store.expandAll();
    expect(store.expanded.length).toBeGreaterThan(0);

    store.collapseAll();

    expect(store.expanded).toEqual([]);
    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data']);
  });

  it('flat view lists every leaf with its full path and no nesting', async () => {
    handler = (params) => {
      const paths = params.paths ?? [];
      if (paths.length === 0) return Promise.resolve(response([level(null, [node('/data')])]));
      return Promise.resolve(
        response(
          paths.map((path) =>
            path === '/data'
              ? level('/data', [node('/data/media'), node('/data/other', { expandable: false })])
              : level('/data/media', [node('/data/media/movies', { expandable: false })]),
          ),
        ),
      );
    };

    const store = usePathsStore();
    await store.load();

    await store.setFlatView(true);

    expect(store.flatView).toBe(true);
    expect(store.rows.every((row) => row.depth === 0)).toBe(true);
    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data/media/movies', '/data/other']);

    // Switching back shows the tree exactly as the user left it - the flat crawl has its
    // own cache and never touched the hierarchical one.
    await store.setFlatView(false);
    expect(store.rows.map((row) => row.node?.path)).toEqual(['/data']);
  });

  it('treats a disabled filesystem as a state, not an error', async () => {
    handler = () =>
      Promise.reject(new ApiRequestError({ code: 'fs_disabled', message: 'off', status: 503 }));

    const store = usePathsStore();
    await store.load();

    expect(store.enabled).toBe(false);
  });
});
