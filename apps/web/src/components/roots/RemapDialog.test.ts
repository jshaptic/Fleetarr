import type { FsCheck, NewQueueItem, PathMatrixResponse } from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FROM = '/data/media/movies';
let nextId = 1;

const push = vi.fn((items: readonly NewQueueItem[]) =>
  Promise.resolve({
    items: items.map((entry) => ({
      id: nextId++,
      instanceId: entry.instanceId ?? null,
      kind: (entry.instanceId == null ? 'fs' : 'arr') as 'fs' | 'arr',
      runId: null,
      dependsOnId: entry.dependsOnId ?? null,
      sortOrder: nextId,
      status: 'pending' as const,
      op: entry.op,
      payload: entry.payload,
      targetKind: 'path' as const,
      targetId: null,
      targetLabel: '',
      summary: '',
      affectedCount: 1,
      attempts: 0,
      error: null,
      result: null,
      createdAt: '',
      updatedAt: '',
      startedAt: null,
      finishedAt: null,
    })),
  }),
);

/** The `fs.mkdir` verdict for the destination - what decides whether a disk step is staged. */
let mkdirChecks: FsCheck[] = [];
const preflight = vi.fn(() =>
  Promise.resolve({
    op: 'fs.mkdir',
    ok: !mkdirChecks.some((check) => check.status === 'blocker'),
    checks: mkdirChecks,
    measurement: null,
    freeSpace: 900,
    referencedBy: [],
  }),
);

function owner(instanceId: number, overrides: Record<string, unknown> = {}) {
  return {
    instanceId,
    name: `Radarr-${String(instanceId)}`,
    kind: 'radarr' as const,
    use: 'rootFolder' as const,
    rootFolderId: 40 + instanceId,
    accessible: true,
    mediaUnder: 3,
    mediaWithFiles: 3,
    title: null,
    rootFoldersUnder: [],
    importLists: [],
    collections: [],
    collectionsKnown: true,
    freeSpace: null,
    totalSpace: null,
    ...overrides,
  };
}

function node(path: string, overrides: Record<string, unknown> = {}) {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    origin: 'disk' as const,
    exists: true,
    kind: 'directory' as const,
    inScope: true,
    modifiedAt: null,
    childCount: 0,
    readable: true,
    writable: true,
    deviceId: '1',
    freeSpace: 1000,
    totalSpace: 2000,
    lowSpace: false,
    sizeOnDisk: null,
    error: null,
    owners: [],
    flags: [],
    severity: 'ok' as const,
    canAddRootFolder: false,
    rollup: null,
    expandable: false,
    ...overrides,
  };
}

/** Nodes the matrix endpoint hands back, keyed by their level. */
let levelNodes: Record<string, ReturnType<typeof node>[]> = {};

function level(path: string | null, nodes: ReturnType<typeof node>[]) {
  return {
    path,
    parent: null,
    nodes,
    rollup: {
      entries: nodes.length,
      tracked: 0,
      untracked: 0,
      neutral: 0,
      missing: 0,
      rootFolders: 0,
      symlinks: 0,
      empty: null,
      unreadable: null,
      mediaUnder: 0,
      severity: 'ok' as const,
    },
    selection: ['all' as const],
    matched: nodes.length,
    offset: 0,
    limit: 200,
    truncated: false,
    childCountsResolved: true,
    error: null,
  };
}

const matrixResponse = vi.fn(
  (query: { paths?: readonly string[] }): Promise<PathMatrixResponse> =>
    Promise.resolve({
      enabled: true,
      scannedAt: '2026-01-01T00:00:00Z',
      roots: [],
      columns: [],
      levels: (query.paths?.length ? query.paths : [null]).map((path) =>
        level(path as string | null, levelNodes[String(path)] ?? []),
      ),
      totals: {
        rootFolderPaths: 0,
        unseenRootFolders: 0,
        unmanaged: 0,
        untracked: 0,
        missing: 0,
      },
      mismatches: [],
    } as PathMatrixResponse),
);

vi.mock('@/api/storage', () => ({
  storageApi: {
    roots: () => Promise.resolve({ enabled: true, roots: [] }),
    matrix: (...args: unknown[]) => matrixResponse(...(args as [{ paths?: readonly string[] }])),
    measure: () => Promise.resolve({ path: FROM, sizeOnDisk: 500, fileCount: 9, directoryCount: 1, truncated: false }),
    preflight: () => preflight(),
  },
}));

