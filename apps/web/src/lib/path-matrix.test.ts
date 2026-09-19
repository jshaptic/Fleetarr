import type {
  PathFlag,
  PathMatrixColumn,
  PathMatrixLevel,
  PathNode,
  PathOwner,
  PathRollup,
  PathUse,
} from '@fleetarr/shared';
import { describe, expect, it } from 'vitest';
import {
  absorbedFolders,
  actionsFor,
  flattenLeaves,
  isLeafFolder,
  flattenLevels,
  levelKey,
  mediaSummary,
  ownerFacts,
  ownerHeadline,
  ownerMedia,
  prunableFolders,
  alignTargetsFor,
  rootFolderTargets,
  SEVERITY_STYLES,
  TOP_LEVEL,
  trackedBy,
  unknownColumns,
  worstSeverity,
} from './path-matrix';

function rollup(overrides: Partial<PathRollup> = {}): PathRollup {
  return {
    entries: 0,
    tracked: 0,
    untracked: 0,
    neutral: 0,
    missing: 0,
    rootFolders: 0,
    symlinks: 0,
    empty: null,
    unreadable: null,
    mediaUnder: 0,
    severity: 'ok',
    ...overrides,
  };
}

function owner(instanceId: number, use: PathUse, overrides: Partial<PathOwner> = {}): PathOwner {
  return {
    instanceId,
    name: `instance ${String(instanceId)}`,
    kind: 'radarr',
    use,
    rootFolderId: use === 'rootFolder' ? instanceId * 10 : null,
    accessible: use === 'rootFolder' ? true : null,
    mediaUnder: use === 'rootFolder' ? 0 : 1,
    mediaWithFiles: use === 'rootFolder' ? 0 : 1,
    title: use === 'tracked' ? 'A Title' : null,
    rootFoldersUnder: use === 'containsRoot' ? [{ id: 1, path: '/data/media/movies' }] : [],
    importLists: [],
    freeSpace: use === 'rootFolder' ? 1_000_000_000 : null,
    totalSpace: use === 'rootFolder' ? 4_000_000_000 : null,
    ...overrides,
  };
}

function node(path: string, overrides: Partial<PathNode> = {}): PathNode {
  return {
    path,
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    origin: 'disk',
    exists: true,
    kind: 'directory',
    inScope: true,
    modifiedAt: null,
    childCount: 3,
    readable: true,
    writable: true,
    deviceId: '1',
    freeSpace: null,
    totalSpace: null,
    lowSpace: false,
    sizeOnDisk: null,
    error: null,
    owners: [],
    flags: [],
    severity: 'ok',
    canAddRootFolder: true,
    rollup: null,
    expandable: true,
    ...overrides,
  };
}

function level(path: string | null, nodes: PathNode[], overrides: Partial<PathMatrixLevel> = {}): PathMatrixLevel {
  return {
    path,
    parent: null,
    nodes,
    rollup: rollup({ entries: nodes.length }),
    selection: ['all'],
    matched: nodes.length,
    offset: 0,
    limit: 200,
    truncated: false,
    childCountsResolved: true,
    error: null,
    ...overrides,
  };
}

function column(instanceId: number, overrides: Partial<PathMatrixColumn> = {}): PathMatrixColumn {
  return {
    instanceId,
    name: `instance ${String(instanceId)}`,
    kind: 'radarr',
    reachable: true,
    error: null,
    fetchedAt: null,
    rootFolderCount: 1,
    mediaPathCount: 0,
    unseenRootFolders: [],
    ...overrides,
  };
}

