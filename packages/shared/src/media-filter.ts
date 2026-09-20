/**
 * The media filter language.
 *
 * One box that has to reach what Radarr's and Sonarr's own filters reach - and/or across
 * many fields at once - plus the one thing they cannot do, which is ask a question of the
 * whole fleet: `instances>1`, `list:"Trakt watchlist"`, `all(monitored:false)`.
 *
 *   tags:4k year<2000 NOT list:"Trakt watchlist"
 *
 * Three things about it are deliberate, and each one is a decision rather than an accident:
 *
 * **A space is AND here.** The folder filter's space is OR, because a list of *patterns*
 * disjoins; a list of *constraints* conjoins. Anyone who learned the other box first will
 * be surprised once, so it is said here, on the help card, and in a test whose name says so.
 *
 * **`AND` / `OR` / `NOT` are uppercase only.** `dead or alive` has to stay a title search.
 *
 * **A verdict has three values, not two.** Sonarr exposes no import-list contents endpoint,
 * so `list:X` on a Sonarr copy is not false - it is unanswerable, and `NOT list:X` is
 * unanswerable too. Kleene logic keeps that straight, and the deliberate absence of a
 * `passesMediaFilter` boolean is what stops any caller collapsing it back to two: the type
 * system makes every one of them decide what "unknown" means for them. Rows that cannot be
 * judged are counted and stated, never quietly dropped into the pile of non-matches.
 *
 * Shared rather than server-only for the same reason `path-filter.ts` is: the server judges
 * the rows it returns, and the browser has to reach the identical verdict to report an
 * error, hint at a typo, or complete a value.
 */

import type { InstanceKind, MediaKind } from './instance.js';
import {
  compilePathPattern,
  compileValueMatcher,
  expandBraces,
  matchTerm,
  pathSegments,
  type PathFilterTerm,
  type PathSegmentMatcher,
} from './path-filter.js';

// --------------------------------------------------------------------- verdicts

/**
 * Where a row, or one copy of it, stands against a filter.
 *
 * `unknown` is the one that earns its keep: it is what we say when the answer is not
 * knowable rather than negative, and it never renders as absence.
 */
export type MediaFilterVerdict = 'match' | 'no' | 'unknown';

/** The ceiling on one expression. A CPU bomb is a dozen keystrokes away without them. */
export const MAX_MEDIA_FILTER_TERMS = 64;
export const MAX_MEDIA_FILTER_VALUES = 1000;
export const MAX_MEDIA_FILTER_DEPTH = 32;

// --------------------------------------------------------- what the evaluator reads

/**
 * One instance's copy of a title.
 *
 * Structural on purpose: `MediaFacet` on the wire satisfies it, so the server hands its
 * rows straight to the evaluator, while this module stays testable with fixtures written
 * by hand and a schema widening cannot ripple into the grammar.
 */
export interface MediaFilterFacet {
  readonly instanceId: number;
  readonly name: string;
  readonly kind: InstanceKind;
  readonly monitored: boolean;
  /** null is UNKNOWN: Sonarr has no top-level `hasFile` and may report no statistics. */
  readonly hasFile: boolean | null;
  readonly sizeOnDisk: number | null;
  readonly path: string;
  readonly rootFolderPath: string | null;
  readonly tags: readonly string[];
  readonly qualityProfileName: string | null;
  readonly added: string | null;
  /** null is UNKNOWN, not empty - Sonarr cannot answer, and a Radarr read can fail. */
  readonly lists: readonly string[] | null;
  readonly excludedFromLists: boolean | null;
}

export interface MediaFilterRow {
  readonly key: string;
  readonly kind: MediaKind;
  readonly title: string;
  readonly sortTitle: string;
  readonly year: number | null;
  readonly status: string | null;
  readonly genres: readonly string[];
  readonly certification: string | null;
  readonly runtime: number | null;
  readonly studio: string | null;
  /**
   * The TMDB collection this title belongs to.
   *
   * Row scope, not facet: the collection comes from TMDB, so two Radarr instances holding
   * the same film agree on it by construction. Null on a series - a known absence, which
   * is why the field declares `entities: ['movie']` rather than `answerableOn`.
   */
  readonly collection: string | null;
  readonly tmdbId: number | null;
  readonly tvdbId: number | null;
  readonly imdbId: string | null;
  readonly titleSlug: string | null;
  readonly seriesType: string | null;
  readonly minimumAvailability: string | null;
  readonly facets: readonly MediaFilterFacet[];
  /**
   * Instances of this row's kind that did not answer at all.
   *
   * Load-bearing: one of them may hold a copy that would have matched, so a
   * facet-scoped filter over an incomplete set cannot honestly return "no".
   */
  readonly unknownInstanceIds: readonly number[];
}

/**
 * What a field reads off a row or a facet.
 *
 * `none` and `unknown` are the whole point of this being a union rather than
 * `string | number | null`: a known absence and an unanswerable question are different
 * facts, and conflating them is exactly how "unknown" turns into "missing".
 */
export type MediaFieldValue =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  /** Epoch milliseconds. */
  | { readonly kind: 'date'; readonly value: number }
  | { readonly kind: 'set'; readonly values: readonly string[] }
  /** A known absence on a known copy: an empty string, an empty array, a field this
   *  entity does not have at all. Never a way to spell "unknown". */
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly reason: string };

const NONE: MediaFieldValue = { kind: 'none' };

function textValue(value: string | null | undefined): MediaFieldValue {
  return value === null || value === undefined || value.length === 0
    ? NONE
    : { kind: 'text', value };
}

function numberValue(value: number | null | undefined): MediaFieldValue {
  return value === null || value === undefined ? NONE : { kind: 'number', value };
}

function setValue(values: readonly string[] | null | undefined): MediaFieldValue {
  return values === null || values === undefined || values.length === 0
    ? NONE
    : { kind: 'set', values };
}

function dateValue(iso: string | null | undefined): MediaFieldValue {
  if (iso === null || iso === undefined || iso.length === 0) return NONE;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? NONE : { kind: 'date', value: parsed };
}

// ------------------------------------------------------------------- the registry

export type MediaFieldType = 'text' | 'enum' | 'set' | 'number' | 'bytes' | 'date' | 'bool' | 'path';
export type MediaFieldScope = 'row' | 'facet';

