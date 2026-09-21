import { z } from 'zod';
import { MEDIA_KIND_BY_INSTANCE, type InstanceKind } from './instance.js';

/** Operations that talk to a Radarr/Sonarr instance. Every one needs an `instanceId`. */
export const ARR_OPS = [
  'tag.create',
  'tag.rename',
  'tag.delete',
  'tag.merge',
  'mediaTags.add',
  'mediaTags.remove',
  'mediaTags.set',
  'rootFolder.create',
  'rootFolder.delete',
  'media.moveRootFolder',
  'media.refresh',
  'media.setMonitored',
  'media.setQualityProfile',
  'media.delete',
  'importList.update',
  'importList.delete',
  'importList.setEnabled',
  'collection.update',
  'collectionTags.add',
  'collectionTags.remove',
  'collectionTags.set',
] as const;
export type ArrOp = (typeof ARR_OPS)[number];

/**
 * Operations that act on mounted storage. These belong to the host, not an instance -
 * `instanceId` is null. Named to match the existing dotted convention; the brief calls
 * them FS_MKDIR / FS_RENAME / FS_MOVE / FS_DELETE.
 */
export const FS_OPS = ['fs.mkdir', 'fs.rename', 'fs.move', 'fs.delete'] as const;
export type FsOp = (typeof FS_OPS)[number];

export const QUEUE_OPS = [...ARR_OPS, ...FS_OPS] as const;
export type QueueOp = ArrOp | FsOp;

/** What a queue item acts on: an *Arr instance, or the filesystem. */
export const QUEUE_ITEM_KINDS = ['arr', 'fs'] as const;
export type QueueItemKind = (typeof QUEUE_ITEM_KINDS)[number];

const FS_OP_SET: ReadonlySet<string> = new Set(FS_OPS);

export function isFsOp(op: QueueOp): op is FsOp {
  return FS_OP_SET.has(op);
}

export function isArrOp(op: QueueOp): op is ArrOp {
  return !FS_OP_SET.has(op);
}

export function kindOfOp(op: QueueOp): QueueItemKind {
  return isFsOp(op) ? 'fs' : 'arr';
}

export const QUEUE_ITEM_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type QueueItemStatus = (typeof QUEUE_ITEM_STATUSES)[number];