describe('flattenLevels', () => {
  const levels = {
    [TOP_LEVEL]: level(null, [node('/data')]),
    '/data': level('/data', [node('/data/media'), node('/data/other')]),
    '/data/media': level('/data/media', [node('/data/media/movies')]),
  };

  it('walks depth-first and indents by depth', () => {
    const rows = flattenLevels({ levels, expanded: ['/data', '/data/media'], focus: null });

    expect(rows.map((row) => [row.node?.path, row.depth])).toEqual([
      ['/data', 0],
      ['/data/media', 1],
      ['/data/media/movies', 2],
      ['/data/other', 1],
    ]);
  });

  it('hides a subtree that is not expanded', () => {
    const rows = flattenLevels({ levels, expanded: ['/data'], focus: null });
    expect(rows.map((row) => row.node?.path)).toEqual(['/data', '/data/media', '/data/other']);
  });

  it('does not expand a node whose level has not been fetched yet', () => {
    const rows = flattenLevels({ levels: { [TOP_LEVEL]: levels[TOP_LEVEL] }, expanded: ['/data'], focus: null });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.expanded).toBe(false);
    expect(rows[0]?.hasLevel).toBe(false);
  });

  it('re-roots at the focused path', () => {
    const rows = flattenLevels({ levels, expanded: ['/data/media'], focus: '/data/media' });

    expect(rows.map((row) => [row.node?.path, row.depth])).toEqual([['/data/media/movies', 0]]);
  });

  it('returns nothing when the focused level is not loaded', () => {
    expect(flattenLevels({ levels, expanded: [], focus: '/nowhere' })).toEqual([]);
  });

  it('carries the worst severity inside a node, so a collapsed row can warn', () => {
    const withProblem = {
      [TOP_LEVEL]: level(null, [node('/data')]),
      '/data': level('/data', [node('/data/media')], { rollup: rollup({ severity: 'error' }) }),
    };
    const rows = flattenLevels({ levels: withProblem, expanded: [], focus: null });

    // /data is collapsed, but its level is loaded and holds something broken.
    expect(rows[0]?.childSeverity).toBe('error');
  });

  it('reports no child severity for a node whose level was never fetched', () => {
    // "Nothing fetched" is not "nothing wrong" - the row must not claim it is clean.
    const rows = flattenLevels({
      levels: { [TOP_LEVEL]: level(null, [node('/data')]) },
      expanded: [],
      focus: null,
    });

    expect(rows[0]?.childSeverity).toBeNull();
  });

  it('survives a level that points back at itself', () => {
    const looped = { '/a': level('/a', [node('/a')]) };
    const rows = flattenLevels({ levels: looped, expanded: ['/a'], focus: '/a' });
    expect(rows.length).toBeLessThan(5);
  });

  it('never shows a plain file - this view manages folders, not media files', () => {
    const withAFile = {
      [TOP_LEVEL]: level(null, [node('/data')]),
      '/data': level('/data', [
        node('/data/media'),
        node('/data/movie.mkv', { kind: 'file', expandable: false }),
      ]),
    };
    const rows = flattenLevels({ levels: withAFile, expanded: ['/data'], focus: null });

    expect(rows.map((row) => row.node?.path)).toEqual(['/data', '/data/media']);
  });
});

describe('isLeafFolder', () => {
  const levels = {
    [TOP_LEVEL]: level(null, [node('/data')]),
    '/data': level('/data', [node('/data/media'), node('/data/other')]),
    // A root folder's level: 812 films, not one of them a folder this view manages.
    '/data/media': level('/data/media', [
      node('/data/media/Dune (2021).mkv', { kind: 'file', expandable: false }),
    ]),
  };

  it('calls a folder with subfolders a parent', () => {
    expect(isLeafFolder('/data', levels)).toBe(false);
  });

  it('calls a folder of files a leaf, however many entries it has', () => {
    expect(isLeafFolder('/data/media', levels)).toBe(true);
  });

  it('calls an unread folder a leaf - "not fetched" is answered, not guessed at twice', () => {
    expect(isLeafFolder('/data/other', levels)).toBe(true);
  });

  /** The tree's checkboxes and the flat list's rows must never disagree about a folder. */
  it('is the same verdict the flat list picks its rows by', () => {
    const flat = flattenLeaves({ levels, expanded: [], focus: null }).map((row) => row.node.path);
    const tree = flattenLevels({ levels, expanded: ['/data', '/data/media'], focus: null });

    expect(tree.filter((row) => row.leaf).map((row) => row.node.path)).toEqual(flat);
    expect(tree.filter((row) => !row.leaf).map((row) => row.node.path)).toEqual(['/data']);
  });
});

