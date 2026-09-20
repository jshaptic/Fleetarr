import type { FsOp, QueuePayloadFor } from './queue.js';

/**
 * Contracts for storage inspection and staged disk work.
 *
 * Fleetarr only ever reports paths as the *container* sees them, which is the same path
 * the *Arr instances must see - see the Storage access section of the README.
 */

export interface FsRoot {
  /** Absolute path inside the container, e.g. /data. */
  readonly path: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
  /** Filesystem id; a move between two different devices cannot be a rename. */
  readonly deviceId: string | null;
  readonly freeSpace: number | null;
  readonly totalSpace: number | null;
  readonly error: string | null;
}

export interface FsRootsResponse {
  /** False when FS_ROOTS is unset: the whole filesystem feature is off. */
  readonly enabled: boolean;
  readonly roots: readonly FsRoot[];
}

export type FsEntryKind = 'directory' | 'file' | 'symlink' | 'other';

export interface FsEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: FsEntryKind;
  readonly modifiedAt: string | null;
  /** Immediate children; null when it could not be read. */
  readonly childCount: number | null;
  readonly sizeOnDisk: number | null;
  readonly fileCount: number | null;
  readonly readable: boolean;
  readonly writable: boolean;
}

export interface FsListResponse {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FsEntry[];
}

/**
 * Every directory a picker may offer, as one flat list.
 *
 * Deliberately not a tree and deliberately not `PathNode`: a destination field needs names,
 * not facts, so this walk does no `stat` per entry and carries no *Arr join. The tree view
 * summarises a level with more than 64 children down to its problems, which is right for
 * reading a fleet and useless for choosing a folder - this answers the second question.
 *
 * It stops at a root folder, exactly as the matrix does: below one lies the library, which
 * is thousands of media folders and never a destination.
 */
export interface FsDirectoriesResponse {
  /** The subtree walked. Null means every storage root. */
  readonly under: string | null;
  readonly directories: readonly string[];
  /** True when the walk hit its cap - the list is a lower bound, and the UI says so. */
  readonly truncated: boolean;
  readonly scannedAt: string;
}

export interface FsMeasurement {
  readonly path: string;
  readonly sizeOnDisk: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  /** True when the walk hit its entry cap - the numbers are a lower bound. */
  readonly truncated: boolean;
}

export type FsCheckStatus = 'ok' | 'warning' | 'blocker';

export interface FsCheck {
  readonly id: string;
  readonly status: FsCheckStatus;
  readonly message: string;
}

/**
 * Why one instance's database stands in the way of a path, in enough detail to stage the
 * fix rather than only to refuse.
 *
 * The three claims are deliberately separate. A root folder and an import list are
 * *registrations* - a staged `rootFolder.delete` or `importList.setEnabled` clears them,
 * and the delete then needs no `force`. Tracked media is not: unassigning a root folder
 * leaves every item's stored path untouched, so `mediaUnder` survives it and the only
 * honest answers are a remap, a `media.delete`, or `force`.
 */
export interface FsPathReference {
  readonly instanceId: number;
  readonly instanceName: string;
  /** Its root folders at or *under* the path - a parent's delete takes them all. */
  readonly rootFolders: readonly PathRootFolderRef[];
  /** Media items at or under the path. Not cleared by unassigning anything. */
  readonly mediaUnder: number;
  /** Lists whose target folder is at or under the path - what refills it after a delete. */
  readonly importLists: readonly PathImportList[];
  /**
   * Radarr collections rooted at or under the path.
   *
   * The fourth claim, and the same shape of hazard as an import list: a monitored
   * collection re-adds its films into this folder on the next sync, so a delete that
   * ignored it would be undone. Required, never optional - an absent array would read as
   * "no collections" to a caller that forgot, and a destructive guard must never mistake a
   * gap for a clear.
   */
  readonly collections: readonly PathCollection[];
}

/**
 * The answer to "what would happen if I ran this". Returned to the UI before staging and
 * re-run by the executor immediately before the operation, because the disk can change
 * between review and Apply All.
 */
