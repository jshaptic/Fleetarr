import type { MediaFleetColumn, MediaFleetResponse, MediaIdsResponse, MediaRow } from '@fleetarr/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaParams } from '@/api/media';

/** Every query the store actually sent - the point of most of these tests. */
const calls: MediaParams[] = [];
let response: MediaFleetResponse;
let ids: MediaIdsResponse;
let fail = false;

vi.mock('@/api/media', () => ({
  mediaApi: {
    list: (params: MediaParams = {}) => {
      calls.push(params);
      if (fail) return Promise.reject(new Error('nope'));
      return Promise.resolve(response);
    },
    ids: (params: MediaParams = {}) => {
      calls.push(params);
      return Promise.resolve(ids);
    },
  },
}));

const { useMediaStore } = await import('./media');

function column(id: number, name: string, reachable = true): MediaFleetColumn {
  return {
    instanceId: id,
    name,
    kind: 'radarr',
    reachable,
    error: null,
    errorCode: null,
    fetchedAt: '2026-09-01T00:00:00.000Z',
    itemCount: 1,
    importListsKnown: true,
    importListsUnknownReason: null,
    tags: [],
    qualityProfiles: [],
    rootFolders: [],
    importLists: [],
  };
}

function row(key: string, facets: Array<{ instanceId: number; mediaId: number; matched: boolean }>): MediaRow {
  return {
    key,
    kind: 'movie',
    identityBasis: 'external',
    title: key,
    sortTitle: key,
    year: 2020,
    status: 'released',
    genres: [],
    certification: null,
    runtime: null,
    studio: null,
    collection: null,
    tmdbId: 1,
    tvdbId: null,
    imdbId: null,
    titleSlug: null,
    seriesType: null,
    minimumAvailability: null,
    tags: [],
    instanceCount: facets.length,
    monitoredCount: 0,
    fileCount: 0,
    sizeOnDisk: null,
    addedFirst: null,
    unknownInstanceIds: [],
    matchedInstanceIds: facets.filter((facet) => facet.matched).map((facet) => facet.instanceId),
    facets: facets.map((facet) => ({
      instanceId: facet.instanceId,
      name: `instance ${String(facet.instanceId)}`,
      kind: 'radarr' as const,
      mediaId: facet.mediaId,
      monitored: true,
      hasFile: true,
      sizeOnDisk: null,
      episodes: null,
      path: '/data/x',
      rootFolderPath: '/data',
      qualityProfileId: 1,
      qualityProfileName: 'HD',
      tagIds: [],
      tags: [],
      added: null,
      lists: [],
      listIds: [],
      excludedFromLists: false,
      flags: [],
      matched: facet.matched,
    })),
  };
}

