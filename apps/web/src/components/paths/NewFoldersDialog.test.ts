import type { FsOp, FsPreflight, NewQueueItem, QueuePayloadFor } from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every path is free unless a test says otherwise - `taken` is the folder that exists. */
let taken: string[] = [];

const preflight = vi.fn(
  <K extends FsOp>(op: K, payload: QueuePayloadFor<K>): Promise<FsPreflight> => {
    const path = (payload as { path: string }).path;
    const exists = taken.includes(path);
    return Promise.resolve({
      op,
      ok: !exists,
      checks: exists
        ? [{ id: 'destination_free', status: 'blocker', message: `${path} already exists` }]
        : [{ id: 'destination_free', status: 'ok', message: 'Destination does not exist yet' }],
      measurement: null,
      freeSpace: null,
      referencedBy: [],
      references: [],
    });
  },
);

const push = vi.fn((items: readonly NewQueueItem[]) =>
  Promise.resolve({ items: items.map(() => ({ id: 1 })) }),
);

vi.mock('@/api/storage', () => ({
  storageApi: {
    matrix: vi.fn(),
    list: vi.fn(),
    roots: () => Promise.resolve({ enabled: true, roots: [] }),
    measure: vi.fn(),
    reconcile: vi.fn(),
    preflight: (op: FsOp, payload: QueuePayloadFor<FsOp>) => preflight(op, payload),
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

const NewFoldersDialog = (await import('./NewFoldersDialog.vue')).default;

async function mountDialog(source: string, parent = '/data/media') {
  const wrapper = mount(NewFoldersDialog, {
    props: { parent, source },
    global: { plugins: [createPinia()] },
  });
  for (let tick = 0; tick < 6; tick += 1) await flushPromises();
  return wrapper;
}

function stageButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('mkdir'),
  );
}

beforeEach(() => {
  taken = [];
  preflight.mockClear();
  push.mockClear();
});

describe('NewFoldersDialog', () => {
  it('stages one mkdir per folder a brace tree names', async () => {
    const wrapper = await mountDialog('{movies,series}/4k');

    const text = document.body.textContent ?? '';
    expect(text).toContain('2 folder(s)');
    expect(text).toContain('/data/media/movies/4k');
    expect(text).toContain('/data/media/series/4k');

    stageButton()?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    // Recursive by default: every one of these patterns names more than one level.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.mkdir', payload: { path: '/data/media/movies/4k', recursive: true } },
      { op: 'fs.mkdir', payload: { path: '/data/media/series/4k', recursive: true } },
    ]);
    wrapper.unmount();
  });

  it('skips the folders that already exist rather than blocking the batch', async () => {
    taken = ['/data/media/movies/4k'];
    const wrapper = await mountDialog('{movies,series}/4k');

    expect(document.body.textContent ?? '').toContain('Skip the 1 that already exist');

    stageButton()?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.mkdir', payload: { path: '/data/media/series/4k', recursive: true } },
    ]);
    wrapper.unmount();
  });

  it('holds the button when a folder that exists is deliberately not skipped', async () => {
    taken = ['/data/media/movies/4k'];
    const wrapper = await mountDialog('{movies,series}/4k');

    const skip = document.body.querySelector<HTMLInputElement>(
      '[data-testid="new-folders-skip-existing"] input',
    );
    skip?.click();
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    expect(stageButton()?.disabled).toBe(true);
    expect(document.body.textContent ?? '').toContain('already exists');
    wrapper.unmount();
  });

  it('refuses a source it cannot expand, and asks the server nothing about it', async () => {
    const wrapper = await mountDialog('{movies,series');

    expect(document.body.querySelector('[data-testid="new-folders-error"]')).not.toBeNull();
    expect(preflight).not.toHaveBeenCalled();
    expect(stageButton()?.disabled).toBe(true);
    wrapper.unmount();
  });

  it('is inert until something is typed', async () => {
    const wrapper = await mountDialog('');

    expect(preflight).not.toHaveBeenCalled();
    expect(stageButton()?.disabled).toBe(true);
    wrapper.unmount();
  });
});