/** Field-value lists the browser cannot know without asking the fleet. */
export interface MediaFilterVocabulary {
  readonly instances: readonly string[];
  readonly tags: readonly string[];
  readonly lists: readonly string[];
  readonly qualityProfiles: readonly string[];
  readonly genres: readonly string[];
  readonly certifications: readonly string[];
  readonly rootFolders: readonly string[];
  readonly collections: readonly string[];
}

export interface MediaFieldDef {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: MediaFieldType;
  readonly scope: MediaFieldScope;
  /** Fixed members, validated at parse time. `enum` only. */
  readonly members?: readonly string[];
  /**
   * Which entities have this attribute at all. A field absent from a row's kind reads
   * `none` - a known fact about the entity, never `unknown`.
   */
  readonly entities?: readonly MediaKind[];
  /**
   * Which app can answer it. A field the app has no endpoint for reads `unknown` -
   * a fact about our access, never `none`.
   *
   * That one sentence is the whole distinction this language hangs on: a movie has no
   * series type *ever*, so `seriesType:none` is true; Sonarr merely cannot *tell us*
   * about lists, so `list:none` is unknown.
   */
  readonly answerableOn?: readonly InstanceKind[];
  /**
   * Values the browser cannot know without asking the fleet, so the help card can offer
   * them. Only for fields whose values are *names* - a set, or a path.
   */
  readonly vocabulary?: keyof MediaFilterVocabulary;
  /** One line for the help card. Non-empty for every field; a test pins that. */
  readonly describe: string;
  read(row: MediaFilterRow, facet: MediaFilterFacet | null): MediaFieldValue;
}

const MOVIE_STATUSES = ['tba', 'announced', 'inCinemas', 'released', 'deleted'] as const;
const SERIES_STATUSES = ['continuing', 'ended', 'upcoming', 'deleted'] as const;

/** Both apps' vocabularies in one list: a member from the wrong app is a known non-match. */
export const MEDIA_STATUSES: readonly string[] = [
  ...MOVIE_STATUSES,
  ...SERIES_STATUSES.filter((status) => !MOVIE_STATUSES.includes(status as never)),
];

export const MEDIA_FILTER_FIELDS: readonly MediaFieldDef[] = [
  // ------------------------------------------------------------------ row scope
  {
    name: 'title',
    aliases: ['name'],
    type: 'text',
    scope: 'row',
    describe: 'part of the title, or a glob over the whole of it',
    read: (row) => textValue(row.title),
  },
  {
    name: 'sortTitle',
    aliases: ['sort'],
    type: 'text',
    scope: 'row',
    describe: 'the sort title, which is how *Arr itself matches ("matrix, the")',
    read: (row) => textValue(row.sortTitle),
  },
  {
    name: 'year',
    aliases: [],
    type: 'number',
    scope: 'row',
    describe: 'release year: year<2000, year:1990..1999',
    read: (row) => numberValue(row.year),
  },
  {
    name: 'kind',
    aliases: ['type'],
    type: 'enum',
    scope: 'row',
    members: ['movie', 'series'],
    describe: 'movie or series',
    read: (row) => ({ kind: 'text', value: row.kind }),
  },
  {
    name: 'status',
    aliases: [],
    type: 'enum',
    scope: 'row',
    members: MEDIA_STATUSES,
    describe: 'released, continuing, ended, announced, upcoming, tba, deleted',
    read: (row) => textValue(row.status),
  },
  {
    name: 'genres',
    aliases: ['genre'],
    type: 'set',
    scope: 'row',
    vocabulary: 'genres',
    describe: 'a genre, exactly (glob it for a partial: genre:*fiction*)',
    read: (row) => setValue(row.genres),
  },
  {
    name: 'certification',
    aliases: ['cert'],
    type: 'set',
    scope: 'row',
    vocabulary: 'certifications',
    describe: 'age rating; a one-value set, so certification:{PG,PG-13} works',
    read: (row) => setValue(row.certification === null ? [] : [row.certification]),
  },
  {
    name: 'collection',
    aliases: ['coll'],
    type: 'set',
    scope: 'row',
    entities: ['movie'],
    vocabulary: 'collections',
    // `entities`, never `answerableOn`: a series has no collection *ever*, so
    // `collection:none` on one is true rather than unanswerable. Radarr reports it inline
    // on the film, so even a Radarr too old for `/collection` can still answer this.
    describe: 'the TMDB collection, exactly (glob it: collection:*Matrix*)',
    read: (row) => setValue(row.collection === null ? [] : [row.collection]),
  },
  {
    name: 'runtime',
    aliases: [],
    type: 'number',
    scope: 'row',
    describe: 'minutes: runtime>150',
    read: (row) => numberValue(row.runtime),
  },
  {
    name: 'studio',
    aliases: ['network'],
    type: 'text',
    scope: 'row',
    describe: 'Radarr calls it a studio and Sonarr a network; one field either way',
    read: (row) => textValue(row.studio),
  },
  {
    name: 'tmdbId',
    aliases: ['tmdb'],
    type: 'number',
    scope: 'row',
    entities: ['movie'],
    describe: 'the TMDB id',
    read: (row) => numberValue(row.tmdbId),
  },
  {
    name: 'tvdbId',
    aliases: ['tvdb'],
    type: 'number',
    scope: 'row',
    entities: ['series'],
    describe: 'the TVDB id',
    read: (row) => numberValue(row.tvdbId),
  },
  {
    name: 'imdbId',
    aliases: ['imdb'],
    type: 'text',
    scope: 'row',
    describe: 'the IMDb id; pasting a bare tt-id works without the field name',
    read: (row) => textValue(row.imdbId),
  },
  {
    name: 'titleSlug',
    aliases: ['slug'],
    type: 'text',
    scope: 'row',
    describe: "the *Arr slug, which is what its own URLs use",
    read: (row) => textValue(row.titleSlug),
  },
  {
    name: 'seriesType',
    aliases: [],
    type: 'enum',
    scope: 'row',
    members: ['standard', 'anime', 'daily'],
    entities: ['series'],
    describe: 'standard, anime or daily - a film has none, and says so',
    read: (row) => textValue(row.seriesType),
  },
  {
    name: 'minimumAvailability',
    aliases: ['minAvail'],
    type: 'enum',
    scope: 'row',
    members: [...MOVIE_STATUSES.filter((status) => status !== 'deleted')],
    entities: ['movie'],
    describe: 'when Radarr starts looking - a series has none',
    read: (row) => textValue(row.minimumAvailability),
  },
  {
    name: 'instances',
    aliases: ['instanceCount'],
    type: 'number',
    scope: 'row',
    describe: 'how many instances hold it: instances>1 is every duplicate in the fleet',
    read: (row) => ({ kind: 'number', value: row.facets.length }),
  },

  // ---------------------------------------------------------------- facet scope
  {
    name: 'instance',
    aliases: ['inst'],
    type: 'set',
    scope: 'facet',
    vocabulary: 'instances',
    describe: 'an instance by name, by app (radarr/sonarr), or by id',
    read: (_row, facet) =>
      facet === null
        ? NONE
        : { kind: 'set', values: [facet.name, facet.kind, String(facet.instanceId)] },
  },
  {
    name: 'monitored',
    aliases: ['mon'],
    type: 'bool',
    scope: 'facet',
    describe: 'monitored:false - on this instance, not necessarily every one',
    read: (_row, facet) => (facet === null ? NONE : { kind: 'bool', value: facet.monitored }),
  },
  {
    name: 'hasFile',
    aliases: ['downloaded'],
    type: 'bool',
    scope: 'facet',
    describe: 'whether anything is on disk for it here',
    read: (_row, facet) => {
      if (facet === null) return NONE;
      if (facet.hasFile === null) {
        return { kind: 'unknown', reason: `${facet.name} did not report whether a file exists` };
      }
      return { kind: 'bool', value: facet.hasFile };
    },
  },
  {
    name: 'sizeOnDisk',
    aliases: ['size'],
    type: 'bytes',
    scope: 'facet',
    describe: 'size>20GB - 1024-based, so it agrees with the number on screen',
    read: (_row, facet) => {
      if (facet === null) return NONE;
      if (facet.sizeOnDisk === null) {
        return { kind: 'unknown', reason: `${facet.name} did not report a size on disk` };
      }
      return { kind: 'number', value: facet.sizeOnDisk };
    },
  },
  {
    name: 'path',
    aliases: [],
    type: 'path',
    scope: 'facet',
    describe: 'path:movies/4k - whole folder names, judged exactly as Paths judges them',
    read: (_row, facet) => (facet === null ? NONE : textValue(facet.path)),
  },
  {
    name: 'rootFolderPath',
    aliases: ['root'],
    type: 'path',
    scope: 'facet',
    vocabulary: 'rootFolders',
    describe: 'root:/data/media/4k, or root:4k for any root folder with that segment',
    read: (_row, facet) => (facet === null ? NONE : textValue(facet.rootFolderPath)),
  },
  {
    name: 'tags',
    aliases: ['tag'],
    type: 'set',
    scope: 'facet',
    vocabulary: 'tags',
    describe: 'a tag label on this instance, exactly (tags:*4k* for a partial)',
    read: (_row, facet) => (facet === null ? NONE : setValue(facet.tags)),
  },
  {
    name: 'qualityProfile',
    aliases: ['profile', 'quality'],
    type: 'set',
    scope: 'facet',
    vocabulary: 'qualityProfiles',
    describe: 'the profile name on this instance',
    read: (_row, facet) =>
      facet === null ? NONE : setValue(facet.qualityProfileName === null ? [] : [facet.qualityProfileName]),
  },
  {
    name: 'added',
    aliases: [],
    type: 'date',
    scope: 'facet',
    describe: 'added>-30d, added:2024, added<2020-06-01',
    read: (_row, facet) => (facet === null ? NONE : dateValue(facet.added)),
  },
  {
    name: 'list',
    aliases: ['lists', 'importList'],
    type: 'set',
    scope: 'facet',
    answerableOn: ['radarr'],
    vocabulary: 'lists',
    describe: 'an import list that holds it - Radarr only, so Sonarr copies are undecided',
    read: (_row, facet) => {
      if (facet === null) return NONE;
      if (facet.lists === null) return { kind: 'unknown', reason: listReason(facet) };
      return setValue(facet.lists);
    },
  },
  {
    name: 'listExcluded',
    aliases: ['excluded'],
    type: 'bool',
    scope: 'facet',
    answerableOn: ['radarr'],
    describe: 'whether an import-list exclusion covers it - Radarr only',
    read: (_row, facet) => {
      if (facet === null) return NONE;
      if (facet.excludedFromLists === null) return { kind: 'unknown', reason: listReason(facet) };
      return { kind: 'bool', value: facet.excludedFromLists };
    },
  },
];