describe('flattenLeaves', () => {
  const levels = {
    [TOP_LEVEL]: level(null, [node('/data')]),
    '/data': level('/data', [
      node('/data/media'),
      node('/data/other', { expandable: false }),
    ]),
    '/data/media': level('/data/media', [node('/data/media/movies', { expandable: false })]),
  };

  it('lists only the leaves, flat, in path order', () => {
    const rows = flattenLeaves({ levels, expanded: [], focus: null });

    expect(rows.map((row) => [row.node?.path, row.depth])).toEqual([
      ['/data/media/movies', 0],
      ['/data/other', 0],
    ]);
  });

  it('drops files and other non-directories - this is a folder list', () => {
    const withAFile = {
      ...levels,
      '/data': level('/data', [
        node('/data/media'),
        node('/data/other', { expandable: false }),
        node('/data/movie.mkv', { kind: 'file', expandable: false }),
        node('/data/link', { kind: 'symlink', expandable: false }),
      ]),
    };
    const rows = flattenLeaves({ levels: withAFile, expanded: [], focus: null });

    expect(rows.map((row) => row.node?.path)).toEqual(['/data/media/movies', '/data/other']);
  });

  it('ignores the expanded set entirely - it walks every fetched level regardless', () => {
    const withoutExpanded = flattenLeaves({ levels, expanded: [], focus: null });
    const withExpanded = flattenLeaves({ levels, expanded: ['/data', '/data/media'], focus: null });
    expect(withoutExpanded).toEqual(withExpanded);
  });

  it('re-roots at the focused path, same as flattenLevels', () => {
    const rows = flattenLeaves({ levels, expanded: [], focus: '/data/media' });
    expect(rows.map((row) => row.node?.path)).toEqual(['/data/media/movies']);
  });

  it('falls back to showing an unfetched expandable node rather than dropping it', () => {
    const partial = { [TOP_LEVEL]: level(null, [node('/data')]) };
    const rows = flattenLeaves({ levels: partial, expanded: [], focus: null });
    expect(rows.map((row) => row.node?.path)).toEqual(['/data']);
  });

  it('keeps a folder that holds only files - it is the deepest folder, not a branch', () => {
    // The real case this got wrong: /data/media/onepiece holds 172 episode files and no
    // subfolder. The server calls it expandable (it has entries), so walking into it and
    // then dropping its files left the folder itself with no row at all.
    const withEpisodes = {
      [TOP_LEVEL]: level(null, [node('/data')]),
      '/data': level('/data', [node('/data/onepiece')]),
      '/data/onepiece': level('/data/onepiece', [
        node('/data/onepiece/ep01.mp4', { kind: 'file', expandable: false }),
        node('/data/onepiece/ep02.mp4', { kind: 'file', expandable: false }),
      ]),
    };
    const rows = flattenLeaves({ levels: withEpisodes, expanded: [], focus: null });

    expect(rows.map((row) => row.node?.path)).toEqual(['/data/onepiece']);
  });

  it('walks past a folder that holds subfolders, even when it also holds files', () => {
    const mixed = {
      [TOP_LEVEL]: level(null, [node('/data')]),
      '/data': level('/data', [node('/data/media')]),
      '/data/media': level('/data/media', [
        node('/data/media/movies'),
        node('/data/media/stray.mkv', { kind: 'file', expandable: false }),
      ]),
      '/data/media/movies': level('/data/media/movies', [
        node('/data/media/movies/film.mkv', { kind: 'file', expandable: false }),
      ]),
    };
    const rows = flattenLeaves({ levels: mixed, expanded: [], focus: null });

    expect(rows.map((row) => row.node?.path)).toEqual(['/data/media/movies']);
  });

  it('survives a level that points back at itself', () => {
    const looped = { '/a': level('/a', [node('/a')]) };
    expect(flattenLeaves({ levels: looped, expanded: [], focus: '/a' }).length).toBeLessThan(5);
  });
});