export const TARGET_KINDS = [
  'tag',
  'rootFolder',
  'importList',
  /** A Radarr collection. Radarr only - Sonarr has no equivalent resource. */
  'collection',
  'movie',
  'series',
  /** A directory on mounted storage. */
  'path',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Field-level changes for an import list, merged onto the raw resource before PUT. */
export interface ImportListChanges {
  name?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;
  tags?: number[];
  monitor?: string;
  minimumAvailability?: string;
  seasonFolder?: boolean;
  seriesType?: string;
}

/**
 * Field-level changes for a Radarr collection, sent to the collection editor.
 *
 * **No `tags` key, deliberately** - tags live in `collectionTags.add|remove|set`. Three
 * reasons, each on its own decisive: `resolveTagIds` folds a `tag.create` dependency into a
 * *flat* `tagIds` array, so a nested list could never join that chain; the staging guard
 * that rejects an empty `tagIds` with no producer cannot see inside `changes`; and a merged
 * PUT of `tags` is a *replace*, so two dependents each adding one created label would wipe
 * each other. `ImportListChanges.tags` is the existing version of that mistake - nothing
 * chains a `tag.create` into an import list, and this is why.
 */
export interface CollectionChanges {
  rootFolderPath?: string;
  qualityProfileId?: number;
  minimumAvailability?: string;
  monitored?: boolean;
  /** Whether the collection's films are monitored as they are added. */
  monitorMovies?: boolean;
  searchOnAdd?: boolean;
}

/**
 * op -> payload. This map is the single source of truth for the whole queue:
 * add an op here and every exhaustive switch in server and UI stops compiling.
 */
export interface QueueOpPayloads {
  'tag.create': { label: string };
  'tag.rename': { tagId: number; from: string; to: string };
  /**
   * `detachFromMedia` and `detachFromCollections` are separate because the two detachments
   * use different endpoints - the media editor and a per-collection merged PUT - and a
   * fleet with no collections should not pay for the second.
   */
  'tag.delete': {
    tagId: number;
    label: string;
    detachFromMedia: boolean;
    detachFromCollections: boolean;
  };
  'tag.merge': { sourceTagIds: number[]; targetTagId: number; deleteSources: boolean };
  'mediaTags.add': { mediaIds: number[]; tagIds: number[] };
  'mediaTags.remove': { mediaIds: number[]; tagIds: number[] };
  /**
   * The exact tag list, replacing whatever was there.
   *
   * Its own op rather than a mode on the two above, because it wipes tags nobody named -
   * a different blast radius deserves its own name in the queue and its own row in the DB
   * CHECK. And an empty list means "clear them all" here, which is precisely the case the
   * add/remove guard exists to reject.
   */
  'mediaTags.set': { mediaIds: number[]; tagIds: number[] };
  'rootFolder.create': { path: string };
  'rootFolder.delete': { rootFolderId: number; path: string };
  'media.moveRootFolder': { mediaIds: number[]; toRootFolderPath: string; moveFiles: boolean };
  /** Rescan after the files underneath *Arr changed on disk. Empty = the whole library. */
  'media.refresh': { mediaIds: number[] };
  'media.setMonitored': { mediaIds: number[]; monitored: boolean };
  /** The id is resolved per instance from a profile *name*: ids do not travel. */
  'media.setQualityProfile': { mediaIds: number[]; qualityProfileId: number; profileName: string };
  /**
   * Removes the items from the instance.
   *
   * `deleteFiles` is the irreversible one - the files leave the disk and Fleetarr cannot
   * put them back. Without `addImportExclusion` the next list sync may re-add everything
   * just removed, so both are explicit rather than defaulted.
   */
  'media.delete': { mediaIds: number[]; deleteFiles: boolean; addImportExclusion: boolean };
  'importList.update': { importListId: number; changes: ImportListChanges };
  'importList.delete': { importListId: number };
  'importList.setEnabled': { importListId: number; enabled: boolean; enableAutomaticAdd: boolean };
  /**
   * Re-point, re-profile or unmonitor collections, through Radarr's collection editor.
   *
   * Plural where `importList.update` is singular: the editor takes a list, and every caller
   * - a root folder remap, a delete bridge - touches all the collections under one folder at
   * once. One queue row, one HTTP call.
   */
  'collection.update': { collectionIds: number[]; changes: CollectionChanges };
  'collectionTags.add': { collectionIds: number[]; tagIds: number[] };
  'collectionTags.remove': { collectionIds: number[]; tagIds: number[] };
  /** The exact tag list, replacing whatever was there. Empty means "clear them all". */
  'collectionTags.set': { collectionIds: number[]; tagIds: number[] };
  'fs.mkdir': { path: string; recursive: boolean };
  /** Same parent directory, new name. */
  'fs.rename': { from: string; to: string };
  /** Different parent directory. Refused across filesystems - see FilesystemService. */
  'fs.move': { from: string; to: string };
  /**
   * Hard delete. `recursive` is required for a non-empty directory; `force` is required
   * when a connected instance still references the path.
   */
  'fs.delete': { path: string; recursive: boolean; force: boolean };
}

export type QueuePayloadFor<K extends QueueOp> = QueueOpPayloads[K];

export interface QueueItemError {
  readonly code: string;
  readonly message: string;
  readonly httpStatus: number | null;
}

export interface QueueItemCommon {
  readonly id: number;
  /** Null for filesystem operations: they belong to the host, not an instance. */
  readonly instanceId: number | null;
  readonly kind: QueueItemKind;
  readonly runId: number | null;
  readonly dependsOnId: number | null;
  readonly sortOrder: number;
  readonly status: QueueItemStatus;
  readonly targetKind: TargetKind;
  readonly targetId: number | null;
  /** Snapshot of the label at staging time - survives deletion of the remote object. */
  readonly targetLabel: string;
  readonly summary: string;
  readonly affectedCount: number;
  readonly attempts: number;
  readonly error: QueueItemError | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Discriminated union member: narrowing on `op` narrows `payload`. */
export type QueueItemOf<K extends QueueOp> = QueueItemCommon & {
  readonly op: K;
  readonly payload: QueuePayloadFor<K>;
};

export type QueueItem = { [K in QueueOp]: QueueItemOf<K> }[QueueOp];

/**
 * What the UI POSTs to stage an action. Nothing has been touched yet - not the instance,
 * not the disk. An *Arr op must name its instance; a filesystem op must not.
 */
export type NewArrQueueItemOf<K extends ArrOp> = {
  readonly instanceId: number;
  readonly op: K;
  readonly payload: QueuePayloadFor<K>;
  readonly dependsOnId?: number;
};

export type NewFsQueueItemOf<K extends FsOp> = {
  readonly instanceId?: null;
  readonly op: K;
  readonly payload: QueuePayloadFor<K>;
  readonly dependsOnId?: number;
};

export type NewQueueItemOf<K extends QueueOp> = K extends ArrOp
  ? NewArrQueueItemOf<K>
  : K extends FsOp
    ? NewFsQueueItemOf<K>
    : never;

export type NewArrQueueItem = { [K in ArrOp]: NewArrQueueItemOf<K> }[ArrOp];
export type NewFsQueueItem = { [K in FsOp]: NewFsQueueItemOf<K> }[FsOp];
export type NewQueueItem = NewArrQueueItem | NewFsQueueItem;

const importListChangesSchema: z.ZodType<ImportListChanges> = z.object({
  name: z.string().min(1).optional(),
  rootFolderPath: z.string().min(1).optional(),
  qualityProfileId: z.number().int().positive().optional(),
  tags: z.array(z.number().int()).optional(),
  monitor: z.string().optional(),
  minimumAvailability: z.string().optional(),
  seasonFolder: z.boolean().optional(),
  seriesType: z.string().optional(),
});

const idList = z.array(z.number().int().positive()).min(1);

const collectionChangesSchema: z.ZodType<CollectionChanges> = z.object({
  rootFolderPath: z.string().min(1).optional(),
  qualityProfileId: z.number().int().positive().optional(),
  minimumAvailability: z.string().optional(),
  monitored: z.boolean().optional(),
  monitorMovies: z.boolean().optional(),
  searchOnAdd: z.boolean().optional(),
});

/**
 * Absolute POSIX paths only. Traversal is rejected here as a first line of defence; the
 * authoritative check is FilesystemService, which resolves against the allowed roots.
 */
const absolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine((value) => value.startsWith('/'), 'path must be absolute')
  .refine((value) => !value.split('/').includes('..'), 'path must not contain ".."')
  .refine((value) => !value.includes('\0'), 'path must not contain a null byte')
  .transform((value) => value.replace(/\/+$/, '') || '/');
/**
 * Tag lists may be empty when the item depends on a `tag.create` step - the id does not
 * exist yet at staging time. The queue rejects an empty list without a dependency.
 */
const tagIdList = z.array(z.number().int().positive());

/**
 * Runtime validation for every payload. The mapped type forces each schema to
 * match its `QueueOpPayloads` entry, so the two can never drift.
 */
export type QueuePayloadSchemas = { [K in QueueOp]: z.ZodType<QueuePayloadFor<K>> };

export const queuePayloadSchemas: QueuePayloadSchemas = {
  'tag.create': z.object({ label: z.string().min(1).max(64) }),
  'tag.rename': z.object({
    tagId: z.number().int().positive(),
    from: z.string().min(1),
    to: z.string().min(1).max(64),
  }),
  'tag.delete': z.object({
    tagId: z.number().int().positive(),
    label: z.string().min(1),
    detachFromMedia: z.boolean(),
    detachFromCollections: z.boolean(),
  }),
  'tag.merge': z.object({
    sourceTagIds: idList,
    targetTagId: z.number().int().positive(),
    deleteSources: z.boolean(),
  }),
  'mediaTags.add': z.object({ mediaIds: idList, tagIds: tagIdList }),
  'mediaTags.remove': z.object({ mediaIds: idList, tagIds: tagIdList }),
  'mediaTags.set': z.object({ mediaIds: idList, tagIds: tagIdList }),
  'rootFolder.create': z.object({ path: z.string().min(1) }),
  'rootFolder.delete': z.object({
    rootFolderId: z.number().int().positive(),
    path: z.string().min(1),
  }),
  'media.moveRootFolder': z.object({
    mediaIds: idList,
    toRootFolderPath: z.string().min(1),
    /** The destructive one: tells *Arr to physically relocate the files on disk. */
    moveFiles: z.boolean(),
  }),
  'importList.update': z.object({
    importListId: z.number().int().positive(),
    changes: importListChangesSchema,
  }),
  'importList.delete': z.object({ importListId: z.number().int().positive() }),
  'importList.setEnabled': z.object({
    importListId: z.number().int().positive(),
    enabled: z.boolean(),
    enableAutomaticAdd: z.boolean(),
  }),
  'collection.update': z.object({ collectionIds: idList, changes: collectionChangesSchema }),
  'collectionTags.add': z.object({ collectionIds: idList, tagIds: tagIdList }),
  'collectionTags.remove': z.object({ collectionIds: idList, tagIds: tagIdList }),
  'collectionTags.set': z.object({ collectionIds: idList, tagIds: tagIdList }),
  'media.refresh': z.object({ mediaIds: z.array(z.number().int().positive()) }),
  'media.setMonitored': z.object({ mediaIds: idList, monitored: z.boolean() }),
  'media.setQualityProfile': z.object({
    mediaIds: idList,
    qualityProfileId: z.number().int().positive(),
    profileName: z.string().min(1),
  }),
  'media.delete': z.object({
    mediaIds: idList,
    /** The irreversible one. */
    deleteFiles: z.boolean(),
    addImportExclusion: z.boolean(),
  }),
  'fs.mkdir': z.object({ path: absolutePath, recursive: z.boolean() }),
  'fs.rename': z.object({ from: absolutePath, to: absolutePath }),
  'fs.move': z.object({ from: absolutePath, to: absolutePath }),
  'fs.delete': z.object({
    path: absolutePath,
    /** Required for a non-empty directory. */
    recursive: z.boolean(),
    /** Required when a connected instance still references the path. */
    force: z.boolean(),
  }),
};

const newQueueItemEnvelopeSchema = z
  .object({
    instanceId: z.number().int().positive().nullish(),
    op: z.enum(QUEUE_OPS),
    payload: z.unknown(),
    dependsOnId: z.number().int().positive().optional(),
  })
  .superRefine((envelope, ctx) => {
    // The instance is what makes an *Arr op addressable; a filesystem op has no instance,
    // and accepting one would quietly imply the disk belongs to it.
    if (isArrOp(envelope.op) && (envelope.instanceId === null || envelope.instanceId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['instanceId'],
        message: `${envelope.op} needs an instanceId`,
      });
    }
    if (isFsOp(envelope.op) && envelope.instanceId !== null && envelope.instanceId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['instanceId'],
        message: `${envelope.op} acts on mounted storage and must not name an instance`,
      });
    }
  });

