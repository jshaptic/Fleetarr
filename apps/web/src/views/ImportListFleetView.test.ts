import type { ArrImportList, ArrTagDetail, Instance, NewQueueItem, QueueItem } from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
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
    lastConnectedAt: '2026-09-01T00:00:00.000Z',
    lastError: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const INSTANCES = [instance(1, 'Radarr-4K'), instance(2, 'Radarr-HD'), instance(3, 'Sonarr-Anime', 'sonarr')];

/** Radarr's shape: an Enabled switch, spelled `enabled`, plus `enableAuto`. */
function importList(id: number, name: string, overrides: Partial<ArrImportList> = {}): ArrImportList {
  return {
    id,
    name,
    implementation: 'TraktListImport',
    implementationName: 'Trakt List',
    configContract: 'TraktListSettings',
    enabled: true,
    rootFolderPath: '/data/media/movies',
    qualityProfileId: 1,
    tags: [],
    fields: [],
    ...overrides,
  };
}

/** Sonarr's shape: the `enabled` key does not exist there at all. */
function sonarrList(id: number, name: string, overrides: Partial<ArrImportList> = {}): ArrImportList {
  const { enabled: _absent, ...list } = importList(id, name, overrides);
  return list;
}

const TAGS: Record<number, ArrTagDetail[]> = {
  1: [
    {
      id: 1,
      label: 'kids',
      indexerIds: [],
      importListIds: [],
      notificationIds: [],
      restrictionIds: [],
      delayProfileIds: [],
    },
  ],
};

const SNAPSHOTS: Record<number, ArrImportList[]> = {
  1: [
    importList(1, 'Trakt watchlist', {
      rootFolderPath: '/data/media/movies-4k',
      enableAuto: true,
      tags: [1, 7],
    }),
    importList(2, 'Popular', { rootFolderPath: '', qualityProfileId: 9 }),
  ],
  2: [importList(4, 'Trakt watchlist', { enabled: false }), importList(5, 'Shared')],
  3: [sonarrList(8, 'Shared', { enableAutomaticAdd: true, rootFolderPath: '/data/media/tv' })],
};

const staged: QueueItem[] = [];
const failingIds = new Set<number>();

function stage(entry: NewQueueItem): void {
  staged.push({
    id: staged.length + 1,
    instanceId: entry.instanceId,
    runId: null,
    dependsOnId: null,
    sortOrder: staged.length + 1,
    status: 'pending',
    op: entry.op,
    payload: entry.payload,
    targetKind: 'importList',
    targetId: 'importListId' in entry.payload ? String(entry.payload.importListId) : null,
    targetLabel: '',
    summary: `staged ${entry.op}`,
    affectedCount: 1,
    attempts: 0,
    error: null,
    result: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  } as QueueItem);
}

const push = vi.fn((items: readonly NewQueueItem[]) => {
  for (const entry of items) stage(entry);
  return Promise.resolve({ items: [...staged] });
});

