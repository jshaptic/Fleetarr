import type {
  ArrCollection,
  ArrImportList,
  ArrQualityProfile,
  ArrRootFolder,
  ArrTagDetail,
  Instance,
} from '@fleetarr/shared';

/**
 * Fleet normalisation.
 *
 * Everything here is pure: instance snapshots in, comparison rows out. The views never
 * reason about a "current instance". Tag cells stay aligned with the fleet columns.
 * Import lists are not a grid at all any more - one row per (list, instance) pair, built
 * in `lib/import-lists.ts`.
 */

export type SnapshotStatus = 'loading' | 'ok' | 'error';

export interface InstanceSnapshot {
  readonly instance: Instance;
  readonly status: SnapshotStatus;
  readonly fetchedAt: string | null;
  readonly error: string | null;
  readonly tags: readonly ArrTagDetail[];
  readonly rootFolders: readonly ArrRootFolder[];
  readonly importLists: readonly ArrImportList[];
  readonly qualityProfiles: readonly ArrQualityProfile[];
  /**
   * Radarr collections. **Null is unknown, `[]` is genuinely none.**
   *
   * Sonarr answers `[]` - it has no collections, which is an answer. Null is a Radarr too
   * old to expose `/collection`, or one whose read failed.
   */
  readonly collections: readonly ArrCollection[] | null;
}

/** `full` = on every healthy instance, `unique` = on exactly one, `partial` = drift. */
export type ParityState = 'full' | 'partial' | 'unique';

export interface TagCell {
  readonly instanceId: number;
  /** False when the instance did not answer: unknown, not "missing". */
  readonly known: boolean;
  readonly present: boolean;
  readonly tagId: number | null;
  readonly mediaCount: number;
  /** Indexers, import lists, notifications, restrictions, delay profiles. */
  readonly otherUses: number;
  /**
   * Radarr collections carrying this tag.
   *
   * Its own count rather than folded into `otherUses`, because it is the one a fleet
   * actually curates by hand - and because `/tag/detail` does not report it at all, so it
   * comes from the collections themselves rather than from the tag.
   */
  readonly collectionCount: number;
  /** False when this instance never reported its collections: unknown, not zero. */
  readonly collectionsKnown: boolean;
}

export interface TagMatrixRow {
  readonly label: string;
  readonly cells: readonly TagCell[];
  readonly presentOn: readonly number[];
  readonly missingOn: readonly number[];
  readonly parity: ParityState;
  readonly totalMedia: number;
  readonly totalCollections: number;
  /**
   * Exists somewhere but attached to nothing anywhere - a deletion candidate.
   *
   * Collections count here. They were missed before, and a tag carried only by collections
   * read as unused and was offered for deletion - which is the unknown-as-missing failure
   * this codebase refuses, in its most expensive form. A row any instance could not answer
   * for is never a candidate either: not knowing is not the same as not used.
   */
  readonly unusedEverywhere: boolean;
}

export interface RootFolderCell {
  readonly instanceId: number;
  readonly known: boolean;
  readonly present: boolean;
  readonly rootFolderId: number | null;
  readonly accessible: boolean;
  readonly freeSpace: number | null;
  readonly totalSpace: number | null;
}

export interface RootFolderRow {
  readonly path: string;
  readonly cells: readonly RootFolderCell[];
  readonly presentOn: readonly number[];
  readonly missingOn: readonly number[];
  readonly inaccessibleOn: readonly number[];
  readonly parity: ParityState;
}

export interface FleetStats {
  readonly instances: number;
  readonly healthy: number;
  readonly failing: number;
  readonly tagsTotal: number;
  readonly tagsInSync: number;
  readonly tagsDrifted: number;
  readonly rootFoldersTotal: number;
  readonly rootFoldersInSync: number;
  readonly rootFoldersDrifted: number;
  readonly rootFoldersInaccessible: number;
}

/** Stable column order: Radarr instances first, then Sonarr, alphabetical within a kind. */
export function sortSnapshots(snapshots: readonly InstanceSnapshot[]): InstanceSnapshot[] {
  return [...snapshots].sort((a, b) => {
    if (a.instance.kind !== b.instance.kind) return a.instance.kind === 'radarr' ? -1 : 1;
    return a.instance.name.localeCompare(b.instance.name, 'en');
  });
}