/**
 * Two-step parse: validate the envelope, then dispatch to the op's payload schema.
 * The single cast is unavoidable - TS cannot correlate `op` with the map lookup -
 * but it is guarded by `queuePayloadSchemas` having been type-checked above.
 */
export function parseNewQueueItem(input: unknown): NewQueueItem {
  const envelope = newQueueItemEnvelopeSchema.parse(input);
  const payload = queuePayloadSchemas[envelope.op].parse(envelope.payload);
  return {
    ...(isFsOp(envelope.op) ? { instanceId: null } : { instanceId: envelope.instanceId }),
    op: envelope.op,
    payload,
    ...(envelope.dependsOnId === undefined ? {} : { dependsOnId: envelope.dependsOnId }),
  } as NewQueueItem;
}

/**
 * What an op acts on. Media ops depend on the instance flavour; filesystem ops act on a
 * path and pass `null` for the kind.
 */
export function targetKindForOp(op: QueueOp, instanceKind: InstanceKind | null): TargetKind {
  switch (op) {
    case 'fs.mkdir':
    case 'fs.rename':
    case 'fs.move':
    case 'fs.delete':
      return 'path';
    case 'tag.create':
    case 'tag.rename':
    case 'tag.delete':
    case 'tag.merge':
      return 'tag';
    case 'rootFolder.create':
    case 'rootFolder.delete':
      return 'rootFolder';
    case 'importList.update':
    case 'importList.delete':
    case 'importList.setEnabled':
      return 'importList';
    case 'collection.update':
    case 'collectionTags.add':
    case 'collectionTags.remove':
    case 'collectionTags.set':
      return 'collection';
    case 'mediaTags.add':
    case 'mediaTags.remove':
    case 'mediaTags.set':
    case 'media.moveRootFolder':
    case 'media.refresh':
    case 'media.setMonitored':
    case 'media.setQualityProfile':
    case 'media.delete':
      // Only reachable for *Arr ops, which the queue always stages with an instance.
      return instanceKind === null ? 'movie' : MEDIA_KIND_BY_INSTANCE[instanceKind];
  }
}

