import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_MEDIA_FILTER_TERMS,
  MEDIA_FILTER_FIELDS,
  matchMediaFilter,
  mediaFilterField,
  parseMediaFilter,
  type MediaFilterFacet,
  type MediaFilterRow,
  type MediaFilterVerdict,
} from './media-filter.js';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function facet(overrides: Partial<MediaFilterFacet> = {}): MediaFilterFacet {
  return {
    instanceId: 1,
    name: 'radarr-hd',
    kind: 'radarr',
    monitored: true,
    hasFile: true,
    sizeOnDisk: 4 * 1024 ** 3,
    path: '/data/media/movies/main/Dune (2021)',
    rootFolderPath: '/data/media/movies/main',
    tags: ['4k-remux', 'kids'],
    qualityProfileName: 'HD-1080p',
    added: '2024-03-15T09:00:00Z',
    lists: ['Trakt watchlist'],
    excludedFromLists: false,
    ...overrides,
  };
}

function movieRow(overrides: Partial<MediaFilterRow> = {}): MediaFilterRow {
  return {
    key: 'movie:tmdb:438631',
    kind: 'movie',
    title: 'Dune',
    sortTitle: 'dune',
    year: 2021,
    status: 'released',
    genres: ['Science Fiction', 'Adventure'],
    certification: 'PG-13',
    runtime: 155,
    studio: 'Legendary Pictures',
    collection: 'Dune Collection',
    tmdbId: 438631,
    tvdbId: null,
    imdbId: 'tt1160419',
    titleSlug: 'dune-438631',
    seriesType: null,
    minimumAvailability: 'released',
    facets: [facet()],
    unknownInstanceIds: [],
    ...overrides,
  };
}

function seriesRow(overrides: Partial<MediaFilterRow> = {}): MediaFilterRow {
  return {
    ...movieRow(),
    key: 'series:tvdb:121361',
    kind: 'series',
    title: 'Shogun',
    sortTitle: 'shogun',
    year: 2024,
    status: 'ended',
    tmdbId: null,
    tvdbId: 121361,
    titleSlug: 'shogun',
    seriesType: 'standard',
    minimumAvailability: null,
    collection: null,
    facets: [facet({ instanceId: 2, name: 'sonarr-tv', kind: 'sonarr', lists: null, excludedFromLists: null })],
    unknownInstanceIds: [],
    ...overrides,
  };
}

const verdict = (source: string, row: MediaFilterRow): MediaFilterVerdict =>
  matchMediaFilter(parseMediaFilter(source, { now: NOW }), row).verdict;

const reasons = (source: string, row: MediaFilterRow): readonly string[] =>
  matchMediaFilter(parseMediaFilter(source, { now: NOW }), row).reasons;

const errorOf = (source: string): string | null => parseMediaFilter(source, { now: NOW }).error;

