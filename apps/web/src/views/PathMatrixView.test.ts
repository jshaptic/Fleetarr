import type {
  Instance,
  NewQueueItem,
  PathFilterMode,
  PathMatrixColumn,
  PathMatrixLevel,
  PathMatrixResponse,
  PathNode,
  PathOwner,
  PathRollup,
  PathUse,
} from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function instance(id: number, name: string, kind: Instance['kind'] = 'radarr'): Instance {
  return {
    id,
    name,
    kind,
    baseUrl: `http://host:${String(7000 + id)}`,
    verifySsl: true,
    enabled: true,
    timeoutMs: 20_000,
    appVersion: '5.0.0',
    lastConnectedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  };
}

const INSTANCES = [instance(1, 'Radarr-4K'), instance(2, 'Radarr-HD')];

/** Each instance roots at its own subfolder - a normal fleet layout. */
const ROOT_FOLDERS: Record<number, Array<{ id: number; path: string; accessible: boolean }>> = {
  1: [{ id: 1, path: '/data/media/movies', accessible: true }],
  2: [{ id: 5, path: '/data/media/tv', accessible: false }],
};

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

const NAMES: Record<number, string> = { 1: 'Radarr-4K', 2: 'Radarr-HD' };

function owner(instanceId: number, use: PathUse, overrides: Partial<PathOwner> = {}): PathOwner {
  return {
    instanceId,
    name: NAMES[instanceId] ?? `instance ${String(instanceId)}`,
    kind: 'radarr',
    use,
    rootFolderId: use === 'rootFolder' ? ROOT_FOLDERS[instanceId]?.[0]?.id ?? 0 : null,
    accessible: use === 'rootFolder' ? (ROOT_FOLDERS[instanceId]?.[0]?.accessible ?? true) : null,
    mediaUnder: use === 'rootFolder' ? 0 : 3,
    mediaWithFiles: use === 'rootFolder' ? 0 : 3,
    title: use === 'tracked' ? 'Dune' : null,
    rootFoldersUnder: use === 'containsRoot' ? [{ id: 1, path: '/data/media/movies' }] : [],
    importLists: [],
    freeSpace: use === 'rootFolder' ? 1_000_000_000 : null,
    totalSpace: use === 'rootFolder' ? 4_000_000_000 : null,
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
    modifiedAt: '2026-09-01T00:00:00.000Z',
    childCount: 2,
    readable: true,
    writable: true,
    deviceId: '1',
    freeSpace: 2_000_000_000,
    totalSpace: 8_000_000_000,
    lowSpace: false,
    sizeOnDisk: null,
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

const MOUNT = node('/data', {
  flags: ['mount'],
  owners: [owner(1, 'ancestor'), owner(2, 'ancestor')],
  canAddRootFolder: true,
});
const MEDIA = node('/data/media', {
  owners: [
    // No media of its own anywhere below: its only claim is the root folder one level
    // down, which is exactly the case that used to render as an unowned folder.
    owner(2, 'containsRoot', {
      mediaUnder: 0,
      mediaWithFiles: 0,
      rootFoldersUnder: [{ id: 5, path: '/data/media/tv' }],
      importLists: [
        { id: 8, name: 'Series watchlist', enabled: true, automatic: true, path: '/data/media/tv' },
        { id: 9, name: 'Kids picks', enabled: false, automatic: false, path: '/data/media/tv' },
      ],
    }),
    owner(1, 'ancestor'),
  ],
});

// Root folders are leaves: the library below them is not this view's to manage. Each
// instance roots at its own subfolder - one owner per folder, the layout this view assumes.
const MOVIES = node('/data/media/movies', {
  flags: ['rootFolder'],
  expandable: false,
  owners: [
    owner(1, 'rootFolder', {
      mediaUnder: 812,
      mediaWithFiles: 806,
      importLists: [
        { id: 3, name: 'Trakt watchlist', enabled: true, automatic: true, path: '/data/media/movies' },
      ],
    }),
  ],
  canAddRootFolder: false,
});
const TV = node('/data/media/tv', {
  flags: ['rootFolder'],
  expandable: false,
  // Radarr-HD reports its own root folder as not accessible - a real warning.
  owners: [owner(2, 'rootFolder')],
  severity: 'warn',
  canAddRootFolder: false,
});
/** Holds films, but sits under no root folder. */
const OLD_MOVIES = node('/data/media/old-movies', {
  flags: ['unmanaged'],
  childCount: 814,
  owners: [owner(1, 'ancestor', { mediaUnder: 806 })],
  severity: 'warn',
});
/** Nobody's root folder and nothing tracked under it: safe to prune. */
const SPARE = node('/data/media/spare', {
  flags: [],
  childCount: 0,
  expandable: false,
  severity: 'ok',
});

/** A root folder outside FS_ROOTS - the mapping diagnosis, as a row. */
const UNSEEN = node('/elsewhere/movies', {
  exists: false,
  inScope: false,
  origin: 'arr',
  flags: ['rootFolder', 'unseen'],
  expandable: false,
  owners: [owner(1, 'rootFolder')],
  severity: 'error',
  freeSpace: null,
  totalSpace: null,
  canAddRootFolder: false,
});

/** 814 entries, only the 3 that need attention returned. */
const LIBRARY_LEVEL = level('/data/media/old-movies', [
  node('/data/media/old-movies/Orphan Film (1999)', { flags: ['untracked'], severity: 'info' }),
  node('/data/media/old-movies/Empty Folder', {
    flags: ['untracked', 'empty'],
    childCount: 0,
    expandable: false,
    severity: 'info',
  }),
  node('/data/media/old-movies/Gone (2001)', {
    exists: false,
    origin: 'arr',
    flags: ['missing'],
    expandable: false,
    owners: [owner(1, 'tracked')],
    severity: 'error',
    canAddRootFolder: false,
  }),
], {
  selection: ['problems'],
  rollup: rollup({ entries: 814, tracked: 806, untracked: 4, missing: 2, mediaUnder: 806 }),
  matched: 6,
  truncated: true,
  childCountsResolved: false,
});

let enabled = true;
/** Flipped by the unreachable-instance test; the server would report this in `columns`. */
let unreachableIds: number[] = [];

interface MatrixCall {
  readonly paths?: readonly string[];
  readonly instanceIds?: readonly number[];
  readonly filter?: string;
  readonly filterMode?: PathFilterMode;
}

/** Only the folders the requested instances own - the server scopes the tree, not the client. */
function scopeTo(nodes: PathNode[], instanceIds: readonly number[] | undefined): PathNode[] {
  if (instanceIds === undefined || instanceIds.length === 0) return nodes;
  return nodes.filter((entry) => entry.owners.some((o) => instanceIds.includes(o.instanceId)));
}

const matrixApi = vi.fn((params: MatrixCall = {}) => {
  const requested = params.paths ?? [];
  const scope = params.instanceIds;

  const levels: PathMatrixLevel[] =
    requested.length === 0
      ? [
          level(null, scopeTo([MOUNT, UNSEEN], scope)),
          level('/data', scopeTo([MEDIA], scope)),
          level('/data/media', scopeTo([MOVIES, TV, OLD_MOVIES, SPARE], scope), {
            matched: scope === undefined || scope.length === 0 ? 4 : 2,
          }),
        ]
      : requested.includes('/data/media/old-movies')
        ? [LIBRARY_LEVEL]
        : [level(requested[0] ?? null, [])];

  return Promise.resolve<PathMatrixResponse>({
    enabled,
    scannedAt: '2026-09-01T00:00:00.000Z',
    roots: [
      {
        path: '/data',
        exists: true,
        readable: true,
        writable: true,
        deviceId: '1',
        freeSpace: 2_000_000_000,
        totalSpace: 8_000_000_000,
        error: null,
      },
    ],
    // Always the whole fleet, filter or not: the bar has to keep listing every instance,
    // and this is where "did not answer" is stated.
    columns: ([
      { instanceId: 1, name: 'Radarr-4K', kind: 'radarr', reachable: true, error: null, fetchedAt: null, rootFolderCount: 2, mediaPathCount: 812, unseenRootFolders: ['/elsewhere/movies'] },
      { instanceId: 2, name: 'Radarr-HD', kind: 'radarr', reachable: true, error: null, fetchedAt: null, rootFolderCount: 1, mediaPathCount: 0, unseenRootFolders: [] },
    ] satisfies PathMatrixColumn[]).map(
      (column): PathMatrixColumn =>
        unreachableIds.includes(column.instanceId)
          ? { ...column, reachable: false, error: 'arr_unreachable', unseenRootFolders: [] }
          : column,
    ),
    levels,
    totals: {
      rootFolderPaths: 3,
      unseenRootFolders: 1,
      unmanaged: 0,
      untracked: 4,
      missing: 2,
    },
    mismatches: [],
  });
});

const preflight = vi.fn(() =>
  Promise.resolve({
    op: 'fs.delete' as const,
    ok: true,
    checks: [{ id: 'inside_root', status: 'ok' as const, message: 'inside a root' }],
    measurement: null,
    freeSpace: 1_000_000_000,
    referencedBy: [],
  }),
);

const push = vi.fn((items: readonly NewQueueItem[]) =>
  Promise.resolve({
    items: items.map((entry, index) => ({
      id: index + 1,
      instanceId: entry.instanceId ?? null,
      runId: null,
      dependsOnId: entry.dependsOnId ?? null,
      sortOrder: index + 1,
      status: 'pending' as const,
      op: entry.op,
      payload: entry.payload,
      targetKind: 'rootFolder' as const,
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

vi.mock('@/api/instances', () => ({
  instancesApi: { list: () => Promise.resolve({ instances: INSTANCES }) },
}));

vi.mock('@/api/storage', () => ({
  storageApi: {
    matrix: (params: MatrixCall) => matrixApi(params),
    roots: () => Promise.resolve({ enabled: true, roots: [] }),
    measure: vi.fn(),
    preflight: () => preflight(),
  },
}));

vi.mock('@/api/resources', () => ({
  resourcesApi: {
    snapshot: (instanceId: number) =>
      Promise.resolve({
        instanceId,
        fetchedAt: '2026-09-01T00:00:00.000Z',
        tags: [],
        rootFolders: (ROOT_FOLDERS[instanceId] ?? []).map((folder) => ({
          ...folder,
          freeSpace: 1_000_000_000,
          totalSpace: 4_000_000_000,
        })),
        importLists: [],
        qualityProfiles: [],
      }),
    media: vi.fn(),
    allMediaIdsInRootFolder: (instanceId: number) =>
      Promise.resolve(instanceId === 1 ? [10, 11, 12] : []),
    refresh: vi.fn(),
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

const PathMatrixView = (await import('./PathMatrixView.vue')).default;

async function mountView() {
  const wrapper = mount(PathMatrixView, {
    global: { plugins: [createPinia()], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  for (let tick = 0; tick < 8; tick += 1) await flushPromises();
  return wrapper;
}

const rowFor = (wrapper: Awaited<ReturnType<typeof mountView>>, needle: string) =>
  wrapper.findAll('tbody tr').find((row) => row.text().includes(needle));

/** The one way to create a folder now: the toolbar, whatever the selection is. */
async function openNewFolders(wrapper: Awaited<ReturnType<typeof mountView>>) {
  const open = wrapper.findAll('button').find((button) => button.text().includes('New folder(s)'));
  await open?.trigger('click');
  for (let tick = 0; tick < 4; tick += 1) await flushPromises();
}

/** By path, because rendered names collide: /elsewhere/movies vs /data/media/movies. */
const rowAt = (wrapper: Awaited<ReturnType<typeof mountView>>, path: string) =>
  wrapper.find(`[data-path="${path}"]`);

beforeEach(() => {
  push.mockClear();
  matrixApi.mockClear();
  preflight.mockClear();
  enabled = true;
  unreachableIds = [];
  document.body.innerHTML = '';
});

describe('PathMatrixView', () => {
  it('renders the spine on first load: every mount and every root folder', async () => {
    const wrapper = await mountView();
    const text = wrapper.text();

    expect(text).toContain('data');
    expect(text).toContain('movies');
    expect(text).toContain('tv');
    // One request for the whole spine, not one per level.
    expect(matrixApi).toHaveBeenCalledTimes(1);
  });

  it('flags a folder that holds media nothing roots at', async () => {
    const wrapper = await mountView();
    const row = rowFor(wrapper, 'old-movies');

    expect(row?.text()).toContain('unmanaged');
  });

  it('flags a root folder an instance cannot reach', async () => {
    const wrapper = await mountView();
    // Radarr-HD reports /data/media/tv as inaccessible.
    expect(rowFor(wrapper, 'tv')?.find('[data-icon="warning"]').exists()).toBe(true);
  });

  it('marks a filesystem mount by the colour of the name, not with a badge', async () => {
    const wrapper = await mountView();
    const row = rowAt(wrapper, '/data');

    // Same idea as a root folder: colour the name. A badge would just say "mount"
    // on the one row that already is the filesystem this view is hanging from.
    expect(row.text()).not.toContain('mount');
    expect(row.attributes('data-mount')).toBe('true');
    expect(row.find('[data-name]').classes()).toContain('text-accent');
    expect(row.find('[data-name]').classes()).toContain('font-semibold');
    expect(row.classes()).toContain('bg-raised');
    expect(rowAt(wrapper, '/data/media/movies').attributes('data-mount')).toBeUndefined();
  });

  it('says root folder with the colour of the name, not with a badge', async () => {
    const wrapper = await mountView();
    const row = rowAt(wrapper, '/data/media/movies');

    // The most common state in the table, on every row the view is organised around: a
    // badge there was 79 identical chips saying what the row is about.
    expect(row.find('th').text()).not.toContain('root folder');
    expect(row.find('[data-name]').classes()).toContain('text-sync');
    // A folder that is nobody's root folder keeps the plain name.
    expect(rowAt(wrapper, '/data/media/old-movies').find('[data-name]').classes()).toContain('text-ink');
  });

  it('states what is wrong beside the name, not in a column of its own', async () => {
    const wrapper = await mountView();

    expect(wrapper.findAll('thead th').map((cell) => cell.text())).not.toContain('State');
    expect(wrapper.findAll('thead th').map((cell) => cell.text())).not.toContain('Row actions');
    expect(wrapper.findAll('thead th').map((cell) => cell.text())).not.toContain('Free');

    // Glyph stays by the name; word badges sit after the row actions, still in the path cell.
    const row = rowAt(wrapper, '/data/media/old-movies');
    expect(row.find('th').text()).toContain('unmanaged');
    expect(row.find('th [data-severity="own"]').exists()).toBe(true);
    const pathCell = row.find('th').element;
    const badge = [...pathCell.querySelectorAll('span')].find((el) => el.textContent?.trim() === 'unmanaged');
    const rename = pathCell.querySelector('[data-action="rename"]');
    expect(badge).toBeTruthy();
    expect(rename).toBeTruthy();
    expect(
      Boolean(rename && badge && Boolean(rename.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING)),
    ).toBe(true);
  });

  it('does not offer to expand a root folder', async () => {
    const wrapper = await mountView();
    const twisty = rowAt(wrapper, '/data/media/movies').find('[data-testid="path-twisty"]');

    expect(twisty.exists()).toBe(true);
    expect(twisty.element.tagName).not.toBe('BUTTON');
    expect(twisty.attributes('title')).toContain('not expanded');
  });

  it('drops the twisty and the focus icon in the flat list - there is no tree to walk', async () => {
    const wrapper = await mountView();

    const treeRow = rowAt(wrapper, '/data');
    expect(treeRow.find('[data-testid="path-twisty"]').exists()).toBe(true);
    expect(treeRow.find('[data-testid="path-focus"]').exists()).toBe(true);

    const toggle = wrapper.findAll('button').find((button) => button.text() === 'Flat list');
    await toggle?.trigger('click');
    for (let tick = 0; tick < 8; tick += 1) await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.find('[data-testid="path-twisty"]').exists()).toBe(false);
      expect(row.find('[data-testid="path-focus"]').exists()).toBe(false);
    }
  });

  it('renders a root folder this container cannot see as a row', async () => {
    const wrapper = await mountView();
    const row = rowFor(wrapper, 'elsewhere');

    // The row says it - the fleet-wide totals line above the table is gone, and the
    // badge on the row is where that fact belongs.
    expect(row?.text()).toContain('not mounted here');
  });

  // ------------------------------------------------------------- one chip, not a grid

  it('shows one chip per owning instance, not one cell per instance', async () => {
    const wrapper = await mountView();

    // 7 spine rows and 2 instances used to mean 14 cells, 8 of them empty. Now each row
    // renders only the instances that actually use it.
    expect(wrapper.findAll('[data-owner]').length).toBe(8);

    expect(rowAt(wrapper, '/data/media/movies').findAll('[data-owner]').length).toBe(1);
    expect(rowAt(wrapper, '/data/media/movies').text()).toContain('Radarr-4K');
    expect(rowAt(wrapper, '/data/media/movies').text()).not.toContain('Radarr-HD');

    expect(rowAt(wrapper, '/data/media/tv').text()).toContain('Radarr-HD');
    // Nobody's folder says so once, rather than in a column per instance.
    expect(rowAt(wrapper, '/data/media/spare').findAll('[data-owner]').length).toBe(0);
    expect(rowAt(wrapper, '/data/media/spare').find('td').text()).not.toContain('—');
  });

  it('renders every owner when two instances do root at one folder', async () => {
    // Rare, and not what the layout optimises for, but it must not be misrepresented.
    const shared = node('/data/media/movies', {
      flags: ['rootFolder'],
      expandable: false,
      owners: [owner(1, 'rootFolder', { mediaUnder: 812 }), owner(2, 'rootFolder')],
      canAddRootFolder: false,
    });
    matrixApi.mockImplementationOnce(() =>
      Promise.resolve<PathMatrixResponse>({
        enabled: true,
        scannedAt: '2026-09-01T00:00:00.000Z',
        roots: [],
        columns: [],
        levels: [level(null, [shared])],
        totals: { rootFolderPaths: 1, unseenRootFolders: 0, unmanaged: 0, untracked: 0, missing: 0 },
        mismatches: [],
      }),
    );

    const wrapper = await mountView();
    const chips = rowAt(wrapper, '/data/media/movies').findAll('[data-owner]');

    expect(chips.length).toBe(2);
    expect(chips.every((chip) => chip.attributes('data-owner') === 'rootFolder')).toBe(true);
  });

  it('states free space on the mount, not in a column or a per-instance total', async () => {
    const wrapper = await mountView();

    // The old footer summed each instance's root folders, double-counting one disk when
    // two instances rooted on it. A Free column then repeated the same figure on every
    // child. The mount is the filesystem, so the number sits next to its name.
    expect(wrapper.find('tfoot').exists()).toBe(false);
    expect(wrapper.findAll('thead th').map((cell) => cell.text())).not.toContain('Free');
    expect(wrapper.find('[data-testid="filesystem-space"]').exists()).toBe(false);

    const mount = rowAt(wrapper, '/data');
    expect(mount.find('[data-free-space]').text()).toMatch(/free/);
    expect(rowAt(wrapper, '/data/media').find('[data-free-space]').exists()).toBe(false);
    expect(rowAt(wrapper, '/data/media/movies').find('[data-free-space]').exists()).toBe(false);
  });

  it('keeps a free-space strip when no mount row is in view', async () => {
    matrixApi.mockImplementationOnce(() =>
      Promise.resolve<PathMatrixResponse>({
        enabled: true,
        scannedAt: '2026-09-01T00:00:00.000Z',
        roots: [
          {
            path: '/data',
            exists: true,
            readable: true,
            writable: true,
            deviceId: '1',
            freeSpace: 2_000_000_000,
            totalSpace: 8_000_000_000,
            error: null,
          },
        ],
        columns: [],
        // A focused subtree, or the flat list: the mount itself is not a row.
        levels: [level(null, [MEDIA])],
        totals: { rootFolderPaths: 0, unseenRootFolders: 0, unmanaged: 0, untracked: 0, missing: 0 },
        mismatches: [],
      }),
    );

    const wrapper = await mountView();
    const strip = wrapper.find('[data-testid="filesystem-space"]');

    expect(wrapper.find('[data-path="/data"]').exists()).toBe(false);
    expect(strip.exists()).toBe(true);
    expect(strip.text()).toContain('/data');
    expect(strip.text()).toContain('free');
  });

  it('the add-root-folder action opens the dialog preset to this path', async () => {
    // There is no gap cell to click any more: the folder has no owner to infer an
    // instance from, so the dialog asks.
    const wrapper = await mountView();
    const row = rowAt(wrapper, '/data/media/old-movies');

    const action = row.find('td [data-action="addRoot"]');
    expect(action.exists()).toBe(true);
    expect(row.find('th [data-action="addRoot"]').exists()).toBe(false);
    await action.trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('Add a root folder to the fleet');
    // Editable, so the path is a DOM value rather than rendered text.
    const field = document.body.querySelector('input[type="text"]');
    expect((field as HTMLInputElement | null)?.value).toBe('/data/media/old-movies');
    // Nothing is staged until the dialog says which instances.
    expect(push).not.toHaveBeenCalled();
  });

  it('a chip opens a card stating what that instance does with the folder', async () => {
    const wrapper = await mountView();
    await rowAt(wrapper, '/data/media/movies').find('[data-owner="rootFolder"]').trigger('click');
    await flushPromises();

    const card = document.body.querySelector('[data-testid="owner-card"]');
    expect(card?.textContent).toContain('Radarr-4K');
    expect(card?.textContent).toContain('Used as');
    expect(card?.textContent).toContain('root folder');
    expect(card?.textContent).not.toContain('as this instance sees it');
    // Tracked and on disk are separate facts: the gap is the backlog, not missing media.
    expect(card?.textContent).toContain('812 items at or under here');
    expect(card?.textContent).toContain('806 on disk');
    expect(card?.textContent).toContain('6 monitored, not downloaded');
    expect(card?.textContent).toContain('Trakt watchlist - adds automatically');
  });

  it('the card is where a root folder is unassigned, so the action is named before it runs', async () => {
    const wrapper = await mountView();
    await rowAt(wrapper, '/data/media/movies').find('[data-owner="rootFolder"]').trigger('click');
    await flushPromises();

    const remove = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Unassign root folder',
    );
    expect(remove).toBeDefined();
    remove?.click();
    await flushPromises();

    expect(document.body.textContent).toContain('Radarr-4K');
    expect(document.body.textContent).toContain('/data/media/movies');
    // Still nothing staged until the dialog confirms it.
    expect(push).not.toHaveBeenCalled();
  });

  it('an owner that merely holds media below is explained, never removable', async () => {
    const wrapper = await mountView();
    await rowAt(wrapper, '/data/media/old-movies').find('[data-owner="ancestor"]').trigger('click');
    await flushPromises();

    const card = document.body.querySelector('[data-testid="owner-card"]');
    expect(card?.textContent).toContain('Used for');
    expect(card?.textContent).toContain('media below this folder');
    expect(
      [...document.body.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Unassign root folder',
      ),
    ).toBe(false);
  });

  it('a parent folder names the instances rooted below it, media or not', async () => {
    const wrapper = await mountView();
    const chip = rowAt(wrapper, '/data/media').find('[data-owner="containsRoot"]');

    // The bug this replaced: Radarr-HD tracks nothing under /data/media, so a media-only
    // rule left the folder its root folder lives in looking like nobody's.
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('Radarr-HD');
    // One count, per instance, and a zero rather than a bare chip: the fleet-wide Media
    // column cannot say that this instance tracks nothing here.
    expect(chip.find('[data-metric="media"]').text()).toContain('0');

    await chip.trigger('click');
    await flushPromises();

    const card = document.body.querySelector('[data-testid="owner-card"]');
    expect(card?.textContent).toContain('Used for');
    expect(card?.textContent).toContain('1 root folder below');
    expect(card?.textContent).toContain('nothing tracked here');
    // Named lists only - the folder they fill is that row's, not this parent's.
    expect(card?.textContent).toContain('2 lists');
    expect(card?.textContent).toContain('Series watchlist - adds automatically');
    expect(card?.textContent).toContain('Kids picks - disabled');
    expect(card?.textContent).not.toContain('tv: Series watchlist');
  });

  // ------------------------------------------------------------------ monitoring

  it('marks a folder that needs attention, and stays quiet about one that does not', async () => {
    const wrapper = await mountView();

    expect(rowAt(wrapper, '/data/media/old-movies').find('[data-severity="own"]').exists()).toBe(true);
    expect(
      rowAt(wrapper, '/elsewhere/movies').find('[data-severity="own"] [data-icon="error"]').exists(),
    ).toBe(true);
    // A healthy root folder gets no icon - one on every row would be noise.
    expect(rowAt(wrapper, '/data/media/movies').find('[data-severity="own"]').exists()).toBe(false);
  });

  it('warns on a collapsed folder whose children need attention', async () => {
    const wrapper = await mountView();

    // /data/media is quiet itself, but holds old-movies and spare.
    const media = rowAt(wrapper, '/data/media');
    expect(media.find('[data-severity="own"]').exists()).toBe(false);
    // Expanded here, so the children speak for themselves rather than the parent.
    expect(media.find('[data-severity="child"]').exists()).toBe(false);
  });

  it('reports the media each folder holds, and names a single tracked item', async () => {
    const wrapper = await mountView();
    expect(rowAt(wrapper, '/data/media/movies').text()).toContain('812');
    expect(rowAt(wrapper, '/data/media/old-movies').text()).toContain('806');
  });

  it('flags a filesystem that is low on space, and only where it means something', async () => {
    const low = node('/data', { flags: ['mount'], lowSpace: true, severity: 'warn' });
    const child = node('/data/media', { lowSpace: false });
    matrixApi.mockImplementationOnce(() =>
      Promise.resolve<PathMatrixResponse>({
        enabled: true,
        scannedAt: '2026-09-01T00:00:00.000Z',
        roots: [],
        columns: [],
        levels: [level(null, [low]), level('/data', [child])],
        totals: { rootFolderPaths: 0, unseenRootFolders: 0, unmanaged: 0, untracked: 0, missing: 0 },
        mismatches: [],
      }),
    );

    const wrapper = await mountView();

    expect(rowAt(wrapper, '/data').find('[data-low-space]').exists()).toBe(true);
    // Every row under it shares the same filesystem; flagging them all says nothing.
    expect(rowAt(wrapper, '/data/media').find('[data-low-space]').exists()).toBe(false);
  });

  // ------------------------------------------ unknown is never "nobody uses this"

  it('says once when an instance did not answer, instead of a cell per row', async () => {
    unreachableIds = [2];
    const wrapper = await mountView();

    const notice = wrapper.find('[data-testid="unknown-instances"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Radarr-HD');
    expect(notice.text()).toContain('deliberately not "nobody"');

    // An ownerless row carries the same caveat, so it cannot read as a gap...
    expect(rowAt(wrapper, '/data/media/spare').find('[data-icon="unknown"]').exists()).toBe(true);
    // ...but a row that already has an owner does not repeat it.
    expect(rowAt(wrapper, '/data/media/movies').find('[data-icon="unknown"]').exists()).toBe(false);
  });

  it('says nothing about unknowns when the whole fleet answered', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('[data-testid="unknown-instances"]').exists()).toBe(false);
    expect(rowAt(wrapper, '/data/media/spare').find('[data-icon="unknown"]').exists()).toBe(false);
  });

  // ------------------------------------------------------- the folder filter

  async function type(wrapper: Awaited<ReturnType<typeof mountView>>, value: string) {
    const input = wrapper.find('[data-testid="path-filter-input"]');
    await input.setValue(value);
    await input.trigger('change');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();
  }

  it('expands braces and asks for every pattern in one request', async () => {
    const wrapper = await mountView();
    matrixApi.mockClear();

    await type(wrapper, 'media/{movies,tv}');

    expect(matrixApi.mock.calls[0]?.[0]?.filter).toBe('media/{movies,tv}');
    expect(matrixApi.mock.calls[0]?.[0]?.filterMode).toBe('include');
  });

  it('the exclude toggle re-asks with the same patterns', async () => {
    const wrapper = await mountView();
    await type(wrapper, 'media/{movies,tv}');
    matrixApi.mockClear();

    await wrapper.find('[data-testid="path-filter-mode"] [data-mode="exclude"]').trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(matrixApi.mock.calls[0]?.[0]?.filterMode).toBe('exclude');
    expect(matrixApi.mock.calls[0]?.[0]?.filter).toBe('media/{movies,tv}');
  });

  it('a filter it cannot read is explained, and never asked for', async () => {
    const wrapper = await mountView();
    matrixApi.mockClear();

    await type(wrapper, 'media/{movies,tv');

    expect(matrixApi).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="path-filter-error"]').text()).toContain('unclosed');
  });

  it('dims the folders kept only as a way down to a match', async () => {
    const wrapper = await mountView();
    await type(wrapper, 'media/movies');

    // `/data/media` is not a match - it is how the tree reaches one.
    expect(rowAt(wrapper, '/data/media').find('[data-name]').classes()).toContain('opacity-45');
    expect(rowAt(wrapper, '/data/media/movies').find('[data-name]').classes()).not.toContain(
      'opacity-45',
    );
  });

  // ------------------------------------------------ the fleet bar as a filter

  it('the fleet bar filters the tree rather than picking action targets', async () => {
    const wrapper = await mountView();
    matrixApi.mockClear();

    const chip = wrapper
      .findAll('section button')
      .find((button) => button.text().includes('Radarr-4K'));
    await chip?.trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(matrixApi.mock.calls[0]?.[0]?.instanceIds).toEqual([1]);
    expect(wrapper.text()).toContain('showing 1 of 2');
    // Radarr-HD's root folder leaves the tree; Radarr-4K's stays.
    expect(rowAt(wrapper, '/data/media/movies').exists()).toBe(true);
    expect(rowAt(wrapper, '/data/media/tv').exists()).toBe(false);
  });

  it('the batch buttons hand the instance choice to a dialog', async () => {
    const wrapper = await mountView();

    await rowAt(wrapper, '/data/media/spare').find('input[type="checkbox"]').trigger('change');
    await flushPromises();

    const add = wrapper
      .findAll('button')
      .find((button) => /^\s*Assign\s*\(\d+\)\s*$/.test(button.text()));
    expect(add?.text()).toContain('(1)');
    await add?.trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('Add a root folder to the fleet');
    expect(document.body.textContent).toContain('/data/media/spare');
    expect(push).not.toHaveBeenCalled();
  });

  // ------------------------------------------------- the whole point of the merge

  it('never turns a folder still full of films into 814 rows', async () => {
    const wrapper = await mountView();

    const twisty = rowAt(wrapper, '/data/media/old-movies').findAll('button')[0];
    await twisty?.trigger('click');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    expect(rows.length).toBeLessThan(15);

    // Only the folders that need attention became rows.
    expect(wrapper.text()).toContain('Orphan Film (1999)');
    expect(wrapper.text()).toContain('Gone (2001)');

    // And nothing sums up what was left out: the table is folders, and only folders.
    expect(wrapper.text()).not.toContain('of 814 folders here');
  });

  it('badges what is tracked, untracked and missing inside that folder', async () => {
    const wrapper = await mountView();
    const twisty = rowAt(wrapper, '/data/media/old-movies').findAll('button')[0];
    await twisty?.trigger('click');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    expect(rowFor(wrapper, 'Orphan Film (1999)')?.text()).toContain('untracked');
    expect(rowFor(wrapper, 'Empty Folder')?.text()).toContain('empty');
    expect(rowFor(wrapper, 'Gone (2001)')?.text()).toContain('missing');
  });

  // --------------------------------------------------------------- disk actions

  // One rename button, not a rename *and* an align: the folder's own root-folder owners
  // decide which of the two it is, and the label says which before it is clicked.
  it('offers add root folder on a leaf, in Used by, and never on a parent', async () => {
    const wrapper = await mountView();

    expect(rowAt(wrapper, '/data').find('[data-action="addRoot"]').exists()).toBe(false);
    expect(rowAt(wrapper, '/data/media').find('[data-action="addRoot"]').exists()).toBe(false);
    expect(rowAt(wrapper, '/data/media/old-movies').find('td [data-action="addRoot"]').exists()).toBe(
      true,
    );
    expect(rowAt(wrapper, '/data/media/movies').find('[data-action="addRoot"]').exists()).toBe(false);
  });

  it('names the rename after what it carries, and never offers a re-map on a plain folder', async () => {
    const wrapper = await mountView();

    const movies = rowAt(wrapper, '/data/media/movies');
    expect(movies.find('[data-action="rename"]').exists()).toBe(true);
    expect(movies.find('[data-action="rename"]').attributes('title')).toBe('rename & align');
    expect(movies.find('[data-action="remap"]').exists()).toBe(true);
    expect(movies.find('th [data-action="rename"]').exists()).toBe(true);

    const leftover = rowFor(wrapper, 'old-movies');
    expect(leftover?.find('[data-action="rename"]').attributes('title')).toBe('rename');
    expect(leftover?.find('[data-action="remap"]').exists()).toBe(false);

    // A parent of root folders is the other rename that must carry instances - renaming
    // it on disk alone is how nested registrations become unavailable.
    expect(rowAt(wrapper, '/data/media').find('[data-action="rename"]').attributes('title')).toBe(
      'rename & align',
    );
  });

  it('never offers a disk action on a mount', async () => {
    const wrapper = await mountView();
    const row = rowAt(wrapper, '/data');

    expect(row.find('[data-action="prune"]').exists()).toBe(false);
    expect(row.find('[data-action="move"]').exists()).toBe(false);
    expect(row.find('[data-action="rename"]').exists()).toBe(false);
  });

  it('creates folders from one toolbar button, never from a row', async () => {
    const wrapper = await mountView();

    expect(wrapper.find('tbody').text()).not.toContain('new folder');
    expect(wrapper.text()).toContain('New folder(s)');
  });

  it('a selected folder only chooses where the new-folder box starts', async () => {
    const wrapper = await mountView();
    await rowAt(wrapper, '/data/media/movies').find('input[type="checkbox"]').setValue(true);
    await openNewFolders(wrapper);

    const parent = document.body.querySelector<HTMLInputElement>(
      '[data-testid="new-folders-parent"]',
    );
    expect(parent?.value).toBe('/data/media/movies');
    wrapper.unmount();
  });

  it('the create-in picker offers the folders this view has read, and narrows as you type', async () => {
    const wrapper = await mountView();
    await openNewFolders(wrapper);

    // Closed until asked for: the field is pre-filled, and a list under a filled field was
    // exactly what the old datalist got wrong.
    expect(document.body.querySelector('[data-select-list]')).toBeNull();

    document.body
      .querySelector('[data-select-toggle]')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    for (let tick = 0; tick < 2; tick += 1) await flushPromises();

    const list = () => document.body.querySelector('[data-select-list]');
    expect(list()?.textContent).toContain('/data/media/movies');
    expect(list()?.textContent).toContain('/data/media/old-movies');

    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid="new-folders-parent"]',
    );
    if (input) {
      input.value = 'old';
      input.dispatchEvent(new Event('input'));
    }
    for (let tick = 0; tick < 2; tick += 1) await flushPromises();

    expect(list()?.textContent).toContain('/data/media/old-movies');
    expect(list()?.textContent).not.toContain('/data/media/tv');

    // Picking one fills the field and closes the list.
    list()?.querySelector('li')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    for (let tick = 0; tick < 2; tick += 1) await flushPromises();

    expect(input?.value).toBe('/data/media/old-movies');
    expect(list()).toBeNull();
    wrapper.unmount();
  });

  it('opens ready to create the path only *Arr believes in, and stages exactly it', async () => {
    const wrapper = await mountView();
    const twisty = rowAt(wrapper, '/data/media/old-movies').findAll('button')[0];
    await twisty?.trigger('click');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    await rowFor(wrapper, 'Gone (2001)')?.find('input[type="checkbox"]').setValue(true);
    await openNewFolders(wrapper);

    const parent = document.body.querySelector<HTMLInputElement>(
      '[data-testid="new-folders-parent"]',
    );
    const source = document.body.querySelector<HTMLInputElement>(
      '[data-testid="new-folders-input"]',
    );
    expect(parent?.value).toBe('/data/media/old-movies');
    // Escaped, because a space is a folder separator in this box - and it stages as one.
    expect(source?.value).toBe(String.raw`Gone\ (2001)`);

    const stage = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('mkdir'),
    );
    stage?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]).toEqual([
      {
        op: 'fs.mkdir',
        payload: { path: '/data/media/old-movies/Gone (2001)', recursive: true },
      },
    ]);
    wrapper.unmount();
  });

  it('pruning requires typing the folder name, then stages one fs.delete', async () => {
    const wrapper = await mountView();
    const prune = rowAt(wrapper, '/data/media/spare').find('[data-action="prune"]');
    expect(prune.attributes('title')).toBe('remove');
    await prune.trigger('click');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    const confirm = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stage'),
    );
    expect(confirm?.hasAttribute('disabled')).toBe(true);

    const input = document.body.querySelector<HTMLInputElement>('input[type="text"]');
    if (input) {
      input.value = 'spare';
      input.dispatchEvent(new Event('input'));
    }
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    const armed = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stage'),
    );
    armed?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.delete', payload: { path: '/data/media/spare', recursive: false, force: false } },
    ]);
    wrapper.unmount();
  });

  it('warns before relocating a folder an instance still tracks', async () => {
    const wrapper = await mountView();
    const rename = rowAt(wrapper, '/data/media/old-movies').find('[data-action="rename"]');
    await rename?.trigger('click');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    expect(document.body.textContent).toContain('Radarr-4K has 806 item(s)');
    // Nobody roots here, so there is nothing to carry the rename - and the dialog says so
    // rather than pointing at a second button that no longer exists.
    expect(document.body.querySelector('[data-testid="align-targets"]')).toBeNull();
    wrapper.unmount();
  });

  it('a root folder rename opens with its owning instances ready to follow it', async () => {
    const wrapper = await mountView();
    const rename = rowAt(wrapper, '/data/media/movies').find('[data-action="rename"]');
    await rename?.trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    const targets = document.body.querySelector('[data-testid="align-targets"]');
    expect(targets?.textContent).toContain('Radarr-4K');
    expect(targets?.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    wrapper.unmount();
  });

  it('a parent of root folders opens the same align dialog for the folders under it', async () => {
    const wrapper = await mountView();
    const rename = rowAt(wrapper, '/data/media').find('[data-action="rename"]');
    await rename?.trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    const targets = document.body.querySelector('[data-testid="align-targets"]');
    expect(targets?.textContent).toContain('Radarr-HD');
    expect(targets?.textContent).toContain('/data/media/tv');
    wrapper.unmount();
  });

  // ------------------------------------------------------------------- selection

  /**
   * A folder the tree renders children under is a place to look, not a thing to act on -
   * every batch action the toolbar offers is about the folder itself. The spine arrives
   * with /data and /data/media already open, so they are the two known parents; everything
   * below them is a leaf until a level says otherwise.
   */
  it('offers a checkbox on leaf folders only', async () => {
    const wrapper = await mountView();

    expect(rowAt(wrapper, '/data').find('input[type="checkbox"]').exists()).toBe(false);
    expect(rowAt(wrapper, '/data/media').find('input[type="checkbox"]').exists()).toBe(false);

    for (const path of ['/data/media/movies', '/data/media/tv', '/data/media/spare', '/elsewhere/movies']) {
      expect(rowAt(wrapper, path).find('input[type="checkbox"]').exists()).toBe(true);
    }
  });

  /**
   * The checkbox is a column of its own. Nesting used to pad the whole row, so a
   * depth-2 leaf's box sat under its parent's name rather than under the header box.
   */
  it('pins the checkbox to the left of the row and indents only the tree', async () => {
    const wrapper = await mountView();

    const root = rowAt(wrapper, '/data');
    const leaf = rowAt(wrapper, '/data/media/movies');

    expect(root.find('[data-testid="path-tree"]').attributes('style') ?? '').not.toContain(
      'padding-left',
    );
    expect(leaf.find('[data-testid="path-tree"]').attributes('style')).toContain('padding-left: 2rem');
    expect(leaf.find('[data-testid="path-tree"] input[type="checkbox"]').exists()).toBe(false);
    expect(leaf.find('th input[type="checkbox"]').exists()).toBe(true);
  });

  it('selects exactly the rows in the table, and clears everything', async () => {
    const wrapper = await mountView();

    const selectable = wrapper.findAll('tbody input[type="checkbox"]');
    expect(selectable).toHaveLength(5);

    await wrapper.find('[data-testid="select-all"]').trigger('change');
    await flushPromises();
    expect(wrapper.text()).toContain('5 row(s) selected');

    // Deselect-all is the same checkbox, not a second control.
    await wrapper.find('[data-testid="select-all"]').trigger('change');
    await flushPromises();
    expect(wrapper.find('[data-testid="clear-selection"]').exists()).toBe(false);

    await wrapper.find('[data-testid="select-all"]').trigger('change');
    await flushPromises();
    await wrapper.find('[data-testid="clear-selection"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="clear-selection"]').exists()).toBe(false);
  });

  it('offers a bulk delete for only the selected folders that can take one', async () => {
    const wrapper = await mountView();

    const button = wrapper.find('[data-testid="bulk-delete-open"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Delete (0)');

    await wrapper.find('[data-testid="select-all"]').trigger('change');
    await flushPromises();

    // Five rows selected. /data/media/movies and /data/media/old-movies hold libraries, but
    // holding one is a cost the delete dialog states and offers to bridge, not a reason to
    // hide the button - so four are deletable. /elsewhere/movies is not mounted here, which
    // is not a cost but an impossibility, and stays out.
    expect(wrapper.text()).toContain('5 row(s) selected');
    expect(wrapper.find('[data-testid="bulk-delete-open"]').text()).toContain('Delete (4)');
    expect(wrapper.find('[data-testid="prunable-count"]').text()).toContain(
      '4 of them can be deleted',
    );
    expect(wrapper.find('[data-testid="bulk-delete-open"]').attributes('disabled')).toBeUndefined();
  });

  /** "All" is what is in view - so narrowing the tree narrows what the header takes. */
  it('takes only the filtered rows once the fleet bar narrows the tree', async () => {
    const wrapper = await mountView();

    const chip = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Radarr-4K'));
    await chip?.trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    await wrapper.find('[data-testid="select-all"]').trigger('change');
    await flushPromises();

    // /data and /data/media are parents; movies, old-movies and /elsewhere/movies are not.
    expect(wrapper.text()).toContain('3 row(s) selected');
  });

  /**
   * Expanding a folder is the moment the tree learns it is a parent. Its checkbox goes,
   * and so does its place in the selection - a selected row with no checkbox would be a
   * count nobody could undo.
   */
  it('drops a selected folder that turns out to have subfolders', async () => {
    const wrapper = await mountView();

    await rowAt(wrapper, '/data/media/old-movies').find('input[type="checkbox"]').trigger('change');
    await flushPromises();
    expect(wrapper.text()).toContain('1 row(s) selected');

    const twisty = rowAt(wrapper, '/data/media/old-movies').findAll('button')[0];
    await twisty?.trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(rowAt(wrapper, '/data/media/old-movies').find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="clear-selection"]').exists()).toBe(false);
  });

  // ---------------------------------------------------------------- teaching state

  it('explains exactly what to configure when the filesystem is off', async () => {
    enabled = false;
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Filesystem access is off');
    expect(wrapper.text()).toContain('FS_ROOTS: /data');
  });
});