export interface FsPreflight {
  readonly op: FsOp;
  readonly ok: boolean;
  readonly checks: readonly FsCheck[];
  readonly measurement: FsMeasurement | null;
  readonly freeSpace: number | null;
  /** Instances whose database references this path, for any of the reasons below. */
  readonly referencedBy: readonly number[];
  /** Per instance, *why* - so a dialog can offer to clear it instead of forcing past it. */
  readonly references: readonly FsPathReference[];
}

/**
 * Claims the caller is about to clear itself, so the preflight states the verdict that
 * will hold once it has.
 *
 * Request-only, and deliberately not part of `QueueOpPayloads`: it describes what the
 * *staging dialog* intends, never what the executor will run. The pre-execution re-run
 * passes nothing here, so by then the claim has either really gone or the check fires
 * for real. Without it a dialog would have to predict a safety verdict in the browser,
 * which is exactly what reading the server's verdict exists to avoid.
 */
export interface FsAssumeResolved {
  /** A `rootFolder.delete` is staged for every root folder at or under the path. */
  readonly rootFolders?: boolean;
  /** An `importList.setEnabled` disabling every list that fills the path is staged. */
  readonly importLists?: boolean;
  /**
   * A `collection.update` unmonitoring every collection aimed here is staged.
   *
   * Unmonitoring rather than deleting: Radarr's API cannot delete a collection at all, so
   * this is a collection's reversible equivalent of disabling a list.
   */
  readonly collections?: boolean;
}

export interface FsPreflightRequest<K extends FsOp = FsOp> {
  readonly op: K;
  readonly payload: QueuePayloadFor<K>;
  readonly assumeResolved?: FsAssumeResolved;
}

/**
 * An instance whose paths do not exist in this container at all - almost always a volume
 * mapping difference rather than missing media.
 */
export interface MappingMismatch {
  readonly instanceId: number;
  readonly reportedPaths: readonly string[];
  readonly checkedRoots: readonly string[];
  readonly mediaPathCount: number;
}


// ------------------------------------------------------------- path matrix

/**
 * The joined view of storage: one row per folder, managed and monitored in its own right.
 *
 * A folder is essentially never reused by two instances - each roots at its own subtree -
 * so the instances that use one are a column (`owners`), not the axis.
 *
 * The join still happens on the server because only it holds every instance's whole media
 * path set - the web app could never answer "how many media items live under this
 * folder, on which instances" without downloading the fleet's entire library.
 */

/** How one instance uses one path, lowest precedence first. */
export const PATH_USES = [
  /**
   * A Radarr collection roots at this path, and the instance neither roots, tracks nor
   * aims a list here.
   *
   * Lowest precedence, and it has to exist: without it a folder claimed by nothing but a
   * collection shows no chip at all, reads as `untracked`, and is then refused deletion by
   * `collection_under` with nothing on the row to explain why.
   */
  'collection',
  /**
   * An import list adds media here, and the instance neither roots nor tracks anything
   * at this path. On its own that is a misconfiguration - a list pointing at a folder
   * nobody roots at - which is why it earns a chip rather than silence.
   */
  'importList',
  /** It has media strictly *under* this path - the folder's reason to exist. */
  'ancestor',
  /**
   * One or more of its root folders live strictly *under* this path.
   *
   * The parent of a root folder is in use by that instance whether or not a single item
   * has been downloaded yet, so this is what an empty-but-configured library reports.
   */
  'containsRoot',
  /** It has a media item at exactly this path. */
  'tracked',
  /** It has a root folder at exactly this path. */
  'rootFolder',
] as const;
export type PathUse = (typeof PATH_USES)[number];

/** One import list, reduced to what a folder's owner card needs. */
export interface PathImportList {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  /** `enableAuto` (Radarr) / `enableAutomaticAdd` (Sonarr): it adds without being asked. */
  readonly automatic: boolean;
  /** The folder it adds to, which is this path or somewhere under it. */
  readonly path: string;
}

/**
 * One Radarr collection, reduced to what a folder's owner card and the delete guard need.
 *
 * `monitored` is the collection's `automatic`: it is what makes Radarr re-add films here
 * unattended. `searchOnAdd` is the weaker claim - nothing happens until something is
 * monitored again, but the collection is still aimed at this folder.
 */