/**
 * Why a copy cannot answer a list question.
 *
 * Two different facts, and the sentence has to say which: Sonarr exposes no
 * `/importlist/series` endpoint at all, whereas a Radarr instance may simply not have been
 * read yet. Neither is "not on any list".
 */
function listReason(facet: MediaFilterFacet): string {
  return facet.kind === 'sonarr'
    ? 'import-list membership is not answerable on Sonarr'
    : `${facet.name} did not answer for import lists`;
}

const FIELDS_BY_NAME = new Map<string, MediaFieldDef>();
for (const field of MEDIA_FILTER_FIELDS) {
  for (const name of [field.name, ...field.aliases]) {
    FIELDS_BY_NAME.set(name.toLowerCase(), field);
  }
}

export function mediaFilterField(name: string): MediaFieldDef | null {
  return FIELDS_BY_NAME.get(name.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------- literals

export type MediaFilterOperator =
  | 'contains'
  | 'equals'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'range'
  | 'absent';

/**
 * One expanded value, compiled once at parse time.
 *
 * A date is a half-open interval `[start, end)` - `2024` is the whole year, `2024-03` the
 * month - which is the only reading where `added>D` and `added<=D` partition the timeline
 * with no gap and no overlap. A relative offset is an instant, so `start === end`.
 */
export type MediaFilterLiteral =
  | { readonly kind: 'text'; readonly source: string; readonly matcher: PathSegmentMatcher }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'date'; readonly start: number; readonly end: number }
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | { readonly kind: 'path'; readonly term: PathFilterTerm };

export interface MediaFilterTerm {
  readonly field: MediaFieldDef;
  readonly operator: MediaFilterOperator;
  /** Every literal the value expanded to. Any one matching satisfies the term. */
  readonly literals: readonly MediaFilterLiteral[];
  /** 0-based offset in `source`, for a caret. */
  readonly at: number;
  readonly length: number;
  /** The term exactly as typed. */
  readonly source: string;
}

export type MediaFilterNode =
  | { readonly type: 'and'; readonly nodes: readonly MediaFilterNode[] }
  | { readonly type: 'or'; readonly nodes: readonly MediaFilterNode[] }
  | { readonly type: 'not'; readonly node: MediaFilterNode }
  | {
      readonly type: 'quantifier';
      readonly quantifier: 'any' | 'all';
      readonly node: MediaFilterNode;
    }
  | { readonly type: 'term'; readonly term: MediaFilterTerm };

export interface MediaFilter {
  readonly source: string;
  readonly root: MediaFilterNode | null;
  /** Every term in source order - drives the echo line and any highlighting. */
  readonly terms: readonly MediaFilterTerm[];
  /** True when a term reads a per-instance field: unanswered instances then matter. */
  readonly usesFacetFields: boolean;
  /** Why the source could not be read, or null. An invalid filter never filters. */
  readonly error: string | null;
  /** 1-based position of the error, or null. */
  readonly errorAt: number | null;
  /** Non-fatal: a likely typo, read as a title search. Amber, never blocking. */
  readonly hints: readonly string[];
  /** True when there is something to apply: parsed, and not blank. */
  readonly active: boolean;
}

class MediaFilterParseError extends Error {
  constructor(
    message: string,
    /** 0-based. */
    readonly at: number,
  ) {
    super(message);
  }
}

// -------------------------------------------------------------- value literals

const BYTES = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)?$/i;
const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

