import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  FsAssumeResolved,
  FsCheck,
  FsEntry,
  FsListResponse,
  FsMeasurement,
  FsOp,
  FsPathReference,
  FsPreflight,
  FsRoot,
  FsRootsResponse,
  QueuePayloadFor,
} from '@fleetarr/shared';
import { FsError } from '../lib/errors.js';
import type { PathReferences } from '../services/path-index.service.js';
import {
  ACCESS_READ,
  ACCESS_WRITE,
  canAccess,
  describePath,
  freeSpaceAt,
  isMountPoint,
  PathGuard,
  type PathStats,
} from './paths.js';

/** One completed filesystem action, recorded in queue_events like an HTTP exchange. */
export interface FsTrace {
  readonly op: string;
  readonly path: string;
  readonly detail: string | null;
  readonly durationMs: number;
  readonly error: string | null;
}

export type FsTraceSink = (trace: FsTrace) => void;

/** Instances whose database references a path - injected to avoid a circular dependency. */
export type PathReferenceLookup = (
  target: string,
  options?: { allowFetch?: boolean },
) => Promise<PathReferences>;

export interface MeasureOptions {
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
}

export interface WalkDirectoriesOptions {
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
  /**
   * A directory to list but not descend into. Injected rather than known here: what counts
   * as a leaf is an *Arr question (a root folder), and this layer only reads the disk.
   */
  readonly stopAt?: (directory: string) => boolean;
}

export interface DirectoryWalk {
  readonly directories: readonly string[];
  readonly truncated: boolean;
}

const DEFAULT_MAX_ENTRIES = 50_000;
/**
 * The directory-walk cap. Two orders below `DEFAULT_MAX_ENTRIES` because this list is sent
 * to a browser and filtered in it: past a few thousand folders the picker, not the walk, is
 * what gives out. Hitting it is reported, never silently trimmed.
 */
const DEFAULT_MAX_DIRECTORIES = 20_000;
/** Reads issued at once while walking. Enough to hide latency, few enough to hold handles. */
const READ_CONCURRENCY = 32;
const LOW_SPACE_BYTES = 1024 * 1024 * 1024; // 1 GiB

function ok(id: string, message: string): FsCheck {
  return { id, status: 'ok', message };
}

function warning(id: string, message: string): FsCheck {
  return { id, status: 'warning', message };
}

