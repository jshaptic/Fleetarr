import type { Instance, QueueItem, QueueRun } from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(() => Promise.resolve({ run: run('running'), items: [] }));
const cancel = vi.fn(() => Promise.resolve({ run: run('cancelled'), items: [] }));
const resume = vi.fn(() => Promise.resolve({ run: run('running'), items: [] }));
const listItems: QueueItem[] = [];

vi.mock('@/api/queue', () => ({
  queueApi: {
    list: () => Promise.resolve({ items: [...listItems], activeRun: null }),
    push: vi.fn(),
    detail: vi.fn(),
    reorder: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    runs: vi.fn(),
    run: vi.fn(),
    start,
    resume,
    cancel,
    events: vi.fn(),
    openStream: vi.fn(() => () => undefined),
  },
}));

vi.mock('@/api/instances', () => ({
  instancesApi: { list: () => Promise.resolve({ instances: INSTANCES }) },
}));

const INSTANCES: Instance[] = [
  {
    id: 1,
    name: 'Radarr-4K',
    kind: 'radarr',
    baseUrl: 'http://host:7878',
    verifySsl: true,
    enabled: true,
    timeoutMs: 20_000,
    appVersion: '5.0.0',
    lastConnectedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 2,
    name: 'Sonarr',
    kind: 'sonarr',
    baseUrl: 'http://host:8989',
    verifySsl: true,
    enabled: true,
    timeoutMs: 20_000,
    appVersion: '4.0.0',
    lastConnectedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  },
];

