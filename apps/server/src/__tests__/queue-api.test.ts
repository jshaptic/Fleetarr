import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type {
  ClearQueueResponse,
  ConnectionTestResult,
  InstanceListResponse,
  InstanceResponse,
  MediaPageResponse,
  QueueItem,
  QueueItemDetailResponse,
  QueueListResponse,
  ResourceSnapshotResponse,
  RunResponse,
} from '@fleetarr/shared';
import { startFakeArr, serverApiKey, type FakeArrServer } from './fake-arr.js';
import {
  api,
  makeTempDir,
  readSse,
  removeTempDir,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';

interface ErrorBody {
  error: { code: string; message: string };
}

describe('instances, resources and the staging queue over HTTP', () => {
  let arr: FakeArrServer;
  let server: TestApp;
  let configDir: string;
  let instanceId = 0;

  const queue = async (): Promise<QueueListResponse> =>
    (await api<QueueListResponse>(server.url, '/queue')).body;

  const run = async (runId: number): Promise<RunResponse> =>
    (await api<RunResponse>(server.url, `/queue/runs/${runId}`)).body;

  before(async () => {
    arr = await startFakeArr({ kind: 'radarr' });
    configDir = makeTempDir();
    server = await startTestApp(configDir);
  });

  after(async () => {
    await server.close();
    await arr.close();
    removeTempDir(configDir);
  });

  // ------------------------------------------------------------------ instances

  test('creates an instance and probes it in the same request', async () => {
    const created = await api<InstanceResponse>(server.url, '/instances', {
      method: 'POST',
      body: {
        name: 'Radarr',
        kind: 'radarr',
        baseUrl: `${arr.url}/`, // trailing slash must be normalised away
        apiKey: serverApiKey(),
      },
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.instance.baseUrl, arr.url);
    assert.equal(created.body.test?.ok, true);
    assert.equal(created.body.instance.appVersion, '5.14.0.9383');
    assert.ok(created.body.instance.lastConnectedAt);

    instanceId = created.body.instance.id;

    const list = await api<InstanceListResponse>(server.url, '/instances');
    assert.equal(list.body.instances.length, 1);
    // The API key must never leave the server.
    assert.equal('apiKey' in list.body.instances[0]!, false);
  });

  test('rejects a duplicate instance with 409', async () => {
    const duplicate = await api<ErrorBody>(server.url, '/instances', {
      method: 'POST',
      body: { name: 'Radarr', kind: 'radarr', baseUrl: arr.url, apiKey: serverApiKey() },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'conflict');
  });

  test('rejects an invalid instance payload with 400', async () => {
    const invalid = await api<ErrorBody>(server.url, '/instances', {
      method: 'POST',
      body: { name: 'Bad', kind: 'radarr', baseUrl: 'not-a-url', apiKey: 'short' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'validation_failed');
  });

  test('tests unsaved credentials without storing them', async () => {
    const bad = await api<ConnectionTestResult>(server.url, '/instances/test', {
      method: 'POST',
      body: { kind: 'radarr', baseUrl: arr.url, apiKey: 'definitely-wrong-key' },
    });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error?.code, 'arr_unauthorized');

    const list = await api<InstanceListResponse>(server.url, '/instances');
    assert.equal(list.body.instances.length, 1, 'a candidate test must not create a row');
  });

  // ------------------------------------------------------------------ resources

  test('serves tags, root folders, import lists and quality profiles, then caches them', async () => {
    const first = await api<ResourceSnapshotResponse>(server.url, `/instances/${instanceId}/resources`);
    assert.equal(first.status, 200);
    assert.equal(first.body.tags.length, 3);
    assert.equal(first.body.rootFolders.length, 2);
    assert.equal(first.body.importLists.length, 1);
    assert.equal(first.body.qualityProfiles.length, 2);
    assert.equal(first.body.qualityProfiles.find((profile) => profile.id === 1)?.name, 'HD-1080p');
    assert.equal(first.body.collections?.length, 2);
    assert.equal(first.body.collections?.[0]?.title, 'Dune Collection');
    assert.deepEqual(
      first.body.tags.find((tag) => tag.label === 'hd')?.movieIds,
      [10, 11],
    );

    const requestsAfterFirst = arr.requests.length;
    const second = await api<ResourceSnapshotResponse>(server.url, `/instances/${instanceId}/resources`);
    assert.equal(second.body.fetchedAt, first.body.fetchedAt);
    assert.equal(arr.requests.length, requestsAfterFirst, 'second read must come from the cache');

    const refreshed = await api<ResourceSnapshotResponse>(
      server.url,
      `/instances/${instanceId}/resources?refresh=true`,
    );
    assert.ok(arr.requests.length > requestsAfterFirst);
    assert.ok(refreshed.body.fetchedAt >= first.body.fetchedAt);
  });

  test('pages and filters the media list', async () => {
    const page1 = await api<MediaPageResponse>(
      server.url,
      `/instances/${instanceId}/media?page=1&pageSize=2`,
    );
    assert.equal(page1.body.totalItems, 4);
    assert.equal(page1.body.totalPages, 2);
    assert.equal(page1.body.items.length, 2);

    const page2 = await api<MediaPageResponse>(
      server.url,
      `/instances/${instanceId}/media?page=2&pageSize=2`,
    );
    assert.equal(page2.body.items.length, 2);
    assert.notDeepEqual(page1.body.items[0]?.id, page2.body.items[0]?.id);

    const search = await api<MediaPageResponse>(
      server.url,
      `/instances/${instanceId}/media?search=dune`,
    );
    assert.equal(search.body.totalItems, 1);
    assert.equal(search.body.items[0]?.title, 'Dune');

    const byTag = await api<MediaPageResponse>(server.url, `/instances/${instanceId}/media?tagId=1`);
    assert.equal(byTag.body.totalItems, 2);
  });

  // ---------------------------------------------------------------- staging

  test('stages a batch of actions atomically', async () => {
    const staged = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        items: [
          { instanceId, op: 'tag.rename', payload: { tagId: 1, from: 'hd', to: '1080p' } },
          { instanceId, op: 'mediaTags.add', payload: { mediaIds: [12, 13], tagIds: [2] } },
          {
            instanceId,
            op: 'media.moveRootFolder',
            payload: { mediaIds: [10], toRootFolderPath: '/data/media-4k', moveFiles: true },
          },
        ],
      },
    });

    assert.equal(staged.status, 201);
    assert.equal(staged.body.items.length, 3);
    assert.deepEqual(
      staged.body.items.map((item) => item.summary),
      [
        'Rename tag "hd" to "1080p"',
        'Add 1 tag(s) to 2 item(s)',
        'Move 1 item(s) to /data/media-4k (moving files on disk)',
      ],
    );
    assert.deepEqual(
      staged.body.items.map((item) => item.affectedCount),
      [1, 2, 1],
    );
    assert.equal(staged.body.items.every((item) => item.status === 'pending'), true);

    // Nothing may have reached the instance yet.
    assert.equal(arr.state.tags.find((tag) => tag.id === 1)?.label, 'hd');
  });

  test('rejects a malformed payload without staging anything', async () => {
    const before = (await queue()).items.length;
    const invalid = await api<ErrorBody>(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'tag.rename', payload: { tagId: 1 } },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await queue()).items.length, before);
  });

  test('reorders pending items', async () => {
    const before = await queue();
    const reversed = [...before.items].map((item) => item.id).reverse();

    const reordered = await api<{ items: QueueItem[] }>(server.url, '/queue/reorder', {
      method: 'PATCH',
      body: { itemIds: reversed },
    });
    assert.deepEqual(reordered.body.items.map((item) => item.id), reversed);

    // Put it back - the run assertions below depend on the original order.
    const restored = await api<{ items: QueueItem[] }>(server.url, '/queue/reorder', {
      method: 'PATCH',
      body: { itemIds: reversed.reverse() },
    });
    assert.deepEqual(
      restored.body.items.map((item) => item.id),
      before.items.map((item) => item.id),
    );
  });

  test('rejects a partial reorder', async () => {
    const items = (await queue()).items;
    const partial = await api<ErrorBody>(server.url, '/queue/reorder', {
      method: 'PATCH',
      body: { itemIds: [items[0]!.id] },
    });
    assert.equal(partial.status, 400);
  });

  // ------------------------------------------------------------------ apply

  test('applies the queue sequentially and streams progress over SSE', async () => {
    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    assert.equal(started.status, 202);
    assert.equal(started.body.run.totalItems, 3);
    const runId = started.body.run.id;

    const events = await readSse(
      `${server.url}/api/queue/runs/${runId}/stream`,
      (event) => event.type === 'run.finished',
    );

    const types = events.map((event) => event.type);
    assert.equal(types.filter((type) => type === 'item.started').length, 3);
    assert.equal(types.filter((type) => type === 'item.finished').length, 3);
    assert.equal(types.at(-1), 'run.finished');

    const finished = await run(runId);
    assert.equal(finished.run.status, 'completed');
    assert.equal(finished.run.succeededItems, 3);
    assert.equal(finished.run.failedItems, 0);
    assert.equal(finished.items.every((item) => item.status === 'succeeded'), true);

    // …and the instance actually changed.
    assert.equal(arr.state.tags.find((tag) => tag.id === 1)?.label, '1080p');
    assert.deepEqual(arr.state.media.find((media) => media.id === 12)?.tags, [3, 2]);
    assert.deepEqual(arr.state.media.find((media) => media.id === 13)?.tags, [2]);
    assert.equal(arr.state.media.find((media) => media.id === 10)?.path, '/data/media-4k/Arrival (2016)');

    const moveResult = finished.items.find((item) => item.op === 'media.moveRootFolder')?.result;
    assert.deepEqual(moveResult, { updated: 1, rootFolderPath: '/data/media-4k', moveFiles: true });
  });

  test('invalidates the cached snapshot after a run mutates the instance', async () => {
    const resources = await api<ResourceSnapshotResponse>(
      server.url,
      `/instances/${instanceId}/resources`,
    );
    assert.equal(resources.body.tags.some((tag) => tag.label === '1080p'), true);
  });

  // ------------------------------------------------------------- safety halt

  test('halts the run on the first failure and leaves later steps untouched', async () => {
    arr.behaviour.rejectTagLabel = 'boom';

    const staged = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        items: [
          { instanceId, op: 'tag.rename', payload: { tagId: 2, from: 'kids', to: 'boom' } },
          { instanceId, op: 'mediaTags.add', payload: { mediaIds: [10], tagIds: [3] } },
          { instanceId, op: 'tag.create', payload: { label: 'never-created' } },
        ],
      },
    });
    const [failing, following, last] = staged.body.items;
    assert.ok(failing && following && last);

    const started = await api<RunResponse>(server.url, '/queue/runs', {
      method: 'POST',
      body: { onError: 'pause' },
    });
    const runId = started.body.run.id;

    const paused = await waitFor(
      () => run(runId),
      (snapshot) => snapshot.run.status === 'paused',
      { label: 'run to pause' },
    );

    assert.equal(paused.run.failedItems, 1);
    assert.equal(paused.run.currentItemId, failing.id);

    const items = new Map(paused.items.map((item) => [item.id, item]));
    assert.equal(items.get(failing.id)?.status, 'failed');
    assert.equal(items.get(failing.id)?.error?.code, 'arr_validation_failed');
    assert.match(items.get(failing.id)?.error?.message ?? '', /Label is not allowed/);
    assert.equal(items.get(failing.id)?.error?.httpStatus, 400);

    // The safety property: nothing after the failed step ran.
    assert.equal(items.get(following.id)?.status, 'pending');
    assert.equal(items.get(last.id)?.status, 'pending');
    assert.deepEqual(arr.state.media.find((media) => media.id === 10)?.tags, [1]);
    assert.equal(arr.state.tags.some((tag) => tag.label === 'never-created'), false);
    assert.equal(arr.state.tags.find((tag) => tag.id === 2)?.label, 'kids');
  });

  test('records the failing HTTP exchange for the error drawer', async () => {
    const failed = (await queue()).items.find((item) => item.status === 'failed');
    assert.ok(failed);

    const detail = await api<QueueItemDetailResponse>(server.url, `/queue/${failed.id}`);
    const httpEvent = detail.body.events.find((event) => event.httpStatus === 400);
    assert.ok(httpEvent, 'the failed *Arr call must be in the audit trail');
    assert.equal(httpEvent.httpMethod, 'PUT');
    assert.match(httpEvent.httpUrl ?? '', /\/api\/v3\/tag\/2$/);
    assert.match(httpEvent.requestBody ?? '', /"label":"boom"/);
    assert.match(httpEvent.responseBody ?? '', /Label is not allowed/);
  });

  test('refuses to start a second run while one is paused', async () => {
    const conflict = await api<ErrorBody>(server.url, '/queue/runs', { method: 'POST', body: {} });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'conflict');
  });

  test('resumes a paused run and skips the failed step', async () => {
    const active = (await queue()).activeRun;
    assert.ok(active);

    const resumed = await api<RunResponse>(server.url, `/queue/runs/${active.id}/resume`, {
      method: 'POST',
      body: { skipFailed: true },
    });
    assert.equal(resumed.status, 202);

    const finished = await waitFor(
      () => run(active.id),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'resumed run to finish' },
    );

    assert.equal(finished.run.status, 'completed');
    assert.equal(finished.run.skippedItems, 1);
    assert.equal(finished.run.succeededItems, 2);

    // The steps behind the halt ran once the queue was released.
    assert.deepEqual(arr.state.media.find((media) => media.id === 10)?.tags, [1, 3]);
    assert.equal(arr.state.tags.some((tag) => tag.label === 'never-created'), true);

    arr.behaviour.rejectTagLabel = null;
  });

  // -------------------------------------------------------------- dependencies

  test('chains a created tag into the step that assigns it', async () => {
    await api<ClearQueueResponse>(server.url, '/queue', { method: 'DELETE' });

    const created = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'tag.create', payload: { label: 'chained' } },
    });
    const tagStep = created.body.items[0];
    assert.ok(tagStep);

    const assign = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        instanceId,
        op: 'mediaTags.add',
        // The tag does not exist yet - its id comes from the step above.
        payload: { mediaIds: [11, 12], tagIds: [] },
        dependsOnId: tagStep.id,
      },
    });
    assert.equal(assign.status, 201);
    assert.match(assign.body.items[0]?.summary ?? '', /tag created in step/);

    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    const finished = await waitFor(
      () => run(started.body.run.id),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'chained run to finish' },
    );

    assert.equal(finished.run.status, 'completed');
    const newTag = arr.state.tags.find((tag) => tag.label === 'chained');
    assert.ok(newTag, 'the dependency step must have created the tag');
    assert.equal(arr.state.media.find((media) => media.id === 11)?.tags.includes(newTag.id), true);
    assert.equal(arr.state.media.find((media) => media.id === 12)?.tags.includes(newTag.id), true);
  });

  test('rejects an empty tag list that has no dependency to supply one', async () => {
    const invalid = await api<ErrorBody>(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'mediaTags.add', payload: { mediaIds: [11], tagIds: [] } },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error.message, /dependsOnId/);
  });

  test('skips a step whose dependency failed', async () => {
    await api<ClearQueueResponse>(server.url, '/queue', { method: 'DELETE' });

    // A duplicate label makes the *Arr instance reject the create with a 400.
    const created = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'tag.create', payload: { label: 'chained' } },
    });
    const failing = created.body.items[0];
    assert.ok(failing);

    const dependent = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        instanceId,
        op: 'mediaTags.add',
        payload: { mediaIds: [13], tagIds: [] },
        dependsOnId: failing.id,
      },
    });
    const skipped = dependent.body.items[0];
    assert.ok(skipped);

    const started = await api<RunResponse>(server.url, '/queue/runs', {
      method: 'POST',
      body: { onError: 'continue' },
    });
    const finished = await waitFor(
      () => run(started.body.run.id),
      (snapshot) => snapshot.run.finishedAt !== null,
      { label: 'dependency run to finish' },
    );

    const items = new Map(finished.items.map((item) => [item.id, item]));
    assert.equal(items.get(failing.id)?.status, 'failed');
    assert.equal(items.get(skipped.id)?.status, 'skipped');
    assert.match(items.get(skipped.id)?.error?.message ?? '', /Depends on item/);
    assert.deepEqual(arr.state.media.find((media) => media.id === 13)?.tags, [2]);
  });

  // --------------------------------------------------------------- cancelling

  test('cancels a running queue and stands down the remaining steps', async () => {
    await api<ClearQueueResponse>(server.url, '/queue', { method: 'DELETE' });
    arr.behaviour.delayMs = 250;

    const staged = await api<{ items: QueueItem[] }>(server.url, '/queue', {
      method: 'POST',
      body: {
        items: [
          { instanceId, op: 'tag.create', payload: { label: 'slow-one' } },
          { instanceId, op: 'tag.create', payload: { label: 'slow-two' } },
          { instanceId, op: 'tag.create', payload: { label: 'slow-three' } },
        ],
      },
    });
    assert.equal(staged.body.items.length, 3);

    const started = await api<RunResponse>(server.url, '/queue/runs', { method: 'POST', body: {} });
    const runId = started.body.run.id;

    await new Promise((resolve) => setTimeout(resolve, 120));
    const cancelled = await api<RunResponse>(server.url, `/queue/runs/${runId}/cancel`, {
      method: 'POST',
    });

    assert.equal(cancelled.body.run.status, 'cancelled');
    assert.ok(cancelled.body.run.finishedAt);
    assert.equal(
      cancelled.body.items.every((item) => item.status !== 'pending' && item.status !== 'running'),
      true,
      'no item may be left pending or running after a cancel',
    );
    assert.ok(arr.state.tags.filter((tag) => tag.label.startsWith('slow-')).length < 3);

    arr.behaviour.delayMs = 0;
  });

  test('clears finished items from the queue', async () => {
    const cleared = await api<ClearQueueResponse>(server.url, '/queue', { method: 'DELETE' });
    assert.ok(cleared.body.removed > 0);
    assert.equal((await queue()).items.length, 0);
  });
});