function blocker(id: string, message: string): FsCheck {
  return { id, status: 'blocker', message };
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

/**
 * Directory operations on mounted storage.
 *
 * Every method resolves its arguments through PathGuard first, and every mutation runs its
 * own preflight and refuses on any blocker - including when called from the queue executor,
 * because the disk can change between staging and Apply All.
 */
export class FilesystemService {
  private references: PathReferenceLookup = async () => ({
    instances: [],
    instanceIds: [],
    complete: true,
  });
  private readonly measurements = new Map<string, { at: number; value: FsMeasurement }>();

  constructor(
    readonly guard: PathGuard,
    private readonly onTrace: FsTraceSink = () => {},
  ) {}

  /** Wired after construction so the guards can ask what *Arr still points at. */
  setReferenceLookup(lookup: PathReferenceLookup): void {
    this.references = lookup;
  }

  /**
   * A view of this service that reports into one queue item's audit trail. Shares the
   * guard, the reference lookup and the measurement cache - only the sink differs.
   */
  withTraceSink(sink: FsTraceSink): FilesystemService {
    const scoped = new FilesystemService(this.guard, sink);
    scoped.setReferenceLookup(this.references);
    return scoped;
  }

  get enabled(): boolean {
    return this.guard.enabled;
  }

  get rootPaths(): string[] {
    return this.guard.roots.filter((root) => root.exists).map((root) => root.real);
  }

  roots(): FsRootsResponse {
    return {
      enabled: this.guard.enabled,
      roots: this.guard.roots.map(
        (root): FsRoot => ({
          path: root.real,
          exists: root.exists,
          readable: root.readable,
          writable: root.writable,
          deviceId: root.deviceId,
          freeSpace: root.freeSpace,
          totalSpace: root.totalSpace,
          error: root.error,
        }),
      ),
    };
  }

  // ----------------------------------------------------------------- reading

  /** One directory. Lazy by design: a media library is far too large to walk eagerly. */
  async list(input: string): Promise<FsListResponse> {
    const target = await this.guard.resolve(input);
    const stats = await describePath(target);

    if (!stats.exists) {
      throw new FsError({ code: 'fs_not_found', message: `${target} does not exist`, path: target, httpStatus: 404 });
    }
    if (stats.isSymlink) {
      throw new FsError({
        code: 'fs_is_symlink',
        message: `${target} is a symlink - Fleetarr does not follow links; browse the target path directly`,
        path: target,
      });
    }
    if (!stats.isDirectory) {
      throw new FsError({ code: 'fs_not_a_directory', message: `${target} is not a directory`, path: target });
    }

    const dirents = await readdir(target, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (dirent): Promise<FsEntry> => {
        const child = path.join(target, dirent.name);
        const kind = dirent.isSymbolicLink()
          ? 'symlink'
          : dirent.isDirectory()
            ? 'directory'
            : dirent.isFile()
              ? 'file'
              : 'other';

        const [childStats, readable, writable, childCount] = await Promise.all([
          describePath(child),
          canAccess(child, ACCESS_READ),
          canAccess(child, ACCESS_WRITE),
          kind === 'directory' ? this.countChildren(child) : Promise.resolve(null),
        ]);

        return {
          path: child,
          name: dirent.name,
          kind,
          modifiedAt: childStats.modifiedAt,
          childCount,
          sizeOnDisk: kind === 'file' ? childStats.size : null,
          fileCount: null,
          readable,
          writable,
        };
      }),
    );

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    });

    const parent = this.guard.isRoot(target) ? null : path.dirname(target);
    return { path: target, parent: parent !== null && this.guard.rootFor(parent) ? parent : null, entries };
  }

  private async countChildren(target: string): Promise<number | null> {
    try {
      return (await readdir(target)).length;
    } catch {
      return null;
    }
  }

  /**
   * Recursive size. Opt-in per folder and capped: this is the one operation that can take
   * minutes on a real array, so it never runs implicitly.
   */
  async measure(input: string, options: MeasureOptions = {}): Promise<FsMeasurement> {
    const target = await this.guard.resolve(input);
    const cached = this.measurements.get(target);
    if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.value;

    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    let sizeOnDisk = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let visited = 0;
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      if (truncated) return;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable subtree: reported as a lower bound
      }

      for (const dirent of dirents) {
        options.signal?.throwIfAborted();
        if (visited >= maxEntries) {
          truncated = true;
          return;
        }
        visited += 1;

        const child = path.join(dir, dirent.name);
        if (dirent.isSymbolicLink()) continue; // never follow links while measuring
        if (dirent.isDirectory()) {
          directoryCount += 1;
          await walk(child);
        } else if (dirent.isFile()) {
          fileCount += 1;
          try {
            sizeOnDisk += (await stat(child)).size;
          } catch {
            // vanished mid-walk
          }
        }
      }
    };

    await walk(target);
    const value: FsMeasurement = { path: target, sizeOnDisk, fileCount, directoryCount, truncated };
    this.measurements.set(target, { at: Date.now(), value });
    return value;
  }

  /**
   * Every directory under a target, as a flat sorted list.
   *
   * The cheap half of {@link measure}: names only, no `stat`, no size, no per-entry access
   * check - a picker needs to know that a folder exists, and the preflight is what judges
   * the one that gets chosen. That is what makes walking a whole tree affordable here when
   * measuring one is "the one operation that can take minutes".
   *
   * A symlink is never followed. `measure` skips one to avoid counting a subtree twice;
   * here the reason is the storage contract - a link can point outside the roots, and this
   * list is fed straight back as a destination.
   */
  async walkDirectories(input: string, options: WalkDirectoriesOptions = {}): Promise<DirectoryWalk> {
    const target = await this.guard.resolve(input);
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_DIRECTORIES;
    const stopAt = options.stopAt ?? (() => false);

    const directories: string[] = [];
    let truncated = false;

    /**
     * Breadth-first, a level at a time, with the reads of one level issued together.
     *
     * The shape of the tree is what makes this worth doing: a media library is wide and
     * shallow, and every `readdir` is latency rather than work - on a network share or a
     * spun-down array, ~8ms each. Sequentially that is seconds of a dialog saying "reading
     * folders"; a level at a time it is one round trip per depth. Bounded, because a wide
     * level would otherwise open thousands of handles at once.
     */
    let frontier: string[] = [target];
    while (frontier.length > 0 && !truncated) {
      const next: string[] = [];

      for (let at = 0; at < frontier.length; at += READ_CONCURRENCY) {
        options.signal?.throwIfAborted();
        const batch = frontier.slice(at, at + READ_CONCURRENCY);
        const listings = await Promise.all(
          batch.map(async (dir) => {
            if (stopAt(dir)) return [];
            try {
              return await readdir(dir, { withFileTypes: true });
            } catch {
              return []; // unreadable subtree: absent from the list rather than fatal
            }
          }),
        );

        // Collected in the order they were requested, so the same tree always yields the
        // same list - and the same one is cut, when the cap cuts it.
        for (const [index, dirents] of listings.entries()) {
          for (const dirent of dirents) {
            if (!dirent.isDirectory()) continue; // a symlink is not a directory to this check
            if (directories.length >= maxEntries) {
              truncated = true;
              break;
            }

            const child = path.join(batch[index] as string, dirent.name);
            directories.push(child);
            next.push(child);
          }
          if (truncated) break;
        }
        if (truncated) break;
      }

      frontier = next;
    }

    return { directories: directories.sort((a, b) => a.localeCompare(b)), truncated };
  }

  /**
   * A measurement taken earlier, or null. The matrix reads sizes through this so a row
   * can show one without ever starting a walk of its own.
   */
  cachedMeasurement(target: string): FsMeasurement | null {
    const cached = this.measurements.get(target);
    return cached !== undefined && Date.now() - cached.at < 60_000 ? cached.value : null;
  }

  invalidateMeasurements(): void {
    this.measurements.clear();
  }

  // --------------------------------------------------------------- preflight

  /**
   * What would happen if this ran. Returned to the UI before staging, and re-run by the
   * executor immediately before the operation.
   */
  async preflight<K extends FsOp>(
    op: K,
    payload: QueuePayloadFor<K>,
    assumeResolved: FsAssumeResolved = {},
  ): Promise<FsPreflight> {
    switch (op) {
      case 'fs.mkdir':
        return this.preflightMkdir(payload as QueuePayloadFor<'fs.mkdir'>);
      case 'fs.rename':
        return this.preflightRelocation('fs.rename', payload as QueuePayloadFor<'fs.rename'>);
      case 'fs.move':
        return this.preflightRelocation('fs.move', payload as QueuePayloadFor<'fs.move'>);
      case 'fs.delete':
        return this.preflightDelete(payload as QueuePayloadFor<'fs.delete'>, assumeResolved);
      default:
        throw new FsError({ code: 'fs_unsupported_op', message: `Unknown filesystem operation ${op}` });
    }
  }

  private finish(
    op: FsOp,
    checks: FsCheck[],
    extra: {
      measurement?: FsMeasurement | null;
      freeSpace?: number | null;
      references?: readonly FsPathReference[];
    } = {},
  ): FsPreflight {
    const references = extra.references ?? [];
    return {
      op,
      ok: !checks.some((check) => check.status === 'blocker'),
      checks,
      measurement: extra.measurement ?? null,
      freeSpace: extra.freeSpace ?? null,
      referencedBy: references.map((reference) => reference.instanceId),
      references,
    };
  }

  private async preflightMkdir(payload: QueuePayloadFor<'fs.mkdir'>): Promise<FsPreflight> {
    const target = await this.guard.resolve(payload.path);
    const checks: FsCheck[] = [ok('inside_root', `${target} is inside an allowed storage root`)];

    const stats = await describePath(target);
    if (stats.exists) {
      checks.push(blocker('destination_free', `${target} already exists`));
    } else {
      checks.push(ok('destination_free', 'Destination does not exist yet'));
    }

    const parent = path.dirname(target);
    const parentStats = await describePath(parent);
    if (!parentStats.exists) {
      checks.push(
        payload.recursive
          ? warning('parent_exists', `${parent} does not exist and will be created`)
          : blocker('parent_exists', `${parent} does not exist - enable recursive to create it`),
      );
    } else if (!(await canAccess(parent, ACCESS_WRITE))) {
      checks.push(blocker('parent_writable', `No write permission on ${parent}`));
    } else {
      checks.push(ok('parent_writable', `${parent} is writable`));
    }

    const freeSpace = await freeSpaceAt(parentStats.exists ? parent : (this.rootPaths[0] ?? '/'));
    if (freeSpace !== null && freeSpace < LOW_SPACE_BYTES) {
      checks.push(warning('free_space', `Only ${formatBytes(freeSpace)} free on that filesystem`));
    }

    return this.finish('fs.mkdir', checks, { freeSpace });
  }

  private async preflightRelocation(
    op: 'fs.rename' | 'fs.move',
    payload: { from: string; to: string },
  ): Promise<FsPreflight> {
    const from = await this.guard.resolve(payload.from);
    const to = await this.guard.resolve(payload.to);
    const checks: FsCheck[] = [ok('inside_root', 'Both paths are inside allowed storage roots')];

    this.guard.assertMutable(from);

    const fromStats = await describePath(from);
    checks.push(...this.sourceChecks(from, fromStats));
    if (await isMountPoint(from)) {
      checks.push(blocker('not_mount_point', `${from} is a mount point, not a folder on it`));
    }

    const toStats = await describePath(to);
    if (toStats.exists) {
      checks.push(blocker('destination_free', `${to} already exists`));
    } else {
      checks.push(ok('destination_free', 'Destination does not exist yet'));
    }

    const toParent = path.dirname(to);
    const fromParent = path.dirname(from);

    if (op === 'fs.rename' && toParent !== fromParent) {
      checks.push(
        blocker('same_parent', 'A rename keeps the folder in place - use move to change directories'),
      );
    }
    if (op === 'fs.move' && toParent === fromParent) {
      checks.push(warning('same_parent', 'Source and destination share a parent - this is a rename'));
    }

    const toParentStats = await describePath(toParent);
    if (!toParentStats.exists) {
      checks.push(blocker('destination_parent', `${toParent} does not exist`));
    } else if (!(await canAccess(toParent, ACCESS_WRITE))) {
      checks.push(blocker('destination_writable', `No write permission on ${toParent}`));
    } else {
      checks.push(ok('destination_writable', `${toParent} is writable`));
    }

    // A rename cannot cross filesystems, and Fleetarr will not silently copy terabytes.
    if (fromStats.exists && toParentStats.exists && fromStats.deviceId !== toParentStats.deviceId) {
      const measurement = await this.measure(from).catch(() => null);
      const size = measurement === null ? 'the folder' : formatBytes(measurement.sizeOnDisk);
      checks.push(
        blocker(
          'same_device',
          `${from} and ${toParent} are on different filesystems (${String(fromStats.deviceId)} -> ${String(toParentStats.deviceId)}). ${size} would have to be copied - move it with your own tool, then use Reconcile & Align.`,
        ),
      );
    } else if (fromStats.exists) {
      checks.push(ok('same_device', 'Same filesystem - the move is an atomic rename'));
    }

    if (!(await canAccess(fromParent, ACCESS_WRITE))) {
      checks.push(blocker('source_parent_writable', `No write permission on ${fromParent}`));
    }

    // A warning, never a blocker: relocating a tracked folder is exactly what
    // Reconcile & Align does on purpose. But moving one *without* realigning leaves
    // those paths dangling, so the decision has to be visible before it is staged.
    // A hint, not a gate - so it never makes a staged rename depend on a live instance.
    const references = await this.references(from, { allowFetch: false });
    if (references.instanceIds.length > 0) {
      checks.push(
        warning(
          'referenced_by_arr',
          `${String(references.instanceIds.length)} connected instance(s) still point at this path - realign them afterwards, or their media will go missing`,
        ),
      );
    } else if (!references.complete) {
      checks.push(
        warning(
          'referenced_by_arr',
          'Could not check every instance for media at this path - refresh the fleet to be sure',
        ),
      );
    } else {
      checks.push(ok('referenced_by_arr', 'No connected instance points at this path'));
    }

    return this.finish(op, checks, {
      freeSpace: await freeSpaceAt(toParentStats.exists ? toParent : from),
      references: references.instances,
    });
  }

  private async preflightDelete(
    payload: QueuePayloadFor<'fs.delete'>,
    assumeResolved: FsAssumeResolved = {},
  ): Promise<FsPreflight> {
    const target = await this.guard.resolve(payload.path);
    const checks: FsCheck[] = [ok('inside_root', `${target} is inside an allowed storage root`)];

    this.guard.assertMutable(target);

    const stats = await describePath(target);
    checks.push(...this.sourceChecks(target, stats));
    if (await isMountPoint(target)) {
      checks.push(blocker('not_mount_point', `${target} is a mount point and will not be deleted`));
    }

    const parent = path.dirname(target);
    if (!(await canAccess(parent, ACCESS_WRITE))) {
      checks.push(blocker('parent_writable', `No write permission on ${parent}`));
    }

    let measurement: FsMeasurement | null = null;
    if (stats.exists && stats.isDirectory && !stats.isSymlink) {
      const children = await readdir(target).catch(() => []);
      measurement = await this.measure(target).catch(() => null);

      if (children.length > 0 && !payload.recursive) {
        checks.push(
          blocker(
            'recursive_required',
            `${target} is not empty (${String(children.length)} entries) - recursive deletion must be enabled`,
          ),
        );
      } else if (children.length === 0) {
        checks.push(ok('empty', 'Directory is empty'));
      } else if (measurement !== null) {
        checks.push(
          warning(
            'recursive_delete',
            `Deletes ${formatBytes(measurement.sizeOnDisk)} in ${String(measurement.fileCount)} file(s)${measurement.truncated ? ' (at least - the walk hit its cap)' : ''}`,
          ),
        );
      }
    }

    // A blocker: worth a read to get right.
    const references = await this.references(target, { allowFetch: true });
    checks.push(...this.referenceChecks(references, payload.force, assumeResolved));

    return this.finish('fs.delete', checks, { measurement, references: references.instances });
  }

  /**
   * The *Arr side of a delete, as three separate verdicts plus an unknown.
   *
   * One check id per reason, because the reasons are not interchangeable. A root folder
   * and an import list are registrations: staging a `rootFolder.delete` or an
   * `importList.setEnabled` clears them, which is why each can be waved through with
   * `assumeResolved` rather than only with `force`. Tracked media is not - unassigning a
   * root folder leaves every item's stored path exactly where it was - so `media_under`
   * answers to `force` alone. Collapsing them, as one `referenced_by_arr` did, meant a
   * folder with a registration and nothing in it was refused in the language of lost
   * media, and a bridgeable problem looked identical to an unbridgeable one.
   */
  private referenceChecks(
    references: PathReferences,
    force: boolean,
    assumeResolved: FsAssumeResolved,
  ): FsCheck[] {
    const checks: FsCheck[] = [];
    // `force` is the user overruling the guard; `assumeResolved` is the dialog promising
    // to stage the fix in front of the delete. Both downgrade, and both say which it was,
    // so a queue row never explains itself with the wrong reason.
    const waive = (id: string, fact: string, remedy: string, resolved: boolean): FsCheck =>
      resolved
        ? warning(id, `${fact} - cleared by a staged operation ahead of the delete`)
        : force
          ? warning(id, `${fact} - forced`)
          : blocker(id, `${fact} - ${remedy}, or force the deletion`);

    const rooted = references.instances.filter((reference) => reference.rootFolders.length > 0);
    if (rooted.length > 0) {
      const folders = rooted.reduce((sum, reference) => sum + reference.rootFolders.length, 0);
      checks.push(
        waive(
          'root_folder_under',
          `${String(folders)} root folder(s) on ${String(rooted.length)} instance(s) live at or under this path`,
          'unassign them',
          assumeResolved.rootFolders === true,
        ),
      );
    } else {
      checks.push(ok('root_folder_under', 'No instance roots at or under this path'));
    }

    const tracking = references.instances.filter((reference) => reference.mediaUnder > 0);
    if (tracking.length > 0) {
      const items = tracking.reduce((sum, reference) => sum + reference.mediaUnder, 0);
      // Deliberately no `assumeResolved` here: nothing the delete dialog can stage
      // rewrites a media item's path, so offering to "resolve" this would be a lie.
      checks.push(
        force
          ? warning(
              'media_under',
              `${String(tracking.length)} instance(s) still track ${String(items)} media item(s) at or under this path - forced`,
            )
          : blocker(
              'media_under',
              `${String(tracking.length)} instance(s) still track ${String(items)} media item(s) at or under this path - move or remove them there first, or force the deletion`,
            ),
      );
    } else {
      checks.push(ok('media_under', 'No instance tracks media at or under this path'));
    }

    checks.push(this.importListCheck(references, assumeResolved, waive));

    if (!references.complete) {
      // Fail safe: an unchecked instance is not a cleared one. No `assumeResolved` - a
      // promise to clear what you could not see is worth nothing.
      checks.push(
        force
          ? warning('references_unknown', 'Could not check every instance for this path - forced')
          : blocker(
              'references_unknown',
              'Fleetarr has no complete view of the fleet, so it cannot tell whether an instance still claims this path - refresh the fleet first, or force the deletion',
            ),
      );
    } else {
      checks.push(ok('references_unknown', 'Every enabled instance answered'));
    }

    return checks;
  }

  /**
   * An import list is graded by what it does unattended, not by its mere existence.
   *
   * A list that adds automatically is the one that recreates the folder on its next sync,
   * so it refuses. An enabled manual list only offers the path - worth saying, not worth
   * refusing over. A disabled list changes nothing on its own and is not a finding at all.
   */
  private importListCheck(
    references: PathReferences,
    assumeResolved: FsAssumeResolved,
    waive: (id: string, fact: string, remedy: string, resolved: boolean) => FsCheck,
  ): FsCheck {
    const lists = references.instances.flatMap((reference) => reference.importLists);
    const enabled = lists.filter((list) => list.enabled);
    const automatic = enabled.filter((list) => list.automatic);

    // The bridge disables every enabled list, not only the automatic ones, so it clears
    // the warning below along with the blocker above - one checkbox, one verdict.
    if (assumeResolved.importLists === true && enabled.length > 0) {
      return warning(
        'import_list_under',
        `${String(enabled.length)} enabled import list(s) target this path - cleared by a staged operation ahead of the delete`,
      );
    }
    if (automatic.length > 0) {
      return waive(
        'import_list_under',
        `${String(automatic.length)} enabled import list(s) add here automatically and will recreate this folder`,
        'disable them',
        false,
      );
    }
    if (enabled.length > 0) {
      return warning(
        'import_list_under',
        `${String(enabled.length)} enabled import list(s) target this path - nothing refills it unattended, but the list is left aimed at a folder that is gone`,
      );
    }
    if (lists.length > 0) {
      return ok(
        'import_list_under',
        `${String(lists.length)} import list(s) target this path, all disabled`,
      );
    }
    return ok('import_list_under', 'No import list adds media at or under this path');
  }

  private sourceChecks(target: string, stats: PathStats): FsCheck[] {
    if (!stats.exists) {
      return [blocker('source_exists', `${target} does not exist`)];
    }
    if (stats.isSymlink) {
      return [blocker('not_symlink', `${target} is a symlink - Fleetarr does not follow or mutate links`)];
    }
    if (!stats.isDirectory) {
      return [blocker('is_directory', `${target} is not a directory - only folders can be staged`)];
    }
    return [ok('source_exists', `${target} exists and is a directory`)];
  }

  // --------------------------------------------------------------- mutations

  private assertPreflightPassed(preflight: FsPreflight): void {
    const first = preflight.checks.find((check) => check.status === 'blocker');
    if (first === undefined) return;

    throw new FsError({
      code: first.id === 'same_device' ? 'fs_cross_device' : blockerCode(first.id),
      message: first.message,
      details: { checks: preflight.checks.filter((check) => check.status !== 'ok') },
    });
  }

  private async traced<T>(op: string, target: string, detail: string | null, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await run();
      this.onTrace({ op, path: target, detail, durationMs: Math.round(performance.now() - startedAt), error: null });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onTrace({ op, path: target, detail, durationMs: Math.round(performance.now() - startedAt), error: message });
      throw error;
    }
  }

  async mkdirp(payload: QueuePayloadFor<'fs.mkdir'>): Promise<{ path: string }> {
    const preflight = await this.preflight('fs.mkdir', payload);
    this.assertPreflightPassed(preflight);

    const target = await this.guard.resolve(payload.path);
    await this.traced('mkdir', target, payload.recursive ? 'recursive' : null, async () => {
      await mkdir(target, { recursive: payload.recursive });
    });

    this.invalidateMeasurements();
    return { path: target };
  }

  async relocate(
    op: 'fs.rename' | 'fs.move',
    payload: { from: string; to: string },
  ): Promise<{ from: string; to: string }> {
    const preflight = await this.preflight(op, payload);
    this.assertPreflightPassed(preflight);

    const from = await this.guard.resolve(payload.from);
    const to = await this.guard.resolve(payload.to);

    await this.traced(op === 'fs.rename' ? 'rename' : 'move', from, `-> ${to}`, async () => {
      await rename(from, to);
    });

    this.invalidateMeasurements();
    return { from, to };
  }

  async remove(payload: QueuePayloadFor<'fs.delete'>): Promise<{
    path: string;
    freedBytes: number;
    fileCount: number;
  }> {
    const preflight = await this.preflight('fs.delete', payload);
    this.assertPreflightPassed(preflight);

    const target = await this.guard.resolve(payload.path);
    const measurement = preflight.measurement;

    await this.traced('delete', target, payload.recursive ? 'recursive' : 'empty only', async () => {
      if (payload.recursive) {
        await rm(target, { recursive: true, force: false });
      } else {
        // rmdir refuses a non-empty directory itself: if the preflight raced with a write,
        // the kernel still stops us from deleting anything unexpected.
        await rmdir(target);
      }
    });

    this.invalidateMeasurements();
    return {
      path: target,
      freedBytes: measurement?.sizeOnDisk ?? 0,
      fileCount: measurement?.fileCount ?? 0,
    };
  }
}

/** Maps a failed check to the error code the UI switches on. */
function blockerCode(checkId: string): string {
  switch (checkId) {
    case 'source_exists':
    case 'parent_exists':
    case 'destination_parent':
      return 'fs_not_found';
    case 'destination_free':
      return 'fs_exists';
    case 'recursive_required':
      return 'fs_not_empty';
    // One code for all four: the split exists so the *message* names the reason, but the
    // HTTP contract stays as it was - nothing in the web app branches on this code.
    case 'referenced_by_arr':
    case 'root_folder_under':
    case 'media_under':
    case 'import_list_under':
    case 'references_unknown':
      return 'fs_referenced_by_arr';
    case 'not_symlink':
      return 'fs_is_symlink';
    case 'not_mount_point':
      return 'fs_is_mount_point';
    case 'parent_writable':
    case 'destination_writable':
    case 'source_parent_writable':
      return 'fs_permission_denied';
    case 'is_directory':
      return 'fs_not_a_directory';
    case 'same_parent':
      return 'fs_precondition_failed';
    default:
      return 'fs_precondition_failed';
  }
}