export interface PathCollection {
  readonly id: number;
  readonly title: string;
  readonly monitored: boolean;
  readonly searchOnAdd: boolean;
  /** Its root folder, which is this path or somewhere under it. */
  readonly path: string;
}

/** A root folder living strictly under a parent row - enough to stage a create/delete. */
export interface PathRootFolderRef {
  readonly id: number;
  readonly path: string;
}

/**
 * One instance's claim on one path. Usually there is exactly one per row.
 *
 * An instance that uses a path in none of those ways is simply absent from `owners`. So is
 * one that did not answer - which is why `PathMatrixColumn.reachable` is load-bearing: the
 * view must say "1 instance did not answer" rather than let an empty Used-by cell read as
 * "nobody uses this". That is the same `unknown` is never `missing` invariant the fleet
 * matrices enforce with `cell.known`, moved from per cell to once per response.
 */
export interface PathOwner {
  readonly instanceId: number;
  /** Denormalised so a chip renders without joining against `columns`. */
  readonly name: string;
  readonly kind: 'radarr' | 'sonarr';
  readonly use: PathUse;
  /** Set when use === 'rootFolder' - needed to stage a delete or a re-map. */
  readonly rootFolderId: number | null;
  /** *Arr's own verdict on the mount. Null unless it reports a root folder here. */
  readonly accessible: boolean | null;
  /** Media items this instance tracks at or under this path. */
  readonly mediaUnder: number;
  /**
   * Of `mediaUnder`, the items it actually holds a file for.
   *
   * The gap between the two is the monitored-but-not-downloaded backlog, which is a fact
   * about the instance rather than about the disk - so the card states both numbers and
   * never lets one stand in for the other.
   */
  readonly mediaWithFiles: number;
  /** Title of the media item at this exact path, when there is one. */
  readonly title: string | null;
  /**
   * Its root folders strictly *under* this path, nearest first.
   *
   * The reason a parent folder shows a chip at all when the library below it is still
   * empty: a configured root folder is use, and waiting for the first download to admit
   * it made the tree lie about who owns what. Carries the id so a parent rename can
   * drop the old registration after the disk has moved.
   */
  readonly rootFoldersUnder: readonly PathRootFolderRef[];
  /**
   * Every import list on this instance that adds media at or under this path, the ones
   * targeting it exactly first.
   *
   * Named rather than counted, and including the ones aimed below: a list is the thing
   * that refills a folder after it is pruned or re-pointed, so "which list" is the
   * actionable half and each entry carries its own `path` to say where it lands.
   */
  readonly importLists: readonly PathImportList[];
  /**
   * Every Radarr collection on this instance rooted at or under this path, the ones
   * targeting it exactly first.
   *
   * Empty on every Sonarr instance, which is a fact about the app rather than a gap - see
   * `collectionsKnown`.
   */
  readonly collections: readonly PathCollection[];
  /**
   * Whether this instance's collections could be read at all.
   *
   * False for a Radarr too old to expose `/collection`, or one whose read failed. **True
   * for Sonarr**, which has no collections to be ignorant of - vacuously known, and
   * load-bearing: `false` there would make every fleet containing a Sonarr incomplete and
   * block every folder delete in the app.
   */
  readonly collectionsKnown: boolean;
  /**
   * Free/total space *Arr itself reports for its root folder here.
   *
   * Deliberately separate from `PathNode.freeSpace`, which is what *this* container's
   * `statfs` says: when the two disagree the instance is looking at a different volume,
   * and only showing both can say so.
   */
  readonly freeSpace: number | null;
  readonly totalSpace: number | null;
}

/**
 * The worst thing known about a path, so a collapsed tree can show a glyph at a glance.
 *
 * Derived server-side from the same flags the badges come from, for the same reason: one
 * vocabulary, one place.
 */
export const PATH_SEVERITIES = ['ok', 'info', 'warn', 'error'] as const;
export type PathSeverity = (typeof PATH_SEVERITIES)[number];

