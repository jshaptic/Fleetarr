import type { Instance, NewQueueItem, QueueItem } from '@fleetarr/shared';
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

const INSTANCES = [
  instance(1, 'Radarr-4K'),
  instance(2, 'Radarr-HD'),
  instance(3, 'Sonarr-Anime', 'sonarr'),
];

function tagDetail(id: number, label: string, movieIds: number[] = []) {
  return {
    id,
    label,
    movieIds,
    indexerIds: [],
    importListIds: [],
    notificationIds: [],
    restrictionIds: [],
    delayProfileIds: [],
  };
}

/** Radarr-4K has both tags, Radarr-HD only "hd", Sonarr-Anime only "anime". */
const SNAPSHOTS: Record<number, { tags: ReturnType<typeof tagDetail>[] }> = {
  1: { tags: [tagDetail(1, 'hd', [10, 11]), tagDetail(2, '4k-remux', [10])] },
  2: { tags: [tagDetail(7, 'hd', [20])] },
  3: { tags: [tagDetail(4, 'anime', [30])] },
};

const staged: QueueItem[] = [];
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
      targetKind: 'tag',
      targetId: null,
      targetLabel: 'label' in entry.payload ? String(entry.payload.label) : '',
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
    snapshot: (instanceId: number) =>
      Promise.resolve({
        instanceId,
        fetchedAt: '2026-09-01T00:00:00.000Z',
        tags: SNAPSHOTS[instanceId]?.tags ?? [],
        rootFolders: [],
        importLists: [],
        qualityProfiles: [],
        collections: [],
      }),
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

const TagMatrixView = (await import('./TagMatrixView.vue')).default;

async function mountView() {
  const wrapper = mount(TagMatrixView, {
    global: {
      plugins: [createPinia()],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
  // instances -> snapshots -> queue all resolve across a few microtask turns
  for (let tick = 0; tick < 6; tick += 1) await flushPromises();
  return wrapper;
}

beforeEach(() => {
  staged.length = 0;
  push.mockClear();
});

describe('TagMatrixView', () => {
  it('renders one column per instance and one row per unique tag', async () => {
    const wrapper = await mountView();

    const headers = wrapper.findAll('thead th');
    // tag label column + 3 instances
    expect(headers).toHaveLength(4);
    expect(wrapper.text()).toContain('Radarr-4K');
    expect(wrapper.text()).toContain('Sonarr-Anime');

    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.find('th [data-name]').text())).toEqual(['4k-remux', 'anime', 'hd']);
  });

  it('shows media counts where a tag exists and a gap where it does not', async () => {
    const wrapper = await mountView();
    const hdRow = wrapper.findAll('tbody tr')[2];
    const cells = hdRow?.findAll('[data-cell="tag"]') ?? [];

    expect(cells).toHaveLength(3);
    expect(cells[0]?.text()).toContain('2'); // Radarr-4K: two movies tagged
    expect(cells[1]?.text()).toContain('1'); // Radarr-HD: one movie
    expect(cells[2]?.find('[data-icon="absent"]').exists()).toBe(true); // Sonarr-Anime: missing
  });

  it('reports parity per row', async () => {
    const wrapper = await mountView();
    const rows = wrapper.findAll('tbody tr');

    // "hd" is on 2 of 3 healthy instances -> drift; every row shows its own count.
    expect(rows[2]?.text()).toContain('drift');
    expect(rows[2]?.text()).toContain('2/3');
    expect(rows[0]?.text()).toContain('1/3');
  });

  it('clicking a gap stages a create for exactly that instance', async () => {
    const wrapper = await mountView();
    const hdRow = wrapper.findAll('tbody tr')[2];
    const missingCell = hdRow?.findAll('[data-cell="tag"]')[2];

    await missingCell?.trigger('click');
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual([
      { instanceId: 3, op: 'tag.create', payload: { label: 'hd' } },
    ]);
  });

  it('marks the cell as staged once the operation is queued', async () => {
    const wrapper = await mountView();
    const missingCell = wrapper.findAll('tbody tr')[2]?.findAll('[data-cell="tag"]')[2];

    await missingCell?.trigger('click');
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    const cellAfter = wrapper.findAll('tbody tr')[2]?.findAll('[data-cell="tag"]')[2];
    expect(cellAfter?.text()).toContain('new');
    expect(cellAfter?.classes().join(' ')).toContain('text-sync');
  });

  it('propagate-missing stages one create per gap across selected rows', async () => {
    const wrapper = await mountView();

    // select every visible row through the header checkbox
    await wrapper.find('thead input[type="checkbox"]').setValue(true);
    await flushPromises();

    const propagate = wrapper
      .findAll('button')
      .find((button) => button.text().startsWith('Propagate missing'));
    // 3 tags x 3 instances = 9 cells, 4 of them already present -> 5 gaps
    expect(propagate?.text()).toContain('(5)');

    await propagate?.trigger('click');
    await flushPromises();

    const batch = push.mock.calls[0]?.[0] ?? [];
    expect(batch).toHaveLength(5);
    expect(batch.every((entry) => entry.op === 'tag.create')).toBe(true);
    expect(new Set(batch.map((entry) => entry.instanceId))).toEqual(new Set([1, 2, 3]));
  });

  it('filters to drifted rows only', async () => {
    const wrapper = await mountView();

    const driftFilter = wrapper.findAll('button').find((button) => button.text() === 'Drift only');
    await driftFilter?.trigger('click');
    await flushPromises();

    // none of the three tags is on all three instances, so all rows survive;
    // the filter must at least keep them and drop nothing unexpected
    expect(wrapper.findAll('tbody tr')).toHaveLength(3);
    expect(wrapper.text()).toContain('All tags');
  });
});