vi.mock('@/api/resources', () => ({
  resourcesApi: {
    snapshot: vi.fn(() =>
      Promise.resolve({
        fetchedAt: '2026-01-01T00:00:00Z',
        tags: [],
        rootFolders: [{ id: 41, path: FROM }],
        importLists: [],
        qualityProfiles: [],
        collections: [],
      }),
    ),
    media: vi.fn(),
    allMediaIdsInRootFolder: vi.fn(() => Promise.resolve([10, 11, 12])),
    refresh: vi.fn(),
  },
}));

vi.mock('@/api/instances', () => ({
  instancesApi: {
    list: () => Promise.resolve([{ id: 1, name: 'Radarr-1', kind: 'radarr', baseUrl: '', enabled: true }]),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

vi.mock('@/api/queue', () => ({
  queueApi: {
    list: () => Promise.resolve({ items: [], activeRun: null }),
    push,
    detail: vi.fn(),
    reorder: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    runs: vi.fn(),
    run: vi.fn(),
    start: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    events: vi.fn(),
    openStream: vi.fn(() => () => undefined),
  },
}));

const RemapDialog = (await import('./RemapDialog.vue')).default;
const { usePathsStore } = await import('@/stores/paths');

const FREE: FsCheck = { id: 'destination_free', status: 'ok', message: 'Destination does not exist yet' };
const TAKEN: FsCheck = { id: 'destination_free', status: 'blocker', message: '/data/media/4k already exists' };

async function mountDialog(): Promise<ReturnType<typeof mount>> {
  const pinia = createPinia();
  setActivePinia(pinia);
  // The tree the dialog reads its owners and its destination facts from.
  await usePathsStore().load();

  const wrapper = mount(RemapDialog, {
    props: { fromPath: FROM },
    global: { plugins: [pinia] },
  });
  for (let tick = 0; tick < 10; tick += 1) await flushPromises();
  return wrapper;
}

function find(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

/** Ids come from the push mock in staging order, so position is identity here. */
function idOf(op: string): number {
  return push.mock.calls.flatMap((call) => call[0]).findIndex((item) => item.op === op) + 1;
}

async function destination(value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="switch-destination"]');
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  for (let tick = 0; tick < 10; tick += 1) await flushPromises();
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  push.mockClear();
  preflight.mockClear();
  nextId = 1;
  mkdirChecks = [FREE];
  levelNodes = {
    null: [node(FROM, { flags: ['rootFolder'], owners: [owner(1)] })],
  };
});

describe('RemapDialog', () => {
  it('reads its instances from the folder row, not from the fleet matrix', async () => {
    // The matrix load is fired and forgotten by the view, so seeding from it left the dialog
    // with no candidates and a button that could never be enabled.
    const wrapper = await mountDialog();

    expect(document.body.textContent).toContain('Radarr-1');
    expect(document.body.textContent).toContain('3 item(s)');
    wrapper.unmount();
  });

  it('puts an fs.mkdir at the head when the destination is not on disk', async () => {
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    expect(find('will-mkdir')).not.toBeNull();

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.mkdir', payload: { path: '/data/media/4k', recursive: true } },
    ]);
    expect(push.mock.calls[1]?.[0]?.[0]).toMatchObject({
      instanceId: 1,
      op: 'rootFolder.create',
      payload: { path: '/data/media/4k' },
      dependsOnId: 1,
    });
    wrapper.unmount();
  });

  it('stages no mkdir for a folder that is already there', async () => {
    // fs.mkdir treats an existing target as a blocker, so staging one would pause the run
    // before a single *Arr step had a chance to execute.
    mkdirChecks = [TAKEN];
    levelNodes['/data/media/4k'] = [];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    expect(find('will-mkdir')).toBeNull();

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]?.[0]).toMatchObject({ op: 'rootFolder.create' });
    wrapper.unmount();
  });

  it('always moves the files, and says the old folder stays behind', async () => {
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    const moves = push.mock.calls.flatMap((call) => call[0]).filter((item) => item.op === 'media.moveRootFolder');
    expect(moves[0]).toMatchObject({
      payload: { mediaIds: [10, 11, 12], toRootFolderPath: '/data/media/4k', moveFiles: true },
    });
    expect(document.body.textContent).toContain('is left on disk');
    wrapper.unmount();
  });

  it('drops the old root folder by its real path, not a placeholder', async () => {
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    const removals = push.mock.calls.flatMap((call) => call[0]).filter((item) => item.op === 'rootFolder.delete');
    expect(removals[0]).toMatchObject({ payload: { rootFolderId: 41, path: FROM } });
    wrapper.unmount();
  });

  it('never stages a rescan - *Arr answers before it has moved anything', async () => {
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    expect(
      push.mock.calls.flatMap((call) => call[0]).filter((item) => item.op === 'media.refresh'),
    ).toHaveLength(0);
    wrapper.unmount();
  });

  it('needs an acknowledgement before moving into a folder that is not empty', async () => {
    mkdirChecks = [TAKEN];
    // Emptiness is read from the destination's own level, which is fetched on demand.
    levelNodes['/data/media/4k'] = [node('/data/media/4k/Dune (2021)')];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    expect(find('destination-occupied')).not.toBeNull();
    expect(find('switch-confirm')?.hasAttribute('disabled')).toBe(true);

    find('acknowledge-not-empty')?.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(find('switch-confirm')?.hasAttribute('disabled')).toBe(false);
    wrapper.unmount();
  });

  it('re-aims the import lists that fill the old folder, keeping their depth', async () => {
    levelNodes.null = [
      node(FROM, {
        flags: ['rootFolder'],
        owners: [
          owner(1, {
            importLists: [
              // One aimed at the root folder itself, one aimed below it.
              { id: 7, name: 'Trakt watchlist', enabled: true, automatic: true, path: FROM },
              { id: 8, name: 'Anime', enabled: true, automatic: true, path: `${FROM}/anime` },
            ],
          }),
        ],
      }),
    ];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    expect(find('stranded-lists')?.textContent).toContain('Trakt watchlist');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    const updates = push.mock.calls
      .flatMap((call) => call[0])
      .filter((item) => item.op === 'importList.update');

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      instanceId: 1,
      payload: { importListId: 7, changes: { rootFolderPath: '/data/media/4k' } },
    });
    // The nested one keeps its own subfolder rather than collapsing onto the new root.
    expect(updates[1]).toMatchObject({
      payload: { importListId: 8, changes: { rootFolderPath: '/data/media/4k/anime' } },
    });
    wrapper.unmount();
  });

  it('re-aims the collections rooted here, grouped by where each lands', async () => {
    levelNodes.null = [
      node(FROM, {
        flags: ['rootFolder'],
        owners: [
          owner(1, {
            collections: [
              { id: 1, title: 'Dune', monitored: true, searchOnAdd: true, path: FROM },
              { id: 2, title: 'Bond', monitored: true, searchOnAdd: false, path: FROM },
              // Rooted below, so it keeps its own subfolder.
              { id: 3, title: 'Marvel', monitored: false, searchOnAdd: false, path: `${FROM}/marvel` },
            ],
          }),
        ],
      }),
    ];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    expect(find('stranded-collections')?.textContent).toContain('Dune');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    const updates = push.mock.calls
      .flatMap((call) => call[0])
      .filter((item) => item.op === 'collection.update');

    // Two calls, not three: the two landing on the same folder are one editor call.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      instanceId: 1,
      payload: { collectionIds: [1, 2], changes: { rootFolderPath: '/data/media/4k' } },
    });
    expect(updates[1]).toMatchObject({
      payload: { collectionIds: [3], changes: { rootFolderPath: '/data/media/4k/marvel' } },
    });

    // And before the old root folder is dropped, or it would re-add into the folder the
    // media just left.
    const ops = push.mock.calls.flatMap((call) => call[0]).map((item) => item.op);
    expect(ops.indexOf('collection.update')).toBeLessThan(ops.indexOf('rootFolder.delete'));
    wrapper.unmount();
  });

  it('says which instances could not report their collections rather than showing none', async () => {
    levelNodes.null = [
      node(FROM, {
        flags: ['rootFolder'],
        owners: [owner(1, { collections: [], collectionsKnown: false })],
      }),
    ];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    expect(find('collections-unknown')?.textContent).toContain('Radarr-1');
    wrapper.unmount();
  });

  it('waits for the move before re-aiming a list', async () => {
    levelNodes.null = [
      node(FROM, {
        flags: ['rootFolder'],
        owners: [
          owner(1, {
            importLists: [{ id: 7, name: 'Trakt', enabled: true, automatic: true, path: FROM }],
          }),
        ],
      }),
    ];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    const items = push.mock.calls.flatMap((call) => call[0]);
    const move = items.find((item) => item.op === 'media.moveRootFolder');
    const update = items.find((item) => item.op === 'importList.update');

    // A list re-aimed at a folder the media never reached is worse than one left alone, so
    // the update hangs off the move itself rather than off a position in the batch.
    expect(move).toBeDefined();
    expect(update?.dependsOnId).toBe(idOf('media.moveRootFolder'));
    wrapper.unmount();
  });

  it('leaves the lists alone when the box is unticked, and says so', async () => {
    levelNodes.null = [
      node(FROM, {
        flags: ['rootFolder'],
        owners: [
          owner(1, {
            importLists: [{ id: 7, name: 'Trakt', enabled: true, automatic: true, path: FROM }],
          }),
        ],
      }),
    ];
    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    find('repoint-lists')?.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(find('stranded-lists')?.textContent).toContain('re-point them on the instance yourself');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    expect(
      push.mock.calls.flatMap((call) => call[0]).filter((item) => item.op === 'importList.update'),
    ).toHaveLength(0);
    wrapper.unmount();
  });

  it('switches a root folder nothing has been downloaded into yet', async () => {
    levelNodes.null = [
      node(FROM, { flags: ['rootFolder'], owners: [owner(1, { mediaUnder: 0, mediaWithFiles: 0 })] }),
    ];
    const { resourcesApi } = await import('@/api/resources');
    vi.mocked(resourcesApi.allMediaIdsInRootFolder).mockResolvedValueOnce([]);

    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    // No media to move, so no move step - but the create and the cleanup still happen, and
    // the cleanup waits on the create rather than on nothing.
    expect(find('switch-confirm')?.hasAttribute('disabled')).toBe(false);
    wrapper.unmount();
  });

  /**
   * "*Arr will physically relocate 0 item(s). This is slow and cannot be undone" was the
   * copy for the case where nothing happens at all. A red box on the harmless case is how
   * the one that matters stops being read, and the chain below it claimed a move step the
   * queue does not stage.
   */
  it('promises no relocation, and no move step, when there is nothing under the folder', async () => {
    levelNodes.null = [
      node(FROM, { flags: ['rootFolder'], owners: [owner(1, { mediaUnder: 0, mediaWithFiles: 0 })] }),
    ];
    const { resourcesApi } = await import('@/api/resources');
    vi.mocked(resourcesApi.allMediaIdsInRootFolder).mockResolvedValue([]);

    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    const notice = find('relocation-notice');
    expect(notice?.textContent).not.toContain('physically relocate');
    expect(notice?.textContent).toContain('no files');
    expect(document.body.textContent).toContain('nothing to move');
    // The button counts the steps the queue will actually receive: mkdir, create and
    // delete - no move.
    expect(find('switch-confirm')?.textContent).toContain('Stage 3 step(s)');

    find('switch-confirm')?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    expect(
      push.mock.calls.flatMap((call) => call[0]).filter((item) => item.op === 'media.moveRootFolder'),
    ).toHaveLength(0);
    vi.mocked(resourcesApi.allMediaIdsInRootFolder).mockResolvedValue([10, 11, 12]);
    wrapper.unmount();
  });

  /** A count that failed is not a count of zero, and must not be rounded down into one. */
  it('says it cannot tell how much moves when a count failed', async () => {
    const { resourcesApi } = await import('@/api/resources');
    vi.mocked(resourcesApi.allMediaIdsInRootFolder).mockRejectedValueOnce(new Error('nope'));

    const wrapper = await mountDialog();
    await destination('/data/media/4k');

    const notice = find('relocation-notice');
    expect(notice?.textContent).toContain('could not count');
    expect(notice?.textContent).not.toContain('relocate 0 item(s)');
    // The move is still staged - only a counted zero cancels it - so this is one more step
    // than the same folder counted at zero.
    expect(find('switch-confirm')?.textContent).toContain('Stage 4 step(s)');
    wrapper.unmount();
  });
});