export type PathNodeKind = 'directory' | 'file' | 'symlink' | 'other';

/** Found on disk, in an *Arr database, or both. */
export type PathNodeOrigin = 'disk' | 'arr' | 'both';

/** Row conclusions, computed server-side so the badge vocabulary cannot drift. */
export const PATH_FLAGS = [
  /** A configured FS_ROOTS mount: never renameable, moveable or deletable. */
  'mount',
  /** A root folder on at least one reachable instance. */
  'rootFolder',
  /** Inside someone's root folder, and nothing is tracked at or under it. */
  'untracked',
  /** Holds media, but sits under no root folder anywhere. */
  'unmanaged',
  /** An instance points here and the disk does not have it. */
  'missing',
  /** A root folder outside FS_ROOTS - a volume mapping difference, not missing media. */
  'unseen',
  /** No entries on disk. A null childCount means "not evaluated", not "empty". */
  'empty',
  /** Shown, never followed, never mutated. */
  'symlink',
  /** The container cannot read it - check PUID/PGID. */
  'unreadable',
  /** Readable but not writable: a staged move or rename here would fail. */
  'readOnly',
] as const;
export type PathFlag = (typeof PATH_FLAGS)[number];

/**
 * What is in a directory, one level down, without shipping its children. Exact even
 * when `nodes` is a subset, because it comes from the dirent list plus the index.
 *
 * `empty` and `unreadable` are null when the level was served without a readdir per
 * child. A null means "not evaluated" - the UI must say so, never render a zero.
 */
export interface PathRollup {
  /** Immediate entries: disk children plus *Arr children that are not on disk. */
  readonly entries: number;
  readonly tracked: number;
  readonly untracked: number;
  /** Children outside every instance's root folders - no instance has an opinion. */
  readonly neutral: number;
  /** Children an instance holds files for that are not on disk. A monitored-but-not-yet
   *  downloaded item is not counted: its path is meant not to exist. */
  readonly missing: number;
  readonly rootFolders: number;
  readonly symlinks: number;
  readonly empty: number | null;
  readonly unreadable: number | null;
  /** Media items at or under this path, summed across reachable instances. */
  readonly mediaUnder: number;
  /**
   * The worst severity among this directory's entries, so a collapsed row can warn that
   * something inside needs attention.
   *
   * Derived from the dirent list plus the index only, exactly like the counts above, so
   * the problems that need a readdir or access check per child (`empty`, `unreadable`,
   * `readOnly`) are reflected only when the level reports `childCountsResolved`.
   */
  readonly severity: PathSeverity;
}

export interface PathNode {
  readonly path: string;
  readonly name: string;
  readonly origin: PathNodeOrigin;
  // ------------------------------------------------------------------ disk facts
  readonly exists: boolean;
  readonly kind: PathNodeKind;
  /** Inside FS_ROOTS at all. False for an *Arr path this container cannot see. */
  readonly inScope: boolean;
  readonly modifiedAt: string | null;
  /** Immediate children on disk. Null when not evaluated, unreadable, or not a dir. */
  readonly childCount: number | null;
  readonly readable: boolean;
  readonly writable: boolean;
  /** Filesystem id: a move between two different devices cannot be a rename. */
  readonly deviceId: string | null;
  /**
   * Free/total space of the filesystem this path is on.
   *
   * Resolved by device id, one statfs per distinct filesystem per request and seeded from
   * the FS_ROOTS mounts - so the common single-`/data`-volume layout costs no extra
   * syscalls at all. A row that was not probed inherits its containing mount's numbers.
   */
  readonly freeSpace: number | null;
  readonly totalSpace: number | null;
  /**
   * This path's filesystem is below the configured low-space threshold.
   *
   * Only ever set on a mount or a root folder: every row under one shares its filesystem,
   * so flagging them all would paint a whole library amber and say nothing actionable.
   */
  readonly lowSpace: boolean;
  /** File size, or a *previously measured* directory size. Never triggers a walk. */
  readonly sizeOnDisk: number | null;
  readonly error: string | null;
  // ---------------------------------------------------------------------- the join
  /** Instances that use this exact path, highest precedence first. Usually one. */
  readonly owners: readonly PathOwner[];
  readonly flags: readonly PathFlag[];
  readonly severity: PathSeverity;
  /**
   * At least one reachable instance has no root folder here, and this path could hold one.
   * Gates the "add root folder" action - the dialog then decides *which* instances.
   */
  readonly canAddRootFolder: boolean;
  /** Null for files and for nodes that are not on disk. */
  readonly rollup: PathRollup | null;
  /** True when this node has, or may have, children worth expanding. */
  readonly expandable: boolean;
}

