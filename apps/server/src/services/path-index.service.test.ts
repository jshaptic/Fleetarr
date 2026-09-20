import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  ArrCollection,
  ArrImportList,
  ArrMedia,
  ArrRootFolder,
  Instance,
} from '@fleetarr/shared';
import type { InstancesRepository } from '../repositories/instances.repo.js';
import {
  isAtOrUnder,
  normalisePath,
  parentPath,
  PathIndexService,
} from './path-index.service.js';
import type { ResourcesService } from './resources.service.js';

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 1,
    name: 'Radarr',
    kind: 'radarr',
    baseUrl: 'http://radarr.test',
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

function rootFolder(path: string, id = 1): ArrRootFolder {
  return { id, path, accessible: true, freeSpace: 1024, totalSpace: 2048 };
}

function media(id: number, path: string, title = `Title ${String(id)}`): ArrMedia {
  return { id, title, path, qualityProfileId: 0, monitored: true, tags: [] };
}

function importList(id: number, rootFolderPath: string, overrides: Partial<ArrImportList> = {}): ArrImportList {
  return {
    id,
    name: `List ${String(id)}`,
    implementation: 'TraktListImport',
    configContract: 'TraktListSettings',
    enabled: true,
    rootFolderPath,
    qualityProfileId: 0,
    tags: [],
    fields: [],
    ...overrides,
  };
}

function arrCollection(
  id: number,
  rootFolderPath: string,
  overrides: Partial<ArrCollection> = {},
): ArrCollection {
  return {
    id,
    title: `Collection ${String(id)}`,
    monitored: true,
    searchOnAdd: true,
    qualityProfileId: 0,
    rootFolderPath,
    tags: [],
    ...overrides,
  };
}

/** A stand-in for the two services the index reads through. */
function serviceFor(
  fleet: ReadonlyArray<{
    instance: Instance;
    rootFolders?: readonly ArrRootFolder[];
    media?: readonly ArrMedia[];
    importLists?: readonly ArrImportList[];
    collections?: readonly ArrCollection[];
    fails?: boolean;
    cached?: boolean;
    /** Cached separately: media can be in the snapshot cache while the lists are not. */
    listsCached?: boolean;
    collectionsCached?: boolean;
    /** A Radarr too old for /collection: known:false rather than an empty list. */
    collectionsUnsupported?: boolean;
  }>,
): { service: PathIndexService; fetches: () => number } {
  let fetches = 0;

  const find = (id: number) => fleet.find((entry) => entry.instance.id === id);

  const instances = {
    list: () => fleet.map((entry) => entry.instance),
  } as unknown as InstancesRepository;

  const resources = {
    mediaLibrary: async (id: number) => {
      const entry = find(id);
      if (entry?.fails === true) throw new Error('instance did not answer');
      fetches += 1;
      return { items: entry?.media ?? [], fetchedAt: '2026-01-01T00:00:00.000Z' };
    },
    rootFolders: async (id: number) => {
      const entry = find(id);
      if (entry?.fails === true) throw new Error('instance did not answer');
      fetches += 1;
      return entry?.rootFolders ?? [];
    },
    importLists: async (id: number) => {
      const entry = find(id);
      if (entry?.fails === true) throw new Error('instance did not answer');
      fetches += 1;
      return entry?.importLists ?? [];
    },
    collections: async (id: number) => {
      const entry = find(id);
      if (entry?.fails === true) throw new Error('instance did not answer');
      // Sonarr is answered without a request - it has no collections, which is an answer.
      if (entry?.instance.kind !== 'radarr') {
        return { known: true, items: [], fetchedAt: '2026-01-01T00:00:00.000Z' };
      }
      if (entry.collectionsUnsupported === true) {
        return { known: false, reason: 'no collections endpoint' };
      }
      fetches += 1;
      return {
        known: true,
        items: entry.collections ?? [],
        fetchedAt: '2026-01-01T00:00:00.000Z',
      };
    },
    peekMediaLibrary: (id: number) => {
      const entry = find(id);
      return entry?.cached === false ? null : (entry?.media ?? []);
    },
    peekRootFolders: (id: number) => {
      const entry = find(id);
      return entry?.cached === false ? null : (entry?.rootFolders ?? []);
    },
    // Null on a miss, and the index must still build - but a guard reads import lists now,
    // so the miss has to travel with the answer rather than look like an empty list.
    peekImportLists: (id: number) => {
      const entry = find(id);
      if (entry?.cached === false || entry?.listsCached === false) return null;
      return entry?.importLists ?? [];
    },
    peekCollections: (id: number) => {
      const entry = find(id);
      if (entry?.instance.kind !== 'radarr') return [];
      if (entry.cached === false || entry.collectionsCached === false) return null;
      if (entry.collectionsUnsupported === true) return null;
      return entry.collections ?? [];
    },
  } as unknown as ResourcesService;

  return { service: new PathIndexService({ instances, resources }), fetches: () => fetches };
}

