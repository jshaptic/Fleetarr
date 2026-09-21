import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { ArrMedia, InstanceWithKey } from '@fleetarr/shared';
import { ArrClient, pageMedia } from '../arr/client.js';
import { ArrDispatcherPool } from '../arr/http.js';
import { ArrApiError } from '../lib/errors.js';
import { startFakeArr, serverApiKey, type FakeArrServer } from './fake-arr.js';

/** A port nothing is listening on - allocated then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function instanceFor(server: FakeArrServer, overrides: Partial<InstanceWithKey> = {}): InstanceWithKey {
  return {
    id: 1,
    name: 'test',
    kind: server.kind,
    baseUrl: server.url,
    apiKey: serverApiKey(),
    verifySsl: true,
    enabled: true,
    timeoutMs: 5000,
    appVersion: null,
    lastConnectedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('ArrClient', () => {
  let radarr: FakeArrServer;
  let sonarr: FakeArrServer;
  const pool = new ArrDispatcherPool();

  const clientFor = (server: FakeArrServer, overrides: Partial<InstanceWithKey> = {}): ArrClient => {
    const instance = instanceFor(server, overrides);
    return new ArrClient(instance, { dispatcher: pool.createEphemeral({ verifySsl: true, timeoutMs: instance.timeoutMs }) });
  };

  before(async () => {
    radarr = await startFakeArr({ kind: 'radarr' });
    sonarr = await startFakeArr({ kind: 'sonarr' });
  });

  after(async () => {
    await pool.closeAll();
    await radarr.close();
    await sonarr.close();
  });

  test('reads system status and reports a successful connection test', async () => {
    const result = await clientFor(radarr).testConnection();
    assert.equal(result.ok, true);
    assert.equal(result.appVersion, '5.14.0.9383');
    assert.equal(result.instanceName, 'Radarr');
  });

  test('parses a narrow view while preserving the raw body', async () => {
    const media = await clientFor(radarr).listMedia();
    const first = media[0];
    assert.ok(first);
    assert.equal(first.view.title, 'Arrival');
    // `images` is not in the schema, so it is stripped from the view...
    assert.equal('images' in first.view, false);
    // ...but survives untouched on the raw body, which is what PUTs send back.
    assert.ok(Array.isArray(first.raw['images']));
  });

  test('targets /series for a Sonarr instance', async () => {
    const media = await clientFor(sonarr).listMedia();
    assert.equal(media.length, 4);
    assert.ok(sonarr.requests.some((entry) => entry.path === '/series'));
    assert.equal(sonarr.requests.some((entry) => entry.path === '/movie'), false);
  });

  test('bulk edit adds and removes tags through the editor endpoint', async () => {
    const client = clientFor(radarr);

    const added = await client.bulkEditMedia({ mediaIds: [12, 13], tags: [2], applyTags: 'add' });
    assert.equal(added, 2);
    assert.deepEqual(radarr.state.media.find((m) => m.id === 13)?.tags, [2]);

    await client.bulkEditMedia({ mediaIds: [13], tags: [2], applyTags: 'remove' });
    assert.deepEqual(radarr.state.media.find((m) => m.id === 13)?.tags, []);
  });

  test('sends seriesIds rather than movieIds for Sonarr', async () => {
    await clientFor(sonarr).bulkEditMedia({ mediaIds: [10], tags: [3], applyTags: 'add' });
    assert.deepEqual(sonarr.state.media.find((m) => m.id === 10)?.tags, [1, 3]);
  });

  test('root folder move only rewrites paths when moveFiles is set', async () => {
    const client = clientFor(radarr);

    await client.bulkEditMedia({ mediaIds: [11], rootFolderPath: '/data/media-4k', moveFiles: false });
    assert.equal(radarr.state.media.find((m) => m.id === 11)?.path, '/data/media/Dune (2021)');

    await client.bulkEditMedia({ mediaIds: [11], rootFolderPath: '/data/media-4k', moveFiles: true });
    assert.equal(radarr.state.media.find((m) => m.id === 11)?.path, '/data/media-4k/Dune (2021)');
  });

  test('import list PUT round-trips fields the client never parses', async () => {
    const client = clientFor(radarr);
    const current = await client.getImportList(1);

    // Only the changed key is merged onto the raw body.
    await client.putImportList(1, { ...current.raw, qualityProfileId: 7 });

    const list = radarr.state.importLists[0];
    assert.equal(list?.qualityProfileId, 7);
    // The fake rejects a PUT that drops this field - exactly like the real apps.
    assert.equal(list?.secretServerField, 'must-survive-put');
  });

  test('lists quality profiles by name while keeping the raw body', async () => {
    const profiles = await clientFor(radarr).listQualityProfiles();
    const hd = profiles.find((entry) => entry.view.id === 1);
    assert.ok(hd);
    assert.equal(hd.view.name, 'HD-1080p');
    assert.equal('cutoff' in hd.view, false);
    assert.equal(hd.raw['cutoff'], 7);
  });

  test('maps a 400 validation body to a readable message', async () => {
    await assert.rejects(
      () => clientFor(radarr).createTag(''),
      (error: unknown) => {
        assert.ok(error instanceof ArrApiError);
        assert.equal(error.code, 'arr_validation_failed');
        assert.equal(error.message, 'Label: Label must not be empty');
        assert.equal(error.httpStatus, 400);
        return true;
      },
    );
  });

  test('maps a rejected API key to arr_unauthorized', async () => {
    const result = await clientFor(radarr, { apiKey: 'wrong-key-entirely' }).testConnection();
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'arr_unauthorized');
  });

  test('maps a wrong URL base to arr_not_found', async () => {
    const result = await clientFor(radarr, { baseUrl: `${radarr.url}/radarr` }).testConnection();
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'arr_not_found');
    assert.match(result.error?.message ?? '', /base URL/);
  });

  test('maps a slow instance to arr_timeout', async () => {
    radarr.behaviour.delayMs = 300;
    try {
      const result = await clientFor(radarr, { timeoutMs: 1000 }).testConnection();
      assert.equal(result.ok, true, 'sanity: 300ms is fine with a 1s timeout');

      const timedOut = await clientFor(radarr, { timeoutMs: 100 }).testConnection();
      assert.equal(timedOut.ok, false);
      assert.equal(timedOut.error?.code, 'arr_timeout');
    } finally {
      radarr.behaviour.delayMs = 0;
    }
  });

  test('maps a closed port to arr_unreachable', async () => {
    const result = await clientFor(radarr, { baseUrl: `http://127.0.0.1:${await closedPort()}` }).testConnection();
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'arr_unreachable');
  });

  test('maps an HTML login page to arr_unexpected_response', async () => {
    radarr.behaviour.serveHtml = true;
    try {
      const result = await clientFor(radarr).testConnection();
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'arr_unexpected_response');
    } finally {
      radarr.behaviour.serveHtml = false;
    }
  });

  test('reports which media a tag is attached to', async () => {
    const detail = await clientFor(radarr).getTagDetail(1);
    assert.equal(detail.view.label, 'hd');
    assert.deepEqual(detail.view.movieIds, [10, 11]);
  });

  test('lists collections, keeping the raw body for the round trip back', async () => {
    const collections = await clientFor(radarr).listCollections();
    const first = collections[0];
    assert.ok(first);
    assert.equal(first.view.title, 'Dune Collection');
    assert.equal(first.view.rootFolderPath, '/data/media');
    assert.deepEqual(first.view.tags, [1]);
    // Narrow view, whole body: the field nothing parses has to survive to the PUT.
    assert.equal(first.raw['secretServerField'], 'must-survive-put');
  });

  test('asking a Sonarr client for collections is a bug, not an empty answer', async () => {
    await assert.rejects(() => clientFor(sonarr).listCollections(), /only available on Radarr/);
  });

  test('the collection editor patches only the keys it is given', async () => {
    const client = clientFor(radarr);
    const updated = await client.bulkEditCollections({
      collectionIds: [1],
      rootFolderPath: '/data/media-4k',
    });

    assert.equal(updated, 1);
    const after = await client.getCollection(1);
    assert.equal(after.view.rootFolderPath, '/data/media-4k');
    // Untouched by a partial body, which is what makes this endpoint exempt from the
    // merge-before-PUT rule.
    assert.equal(after.view.title, 'Dune Collection');
    assert.deepEqual(after.view.tags, [1]);
  });

  test('a single-collection PUT is a replace, so it must be merged first', async () => {
    const client = clientFor(radarr);
    const current = await client.getCollection(2);

    // The fake refuses a body missing the field it never sent us back, exactly as *Arr
    // wipes what a partial PUT omits.
    await assert.rejects(
      () => client.putCollection(2, { id: 2, tags: [3] }),
      (error: unknown) => error instanceof ArrApiError && error.code === 'arr_validation_failed',
    );

    const merged = await client.putCollection(2, { ...current.raw, tags: [3] });
    assert.deepEqual(merged.view.tags, [3]);
    assert.equal(merged.view.title, 'Heat Collection');
  });
});

describe('pageMedia', () => {
  /** A library where two root folders share a prefix - the trap this guards. */
  const library: ArrMedia[] = [
    { id: 1, title: 'Heat', path: '/data/movies', qualityProfileId: 0, monitored: true, tags: [] },
    { id: 2, title: 'Dune', path: '/data/movies/Dune (2021)', qualityProfileId: 0, monitored: true, tags: [] },
    { id: 3, title: 'Arrival', path: '/data/movies-4k/Arrival (2016)', qualityProfileId: 0, monitored: true, tags: [] },
    { id: 4, title: 'Tenet', path: '/data/movies-4k', qualityProfileId: 0, monitored: true, tags: [] },
  ];

  test('a root folder never captures a sibling that merely shares its prefix', () => {
    const page = pageMedia(library, { rootFolderPath: '/data/movies' });

    assert.deepEqual(
      page.items.map((item) => item.id),
      [1, 2],
      'movies-4k items must not be re-mapped along with movies',
    );
    assert.equal(page.totalItems, 2);
  });

  test('matches the root folder itself and everything under it', () => {
    const under = pageMedia(library, { rootFolderPath: '/data/movies-4k' });
    assert.deepEqual(
      under.items.map((item) => item.id),
      [3, 4],
    );
  });

  test('a trailing slash on the query does not change the result', () => {
    assert.equal(pageMedia(library, { rootFolderPath: '/data/movies/' }).totalItems, 2);
  });

  test("falls back to the item's own rootFolderPath when its path is elsewhere", () => {
    const moved: ArrMedia[] = [
      {
        id: 9,
        title: 'Relocated',
        path: '/elsewhere/Relocated (2019)',
        rootFolderPath: '/data/movies',
        qualityProfileId: 0,
        monitored: true,
        tags: [],
      },
    ];

    assert.equal(pageMedia(moved, { rootFolderPath: '/data/movies' }).totalItems, 1);
  });

  test('totalItems counts every match, not just the current page', () => {
    const page = pageMedia(library, { rootFolderPath: '/data/movies', pageSize: 1, page: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.totalItems, 2);
    assert.equal(page.totalPages, 2);
  });
});