/**
 * What `only=` may select. Everything is free to evaluate from one readdir plus the
 * index, except `empty` and `unreadable`, which need a readdir per child.
 */
export const PATH_SELECTORS = [
  'all',
  'problems',
  'rootFolders',
  'tracked',
  'untracked',
  'missing',
  'symlinks',
  'empty',
  'unreadable',
] as const;
export type PathSelector = (typeof PATH_SELECTORS)[number];

export interface PathMatrixLevel {
  /** The directory these nodes are children of. Null for the synthetic top level. */
  readonly path: string | null;
  /** Where "up" goes, or null at a mount and at the top level. */
  readonly parent: string | null;
  readonly nodes: readonly PathNode[];
  /** Everything in this directory *before* only/q/limit - the "812 entries" line. */
  readonly rollup: PathRollup;
  /**
   * The selectors actually applied. A big level defaults to `['problems']`, so the UI
   * knows the rows are a deliberate subset rather than everything there is.
   */
  readonly selection: readonly PathSelector[];
  /** How many entries matched only+q, before limit. */
  readonly matched: number;
  readonly offset: number;
  readonly limit: number;
  /** matched > offset + nodes.length. */
  readonly truncated: boolean;
  /** False when this level was served without a readdir per child. */
  readonly childCountsResolved: boolean;
  /** Per level, so one unreadable folder is not a failed request. */
  readonly error: string | null;
}

export interface PathMatrixColumn {
  readonly instanceId: number;
  readonly name: string;
  readonly kind: 'radarr' | 'sonarr';
  /**
   * False when the instance did not answer.
   *
   * Load-bearing: an unreachable instance is absent from every row's `owners`, so without
   * this the view could not tell "nobody uses this folder" from "we could not ask".
   */
  readonly reachable: boolean;
  readonly error: string | null;
  readonly fetchedAt: string | null;
  readonly rootFolderCount: number;
  readonly mediaPathCount: number;
  /** Its root folders this container cannot see - the mismatch diagnosis, per column. */
  readonly unseenRootFolders: readonly string[];
}

/**
 * Fleet counters.
 *
 * `rootFolderPaths`, `unseenRootFolders` and `unmanaged` are exact: they come from the
 * *Arr index and need no disk access. `untracked` and `missing` describe the
 * levels in *this* response, because counting them fleet-wide would mean walking every
 * library - the one thing this design exists to avoid. The overview always reads the
 * whole spine, so on a first load they cover every mount and root folder.
 */
export interface PathMatrixTotals {
  readonly rootFolderPaths: number;
  readonly unseenRootFolders: number;
  /** Media paths that sit under none of their own instance's root folders. Exact. */
  readonly unmanaged: number;
  /** Directories inside a root folder that no instance tracks - the old orphan count. */
  readonly untracked: number;
  /** *Arr paths that are not on disk. */
  readonly missing: number;
}

export interface PathMatrixResponse {
  /** False when FS_ROOTS is unset: the whole filesystem feature is off. */
  readonly enabled: boolean;
  readonly scannedAt: string;
  /** Saves a second request; also feeds the disabled-state panel and move datalists. */
  readonly roots: readonly FsRoot[];
  readonly columns: readonly PathMatrixColumn[];
  readonly levels: readonly PathMatrixLevel[];
  readonly totals: PathMatrixTotals;
  /** Instances none of whose paths exist here. Now also rendered inline as rows. */
  readonly mismatches: readonly MappingMismatch[];
}
