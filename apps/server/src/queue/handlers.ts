import {
  mergeForPut,
  type ArrJson,
  type ArrOp,
  type ArrTagDetail,
  type FsOp,
  type ImportListChanges,
  type InstanceWithKey,
  type QueueItemOf,
} from '@fleetarr/shared';
import type { ApplyTagsMode, ArrClient } from '../arr/client.js';
import type { FilesystemService } from '../fs/filesystem.service.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Handlers for every staged operation.
 *
 * The four action types named in the Phase 2 brief map onto this contract as:
 *   RENAME_TAG         -> tag.rename
 *   DELETE_TAG         -> tag.delete
 *   REASSIGN_TAG       -> mediaTags.add / mediaTags.remove / tag.merge
 *   CHANGE_ROOT_FOLDER -> media.moveRootFolder (plus rootFolder.create/delete)
 *
 * Everything goes through PUT /{movie|series}/editor for bulk media writes, which is
 * the only endpoint that applies a change to many items in one call.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** What every handler gets, whichever side of the fence it works on. */
export interface HandlerContext {
  readonly log: (level: LogLevel, message: string) => void;
  /** Result JSON of the item this one depends on - e.g. the id of a just-created tag. */
  readonly dependencyResult: Record<string, unknown> | null;
  readonly signal: AbortSignal;
}

/** *Arr operations additionally get a client bound to their instance. */
export interface ArrHandlerContext extends HandlerContext {
  readonly client: ArrClient;
  readonly instance: InstanceWithKey;
}

/** Filesystem operations get the storage engine and no instance at all. */
export interface FsHandlerContext extends HandlerContext {
  readonly fs: FilesystemService;
}

export type QueueHandlerResult = Record<string, unknown> | void;

export type ArrQueueHandler<K extends ArrOp> = (
  ctx: ArrHandlerContext,
  item: QueueItemOf<K>,
) => Promise<QueueHandlerResult>;

export type FsQueueHandler<K extends FsOp> = (
  ctx: FsHandlerContext,
  item: QueueItemOf<K>,
) => Promise<QueueHandlerResult>;

export type ArrQueueHandlers = { [K in ArrOp]: ArrQueueHandler<K> };
export type FsQueueHandlers = { [K in FsOp]: FsQueueHandler<K> };

/** Radarr reports attached media as movieIds, Sonarr as seriesIds. */
function attachedMediaIds(detail: ArrTagDetail): number[] {
  return detail.movieIds ?? detail.seriesIds ?? [];
}

/**
 * A dependency (`dependsOnId`) can supply an id the payload could not know at staging
 * time - "create tag X, then assign it to 40 movies" is two calls.
 */
function resolveTagId(payloadTagId: number, dependencyResult: Record<string, unknown> | null): number {
  const fromDependency = dependencyResult?.['tagId'];
  return typeof fromDependency === 'number' ? fromDependency : payloadTagId;
}

/** Folds the id produced by a `tag.create` dependency into the item's tag list. */
function resolveTagIds(
  payloadTagIds: readonly number[],
  dependencyResult: Record<string, unknown> | null,
  options: { allowEmpty?: boolean } = {},
): number[] {
  const fromDependency = dependencyResult?.['tagId'];
  const tagIds =
    typeof fromDependency === 'number'
      ? [...new Set([...payloadTagIds, fromDependency])]
      : [...payloadTagIds];

  // Empty is a mistake when adding or removing, and an instruction when replacing:
  // `mediaTags.set` with no ids means "clear them all".
  if (tagIds.length === 0 && options.allowEmpty !== true) {
    throw new ValidationError(
      'No tag to apply - the item it depends on did not produce a tag id',
    );
  }
  return tagIds;
}

const CORE_IMPORT_LIST_KEYS: ReadonlySet<keyof ImportListChanges> = new Set([
  'name',
  'rootFolderPath',
  'qualityProfileId',
  'tags',
  'monitor',
]);