const BOOL_TRUE = new Set(['true', 'yes', 'on', '1']);
const BOOL_FALSE = new Set(['false', 'no', 'off', '0']);

const ABSOLUTE_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const RELATIVE_DATE = /^([+-])(\d+)(h|d|w|mo|m|y)$/i;
const NUMERIC_RANGE = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
const DATE_RANGE = /^(\d{4}(?:-\d{2}(?:-\d{2})?)?)\.\.(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/;

interface Interval {
  readonly start: number;
  readonly end: number;
}

/** `2024` is the year, `2024-03` the month, `2024-03-15` the day. */
function absoluteInterval(raw: string): Interval | null {
  const match = ABSOLUTE_DATE.exec(raw);
  if (match === null) return null;
  const [, yearText = '', monthText, dayText] = match;
  const year = Number.parseInt(yearText, 10);

  if (monthText === undefined) {
    return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) };
  }
  const month = Number.parseInt(monthText, 10);
  if (month < 1 || month > 12) return null;

  if (dayText === undefined) {
    return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 1) };
  }
  const day = Number.parseInt(dayText, 10);
  if (day < 1 || day > 31) return null;
  return { start: Date.UTC(year, month - 1, day), end: Date.UTC(year, month - 1, day + 1) };
}

/**
 * `-30d`, `-6w`, `-3mo`, `+2y`, `now`, `today`.
 *
 * The sign is required on an offset: a bare `30d` is refused rather than guessed at, so
 * nobody discovers by accident which direction we picked.
 */
function relativeInterval(raw: string, now: number): Interval | null {
  const lower = raw.toLowerCase();
  if (lower === 'now') return { start: now, end: now };
  if (lower === 'today') {
    const start = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    return { start, end: start + 86_400_000 };
  }

  const match = RELATIVE_DATE.exec(raw);
  if (match === null) return null;
  const [, sign = '+', amountText = '0', unit = 'd'] = match;
  const amount = Number.parseInt(amountText, 10) * (sign === '-' ? -1 : 1);
  const at = new Date(now);

  switch (unit.toLowerCase()) {
    case 'h':
      at.setUTCHours(at.getUTCHours() + amount);
      break;
    case 'd':
      at.setUTCDate(at.getUTCDate() + amount);
      break;
    case 'w':
      at.setUTCDate(at.getUTCDate() + amount * 7);
      break;
    case 'mo':
    case 'm':
      at.setUTCMonth(at.getUTCMonth() + amount);
      break;
    default:
      at.setUTCFullYear(at.getUTCFullYear() + amount);
  }
  const instant = at.getTime();
  return { start: instant, end: instant };
}

function dateInterval(raw: string, now: number): Interval | null {
  return absoluteInterval(raw) ?? relativeInterval(raw, now);
}

function parseBytes(raw: string): number | null {
  const match = BYTES.exec(raw);
  if (match === null) return null;
  const [, amountText = '0', unit] = match;
  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount)) return null;
  return amount * (unit === undefined ? 1 : (BYTE_UNITS[unit.toLowerCase()] ?? 1));
}

function parseNumber(raw: string, type: MediaFieldType): number | null {
  if (type === 'bytes') return parseBytes(raw);
  const value = Number(raw);
  return Number.isFinite(value) && raw.trim().length > 0 ? value : null;
}

function quote(value: string): string {
  return `“${value}”`;
}

/**
 * `1990..1999` is a range; `1990` is not.
 *
 * Asked of each expanded literal rather than of the value as typed, because
 * `year:{2018..2020}` is brace expansion producing three plain numbers - the `..` there
 * belongs to `expandBraces`, not to this language.
 */
function isRangeLiteral(operator: MediaFilterOperator, raw: string): boolean {
  return (operator === 'contains' || operator === 'equals') && raw.includes('..');
}

