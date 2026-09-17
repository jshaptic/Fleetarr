import type { NewQueueItem, QueueItem, QueueOp } from '@fleetarr/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn<(items: readonly NewQueueItem[]) => Promise<{ items: QueueItem[] }>>();
const list = vi.fn();
const run = vi.fn();

vi.mock('@/api/queue', () => ({
  queueApi: {
    push: (items: readonly NewQueueItem[]) => push(items),
    list: () => list(),
    run: (id: number) => run(id),
    detail: vi.fn(),
    reorder: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    runs: vi.fn(),
    start: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    events: vi.fn(),
    openStream: vi.fn(() => () => undefined),
  },
}));

const { useQueueStore } = await import('./queue');

let nextId = 1;

function item(op: QueueOp, instanceId: number | null, overrides: Partial<QueueItem> = {}): QueueItem {
  const base = {
    id: nextId++,
    instanceId,
    kind: (instanceId === null ? 'fs' : 'arr') as QueueItem['kind'],
    runId: null,
    dependsOnId: null,
    sortOrder: nextId,
    status: 'pending' as const,
    targetKind: 'tag' as const,
    targetId: null,
    targetLabel: 'hd',
    summary: `${op} on ${String(instanceId)}`,
    affectedCount: 1,
    attempts: 0,
    error: null,
    result: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  };

  const payloads: Record<string, unknown> = {
    'tag.create': { label: 'hd' },
    'tag.rename': { tagId: 1, from: 'hd', to: '1080p' },
    'tag.delete': { tagId: 1, label: 'hd', detachFromMedia: true },
    'rootFolder.create': { path: '/data/media' },
    'media.moveRootFolder': { mediaIds: [1], toRootFolderPath: '/data/media-4k', moveFiles: false },
    'mediaTags.add': { mediaIds: [1], tagIds: [7] },
    'mediaTags.remove': { mediaIds: [1], tagIds: [7] },
    'mediaTags.set': { mediaIds: [1], tagIds: [7] },
    'media.refresh': { mediaIds: [1] },
    'media.setMonitored': { mediaIds: [1], monitored: false },
    'media.setQualityProfile': { mediaIds: [1], qualityProfileId: 4, profileName: 'Ultra-HD' },
    'media.delete': { mediaIds: [1], deleteFiles: false, addImportExclusion: false },
    'fs.rename': { from: '/data/media/movies', to: '/data/media/films' },
    'fs.delete': { path: '/data/media/movies', recursive: true, force: false },
  };

  return { ...base, op, payload: payloads[op], ...overrides } as QueueItem;
}

beforeEach(() => {
  setActivePinia(createPinia());
  nextId = 1;
  push.mockReset();
  list.mockReset();
  run.mockReset();
  list.mockResolvedValue({ items: [], activeRun: null });
  push.mockImplementation((items: readonly NewQueueItem[]) =>
    Promise.resolve({
      items: items.map((entry) =>
        item(entry.op, entry.instanceId ?? null, { dependsOnId: entry.dependsOnId ?? null }),
      ),
    }),
  );
});