export const arrHandlers: ArrQueueHandlers = {
  'tag.create': async (ctx, item) => {
    const tag = await ctx.client.createTag(item.payload.label);
    ctx.log('info', `Created tag "${tag.label}" (#${tag.id})`);
    return { tagId: tag.id, label: tag.label };
  },

  'tag.rename': async (ctx, item) => {
    const tagId = resolveTagId(item.payload.tagId, ctx.dependencyResult);
    const tag = await ctx.client.renameTag(tagId, item.payload.to);
    ctx.log('info', `Renamed tag #${tagId} from "${item.payload.from}" to "${tag.label}"`);
    return { tagId, label: tag.label };
  },

  'tag.delete': async (ctx, item) => {
    const tagId = resolveTagId(item.payload.tagId, ctx.dependencyResult);
    let detached = 0;

    let detachedCollections = 0;

    if (item.payload.detachFromMedia) {
      // *Arr detaches the tag implicitly on delete; doing it explicitly first means the
      // audit trail records exactly how many items were touched.
      const detail = await ctx.client.getTagDetail(tagId);
      const mediaIds = attachedMediaIds(detail.view);
      if (mediaIds.length > 0) {
        detached = await ctx.client.bulkEditMedia({ mediaIds, tags: [tagId], applyTags: 'remove' });
        ctx.log('info', `Removed tag #${tagId} from ${detached} item(s)`);
      }
    }

    // Collections are not in `/tag/detail`, so the count comes from the collections
    // themselves. Same reason as above - Radarr drops the tag either way, and the point is
    // that the trail says how much was carrying it.
    if (item.payload.detachFromCollections && ctx.instance.kind === 'radarr') {
      const collections = await ctx.client.listCollections();
      for (const entry of collections) {
        if (!entry.view.tags.includes(tagId)) continue;
        await ctx.client.putCollection(
          entry.view.id,
          mergeForPut(entry.raw, { tags: entry.view.tags.filter((id) => id !== tagId) }),
        );
        detachedCollections += 1;
      }
      if (detachedCollections > 0) {
        ctx.log('info', `Removed tag #${tagId} from ${detachedCollections} collection(s)`);
      }
    }

    await ctx.client.deleteTag(tagId);
    ctx.log('info', `Deleted tag "${item.payload.label}" (#${tagId})`);
    return { tagId, detached, detachedCollections };
  },

  'tag.merge': async (ctx, item) => {
    const { sourceTagIds, targetTagId, deleteSources } = item.payload;
    let moved = 0;
    let movedCollections = 0;

    // Collections carry tags too, and `/tag/detail` does not report them - so without this
    // read a merge moves every film and silently drops the association on the collections,
    // which is the half of the tag the fleet actually curates by hand.
    //
    // Held as mutable state rather than re-read per source tag: one collection may carry
    // several of them, and each PUT is a full replace, so the *next* one has to merge onto
    // the body this loop just wrote or it would resurrect the tag it had already removed.
    const collections = (
      ctx.instance.kind === 'radarr' ? await ctx.client.listCollections() : []
    ).map((entry) => ({ id: entry.view.id, raw: entry.raw, tags: [...entry.view.tags] }));

    for (const sourceTagId of sourceTagIds) {
      if (sourceTagId === targetTagId) continue;

      const detail = await ctx.client.getTagDetail(sourceTagId);
      const mediaIds = attachedMediaIds(detail.view);

      if (mediaIds.length > 0) {
        await ctx.client.bulkEditMedia({ mediaIds, tags: [targetTagId], applyTags: 'add' });
        moved += mediaIds.length;
        ctx.log('info', `Moved ${mediaIds.length} item(s) from tag #${sourceTagId} to #${targetTagId}`);
      }

      for (const entry of collections) {
        if (!entry.tags.includes(sourceTagId)) continue;
        const next = new Set(entry.tags);
        next.add(targetTagId);
        // The source tag is left in place when the sources survive - the merge then adds
        // the target without claiming the old one is gone, exactly as the media half does.
        if (deleteSources) next.delete(sourceTagId);
        const tags = [...next];
        const updated = await ctx.client.putCollection(entry.id, mergeForPut(entry.raw, { tags }));
        entry.raw = updated.raw;
        entry.tags = tags;
        movedCollections += 1;
      }

      if (deleteSources) {
        await ctx.client.deleteTag(sourceTagId);
        ctx.log('info', `Deleted merged tag #${sourceTagId}`);
      } else if (mediaIds.length > 0) {
        await ctx.client.bulkEditMedia({ mediaIds, tags: [sourceTagId], applyTags: 'remove' });
      }
    }

    if (movedCollections > 0) {
      ctx.log('info', `Moved ${String(movedCollections)} collection(s) onto tag #${targetTagId}`);
    }
    return { targetTagId, movedItems: moved, movedCollections, mergedTags: sourceTagIds.length };
  },

  /**
   * Replace, not merge. Every tag the payload does not name is gone afterwards, which is
   * why this is a separate op rather than a mode - and why an empty list is allowed: it is
   * how "clear all tags" is said.
   */
  'mediaTags.set': async (ctx, item) => {
    const tagIds = resolveTagIds(item.payload.tagIds, ctx.dependencyResult, { allowEmpty: true });
    const updated = await ctx.client.bulkEditMedia({
      mediaIds: item.payload.mediaIds,
      tags: tagIds,
      applyTags: 'replace',
    });
    ctx.log(
      'info',
      tagIds.length === 0
        ? `Cleared every tag on ${String(updated)} item(s)`
        : `Replaced the tags on ${String(updated)} item(s) with ${String(tagIds.length)} tag(s)`,
    );
    return { updated, tagIds };
  },
  'media.setMonitored': async (ctx, item) => {
    const updated = await ctx.client.bulkEditMedia({
      mediaIds: item.payload.mediaIds,
      monitored: item.payload.monitored,
    });
    ctx.log(
      'info',
      `${item.payload.monitored ? 'Monitoring' : 'Unmonitoring'} ${String(updated)} item(s)`,
    );
    return { updated, monitored: item.payload.monitored };
  },
  'media.setQualityProfile': async (ctx, item) => {
    const updated = await ctx.client.bulkEditMedia({
      mediaIds: item.payload.mediaIds,
      qualityProfileId: item.payload.qualityProfileId,
    });
    // The name is logged as well as the id: the id is meaningless one instance over, and
    // the audit trail is read long after the profile list has moved on.
    ctx.log(
      'info',
      `Set quality profile "${item.payload.profileName}" (#${String(item.payload.qualityProfileId)}) on ${String(updated)} item(s)`,
    );
    return { updated, qualityProfileId: item.payload.qualityProfileId };
  },
  /**
   * The only op in the app that destroys data outside the queue's reach. Both flags are
   * logged explicitly, because "we deleted 137 items" and "we deleted 137 items and their
   * files" are the two facts anyone reads this trail to tell apart.
   */
  'media.delete': async (ctx, item) => {
    const { mediaIds, deleteFiles, addImportExclusion } = item.payload;
    const deleted = await ctx.client.bulkDeleteMedia({ mediaIds, deleteFiles, addImportExclusion });
    ctx.log(
      'info',
      `Deleted ${String(deleted)} item(s) - files ${
        deleteFiles ? 'removed from disk' : 'left in place'
      }, import exclusion ${addImportExclusion ? 'added' : 'not added'}`,
    );
    return { deleted, deleteFiles, addImportExclusion };
  },
  'mediaTags.add': async (ctx, item) => {
    const tagIds = resolveTagIds(item.payload.tagIds, ctx.dependencyResult);
    const updated = await ctx.client.bulkEditMedia({
      mediaIds: item.payload.mediaIds,
      tags: tagIds,
      applyTags: 'add',
    });
    ctx.log('info', `Added ${tagIds.length} tag(s) to ${updated} item(s)`);
    return { updated, tagIds };
  },

  'mediaTags.remove': async (ctx, item) => {
    const tagIds = resolveTagIds(item.payload.tagIds, ctx.dependencyResult);
    const updated = await ctx.client.bulkEditMedia({
      mediaIds: item.payload.mediaIds,
      tags: tagIds,
      applyTags: 'remove',
    });
    ctx.log('info', `Removed ${tagIds.length} tag(s) from ${updated} item(s)`);
    return { updated, tagIds };
  },

  'rootFolder.create': async (ctx, item) => {
    const folder = await ctx.client.createRootFolder(item.payload.path);
    ctx.log('info', `Added root folder ${folder.path} (#${folder.id})`);
    return { rootFolderId: folder.id, path: folder.path };
  },

  'rootFolder.delete': async (ctx, item) => {
    await ctx.client.deleteRootFolder(item.payload.rootFolderId);
    ctx.log('info', `Removed root folder ${item.payload.path}`);
    return { rootFolderId: item.payload.rootFolderId };
  },

  'media.moveRootFolder': async (ctx, item) => {
    const { mediaIds, toRootFolderPath, moveFiles } = item.payload;
    const updated = await ctx.client.bulkEditMedia({ mediaIds, rootFolderPath: toRootFolderPath, moveFiles });
    ctx.log(
      'info',
      `Moved ${updated} item(s) to ${toRootFolderPath} - files ${moveFiles ? 'relocated on disk' : 'left in place'}`,
    );
    return { updated, rootFolderPath: toRootFolderPath, moveFiles };
  },

  'importList.update': async (ctx, item) => {
    const current = await ctx.client.getImportList(item.payload.importListId);
    const patch: ArrJson = {};
    const ignored: string[] = [];

    for (const [key, value] of Object.entries(item.payload.changes)) {
      if (value === undefined) continue;
      // Radarr and Sonarr expose different fields on an import list. Only send keys the
      // instance actually has, or *Arr rejects the whole PUT with a 400.
      if (key in current.raw || CORE_IMPORT_LIST_KEYS.has(key as keyof ImportListChanges)) {
        patch[key] = value;
      } else {
        ignored.push(key);
      }
    }

    if (ignored.length > 0) {
      ctx.log('warn', `Ignored field(s) not present on this ${ctx.instance.kind} import list: ${ignored.join(', ')}`);
    }

    const updated = await ctx.client.putImportList(
      item.payload.importListId,
      mergeForPut(current.raw, patch),
    );
    ctx.log('info', `Updated import list "${updated.view.name}" (#${updated.view.id})`);
    return { importListId: updated.view.id, applied: Object.keys(patch) };
  },

  'importList.delete': async (ctx, item) => {
    await ctx.client.deleteImportList(item.payload.importListId);
    ctx.log('info', `Deleted import list #${item.payload.importListId}`);
    return { importListId: item.payload.importListId };
  },

  'media.refresh': async (ctx, item) => {
    // After a folder was renamed on disk, this is what makes *Arr look again.
    const name = ctx.instance.kind === 'radarr' ? 'RefreshMovie' : 'RefreshSeries';
    const idKey = ctx.instance.kind === 'radarr' ? 'movieIds' : 'seriesIds';
    const command = await ctx.client.runCommand(
      name,
      item.payload.mediaIds.length === 0 ? {} : { [idKey]: [...item.payload.mediaIds] },
    );
    ctx.log('info', `Queued ${name} on ${ctx.instance.name} (command #${String(command.id)})`);
    return { commandId: command.id, command: name };
  },

  'importList.setEnabled': async (ctx, item) => {
    const current = await ctx.client.getImportList(item.payload.importListId);
    const patch: ArrJson = {};

    if ('enabled' in current.raw) patch['enabled'] = item.payload.enabled;
    // Radarr calls it enableAuto, Sonarr enableAutomaticAdd.
    if ('enableAuto' in current.raw) patch['enableAuto'] = item.payload.enableAutomaticAdd;
    if ('enableAutomaticAdd' in current.raw) {
      patch['enableAutomaticAdd'] = item.payload.enableAutomaticAdd;
    }

    // A silent no-op is the dangerous outcome here, not a failure: a folder delete can be
    // staged behind this op precisely because the list will stop adding, and an instance
    // whose raw body omits every switch would report success having changed nothing.
    if (Object.keys(patch).length === 0) {
      ctx.log(
        'warn',
        `This ${ctx.instance.kind} import list exposes no enabled/enableAuto field - nothing was changed`,
      );
    }

    const updated = await ctx.client.putImportList(
      item.payload.importListId,
      mergeForPut(current.raw, patch),
    );
    ctx.log(
      'info',
      `${item.payload.enabled ? 'Enabled' : 'Disabled'} import list "${updated.view.name}"`,
    );
    return { importListId: updated.view.id, applied: Object.keys(patch) };
  },

  /**
   * Radarr's collection editor. Partial by design, like `/movie/editor`, so no merge.
   *
   * One call for every collection named - which is what makes this the right op for a
   * root-folder remap, where every collection under the old folder moves together.
   */
  'collection.update': async (ctx, item) => {
    const { collectionIds, changes } = item.payload;
    if (Object.keys(changes).length === 0) {
      throw new ValidationError('collection.update was staged with no changes');
    }
    const updated = await ctx.client.bulkEditCollections({ collectionIds, ...changes });
    ctx.log(
      'info',
      `Updated ${String(updated)} collection(s): ${Object.keys(changes).join(', ')}`,
    );
    return { updated, applied: Object.keys(changes) };
  },

  'collectionTags.add': async (ctx, item) => applyCollectionTags(ctx, item, 'add'),
  'collectionTags.remove': async (ctx, item) => applyCollectionTags(ctx, item, 'remove'),
  'collectionTags.set': async (ctx, item) => applyCollectionTags(ctx, item, 'replace'),
};