/** Compile one expanded literal for a field, or throw a message the user can act on. */
function compileLiteral(
  field: MediaFieldDef,
  operator: MediaFilterOperator,
  raw: string,
  at: number,
  now: number,
): MediaFilterLiteral {
  switch (field.type) {
    case 'text':
      return { kind: 'text', source: raw, matcher: compileValueMatcher(raw, operator === 'equals' ? 'exact' : 'contains') };

    case 'set':
      return { kind: 'text', source: raw, matcher: compileValueMatcher(raw, 'exact') };

    case 'enum': {
      const members = field.members ?? [];
      const member = members.find((entry) => entry.toLowerCase() === raw.toLowerCase());
      if (member === undefined) {
        throw new MediaFilterParseError(
          `${quote(field.name)} has no value ${quote(raw)} - one of ${members.join(', ')}`,
          at,
        );
      }
      return { kind: 'text', source: member, matcher: compileValueMatcher(member, 'exact') };
    }

    case 'bool': {
      const lower = raw.toLowerCase();
      if (BOOL_TRUE.has(lower)) return { kind: 'bool', value: true };
      if (BOOL_FALSE.has(lower)) return { kind: 'bool', value: false };
      throw new MediaFilterParseError(
        `${quote(field.name)} takes true or false, not ${quote(raw)}`,
        at,
      );
    }

    case 'number':
    case 'bytes': {
      // Decided per expanded literal, never on the raw value: `year:{2018..2020}` expands
      // to three equalities, while `year:1990..1999` stays one range.
      if (isRangeLiteral(operator, raw)) {
        const match = NUMERIC_RANGE.exec(raw);
        const parts = match === null ? raw.split('..') : [match[1] ?? '', match[2] ?? ''];
        const from = parseNumber(parts[0] ?? '', field.type);
        const to = parseNumber(parts[1] ?? '', field.type);
        if (from === null || to === null) {
          throw new MediaFilterParseError(
            `${quote(field.name)} takes a range like 1990..1999, not ${quote(raw)}`,
            at,
          );
        }
        return { kind: 'range', from: Math.min(from, to), to: Math.max(from, to) };
      }
      const value = parseNumber(raw, field.type);
      if (value === null) {
        throw new MediaFilterParseError(
          field.type === 'bytes'
            ? `${quote(field.name)} takes a size like 20GB, not ${quote(raw)}`
            : `${quote(field.name)} takes a number, not ${quote(raw)}`,
          at,
        );
      }
      return { kind: 'number', value };
    }

    case 'date': {
      if (isRangeLiteral(operator, raw)) {
        const match = DATE_RANGE.exec(raw);
        if (match === null) {
          throw new MediaFilterParseError(
            `${quote(field.name)} takes a range like 2020-01-01..2020-12-31, not ${quote(raw)}`,
            at,
          );
        }
        const from = dateInterval(match[1] ?? '', now);
        const to = dateInterval(match[2] ?? '', now);
        if (from === null || to === null) {
          throw new MediaFilterParseError(`${quote(field.name)} takes a date, not ${quote(raw)}`, at);
        }
        return { kind: 'date', start: Math.min(from.start, to.start), end: Math.max(from.end, to.end) };
      }
      const interval = dateInterval(raw, now);
      if (interval === null) {
        if (/^\d+(h|d|w|mo|m|y)$/i.test(raw)) {
          throw new MediaFilterParseError(
            `${quote(raw)} needs a sign - write ${quote(`-${raw}`)} for ${raw} ago`,
            at,
          );
        }
        throw new MediaFilterParseError(
          `${quote(field.name)} takes a date like 2024-03-15, 2024 or -30d, not ${quote(raw)}`,
          at,
        );
      }
      return { kind: 'date', start: interval.start, end: interval.end };
    }

    case 'path': {
      const term = compilePathPattern(raw);
      if (term === null) {
        throw new MediaFilterParseError(`${quote(field.name)} takes a path, not ${quote(raw)}`, at);
      }
      return { kind: 'path', term };
    }
  }
}

const OPERATORS_BY_TYPE: Record<MediaFieldType, readonly MediaFilterOperator[]> = {
  text: ['contains', 'equals', 'absent'],
  enum: ['contains', 'equals', 'absent'],
  set: ['contains', 'equals', 'absent'],
  number: ['contains', 'equals', 'lt', 'lte', 'gt', 'gte', 'range', 'absent'],
  bytes: ['contains', 'equals', 'lt', 'lte', 'gt', 'gte', 'range', 'absent'],
  date: ['contains', 'equals', 'lt', 'lte', 'gt', 'gte', 'range', 'absent'],
  bool: ['contains', 'equals', 'absent'],
  path: ['contains', 'equals', 'absent'],
};

const COMPARISONS: readonly (readonly [string, MediaFilterOperator])[] = [
  ['!:', 'contains'],
  ['!=', 'equals'],
  ['>=', 'gte'],
  ['<=', 'lte'],
  [':', 'contains'],
  ['=', 'equals'],
  ['>', 'gt'],
  ['<', 'lt'],
];

const COMPARISON_LABEL: Record<MediaFilterOperator, string> = {
  contains: ':',
  equals: '=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  range: '..',
  absent: ':none',
};

// ------------------------------------------------------------------------ lexer

type Token =
  | { readonly type: 'lparen' | 'rparen' | 'and' | 'or' | 'not'; readonly at: number }
  | { readonly type: 'quantifier'; readonly quantifier: 'any' | 'all'; readonly at: number }
  | { readonly type: 'word'; readonly text: string; readonly at: number };

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * One word, brace- and quote-aware.
 *
 * Stops at top-level whitespace or a paren, so a space inside `{…}` or `"…"` is an ordinary
 * character - which is what makes `tags:{4k,TV Shows} year<2000` two terms rather than
 * three words. The raw lexeme goes to `expandBraces` untouched, so expansion stays in one
 * place.
 */
function readWord(source: string, start: number): number {
  let index = start;
  let depth = 0;
  let quoteChar: string | null = null;

  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quoteChar !== null) {
      if (char === quoteChar) quoteChar = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quoteChar = char;
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (isSpace(char) || char === '(' || char === ')')) break;
    index += 1;
  }
  return index;
}

function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? '';
    if (isSpace(char)) {
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ type: 'lparen', at: index });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', at: index });
      index += 1;
      continue;
    }

    const end = readWord(source, index);
    if (end === index) break;
    let word = source.slice(index, end);
    let at = index;

    // `-tags:4k` and `!tags:4k` are negation; `spider-man` is not, because the sign has to
    // lead the token. A bare `-` or `!` is handled below as the operator word it is.
    while (word.length > 1 && (word.startsWith('-') || word.startsWith('!'))) {
      tokens.push({ type: 'not', at });
      word = word.slice(1);
      at += 1;
    }

    if (word === 'AND' || word === '&&') tokens.push({ type: 'and', at });
    else if (word === 'OR' || word === '||') tokens.push({ type: 'or', at });
    else if (word === 'NOT' || word === '!' || word === '-') tokens.push({ type: 'not', at });
    else if ((word.toLowerCase() === 'any' || word.toLowerCase() === 'all') && source[end] === '(') {
      tokens.push({
        type: 'quantifier',
        quantifier: word.toLowerCase() === 'any' ? 'any' : 'all',
        at,
      });
    } else tokens.push({ type: 'word', text: word, at });

    index = end;
  }

  return tokens;
}

// ----------------------------------------------------------------------- parser