function fleet(rows: MediaRow[], overrides: Partial<MediaFleetResponse> = {}): MediaFleetResponse {
  return {
    scannedAt: '2026-09-08T00:00:00.000Z',
    oldestFetchedAt: '2026-09-01T00:00:00.000Z',
    columns: [column(1, 'A'), column(2, 'B')],
    rows,
    listing: 'hide',
    totals: {
      rows: 900,
      movies: 900,
      series: 0,
      facets: 900,
      onOneInstance: 900,
      onMultipleInstances: 0,
      monitored: 0,
      withFiles: 0,
      sizeOnDisk: null,
      unreachableInstances: 0,
      importListsUnknownInstances: 0,
      weakIdentityRows: 0,
    },
    counts: { matched: 900, undecided: 4, total: 904 },
    undecidedReasons: [{ reason: 'not answerable on Sonarr', rows: 4 }],
    page: 1,
    pageSize: 100,
    truncated: true,
    sort: 'title',
    direction: 'asc',
    filter: { source: '', error: null },
    vocabulary: {
      instances: [],
      tags: [],
      lists: [],
      qualityProfiles: [],
      genres: [],
      certifications: [],
    collections: [],
      rootFolders: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  calls.length = 0;
  fail = false;
  response = fleet([
    row('a', [{ instanceId: 1, mediaId: 11, matched: true }]),
    row('b', [
      { instanceId: 1, mediaId: 12, matched: false },
      { instanceId: 2, mediaId: 22, matched: true },
    ]),
  ]);
  ids = {
    matched: 900,
    truncated: false,
    groups: [{ instanceId: 1, kind: 'radarr', mediaIds: [11, 13, 14] }],
  };
});

describe('the media store', () => {
  it('never sends a filter it cannot read, but keeps what was typed', async () => {
    const store = useMediaStore();
    await store.setFilter('tags:{4k');

    expect(calls).toHaveLength(0);
    expect(store.filter).toBe('tags:{4k');
    expect(store.parsedFilter.error).not.toBeNull();
  });

  it('sends a readable filter as a fresh first page', async () => {
    const store = useMediaStore();
    await store.load();
    await store.setFilter('tags:kids');

    expect(calls.at(-1)).toMatchObject({ filter: 'tags:kids', page: 1 });
  });

  it('reports the server\'s counts, never the number of rows on screen', async () => {
    const store = useMediaStore();
    await store.load();

    expect(store.rows).toHaveLength(2);
    expect(store.summary).toMatchObject({
      loaded: 2,
      matched: 900,
      listed: 900,
      undecided: 4,
      page: 1,
      totalPages: 9,
      truncated: true,
    });
  });

  it('replaces the page rather than appending, and keeps the counts', async () => {
    const store = useMediaStore();
    await store.load();
    response = fleet([row('c', [{ instanceId: 1, mediaId: 33, matched: true }])], { page: 2 });
    await store.goToPage(2);

    expect(store.rows.map((entry) => entry.key)).toEqual(['c']);
    expect(store.summary.matched).toBe(900);
    expect(store.page).toBe(2);
    expect(calls.at(-1)).toMatchObject({ page: 2 });
  });

  it('clears a hand-picked page on navigation, and keeps a whole match', async () => {
    const store = useMediaStore();
    await store.load();
    store.toggleRow('a');
    expect(store.selectedKeys).toEqual(['a']);

    response = fleet([row('c', [{ instanceId: 1, mediaId: 33, matched: true }])], { page: 2 });
    await store.goToPage(2);
    expect(store.selectedKeys).toHaveLength(0);
    expect(store.allMatching).toBeNull();

    response = fleet([row('a', [{ instanceId: 1, mediaId: 11, matched: true }])], { page: 1 });
    await store.goToPage(1);
    await store.selectAllMatching();
    expect(store.allMatching).not.toBeNull();

    response = fleet([row('c', [{ instanceId: 1, mediaId: 33, matched: true }])], { page: 2 });
    await store.goToPage(2);
    expect(store.allMatching).not.toBeNull();
    expect(store.isRowSelected('c')).toBe(true);
  });

  it('drops the whole-match selection when the filter that defined it changes', async () => {
    const store = useMediaStore();
    await store.load();
    await store.selectAllMatching();
    expect(store.allMatching).not.toBeNull();

    await store.setFilter('year<2000');
    expect(store.allMatching).toBeNull();
  });

  it('asks the server for the whole match rather than reusing the loaded rows', async () => {
    const store = useMediaStore();
    await store.load();
    await store.setFilter('tags:kids');
    calls.length = 0;
    await store.toggleAllMatching();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ filter: 'tags:kids' });
    expect(store.selectedTitleCount).toBe(900);
    expect(store.targetsFor([1, 2])).toEqual([{ instanceId: 1, mediaIds: [11, 13, 14] }]);
  });

  it('targets only the copies that matched, grouped one operation per instance', async () => {
    const store = useMediaStore();
    await store.load();
    store.toggleRow('a');
    store.toggleRow('b');

    // row b has a copy on instance 1 that did not match - it must not be acted on
    expect(store.targetsFor([1, 2])).toEqual([
      { instanceId: 1, mediaIds: [11] },
      { instanceId: 2, mediaIds: [22] },
    ]);
  });

  it('drops an untargeted instance, and an unreachable one - and can say which', async () => {
    response = fleet(
      [
        row('a', [{ instanceId: 1, mediaId: 11, matched: true }]),
        row('b', [{ instanceId: 2, mediaId: 22, matched: true }]),
      ],
      { columns: [column(1, 'A'), column(2, 'B', false)] },
    );

    const store = useMediaStore();
    await store.load();
    store.toggleRow('a');
    store.toggleRow('b');

    // instance 2 is targeted but silent: no operation, and the count is available to state
    expect(store.targetsFor([1, 2])).toEqual([{ instanceId: 1, mediaIds: [11] }]);
    expect(store.skippedFor([1, 2])).toEqual([{ name: 'B', items: 1 }]);

    // instance 1 untargeted: dropped too, but that is a choice rather than an unknown
    expect(store.targetsFor([2])).toEqual([]);
    expect(store.skippedFor([2])).toEqual([{ name: 'B', items: 1 }]);
  });

  it('counts a silent instance from the id set, not only the loaded page', async () => {
    response = fleet(
      [row('a', [{ instanceId: 1, mediaId: 11, matched: true }])],
      { columns: [column(1, 'A'), column(2, 'B', false)] },
    );
    ids = {
      matched: 2,
      truncated: false,
      groups: [
        { instanceId: 1, kind: 'radarr', mediaIds: [11] },
        { instanceId: 2, kind: 'radarr', mediaIds: [22, 23] },
      ],
    };

    const store = useMediaStore();
    await store.load();
    await store.selectAllMatching();

    expect(store.targetsFor([1, 2])).toEqual([{ instanceId: 1, mediaIds: [11] }]);
    expect(store.skippedFor([1, 2])).toEqual([{ name: 'B', items: 2 }]);
  });

  it('keeps the rows on screen when a request fails', async () => {
    const store = useMediaStore();
    await store.load();
    fail = true;
    await store.load();

    expect(store.rows).toHaveLength(2);
  });
});
