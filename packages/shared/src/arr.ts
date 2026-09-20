import { z } from 'zod';

/**
 * Radarr/Sonarr v3 responses are wide, version-dependent and differ per flavour.
 * The rule in this codebase: parse a NARROW view of the fields we render, and keep
 * the body exactly as sent alongside it. `z.object()` strips unknown keys, so the
 * view stays clean while `raw` keeps everything the API gave us.
 */
export type ArrJson = Record<string, unknown>;

export interface ArrResource<TView> {
  readonly view: TView;
  readonly raw: ArrJson;
}

export const arrSystemStatusSchema = z.object({
  version: z.string(),
  appName: z.string().optional(),
  instanceName: z.string().optional(),
  isDocker: z.boolean().optional(),
});
export type ArrSystemStatus = z.infer<typeof arrSystemStatusSchema>;

export const arrTagSchema = z.object({
  id: z.number().int(),
  label: z.string(),
});
export type ArrTag = z.infer<typeof arrTagSchema>;

/** GET /api/v3/tag/detail - the only way to know what a tag is actually attached to. */
export const arrTagDetailSchema = arrTagSchema.extend({
  movieIds: z.array(z.number().int()).optional(),
  seriesIds: z.array(z.number().int()).optional(),
  indexerIds: z.array(z.number().int()).default([]),
  importListIds: z.array(z.number().int()).default([]),
  notificationIds: z.array(z.number().int()).default([]),
  restrictionIds: z.array(z.number().int()).default([]),
  delayProfileIds: z.array(z.number().int()).default([]),
});
export type ArrTagDetail = z.infer<typeof arrTagDetailSchema>;

export const arrRootFolderSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  accessible: z.boolean().default(true),
  freeSpace: z.number().nullable().default(null),
  totalSpace: z.number().nullable().default(null),
});
export type ArrRootFolder = z.infer<typeof arrRootFolderSchema>;

/** GET /api/v3/qualityprofile - ids are per-instance; only the name is rendered. */
export const arrQualityProfileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type ArrQualityProfile = z.infer<typeof arrQualityProfileSchema>;

export const arrFieldSchema = z.object({
  name: z.string(),
  value: z.unknown().optional(),
});
export type ArrField = z.infer<typeof arrFieldSchema>;

/**
 * Import lists diverge the most between the two apps:
 * Radarr uses `enableAuto`/`minimumAvailability`, Sonarr uses `enableAutomaticAdd`/
 * `seasonFolder`/`seriesType`. Both are optional here; `raw` carries the rest.
 */
export const arrImportListSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  implementation: z.string(),
  implementationName: z.string().optional(),
  configContract: z.string(),
  enabled: z.boolean().default(true),
  enableAuto: z.boolean().optional(),
  enableAutomaticAdd: z.boolean().optional(),
  rootFolderPath: z.string().default(''),
  qualityProfileId: z.number().int().default(0),
  monitor: z.string().optional(),
  minimumAvailability: z.string().optional(),
  seasonFolder: z.boolean().optional(),
  seriesType: z.string().optional(),
  tags: z.array(z.number().int()).default([]),
  fields: z.array(arrFieldSchema).default([]),
});
export type ArrImportList = z.infer<typeof arrImportListSchema>;

/**
 * A Radarr collection - a TMDB collection Radarr tracks in its own right.
 *
 * **Radarr only**, and the API offers no create and no delete: collections arrive from
 * TMDB, so every write is a PUT on one that already exists.
 *
 * It is here because a collection is two things Fleetarr already manages at once - a root
 * folder consumer (`rootFolderPath`) and a tag holder (`tags`) - which makes it a folder's
 * owner and a tag's user. Ignoring it meant a folder only a collection roots at read as
 * untracked, and a tag only collections carry read as unused.
 *
 * `movies[]` is deliberately absent: it is the wide part of the body, and the join back to
 * the library is by `tmdbId` anyway.
 */
export const arrCollectionSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string().optional(),
  tmdbId: z.number().int().optional(),
  monitored: z.boolean().default(false),
  /** Radarr searches for the collection's films as soon as one is added. */
  searchOnAdd: z.boolean().optional(),
  qualityProfileId: z.number().int().default(0),
  minimumAvailability: z.string().optional(),
  rootFolderPath: z.string().default(''),
  tags: z.array(z.number().int()).default([]),
});
export type ArrCollection = z.infer<typeof arrCollectionSchema>;

/**
 * Sonarr's per-series rollup. Narrow on purpose: it is here because Sonarr has no
 * top-level `sizeOnDisk` and no `hasFile`, so without it "how big is this" and "is
 * anything on disk" are unanswerable for every series - and an unanswerable question
 * rendered as `false` is exactly the unknown-as-missing bug this codebase refuses.
 */
export const arrMediaStatisticsSchema = z.object({
  episodeCount: z.number().int().optional(),
  episodeFileCount: z.number().int().optional(),
  sizeOnDisk: z.number().optional(),
  percentOfEpisodes: z.number().optional(),
});
export type ArrMediaStatistics = z.infer<typeof arrMediaStatisticsSchema>;

/** What `/movie` says about a film's collection, inline. The full record is `arrCollectionSchema`. */
export const arrMediaCollectionSchema = z.object({
  title: z.string().optional(),
  tmdbId: z.number().int().optional(),
});
export type ArrMediaCollection = z.infer<typeof arrMediaCollectionSchema>;