describe('actionsFor', () => {
  const flagged = (path: string, flags: PathFlag[], owners: PathOwner[]): PathNode =>
    node(path, { flags, owners, canAddRootFolder: false });

  it('offers the root-folder actions on a root folder that holds media', () => {
    const target = flagged('/data/media/movies', ['rootFolder'], [
      owner(1, 'rootFolder', { mediaUnder: 806 }),
    ]);

    expect(actionsFor(target)).toEqual(expect.arrayContaining(['remap', 'rename']));
    // Removal is per instance, so it is the owner card's button, never a row button
    // standing for every owner at once.
    expect(actionsFor(target)).not.toContain('remove');
  });

  it('offers the disk actions on a folder nobody roots', () => {
    const target = node('/data/media/old-movies', { flags: [], owners: [] });
    const actions = actionsFor(target);

    expect(actions).toEqual(expect.arrayContaining(['addRoot', 'rename', 'move', 'prune']));
    expect(actions).not.toContain('remap');
  });

  it('offers a switch on a root folder nothing has been downloaded into yet', () => {
    // Use is structural, not a consequence of downloading: an empty, freshly configured root
    // folder is precisely the one worth re-pointing before a library lands in it.
    const target = flagged('/data/media/tv', ['rootFolder'], [
      owner(1, 'rootFolder', { mediaUnder: 0 }),
    ]);

    expect(actionsFor(target)).toContain('remap');
  });

  it('offers addRoot only when the server says the path could take one', () => {
    // The server owns this decision: it is the only side that knows every instance's
    // root folders, and the old client-side version needed a target selection to guess.
    const already = node('/data/media/movies', {
      flags: ['rootFolder'],
      owners: [owner(1, 'rootFolder')],
      canAddRootFolder: false,
    });
    expect(actionsFor(already)).not.toContain('addRoot');
    expect(actionsFor(node('/data/media/spare', { canAddRootFolder: true }))).toContain('addRoot');
  });

  it('offers a prune even where it would cost something - the dialog says what', () => {
    // This used to be hidden, which read as "cannot be deleted" when the truth was "here is
    // what it would cost". The delete preflight now names the cost per instance and per
    // reason, and offers to unassign or disable whatever a staged operation can clear.
    const tracked = flagged('/data/media/movies/Dune (2021)', [], [
      owner(1, 'tracked', { mediaUnder: 1 }),
    ]);
    expect(actionsFor(tracked)).toContain('prune');

    const parentOfRoot = node('/data/media', {
      owners: [owner(1, 'containsRoot', { mediaUnder: 0, rootFoldersUnder: [{ id: 2, path: '/data/media/tv' }] })],
    });
    expect(actionsFor(parentOfRoot)).toContain('prune');
  });

  it('still never offers a prune on a mount, or on a folder that is not there', () => {
    // The gate that remains: these are not "expensive", they are impossible.
    expect(actionsFor(node('/data', { flags: ['mount'] }))).not.toContain('prune');
    expect(actionsFor(node('/data/media/gone', { flags: ['missing'] }))).not.toContain('prune');
    expect(actionsFor(node('/elsewhere/movies', { flags: ['unseen'] }))).not.toContain('prune');
  });

  it('prunes a folder no owner holds media under - an unreachable instance is not an owner', () => {
    // The old check was `cells.every(c => !c.known || c.mediaUnder === 0)`. An instance
    // that did not answer is absent from `owners` entirely, so it reaches the same answer.
    expect(actionsFor(node('/data/media/spare', { owners: [] }))).toContain('prune');
  });

  // Align is not a second row action any more: renaming a root folder offers the instances
  // rooting at it inside the one dialog. A media folder has none, so it gets a plain rename
  // - which is exactly what it could ever have had.
  it('offers a plain rename on a tracked media folder, and no re-map', () => {
    const target = flagged('/data/media/movies/Dune (2021)', [], [owner(1, 'tracked')]);
    const actions = actionsFor(target);

    expect(actions).toContain('rename');
    expect(actions).not.toContain('remap');
  });

  it('a rename can carry nested root folders, not only the folder itself', () => {
    const parent = node('/data/media/movies/europe', {
      owners: [
        owner(1, 'containsRoot', {
          mediaUnder: 0,
          rootFoldersUnder: [
            { id: 8, path: '/data/media/movies/europe/auto-feed/0k' },
            { id: 9, path: '/data/media/movies/europe/curated-feed/0k' },
          ],
        }),
      ],
    });

    expect(alignTargetsFor(parent)).toEqual([
      {
        instanceId: 1,
        name: 'instance 1',
        kind: 'radarr',
        roots: [
          { path: '/data/media/movies/europe/auto-feed/0k', rootFolderId: 8 },
          { path: '/data/media/movies/europe/curated-feed/0k', rootFolderId: 9 },
        ],
      },
    ]);
    expect(alignTargetsFor(flagged('/data/media/movies/Dune (2021)', [], [owner(1, 'tracked')]))).toEqual(
      [],
    );
  });

  it('never offers a disk action on a mount', () => {
    const mount = flagged('/data', ['mount'], [owner(1, 'ancestor')]);
    const actions = actionsFor(mount);

    expect(actions).not.toContain('rename');
    expect(actions).not.toContain('move');
    expect(actions).not.toContain('prune');
  });

  // Creating folders left the row entirely - it is one toolbar button taking mkdir syntax,
  // see `planNewFolders`. A path only *Arr believes in has nothing on disk to act on at
  // all: it is not a root folder, so there is no re-map, and there is no folder to rename.
  it('offers no action at all on a path only *Arr believes in', () => {
    const missing = node('/data/media/movies/Gone (2001)', {
      exists: false,
      origin: 'arr',
      flags: ['missing'],
      owners: [owner(1, 'tracked')],
      canAddRootFolder: false,
    });

    expect(actionsFor(missing)).toEqual([]);
  });

  it('offers no row action for a root folder this container cannot see', () => {
    const unseen = node('/elsewhere/movies', {
      exists: false,
      inScope: false,
      origin: 'arr',
      flags: ['rootFolder', 'unseen'],
      owners: [owner(1, 'rootFolder')],
      canAddRootFolder: false,
    });

    // There is nothing on disk to act on, and removing its root folder is the owner
    // card's job - the chip is still there whether or not the folder is.
    expect(actionsFor(unseen)).toEqual([]);
  });
});