/** Human-readable one-liner, stored on the item so the queue reads the same after Apply. */
export function summariseQueueOp(item: NewQueueItem): string {
  switch (item.op) {
    case 'tag.create':
      return `Create tag "${item.payload.label}"`;
    case 'tag.rename':
      return `Rename tag "${item.payload.from}" to "${item.payload.to}"`;
    case 'tag.delete':
      return `Delete tag "${item.payload.label}"`;
    case 'tag.merge':
      return `Merge ${item.payload.sourceTagIds.length} tag(s) into #${item.payload.targetTagId}`;
    case 'mediaTags.add':
      return item.payload.tagIds.length === 0
        ? `Add the tag created in step ${item.dependsOnId ?? '?'} to ${item.payload.mediaIds.length} item(s)`
        : `Add ${item.payload.tagIds.length} tag(s) to ${item.payload.mediaIds.length} item(s)`;
    case 'mediaTags.remove':
      return item.payload.tagIds.length === 0
        ? `Remove the tag from step ${item.dependsOnId ?? '?'} from ${item.payload.mediaIds.length} item(s)`
        : `Remove ${item.payload.tagIds.length} tag(s) from ${item.payload.mediaIds.length} item(s)`;
    case 'mediaTags.set':
      return item.payload.tagIds.length === 0
        ? `Clear all tags on ${String(item.payload.mediaIds.length)} item(s)`
        : `Replace tags on ${String(item.payload.mediaIds.length)} item(s) with ${String(item.payload.tagIds.length)} tag(s)`;
    case 'media.setMonitored':
      return `${item.payload.monitored ? 'Monitor' : 'Unmonitor'} ${String(item.payload.mediaIds.length)} item(s)`;
    case 'media.setQualityProfile':
      return `Set quality profile "${item.payload.profileName}" on ${String(item.payload.mediaIds.length)} item(s)`;
    case 'media.delete':
      return `Delete ${String(item.payload.mediaIds.length)} item(s)${
        item.payload.deleteFiles ? ' and their files from disk' : ', leaving the files on disk'
      }${item.payload.addImportExclusion ? ', adding an import exclusion' : ''}`;
    case 'rootFolder.create':
      return `Add root folder ${item.payload.path}`;
    case 'rootFolder.delete':
      return `Unassign root folder ${item.payload.path}`;
    case 'media.moveRootFolder':
      return `Move ${item.payload.mediaIds.length} item(s) to ${item.payload.toRootFolderPath}${
        item.payload.moveFiles ? ' (moving files on disk)' : ' (leaving files in place)'
      }`;
    case 'importList.update':
      return `Update import list #${item.payload.importListId}`;
    case 'importList.delete':
      return `Delete import list #${item.payload.importListId}`;
    case 'importList.setEnabled':
      return `${item.payload.enabled ? 'Enable' : 'Disable'} import list #${item.payload.importListId}`;
    case 'media.refresh':
      return item.payload.mediaIds.length === 0
        ? 'Rescan the whole library'
        : `Rescan ${item.payload.mediaIds.length} item(s)`;
    case 'collection.update':
      return `${describeCollectionChanges(item.payload.changes)} on ${String(item.payload.collectionIds.length)} collection(s)`;
    case 'collectionTags.add':
      return item.payload.tagIds.length === 0
        ? `Add the tag created in step ${item.dependsOnId ?? '?'} to ${String(item.payload.collectionIds.length)} collection(s)`
        : `Add ${String(item.payload.tagIds.length)} tag(s) to ${String(item.payload.collectionIds.length)} collection(s)`;
    case 'collectionTags.remove':
      return item.payload.tagIds.length === 0
        ? `Remove the tag from step ${item.dependsOnId ?? '?'} from ${String(item.payload.collectionIds.length)} collection(s)`
        : `Remove ${String(item.payload.tagIds.length)} tag(s) from ${String(item.payload.collectionIds.length)} collection(s)`;
    case 'collectionTags.set':
      return item.payload.tagIds.length === 0
        ? `Clear all tags on ${String(item.payload.collectionIds.length)} collection(s)`
        : `Replace tags on ${String(item.payload.collectionIds.length)} collection(s) with ${String(item.payload.tagIds.length)} tag(s)`;
    case 'fs.mkdir':
      return `Create directory ${item.payload.path}`;
    case 'fs.rename':
      return `Rename ${item.payload.from} to ${basename(item.payload.to)} on disk`;
    case 'fs.move':
      return `Move ${item.payload.from} to ${item.payload.to} on disk`;
    case 'fs.delete':
      return `Delete ${item.payload.path} from disk${item.payload.recursive ? ' (recursively)' : ''}`;
  }
}

