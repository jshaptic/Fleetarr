import type {
  Instance,
  MediaFacet,
  MediaFleetColumn,
  MediaFleetResponse,
  MediaRow,
  NewQueueItem,
  QueueItem,
} from '@fleetarr/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function instance(id: number, name: string, kind: Instance['kind'] = 'radarr'): Instance {
  return {
    id,
    name,
    kind,
    baseUrl: `http://host:${String(7000 + id)}`,
    verifySsl: true,
    enabled: true,
    timeoutMs: 20_000,
    appVersion: '5.0.0',
    lastConnectedAt: '2026-09-01T00:00:00.000Z',
    lastError: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const INSTANCES = [
  instance(1, 'Radarr-HD'),
  instance(2, 'Radarr-4K'),
  instance(3, 'Sonarr-TV', 'sonarr'),
];

function facet(overrides: Partial<MediaFacet> = {}): MediaFacet {
  return {
    instanceId: 1,
    name: 'Radarr-HD',
    kind: 'radarr',
    mediaId: 11,
    monitored: true,
    hasFile: true,
    sizeOnDisk: 4 * 1024 ** 3,
    episodes: null,
    path: '/data/media/movies/Dune (2021)',
    rootFolderPath: '/data/media/movies',
    qualityProfileId: 1,
    qualityProfileName: 'HD-1080p',
    tagIds: [1],
    tags: ['kids'],
    added: '2024-03-15T09:00:00Z',
    lists: ['Trakt watchlist'],
    listIds: [1],
    excludedFromLists: false,
    flags: [],
    matched: true,
    ...overrides,
  };
}

function row(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    key: 'movie:tmdb:438631',
    kind: 'movie',
    identityBasis: 'external',
    title: 'Dune',
    sortTitle: 'dune',
    year: 2021,
    status: 'released',
    genres: ['Science Fiction'],
    certification: 'PG-13',
    runtime: 155,
    studio: 'Legendary',
    collection: 'Dune Collection',
    tmdbId: 438631,
    tvdbId: null,
    imdbId: 'tt1160419',
    titleSlug: 'dune-438631',
    seriesType: null,
    minimumAvailability: 'released',
    facets: [facet()],
    tags: ['kids'],
    instanceCount: 1,
    monitoredCount: 1,
    fileCount: 1,
    sizeOnDisk: 4 * 1024 ** 3,
    addedFirst: '2024-03-15T09:00:00Z',
    unknownInstanceIds: [],
    matchedInstanceIds: [1],
    ...overrides,
  };
}

function column(overrides: Partial<MediaFleetColumn> = {}): MediaFleetColumn {
  return {
    instanceId: 1,
    name: 'Radarr-HD',
    kind: 'radarr',
    reachable: true,
    error: null,
    errorCode: null,
    fetchedAt: '2026-09-01T00:00:00.000Z',
    itemCount: 2,
    importListsKnown: true,
    importListsUnknownReason: null,
    tags: [{ id: 1, label: 'kids' }],
    qualityProfiles: [{ id: 1, name: 'HD-1080p' }],
    rootFolders: ['/data/media/movies'],
    importLists: [{ id: 1, name: 'Trakt watchlist' }],
    ...overrides,
  };
}

/** The row two Radarrs share - two chips, only the 4K one matching. */
const SHARED = row({
  key: 'movie:tmdb:1',
  title: 'Arrival',
  year: 2016,
  instanceCount: 2,
  matchedInstanceIds: [2],
  facets: [
    facet({ instanceId: 1, name: 'Radarr-HD', mediaId: 11, matched: false }),
    facet({
      instanceId: 2,
      name: 'Radarr-4K',
      mediaId: 77,
      matched: true,
      tags: ['remux'],
      tagIds: [9],
      rootFolderPath: '/data/media/4k',
      path: '/data/media/4k/Arrival (2016)',
      qualityProfileName: null,
      flags: ['no-quality-profile'],
    }),
  ],
  tags: ['kids', 'remux'],
});

const SERIES = row({
  key: 'series:tvdb:121361',
  kind: 'series',
  title: 'Shogun',
  year: 2024,
  tmdbId: null,
  tvdbId: 121361,
  imdbId: null,
  matchedInstanceIds: [3],
  sizeOnDisk: null,
  fileCount: 0,
  facets: [
    facet({
      instanceId: 3,
      name: 'Sonarr-TV',
      kind: 'sonarr',
      mediaId: 40,
      monitored: false,
      hasFile: null,
      sizeOnDisk: null,
      lists: null,
      listIds: null,
      excludedFromLists: null,
      flags: ['unmonitored'],
      tags: [],
      tagIds: [],
    }),
  ],
  tags: [],
  collection: null,
});