/**
 * Tags on collections, one merged PUT each.
 *
 * There is no bulk path: `PUT /collection` carries no `tags` and no `applyTags`, so the
 * single-resource PUT is the only way in - and that one *is* a full replace, hence
 * `mergeForPut`. Sequential rather than parallel so a 4xx on the third collection leaves
 * a log that says which one, and so a partial failure stops where it happened.
 */
async function applyCollectionTags(
  ctx: ArrHandlerContext,
  item: QueueItemOf<'collectionTags.add' | 'collectionTags.remove' | 'collectionTags.set'>,
  mode: ApplyTagsMode,
): Promise<QueueHandlerResult> {
  // `replace` is the only mode where an empty list is an instruction rather than a
  // missing dependency result - it is how "clear them all" is said.
  const tagIds = resolveTagIds(item.payload.tagIds, ctx.dependencyResult, {
    allowEmpty: mode === 'replace',
  });
  const wanted = new Set(tagIds);
  let updated = 0;

  for (const collectionId of item.payload.collectionIds) {
    const current = await ctx.client.getCollection(collectionId);
    const existing = current.view.tags;
    const next =
      mode === 'replace'
        ? tagIds
        : mode === 'add'
          ? [...new Set([...existing, ...tagIds])]
          : existing.filter((tagId) => !wanted.has(tagId));

    // Skipping a no-op keeps the log honest about how many collections actually moved,
    // and spares a PUT that would bump the resource for nothing.
    if (next.length === existing.length && next.every((tagId) => existing.includes(tagId))) {
      continue;
    }

    await ctx.client.putCollection(collectionId, mergeForPut(current.raw, { tags: next }));
    updated += 1;
  }

  ctx.log(
    'info',
    `${mode === 'add' ? 'Added' : mode === 'remove' ? 'Removed' : 'Replaced'} tag(s) on ${String(updated)} of ${String(item.payload.collectionIds.length)} collection(s)`,
  );
  return { updated, tagIds };
}

/**
 * Filesystem handlers.
 *
 * Each one re-runs its preflight inside FilesystemService before touching anything: a
 * staged operation was reviewed against the disk as it was, and the disk may have moved on.
 */
export const fsHandlers: FsQueueHandlers = {
  'fs.mkdir': async (ctx, item) => {
    const result = await ctx.fs.mkdirp(item.payload);
    ctx.log('info', `Created ${result.path}`);
    return result;
  },

  'fs.rename': async (ctx, item) => {
    const result = await ctx.fs.relocate('fs.rename', item.payload);
    ctx.log('info', `Renamed ${result.from} to ${result.to}`);
    return result;
  },

  'fs.move': async (ctx, item) => {
    const result = await ctx.fs.relocate('fs.move', item.payload);
    ctx.log('info', `Moved ${result.from} to ${result.to}`);
    return result;
  },

  'fs.delete': async (ctx, item) => {
    const result = await ctx.fs.remove(item.payload);
    ctx.log(
      'info',
      `Deleted ${result.path} (${String(result.fileCount)} file(s), ${String(result.freedBytes)} bytes reclaimed)`,
    );
    return result;
  },
};