interface TermBuild {
  readonly node: MediaFilterNode;
  readonly terms: readonly MediaFilterTerm[];
  readonly hints: readonly string[];
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*/;

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0] ?? 0;
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = rows[j] ?? 0;
      rows[j] = Math.min(
        (rows[j] ?? 0) + 1,
        (rows[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return rows[b.length] ?? 0;
}

/** A bare word shaped like `ident:value` whose ident nearly names a field. */
function typoHint(word: string): string | null {
  const colon = word.indexOf(':');
  if (colon <= 0) return null;
  const candidate = word.slice(0, colon).toLowerCase();
  if (!IDENT.test(candidate) || mediaFilterField(candidate) !== null) return null;

  let best: string | null = null;
  let bestDistance = 3;
  for (const name of FIELDS_BY_NAME.keys()) {
    const distance = levenshtein(candidate, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best === null
    ? null
    : `${quote(word)} was read as a title search - did you mean ${quote(`${best}${word.slice(colon)}`)}?`;
}

/**
 * Expand one value lexeme.
 *
 * `expandBraces` reports positions relative to the lexeme, so they have to be rebased
 * against the whole expression or the caret points at the wrong character.
 */
function expandValue(raw: string, at: number): string[] {
  try {
    const expanded = expandBraces(raw);
    if (expanded.length > MAX_MEDIA_FILTER_VALUES) {
      throw new MediaFilterParseError(
        `that value expands to more than ${String(MAX_MEDIA_FILTER_VALUES)} values`,
        at,
      );
    }
    return expanded;
  } catch (caught) {
    if (caught instanceof MediaFilterParseError) throw caught;
    const message = caught instanceof Error ? caught.message : 'could not be read';
    const relative = /^(.*) at position (\d+)$/.exec(message);
    if (relative === null) throw new MediaFilterParseError(message, at);
    // expandBraces counts from 1 inside the value; the caret has to point into the whole
    // expression, so the offset of the value is added back on.
    const absolute = at + Number.parseInt(relative[2] ?? '1', 10);
    throw new MediaFilterParseError(relative[1] ?? message, absolute - 1);
  }
}

const NONE_WORDS = new Set(['none', 'null']);

/** A word in term position: a field comparison, or a bare title search. */
function buildTerm(word: string, at: number, now: number): TermBuild {
  const identMatch = IDENT.exec(word);
  const ident = identMatch?.[0];

  if (ident !== undefined) {
    const field = mediaFilterField(ident);
    const rest = word.slice(ident.length);
    const comparison = COMPARISONS.find((entry) => rest.startsWith(entry[0]));

    if (field !== null && comparison !== undefined) {
      const [symbol, positive] = comparison;
      const rawValue = rest.slice(symbol.length);
      const valueAt = at + ident.length + symbol.length;

      if (rawValue.length === 0) {
        throw new MediaFilterParseError(
          `${quote(field.name)} needs a value (use ${quote(`${field.name}:none`)} for "no ${field.name}")`,
          at,
        );
      }

      const negated = symbol === '!:' || symbol === '!=';
      const absent = NONE_WORDS.has(rawValue.toLowerCase());
      const operator: MediaFilterOperator = absent ? 'absent' : positive;

      if (!OPERATORS_BY_TYPE[field.type].includes(operator)) {
        throw new MediaFilterParseError(
          `${quote(field.name)} cannot be compared with ${quote(COMPARISON_LABEL[operator])} - use ${quote(`${field.name}:`)} or ${quote(`${field.name}=`)}`,
          at,
        );
      }

      const literals =
        operator === 'absent'
          ? []
          : expandValue(rawValue, valueAt).map((raw) =>
              compileLiteral(field, operator, raw, valueAt, now),
            );

      if (operator !== 'absent' && literals.length === 0) {
        throw new MediaFilterParseError(
          `${quote(field.name)} needs a value (use ${quote(`${field.name}:none`)} for "no ${field.name}")`,
          at,
        );
      }

      const term: MediaFilterTerm = {
        field,
        operator,
        literals,
        at,
        length: word.length,
        source: word,
      };
      const node: MediaFilterNode = { type: 'term', term };
      return {
        node: negated ? { type: 'not', node } : node,
        terms: [term],
        hints: [],
      };
    }
  }

  // A bare word: the title, the sort title, and an IMDb id pasted straight in.
  const values = expandValue(word, at);
  const nodes: MediaFilterNode[] = [];
  const terms: MediaFilterTerm[] = [];

  for (const value of values) {
    const fields = /^tt\d{7,}$/i.test(value)
      ? [mediaFilterField('imdbId')]
      : [mediaFilterField('title'), mediaFilterField('sortTitle')];

    for (const field of fields) {
      if (field === null) continue;
      const operator: MediaFilterOperator = field.name === 'imdbId' ? 'equals' : 'contains';
      const term: MediaFilterTerm = {
        field,
        operator,
        literals: [compileLiteral(field, operator, value, at, now)],
        at,
        length: word.length,
        source: word,
      };
      terms.push(term);
      nodes.push({ type: 'term', term });
    }
  }

  const hint = typoHint(word);
  return {
    node: nodes.length === 1 ? (nodes[0] as MediaFilterNode) : { type: 'or', nodes },
    terms,
    hints: hint === null ? [] : [hint],
  };
}

interface ParserState {
  readonly tokens: readonly Token[];
  index: number;
  readonly terms: MediaFilterTerm[];
  readonly hints: string[];
  readonly now: number;
  depth: number;
  inQuantifier: boolean;
}

function peek(state: ParserState): Token | undefined {
  return state.tokens[state.index];
}

function parseOr(state: ParserState): MediaFilterNode {
  const nodes = [parseAnd(state)];
  for (;;) {
    const token = peek(state);
    if (token?.type !== 'or') break;
    state.index += 1;
    if (peek(state) === undefined) {
      throw new MediaFilterParseError(`${quote('OR')} needs a term after it`, token.at);
    }
    nodes.push(parseAnd(state));
  }
  return nodes.length === 1 ? (nodes[0] as MediaFilterNode) : { type: 'or', nodes };
}

function parseAnd(state: ParserState): MediaFilterNode {
  const nodes = [parseUnary(state)];
  for (;;) {
    const token = peek(state);
    if (token === undefined || token.type === 'or' || token.type === 'rparen') break;
    if (token.type === 'and') {
      state.index += 1;
      if (peek(state) === undefined) {
        throw new MediaFilterParseError(`${quote('AND')} needs a term after it`, token.at);
      }
    }
    nodes.push(parseUnary(state));
  }
  return nodes.length === 1 ? (nodes[0] as MediaFilterNode) : { type: 'and', nodes };
}

function parseUnary(state: ParserState): MediaFilterNode {
  const token = peek(state);
  if (token === undefined) {
    const last = state.tokens.at(-1);
    throw new MediaFilterParseError('that filter ends before it says anything', last?.at ?? 0);
  }
  if (token.type === 'not') {
    state.index += 1;
    if (peek(state) === undefined) {
      throw new MediaFilterParseError(`${quote('NOT')} needs a term after it`, token.at);
    }
    return { type: 'not', node: parseUnary(state) };
  }
  return parsePrimary(state);
}

function parsePrimary(state: ParserState): MediaFilterNode {
  const token = peek(state);
  if (token === undefined) {
    throw new MediaFilterParseError('that filter ends before it says anything', 0);
  }

  if (token.type === 'lparen') {
    state.index += 1;
    state.depth += 1;
    if (state.depth > MAX_MEDIA_FILTER_DEPTH) {
      throw new MediaFilterParseError('that filter nests too deeply', token.at);
    }
    const node = parseOr(state);
    const closing = peek(state);
    if (closing?.type !== 'rparen') {
      throw new MediaFilterParseError(`unclosed ${quote('(')}`, token.at);
    }
    state.index += 1;
    state.depth -= 1;
    return node;
  }

  if (token.type === 'quantifier') {
    if (state.inQuantifier) {
      throw new MediaFilterParseError(
        `${quote(token.quantifier)} inside a quantifier - quantifiers do not nest`,
        token.at,
      );
    }
    state.index += 1;
    const open = peek(state);
    if (open?.type !== 'lparen') {
      throw new MediaFilterParseError(`${quote(token.quantifier)} needs a "(" after it`, token.at);
    }
    state.index += 1;
    state.depth += 1;
    state.inQuantifier = true;
    const node = parseOr(state);
    const closing = peek(state);
    if (closing?.type !== 'rparen') {
      throw new MediaFilterParseError(`unclosed ${quote('(')}`, open.at);
    }
    state.index += 1;
    state.depth -= 1;
    state.inQuantifier = false;
    return { type: 'quantifier', quantifier: token.quantifier, node };
  }

  if (token.type === 'rparen') {
    throw new MediaFilterParseError(`unexpected ${quote(')')}`, token.at);
  }

  // `AND` / `OR` / `NOT` are consumed by the levels above, so reaching one here means it
  // was written where a term belongs.
  if (token.type !== 'word') {
    throw new MediaFilterParseError(
      `${quote(token.type.toUpperCase())} needs a term before it`,
      token.at,
    );
  }

  state.index += 1;
  const built = buildTerm(token.text, token.at, state.now);
  state.terms.push(...built.terms);
  state.hints.push(...built.hints);
  if (state.terms.length > MAX_MEDIA_FILTER_TERMS) {
    throw new MediaFilterParseError(
      `that filter has more than ${String(MAX_MEDIA_FILTER_TERMS)} terms`,
      token.at,
    );
  }
  return built.node;
}

/**
 * Whether a per-instance field is read *outside* a quantifier.
 *
 * Only then does an instance that never answered change the row's verdict: a bare
 * `tags:4k` cannot say "no" while a silent instance might hold a tagged copy. Inside
 * `all(...)` or `any(...)` the quantifier has already folded the incomplete set in, so
 * adding it again at row level would turn a settled `no` into `unknown`.
 */
function usesFacetFields(node: MediaFilterNode): boolean {
  switch (node.type) {
    case 'term':
      return node.term.field.scope === 'facet';
    case 'not':
      return usesFacetFields(node.node);
    case 'and':
    case 'or':
      return node.nodes.some(usesFacetFields);
    case 'quantifier':
      return false;
  }
}

/**
 * Blank, unparseable or expanding to nothing - all three mean "do not filter".
 *
 * `now` is resolved into the AST here rather than at match time, so one request cannot
 * straddle a date boundary halfway through a library.
 */
export function parseMediaFilter(source: string, options: { now?: number } = {}): MediaFilter {
  const trimmed = source.trim();
  const now = options.now ?? Date.now();
  const base = { source: trimmed, hints: [] as readonly string[] };

  if (trimmed.length === 0) {
    return { ...base, root: null, terms: [], usesFacetFields: false, error: null, errorAt: null, active: false };
  }

  const state: ParserState = {
    tokens: tokenise(trimmed),
    index: 0,
    terms: [],
    hints: [],
    now,
    depth: 0,
    inQuantifier: false,
  };

  try {
    if (state.tokens.length === 0) {
      return {
        ...base,
        root: null,
        terms: [],
        usesFacetFields: false,
        error: null,
        errorAt: null,
        active: false,
      };
    }
    const root = parseOr(state);
    const trailing = peek(state);
    if (trailing !== undefined) {
      throw new MediaFilterParseError(`unexpected ${quote(')')}`, trailing.at);
    }
    return {
      source: trimmed,
      root,
      terms: state.terms,
      usesFacetFields: usesFacetFields(root),
      error: null,
      errorAt: null,
      hints: [...new Set(state.hints)],
      active: state.terms.length > 0,
    };
  } catch (caught) {
    const at = caught instanceof MediaFilterParseError ? caught.at : -1;
    const message = caught instanceof Error ? caught.message : 'could not be read';
    return {
      source: trimmed,
      root: null,
      terms: [],
      usesFacetFields: false,
      error: at < 0 ? message : `${message} at position ${String(at + 1)}`,
      errorAt: at < 0 ? null : at + 1,
      hints: [],
      active: false,
    };
  }
}

// -------------------------------------------------------------------- evaluation

interface Evaluation {
  readonly verdict: MediaFilterVerdict;
  /** Only the reasons that actually kept the answer from being decided. */
  readonly reasons: readonly string[];
}

const MATCH: Evaluation = { verdict: 'match', reasons: [] };
const NO: Evaluation = { verdict: 'no', reasons: [] };

function unknown(reasons: readonly string[]): Evaluation {
  return { verdict: 'unknown', reasons };
}

/** `NOT U = U`, and the reason travels with it - that is the whole point. */
function kleeneNot(value: Evaluation): Evaluation {
  if (value.verdict === 'unknown') return value;
  return value.verdict === 'match' ? NO : MATCH;
}

/** `F ∧ U = F`: a definite miss decides it, so the unknown never has to be reported. */
function kleeneAnd(values: readonly Evaluation[]): Evaluation {
  const reasons: string[] = [];
  let sawUnknown = false;
  for (const value of values) {
    if (value.verdict === 'no') return NO;
    if (value.verdict === 'unknown') {
      sawUnknown = true;
      reasons.push(...value.reasons);
    }
  }
  return sawUnknown ? unknown(reasons) : MATCH;
}

/** `T ∨ U = T`: a definite match decides it, so an incomplete fleet never demotes one. */
function kleeneOr(values: readonly Evaluation[]): Evaluation {
  const reasons: string[] = [];
  let sawUnknown = false;
  for (const value of values) {
    if (value.verdict === 'match') return MATCH;
    if (value.verdict === 'unknown') {
      sawUnknown = true;
      reasons.push(...value.reasons);
    }
  }
  return sawUnknown ? unknown(reasons) : NO;
}

function matchesLiteral(
  literal: MediaFilterLiteral,
  operator: MediaFilterOperator,
  value: MediaFieldValue,
): boolean {
  switch (literal.kind) {
    case 'text':
      if (value.kind === 'text') return literal.matcher.matches(value.value);
      if (value.kind === 'set') return value.values.some((entry) => literal.matcher.matches(entry));
      return false;

    case 'bool':
      return value.kind === 'bool' && value.value === literal.value;

    case 'number': {
      if (value.kind !== 'number') return false;
      switch (operator) {
        case 'lt':
          return value.value < literal.value;
        case 'lte':
          return value.value <= literal.value;
        case 'gt':
          return value.value > literal.value;
        case 'gte':
          return value.value >= literal.value;
        default:
          return value.value === literal.value;
      }
    }

    case 'range':
      return value.kind === 'number' && value.value >= literal.from && value.value <= literal.to;

    case 'date': {
      if (value.kind !== 'date') return false;
      switch (operator) {
        // Half-open intervals, so `>` and `<=` partition the timeline with no overlap.
        case 'lt':
          return value.value < literal.start;
        case 'lte':
          return value.value < literal.end;
        case 'gt':
          return value.value >= literal.end;
        case 'gte':
          return value.value >= literal.start;
        default:
          return literal.start === literal.end
            ? value.value === literal.start
            : value.value >= literal.start && value.value < literal.end;
      }
    }

    case 'path':
      return (
        value.kind === 'text' && matchTerm(literal.term, pathSegments(value.value)) === 'full'
      );
  }
}

function evaluateTerm(
  term: MediaFilterTerm,
  row: MediaFilterRow,
  facet: MediaFilterFacet | null,
): Evaluation {
  // A field this entity does not have at all is a known absence, not an unanswered
  // question: a film has no series type, ever, so `seriesType:none` is simply true.
  if (term.field.entities !== undefined && !term.field.entities.includes(row.kind)) {
    return term.operator === 'absent' ? MATCH : NO;
  }

  const value = term.field.read(row, facet);
  if (value.kind === 'unknown') return unknown([value.reason]);
  if (term.operator === 'absent') return value.kind === 'none' ? MATCH : NO;
  if (value.kind === 'none') return NO;

  return term.literals.some((literal) => matchesLiteral(literal, term.operator, value)) ? MATCH : NO;
}

/**
 * The extra disjunct that keeps an incomplete fleet honest.
 *
 * With `tags:4k` over one instance that answered without the tag and one that stayed
 * silent, the answer is not "no" - the silent one may hold a copy that carries it.
 */
function incompleteFacetSet(row: MediaFilterRow): Evaluation {
  const count = row.unknownInstanceIds.length;
  return unknown([
    `${String(count)} instance(s) did not answer, so a copy that matches may be missing from this list`,
  ]);
}

function evaluateNode(
  node: MediaFilterNode,
  row: MediaFilterRow,
  facet: MediaFilterFacet | null,
): Evaluation {
  switch (node.type) {
    case 'term':
      return evaluateTerm(node.term, row, facet);
    case 'not':
      return kleeneNot(evaluateNode(node.node, row, facet));
    case 'and':
      return kleeneAnd(node.nodes.map((child) => evaluateNode(child, row, facet)));
    case 'or':
      return kleeneOr(node.nodes.map((child) => evaluateNode(child, row, facet)));
    case 'quantifier': {
      const perFacet = row.facets.map((entry) => evaluateNode(node.node, row, entry));
      const incomplete = row.unknownInstanceIds.length > 0 ? [incompleteFacetSet(row)] : [];
      return node.quantifier === 'all'
        ? kleeneAnd([...perFacet, ...incomplete])
        : kleeneOr([...perFacet, ...incomplete]);
    }
  }
}

export interface MediaFilterResult {
  readonly verdict: MediaFilterVerdict;
  /** Copies that satisfied the expression. All of them when the filter is inactive. */
  readonly matchedInstanceIds: readonly number[];
  /** Why it could not be judged. Empty unless the verdict is `unknown`. */
  readonly reasons: readonly string[];
}

/**
 * Where one row stands.
 *
 * Existential over the copies, so a facet-scoped conjunction binds to *one* instance:
 * `monitored:false tags:4k` does not match a title that is unmonitored on one instance and
 * tagged on another. `all(…)` is how the loose reading is asked for, and the reason it
 * exists at all - `NOT monitored:true` means "some copy is unmonitored", which is a
 * different question from "unmonitored everywhere".
 *
 * An inactive filter matches everything, on every copy, with nothing to explain.
 */
export function matchMediaFilter(filter: MediaFilter, row: MediaFilterRow): MediaFilterResult {
  if (!filter.active || filter.root === null) {
    return {
      verdict: 'match',
      matchedInstanceIds: row.facets.map((facet) => facet.instanceId),
      reasons: [],
    };
  }

  const root = filter.root;
  const matchedInstanceIds: number[] = [];
  const perFacet = row.facets.map((facet) => {
    const evaluation = evaluateNode(root, row, facet);
    if (evaluation.verdict === 'match') matchedInstanceIds.push(facet.instanceId);
    return evaluation;
  });

  const incomplete =
    filter.usesFacetFields && row.unknownInstanceIds.length > 0 ? [incompleteFacetSet(row)] : [];
  const combined = kleeneOr([...perFacet, ...incomplete]);

  return {
    verdict: combined.verdict,
    matchedInstanceIds,
    reasons: combined.verdict === 'unknown' ? [...new Set(combined.reasons)] : [],
  };
}