/** Only instances that answered can be compared - a failed one is "unknown", not "missing". */
function comparable(snapshots: readonly InstanceSnapshot[]): InstanceSnapshot[] {
  return snapshots.filter((snapshot) => snapshot.status === 'ok');
}

function parityOf(presentCount: number, comparableCount: number): ParityState {
  if (comparableCount > 0 && presentCount >= comparableCount) return 'full';
  if (presentCount <= 1) return 'unique';
  return 'partial';
}

function attachedMediaCount(tag: ArrTagDetail): number {
  return (tag.movieIds ?? tag.seriesIds ?? []).length;
}

/**
 * How many of this instance's collections carry the tag.
 *
 * Derived from the collections rather than from `/tag/detail`, which reports indexers,
 * lists, notifications, restrictions and delay profiles but not collections - so a count
 * taken from there would silently be zero.
 */
function collectionUseCount(
  collections: readonly ArrCollection[] | null,
  tagId: number | null,
): number {
  if (collections === null || tagId === null) return 0;
  return collections.filter((entry) => entry.tags.includes(tagId)).length;
}

function otherUseCount(tag: ArrTagDetail): number {
  return (
    tag.indexerIds.length +
    tag.importListIds.length +
    tag.notificationIds.length +
    tag.restrictionIds.length +
    tag.delayProfileIds.length
  );
}

export function buildTagRows(snapshots: readonly InstanceSnapshot[]): TagMatrixRow[] {
  // Cells cover every column - including unreachable ones, which render as unknown - so
  // the matrix header and body always line up.
  const healthy = comparable(snapshots);
  const labels = new Set<string>();
  for (const snapshot of healthy) {
    for (const tag of snapshot.tags) labels.add(tag.label);
  }

  const rows = [...labels].map((label): TagMatrixRow => {
    const cells = snapshots.map((snapshot): TagCell => {
      const tag = snapshot.tags.find((entry) => entry.label === label);
      return {
        instanceId: snapshot.instance.id,
        known: snapshot.status === 'ok',
        present: tag !== undefined,
        tagId: tag?.id ?? null,
        mediaCount: tag === undefined ? 0 : attachedMediaCount(tag),
        otherUses: tag === undefined ? 0 : otherUseCount(tag),
        collectionCount: collectionUseCount(snapshot.collections, tag?.id ?? null),
        collectionsKnown: snapshot.collections !== null,
      };
    });

    const presentOn = cells.filter((cell) => cell.known && cell.present).map((cell) => cell.instanceId);
    const missingOn = cells.filter((cell) => cell.known && !cell.present).map((cell) => cell.instanceId);
    const totalMedia = cells.reduce((sum, cell) => sum + cell.mediaCount, 0);
    const totalOther = cells.reduce((sum, cell) => sum + cell.otherUses, 0);
    const totalCollections = cells.reduce((sum, cell) => sum + cell.collectionCount, 0);
    // Only over the cells that are present: an instance that does not have the tag has no
    // collections to be ignorant of either.
    const collectionsUnknown = cells.some(
      (cell) => cell.known && cell.present && !cell.collectionsKnown,
    );

    return {
      label,
      cells,
      presentOn,
      missingOn,
      parity: parityOf(presentOn.length, healthy.length),
      totalMedia,
      totalCollections,
      unusedEverywhere:
        totalMedia === 0 && totalOther === 0 && totalCollections === 0 && !collectionsUnknown,
    };
  });

  return rows.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}