vi.mock('@/api/instances', () => ({
  instancesApi: {
    list: () => Promise.resolve({ instances: INSTANCES }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    testCandidate: vi.fn(),
  },
}));

vi.mock('@/api/resources', () => ({
  resourcesApi: {
    snapshot: (instanceId: number) => {
      if (failingIds.has(instanceId)) return Promise.reject(new Error('unreachable'));
      return Promise.resolve({
        instanceId,
        fetchedAt: '2026-09-01T00:00:00.000Z',
        tags: TAGS[instanceId] ?? [],
        rootFolders: [],
        importLists: SNAPSHOTS[instanceId] ?? [],
        qualityProfiles: [{ id: 1, name: 'HD-1080p' }],
        collections: [],
      });
    },
    media: vi.fn(),
    allMediaIdsInRootFolder: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('@/api/queue', () => ({
  queueApi: {
    list: () => Promise.resolve({ items: [...staged], activeRun: null }),
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

const ImportListFleetView = (await import('./ImportListFleetView.vue')).default;
const { useQueueStore } = await import('@/stores/queue');

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(ImportListFleetView, {
    global: { plugins: [pinia], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  for (let tick = 0; tick < 8; tick += 1) await flushPromises();
  return wrapper;
}

type View = Awaited<ReturnType<typeof mountView>>;

/** A row is a (list, instance) pair now, so a name alone no longer identifies one. */
const rowFor = (wrapper: View, name: string, instanceName: string) =>
  wrapper
    .findAll('tbody tr')
    .find(
      (row) =>
        row.find('[data-name]').text() === name &&
        row.find('[data-instance]').text().includes(instanceName),
    );

const pairs = (wrapper: View) =>
  wrapper
    .findAll('tbody tr')
    .map((row) => `${row.find('[data-name]').text()}@${row.find('[data-instance]').text()}`);

beforeEach(() => {
  staged.length = 0;
  failingIds.clear();
  push.mockClear();
  document.body.innerHTML = '';
});

describe('ImportListFleetView', () => {
  it('gives every (list, instance) pair its own row, sorted by list then instance', async () => {
    const wrapper = await mountView();

    expect(wrapper.findAll('thead th').map((header) => header.text().replace(/\s+/g, ' ').trim()))
      .toEqual([
        'Import list (5)',
        'Instance',
        'Enabled',
        'Auto add',
        'Root folder',
        'Profile',
        'Tags',
      ]);

    expect(pairs(wrapper)).toEqual([
      'Popular@Radarr-4K',
      'Shared@Radarr-HD',
      'Shared@Sonarr-Anime',
      'Trakt watchlist@Radarr-4K',
      'Trakt watchlist@Radarr-HD',
    ]);
  });

  it('answers Enabled per app: on/off for Radarr, and no such switch for Sonarr', async () => {
    const wrapper = await mountView();

    expect(rowFor(wrapper, 'Trakt watchlist', 'Radarr-4K')?.find('[data-enabled]').text()).toBe('on');
    expect(rowFor(wrapper, 'Trakt watchlist', 'Radarr-HD')?.find('[data-enabled]').text()).toBe('off');

    const sonarr = rowFor(wrapper, 'Shared', 'Sonarr-Anime');
    expect(sonarr?.find('[data-enabled]').text()).toBe('n/a');
    expect(sonarr?.find('[data-enabled] span').attributes('title')).toContain('no Enabled switch');
    // Auto add is the switch Sonarr does have, and it is read separately.
    expect(sonarr?.find('[data-auto-add]').text()).toBe('on');
    expect(rowFor(wrapper, 'Shared', 'Radarr-HD')?.find('[data-auto-add]').text()).toBe('off');
  });

  it('carries the root folder, profile and tags of that one instance', async () => {
    const wrapper = await mountView();

    const trakt = rowFor(wrapper, 'Trakt watchlist', 'Radarr-4K');
    expect(trakt?.find('[data-root-folder]').text()).toBe('/data/media/movies-4k');
    expect(trakt?.find('[data-profile]').text()).toBe('HD-1080p');
    expect(trakt?.findAll('[data-tag]').map((chip) => chip.text())).toEqual(['kids', '#7']);

    // The three known absences, each said plainly rather than left blank.
    const popular = rowFor(wrapper, 'Popular', 'Radarr-4K');
    expect(popular?.find('[data-root-folder]').text()).toBe('none set');
    expect(popular?.find('[data-profile]').text()).toBe('id 9');
    expect(popular?.find('[data-tag="none"]').exists()).toBe(true);
  });

  it('offers no way to change a list from here', async () => {
    const wrapper = await mountView();

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="addList"]').exists()).toBe(false);
    const labels = wrapper.findAll('button').map((button) => button.text());
    expect(labels).not.toContain('Enable');
    expect(labels).not.toContain('Disable');
  });

  it('shows work staged against a list from elsewhere', async () => {
    stage({
      instanceId: 2,
      op: 'importList.update',
      payload: { importListId: 4, changes: { rootFolderPath: '/mnt/movies' } },
    });
    const wrapper = await mountView();
    await useQueueStore().load();
    await flushPromises();

    expect(rowFor(wrapper, 'Trakt watchlist', 'Radarr-HD')?.find('[data-testid="row-staged"]').exists())
      .toBe(true);
    expect(rowFor(wrapper, 'Trakt watchlist', 'Radarr-4K')?.find('[data-testid="row-staged"]').exists())
      .toBe(false);
  });

  it('filters rows by the fleet bar, and treats no selection as the whole fleet', async () => {
    const wrapper = await mountView();

    const chip = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Sonarr-Anime'));
    await chip?.trigger('click');
    await flushPromises();

    expect(pairs(wrapper)).toEqual(['Shared@Sonarr-Anime']);

    await chip?.trigger('click');
    await flushPromises();
    expect(pairs(wrapper)).toHaveLength(5);
  });

  it('states unreachable instances once above the table, and gives them no rows', async () => {
    failingIds.add(3);
    const wrapper = await mountView();

    const notice = wrapper.find('[data-testid="unknown-instances"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Sonarr-Anime');
    expect(notice.text()).toContain('Unknown, deliberately not "no lists"');

    expect(pairs(wrapper).some((pair) => pair.includes('Sonarr-Anime'))).toBe(false);
  });
});