describe('fleet fan-out', () => {
  it('propagating a tag stages one create per instance', async () => {
    const queue = useQueueStore();
    await queue.propagateTag('4k-remux', [1, 2, 5]);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual([
      { instanceId: 1, op: 'tag.create', payload: { label: '4k-remux' } },
      { instanceId: 2, op: 'tag.create', payload: { label: '4k-remux' } },
      { instanceId: 5, op: 'tag.create', payload: { label: '4k-remux' } },
    ]);
  });

  it('a bulk rename carries each instance own tag id', async () => {
    const queue = useQueueStore();
    await queue.renameTagAcross(
      [
        { instanceId: 1, tagId: 11, label: 'hd' },
        { instanceId: 2, tagId: 42, label: 'hd' },
      ],
      '1080p',
    );

    expect(push.mock.calls[0]?.[0]).toEqual([
      { instanceId: 1, op: 'tag.rename', payload: { tagId: 11, from: 'hd', to: '1080p' } },
      { instanceId: 2, op: 'tag.rename', payload: { tagId: 42, from: 'hd', to: '1080p' } },
    ]);
  });

  it('find & replace becomes a merge where the new label already exists', async () => {
    const queue = useQueueStore();
    await queue.applyFindReplace(
      [
        { instanceId: 1, tagId: 11, from: '4k-web', to: 'uhd-web' },
        { instanceId: 2, tagId: 22, from: '4k-web', to: 'uhd-web' },
      ],
      new Map([['2|uhd-web', 99]]),
    );

    expect(push.mock.calls[0]?.[0]).toEqual([
      { instanceId: 1, op: 'tag.rename', payload: { tagId: 11, from: '4k-web', to: 'uhd-web' } },
      {
        instanceId: 2,
        op: 'tag.merge',
        payload: { sourceTagIds: [22], targetTagId: 99, deleteSources: true },
      },
    ]);
  });

  it('a switch chains create -> move -> delete with dependencies per instance', async () => {
    const queue = useQueueStore();

    await queue.remapRootFolder({
      fromPath: '/data/media',
      toPath: '/data/media-4k',
      moveFiles: true,
      mkdirPath: null,
      targets: [
        { instanceId: 1, mediaIds: [10, 11], needsRootFolder: true, removeRootFolderId: 5 },
        { instanceId: 2, mediaIds: [20], needsRootFolder: false, removeRootFolderId: null },
      ],
    });

    expect(push).toHaveBeenCalledTimes(3);

    // 1. only the instance without the destination gets a create
    expect(push.mock.calls[0]?.[0]).toEqual([
      { instanceId: 1, op: 'rootFolder.create', payload: { path: '/data/media-4k' } },
    ]);

    // 2. the move on instance 1 waits for that create; instance 2 has no dependency
    const moves = push.mock.calls[1]?.[0] ?? [];
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({
      instanceId: 1,
      op: 'media.moveRootFolder',
      payload: { mediaIds: [10, 11], toRootFolderPath: '/data/media-4k', moveFiles: true },
      dependsOnId: 1,
    });
    expect(moves[1]).not.toHaveProperty('dependsOnId');

    // 3. the old folder is only removed after that instance's move succeeded
    const removals = push.mock.calls[2]?.[0] ?? [];
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({
      instanceId: 1,
      op: 'rootFolder.delete',
      // The real path, not a placeholder: it is what marks the old folder's row as pending.
      payload: { rootFolderId: 5, path: '/data/media' },
      dependsOnId: 2,
    });
  });

  it('a switch to a folder that is not on disk yet puts one mkdir at the head of the chain', async () => {
    const queue = useQueueStore();

    await queue.remapRootFolder({
      fromPath: '/data/media',
      toPath: '/data/media-4k',
      moveFiles: true,
      mkdirPath: '/data/media-4k',
      targets: [
        { instanceId: 1, mediaIds: [10], needsRootFolder: true, removeRootFolderId: 5 },
        { instanceId: 2, mediaIds: [20], needsRootFolder: true, removeRootFolderId: 6 },
      ],
    });

    // One disk step for the fleet, and both instances wait on it - *Arr refuses to register a
    // root folder at a path that is not there.
    expect(push.mock.calls[0]?.[0]).toEqual([
      { op: 'fs.mkdir', payload: { path: '/data/media-4k', recursive: true } },
    ]);
    const creates = push.mock.calls[1]?.[0] ?? [];
    expect(creates[0]).toMatchObject({ instanceId: 1, op: 'rootFolder.create', dependsOnId: 1 });
    expect(creates[1]).toMatchObject({ instanceId: 2, op: 'rootFolder.create', dependsOnId: 1 });
  });

  it('an instance with nothing to move still gets its old root folder dropped, after the create', async () => {
    const queue = useQueueStore();

    await queue.remapRootFolder({
      fromPath: '/data/media',
      toPath: '/data/media-4k',
      moveFiles: true,
      mkdirPath: null,
      targets: [
        { instanceId: 1, mediaIds: [], needsRootFolder: true, removeRootFolderId: 5 },
      ],
    });

    // No move item exists, so the cleanup hangs off the create instead of off nothing - the
    // old root folder must never go before the new one is registered.
    const moves = push.mock.calls[1]?.[0] ?? [];
    expect(moves).toHaveLength(0);

    const removals = push.mock.calls[2]?.[0] ?? [];
    expect(removals[0]).toMatchObject({
      instanceId: 1,
      op: 'rootFolder.delete',
      payload: { rootFolderId: 5, path: '/data/media' },
      dependsOnId: 1,
    });
  });

  it('re-aims an import list after the move, and skips the step when none was given', async () => {
    const queue = useQueueStore();

    await queue.remapRootFolder({
      fromPath: '/data/media',
      toPath: '/data/media-4k',
      moveFiles: true,
      mkdirPath: null,
      targets: [
        {
          instanceId: 1,
          mediaIds: [10],
          needsRootFolder: false,
          removeRootFolderId: null,
          importLists: [{ importListId: 7, name: 'Trakt', toRootFolderPath: '/data/media-4k' }],
        },
        // No lists on this one: it must not produce an empty update.
        { instanceId: 2, mediaIds: [20], needsRootFolder: false, removeRootFolderId: null },
      ],
    });

    const updates = push.mock.calls
      .flatMap((call) => call[0])
      .filter((item) => item.op === 'importList.update');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      instanceId: 1,
      payload: { importListId: 7, changes: { rootFolderPath: '/data/media-4k' } },
      // The move for instance 1, so a failed move leaves the list pointing where it was.
      dependsOnId: 1,
    });
  });

  it('never stages a rescan - *Arr answers the move before it has moved anything', async () => {
    const queue = useQueueStore();

    await queue.remapRootFolder({
      fromPath: '/data/media',
      toPath: '/data/media-4k',
      moveFiles: false,
      mkdirPath: null,
      targets: [
        { instanceId: 1, mediaIds: [10, 11], needsRootFolder: false, removeRootFolderId: 8 },
        { instanceId: 2, mediaIds: [], needsRootFolder: false, removeRootFolderId: null },
      ],
    });

    expect(
      push.mock.calls.flatMap((call) => call[0]).filter((item) => item.op === 'media.refresh'),
    ).toHaveLength(0);
  });

  it('a parent rename realigns each nested root folder, not the parent path', async () => {
    const queue = useQueueStore();

    await queue.stageReconcile({
      from: '/data/media/movies/europe',
      to: '/data/media/movies/european',
      removeOldRootFolder: true,
      targets: [
        {
          instanceId: 1,
          fromPath: '/data/media/movies/europe/auto-feed/0k',
          toPath: '/data/media/movies/european/auto-feed/0k',
          mediaIds: [10, 11],
          oldRootFolderId: 8,
        },
        {
          instanceId: 1,
          fromPath: '/data/media/movies/europe/curated-feed/0k',
          toPath: '/data/media/movies/european/curated-feed/0k',
          mediaIds: [12],
          oldRootFolderId: 9,
        },
      ],
    });

    const ops = push.mock.calls.map((call) => call[0]?.[0]).filter((entry) => entry !== undefined);
    expect(ops[0]).toEqual({
      op: 'fs.rename',
      payload: { from: '/data/media/movies/europe', to: '/data/media/movies/european' },
    });
    expect(ops.map((entry) => entry.op)).toEqual([
      'fs.rename',
      'rootFolder.create',
      'media.moveRootFolder',
      'rootFolder.delete',
      'rootFolder.create',
      'media.moveRootFolder',
      'rootFolder.delete',
    ]);
    expect(ops[1]?.payload).toEqual({ path: '/data/media/movies/european/auto-feed/0k' });
    expect(ops[4]?.payload).toEqual({ path: '/data/media/movies/european/curated-feed/0k' });
    expect(ops[3]?.payload).toEqual({
      rootFolderId: 8,
      path: '/data/media/movies/europe/auto-feed/0k',
    });
    expect(ops[6]?.payload).toEqual({
      rootFolderId: 9,
      path: '/data/media/movies/europe/curated-feed/0k',
    });
  });

  it('staging nothing does not call the API', async () => {
    const queue = useQueueStore();
    await queue.propagateTag('hd', []);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('staged overlay and impact', () => {
  it('indexes staged operations by instance and label, including both sides of a rename', async () => {
    list.mockResolvedValue({
      items: [
        item('tag.create', 1),
        item('tag.rename', 2),
        item('tag.delete', 3),
        item('rootFolder.create', 4, {
          targetKind: 'rootFolder',
          targetLabel: '/data/media',
        }),
      ],
      activeRun: null,
    });

    const queue = useQueueStore();
    await queue.load();

    expect(queue.stagedForTag(1, 'hd')).toHaveLength(1);
    // A rename touches the old label and the new one.
    expect(queue.stagedForTag(2, 'hd')).toHaveLength(1);
    expect(queue.stagedForTag(2, '1080p')).toHaveLength(1);
    expect(queue.stagedForTag(3, 'hd')[0]?.op).toBe('tag.delete');
    expect(queue.stagedForTag(1, 'other')).toEqual([]);
    expect(queue.stagedForRootFolder(4, '/data/media')).toHaveLength(1);
  });

  it('summarises impact as distinct targets, instances and operations', async () => {
    list.mockResolvedValue({
      items: [
        item('tag.create', 1),
        item('tag.create', 2),
        item('rootFolder.create', 1, { targetKind: 'rootFolder', targetLabel: '/data/media' }),
        item('media.moveRootFolder', 3, {
          targetKind: 'movie',
          targetLabel: '/data/media-4k',
          affectedCount: 12,
        }),
      ],
      activeRun: null,
    });

    const queue = useQueueStore();
    await queue.load();

    expect(queue.impact.operations).toBe(4);
    expect(queue.impact.instances).toBe(3);
    expect(queue.impact.affectedItems).toBe(15);
    expect(queue.impact.byKind).toEqual([
      { kind: 'tag', targets: 1 },
      { kind: 'rootFolder', targets: 1 },
      { kind: 'movie', targets: 1 },
    ]);
  });

  it('groups the drawer by instance and by execution order', async () => {
    list.mockResolvedValue({
      items: [
        item('tag.create', 2, { sortOrder: 3 }),
        item('tag.create', 1, { sortOrder: 1 }),
        item('tag.create', 2, { sortOrder: 2 }),
      ],
      activeRun: null,
    });

    const queue = useQueueStore();
    await queue.load();

    expect(queue.executionOrder.map((entry) => entry.sortOrder)).toEqual([1, 2, 3]);
    expect(queue.groupedByInstance.map((group) => `${group.label}:${group.items.length}`)).toEqual([
      'instance 1:1',
      'instance 2:2',
    ]);
  });

  it('puts filesystem work in its own group, ahead of the instances', async () => {
    list.mockResolvedValue({
      items: [
        item('tag.create', 1, { sortOrder: 2 }),
        item('fs.rename', null, {
          sortOrder: 1,
          targetKind: 'path',
          targetLabel: '/data/media/movies',
          payload: { from: '/data/media/movies', to: '/data/media/films' },
        }),
      ],
      activeRun: null,
    });

    const queue = useQueueStore();
    await queue.load();

    // Disk work has no instance, so it groups under one pseudo-instance and reads first -
    // which is also the order a mixed recipe executes in.
    expect(queue.groupedByInstance.map((group) => group.label)).toEqual([
      'Local storage',
      'instance 1',
    ]);
    // …and it is not counted as an instance in the impact summary.
    expect(queue.impact.instances).toBe(1);
    expect(queue.impact.operations).toBe(2);
    expect(queue.impact.byKind).toEqual([
      { kind: 'tag', targets: 1 },
      { kind: 'path', targets: 1 },
    ]);

    // Both ends of a rename are marked, so the explorer can badge either row.
    expect(queue.stagedForPath('/data/media/movies')).toHaveLength(1);
    expect(queue.stagedForPath('/data/media/films')).toHaveLength(1);
    expect(queue.stagedForPath('/data/media/other')).toEqual([]);
  });
});

describe('the per-media staged index', () => {
  /**
   * Every op that names media ids has to appear here.
   *
   * `mediaIdsOf` is a second exhaustive switch with a `default`, so forgetting a new media op
   * there compiles cleanly and silently loses the row's staged cue. One assertion per op is
   * what turns that into a failing test instead.
   */
  const MEDIA_OPS = [
    'mediaTags.add',
    'mediaTags.remove',
    'mediaTags.set',
    'media.moveRootFolder',
    'media.refresh',
    'media.setMonitored',
    'media.setQualityProfile',
    'media.delete',
  ] as const;

  it('sees every operation that names a media id', async () => {
    for (const op of MEDIA_OPS) {
      setActivePinia(createPinia());
      nextId = 1;
      const queue = useQueueStore();
      list.mockResolvedValue({ items: [item(op, 3)], activeRun: null });
      await queue.load();

      expect(queue.stagedIntentForMedia(3, 1), op).not.toBeNull();
    }
  });

  it('answers nothing for an id nobody staged, and for a filesystem op', async () => {
    const queue = useQueueStore();
    list.mockResolvedValue({
      items: [item('media.delete', 3), item('fs.rename', null)],
      activeRun: null,
    });
    await queue.load();

    expect(queue.stagedIntentForMedia(3, 1)).not.toBeNull();
    expect(queue.stagedIntentForMedia(3, 99)).toBeNull();
    expect(queue.stagedIntentForMedia(4, 1)).toBeNull();
  });

  it('reports the worst intent when two operations name one id', async () => {
    const queue = useQueueStore();
    list.mockResolvedValue({
      items: [item('media.setMonitored', 3), item('media.delete', 3)],
      activeRun: null,
    });
    await queue.load();

    // update vs destroy: the row has to warn about the delete, not the monitor flip
    expect(queue.stagedIntentForMedia(3, 1)?.tone).toBe('destroy');
  });
});