export function buildRootFolderRows(snapshots: readonly InstanceSnapshot[]): RootFolderRow[] {
  const healthy = comparable(snapshots);
  const paths = new Set<string>();
  for (const snapshot of healthy) {
    for (const folder of snapshot.rootFolders) paths.add(folder.path);
  }

  const rows = [...paths].map((path): RootFolderRow => {
    const cells = snapshots.map((snapshot): RootFolderCell => {
      const folder = snapshot.rootFolders.find((entry) => entry.path === path);
      return {
        instanceId: snapshot.instance.id,
        known: snapshot.status === 'ok',
        present: folder !== undefined,
        rootFolderId: folder?.id ?? null,
        accessible: folder?.accessible ?? true,
        freeSpace: folder?.freeSpace ?? null,
        totalSpace: folder?.totalSpace ?? null,
      };
    });

    const presentOn = cells.filter((cell) => cell.known && cell.present).map((cell) => cell.instanceId);

    return {
      path,
      cells,
      presentOn,
      missingOn: cells.filter((cell) => cell.known && !cell.present).map((cell) => cell.instanceId),
      inaccessibleOn: cells
        .filter((cell) => cell.present && !cell.accessible)
        .map((cell) => cell.instanceId),
      parity: parityOf(presentOn.length, healthy.length),
    };
  });

  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function buildFleetStats(
  snapshots: readonly InstanceSnapshot[],
  tagRows: readonly TagMatrixRow[],
  rootFolderRows: readonly RootFolderRow[],
): FleetStats {
  return {
    instances: snapshots.length,
    healthy: snapshots.filter((snapshot) => snapshot.status === 'ok').length,
    failing: snapshots.filter((snapshot) => snapshot.status === 'error').length,
    tagsTotal: tagRows.length,
    tagsInSync: tagRows.filter((row) => row.parity === 'full').length,
    tagsDrifted: tagRows.filter((row) => row.parity !== 'full').length,
    rootFoldersTotal: rootFolderRows.length,
    rootFoldersInSync: rootFolderRows.filter((row) => row.parity === 'full').length,
    rootFoldersDrifted: rootFolderRows.filter((row) => row.parity !== 'full').length,
    rootFoldersInaccessible: rootFolderRows.filter((row) => row.inaccessibleOn.length > 0).length,
  };
}

/** Case-insensitive substring match used by Find &amp; Replace across the fleet. */
export interface ReplacementPreview {
  readonly instanceId: number;
  readonly tagId: number;
  readonly from: string;
  readonly to: string;
}

export function previewFindReplace(
  snapshots: readonly InstanceSnapshot[],
  find: string,
  replace: string,
  options: { caseSensitive?: boolean; instanceIds?: readonly number[] } = {},
): ReplacementPreview[] {
  if (find.length === 0) return [];

  const flags = options.caseSensitive === true ? 'g' : 'gi';
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const allowed = options.instanceIds;

  const previews: ReplacementPreview[] = [];

  for (const snapshot of comparable(snapshots)) {
    if (allowed !== undefined && !allowed.includes(snapshot.instance.id)) continue;

    for (const tag of snapshot.tags) {
      pattern.lastIndex = 0;
      if (!pattern.test(tag.label)) continue;

      const next = tag.label.replace(new RegExp(pattern.source, flags), replace);
      if (next === tag.label || next.trim().length === 0) continue;

      previews.push({ instanceId: snapshot.instance.id, tagId: tag.id, from: tag.label, to: next });
    }
  }

  return previews;
}

/** The tag id carrying `label` on one instance, if any. */
export function tagIdByLabel(
  snapshots: readonly InstanceSnapshot[],
  instanceId: number,
  label: string,
): number | null {
  const snapshot = snapshots.find((entry) => entry.instance.id === instanceId);
  return snapshot?.tags.find((tag) => tag.label === label)?.id ?? null;
}

/**
 * Renames that would collide with an existing tag on the same instance, keyed
 * `${instanceId}|${label}` -> existing tag id. *Arr answers a colliding rename with
 * "Label already exists", so the caller stages a merge into that tag instead.
 */
export function findCollisions(
  snapshots: readonly InstanceSnapshot[],
  candidates: ReadonlyArray<{ instanceId: number; to: string }>,
): Map<string, number> {
  const collisions = new Map<string, number>();

  for (const candidate of candidates) {
    const existing = tagIdByLabel(snapshots, candidate.instanceId, candidate.to);
    if (existing !== null) collisions.set(`${String(candidate.instanceId)}|${candidate.to}`, existing);
  }

  return collisions;
}