function run(status: QueueRun['status'], overrides: Partial<QueueRun> = {}): QueueRun {
  return {
    id: 7,
    status,
    onError: 'pause',
    totalItems: 4,
    succeededItems: 2,
    failedItems: status === 'paused' ? 1 : 0,
    skippedItems: 0,
    currentItemId: null,
    error: null,
    startedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function item(id: number, instanceId: number, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    instanceId,
    runId: null,
    dependsOnId: null,
    sortOrder: id,
    status: 'pending',
    op: 'tag.create',
    payload: { label: `tag-${String(id)}` },
    targetKind: 'tag',
    targetId: null,
    targetLabel: `tag-${String(id)}`,
    summary: `Create tag "tag-${String(id)}"`,
    affectedCount: 1,
    attempts: 0,
    error: null,
    result: null,
    createdAt: '',
    updatedAt: '',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  } as QueueItem;
}

const StagingDrawer = (await import('./StagingDrawer.vue')).default;
const ExecutionModal = (await import('./ExecutionModal.vue')).default;
const { useQueueStore } = await import('@/stores/queue');
const { useUiStore } = await import('@/stores/ui');
const { useInstancesStore } = await import('@/stores/instances');

beforeEach(() => {
  setActivePinia(createPinia());
  listItems.length = 0;
  start.mockClear();
  cancel.mockClear();
  resume.mockClear();
});

describe('StagingDrawer', () => {
  it('summarises the impact across instances', async () => {
    listItems.push(
      item(1, 1),
      item(2, 2),
      item(3, 2, {
        op: 'media.moveRootFolder',
        payload: { mediaIds: [1, 2, 3], toRootFolderPath: '/data/4k', moveFiles: true },
        targetKind: 'movie',
        targetLabel: '/data/4k',
        affectedCount: 3,
      }),
    );

    const wrapper = mount(StagingDrawer, { global: { plugins: [createPinia()] } });
    const queue = useQueueStore();
    await queue.load();
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('Modifying 2 tags, 1 movie across 2 instances (3 API operations total)');
    expect(text).toContain('touching 5 media item(s)');
  });

  it('marks destructive operations and groups by instance on demand', async () => {
    listItems.push(
      item(1, 1, {
        op: 'media.moveRootFolder',
        payload: { mediaIds: [1], toRootFolderPath: '/data/4k', moveFiles: true },
        summary: 'Move 1 item(s) to /data/4k (moving files on disk)',
      }),
      item(2, 2, { op: 'tag.delete', payload: { tagId: 4, label: 'old', detachFromMedia: true } }),
    );

    const wrapper = mount(StagingDrawer, { global: { plugins: [createPinia()] } });
    const queue = useQueueStore();
    const ui = useUiStore();
    await useInstancesStore().load();
    await queue.load();
    ui.openDrawer();
    await flushPromises();

    expect(wrapper.find('[data-testid="destructive"]').text()).toBe('destructive');

    const byInstance = wrapper.findAll('button').find((b) => b.text() === 'By instance');
    await byInstance?.trigger('click');
    expect(wrapper.text()).toContain('Radarr-4K');
    expect(wrapper.text()).toContain('Sonarr');
  });

  it('Apply All starts a run with the chosen failure policy', async () => {
    listItems.push(item(1, 1));

    const wrapper = mount(StagingDrawer, { global: { plugins: [createPinia()] } });
    await useQueueStore().load();
    await flushPromises();

    // The policy picker is `BaseSelect`, whose list is teleported to the body - there is no
    // native <select> to `setValue` any more, so this drives the popup the way a user does.
    await wrapper.find('[data-select-toggle]').trigger('mousedown');
    const keep = [...document.body.querySelectorAll('[role="option"]')].find((row) =>
      row.textContent?.includes('keep going'),
    );
    keep?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();

    const apply = wrapper.findAll('button').find((b) => b.text() === 'Apply All');
    await apply?.trigger('click');
    await flushPromises();

    expect(start).toHaveBeenCalledWith({ onError: 'continue' });
  });

  it('is inert with an empty queue', async () => {
    const wrapper = mount(StagingDrawer, { global: { plugins: [createPinia()] } });
    await useQueueStore().load();
    useUiStore().openDrawer();
    await flushPromises();

    expect(wrapper.text()).toContain('Nothing staged');
    const apply = wrapper.findAll('button').find((b) => b.text() === 'Apply All');
    expect(apply?.attributes('disabled')).toBeDefined();
  });
});

describe('ExecutionModal', () => {
  it('tracks progress, the active instance and the current step', async () => {
    const wrapper = mount(ExecutionModal, { global: { plugins: [createPinia()] } });
    const queue = useQueueStore();
    const ui = useUiStore();
    await useInstancesStore().load();

    queue.activeRun = run('running');
    queue.runItems = [
      item(1, 1, { status: 'succeeded' }),
      item(2, 1, { status: 'succeeded' }),
      item(3, 2, { status: 'running', summary: 'Create tag "wip"' }),
      item(4, 2),
    ];
    queue.currentItemId = 3;
    ui.openExecution();
    await flushPromises();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Applying staged changes');
    expect(text).toContain('step 2 of 4');
    expect(text).toContain('50%');
    expect(text).toContain('Create tag "wip"');
    expect(text).toContain('Sonarr');
    expect(text).toContain('Halt run');
    wrapper.unmount();
  });

  it('offers retry and skip when the queue halted on a failure', async () => {
    const wrapper = mount(ExecutionModal, { global: { plugins: [createPinia()] } });
    const queue = useQueueStore();
    const ui = useUiStore();
    await useInstancesStore().load();

    queue.activeRun = run('paused', { currentItemId: 3 });
    queue.runItems = [
      item(1, 1, { status: 'succeeded' }),
      item(2, 1, { status: 'succeeded' }),
      item(3, 2, {
        status: 'failed',
        error: { code: 'arr_validation_failed', message: 'Label already exists', httpStatus: 400 },
      }),
      item(4, 2),
    ];
    queue.failedItemId = 3;
    ui.openExecution();
    await flushPromises();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Queue halted on a failed step');
    expect(text).toContain('Nothing after the failed step has run');
    expect(text).toContain('arr_validation_failed');

    const buttons = [...document.body.querySelectorAll('button')];
    const retry = buttons.find((button) => button.textContent?.includes('Retry failed'));
    retry?.click();
    await flushPromises();

    expect(resume).toHaveBeenCalledWith(7, { retryFailed: true });
    wrapper.unmount();
  });
});