let ROWS: MediaRow[] = [];
let COLUMNS: MediaFleetColumn[] = [];
let UNDECIDED = 0;
let TRUNCATED = false;
let IDS_TRUNCATED = false;

const staged: QueueItem[] = [];

const push = vi.fn((items: readonly NewQueueItem[]) => {
  const created: QueueItem[] = [];
  for (const entry of items) {
    const item = {
      id: staged.length + created.length + 1,
      instanceId: entry.instanceId ?? null,
      runId: null,
      dependsOnId: entry.dependsOnId ?? null,
      sortOrder: staged.length + created.length + 1,
      status: 'pending',
      op: entry.op,
      payload: entry.payload,
      targetKind: 'movie',
      targetId: null,
      targetLabel: 'items',
      summary: `staged ${entry.op}`,
      affectedCount: 1,
      attempts: 0,
      error: null,
      result: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    } as QueueItem;
    created.push(item);
  }
  staged.push(...created);
  return Promise.resolve({ items: created });
});

const listMedia = vi.fn(
  (): Promise<MediaFleetResponse> =>
    Promise.resolve({
      scannedAt: '2026-09-08T00:00:00.000Z',
      oldestFetchedAt: '2026-09-01T00:00:00.000Z',
      columns: COLUMNS,
      rows: ROWS,
      listing: 'hide',
      totals: {
        rows: ROWS.length,
        movies: 1,
        series: 1,
        facets: 3,
        onOneInstance: 1,
        onMultipleInstances: 1,
        monitored: 1,
        withFiles: 1,
        sizeOnDisk: 1024,
        unreachableInstances: COLUMNS.filter((entry) => !entry.reachable).length,
        importListsUnknownInstances: COLUMNS.filter((entry) => !entry.importListsKnown).length,
        weakIdentityRows: 0,
      },
      counts: {
        matched: TRUNCATED ? 250 : ROWS.length,
        undecided: UNDECIDED,
        total: (TRUNCATED ? 250 : ROWS.length) + UNDECIDED,
      },
      undecidedReasons:
        UNDECIDED > 0
          ? [{ reason: 'import-list membership is not answerable on Sonarr', rows: UNDECIDED }]
          : [],
      page: 1,
      pageSize: 100,
      truncated: TRUNCATED,
      sort: 'title',
      direction: 'asc',
      filter: { source: '', error: null },
      vocabulary: {
        instances: ['Radarr-4K', 'Radarr-HD', 'Sonarr-TV'],
        tags: ['kids', 'remux'],
        lists: ['Trakt watchlist'],
        qualityProfiles: ['HD-1080p', 'Ultra-HD'],
        genres: ['Science Fiction'],
        certifications: ['PG-13'],
        collections: ['Dune Collection'],
        rootFolders: ['/data/media/4k', '/data/media/movies'],
      },
    }),
);

function idsFromRows() {
  const groups = new Map<number, { kind: MediaFacet['kind']; mediaIds: number[] }>();
  for (const entry of ROWS) {
    for (const facet of entry.facets) {
      if (!facet.matched) continue;
      const column = COLUMNS.find((item) => item.instanceId === facet.instanceId);
      if (column !== undefined && !column.reachable) continue;
      const group = groups.get(facet.instanceId) ?? { kind: facet.kind, mediaIds: [] };
      group.mediaIds.push(facet.mediaId);
      groups.set(facet.instanceId, group);
    }
  }
  return {
    matched: TRUNCATED ? 900 : ROWS.length,
    truncated: IDS_TRUNCATED,
    groups: [...groups].map(([instanceId, group]) => ({ instanceId, ...group })),
  };
}

const idsMedia = vi.fn(() => Promise.resolve(idsFromRows()));

vi.mock('@/api/media', () => ({
  mediaApi: { list: () => listMedia(), ids: () => idsMedia() },
}));