describe('recovery after an interrupted run', () => {
  let arr: FakeArrServer;
  let configDir: string;

  before(async () => {
    arr = await startFakeArr({ kind: 'radarr' });
    configDir = makeTempDir();
  });

  after(async () => {
    await arr.close();
    removeTempDir(configDir);
  });

  test('parks a run left mid-flight by a restart as paused', async () => {
    const first = await startTestApp(configDir);
    const created = await api<InstanceResponse>(first.url, '/instances', {
      method: 'POST',
      body: { name: 'Radarr', kind: 'radarr', baseUrl: arr.url, apiKey: serverApiKey() },
    });
    const instanceId = created.body.instance.id;

    await api(first.url, '/queue', {
      method: 'POST',
      body: { instanceId, op: 'tag.create', payload: { label: 'interrupted' } },
    });

    // Simulate a process kill in the middle of step 1.
    first.db.exec(`
      INSERT INTO queue_runs (status, on_error, total_items) VALUES ('running', 'pause', 1);
      UPDATE queue_items SET status = 'running', run_id = (SELECT MAX(id) FROM queue_runs);
    `);
    await first.close();

    const second = await startTestApp(configDir);
    try {
      const runs = await api<{ runs: Array<{ id: number; status: string; error: string | null }> }>(
        second.url,
        '/queue/runs',
      );
      const recovered = runs.body.runs[0];
      assert.ok(recovered);
      assert.equal(recovered.status, 'paused');
      assert.match(recovered.error ?? '', /restart/);

      const items = (await api<QueueListResponse>(second.url, '/queue')).body.items;
      assert.equal(items[0]?.status, 'failed');
      assert.equal(items[0]?.error?.code, 'interrupted');
    } finally {
      await second.close();
    }
  });
});