describe('rootFolderTargets', () => {
  it('takes its instances from the folder own owners, not from a selection', () => {
    const shared = node('/data/media/movies', {
      flags: ['rootFolder'],
      owners: [owner(1, 'rootFolder'), owner(2, 'rootFolder')],
    });

    expect(rootFolderTargets(shared)).toEqual([
      { instanceId: 1, rootFolderId: 10, path: '/data/media/movies' },
      { instanceId: 2, rootFolderId: 20, path: '/data/media/movies' },
    ]);
  });

  it('ignores an owner that merely holds media here', () => {
    const target = node('/data/media/old-movies', { owners: [owner(1, 'ancestor')] });
    expect(rootFolderTargets(target)).toEqual([]);
  });
});

describe('trackedBy', () => {
  it('names the instances that would lose media, with counts', () => {
    const target = node('/data/media/movies', {
      owners: [owner(1, 'rootFolder', { name: 'Radarr-4K', mediaUnder: 806 })],
    });

    // No column list to join against any more - the owner carries its own name.
    expect(trackedBy(target)).toEqual([{ instanceId: 1, name: 'Radarr-4K', mediaCount: 806 }]);
  });

  it('says nothing about a folder no instance holds media under', () => {
    expect(trackedBy(node('/data/media/spare', { owners: [] }))).toEqual([]);
  });
});

describe('severity', () => {
  it('is silent for ok and info - a glyph on every row would be noise', () => {
    expect(SEVERITY_STYLES.ok).toBeNull();
    expect(SEVERITY_STYLES.info).toBeNull();
    expect(SEVERITY_STYLES.warn?.classes).toContain('drift');
    expect(SEVERITY_STYLES.error?.classes).toContain('danger');
  });

  it('takes the worst of a set, in order', () => {
    expect(worstSeverity(['ok', 'info', 'warn'])).toBe('warn');
    expect(worstSeverity(['warn', 'error', 'info'])).toBe('error');
    expect(worstSeverity([])).toBe('ok');
    expect(worstSeverity(['ok'])).toBe('ok');
  });
});

