import type { Component } from 'vue';
import type { QueueItem, QueueItemStatus, QueueOp } from '@fleetarr/shared';
import IconCreate from '@/components/base/icons/IconCreate.vue';
import IconDelete from '@/components/base/icons/IconDelete.vue';
import IconEdit from '@/components/base/icons/IconEdit.vue';
import IconMerge from '@/components/base/icons/IconMerge.vue';
import IconMove from '@/components/base/icons/IconMove.vue';
import IconRefresh from '@/components/base/icons/IconRefresh.vue';
import IconRemove from '@/components/base/icons/IconRemove.vue';
import IconToggle from '@/components/base/icons/IconToggle.vue';

export type OpTone = 'create' | 'update' | 'move' | 'destroy';

export interface OpPresentation {
  readonly icon: Component;
  readonly label: string;
  readonly tone: OpTone;
}

/** One place for the icon + wording of every operation, shared by cells and the drawer. */
const PRESENTATION: Record<QueueOp, OpPresentation> = {
  'tag.create': { icon: IconCreate, label: 'Create tag', tone: 'create' },
  'tag.rename': { icon: IconEdit, label: 'Rename tag', tone: 'update' },
  'tag.delete': { icon: IconDelete, label: 'Delete tag', tone: 'destroy' },
  'tag.merge': { icon: IconMerge, label: 'Merge tags', tone: 'destroy' },
  'mediaTags.add': { icon: IconCreate, label: 'Add tags to media', tone: 'update' },
  'mediaTags.remove': { icon: IconRemove, label: 'Remove tags from media', tone: 'update' },
  'mediaTags.set': { icon: IconEdit, label: 'Replace tags on media', tone: 'update' },
  'rootFolder.create': { icon: IconCreate, label: 'Add root folder', tone: 'create' },
  'rootFolder.delete': { icon: IconDelete, label: 'Unassign root folder', tone: 'destroy' },
  'media.moveRootFolder': { icon: IconMove, label: 'Move to root folder', tone: 'move' },
  'importList.update': { icon: IconEdit, label: 'Update import list', tone: 'update' },
  'importList.delete': { icon: IconDelete, label: 'Delete import list', tone: 'destroy' },
  'importList.setEnabled': { icon: IconToggle, label: 'Toggle import list', tone: 'update' },
  'media.refresh': { icon: IconRefresh, label: 'Rescan library', tone: 'update' },
  'media.setMonitored': { icon: IconToggle, label: 'Set monitored', tone: 'update' },
  'media.setQualityProfile': { icon: IconEdit, label: 'Set quality profile', tone: 'update' },
  'media.delete': { icon: IconDelete, label: 'Delete media', tone: 'destroy' },
  'collection.update': { icon: IconEdit, label: 'Update collections', tone: 'update' },
  'collectionTags.add': { icon: IconCreate, label: 'Add tags to collections', tone: 'update' },
  'collectionTags.remove': {
    icon: IconRemove,
    label: 'Remove tags from collections',
    tone: 'update',
  },
  'collectionTags.set': {
    icon: IconEdit,
    label: 'Replace tags on collections',
    tone: 'update',
  },
  'fs.mkdir': { icon: IconCreate, label: 'Create directory', tone: 'create' },
  'fs.rename': { icon: IconEdit, label: 'Rename on disk', tone: 'move' },
  'fs.move': { icon: IconMove, label: 'Move on disk', tone: 'move' },
  'fs.delete': { icon: IconDelete, label: 'Delete from disk', tone: 'destroy' },
};

export function presentOp(op: QueueOp): OpPresentation {
  return PRESENTATION[op];
}

const TONE_SEVERITY: Record<OpTone, number> = { destroy: 3, move: 2, create: 1, update: 0 };

/**
 * The worse of what is already staged and one more operation.
 *
 * Extracted because two indexes now answer "what is staged here" - the matrix cells and the
 * per-media one - and worst-case-wins has to mean the same thing in both.
 */
export function worseIntent(current: OpPresentation | null, op: QueueOp): OpPresentation {
  const candidate = presentOp(op);
  if (current === null) return candidate;
  return TONE_SEVERITY[candidate.tone] > TONE_SEVERITY[current.tone] ? candidate : current;
}

/** The badge a matrix cell shows when several operations target it - worst case wins. */
export function stagedIntent(items: readonly QueueItem[]): OpPresentation | null {
  let winner: OpPresentation | null = null;
  for (const item of items) winner = worseIntent(winner, item.op);
  return winner;
}

export const TONE_CLASSES: Record<OpTone, string> = {
  create: 'text-sync border-sync/50 bg-sync/10',
  update: 'text-staged border-staged/50 bg-staged/10',
  move: 'text-accent border-accent/50 bg-accent/10',
  destroy: 'text-danger border-danger/50 bg-danger/10',
};

export const STATUS_CLASSES: Record<QueueItemStatus, string> = {
  pending: 'text-muted border-line-strong bg-raised',
  running: 'text-accent border-accent/50 bg-accent/10 staged-pulse',
  succeeded: 'text-sync border-sync/50 bg-sync/10',
  failed: 'text-danger border-danger/50 bg-danger/10',
  skipped: 'text-drift border-drift/50 bg-drift/10',
  cancelled: 'text-faint border-line bg-raised',
};

export const STATUS_LABELS: Record<QueueItemStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** True when an operation removes or relocates data - the drawer flags these explicitly. */
export function isDestructive(item: QueueItem): boolean {
  if (presentOp(item.op).tone === 'destroy') return true;
  if (item.op === 'fs.rename' || item.op === 'fs.move') return true;
  return item.op === 'media.moveRootFolder' && item.payload.moveFiles;
}

/**
 * Work nothing can undo: the bytes are gone from the disk.
 *
 * Distinct from `isDestructive`, which covers everything worth a red badge. This one is
 * what earns the typed confirmation, and it is deliberately a short list.
 */
export function isIrreversible(item: QueueItem): boolean {
  if (item.op === 'media.delete') return item.payload.deleteFiles;
  return item.op === 'fs.delete';
}

/** Human sentence for the impact summary, e.g. "3 tags across 4 instances". */
export function describeTargets(kind: string, count: number): string {
  const nouns: Record<string, [string, string]> = {
    tag: ['tag', 'tags'],
    rootFolder: ['root folder', 'root folders'],
    importList: ['import list', 'import lists'],
    collection: ['collection', 'collections'],
    path: ['folder', 'folders'],
    movie: ['movie', 'movies'],
    series: ['series', 'series'],
  };
  const pair = nouns[kind] ?? [kind, `${kind}s`];
  return `${String(count)} ${count === 1 ? pair[0] : pair[1]}`;
}