describe('path helpers', () => {
  test('normalises trailing separators without eating the root', () => {
    assert.equal(normalisePath('/data/media/'), '/data/media');
    assert.equal(normalisePath('/data/media'), '/data/media');
    assert.equal(normalisePath('/'), '/');
  });

  test('walks up to the root and then stops', () => {
    assert.equal(parentPath('/data/media/movies'), '/data/media');
    assert.equal(parentPath('/data'), '/');
    assert.equal(parentPath('/'), null);
  });

  test('a shared prefix is not containment - the bug that moves the wrong media', () => {
    assert.equal(isAtOrUnder('/data/movies-4k/Arrival (2016)', '/data/movies'), false);
    assert.equal(isAtOrUnder('/data/movies/Dune (2021)', '/data/movies'), true);
    assert.equal(isAtOrUnder('/data/movies', '/data/movies'), true);
    assert.equal(isAtOrUnder('/data/movies', '/'), true);
  });
});

describe('PathIndexService', () => {
  test('credits every ancestor, so a nested library is never an orphan', async () => {
    const { service } = serviceFor([
      {
        instance: instance(),
        rootFolders: [rootFolder('/data/media')],
        media: [media(10, '/data/media/movies/The Matrix (1999)')],
      },
    ]);

    const [index] = await service.index();
    assert.ok(index);

    // The whole point: `movies` is an intermediate folder that holds media. The old
    // one-level reconcile scan called it an orphan.
    assert.equal(index.mediaUnder.get('/data/media/movies'), 1);
    assert.equal(index.mediaUnder.get('/data/media'), 1);
    assert.equal(index.mediaUnder.get('/data'), 1);
    assert.equal(index.mediaUnder.get('/'), 1);
    assert.equal(index.mediaUnder.get('/data/media/movies/The Matrix (1999)'), 1);
    assert.equal(index.mediaUnder.get('/data/media/tv'), undefined);
  });

  test('counts accumulate at every shared ancestor, at depth', async () => {
    const { service } = serviceFor([
      {
        instance: instance(),
        rootFolders: [rootFolder('/data')],
        media: [
          media(1, '/data/a/b/c/d/One'),
          media(2, '/data/a/b/c/d/Two'),
          media(3, '/data/a/b/other/Three'),
        ],
      },
    ]);

    const [index] = await service.index();
    assert.equal(index?.mediaUnder.get('/data/a/b/c/d'), 2);
    assert.equal(index?.mediaUnder.get('/data/a/b'), 3);
    assert.equal(index?.mediaUnder.get('/data'), 3);
  });

  test('indexes children by parent, from media paths and root folders alike', async () => {
    const { service } = serviceFor([
      {
        instance: instance(),
        rootFolders: [rootFolder('/data/media/movies'), rootFolder('/data/media/tv', 2)],
        media: [media(1, '/data/media/movies/Dune (2021)')],
      },
    ]);

    const [index] = await service.index();
    assert.deepEqual(
      [...(index?.childrenByParent.get('/data/media') ?? [])].sort(),
      ['/data/media/movies', '/data/media/tv'],
    );
    assert.deepEqual([...(index?.childrenByParent.get('/data/media/movies') ?? [])], [
      '/data/media/movies/Dune (2021)',
    ]);
  });

  test('an unreachable instance still gets a column, but contributes nothing', async () => {
    const { service } = serviceFor([
      { instance: instance(), rootFolders: [rootFolder('/data/media')], media: [media(1, '/data/media/A')] },
      { instance: instance({ id: 2, name: 'Sonarr', kind: 'sonarr' }), fails: true },
    ]);

    const indexes = await service.index();
    assert.equal(indexes.length, 2);

    const failed = indexes.find((entry) => entry.instanceId === 2);
    assert.equal(failed?.reachable, false);
    assert.match(failed?.error ?? '', /did not answer/);
    assert.equal(failed?.rootFolders.size, 0);
    assert.equal(failed?.mediaUnder.size, 0);
  });

  test('indexes import lists by the folder they fill, and never by an unset one', async () => {
    const { service } = serviceFor([
      {
        instance: instance(),
        rootFolders: [rootFolder('/data/media')],
        importLists: [
          // *Arr stores the target as a plain string, trailing separator and all.
          importList(1, '/data/media/', { enableAuto: true }),
          importList(2, '/data/media', { name: 'Second list' }),
          // An unconfigured list. Normalising this would claim the whole filesystem.
          importList(3, ''),
        ],
      },
    ]);

    const [index] = await service.index();

    assert.deepEqual(
      index?.importLists.map((list) => list.path),
      ['/data/media', '/data/media'],
      'the unset one claims nothing - normalising it would claim the whole filesystem',
    );
    assert.equal(index?.importLists[0]?.automatic, true);
    assert.equal(index?.importLists[1]?.automatic, false);
  });

  test('counts what is on disk separately from what is merely tracked', async () => {
    const { service } = serviceFor([
      {
        instance: instance(),
        rootFolders: [rootFolder('/data/media')],
        media: [
          { ...media(10, '/data/media/films/Dune (2021)'), hasFile: true },
          // Monitored, never downloaded: tracked at every ancestor, on disk at none.
          { ...media(11, '/data/media/films/Dune Part Three (2029)'), hasFile: false },
        ],
      },
    ]);

    const [index] = await service.index();

    assert.equal(index?.mediaUnder.get('/data/media/films'), 2);
    assert.equal(index?.mediaWithFilesUnder.get('/data/media/films'), 1);
    assert.equal(index?.mediaWithFilesUnder.get('/data/media'), 1, 'and at every ancestor');
  });

  test('skips instances that are disabled', async () => {
    const { service } = serviceFor([
      { instance: instance({ enabled: false }), rootFolders: [rootFolder('/data/media')] },
    ]);
    assert.deepEqual(await service.index(), []);
  });

  test('serves a second read from cache, and refetches on refresh', async () => {
    const { service, fetches } = serviceFor([
      { instance: instance(), rootFolders: [rootFolder('/data/media')], media: [] },
    ]);

    await service.index();
    const afterFirst = fetches();
    await service.index();
    assert.equal(fetches(), afterFirst, 'a cached read must not touch the instance');

    await service.index({ refresh: true });
    assert.ok(fetches() > afterFirst);
  });

  test('invalidate makes the next read see a change immediately', async () => {
    const folders: ArrRootFolder[] = [rootFolder('/data/media')];
    const { service } = serviceFor([{ instance: instance(), rootFolders: folders, media: [] }]);

    await service.index();
    folders.push(rootFolder('/data/media/audiobooks', 2));

    assert.equal((await service.index())[0]?.rootFolders.has('/data/media/audiobooks'), false);
    service.invalidate();
    assert.equal((await service.index())[0]?.rootFolders.has('/data/media/audiobooks'), true);
  });

  describe('referencedBy', () => {
    test('reports the instances pointing at a path or anything beneath it', async () => {
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/media/movies')],
          media: [media(1, '/data/media/movies/Dune (2021)')],
        },
        {
          instance: instance({ id: 2, name: 'Sonarr', kind: 'sonarr' }),
          rootFolders: [rootFolder('/data/media/tv', 5)],
          media: [],
        },
      ]);

      const ids = async (target: string): Promise<readonly number[]> =>
        (await service.referencedBy(target)).instanceIds;

      assert.deepEqual(await ids('/data/media/movies'), [1]);
      assert.deepEqual(await ids('/data/media/movies/Dune (2021)'), [1]);
      assert.deepEqual(await ids('/data/media/tv'), [2]);
      // Instance 2 roots under here with nothing downloaded yet - still a reference.
      assert.deepEqual(await ids('/data/media'), [1, 2]);
    });

    test('a shared prefix is not a reference', async () => {
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/movies')],
          media: [media(1, '/data/movies/Heat (1995)')],
        },
      ]);

      assert.deepEqual((await service.referencedBy('/data/movies-4k')).instanceIds, []);
      assert.deepEqual((await service.referencedBy('/data/mov')).instanceIds, []);
    });

    test('a collection is a claim in its own right, even with nothing else pointing here', async () => {
      // The gap this closes: with no root folder, no media and no list, the folder used to
      // be reported as referenced by nobody - and then a monitored collection rebuilt it.
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/media/movies')],
          media: [],
          collections: [arrCollection(1, '/data/media/collections')],
        },
      ]);

      const references = await service.referencedBy('/data/media/collections');

      assert.deepEqual(references.instanceIds, [1]);
      assert.deepEqual(references.instances[0]?.collections, [
        { id: 1, title: 'Collection 1', monitored: true, searchOnAdd: true, path: '/data/media/collections' },
      ]);
      assert.equal(references.complete, true);
    });

    test('a Radarr with no collections endpoint is unknown, never "no collections"', async () => {
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/media')],
          media: [],
          collectionsUnsupported: true,
        },
      ]);

      const references = await service.referencedBy('/data/media', { allowFetch: true });

      // It still answers everything else - it is one unreadable claim, not a dead
      // instance - but the fleet's view is incomplete, so a delete cannot clear the path.
      assert.deepEqual(references.instanceIds, [1]);
      assert.equal(references.complete, false);
    });

    test('Sonarr having no collections does not make the fleet incomplete', async () => {
      // Load-bearing: `collectionsKnown: false` for Sonarr would block every folder
      // delete in any fleet with a Sonarr in it.
      const { service } = serviceFor([
        {
          instance: instance({ id: 2, name: 'Sonarr', kind: 'sonarr' }),
          rootFolders: [rootFolder('/data/media/tv', 5)],
          media: [],
        },
      ]);

      const references = await service.referencedBy('/data/media/tv', { allowFetch: true });

      assert.equal(references.complete, true);
    });

    test('names each claim, so a caller can tell a registration from a library', async () => {
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/media/movies', 4)],
          media: [media(1, '/data/media/movies/Dune (2021)')],
          importLists: [importList(9, '/data/media/movies')],
        },
      ]);

      const answer = await service.referencedBy('/data/media/movies', { allowFetch: true });

      assert.deepEqual(answer.instances[0]?.rootFolders, [{ id: 4, path: '/data/media/movies' }]);
      assert.equal(answer.instances[0]?.mediaUnder, 1);
      assert.equal(answer.instances[0]?.importLists[0]?.id, 9);
      assert.equal(answer.instances[0]?.instanceName, 'Radarr');
    });

    test('a list filling the folder is a reference, even with no root folder and no media', async () => {
      // The hole this closes: nothing rooted here and nothing downloaded, so the old guard
      // called it unreferenced - and the list recreated the folder on its next sync.
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [],
          media: [],
          importLists: [importList(9, '/data/media/incoming')],
        },
      ]);

      const answer = await service.referencedBy('/data/media/incoming', { allowFetch: true });

      assert.deepEqual(answer.instanceIds, [1]);
      assert.equal(answer.instances[0]?.mediaUnder, 0);
      assert.deepEqual(answer.instances[0]?.rootFolders, []);
    });

    test('import lists it could not read make the answer incomplete, not empty', async () => {
      const { service } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/media')],
          media: [media(1, '/data/media/A')],
          importLists: [importList(9, '/data/media')],
          listsCached: false,
        },
      ]);

      // Media and root folders are cached, so the instance is checkable for those - but an
      // uncached list must never come back looking like "no list adds here".
      const answer = await service.referencedBy('/data/media');
      assert.equal(answer.complete, false);
    });

    test('never turns a cache miss into a request', async () => {
      const { service, fetches } = serviceFor([
        {
          instance: instance(),
          rootFolders: [rootFolder('/data/media')],
          media: [media(1, '/data/media/A')],
          cached: false,
        },
      ]);

      // Nothing cached and no fetch allowed: the guard says so rather than contacting
      // *Arr, and "incomplete" is what stops a caller reading it as "nothing owns this".
      const answer = await service.referencedBy('/data/media');
      assert.deepEqual(answer.instanceIds, []);
      assert.equal(answer.complete, false);
      assert.equal(fetches(), 0);

      // A blocker may pay for the truth.
      const fetched = await service.referencedBy('/data/media', { allowFetch: true });
      assert.deepEqual(fetched.instanceIds, [1]);
      assert.equal(fetched.complete, true);
      assert.ok(fetches() > 0);
    });
  });
});
