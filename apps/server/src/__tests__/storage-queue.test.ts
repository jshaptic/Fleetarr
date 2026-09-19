import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  FsPreflight,
  FsRootsResponse,
  InstanceResponse,
  QueueItem,
  QueueListResponse,
  PathMatrixResponse,
  RunResponse,
} from '@fleetarr/shared';
import { serverApiKey, startFakeArr, type FakeArrServer } from './fake-arr.js';
import { api, makeTempDir, removeTempDir, startTestApp, waitFor, type TestApp } from './helpers.js';

interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * The point of Phase 4: disk work and *Arr work in one queue, one dependency chain, one
 * halt. Everything here runs against a real temp filesystem and a fake Radarr.
 */
describe('filesystem operations in the unified queue', () => {
  let arr: FakeArrServer;
  let server: TestApp;
  let configDir: string;
  let media: string;
  let instanceId = 0;

  const movies = (): string => path.join(media, 'movies');

  before(async () => {
    media = makeTempDir();
    mkdirSync(path.join(media, 'movies', 'Arrival (2016)'), { recursive: true });
    writeFileSync(path.join(media, 'movies', 'Arrival (2016)', 'movie.mkv'), 'x'.repeat(4096));
    mkdirSync(path.join(media, 'movies', 'Orphan Film (1999)'), { recursive: true });
    writeFileSync(path.join(media, 'movies', 'Orphan Film (1999)', 'movie.mkv'), 'y'.repeat(1024));
    mkdirSync(path.join(media, 'movies', 'Empty Folder'), { recursive: true });

    arr = await startFakeArr({ kind: 'radarr' });
    // The instance describes the same paths this container sees - the rule Phase 4 documents.
    arr.state.rootFolders = [
      { id: 1, path: path.join(media, 'movies'), accessible: true, freeSpace: 1e9, totalSpace: 4e9, unmappedFolders: [] },
    ];
    arr.state.media = [
      {
        id: 10,
        title: 'Arrival',
        sortTitle: 'arrival',
        path: path.join(media, 'movies', 'Arrival (2016)'),
        rootFolderPath: path.join(media, 'movies'),
        qualityProfileId: 1,
        monitored: true,
        tags: [],
        year: 2016,
        sizeOnDisk: 4096,
        images: [],
      },
      {
        id: 11,
        title: 'Gone Missing',
        sortTitle: 'gone missing',
        path: path.join(media, 'movies', 'Gone Missing (2001)'),
        rootFolderPath: path.join(media, 'movies'),
        qualityProfileId: 1,
        monitored: true,
        tags: [],
        year: 2001,
        sizeOnDisk: 0,
        images: [],
      },
    ];

    configDir = makeTempDir();
    server = await startTestApp(configDir, { fsRoots: [media] });

    const created = await api<InstanceResponse>(server.url, '/instances', {
      method: 'POST',
      body: { name: 'Radarr', kind: 'radarr', baseUrl: arr.url, apiKey: serverApiKey() },
    });
    instanceId = created.body.instance.id;
  });

  after(async () => {
    // Always give the media root its permissions back, but never let cleanup failures
    // stop the server from closing - an open listener keeps the test process alive.
    try {
      chmodSync(media, 0o755);
    } catch {
      // already gone
    }
    await server.close();
    await arr.close();
    removeTempDir(configDir);
    removeTempDir(media);
  });

  // ------------------------------------------------------------- inspection

  test('reports the configured storage roots', async () => {
    const roots = await api<FsRootsResponse>(server.url, '/storage/roots');
    assert.equal(roots.body.enabled, true);
    assert.equal(roots.body.roots[0]?.path, media);
    assert.equal(roots.body.roots[0]?.writable, true);
    assert.ok((roots.body.roots[0]?.freeSpace ?? 0) > 0);
  });

  test('preflight explains a refusal before anything is staged', async () => {
    // The guard reads cached snapshots only, so warm the cache first. Without this the
    // honest answer is "I cannot tell", which the next test covers.
    await api<PathMatrixResponse>(server.url, '/storage/matrix?refresh=true');

    const refused = await api<FsPreflight>(server.url, '/storage/preflight', {
      method: 'POST',
      body: {
        op: 'fs.delete',
        payload: { path: path.join(movies(), 'Arrival (2016)'), recursive: true, force: false },
      },
    });

    assert.equal(refused.body.ok, false);
    assert.deepEqual(refused.body.referencedBy, [instanceId]);
    // The instance holds a film here, which is the one claim no staged operation can clear.
    assert.equal(
      refused.body.checks.find((check) => check.id === 'media_under')?.status,
      'blocker',
    );
    assert.equal(refused.body.measurement?.sizeOnDisk, 4096);

    // And `assumeResolved` does not launder it: the dialog can only promise what it stages.
    const stillRefused = await api<FsPreflight>(server.url, '/storage/preflight', {
      method: 'POST',
      body: {
        op: 'fs.delete',
        payload: { path: path.join(movies(), 'Arrival (2016)'), recursive: true, force: false },
        assumeResolved: { rootFolders: true, importLists: true },
      },
    });
    assert.equal(stillRefused.body.ok, false);

    const allowed = await api<FsPreflight>(server.url, '/storage/preflight', {
      method: 'POST',
      body: {
        op: 'fs.delete',
        payload: { path: path.join(movies(), 'Orphan Film (1999)'), recursive: true, force: false },
      },
    });
    assert.equal(allowed.body.ok, true, 'an orphan is nobody else business');
  });

  // ---------------------------------------------------------------- staging

  test('a filesystem operation stages with no instance', async () => {
    const staged = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        op: 'fs.mkdir',
        payload: { path: path.join(media, 'movies-4k'), recursive: false },
      },
    });

    assert.equal(staged.status, 201);
    const item = staged.body.items[0];
    assert.equal(item?.instanceId, null);
    assert.equal(item?.kind, 'fs');
    assert.equal(item?.targetKind, 'path');
    assert.equal(item?.summary, `Create directory ${path.join(media, 'movies-4k')}`);
  });

  test('refuses to stage a path outside the roots, and an *Arr op without an instance', async () => {
    const escape = await api<ErrorBody>(server.url, '/queue', {
      method: 'POST',
      body: { op: 'fs.delete', payload: { path: '/etc/cron.d', recursive: true, force: true } },
    });
    assert.equal(escape.status, 403);
    assert.equal(escape.body.error.code, 'fs_forbidden_path');

    const noInstance = await api<ErrorBody>(server.url, '/queue', {
      method: 'POST',
      body: { op: 'tag.create', payload: { label: 'x' } },
    });
    assert.equal(noInstance.status, 400);
    assert.match(noInstance.body.error.message, /validation/i);

    const wrongInstance = await api<ErrorBody>(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'fs.mkdir', payload: { path: path.join(media, 'x'), recursive: false } },
    });
    assert.equal(wrongInstance.status, 400);
  });

  test('applies the staged directory creation', async () => {
    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    const finished = await waitFor(
      () => api<RunResponse>(server.url, `/queue/runs/${started.body.run.id}`).then((r) => r.body),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'mkdir run' },
    );

    assert.equal(finished.run.status, 'completed');
    assert.equal(statSync(path.join(media, 'movies-4k')).isDirectory(), true);

    // The disk work is in the same audit trail as an HTTP exchange.
    const detail = await api<{ events: Array<{ message: string; requestBody: string | null }> }>(
      server.url,
      `/queue/${finished.items[0]?.id ?? 0}`,
    );
    assert.ok(detail.body.events.some((event) => event.message.startsWith('mkdir ')));
  });

  // ------------------------------------------------- the mixed-mode recipe

  test('Reconcile & Align: rename on disk, then realign the instance without a copy', async () => {
    await api(server.url, '/queue', { method: 'DELETE' });
    const from = movies();
    const to = path.join(media, 'films');

    // 1. the disk step
    const rename = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: { op: 'fs.rename', payload: { from, to } },
    });
    const renameId = rename.body.items[0]?.id ?? 0;

    // 2. the destination root folder, only after the rename succeeded
    const rootFolder = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        instanceId,
        op: 'rootFolder.create',
        payload: { path: to },
        dependsOnId: renameId,
      },
    });
    const rootFolderId = rootFolder.body.items[0]?.id ?? 0;

    // 3. point the media at it - moveFiles false, because the bytes already moved
    const realign = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        instanceId,
        op: 'media.moveRootFolder',
        payload: { mediaIds: [10], toRootFolderPath: to, moveFiles: false },
        dependsOnId: rootFolderId,
      },
    });
    const realignId = realign.body.items[0]?.id ?? 0;

    // 4. and make the instance look at the new paths
    await api(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'media.refresh', payload: { mediaIds: [10] }, dependsOnId: realignId },
    });

    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    const finished = await waitFor(
      () => api<RunResponse>(server.url, `/queue/runs/${started.body.run.id}`).then((r) => r.body),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'reconcile run', timeoutMs: 10_000 },
    );

    assert.equal(finished.run.status, 'completed');
    assert.equal(finished.run.succeededItems, 4);

    // the disk moved…
    assert.equal(statSync(to).isDirectory(), true);
    assert.deepEqual(readdirSync(to).sort(), ['Arrival (2016)', 'Empty Folder', 'Orphan Film (1999)']);
    assert.throws(() => statSync(from));

    // …and the instance follows, without being told to copy anything
    assert.ok(arr.state.rootFolders.some((folder) => folder.path === to));
    const movie = arr.state.media.find((entry) => entry.id === 10);
    assert.equal(movie?.rootFolderPath, to);
    assert.equal(
      movie?.path,
      path.join(from, 'Arrival (2016)'),
      'moveFiles: false means *Arr did not relocate anything itself',
    );
    assert.equal(arr.state.commands.at(-1)?.name, 'RefreshMovie');
  });

  test('a failed disk step halts the queue before any *Arr call', async () => {
    await api(server.url, '/queue', { method: 'DELETE' });
    const from = path.join(media, 'films');
    const to = path.join(media, 'library');

    const rename = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: { op: 'fs.rename', payload: { from, to } },
    });
    const renameId = rename.body.items[0]?.id ?? 0;

    await api(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'rootFolder.create', payload: { path: to }, dependsOnId: renameId },
    });

    const rootFoldersBefore = arr.state.rootFolders.length;
    const requestsBefore = arr.requests.length;

    // Take away write permission on the parent: the rename cannot succeed.
    chmodSync(media, 0o500);
    try {
      const started = await api<RunResponse>(server.url, '/queue/runs', {
        method: 'POST',
        body: { onError: 'pause' },
      });
      const paused = await waitFor(
        () => api<RunResponse>(server.url, `/queue/runs/${started.body.run.id}`).then((r) => r.body),
        (snapshot) => snapshot.run.status === 'paused',
        { label: 'halt on the disk step' },
      );

      const items = new Map(paused.items.map((item) => [item.id, item]));
      assert.equal(items.get(renameId)?.status, 'failed');
      assert.equal(items.get(renameId)?.error?.code, 'fs_permission_denied');

      // The dependent *Arr step never ran, and the instance was never contacted.
      const dependent = paused.items.find((item) => item.op === 'rootFolder.create');
      assert.equal(dependent?.status, 'pending');
      assert.equal(arr.state.rootFolders.length, rootFoldersBefore);
      assert.equal(arr.requests.length, requestsBefore, 'no *Arr request was made');
      assert.equal(statSync(from).isDirectory(), true, 'the disk is untouched');
    } finally {
      chmodSync(media, 0o755);
    }
  });

  test('the halted run resumes once the cause is fixed', async () => {
    const active = (await api<QueueListResponse>(server.url, '/queue')).body.activeRun;
    assert.ok(active);

    const resumed = await api<RunResponse>(server.url, `/queue/runs/${active.id}/resume`, {
      method: 'POST',
      body: { retryFailed: true },
    });
    assert.equal(resumed.status, 202);

    const finished = await waitFor(
      () => api<RunResponse>(server.url, `/queue/runs/${active.id}`).then((r) => r.body),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'resumed run' },
    );

    assert.equal(finished.run.status, 'completed');
    assert.equal(statSync(path.join(media, 'library')).isDirectory(), true);
    assert.ok(arr.state.rootFolders.some((folder) => folder.path === path.join(media, 'library')));
  });

  test('refuses a reorder that would put a delete ahead of the unassign protecting it', async () => {
    await api(server.url, '/queue', { method: 'DELETE' });

    const unassign = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        instanceId,
        op: 'rootFolder.delete',
        payload: { rootFolderId: 1, path: path.join(media, 'library') },
      },
    });
    const producerId = unassign.body.items[0]?.id ?? 0;
    const deletion = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        op: 'fs.delete',
        payload: { path: path.join(media, 'library'), recursive: true, force: false },
        dependsOnId: producerId,
      },
    });
    const dependentId = deletion.body.items[0]?.id ?? 0;

    // The executor takes items strictly in sort order and never defers: a dependent whose
    // producer has not run is skipped for good. So this order would not reorder the chain,
    // it would drop the unassign's whole reason for existing and delete the folder anyway.
    const refused = await api<ErrorBody>(server.url, '/queue/reorder', {
      method: 'PATCH',
      body: { itemIds: [dependentId, producerId] },
    });

    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /depends on/);

    // The order it was staged in is still accepted.
    const allowed = await api<{ items: QueueItem[] }>(server.url, '/queue/reorder', {
      method: 'PATCH',
      body: { itemIds: [producerId, dependentId] },
    });
    assert.equal(allowed.status, 200);

    // Staged but never run, and `DELETE /queue` only clears finished work - so these two
    // have to go by id, or the next test's run would apply them to the shared library.
    await api(server.url, `/queue/${String(dependentId)}`, { method: 'DELETE' });
    await api(server.url, `/queue/${String(producerId)}`, { method: 'DELETE' });
  });

  test('pruning an orphan reports what it reclaimed', async () => {
    await api(server.url, '/queue', { method: 'DELETE' });
    const orphan = path.join(media, 'library', 'Orphan Film (1999)');

    await api(server.url, '/queue', {
      method: 'POST',
      body: { op: 'fs.delete', payload: { path: orphan, recursive: true, force: false } },
    });

    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    const finished = await waitFor(
      () => api<RunResponse>(server.url, `/queue/runs/${started.body.run.id}`).then((r) => r.body),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'prune run' },
    );

    assert.equal(finished.run.status, 'completed');
    assert.throws(() => statSync(orphan));
    assert.deepEqual(finished.items[0]?.result, {
      path: orphan,
      freedBytes: 1024,
      fileCount: 1,
    });
  });

  test('a root folder created by a run is visible on the next read, not 30s later', async () => {
    await api(server.url, '/queue', { method: 'DELETE' });
    const added = path.join(media, 'audiobooks');
    mkdirSync(added, { recursive: true });

    const rootFolderPaths = async (): Promise<number> =>
      (await api<PathMatrixResponse>(server.url, '/storage/matrix')).body.totals.rootFolderPaths;

    // Populate the cache first - that is what used to go stale.
    const before = await rootFolderPaths();

    await api(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'rootFolder.create', payload: { path: added } },
    });
    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    const finished = await waitFor(
      () => api<RunResponse>(server.url, `/queue/runs/${started.body.run.id}`).then((r) => r.body),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'root folder create run' },
    );
    assert.equal(finished.run.status, 'completed');

    // No ?refresh: an *Arr item has to invalidate the joined view on its own.
    assert.equal(
      await rootFolderPaths(),
      before + 1,
      'the joined view still served a pre-run cache',
    );
  });
});

describe('storage with no roots configured', () => {
  let server: TestApp;
  let configDir: string;

  before(async () => {
    configDir = makeTempDir();
    server = await startTestApp(configDir);
  });

  after(async () => {
    await server.close();
    removeTempDir(configDir);
  });

  test('reports the feature as disabled instead of failing obscurely', async () => {
    const roots = await api<FsRootsResponse>(server.url, '/storage/roots');
    assert.equal(roots.body.enabled, false);
    assert.deepEqual(roots.body.roots, []);

    const listing = await api<ErrorBody>(server.url, '/storage/measure?path=%2Fdata');
    assert.equal(listing.status, 503);
    assert.equal(listing.body.error.code, 'fs_disabled');
    assert.match(listing.body.error.message, /FS_ROOTS/);
  });
});