describe('the grammar', () => {
  test('a bare word matches part of the title, case-insensitively', () => {
    assert.equal(verdict('dune', movieRow()), 'match');
    assert.equal(verdict('DUN', movieRow()), 'match');
    assert.equal(verdict('heat', movieRow()), 'no');
  });

  test('a bare word with a glob matches the whole title', () => {
    assert.equal(verdict('Dun*', movieRow()), 'match');
    assert.equal(verdict('*une', movieRow()), 'match');
    assert.equal(verdict('un*', movieRow()), 'no');
  });

  test('a bare word searches the sort title too, which is how *Arr matches', () => {
    const row = movieRow({ title: 'The Matrix', sortTitle: 'matrix, the' });
    assert.equal(verdict('matrix, the', row), 'match');
  });

  test('a pasted IMDb id finds the row without a field name', () => {
    assert.equal(verdict('tt1160419', movieRow()), 'match');
    assert.equal(verdict('tt0000001', movieRow()), 'no');
  });

  test('a space is AND, not OR - the folder filter reads the other way round', () => {
    assert.equal(verdict('dune 2021', movieRow()), 'no'); // "2021" is not in the title
    assert.equal(verdict('dune tags:kids', movieRow()), 'match');
    assert.equal(verdict('dune tags:absent', movieRow()), 'no');
    assert.equal(verdict('dune OR tags:absent', movieRow()), 'match');
  });

  test('lowercase and/or/not are title text, so "dead or alive" still searches', () => {
    const row = movieRow({ title: 'Dead or Alive', sortTitle: 'dead or alive' });
    assert.equal(verdict('dead or alive', row), 'match');
    // proof it was three AND'd words and not a disjunction: one absent word fails it
    assert.equal(verdict('dead or zombies', row), 'no');
  });

  test('precedence is NOT then AND then OR, and parentheses override it', () => {
    const row = movieRow();
    // year:1999 OR (dune AND tags:kids)
    assert.equal(verdict('year:1999 OR dune tags:kids', row), 'match');
    assert.equal(verdict('(year:1999 OR dune) tags:absent', row), 'no');
    // (NOT year:1999) AND dune
    assert.equal(verdict('NOT year:1999 dune', row), 'match');
    assert.equal(verdict('NOT year:2021 dune', row), 'no');
  });

  test('&&, ||, !, - and !: are aliases that agree with the words', () => {
    const row = movieRow();
    assert.equal(verdict('dune && tags:kids', row), 'match');
    assert.equal(verdict('year:1999 || dune', row), 'match');
    for (const source of ['NOT tags:4k-remux', '!tags:4k-remux', '-tags:4k-remux', 'tags!:4k-remux']) {
      assert.equal(verdict(source, row), 'no', source);
    }
    for (const source of ['NOT tags:absent', '!tags:absent', '-tags:absent', 'tags!:absent']) {
      assert.equal(verdict(source, row), 'match', source);
    }
  });

  test('a hyphen inside a word is not negation', () => {
    const row = movieRow({ title: 'Spider-Man', sortTitle: 'spider-man' });
    assert.equal(verdict('spider-man', row), 'match');
    assert.equal(verdict('tags:4k-remux', movieRow()), 'match');
  });

  test('an unregistered ident before a colon is a title search, not an error', () => {
    const row = movieRow({ title: 'Mission: Impossible', sortTitle: 'mission: impossible' });
    assert.equal(errorOf('Mission:Impossible'), null);
    assert.equal(verdict('Mission:Impossible', row), 'no'); // the space in the title is real
    assert.equal(verdict('Mission: Impossible', row), 'match'); // two words, both present
  });

  test('quoting and escaping keep a space inside one value', () => {
    const row = movieRow();
    assert.equal(verdict('list:"Trakt watchlist"', row), 'match');
    assert.equal(verdict("list:'Trakt watchlist'", row), 'match');
    assert.equal(verdict('list:Trakt\\ watchlist', row), 'match');
    assert.equal(verdict('profile:"HD-1080p"', row), 'match');
  });

  test('brace expansion runs on values, so one term can carry several', () => {
    const row = movieRow();
    assert.equal(verdict('tags:{kids,anime}', row), 'match');
    assert.equal(verdict('tags:{anime,horror}', row), 'no');
    assert.equal(verdict('year:{2019..2021}', row), 'match');
    assert.equal(verdict('year:{2018..2020}', row), 'no');
    // a space inside braces belongs to the value
    assert.equal(verdict('list:{"Trakt watchlist",Imdb}', row), 'match');
  });

  test('sets are exact unless you glob them - a tag is an identity, not prose', () => {
    const row = movieRow({ facets: [facet({ tags: ['4k-remux'] })] });
    assert.equal(verdict('tags:4k', row), 'no');
    assert.equal(verdict('tags:*4k*', row), 'match');
    assert.equal(verdict('tags:4k-remux', row), 'match');
    assert.equal(verdict('genre:Science', row), 'no');
    assert.equal(verdict('genre:"Science Fiction"', row), 'match');
  });

  test('a colon on a number is equality, not a substring', () => {
    const row = movieRow();
    assert.equal(verdict('year:202', row), 'no');
    assert.equal(verdict('year:2021', row), 'match');
  });

  test('numeric comparisons and ranges', () => {
    const row = movieRow();
    assert.equal(verdict('year<2000', row), 'no');
    assert.equal(verdict('year>2000', row), 'match');
    assert.equal(verdict('year>=2021', row), 'match');
    assert.equal(verdict('year<=2021', row), 'match');
    assert.equal(verdict('year:2019..2021', row), 'match');
    assert.equal(verdict('year:1990..1999', row), 'no');
    assert.equal(verdict('runtime>150', row), 'match');
  });

  test('sizes are 1024-based, so the filter agrees with the number on screen', () => {
    const row = movieRow({ facets: [facet({ sizeOnDisk: 10 * 1024 ** 3 })] });
    assert.equal(verdict('size>=10GB', row), 'match');
    assert.equal(verdict('size>10GB', row), 'no');
    assert.equal(verdict('size>9.9GB', row), 'match');
    assert.equal(verdict('size>10000000000', row), 'match'); // 10 GB decimal is smaller
    assert.equal(verdict('size:10GiB', row), 'match');
  });

  test('a date literal is the whole interval it names', () => {
    const row = movieRow();
    assert.equal(verdict('added:2024', row), 'match');
    assert.equal(verdict('added:2024-03', row), 'match');
    assert.equal(verdict('added:2024-03-15', row), 'match');
    assert.equal(verdict('added:2024-03-16', row), 'no');
    assert.equal(verdict('added:2023', row), 'no');
    assert.equal(verdict('added:2024-01-01..2024-06-30', row), 'match');
  });

  test('> and <= partition the timeline, with neither claiming half of a day', () => {
    // added is 2024-03-15T09:00Z, so the day it is in belongs to <= and not to >
    const row = movieRow();
    assert.equal(verdict('added>2024-03-15', row), 'no');
    assert.equal(verdict('added<=2024-03-15', row), 'match');
    assert.equal(verdict('added>=2024-03-15', row), 'match');
    assert.equal(verdict('added<2024-03-15', row), 'no');
    // and the pair is complementary either side of that day
    assert.equal(verdict('added>2024-03-14', row), 'match');
    assert.equal(verdict('added<=2024-03-14', row), 'no');
  });

  test('a relative date is an instant, resolved against a pinned now', () => {
    const recent = movieRow({ facets: [facet({ added: new Date(NOW - 10 * 86_400_000).toISOString() })] });
    assert.equal(verdict('added>-30d', recent), 'match');
    assert.equal(verdict('added>-1w', recent), 'no');
    assert.equal(verdict('added<-1w', recent), 'match');
    assert.equal(verdict('added>-6mo', recent), 'match');
    assert.equal(verdict('added<now', recent), 'match');
  });

  test('"none" is a known absence, and quoting it makes it a literal again', () => {
    const bare = movieRow({
      certification: null,
      facets: [facet({ tags: [], qualityProfileName: null, rootFolderPath: null })],
    });
    assert.equal(verdict('tags:none', bare), 'match');
    assert.equal(verdict('tags:none', movieRow()), 'no');
    assert.equal(verdict('certification:none', bare), 'match');
    assert.equal(verdict('profile:none', bare), 'match');
    assert.equal(verdict('root:none', bare), 'match');
    // a tag literally called "none"
    const named = movieRow({ facets: [facet({ tags: ['none'] })] });
    assert.equal(verdict('tags:"none"', named), 'match');
    assert.equal(verdict('tags:"none"', bare), 'no');
  });

  test('a path value is judged by the rule Paths uses', () => {
    const row = movieRow();
    assert.equal(verdict('path:movies/main', row), 'match');
    assert.equal(verdict('path:movies/4k', row), 'no');
    assert.equal(verdict('root:movies/main', row), 'match');
    assert.equal(verdict('root:{movies/main,movies/4k}', row), 'match');
    assert.equal(verdict('root="/data/media/movies/main"', row), 'match');
  });

  test('an instance is reachable by name, by app and by id', () => {
    const row = movieRow();
    assert.equal(verdict('instance:radarr-hd', row), 'match');
    assert.equal(verdict('instance:radarr', row), 'match');
    assert.equal(verdict('instance:1', row), 'match');
    assert.equal(verdict('instance:radarr-*', row), 'match');
    assert.equal(verdict('instance:sonarr', row), 'no');
  });
});