describe('unknownColumns', () => {
  it('names the instances that did not answer, so an empty row is not read as "nobody"', () => {
    const columns = [column(1), column(2, { reachable: false, error: 'unreachable' })];
    expect(unknownColumns(columns).map((entry) => entry.instanceId)).toEqual([2]);
  });

  it('is empty when the whole fleet answered', () => {
    expect(unknownColumns([column(1), column(2)])).toEqual([]);
  });
});

describe('mediaSummary', () => {
  it('names the item when exactly one instance tracks one at this path', () => {
    const target = node('/data/media/movies/Dune (2021)', {
      owners: [owner(1, 'tracked', { title: 'Dune', mediaUnder: 1 })],
    });
    expect(mediaSummary(target)?.label).toBe('Dune');
  });

  it('sums across owners, and breaks the sum down in the detail', () => {
    // A 4K/HD split counts the same films twice; neither number alone is the truth, so
    // the total leads and the tooltip says who contributed what.
    const target = node('/data/media/movies', {
      owners: [
        owner(1, 'rootFolder', { name: 'Radarr', mediaUnder: 384 }),
        owner(2, 'rootFolder', { name: 'Radarr-4K', mediaUnder: 112 }),
      ],
    });

    const summary = mediaSummary(target);
    expect(summary?.label).toBe('496');
    expect(summary?.detail).toContain('Radarr: 384 item(s)');
    expect(summary?.detail).toContain('Radarr-4K: 112 item(s)');
  });

  it('says nothing for a folder nobody uses', () => {
    expect(mediaSummary(node('/data/media/spare', { owners: [] }))).toBeNull();
  });
});

describe('levelKey', () => {
  it('maps the synthetic top level to a stable key', () => {
    expect(levelKey(null)).toBe(TOP_LEVEL);
    expect(levelKey('/data')).toBe('/data');
  });
});

describe('the owner card', () => {
  it('names the claim, and counts the one that begs a number', () => {
    expect(ownerHeadline(owner(1, 'rootFolder'))).toBe('used as a root folder');
    expect(ownerHeadline(owner(1, 'rootFolder', { accessible: false }))).toContain('cannot see it');
    expect(ownerHeadline(owner(1, 'tracked'))).toContain('A Title');
    expect(ownerHeadline(owner(1, 'ancestor'))).toBe('used for media below this folder');
    expect(
      ownerHeadline(owner(1, 'containsRoot', { rootFoldersUnder: [{ id: 1, path: '/a/x' }, { id: 2, path: '/a/y' }] })),
    ).toBe('used for 2 root folders below');
  });

  it('puts one number on the chip: this instance share of the folder, zero included', () => {
    expect(ownerMedia(owner(1, 'ancestor', { mediaUnder: 806 })).value).toBe(806);

    // A bare chip could not tell "tracks nothing here" from "we did not count".
    const empty = ownerMedia(owner(1, 'containsRoot', { mediaUnder: 0 }));
    expect(empty.value).toBe(0);
    expect(empty.title).toContain('nothing tracked');
  });

  it('separates what is tracked from what is on disk', () => {
    const facts = ownerFacts(
      owner(1, 'rootFolder', { mediaUnder: 812, mediaWithFiles: 806 }),
      '/data/media/movies',
    );
    const media = facts.find((fact) => fact.label === 'Media');

    expect(media?.value).toBe('812 items at or under here');
    expect(media?.detail).toEqual(['806 on disk', '6 monitored, not downloaded']);
  });

  it('states the use as a fact, and never a Root folder section beside it', () => {
    const target = owner(1, 'containsRoot', { rootFoldersUnder: [{ id: 2, path: '/data/media/tv' }] });

    expect(ownerHeadline(target)).toBe('used for 1 root folder below');
    expect(ownerFacts(target, '/data/media').map((fact) => fact.label)).toEqual([
      'Used for',
      'Media',
      'Import lists',
    ]);
    expect(ownerFacts(owner(1, 'rootFolder'), '/data/media/movies').some((f) => f.label === 'Root folder')).toBe(
      false,
    );
  });

  it('names every list, and does not prefix the folder they fill', () => {
    const facts = ownerFacts(
      owner(1, 'containsRoot', {
        rootFoldersUnder: [{ id: 2, path: '/data/media/tv' }],
        importLists: [
          { id: 1, name: 'Trakt watchlist', enabled: true, automatic: true, path: '/data/media' },
          { id: 2, name: 'Series watchlist', enabled: true, automatic: false, path: '/data/media/tv' },
          { id: 3, name: 'Stalled', enabled: false, automatic: false, path: '/data/media/tv' },
        ],
      }),
      '/data/media',
    );
    const lists = facts.find((fact) => fact.label === 'Import lists');

    expect(lists?.value).toBe('1 list adds here, 2 more');
    expect(lists?.detail).toEqual([
      'Trakt watchlist - adds automatically',
      'Series watchlist - manual add',
      'Stalled - disabled',
    ]);
  });

  it('states the import lists even when there are none, and flags an orphaned one', () => {
    const quiet = ownerFacts(owner(1, 'rootFolder'), '/data/media/movies');
    expect(quiet.find((fact) => fact.label === 'Import lists')).toMatchObject({
      value: 'none point here',
      tone: 'muted',
    });

    // A list filling a folder its own instance does not root at is a question, not a fact.
    const orphan = ownerFacts(
      owner(1, 'importList', {
        mediaUnder: 0,
        importLists: [
          { id: 2, name: 'Stalled', enabled: false, automatic: false, path: '/data/inbox' },
        ],
      }),
      '/data/inbox',
    );
    expect(orphan.find((fact) => fact.label === 'Import lists')).toMatchObject({
      value: '1 list adds here',
      detail: ['Stalled - disabled'],
      tone: 'warn',
    });
  });

  it('says how the instance uses the folder, not a Root folder section with free space', () => {
    const rooted = ownerFacts(owner(1, 'rootFolder'), '/data/media/movies');
    expect(rooted[0]).toMatchObject({ label: 'Used as', value: 'root folder' });
    expect(rooted.some((fact) => fact.label === 'Root folder')).toBe(false);

    const parent = ownerFacts(
      owner(1, 'containsRoot', { rootFoldersUnder: [{ id: 2, path: '/data/media/tv' }] }),
      '/data/media',
    );
    expect(parent[0]).toMatchObject({ label: 'Used for', value: '1 root folder below' });
  });
});

