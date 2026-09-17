import type { FsCheck, NewQueueItem, PathNode } from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let nextId = 1;

const push = vi.fn((items: readonly NewQueueItem[]) =>
  Promise.resolve({
    items: items.map((entry) => ({
      id: nextId++,
      instanceId: entry.instanceId ?? null,
      kind: 'fs' as const,
      runId: null,
      dependsOnId: null,
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
      startedAt: '',
      finishedAt: null,
    })),
  }),
);

/** Per-path checks, so one selection can mix deletable and blocked folders. */
const checksByPath: Record<string, FsCheck[]> = {};

const preflight = vi.fn((_op: string, payload: { path: string }) =>
  Promise.resolve({
    op: 'fs.delete',
    ok: !(checksByPath[payload.path] ?? []).some((check) => check.status === 'blocker'),
    checks: checksByPath[payload.path] ?? [],
    measurement: null,
    freeSpace: null,
    referencedBy: [],
  }),
);

vi.mock('@/api/storage', () => ({
  storageApi: {
    roots: () => Promise.resolve({ enabled: true, roots: [] }),
    matrix: vi.fn(),
    measure: vi.fn(),
    preflight: (...args: unknown[]) => preflight(...(args as [string, { path: string }])),
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

const BulkDeleteDialog = (await import('./BulkDeleteDialog.vue')).default;

const EMPTY: FsCheck = { id: 'empty', status: 'ok', message: 'Directory is empty' };
const UNREFERENCED: FsCheck = {
  id: 'referenced_by_arr',
  status: 'ok',
  message: 'No connected instance references this path',
};

function node(path: string): PathNode {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    origin: 'disk',
    exists: true,
    kind: 'directory',
    inScope: true,
    modifiedAt: null,
    childCount: 0,
    readable: true,
    writable: true,
    deviceId: '1',
    freeSpace: null,
    totalSpace: null,
    lowSpace: false,
    sizeOnDisk: null,
    error: null,
    owners: [],
    flags: [],
    severity: 'ok',
    canAddRootFolder: false,
    rollup: null,
    expandable: false,
  };
}

async function mountDialog(targets: PathNode[]): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(BulkDeleteDialog, {
    props: { targets },
    global: { plugins: [createPinia()] },
  });
  for (let tick = 0; tick < 8; tick += 1) await flushPromises();
  return wrapper;
}

function find(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function all(testId: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

function type(value: string): void {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="bulk-delete-confirm"]');
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  setActivePinia(createPinia());
  push.mockClear();
  preflight.mockClear();
  for (const key of Object.keys(checksByPath)) delete checksByPath[key];
  nextId = 1;
});

describe('BulkDeleteDialog', () => {
  it('stages one fs.delete per folder in a single batch', async () => {
    checksByPath['/data/a'] = [EMPTY, UNREFERENCED];
    checksByPath['/data/b'] = [EMPTY, UNREFERENCED];
    const wrapper = await mountDialog([node('/data/a'), node('/data/b')]);

    type('2');
    await flushPromises();
    find('bulk-delete-stage')?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls).toHaveLength(1);
    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.delete', payload: { path: '/data/a', recursive: false, force: false } },
      { op: 'fs.delete', payload: { path: '/data/b', recursive: false, force: false } },
    ]);
    wrapper.unmount();
  });

  it('names a folder it cannot delete and leaves it out of the batch', async () => {
    checksByPath['/data/a'] = [EMPTY, UNREFERENCED];
    checksByPath['/data/mount'] = [
      { id: 'not_mount_point', status: 'blocker', message: '/data/mount is a mount point' },
    ];
    const wrapper = await mountDialog([node('/data/a'), node('/data/mount')]);

    expect(find('delete-blocked')?.textContent).toContain('is a mount point');
    expect(all('delete-victim')).toHaveLength(1);
    // The typed count is the count that will actually go, not the count selected.
    expect(document.body.textContent).toContain('Stage 1 deletion(s)');

    type('1');
    await flushPromises();
    find('bulk-delete-stage')?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.delete', payload: { path: '/data/a', recursive: false, force: false } },
    ]);
    wrapper.unmount();
  });

  it('asks neither question when every folder is empty and unreferenced', async () => {
    checksByPath['/data/a'] = [EMPTY, UNREFERENCED];
    const wrapper = await mountDialog([node('/data/a')]);

    expect(find('bulk-delete-recursive')).toBeNull();
    expect(find('bulk-delete-force')).toBeNull();
    wrapper.unmount();
  });

  it('asks once for the batch when any one folder needs it', async () => {
    checksByPath['/data/a'] = [EMPTY, UNREFERENCED];
    checksByPath['/data/b'] = [
      { id: 'recursive_required', status: 'blocker', message: '/data/b is not empty (3 entries)' },
      UNREFERENCED,
    ];
    const wrapper = await mountDialog([node('/data/a'), node('/data/b')]);

    expect(find('bulk-delete-recursive')).not.toBeNull();
    expect(find('bulk-delete-force')).toBeNull();

    // Ticking it re-runs every preflight, and /data/b stops being a blocker.
    checksByPath['/data/b'] = [
      { id: 'recursive_delete', status: 'warning', message: 'Deletes 4 GB in 12 file(s)' },
      UNREFERENCED,
    ];
    find('bulk-delete-recursive')?.dispatchEvent(new MouseEvent('click'));
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(all('delete-victim')).toHaveLength(2);
    type('2');
    await flushPromises();
    find('bulk-delete-stage')?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.delete', payload: { path: '/data/a', recursive: true, force: false } },
      { op: 'fs.delete', payload: { path: '/data/b', recursive: true, force: false } },
    ]);
    wrapper.unmount();
  });

  it('reports which folders it staged, so they leave the selection', async () => {
    checksByPath['/data/a'] = [EMPTY, UNREFERENCED];
    checksByPath['/data/blocked'] = [
      { id: 'not_mount_point', status: 'blocker', message: 'is a mount point' },
    ];
    const wrapper = await mountDialog([node('/data/a'), node('/data/blocked')]);

    type('1');
    await flushPromises();
    find('bulk-delete-stage')?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    // Only what was actually staged: the blocked folder stays ticked, because nothing
    // happened to it and the user still has to deal with it.
    expect(wrapper.emitted('staged')).toEqual([[['/data/a']]]);
    wrapper.unmount();
  });

  it('will not stage until the number of folders is typed back', async () => {
    checksByPath['/data/a'] = [EMPTY, UNREFERENCED];
    checksByPath['/data/b'] = [EMPTY, UNREFERENCED];
    const wrapper = await mountDialog([node('/data/a'), node('/data/b')]);

    expect(find('bulk-delete-stage')?.hasAttribute('disabled')).toBe(true);
    type('1');
    await flushPromises();
    expect(find('bulk-delete-stage')?.hasAttribute('disabled')).toBe(true);

    type('2');
    await flushPromises();
    expect(find('bulk-delete-stage')?.hasAttribute('disabled')).toBe(false);
    wrapper.unmount();
  });
});
