import type { NewQueueItem } from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The align half of this dialog used to be `ReconcileDialog`, a second row action beside
 * `rename`. These are its tests, re-pointed: the chain is unchanged, what changed is that
 * choosing it is a checkbox next to the new name rather than a different button.
 */

const ROOT = '/data/movies';
let nextId = 1;

const push = vi.fn((items: readonly NewQueueItem[]) =>
  Promise.resolve({
    items: items.map((entry) => ({
      id: nextId++,
      instanceId: entry.instanceId ?? null,
      kind: (entry.instanceId === undefined || entry.instanceId === null ? 'fs' : 'arr') as 'fs' | 'arr',
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

/**
 * Overridable per test: the delete branch renders its two options from the preflight's own
 * verdict, so the checks a test hands back are the thing under test.
 */
const renamePreflight = () =>
  Promise.resolve({
    op: 'fs.rename',
    ok: true,
    checks: [{ id: 'same_device', status: 'ok', message: 'Same filesystem - atomic rename' }],
    measurement: null,
    freeSpace: null,
    referencedBy: [],
  });

const preflight = vi.fn(renamePreflight);

function deletePreflight(checks: { id: string; status: string; message: string }[]) {
  return () =>
    Promise.resolve({
      op: 'fs.delete',
      ok: !checks.some((check) => check.status === 'blocker'),
      checks,
      measurement: null,
      freeSpace: null,
      referencedBy: [],
    });
}

vi.mock('@/api/storage', () => ({
  storageApi: {
    roots: () => Promise.resolve({ enabled: true, roots: [] }),
    list: vi.fn(),
    measure: vi.fn(),
    preflight: (...args: unknown[]) => preflight(...(args as [])),
  },
}));

vi.mock('@/api/resources', () => ({
  resourcesApi: {
    snapshot: vi.fn(),
    media: vi.fn(),
    allMediaIdsInRootFolder: vi.fn((instanceId: number, rootFolderPath: string) => {
      if (instanceId !== 1) return Promise.resolve([]);
      if (rootFolderPath.endsWith('auto-feed/0k')) return Promise.resolve([10, 11]);
      if (rootFolderPath.endsWith('curated-feed/0k')) return Promise.resolve([12]);
      return Promise.resolve([10, 11, 12]);
    }),
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

const DiskOperationModal = (await import('./DiskOperationModal.vue')).default;

const RADARR_4K = {
  instanceId: 1,
  name: 'Radarr-4K',
  kind: 'radarr' as const,
  roots: [{ path: ROOT, rootFolderId: 5 }],
};

async function mountDialog(
  props: Record<string, unknown> = { alignTargets: [RADARR_4K] },
): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(DiskOperationModal, {
    props: { operation: 'rename', target: ROOT, ...props },
    global: { plugins: [createPinia()] },
  });
  for (let tick = 0; tick < 8; tick += 1) await flushPromises();
  return wrapper;
}

/** The dialog teleports into the body, so every query goes through the document. */
function type(value: string): void {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="disk-operation-name"]');
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
}

function stageButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Stage'),
  );
}

// The dialog teleports into the body, so a test that fails before its own `unmount` would
// otherwise leave a second dialog behind for the next one to find.
afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  push.mockClear();
  // mockClear keeps the implementation, and the delete tests swap it - so put it back.
  preflight.mockReset();
  preflight.mockImplementation(renamePreflight);
  nextId = 1;
});

describe('DiskOperationModal', () => {
  it('offers the instances rooting at this path, with what each would realign', async () => {
    const wrapper = await mountDialog();
    const text = document.body.textContent ?? '';

    expect(text).toContain('Rename & align');
    expect(text).toContain('Radarr-4K');
    expect(text).toContain('3 item(s) to realign');
    wrapper.unmount();
  });

  it('is a plain disk rename when no instance roots here', async () => {
    const wrapper = await mountDialog({ alignTargets: [] });
    const text = document.body.textContent ?? '';

    expect(text).toContain('Rename on disk');
    expect(text).not.toContain('to realign');
    expect(document.body.querySelector('[data-testid="align-targets"]')).toBeNull();

    type('films');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();
    stageButton()?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls.map((call) => call[0])).toEqual([
      [{ op: 'fs.rename', payload: { from: ROOT, to: '/data/films' } }],
    ]);
    wrapper.unmount();
  });

  it('spells out the chain, including that no files will be copied', async () => {
    const wrapper = await mountDialog();
    const text = document.body.textContent ?? '';

    expect(text).toContain('rename /data/movies');
    expect(text).toContain('moveFiles: false');
    expect(text).toContain('Every *Arr step waits for the disk step');
    wrapper.unmount();
  });

  it('stages the disk rename first, with every *Arr step depending on it', async () => {
    const wrapper = await mountDialog();

    type('films');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    stageButton()?.click();
    for (let tick = 0; tick < 8; tick += 1) await flushPromises();

    const batches = push.mock.calls.map((call) => call[0][0]);

    // 1. the disk, with no instance attached
    expect(batches[0]).toEqual({ op: 'fs.rename', payload: { from: ROOT, to: '/data/films' } });

    // 2. the destination root folder, gated on the rename
    expect(batches[1]).toMatchObject({
      instanceId: 1,
      op: 'rootFolder.create',
      payload: { path: '/data/films' },
      dependsOnId: 1,
    });

    // 3. realignment - and this is the whole point of the phase
    expect(batches[2]).toMatchObject({
      instanceId: 1,
      op: 'media.moveRootFolder',
      payload: { mediaIds: [10, 11, 12], toRootFolderPath: '/data/films', moveFiles: false },
      dependsOnId: 2,
    });

    // 4. drop the old root folder, gated on the realignment
    expect(batches[3]).toMatchObject({
      instanceId: 1,
      op: 'rootFolder.delete',
      payload: { rootFolderId: 5, path: ROOT },
      dependsOnId: 3,
    });
    // Nothing follows it: a rescan would read the new paths before *Arr had finished.
    expect(batches).toHaveLength(4);
    wrapper.unmount();
  });

  it('skips the optional steps when they are turned off', async () => {
    const wrapper = await mountDialog();

    type('films');
    for (const box of document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      // The instance checkbox stays on; the option toggle goes off.
      if (box.checked && box !== document.body.querySelector('input[type="checkbox"]')) box.click();
    }
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    stageButton()?.click();
    for (let tick = 0; tick < 8; tick += 1) await flushPromises();

    expect(push.mock.calls.map((call) => call[0][0]?.op)).toEqual([
      'fs.rename',
      'rootFolder.create',
      'media.moveRootFolder',
    ]);
    wrapper.unmount();
  });

  // ------------------------------------------------- the delete branch's two options
  //
  // Each one is a question the preflight has already answered. Asking it anyway turned the
  // ordinary case - an empty folder nobody references - into two irreversible-sounding
  // checkboxes that changed nothing, which reads like the dangerous case.

  const EMPTY = { id: 'empty', status: 'ok', message: 'Directory is empty' };
  const UNREFERENCED = {
    id: 'referenced_by_arr',
    status: 'ok',
    message: 'No connected instance references this path',
  };

  async function mountDelete(
    checks: { id: string; status: string; message: string }[],
  ): Promise<ReturnType<typeof mount>> {
    preflight.mockImplementation(deletePreflight(checks) as never);
    return mountDialog({ operation: 'delete', alignTargets: [] });
  }

  function box(name: 'recursive' | 'force'): Element | null {
    return document.body.querySelector(`[data-testid="delete-${name}"]`);
  }

  it('asks neither question when the folder is empty and nothing references it', async () => {
    const wrapper = await mountDelete([EMPTY, UNREFERENCED]);

    expect(box('recursive')).toBeNull();
    expect(box('force')).toBeNull();
    // The delete itself is still a delete: the warning and the typed confirmation stay.
    expect(document.body.textContent).toContain('Fleetarr has no recycle bin');
    wrapper.unmount();
  });

  it('asks only about the contents when the folder is not empty', async () => {
    const wrapper = await mountDelete([
      { id: 'recursive_required', status: 'blocker', message: '/data/movies is not empty (3 entries)' },
      UNREFERENCED,
    ]);

    expect(box('recursive')).not.toBeNull();
    expect(box('force')).toBeNull();
    wrapper.unmount();
  });

  it('asks only about the instance when one still references the path', async () => {
    const wrapper = await mountDelete([
      EMPTY,
      { id: 'referenced_by_arr', status: 'blocker', message: '1 connected instance(s) still have media here' },
    ]);

    expect(box('recursive')).toBeNull();
    expect(box('force')).not.toBeNull();
    wrapper.unmount();
  });

  it('keeps asking about the contents once the box is ticked', async () => {
    // The blocker becomes a warning the moment `recursive` is on. If the option vanished on
    // its own answer it would untick itself, and the delete would refuse to stage.
    const wrapper = await mountDelete([
      { id: 'recursive_delete', status: 'warning', message: 'Deletes 4 GB in 12 file(s)' },
      UNREFERENCED,
    ]);

    expect(box('recursive')).not.toBeNull();
    wrapper.unmount();
  });

  it('drops an option from the payload when it stops being asked about', async () => {
    const wrapper = await mountDelete([
      { id: 'recursive_required', status: 'blocker', message: 'not empty' },
      { id: 'referenced_by_arr', status: 'blocker', message: 'still referenced' },
    ]);

    box('recursive')?.dispatchEvent(new MouseEvent('click'));
    box('force')?.dispatchEvent(new MouseEvent('click'));
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    // Somebody emptied the folder and dropped it from the instance while the dialog was open.
    // Unticking `recursive` is what re-runs the preflight; `force` is still ticked, and the
    // point of the assertion below is that it does not survive into the payload unexplained.
    preflight.mockImplementation(deletePreflight([EMPTY, UNREFERENCED]) as never);
    box('recursive')?.dispatchEvent(new MouseEvent('click'));
    for (let tick = 0; tick < 8; tick += 1) await flushPromises();

    expect(box('recursive')).toBeNull();
    expect(box('force')).toBeNull();

    const confirm = document.body.querySelector<HTMLInputElement>('input[autocomplete="off"]');
    if (confirm) {
      confirm.value = 'movies';
      confirm.dispatchEvent(new Event('input'));
    }
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    stageButton()?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls.at(-1)?.[0]).toEqual([
      { op: 'fs.delete', payload: { path: ROOT, recursive: false, force: false } },
    ]);
    wrapper.unmount();
  });

  it('unchecking every instance leaves the disk rename alone, and says what it strands', async () => {
    const wrapper = await mountDialog({
      alignTargets: [RADARR_4K],
      trackedBy: [{ instanceId: 1, name: 'Radarr-4K', mediaCount: 3 }],
    });

    document.body.querySelector<HTMLInputElement>('[data-testid="align-targets"] input')?.click();
    type('films');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    expect(document.body.textContent).toContain('No instance is selected below');

    stageButton()?.click();
    for (let tick = 0; tick < 6; tick += 1) await flushPromises();

    expect(push.mock.calls.map((call) => call[0][0]?.op)).toEqual(['fs.rename']);
    wrapper.unmount();
  });

  it('re-points an instance that roots here but has downloaded nothing yet', async () => {
    // No media ids to bulk-edit, so no editor call and no rescan - but the root folder is
    // still created at the new path and the old one dropped, or the rename would strand a
    // freshly configured instance.
    const wrapper = await mountDialog({
      alignTargets: [{ ...RADARR_4K, instanceId: 2, name: 'Sonarr', kind: 'sonarr' }],
    });

    type('films');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    expect(document.body.textContent).toContain('0 item(s) to realign');

    stageButton()?.click();
    for (let tick = 0; tick < 8; tick += 1) await flushPromises();

    expect(push.mock.calls.map((call) => call[0][0]?.op)).toEqual([
      'fs.rename',
      'rootFolder.create',
      'rootFolder.delete',
    ]);
    expect(push.mock.calls[2]?.[0][0]).toMatchObject({ dependsOnId: 2 });
    wrapper.unmount();
  });

  it('rewrites every nested root folder when the parent is renamed', async () => {
    const from = '/data/media/movies/europe';
    const wrapper = await mountDialog({
      target: from,
      alignTargets: [
        {
          instanceId: 1,
          name: 'Radarr',
          kind: 'radarr',
          roots: [
            { path: `${from}/auto-feed/0k`, rootFolderId: 8 },
            { path: `${from}/curated-feed/0k`, rootFolderId: 9 },
          ],
        },
      ],
    });

    type('european');
    for (let tick = 0; tick < 4; tick += 1) await flushPromises();

    expect(document.body.textContent).toContain('2 root folder(s)');
    expect(document.body.textContent).toContain(`${from}/auto-feed/0k`);
    expect(document.body.textContent).toContain(`${from}/curated-feed/0k`);

    stageButton()?.click();
    for (let tick = 0; tick < 10; tick += 1) await flushPromises();

    const batches = push.mock.calls.map((call) => call[0]?.[0]).filter((entry) => entry !== undefined);
    expect(batches[0]).toEqual({
      op: 'fs.rename',
      payload: { from, to: '/data/media/movies/european' },
    });
    expect(batches[1]).toMatchObject({
      op: 'rootFolder.create',
      payload: { path: '/data/media/movies/european/auto-feed/0k' },
    });
    expect(batches[2]).toMatchObject({
      op: 'media.moveRootFolder',
      payload: {
        mediaIds: [10, 11],
        toRootFolderPath: '/data/media/movies/european/auto-feed/0k',
        moveFiles: false,
      },
    });
    expect(
      batches.some(
        (entry) =>
          entry.op === 'rootFolder.create' &&
          entry.payload.path === '/data/media/movies/european/curated-feed/0k',
      ),
    ).toBe(true);
    expect(
      batches.some(
        (entry) =>
          entry.op === 'rootFolder.delete' &&
          entry.payload.path === `${from}/auto-feed/0k` &&
          entry.payload.rootFolderId === 8,
      ),
    ).toBe(true);
    expect(
      batches.some(
        (entry) =>
          entry.op === 'rootFolder.delete' &&
          entry.payload.path === `${from}/curated-feed/0k` &&
          entry.payload.rootFolderId === 9,
      ),
    ).toBe(true);
    wrapper.unmount();
  });
});