describe('prunableFolders', () => {
  it('keeps only what actionsFor would offer a prune on', () => {
    const spare = node('/data/media/spare', { owners: [] });
    const mount = node('/data', { flags: ['mount'] });
    const tracked = node('/data/media/movies/Dune (2021)', {
      owners: [owner(1, 'tracked', { mediaUnder: 1 })],
    });

    // A tracked folder is deletable now - expensively, and the dialog says so. A mount
    // never is.
    expect(prunableFolders([spare, mount, tracked])).toEqual([spare, tracked]);
  });

  it('names the folders it dropped as covered by a parent, rather than losing them', () => {
    // `prunableFolders` drops the child; a batch that simply showed one fewer folder would
    // be describing a smaller deletion than it performs.
    const parent = node('/data/media/spare', { owners: [] });
    const child = node('/data/media/spare/2019', { owners: [] });

    expect(absorbedFolders([parent, child])).toEqual([child]);
    expect(absorbedFolders([parent])).toEqual([]);
  });

  it('drops a selected folder that another selected folder already contains', () => {
    // The parent's recursive delete takes the child with it, so staging both would leave the
    // second one failing its re-run preflight and pausing the whole batch.
    const parent = node('/data/media/spare', { owners: [] });
    const child = node('/data/media/spare/2019', { owners: [] });

    expect(prunableFolders([parent, child])).toEqual([parent]);
    expect(prunableFolders([child, parent])).toEqual([parent]);
  });

  it('keeps siblings, and is not fooled by a shared name prefix', () => {
    const spare = node('/data/media/spare', { owners: [] });
    const spares = node('/data/media/spares', { owners: [] });

    expect(prunableFolders([spare, spares])).toEqual([spare, spares]);
  });

  it('keeps a child whose parent was selected but is not itself prunable', () => {
    // The parent is a mount, so nothing recursive is coming for the child.
    const mount = node('/data', { flags: ['mount'] });
    const child = node('/data/spare', { owners: [] });

    expect(prunableFolders([mount, child])).toEqual([child]);
  });
});
