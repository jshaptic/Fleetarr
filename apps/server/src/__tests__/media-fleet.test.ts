import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ApiErrorResponse, InstanceResponse, MediaFleetResponse, MediaIdsResponse } from '@fleetarr/shared';
import { serverApiKey, startFakeArr, type FakeArrServer } from './fake-arr.js';
import { api, makeTempDir, removeTempDir, startTestApp, type TestApp } from './helpers.js';

/**
 * Three instances, because two of the three things this view has to get right only show up
 * with a mixed fleet: the same film on two Radarrs is one row with two chips, and a Sonarr
 * instance can answer nothing at all about import lists.
 */
describe('the media fleet view', () => {
  let hd: FakeArrServer;
  let uhd: FakeArrServer;
  let tv: FakeArrServer;
  let server: TestApp;
  let configDir: string;
  let hdId = 0;
  let uhdId = 0;
  let tvId = 0;

  const media = (url: string) => api<MediaFleetResponse>(server.url, url);

  before(async () => {
    hd = await startFakeArr({ kind: 'radarr' });
    uhd = await startFakeArr({ kind: 'radarr' });
    tv = await startFakeArr({ kind: 'sonarr' });

    // Arrival is on both Radarrs - the row that has to collapse. Dune is only on HD.
    hd.state.media = hd.state.media.slice(0, 2);
    const arrival = hd.state.media[0];
    assert.ok(arrival, 'the fake should seed a library');
    uhd.state.media = [{ ...arrival, id: 77, path: '/data/media/4k/Arrival (2016)' }];
    uhd.state.rootFolders = [
      {
        id: 1,
        path: '/data/media/4k',
        accessible: true,
        freeSpace: 1,
        totalSpace: 2,
        unmappedFolders: [],
      },
    ];
    uhd.state.tags = [{ id: 9, label: 'remux' }];
    if (uhd.state.media[0] !== undefined) uhd.state.media[0].tags = [9];

    configDir = makeTempDir();
    server = await startTestApp(configDir);

    const register = async (name: string, kind: 'radarr' | 'sonarr', arr: FakeArrServer) => {
      const created = await api<InstanceResponse>(server.url, '/instances', {
        method: 'POST',
        body: { name, kind, baseUrl: arr.url, apiKey: serverApiKey() },
      });
      assert.equal(created.status, 201);
      return created.body.instance.id;
    };

    hdId = await register('Radarr-HD', 'radarr', hd);
    uhdId = await register('Radarr-4K', 'radarr', uhd);
    tvId = await register('Sonarr-TV', 'sonarr', tv);
  });

  after(async () => {
    await server.close();
    await Promise.all([hd.close(), uhd.close(), tv.close()]);
    removeTempDir(configDir);
  });

  test('groups a title held by two instances into one row with two chips', async () => {
    const response = await media('/media?pageSize=500');
    assert.equal(response.status, 200);

    const shared = response.body.rows.find((row) => row.facets.length === 2);
    assert.ok(shared, 'the film both Radarrs hold should be a single row');
    assert.deepEqual(
      [...shared.facets].map((facet) => facet.instanceId).sort((a, b) => a - b),
      [hdId, uhdId],
    );
    assert.equal(shared.instanceCount, 2);
    // Identity came from tmdbId, not from a normalised title
    assert.equal(shared.identityBasis, 'external');
    // Different copies, different paths - never reconciled into one
    assert.notEqual(shared.facets[0]?.path, shared.facets[1]?.path);
  });

  test('a series never merges with a film, and every column is reported', async () => {
    const response = await media('/media?pageSize=500');
    const kinds = new Set(response.body.rows.map((row) => row.kind));
    assert.ok(kinds.has('movie'));
    assert.ok(kinds.has('series'));
    // no row mixes the two
    for (const row of response.body.rows) {
      assert.equal(new Set(row.facets.map((facet) => facet.kind)).size, 1);
    }
    assert.deepEqual(
      response.body.columns.map((column) => column.instanceId).sort((a, b) => a - b),
      [hdId, uhdId, tvId],
    );
  });

  test('per-copy tag labels and profile names are resolved, and never invented', async () => {
    const response = await media('/media?pageSize=500');
    const shared = response.body.rows.find((row) => row.facets.length === 2);
    const onUhd = shared?.facets.find((facet) => facet.instanceId === uhdId);

    assert.deepEqual(onUhd?.tags, ['remux']);
    assert.deepEqual(onUhd?.tagIds, [9]);
    // the row carries labels only: a tag id means nothing one instance over
    assert.ok(shared?.tags.includes('remux'));

    const noProfile = response.body.rows
      .flatMap((row) => row.facets)
      .find((facet) => facet.qualityProfileId !== 1 && facet.qualityProfileId !== 4);
    if (noProfile !== undefined) assert.equal(noProfile.qualityProfileName, null);
  });

  test('a second read comes from the cache, and ?refresh=true does not', async () => {
    await media('/media');
    const before = hd.requests.length;

    await media('/media');
    assert.equal(hd.requests.length, before, 'a cached read must not touch the instance');

    await media('/media?refresh=true');
    assert.ok(hd.requests.length > before, '?refresh=true must re-read');
  });

  test('the import-list read asks Radarr for its cache and nothing upstream', async () => {
    await media('/media?refresh=true');
    const listRead = hd.requests.find((entry) => entry.path === '/importlist/movie');
    assert.ok(listRead, 'Radarr should be asked for its list contents');
    assert.match(listRead.query ?? '', /includeRecommendations=false/);
    assert.match(listRead.query ?? '', /includeTrending=false/);
    assert.match(listRead.query ?? '', /includePopular=false/);
  });

  test('an unreadable filter is a 400 carrying the position, never an unfiltered list', async () => {
    const response = await api<ApiErrorResponse>(server.url, '/media?q=tags%3A%7B4k');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'validation_failed');
    assert.match(JSON.stringify(response.body.error), /unclosed/);
  });

  test('filtering happens on the server, and the counts describe the filter not the page', async () => {
    const all = await media('/media?pageSize=500');
    const filtered = await media('/media?q=tags%3Aremux&pageSize=500');

    assert.ok(filtered.body.counts.matched < all.body.counts.matched);
    assert.equal(filtered.body.rows.length, filtered.body.counts.matched);
    // totals stay the unfiltered fleet - the rollup split
    assert.equal(filtered.body.totals.rows, all.body.totals.rows);
    assert.equal(filtered.body.counts.total, all.body.counts.total);
  });

  test('a matching row keeps every copy, and names the ones that matched', async () => {
    const filtered = await media('/media?q=tags%3Aremux&pageSize=500');
    const shared = filtered.body.rows.find((row) => row.facets.length === 2);
    assert.ok(shared, 'the row should still carry both chips');
    // only the 4K copy has the tag, but the HD chip must still render
    assert.deepEqual(shared.matchedInstanceIds, [uhdId]);
    assert.equal(shared.facets.filter((facet) => facet.matched).length, 1);
  });

  test('paging reports what it left behind', async () => {
    const first = await media('/media?pageSize=1');
    assert.equal(first.body.rows.length, 1);
    assert.equal(first.body.page, 1);
    assert.equal(first.body.truncated, first.body.counts.matched > 1);

    const second = await media('/media?pageSize=1&page=2');
    assert.notEqual(second.body.rows[0]?.key, first.body.rows[0]?.key);
  });

  test('Sonarr cannot answer a list question, so those rows are undecided - never unmatched', async () => {
    const all = await media('/media?pageSize=500');
    const sonarr = all.body.columns.find((column) => column.instanceId === tvId);
    assert.equal(sonarr?.importListsKnown, false);
    assert.equal(sonarr?.importListsUnknownReason, 'unsupported');

    const radarr = all.body.columns.find((column) => column.instanceId === hdId);
    assert.equal(radarr?.importListsKnown, true);

    const hidden = await media('/media?q=list%3Anone&pageSize=500');
    assert.ok(hidden.body.counts.undecided > 0, 'series rows cannot be judged by list:none');
    // and they are absent from the listing rather than reported as "in no list"
    for (const row of hidden.body.rows) assert.notEqual(row.kind, 'series');
    assert.match(
      hidden.body.undecidedReasons[0]?.reason ?? '',
      /not answerable on Sonarr/,
    );

    const shown = await media('/media?q=list%3Anone&undecided=show&pageSize=500');
    assert.equal(shown.body.listing, 'show');
    assert.equal(shown.body.rows.length, shown.body.counts.undecided);
    assert.ok((shown.body.rows[0]?.reasons ?? []).length > 0, 'an undecided row carries its reason');
  });

  test('a Radarr copy carries the lists that hold it', async () => {
    const response = await media('/media?q=list%3A%22Trakt%20watchlist%22&pageSize=500');
    assert.ok(response.body.counts.matched > 0);
    const facet = response.body.rows[0]?.facets.find((entry) => entry.instanceId === hdId);
    assert.deepEqual(facet?.lists, ['Trakt watchlist']);
  });

  test('an instance that stops answering keeps its rows and loses its operations', async () => {
    uhd.behaviour.serveHtml = true;
    try {
      const response = await media('/media?refresh=true&pageSize=500');
      assert.equal(response.status, 200, 'one silent instance must not fail the request');

      const column = response.body.columns.find((entry) => entry.instanceId === uhdId);
      assert.equal(column?.reachable, false);
      assert.equal(column?.errorCode, 'arr_unexpected_response');
      assert.equal(response.body.totals.unreachableInstances, 1);

      // its cached copies still render - the alternative reads as "nobody holds this"
      const shared = response.body.rows.find((row) =>
        row.facets.some((facet) => facet.instanceId === uhdId),
      );
      assert.ok(shared, 'the last known snapshot should still be shown');

      // but no bulk operation may target it
      const ids = await api<MediaIdsResponse>(server.url, '/media/ids');
      assert.equal(
        ids.body.groups.some((group) => group.instanceId === uhdId),
        false,
        'an instance that did not answer must not become an operation',
      );
    } finally {
      uhd.behaviour.serveHtml = false;
      await media('/media?refresh=true');
    }
  });

  test('the id endpoint answers the filter, not the page', async () => {
    const page = await media('/media?q=tags%3Aremux&pageSize=1');
    const ids = await api<MediaIdsResponse>(server.url, '/media/ids?q=tags%3Aremux');

    assert.equal(ids.status, 200);
    assert.equal(ids.body.matched, page.body.counts.matched);
    assert.equal(ids.body.truncated, false);
    // only the copies that matched: the HD copy carries no such tag
    assert.deepEqual(
      ids.body.groups.map((group) => group.instanceId),
      [uhdId],
    );
  });

  test('the vocabulary is the fleet\'s own values, so the filter bar cannot offer a miss', async () => {
    const response = await media('/media');
    assert.ok(response.body.vocabulary.tags.includes('remux'));
    assert.ok(response.body.vocabulary.lists.includes('Trakt watchlist'));
    assert.ok(response.body.vocabulary.qualityProfiles.includes('HD-1080p'));
    assert.deepEqual(
      [...response.body.vocabulary.instances].sort(),
      ['Radarr-4K', 'Radarr-HD', 'Sonarr-TV'],
    );
    // Built from the library, not from /collection - so it still answers on a Radarr too
    // old to have that endpoint.
    assert.deepEqual(response.body.vocabulary.collections, ['Dune Collection']);
  });

  test('a collection is a column and a filter, and a series has none rather than unknown', async () => {
    const all = await media('/media');
    const dune = all.body.rows.find((row) => row.title === 'Dune');
    const shogun = all.body.rows.find((row) => row.kind === 'series');

    assert.equal(dune?.collection, 'Dune Collection');
    // Not null-because-we-could-not-ask: Sonarr has no collections as a matter of fact.
    assert.equal(shogun?.collection, null);

    const filtered = await media('/media?q=collection%3A%22Dune%20Collection%22');
    assert.deepEqual(
      filtered.body.rows.map((row) => row.title),
      ['Dune'],
    );
    assert.equal(filtered.body.counts.undecided, 0, 'a series is a plain no, never undecided');

    const none = await media('/media?q=collection%3Anone');
    // Every series matches - a known absence, not an unknown - and so does any film in no
    // collection. The film that is in one does not. Note the fleet holds a Sonarr series
    // also called Dune: identity is kind-first, so it is a different row and it matches.
    assert.ok(none.body.rows.every((row) => row.collection === null));
    assert.ok(none.body.rows.some((row) => row.kind === 'series'));
    assert.ok(!none.body.rows.some((row) => row.kind === 'movie' && row.title === 'Dune'));
    assert.equal(none.body.counts.undecided, 0);
  });
});