vi.mock('@/api/instances', () => ({
  instancesApi: {
    list: () => Promise.resolve({ instances: INSTANCES }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    testCandidate: vi.fn(),
  },
}));

vi.mock('@/api/resources', () => ({
  resourcesApi: {
    snapshot: (instanceId: number) =>
      Promise.resolve({
        instanceId,
        fetchedAt: '2026-09-01T00:00:00.000Z',
        tags: [],
        rootFolders: [],
        importLists: [],
        qualityProfiles: [],
      }),
    media: vi.fn(),
    allMediaIdsInRootFolder: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('@/api/queue', () => ({
  queueApi: {
    list: () => Promise.resolve({ items: [...staged], activeRun: null }),
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

const MediaFleetView = (await import('./MediaFleetView.vue')).default;

async function mountView() {
  const wrapper = mount(MediaFleetView, {
    global: { plugins: [createPinia()], stubs: { RouterLink: true } },
  });
  for (let tick = 0; tick < 8; tick += 1) await flushPromises();
  return wrapper;
}

function rowFor(wrapper: Awaited<ReturnType<typeof mountView>>, title: string) {
  return wrapper
    .findAll('tbody tr')
    .find((entry) => entry.find('[data-name]').text().includes(title));
}

async function selectAllAnd(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  button: string,
): Promise<void> {
  await wrapper.find('[data-testid="select-all"]').setValue(true);
  await flushPromises();
  const target = wrapper
    .findAll('button')
    .find((entry) => entry.text().trim().startsWith(button));
  await target?.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  staged.length = 0;
  ROWS = [SHARED, row(), SERIES];
  COLUMNS = [
    column(),
    column({ instanceId: 2, name: 'Radarr-4K', rootFolders: ['/data/media/4k'], tags: [{ id: 9, label: 'remux' }] }),
    column({
      instanceId: 3,
      name: 'Sonarr-TV',
      kind: 'sonarr',
      importListsKnown: false,
      importListsUnknownReason: 'unsupported',
      importLists: [],
    }),
  ];
  UNDECIDED = 0;
  TRUNCATED = false;
  IDS_TRUNCATED = false;
  push.mockClear();
  listMedia.mockClear();
  idsMedia.mockReset();
  idsMedia.mockImplementation(() => Promise.resolve(idsFromRows()));
  document.body.innerHTML = '';
});

describe('MediaFleetView', () => {
  it('renders one row per title with a chip per instance that holds it', async () => {
    const wrapper = await mountView();

    expect(wrapper.findAll('tbody tr')).toHaveLength(3);
    const arrival = rowFor(wrapper, 'Arrival');
    expect(arrival?.findAll('[data-owner]')).toHaveLength(2);
    expect(arrival?.find('[data-instance="1"]').exists()).toBe(true);
    expect(arrival?.find('[data-instance="2"]').exists()).toBe(true);
  });

  it('is nine fixed columns, and none of them is an instance', async () => {
    const wrapper = await mountView();
    const headers = wrapper.findAll('thead th').map((entry) => entry.text());

    expect(headers.slice(1)).toEqual([
      'Kind',
      'Links',
      'Instances',
      'Size',
      'Status',
      'Tags',
      'Collection',
      'Root folder',
    ]);
    // the no-fleet-column-grid guard: the tag matrix is the only view with an instance axis
    for (const header of headers) {
      for (const name of ['Radarr-HD', 'Radarr-4K', 'Sonarr-TV']) {
        expect(header).not.toContain(name);
      }
    }
  });

  it('keeps a row to one line: the title cell carries no second row of detail', async () => {
    const wrapper = await mountView();
    const title = rowFor(wrapper, 'Dune')?.find('th');

    // the status word rides with the title; kind, links and size have columns of their own
    expect(title?.text()).toContain('Dune (2021)');
    expect(title?.text()).toContain('released');
    expect(title?.text()).not.toContain('movie');
    expect(title?.find('[data-link="tmdb"]').exists()).toBe(false);
    expect(title?.text()).not.toContain('GB');
  });

  it('answers size three ways, and never calls "unknown" a zero', async () => {
    const wrapper = await mountView();

    // a copy with a size
    expect(rowFor(wrapper, 'Dune')?.find('[data-size]').text()).toBe('4.0 GB');

    // Sonarr reported neither hasFile nor statistics for Shogun: unknown, not "no file"
    const shogun = rowFor(wrapper, 'Shogun')?.find('[data-size]').text();
    expect(shogun).toContain('unknown');
    expect(shogun).not.toContain('no file');

    // and a copy that says it has nothing gets the plain badge
    ROWS = [row({ sizeOnDisk: null, fileCount: 0, facets: [facet({ hasFile: false, sizeOnDisk: 0 })] })];
    const fresh = await mountView();
    expect(fresh.find('[data-size]').text()).toBe('no file');
  });

  it('never badges "no file" in the Status column, nor file state on a chip', async () => {
    const wrapper = await mountView();

    expect(wrapper.find('[data-flag="not-downloaded"]').exists()).toBe(false);
    expect(wrapper.find('tbody').text()).not.toContain('no file yet');
    // the chips say whether *Arr is watching, and nothing about the file
    const chip = rowFor(wrapper, 'Shogun')?.find('[data-metric="state"]').text();
    expect(chip).toContain('off');
    expect(chip).not.toContain('file');
  });

  it('a root folder filters by itself', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Dune')?.find('[data-root]').trigger('click');
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('root:"/data/media/movies"');
  });

  it('a collection filters by itself, and a series filters by collection:none', async () => {
    const wrapper = await mountView();

    await rowFor(wrapper, 'Dune')?.find('[data-collection]').trigger('click');
    await flushPromises();
    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('collection:"Dune Collection"');

    // A series has no collection ever, so the dash is a known absence rather than a gap.
    await rowFor(wrapper, 'Shogun')?.find('[data-collection="none"]').trigger('click');
    await flushPromises();
    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('collection:none');
  });

  it('a tag filters by itself', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Dune')?.find('[data-tag]').trigger('click');
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('tags:"kids"');
  });

  it('an empty tags cell filters by tags:none', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Shogun')?.find('[data-tag="none"]').trigger('click');
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('tags:none');
  });

  it('a status word filters by itself', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Dune')?.find('[data-status]').trigger('click');
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('status:"released"');
    // outside the checkbox label, so the click did not select the row
    expect(wrapper.find('[data-testid="summary"]').exists()).toBe(false);
  });

  it('an unmonitored badge filters by monitored:false', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Shogun')?.find('[data-flag="unmonitored"]').trigger('click');
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('monitored:false');
  });

  it('a no-profile badge filters by profile:none', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Arrival')?.find('[data-flag="no-quality-profile"]').trigger('click');
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="media-filter-input"]').element as HTMLInputElement).value,
    ).toBe('profile:none');
  });

  it('never speaks the matrix vocabulary, and shows no artwork', async () => {
    const wrapper = await mountView();
    // The rows are where a claim would be made. The notices above the table are allowed to
    // quote a phrase in order to deny it - "deliberately not 'in no list'" is the point.
    const rows = wrapper.find('tbody').text();

    for (const forbidden of ['missing on', 'drift', 'parity', 'in no list', 'nobody', 'Align']) {
      expect(rows).not.toContain(forbidden);
    }
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('keeps every chip, and lights only the copies that matched', async () => {
    const wrapper = await mountView();
    const arrival = rowFor(wrapper, 'Arrival');

    // the filter matched the 4K copy only, but the HD chip still renders
    expect(arrival?.find('[data-instance="2"]').attributes('data-owner')).toBe('matched');
    expect(arrival?.find('[data-instance="1"]').attributes('data-owner')).toBe('other');
  });

  it('links out only to systems it has an id for', async () => {
    const wrapper = await mountView();

    const dune = rowFor(wrapper, 'Dune');
    const tmdb = dune?.find('[data-link="tmdb"]');
    expect(tmdb?.attributes('href')).toBe('https://www.themoviedb.org/movie/438631');
    expect(tmdb?.attributes('target')).toBe('_blank');
    expect(tmdb?.attributes('rel')).toContain('noreferrer');

    const mdblist = dune?.find('[data-link="mdblist"]');
    expect(mdblist?.attributes('href')).toBe('https://mdblist.com/movie/tt1160419');

    // Shogun has no IMDb id, so there is no dead link pretending otherwise
    const shogun = rowFor(wrapper, 'Shogun');
    expect(shogun?.find('[data-link="imdb"]').exists()).toBe(false);
    expect(shogun?.find('[data-link="mdblist"]').exists()).toBe(false);
    expect(shogun?.find('[data-link="tvdb"]').exists()).toBe(true);
  });

  it('keys the MDBList link on IMDb and the show path for a series', async () => {
    ROWS = [{ ...SERIES, imdbId: 'tt2788316' }];
    const wrapper = await mountView();
    expect(rowFor(wrapper, 'Shogun')?.find('[data-link="mdblist"]').attributes('href')).toBe(
      'https://mdblist.com/show/tt2788316',
    );
  });

  it('states Sonarr list membership once, and never as "in no list"', async () => {
    const wrapper = await mountView();

    expect(wrapper.findAll('[data-testid="importlist-unknown"]')).toHaveLength(1);
    const notice = wrapper.find('[data-testid="importlist-unknown"]').text();
    expect(notice).toContain('Sonarr-TV');
    expect(notice).toContain('deliberately not "in no list"');
    expect(wrapper.text()).not.toContain('in no list.');
  });

  it('counts the titles a filter could not judge, and offers to show them', async () => {
    UNDECIDED = 12;
    const wrapper = await mountView();

    const notice = wrapper.find('[data-testid="undecided"]');
    expect(notice.text()).toContain('12 title(s) could not be judged');
    expect(notice.text()).toContain('not answerable on Sonarr');
    expect(notice.text()).toContain('deliberately not "no match"');
    expect(wrapper.find('[data-testid="show-undecided"]').exists()).toBe(true);
  });

  it('states an unreachable instance once and never makes it an operation', async () => {
    COLUMNS = COLUMNS.map((entry) =>
      entry.instanceId === 2
        ? { ...entry, reachable: false, error: 'unreachable', errorCode: 'arr_unreachable' }
        : entry,
    );
    const wrapper = await mountView();

    expect(wrapper.findAll('[data-testid="unknown-instances"]')).toHaveLength(1);
    const notice = wrapper.find('[data-testid="unknown-instances"]').text();
    expect(notice).toContain('Radarr-4K');
    expect(notice).toContain('Unknown, deliberately not "missing"');
    // its cached copies still render - the row must not read as "nobody holds this"
    expect(rowFor(wrapper, 'Arrival')?.find('[data-instance="2"]').exists()).toBe(true);

    // The skip is stated while the selection is live - before staging, when it can still
    // change someone's mind, rather than as a footnote afterwards.
    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();
    const skipped = wrapper.find('[data-testid="skipped-instances"]').text();
    expect(skipped).toContain('Radarr-4K');
    expect(skipped).toContain('not part of this operation');

    await wrapper.findAll('button').find((entry) => entry.text().trim() === 'Monitor')?.trigger('click');
    await flushPromises();
    const batch = push.mock.calls[0]?.[0] ?? [];
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.map((item) => item.instanceId)).not.toContain(2);
  });

  it('select-all is tri-state and the summary counts titles and copies apart', async () => {
    const wrapper = await mountView();
    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();

    const summary = wrapper.find('[data-testid="summary"]').text();
    expect(summary).toContain('3 title(s)');
    expect(summary).toContain('3 cop(ies)');
    expect(summary).toContain('3 instance(s)');
  });

  it('stages one monitored op per instance, batching the ids', async () => {
    const wrapper = await mountView();
    await selectAllAnd(wrapper, 'Unmonitor');

    const batch = push.mock.calls[0]?.[0] ?? [];
    expect(batch).toHaveLength(3);
    expect(new Set(batch.map((item) => item.op))).toEqual(new Set(['media.setMonitored']));
    for (const item of batch) {
      expect(item.payload).toMatchObject({ monitored: false });
    }
  });

  it('stages a rescan without opening a dialog - reversible work is a button', async () => {
    const wrapper = await mountView();
    await selectAllAnd(wrapper, 'Rescan on *Arr');

    expect(push.mock.calls[0]?.[0]?.[0]?.op).toBe('media.refresh');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('the delete dialog will not confirm a file deletion until the count is typed', async () => {
    const wrapper = await mountView();
    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();
    await wrapper.findAll('button').find((entry) => entry.text().startsWith('Delete'))?.trigger('click');
    await flushPromises();

    const dialog = document.body;
    const confirm = dialog.querySelector<HTMLButtonElement>('[data-testid="delete-confirm-button"]');
    expect(confirm?.disabled).toBe(false);

    const files = dialog.querySelector<HTMLInputElement>('[data-testid="delete-files"]');
    expect(files).not.toBeNull();
    if (files !== null) {
      files.checked = true;
      files.dispatchEvent(new Event('change'));
    }
    await flushPromises();

    expect(
      dialog.querySelector<HTMLButtonElement>('[data-testid="delete-confirm-button"]')?.disabled,
    ).toBe(true);
  });

  it('a filter change clears the selection', async () => {
    const wrapper = await mountView();
    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="summary"]').exists()).toBe(true);

    const input = wrapper.find('[data-testid="media-filter-input"]');
    await input.setValue('tags:remux');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(wrapper.find('[data-testid="summary"]').exists()).toBe(false);
  });

  it('asks the server for the whole match rather than reusing the page', async () => {
    TRUNCATED = true;
    idsMedia.mockResolvedValue({
      matched: 900,
      truncated: false,
      groups: [{ instanceId: 2, kind: 'radarr', mediaIds: [77, 78, 79] }],
    });
    const wrapper = await mountView();

    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();
    expect(idsMedia).toHaveBeenCalled();

    const summary = wrapper.find('[data-testid="summary"]').text();
    expect(summary).toContain('900 title(s)');
    expect(summary).toContain('3 cop(ies)');

    await wrapper.findAll('button').find((entry) => entry.text().trim() === 'Monitor')?.trigger('click');
    await flushPromises();
    const batch = push.mock.calls[0]?.[0] ?? [];
    // the server's ids, not the loaded rows'
    expect(batch).toHaveLength(1);
    expect(batch[0]?.payload).toMatchObject({ mediaIds: [77, 78, 79] });
  });

  it('refuses to stage a truncated match, and says why', async () => {
    TRUNCATED = true;
    IDS_TRUNCATED = true;
    const wrapper = await mountView();

    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();

    expect(wrapper.find('[data-testid="selection-truncated"]').text()).toContain(
      'narrow the filter',
    );
    const monitor = wrapper.findAll('button').find((entry) => entry.text().trim() === 'Monitor');
    expect(monitor?.attributes('disabled')).toBeDefined();
  });

  it('reports the matched count, not the number of rows on screen', async () => {
    TRUNCATED = true;
    const wrapper = await mountView();
    expect(wrapper.find('[data-testid="listing-summary"]').text()).toMatch(
      /Page 1 of 3 ·\s*250 matching title\(s\)/,
    );
    expect(wrapper.find('[data-testid="pagination"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="load-more"]').exists()).toBe(false);
  });

  it('opens one copy\'s full breakdown from its chip, and says what it cannot know', async () => {
    const wrapper = await mountView();
    await rowFor(wrapper, 'Shogun')?.find('[data-instance="3"]').trigger('click');
    await flushPromises();

    // Teleported to the body, so it is queried there rather than through the wrapper
    const card = document.body.querySelector('[data-testid="media-owner-card"]');
    expect(card).not.toBeNull();
    const text = card?.textContent ?? '';
    // Sonarr answers neither question, and says so rather than reading as an absence:
    // "no file" and "in no list" are both claims we have no way to make here.
    expect(text).toContain('On disk unknown');
    expect(text).toContain('Import lists unknown here');
    expect(text).not.toContain('On disk not yet');
    expect(text).not.toContain('Import lists none');
    expect(
      document.body.querySelector('[data-testid="media-owner-link"]')?.getAttribute('href'),
    ).toBe('http://host:7003/series/dune-438631');
  });

  it('shows the worst staged intent beside the name, from any copy', async () => {
    const wrapper = await mountView();
    // nothing pending yet
    expect(rowFor(wrapper, 'Arrival')?.find('[data-testid="row-staged"]').exists()).toBe(false);

    // stage a delete on the 4K copy only - the icon still has to appear on the row
    await wrapper.find('[data-testid="select-all"]').setValue(true);
    await flushPromises();
    await wrapper.findAll('button').find((entry) => entry.text().startsWith('Delete'))?.trigger('click');
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>('[data-testid="delete-confirm-button"]')
      ?.click();
    await flushPromises();
    await flushPromises();

    const staged = rowFor(wrapper, 'Arrival')?.find('[data-testid="row-staged"]');
    expect(staged?.exists()).toBe(true);
    expect(staged?.attributes('title')).toContain('Delete media staged for Arrival');
  });

  it('renders its own state vocabulary, and no severity glyph for an ordinary row', async () => {
    const wrapper = await mountView();

    expect(rowFor(wrapper, 'Shogun')?.find('[data-flag="unmonitored"]').text()).toContain(
      'unmonitored',
    );
    expect(rowFor(wrapper, 'Arrival')?.find('[data-flag="no-quality-profile"]').exists()).toBe(true);
    // an ordinary row carries no badge at all
    expect(rowFor(wrapper, 'Dune')?.findAll('[data-flag]')).toHaveLength(0);
  });
});
