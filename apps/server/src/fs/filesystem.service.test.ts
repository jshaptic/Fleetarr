import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FsError } from '../lib/errors.js';
import { FilesystemService } from './filesystem.service.js';
import { PathGuard } from './paths.js';

async function makeService(roots: string[], references: readonly number[] = []): Promise<FilesystemService> {
  const guard = await PathGuard.create(roots);
  const service = new FilesystemService(guard);
  service.setReferenceLookup(async () => ({ instanceIds: references, complete: true }));
  return service;
}

function seed(root: string): void {
  mkdirSync(path.join(root, 'movies', 'Arrival (2016)'), { recursive: true });
  writeFileSync(path.join(root, 'movies', 'Arrival (2016)', 'movie.mkv'), 'x'.repeat(2048));
  mkdirSync(path.join(root, 'movies', 'Empty Folder'), { recursive: true });
  mkdirSync(path.join(root, 'movies-4k'), { recursive: true });
  symlinkSync(path.join(root, 'movies'), path.join(root, 'movies-link'));
}

describe('FilesystemService', () => {
  let root: string;
  let fs: FilesystemService;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'fleetarr-fs-'));
    seed(root);
    fs = await makeService([root]);
  });

  afterEach(() => {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  test('lists a directory with folders first and symlinks marked', async () => {
    const listing = await fs.list(root);
    assert.deepEqual(
      listing.entries.map((entry) => `${entry.name}:${entry.kind}`),
      ['movies:directory', 'movies-4k:directory', 'movies-link:symlink'],
    );
    assert.equal(listing.parent, null, 'a root has no navigable parent');

    const movies = await fs.list(path.join(root, 'movies'));
    assert.equal(movies.parent, root);
    assert.equal(movies.entries.find((entry) => entry.name === 'Arrival (2016)')?.childCount, 1);
    assert.equal(movies.entries.find((entry) => entry.name === 'Empty Folder')?.childCount, 0);
  });

  test('measures a subtree without following symlinks', async () => {
    const measured = await fs.measure(path.join(root, 'movies'));
    assert.equal(measured.fileCount, 1);
    assert.equal(measured.sizeOnDisk, 2048);
    assert.equal(measured.truncated, false);

    // Following movies-link would double-count the whole library.
    const viaLink = await fs.measure(root);
    assert.equal(viaLink.fileCount, 1);
  });

  test('walks directories for names alone, never through a symlink', async () => {
    const walk = await fs.walkDirectories(root);

    assert.deepEqual(walk.directories, [
      path.join(root, 'movies'),
      path.join(root, 'movies-4k'),
      path.join(root, 'movies', 'Arrival (2016)'),
      path.join(root, 'movies', 'Empty Folder'),
    ]);
    // `movies-link` points at `movies`; following it would list the same tree twice and,
    // worse, could lead outside the roots.
    assert.equal(walk.truncated, false);
  });

  /**
   * The rule the picker inherits from the matrix view: below a root folder lies the
   * library, which is thousands of media folders and never a destination.
   */
  test('lists a directory it is told to stop at, without descending into it', async () => {
    const movies = path.join(root, 'movies');
    const walk = await fs.walkDirectories(root, { stopAt: (directory) => directory === movies });

    assert.ok(walk.directories.includes(movies), 'the leaf itself is still offerable');
    assert.ok(!walk.directories.some((entry) => entry.startsWith(`${movies}${path.sep}`)));
  });

  test('reports a truncated directory walk rather than a short list that looks whole', async () => {
    const walk = await fs.walkDirectories(root, { maxEntries: 2 });

    assert.equal(walk.directories.length, 2);
    assert.equal(walk.truncated, true);
  });

  test('refuses to walk outside the configured roots', async () => {
    await assert.rejects(() => fs.walkDirectories(path.join(tmpdir(), 'somewhere-else')), FsError);
  });

  test('reports a truncated walk instead of pretending to be complete', async () => {
    const measured = await fs.measure(root, { maxEntries: 1 });
    assert.equal(measured.truncated, true);
  });

  // ------------------------------------------------------------------ mkdir

  test('mkdir refuses an existing destination and creates a new one', async () => {
    const existing = await fs.preflight('fs.mkdir', { path: path.join(root, 'movies'), recursive: false });
    assert.equal(existing.ok, false);
    assert.equal(existing.checks.find((check) => check.id === 'destination_free')?.status, 'blocker');

    const target = path.join(root, 'movies', 'New Film (2026)');
    const preflight = await fs.preflight('fs.mkdir', { path: target, recursive: false });
    assert.equal(preflight.ok, true);

    await fs.mkdirp({ path: target, recursive: false });
    assert.equal(statSync(target).isDirectory(), true);
  });

  test('mkdir needs recursive when the parent is missing', async () => {
    const payload = { path: path.join(root, 'deep', 'nested', 'folder'), recursive: false };
    assert.equal((await fs.preflight('fs.mkdir', payload)).ok, false);
    await assert.rejects(() => fs.mkdirp(payload), (error: unknown) => {
      assert.ok(error instanceof FsError);
      assert.equal(error.code, 'fs_not_found');
      return true;
    });

    await fs.mkdirp({ ...payload, recursive: true });
    assert.equal(statSync(payload.path).isDirectory(), true);
  });

  // ----------------------------------------------------------------- rename

  test('renames a folder in place', async () => {
    const from = path.join(root, 'movies', 'Arrival (2016)');
    const to = path.join(root, 'movies', 'Arrival (2016) [remux]');

    const preflight = await fs.preflight('fs.rename', { from, to });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.checks.find((check) => check.id === 'same_device')?.status, 'ok');

    await fs.relocate('fs.rename', { from, to });
    assert.equal(statSync(to).isDirectory(), true);
  });

  test('rename refuses to change directories - that is a move', async () => {
    const result = await fs.preflight('fs.rename', {
      from: path.join(root, 'movies', 'Arrival (2016)'),
      to: path.join(root, 'movies-4k', 'Arrival (2016)'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.id === 'same_parent')?.status, 'blocker');
  });

  test('refuses an occupied destination, a missing source and a symlink', async () => {
    const occupied = await fs.preflight('fs.rename', {
      from: path.join(root, 'movies', 'Arrival (2016)'),
      to: path.join(root, 'movies', 'Empty Folder'),
    });
    assert.equal(occupied.checks.find((check) => check.id === 'destination_free')?.status, 'blocker');

    const missing = await fs.preflight('fs.rename', {
      from: path.join(root, 'movies', 'Ghost'),
      to: path.join(root, 'movies', 'Ghost 2'),
    });
    assert.equal(missing.checks.find((check) => check.id === 'source_exists')?.status, 'blocker');

    const link = await fs.preflight('fs.move', {
      from: path.join(root, 'movies-link'),
      to: path.join(root, 'movies-4k', 'link'),
    });
    assert.equal(link.checks.find((check) => check.id === 'not_symlink')?.status, 'blocker');
  });

  test('moves between directories on the same filesystem', async () => {
    const from = path.join(root, 'movies', 'Arrival (2016)');
    const to = path.join(root, 'movies-4k', 'Arrival (2016)');

    await fs.relocate('fs.move', { from, to });
    assert.equal(statSync(to).isDirectory(), true);
    assert.throws(() => statSync(from));
  });

  test('refuses a move across filesystems rather than copying', async (t) => {
    // /dev/shm is a separate tmpfs on Linux; skip where that is not true.
    let otherRoot: string;
    try {
      otherRoot = mkdtempSync(path.join('/dev/shm', 'fleetarr-other-'));
    } catch {
      t.skip('no second filesystem available');
      return;
    }

    try {
      if (statSync(otherRoot).dev === statSync(root).dev) {
        t.skip('/dev/shm is on the same device as the temp dir');
        return;
      }

      const crossDevice = await makeService([root, otherRoot]);
      const result = await crossDevice.preflight('fs.move', {
        from: path.join(root, 'movies', 'Arrival (2016)'),
        to: path.join(otherRoot, 'Arrival (2016)'),
      });

      assert.equal(result.ok, false);
      const check = result.checks.find((entry) => entry.id === 'same_device');
      assert.equal(check?.status, 'blocker');
      assert.match(check?.message ?? '', /different filesystems/);
      assert.match(check?.message ?? '', /2\.0 KB/);

      await assert.rejects(
        () =>
          crossDevice.relocate('fs.move', {
            from: path.join(root, 'movies', 'Arrival (2016)'),
            to: path.join(otherRoot, 'Arrival (2016)'),
          }),
        (error: unknown) => {
          assert.ok(error instanceof FsError);
          assert.equal(error.code, 'fs_cross_device');
          return true;
        },
      );
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  // ----------------------------------------------------------------- delete

  test('deletes an empty folder with rmdir, not a recursive rm', async () => {
    const target = path.join(root, 'movies', 'Empty Folder');
    const preflight = await fs.preflight('fs.delete', { path: target, recursive: false, force: false });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.checks.find((check) => check.id === 'empty')?.status, 'ok');

    await fs.remove({ path: target, recursive: false, force: false });
    assert.throws(() => statSync(target));
  });

  test('refuses a non-empty delete unless recursive, and reports what it would remove', async () => {
    const target = path.join(root, 'movies', 'Arrival (2016)');

    const refused = await fs.preflight('fs.delete', { path: target, recursive: false, force: false });
    assert.equal(refused.ok, false);
    assert.equal(refused.checks.find((check) => check.id === 'recursive_required')?.status, 'blocker');
    await assert.rejects(
      () => fs.remove({ path: target, recursive: false, force: false }),
      (error: unknown) => {
        assert.ok(error instanceof FsError);
        assert.equal(error.code, 'fs_not_empty');
        return true;
      },
    );

    const allowed = await fs.preflight('fs.delete', { path: target, recursive: true, force: false });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.measurement?.fileCount, 1);
    assert.equal(allowed.measurement?.sizeOnDisk, 2048);

    const result = await fs.remove({ path: target, recursive: true, force: false });
    assert.equal(result.freedBytes, 2048);
    assert.throws(() => statSync(target));
  });

  test('warns, but does not refuse, when a relocation moves a folder an instance points at', async () => {
    const tracked = await makeService([root], [7]);

    const preflight = await tracked.preflight('fs.rename', {
      from: path.join(root, 'movies'),
      to: path.join(root, 'films'),
    });

    // Reconcile & Align relocates tracked folders on purpose - this must never block.
    assert.equal(preflight.ok, true);
    assert.deepEqual(preflight.referencedBy, [7]);
    const check = preflight.checks.find((entry) => entry.id === 'referenced_by_arr');
    assert.equal(check?.status, 'warning');
    assert.match(check?.message ?? '', /1 connected instance/);
  });

  test('says so plainly when no instance points at a folder being relocated', async () => {
    const preflight = await fs.preflight('fs.rename', {
      from: path.join(root, 'movies'),
      to: path.join(root, 'films'),
    });

    const check = preflight.checks.find((entry) => entry.id === 'referenced_by_arr');
    assert.equal(check?.status, 'ok');
    assert.deepEqual(preflight.referencedBy, []);
  });

  test('refuses a delete it cannot check, rather than assuming nothing owns the folder', async () => {
    const guard = await PathGuard.create([root]);
    const blind = new FilesystemService(guard);
    // An instance exists but nothing about it is cached: "unknown" is not "cleared".
    blind.setReferenceLookup(async () => ({ instanceIds: [], complete: false }));

    const refused = await blind.preflight('fs.delete', {
      path: path.join(root, 'movies', 'Arrival (2016)'),
      recursive: true,
      force: false,
    });

    assert.equal(refused.ok, false);
    const check = refused.checks.find((entry) => entry.id === 'referenced_by_arr');
    assert.equal(check?.status, 'blocker');
    assert.match(check?.message ?? '', /cannot tell/);

    const forced = await blind.preflight('fs.delete', {
      path: path.join(root, 'movies', 'Arrival (2016)'),
      recursive: true,
      force: true,
    });
    assert.equal(forced.ok, true, 'force is the deliberate override');
  });

  test('refuses to delete a folder an instance still references, unless forced', async () => {
    const guarded = await makeService([root], [7]);
    const target = path.join(root, 'movies', 'Arrival (2016)');

    const refused = await guarded.preflight('fs.delete', { path: target, recursive: true, force: false });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.referencedBy, [7]);
    await assert.rejects(
      () => guarded.remove({ path: target, recursive: true, force: false }),
      (error: unknown) => {
        assert.ok(error instanceof FsError);
        assert.equal(error.code, 'fs_referenced_by_arr');
        return true;
      },
    );

    const forced = await guarded.preflight('fs.delete', { path: target, recursive: true, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.checks.find((check) => check.id === 'referenced_by_arr')?.status, 'warning');
  });

  test('refuses to delete a configured root', async () => {
    await assert.rejects(
      () => fs.preflight('fs.delete', { path: root, recursive: true, force: true }),
      /configured storage root/,
    );
  });

  test('reports missing write permission on the parent', async () => {
    const parent = path.join(root, 'movies');
    chmodSync(parent, 0o500);
    try {
      const result = await fs.preflight('fs.delete', {
        path: path.join(parent, 'Empty Folder'),
        recursive: false,
        force: false,
      });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((check) => check.id === 'parent_writable')?.status, 'blocker');
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  test('re-runs preflight at execution time, so a stale staged operation fails safely', async () => {
    const from = path.join(root, 'movies', 'Arrival (2016)');
    const to = path.join(root, 'movies', 'Arrival (2016) [remux]');

    // Reviewed while it existed…
    assert.equal((await fs.preflight('fs.rename', { from, to })).ok, true);
    // …renamed by someone else in the meantime.
    rmSync(from, { recursive: true, force: true });

    await assert.rejects(() => fs.relocate('fs.rename', { from, to }), (error: unknown) => {
      assert.ok(error instanceof FsError);
      assert.equal(error.code, 'fs_not_found');
      return true;
    });
  });

  test('traces every mutation for the audit trail', async () => {
    const traces: string[] = [];
    const traced = (await makeService([root])).withTraceSink((trace) =>
      traces.push(`${trace.op} ${path.basename(trace.path)} ${trace.error === null ? 'ok' : 'error'}`),
    );

    await traced.mkdirp({ path: path.join(root, 'movies', 'Traced'), recursive: false });
    await traced.relocate('fs.rename', {
      from: path.join(root, 'movies', 'Traced'),
      to: path.join(root, 'movies', 'Traced 2'),
    });

    assert.deepEqual(traces, ['mkdir Traced ok', 'rename Traced ok']);
  });
});
