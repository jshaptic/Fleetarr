import type { ArrImportList, Instance, NewQueueItem, QueueItem } from '@fleetarr/shared';
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
    lastConnectedAt: '2026-09-01T00:00:00.000Z',
    lastError: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const INSTANCES = [instance(1, 'Radarr-4K'), instance(2, 'Radarr-HD'), instance(3, 'Sonarr-Anime', 'sonarr')];

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

const SNAPSHOTS: Record<number, ArrImportList[]> = {
  1: [
    importList(1, 'Trakt watchlist', { rootFolderPath: '/data/media/movies-4k', enableAuto: true }),
    importList(2, 'Popular'),
    importList(3, 'Shared'),
  ],
  2: [
    importList(4, 'Trakt watchlist', { enabled: false, rootFolderPath: '/data/media/movies' }),
    importList(5, 'Shared'),
  ],
  3: [importList(8, 'Shared')],
};

const staged: QueueItem[] = [];
const failingIds = new Set<number>();

const push = vi.fn((items: readonly NewQueueItem[]) => {
  for (const [index, entry] of items.entries()) {
    staged.push({
      id: staged.length + 1,
      instanceId: entry.instanceId,
      runId: null,
      dependsOnId: null,
      sortOrder: staged.length + 1 + index,
      status: 'pending',
      op: entry.op,
      payload: entry.payload,
      targetKind: 'importList',
      targetId: 'importListId' in entry.payload ? String(entry.payload.importListId) : null,
      targetLabel: 'name' in entry.payload ? String(entry.payload.name) : '',
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
        tags: [],
        rootFolders:
          instanceId === 1
            ? [{ id: 1, path: '/data/media/movies', accessible: true, freeSpace: 1, totalSpace: 2 }]
            : [],
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

async function mountView() {
  const wrapper = mount(ImportListFleetView, {
    global: {
      plugins: [createPinia()],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
  for (let tick = 0; tick < 8; tick += 1) await flushPromises();
  return wrapper;
}

const rowFor = (wrapper: Awaited<ReturnType<typeof mountView>>, name: string) =>
  wrapper.findAll('tbody tr').find((row) => row.find('[data-name]').text() === name);

beforeEach(() => {
  staged.length = 0;
  failingIds.clear();
  push.mockClear();
  document.body.innerHTML = '';
});

describe('ImportListFleetView', () => {
  it('renders lists as rows and instances as chips, not as columns', async () => {
    const wrapper = await mountView();

    const headers = wrapper.findAll('thead th');
    expect(headers.map((header) => header.text().replace(/\s+/g, ' ').trim())).toEqual([
      'Import list (3)',
      'Instances',
    ]);
    expect(wrapper.findAll('thead th').length).toBe(2);

    const names = wrapper.findAll('[data-name]').map((node) => node.text());
    expect(names).toEqual(['Popular', 'Shared', 'Trakt watchlist']);
  });

  it('chips only the instances that have the list, with no missing or drift copy', async () => {
    const wrapper = await mountView();

    const trakt = rowFor(wrapper, 'Trakt watchlist');
    const popular = rowFor(wrapper, 'Popular');

    expect(trakt?.findAll('[data-owner]').map((chip) => chip.text())).toEqual([
      expect.stringContaining('Radarr-4K'),
      expect.stringContaining('Radarr-HD'),
    ]);
    expect(trakt?.text()).not.toContain('missing on');
    expect(trakt?.text()).not.toContain('path drift');
    expect(trakt?.text()).not.toContain('state drift');
    expect(wrapper.text()).not.toContain('Drift only');
    expect(wrapper.text()).not.toContain('Align root folder');

    expect(popular?.findAll('[data-owner="enabled"]')).toHaveLength(1);
    expect(popular?.find('[data-action="addList"]').exists()).toBe(true);
    expect(trakt?.find('[data-action="addList"]').exists()).toBe(false);
    expect(rowFor(wrapper, 'Shared')?.find('[data-action="addList"]').exists()).toBe(false);
  });

  it('puts on/off on the chip and the rest on the card', async () => {
    const wrapper = await mountView();
    const trakt = rowFor(wrapper, 'Trakt watchlist');

    expect(trakt?.find('[data-owner="enabled"]').find('[data-metric="state"]').text()).toContain('on');
    expect(trakt?.find('[data-owner="disabled"]').find('[data-metric="state"]').text()).toContain(
      'off',
    );

    await trakt?.find('[data-owner="enabled"]').trigger('click');
    await flushPromises();

    const card = document.body.querySelector('[data-testid="owner-card"]');
    expect(card?.textContent).toContain('Radarr-4K');
    expect(card?.textContent).toContain('/data/media/movies-4k');
    expect(card?.textContent).toContain('automatic add on');
    expect(card?.textContent).toContain('HD-1080p');
    expect(card?.textContent).not.toContain('id 1');
    expect(card?.textContent).not.toContain('disagrees');
  });

  it('stages enable/disable for selected rows on targeted instances', async () => {
    const wrapper = await mountView();

    await wrapper.find('thead input[type="checkbox"]').setValue(true);
    await flushPromises();

    const enable = wrapper.findAll('button').find((button) => button.text().startsWith('Enable'));
    expect(enable?.text()).toContain('(6)');

    await enable?.trigger('click');
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    const batch = push.mock.calls[0]?.[0] ?? [];
    expect(batch).toHaveLength(6);
    expect(batch.every((entry) => entry.op === 'importList.setEnabled')).toBe(true);
    expect(new Set(batch.map((entry) => entry.instanceId))).toEqual(new Set([1, 2, 3]));
  });

  it('the card is where one instance is enabled or disabled', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Trakt watchlist')?.find('[data-owner="disabled"]').trigger('click');
    await flushPromises();

    const enable = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Enable',
    );
    expect(enable).toBeDefined();
    enable?.click();
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual([
      {
        instanceId: 2,
        op: 'importList.setEnabled',
        payload: { importListId: 4, enabled: true, enableAutomaticAdd: true },
      },
    ]);
  });

  it('the + copies the list onto a same-kind instance that does not have it', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Popular')?.find('[data-action="addList"]').trigger('click');
    await flushPromises();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Popular');
    expect(dialog?.textContent).toContain('Radarr-HD');
    expect(dialog?.textContent).toContain('already present');
    expect(dialog?.textContent).not.toContain('Sonarr-Anime');

    const selectAll = [...dialog!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('select all'),
    );
    selectAll?.click();
    await flushPromises();

    const confirm = [...dialog!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stage'),
    );
    confirm?.click();
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual([
      {
        instanceId: 2,
        op: 'importList.create',
        payload: { name: 'Popular', sourceInstanceId: 1, sourceImportListId: 2 },
      },
    ]);
  });

  it('states unreachable instances once above the table, never as a missing chip', async () => {
    failingIds.add(3);
    const wrapper = await mountView();

    const notice = wrapper.find('[data-testid="unknown-instances"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Sonarr-Anime');
    expect(notice.text()).toContain('Unknown, deliberately not "missing"');

    const trakt = rowFor(wrapper, 'Trakt watchlist');
    expect(trakt?.text()).not.toContain('missing on Sonarr-Anime');
    expect(trakt?.findAll('[data-owner]')).toHaveLength(2);
  });
});