describe('errors are positions, not guesses', () => {
  test('the wrong operator for the type', () => {
    assert.match(errorOf('title<5') ?? '', /cannot be compared with/);
    assert.match(errorOf('monitored>1') ?? '', /cannot be compared with/);
  });

  test('a value the type cannot read', () => {
    assert.match(errorOf('year:nineteen') ?? '', /takes a number, not/);
    assert.match(errorOf('monitored:maybe') ?? '', /takes true or false, not/);
    assert.match(errorOf('size:big') ?? '', /takes a size like 20GB/);
    assert.match(errorOf('added:soon') ?? '', /takes a date like/);
  });

  test('a bad enum member lists the members', () => {
    const message = errorOf('status:release') ?? '';
    assert.match(message, /has no value/);
    assert.match(message, /released/);
    assert.match(message, /continuing/);
  });

  test('a relative date needs a sign, so nothing guesses a direction', () => {
    const message = errorOf('added>30d') ?? '';
    assert.match(message, /needs a sign/);
    assert.match(message, /-30d/);
  });

  test('a field with no value says how to ask for absence instead', () => {
    const message = errorOf('tags:') ?? '';
    assert.match(message, /needs a value/);
    assert.match(message, /tags:none/);
  });

  test('unbalanced parens and dangling operators', () => {
    assert.match(errorOf('(tags:kids OR dune') ?? '', /unclosed “\(” at position 1/);
    assert.match(errorOf('dune)') ?? '', /unexpected “\)”/);
    assert.match(errorOf('dune AND') ?? '', /“AND” needs a term after it/);
    assert.match(errorOf('dune OR') ?? '', /“OR” needs a term after it/);
    assert.match(errorOf('dune NOT') ?? '', /“NOT” needs a term after it/);
  });

  test('quantifiers do not nest', () => {
    assert.match(errorOf('all(any(monitored:false))') ?? '', /quantifiers do not nest/);
    assert.equal(errorOf('all(monitored:false)'), null);
  });

  test('an unclosed brace is reported at its real position, not the value\'s', () => {
    // `{` is character 6 of the expression, not character 1 of the value
    assert.equal(parseMediaFilter('tags:{4k,hdr year<2000').errorAt, 6);
    assert.match(parseMediaFilter('tags:{4k,hdr year<2000').error ?? '', /unclosed “\{” at position 6/);
    assert.match(errorOf('title:"dune') ?? '', /unclosed double quote/);
  });

  test('it refuses to explode', () => {
    const many = Array.from({ length: MAX_MEDIA_FILTER_TERMS + 5 }, (_, i) => `year:${String(1900 + i)}`).join(' OR ');
    assert.match(errorOf(many) ?? '', /more than 64 terms/);
    assert.match(errorOf('tags:{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}') ?? '', /more than/);
  });

  test('a likely typo is a hint, not an error - the filter still applies', () => {
    const parsed = parseMediaFilter('tgs:4k', { now: NOW });
    assert.equal(parsed.error, null);
    assert.equal(parsed.active, true);
    assert.equal(parsed.hints.length, 1);
    assert.match(parsed.hints[0] ?? '', /did you mean “tags:4k”/);
    // and something that is not near a field name gets no hint
    assert.deepEqual(parseMediaFilter('Mission:Impossible', { now: NOW }).hints, []);
  });

  test('a filter that cannot be read never filters', () => {
    for (const source of ['(tags:kids', 'year:nineteen', 'tags:', 'dune AND', 'all(any(dune))']) {
      const broken = parseMediaFilter(source, { now: NOW });
      assert.notEqual(broken.error, null, source);
      assert.equal(broken.active, false, source);
      assert.equal(matchMediaFilter(broken, movieRow()).verdict, 'match', source);
    }
  });

  test('blank is inactive and not an error', () => {
    for (const source of ['', '   ', '\t\n']) {
      const parsed = parseMediaFilter(source, { now: NOW });
      assert.equal(parsed.error, null);
      assert.equal(parsed.active, false);
    }
  });
});

describe('row and facet scoping', () => {
  const split = movieRow({
    facets: [
      facet({ instanceId: 1, name: 'radarr-hd', monitored: false, tags: ['kids'] }),
      facet({ instanceId: 2, name: 'radarr-4k', monitored: true, tags: ['4k-remux'] }),
    ],
  });

  test('a facet-scoped conjunction has to be satisfied by one and the same instance', () => {
    // unmonitored on hd, tagged 4k-remux on 4k - no single copy is both
    assert.equal(verdict('monitored:false tags:4k-remux', split), 'no');
    assert.equal(verdict('monitored:false tags:kids', split), 'match');
  });

  test('any() is how the loose reading is asked for', () => {
    assert.equal(verdict('any(monitored:false) any(tags:4k-remux)', split), 'match');
  });

  test('matchedInstanceIds names only the satisfying copies, and every copy survives', () => {
    const result = matchMediaFilter(parseMediaFilter('tags:4k-remux', { now: NOW }), split);
    assert.equal(result.verdict, 'match');
    assert.deepEqual(result.matchedInstanceIds, [2]);
    // the row still exposes both, so the chip strip cannot lie about who holds the title
    assert.equal(split.facets.length, 2);
  });

  test('an inactive filter matches on every copy', () => {
    const result = matchMediaFilter(parseMediaFilter('', { now: NOW }), split);
    assert.equal(result.verdict, 'match');
    assert.deepEqual(result.matchedInstanceIds, [1, 2]);
    assert.deepEqual(result.reasons, []);
  });

  test('all() needs every copy, and one dissenter fails it', () => {
    assert.equal(verdict('all(monitored:false)', split), 'no');
    const both = movieRow({
      facets: [facet({ instanceId: 1, monitored: false }), facet({ instanceId: 2, monitored: false })],
    });
    assert.equal(verdict('all(monitored:false)', both), 'match');
  });

  test('"absent from that instance" is NOT any(instance:…)', () => {
    assert.equal(verdict('instance:radarr-4k NOT any(instance:radarr-hd)', split), 'no');
    const only4k = movieRow({ facets: [facet({ instanceId: 2, name: 'radarr-4k' })] });
    assert.equal(verdict('instance:radarr-4k NOT any(instance:radarr-hd)', only4k), 'match');
  });

  test('instances counts the copies, which is the de-duplication worklist', () => {
    assert.equal(verdict('instances>1', split), 'match');
    assert.equal(verdict('instances:1', split), 'no');
    assert.equal(verdict('instances:1', movieRow()), 'match');
  });

  test('the NOT trap: "some copy is unmonitored" is not "unmonitored everywhere"', () => {
    // Reads as any(): one unmonitored copy is enough. `all(monitored:false)` is the other question.
    assert.equal(verdict('NOT monitored:true', split), 'match');
    assert.equal(verdict('all(monitored:false)', split), 'no');
  });

  test('a row-only expression ignores the copies entirely', () => {
    assert.equal(parseMediaFilter('year<2030', { now: NOW }).usesFacetFields, false);
    assert.equal(parseMediaFilter('tags:kids', { now: NOW }).usesFacetFields, true);
    assert.equal(verdict('year<2030', split), 'match');
  });
});

describe('unknown is not no', () => {
  test('a list question on a Sonarr copy is unanswerable, and says why', () => {
    const row = seriesRow();
    assert.equal(verdict('list:"Trakt watchlist"', row), 'unknown');
    assert.deepEqual(reasons('list:"Trakt watchlist"', row), [
      'import-list membership is not answerable on Sonarr',
    ]);
  });

  test('NOT of an unanswerable question stays unanswerable', () => {
    // The rule this whole design exists for: a list Sonarr cannot report on must never
    // render as "not on the list".
    assert.equal(verdict('NOT list:"Trakt watchlist"', seriesRow()), 'unknown');
    assert.equal(verdict('list:none', seriesRow()), 'unknown');
    assert.equal(verdict('excluded:false', seriesRow()), 'unknown');
  });

  test('a definite miss decides a conjunction, so we answer what we can', () => {
    // U AND F = F. An "unknown poisons everything" scheme would have parked this
    // in the undecided pile even though the year alone settles it.
    assert.equal(verdict('list:"Trakt watchlist" year<2000', seriesRow()), 'no');
    assert.equal(verdict('list:"Trakt watchlist" year:2024', seriesRow()), 'unknown');
  });

  test('a definite match decides a disjunction', () => {
    assert.equal(verdict('list:"Trakt watchlist" OR year:2024', seriesRow()), 'match');
    assert.equal(verdict('list:"Trakt watchlist" OR year<2000', seriesRow()), 'unknown');
  });

  test('the Kleene tables, exhaustively', () => {
    // match / no / unknown, expressed as a term each against one fixture
    const row = seriesRow();
    const T = 'year:2024';
    const F = 'year:1999';
    const U = 'list:x';

    const and: ReadonlyArray<[string, string, MediaFilterVerdict]> = [
      [T, T, 'match'], [T, F, 'no'], [T, U, 'unknown'],
      [F, F, 'no'], [F, U, 'no'], [U, U, 'unknown'],
    ];
    for (const [left, right, expected] of and) {
      assert.equal(verdict(`${left} AND ${right}`, row), expected, `${left} AND ${right}`);
      assert.equal(verdict(`${right} AND ${left}`, row), expected, `${right} AND ${left}`);
    }

    const or: ReadonlyArray<[string, string, MediaFilterVerdict]> = [
      [T, T, 'match'], [T, F, 'match'], [T, U, 'match'],
      [F, F, 'no'], [F, U, 'unknown'], [U, U, 'unknown'],
    ];
    for (const [left, right, expected] of or) {
      assert.equal(verdict(`${left} OR ${right}`, row), expected, `${left} OR ${right}`);
      assert.equal(verdict(`${right} OR ${left}`, row), expected, `${right} OR ${left}`);
    }

    assert.equal(verdict(`NOT ${T}`, row), 'no');
    assert.equal(verdict(`NOT ${F}`, row), 'match');
    assert.equal(verdict(`NOT ${U}`, row), 'unknown');
  });

  test('a Radarr copy that was never read for lists is unknown, with its own reason', () => {
    const row = movieRow({ facets: [facet({ lists: null, excludedFromLists: null })] });
    assert.equal(verdict('list:x', row), 'unknown');
    assert.deepEqual(reasons('list:x', row), ['radarr-hd did not answer for import lists']);
  });

  test('hasFile is derived on Sonarr, and unknown only when nothing reported it', () => {
    const known = seriesRow({ facets: [facet({ kind: 'sonarr', hasFile: true, lists: null })] });
    assert.equal(verdict('hasFile:true', known), 'match');

    const silent = seriesRow({
      facets: [facet({ kind: 'sonarr', hasFile: null, sizeOnDisk: null, lists: null })],
    });
    assert.equal(verdict('hasFile:true', silent), 'unknown');
    assert.equal(verdict('hasFile:false', silent), 'unknown');
    assert.equal(verdict('size>1GB', silent), 'unknown');
  });

  test('a field the entity does not have is a known absence, not an unknown', () => {
    // The other half of the distinction: a film has no series type EVER, so this is a
    // fact about the entity rather than about our access.
    assert.equal(verdict('seriesType:anime', movieRow()), 'no');
    assert.equal(verdict('seriesType:none', movieRow()), 'match');
    assert.equal(verdict('tvdb:121361', movieRow()), 'no');
    assert.equal(verdict('minAvail:none', seriesRow()), 'match');
    assert.equal(verdict('minAvail:released', seriesRow()), 'no');

    // A series has no TMDB collection ever - so this is `none`, never `unknown`, even
    // though Sonarr is the app that cannot answer it. The entity decides, not the app.
    assert.equal(verdict('collection:"Dune Collection"', seriesRow()), 'no');
    assert.equal(verdict('collection:none', seriesRow()), 'match');
  });

  test('collection matches exactly, globs, and reads none for a standalone film', () => {
    assert.equal(verdict('collection:"Dune Collection"', movieRow()), 'match');
    assert.equal(verdict('collection:*Dune*', movieRow()), 'match');
    assert.equal(verdict('coll:"Dune Collection"', movieRow()), 'match');
    assert.equal(verdict('collection:"Bond Collection"', movieRow()), 'no');
    // A film in no collection is a known absence, exactly like a film with no certification.
    assert.equal(verdict('collection:none', movieRow({ collection: null })), 'match');
    assert.equal(verdict('collection:*', movieRow({ collection: null })), 'no');
  });

  test('an incomplete set of copies cannot honestly answer no', () => {
    // radarr-hd answered and has no such tag; radarr-4k stayed silent and might.
    const partial = movieRow({
      facets: [facet({ instanceId: 1, tags: ['kids'] })],
      unknownInstanceIds: [2],
    });
    assert.equal(verdict('tags:4k-remux', partial), 'unknown');
    assert.match(reasons('tags:4k-remux', partial)[0] ?? '', /did not answer/);

    // a definite match still wins outright
    assert.equal(verdict('tags:kids', partial), 'match');
    // and a row-only question is unaffected: the year is the same everywhere
    assert.equal(verdict('year:1999', partial), 'no');
    assert.equal(verdict('year:2021', partial), 'match');
  });

  test('all() over an incomplete set will not claim universality', () => {
    const partial = movieRow({
      facets: [facet({ instanceId: 1, monitored: false })],
      unknownInstanceIds: [2],
    });
    assert.equal(verdict('all(monitored:false)', partial), 'unknown');
    assert.equal(verdict('all(monitored:true)', partial), 'no');
  });

  test('reasons are deduplicated and only reported when the verdict is unknown', () => {
    const two = seriesRow({
      facets: [
        facet({ instanceId: 2, name: 'sonarr-tv', kind: 'sonarr', lists: null, excludedFromLists: null }),
        facet({ instanceId: 3, name: 'sonarr-anime', kind: 'sonarr', lists: null, excludedFromLists: null }),
      ],
    });
    assert.deepEqual(reasons('list:x', two), ['import-list membership is not answerable on Sonarr']);
    // decided, so nothing to explain
    assert.deepEqual(reasons('list:x year<2000', two), []);
    assert.deepEqual(reasons('year:2024', two), []);
  });
});

describe('the registry', () => {
  test('every field is reachable by its name and each alias, with no duplicates', () => {
    const seen = new Set<string>();
    for (const field of MEDIA_FILTER_FIELDS) {
      for (const name of [field.name, ...field.aliases]) {
        const key = name.toLowerCase();
        assert.equal(seen.has(key), false, `duplicate field name: ${name}`);
        seen.add(key);
        assert.equal(mediaFilterField(name), field, name);
        assert.equal(mediaFilterField(name.toUpperCase()), field, name);
      }
    }
    assert.equal(mediaFilterField('nonesuch'), null);
  });

  test('the operator matrix is driven off the type, so a text field cannot take <', () => {
    for (const field of MEDIA_FILTER_FIELDS) {
      const ordered = field.type === 'number' || field.type === 'bytes' || field.type === 'date';
      const parsed = parseMediaFilter(`${field.name}<1`, { now: NOW });
      if (ordered) {
        assert.doesNotMatch(parsed.error ?? '', /cannot be compared with/, field.name);
      } else {
        assert.match(parsed.error ?? '', /cannot be compared with/, field.name);
      }
    }
  });

  test('every enum has members, every vocabulary field is a set, every field describes itself', () => {
    for (const field of MEDIA_FILTER_FIELDS) {
      if (field.type === 'enum') {
        assert.ok((field.members ?? []).length > 0, `${field.name} has no members`);
      }
      if (field.vocabulary !== undefined) {
        // A vocabulary only makes sense where the values are names the fleet supplies:
        // a set of them, or a path. Offering completions for a number would be noise.
        assert.ok(
          field.type === 'set' || field.type === 'path',
          `${field.name} has a vocabulary but is a ${field.type}`,
        );
      }
      assert.ok(field.describe.length > 0, `${field.name} has no description`);
      // answerableOn is what produces `unknown`; entities is what produces `none`
      assert.notEqual(
        field.answerableOn !== undefined && field.entities !== undefined,
        true,
        `${field.name} claims both an entity and an app restriction`,
      );
    }
  });
});