/**
 * The changed keys, named rather than counted - "Update 3 collection(s)" would not say
 * whether the queue is about to re-point a folder or unmonitor the lot.
 */
function describeCollectionChanges(changes: CollectionChanges): string {
  const parts: string[] = [];
  if (changes.rootFolderPath !== undefined) parts.push(`re-aim at ${changes.rootFolderPath}`);
  if (changes.qualityProfileId !== undefined) parts.push('change quality profile');
  if (changes.minimumAvailability !== undefined)
    parts.push(`set availability to ${changes.minimumAvailability}`);
  if (changes.monitored !== undefined) parts.push(changes.monitored ? 'monitor' : 'unmonitor');
  if (changes.monitorMovies !== undefined)
    parts.push(changes.monitorMovies ? 'monitor their films' : 'unmonitor their films');
  if (changes.searchOnAdd !== undefined)
    parts.push(changes.searchOnAdd ? 'search on add' : 'stop searching on add');
  // An empty `changes` is rejected by the stager, but a summary that reads "on 3
  // collection(s)" with no verb would be worse than a dull one.
  return parts.length === 0 ? 'Update' : capitalise(parts.join(', '));
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function basename(value: string): string {
  const segments = value.split('/').filter((segment) => segment.length > 0);
  return segments.at(-1) ?? value;
}

/** How many remote objects an item touches - drives the "affected" column. */
export function affectedCountForOp(item: NewQueueItem): number {
  // Exhaustive on purpose, with no `default`. This used to fall through to 1, which meant a
  // 3000-item delete would stage as "1 affected" - a silent lie in the one column the
  // review step exists to show. Enumerating the ones that touch a single object costs a
  // line each and makes the next op break the build instead.
  switch (item.op) {
    case 'mediaTags.add':
    case 'mediaTags.remove':
    case 'mediaTags.set':
    case 'media.moveRootFolder':
    case 'media.setMonitored':
    case 'media.setQualityProfile':
    case 'media.delete':
      return item.payload.mediaIds.length;
    case 'collection.update':
    case 'collectionTags.add':
    case 'collectionTags.remove':
    case 'collectionTags.set':
      // The bulk editor touches N collections in one call and the tag ops touch N in N
      // calls; this column counts remote objects, not HTTP requests.
      return item.payload.collectionIds.length;
    case 'media.refresh':
      return Math.max(1, item.payload.mediaIds.length);
    case 'tag.merge':
      return item.payload.sourceTagIds.length;
    case 'tag.create':
    case 'tag.rename':
    case 'tag.delete':
    case 'rootFolder.create':
    case 'rootFolder.delete':
    case 'importList.update':
    case 'importList.delete':
    case 'importList.setEnabled':
    case 'fs.mkdir':
    case 'fs.rename':
    case 'fs.move':
    case 'fs.delete':
      return 1;
  }
}

export interface QueueTargetDescription {
  readonly targetId: number | null;
  readonly targetLabel: string;
}

/**
 * The remote object an item points at, snapshotted at staging time so the queue still
 * reads correctly after the object is renamed or deleted on the instance.
 */
export function describeQueueTarget(item: NewQueueItem): QueueTargetDescription {
  switch (item.op) {
    case 'tag.create':
      return { targetId: null, targetLabel: item.payload.label };
    case 'tag.rename':
      return { targetId: item.payload.tagId, targetLabel: item.payload.from };
    case 'tag.delete':
      return { targetId: item.payload.tagId, targetLabel: item.payload.label };
    case 'tag.merge':
      return { targetId: item.payload.targetTagId, targetLabel: `tag #${item.payload.targetTagId}` };
    case 'mediaTags.add':
    case 'mediaTags.remove':
      return { targetId: null, targetLabel: `${item.payload.mediaIds.length} item(s)` };
    case 'mediaTags.set':
    case 'media.setMonitored':
    case 'media.setQualityProfile':
    case 'media.delete':
      return {
        // A one-item operation is worth addressing in the drawer and the audit trail; a
        // 137-title label is not, so the row stays a count and the view keeps the identity.
        targetId: item.payload.mediaIds.length === 1 ? (item.payload.mediaIds[0] ?? null) : null,
        targetLabel: `${item.payload.mediaIds.length} item(s)`,
      };
    case 'rootFolder.create':
      return { targetId: null, targetLabel: item.payload.path };
    case 'rootFolder.delete':
      return { targetId: item.payload.rootFolderId, targetLabel: item.payload.path };
    case 'media.moveRootFolder':
      return { targetId: null, targetLabel: item.payload.toRootFolderPath };
    case 'importList.update':
    case 'importList.delete':
    case 'importList.setEnabled':
      return {
        targetId: item.payload.importListId,
        targetLabel: `import list #${item.payload.importListId}`,
      };
    case 'media.refresh':
      return { targetId: null, targetLabel: 'library rescan' };
    case 'collection.update':
    case 'collectionTags.add':
    case 'collectionTags.remove':
    case 'collectionTags.set':
      // The same rule the media branch follows: one collection is worth addressing, a
      // forty-collection label is not. No name is snapshotted - TMDB renames collections,
      // and the instance's own snapshot already holds the current one.
      return item.payload.collectionIds.length === 1
        ? {
            targetId: item.payload.collectionIds[0] ?? null,
            targetLabel: `collection #${String(item.payload.collectionIds[0])}`,
          }
        : {
            targetId: null,
            targetLabel: `${String(item.payload.collectionIds.length)} collection(s)`,
          };
    case 'fs.mkdir':
    case 'fs.delete':
      return { targetId: null, targetLabel: item.payload.path };
    case 'fs.rename':
    case 'fs.move':
      // The source path: that is the row the storage explorer highlights as staged.
      return { targetId: null, targetLabel: item.payload.from };
  }
}