/**
 * Projection of a movie/series row for the bulk-selection grid.
 *
 * Every field here is rendered, sorted or filtered on by `/media`; the rule is never to
 * widen this to "be complete". Deliberately absent, and why: `images`/`remotePoster`
 * (stripped at fetch time by MEDIA_LIGHT_QUERY anyway), `overview`, `ratings`,
 * `popularity`, `alternateTitles`, `cleanTitle`, `movieFile`, `seasons`,
 * `folder`, `originalLanguage` (an object nothing renders), `ended` (Sonarr's `status`
 * already says it), and the release-date family.
 *
 * `collection` used to be on that list and no longer is: `/media` renders it as a column
 * and filters on it, which is the bar this projection sets. Only the two keys that answer
 * "which collection" are taken - never the nested movie list.
 */
export const arrMediaSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string().optional(),
  originalTitle: z.string().optional(),
  path: z.string().default(''),
  rootFolderPath: z.string().optional(),
  qualityProfileId: z.number().int().default(0),
  monitored: z.boolean().default(false),
  tags: z.array(z.number().int()).default([]),
  sizeOnDisk: z.number().optional(),
  /**
   * Radarr sets this false for a monitored film nobody has downloaded yet. Such an item
   * has a `path` that deliberately does not exist, so it must never be reported as a
   * folder missing from disk.
   */
  hasFile: z.boolean().optional(),
  year: z.number().int().optional(),

  // Identity across instances, and the links out. Radarr writes 0 for a manually added
  // item with no metadata match, so 0 and absent have to mean the same thing.
  tmdbId: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  titleSlug: z.string().optional(),

  /** radarr: tba|announced|inCinemas|released|deleted - sonarr: continuing|ended|upcoming|deleted */
  status: z.string().optional(),
  /** Not `.default([])`: a default allocates an array per item on every cold index build. */
  genres: z.array(z.string()).optional(),
  certification: z.string().optional(),
  runtime: z.number().optional(),
  /** Radarr calls it a studio, Sonarr a network. One field to the filter. */
  studio: z.string().optional(),
  network: z.string().optional(),
  added: z.string().optional(),
  /** sonarr only */
  seriesType: z.string().optional(),
  /** radarr only */
  minimumAvailability: z.string().optional(),
  /**
   * The TMDB collection this film belongs to. Radarr only - a series has none, *ever*,
   * which is why `/media` reads it as a known absence rather than as unknown.
   */
  collection: arrMediaCollectionSchema.optional(),
  movieFileId: z.number().int().optional(),
  statistics: arrMediaStatisticsSchema.optional(),
});
export type ArrMedia = z.infer<typeof arrMediaSchema>;

/**
 * What one import list currently holds, joined to the library by tmdbId.
 *
 * Radarr only: `GET /api/v3/importlist/movie`. Sonarr exposes no equivalent, which is why
 * list membership there is unknown rather than empty. `lists` is a set of import list
 * *ids* - per-instance, so names are resolved from that instance's own list snapshot.
 */
export const arrImportListMovieSchema = z.object({
  tmdbId: z.number().int(),
  lists: z.array(z.number().int()).default([]),
  isExcluded: z.boolean().optional(),
  isExisting: z.boolean().optional(),
});
export type ArrImportListMovie = z.infer<typeof arrImportListMovieSchema>;

/**
 * Size on disk, wherever this flavour keeps it.
 *
 * `null` means unknown, and it stays unknown all the way into the filter's three-valued
 * logic. Never coerce it to 0: "we do not know" and "nothing there" are different answers.
 */
export function mediaSizeOnDisk(media: ArrMedia): number | null {
  if (media.sizeOnDisk !== undefined) return media.sizeOnDisk;
  return media.statistics?.sizeOnDisk ?? null;
}

/**
 * Whether anything is on disk for this item.
 *
 * Radarr says so directly. Sonarr does not, so it is derived from the episode file count.
 * `null` when neither source is present - unknown, deliberately not `false`.
 */
export function mediaHasFile(media: ArrMedia): boolean | null {
  if (media.hasFile !== undefined) return media.hasFile;
  const files = media.statistics?.episodeFileCount;
  return files === undefined ? null : files > 0;
}

/** Sonarr's episode progress, or null for a movie (and for a series with no rollup). */
export function mediaEpisodeCounts(media: ArrMedia): { have: number; total: number } | null {
  const stats = media.statistics;
  if (stats?.episodeCount === undefined) return null;
  return { have: stats.episodeFileCount ?? 0, total: stats.episodeCount };
}

/** Body of an *Arr `POST /api/v3/command` acknowledgement. */
export const arrCommandSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string().optional(),
});
export type ArrCommand = z.infer<typeof arrCommandSchema>;

/**
 * *Arr v3 PUT endpoints REPLACE the resource - a partial body silently wipes the
 * omitted fields. Always fetch the raw resource, merge the changed keys onto it,
 * then PUT the merged object back.
 */
export function mergeForPut(raw: ArrJson, patch: ArrJson): ArrJson {
  return { ...raw, ...patch };
}

/** Parse an *Arr list response into view+raw pairs. */
export function toResources<TView>(
  schema: z.ZodType<TView>,
  body: unknown,
): ArrResource<TView>[] {
  if (!Array.isArray(body)) {
    throw new TypeError('Expected a JSON array from the *Arr API');
  }
  return body.map((entry) => ({
    view: schema.parse(entry),
    raw: entry as ArrJson,
  }));
}

export function toResource<TView>(schema: z.ZodType<TView>, body: unknown): ArrResource<TView> {
  return { view: schema.parse(body), raw: body as ArrJson };
}
