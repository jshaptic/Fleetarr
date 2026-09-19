# AGENTS.md

Keep this file under 200 lines. Tighten existing rules rather than adding sections.

## Critical rules

- **NEVER mutate an \*Arr instance outside the queue.** Stage every change as an op, run only
  from Apply All. No direct writes from a route handler or a store.
- **NEVER render an unreachable instance as a gap.** Unknown is not "missing": batch actions
  skip it, deletes need `force`, and the count is stated.
- **NEVER translate paths.** Fleetarr and the *Arr apps see identical container paths;
  comparison is literal. A mismatch is reported, never bridged.
- **ALWAYS `PUT` a merged resource** (`mergeForPut`) - a partial body wipes what it omits.
- **ALWAYS reuse `components/base`**; invent one only when nothing there fits.
- **NEVER draw an instance's initials or app colour by hand.** `BaseInstanceBadge` is the only
  one; its test fails the build if `initialsOf` or the palette is named elsewhere.
- **NEVER import an icon library outside `components/base/icons/glyphs.ts`, and NEVER add a
  `<style>` block.** Ask for a meaning (`IconWarning`) and a weight; utility classes only.
  `icons.test.ts` pins both.
- **NEVER hand-roll a checkbox.** `BaseCheckbox` keeps a real `<input type="checkbox">`.
- **NEVER hand-roll a severity line.** `BaseNotice` is the only one: a tone picks colour and
  glyph, and its slot is one element - a flex row splits a sentence into anonymous runs.
- **NEVER hand-roll a picker, `<datalist>` or `<select>`.** `BaseSelect` is the only one:
  `editable` means what you type is the value (a path); the default means only an option is.
- **ALWAYS run `npm run typecheck` and `npm test`** before calling work done.

## Project context

TypeScript monorepo, npm workspaces, Node >= 22. `packages/shared` (types, queue contract,
`expandBraces`) → `apps/server` (Fastify + better-sqlite3 + migrations) → `apps/web`
(Vue 3 + Pinia + Vite). `npm run build` once before anything else - **server and web resolve
shared from `dist`**, so a contract change is invisible until it is rebuilt. Then
`npm run dev` (:8586 + :5173), `npm run typecheck`, `npm test`.

## Visual language

The tag matrix is the only fleet-column grid. These five cell states are its only cues.

| Cue | Meaning |
|---|---|
| solid green cell + count | present, with how many media items carry it |
| dashed empty cell | missing on that instance (click to stage it there) |
| amber | drift: partial parity, an inaccessible mount, or a setting that disagrees |
| violet ring + glyph | a staged operation is pending for this cell |
| red unknown icon | that instance did not answer - unknown, deliberately *not* "missing" |

`cell.known` in `buildTagRows` enforces the last. Import lists, `/paths` and `/media` drop
the column axis: rows are lists, folders or titles, instances are chips. Unreachable
instances are stated once above the table, never as "missing"; an instance that does not
have the row is simply absent. **None of the three reports parity or drift** - comparing
configuration is the matrix's job.

## The folder view (`/paths`)

- **Rows are folders, instances are chips. Root folders are leaves** - never `readdir` below
  one. Ones outside `FS_ROOTS` or absent from disk are still rows: `not mounted here` and
  struck through respectively.
- **`missing` = an instance holds a file here and the disk does not**; a monitored,
  undownloaded film's path is not a row.
- **Delete is offered on every real folder**, library or not: a missing button reads as
  "impossible" when the truth is "here is the cost", which the preflight states.
- **Depth is answered by `PathIndexService`**, server-side - an ancestor closure over every
  media path, so the browser never needs the fleet's whole library.

### Owner chips (`use`)

Precedence. An instance using the folder in none of these ways is **absent**:

| Use | Meaning |
|---|---|
| `rootFolder` | a root folder at exactly this path |
| `tracked` | a media item at exactly this path |
| `containsRoot` | one or more of its root folders live **under** here |
| `ancestor` | media lives *under* here |
| `importList` | a list fills this folder, and the instance neither roots nor tracks here |

A list aimed at a folder is a **delete guard**, not only a card fact: unnoticed, it recreates
the folder on its next sync. `referencedBy` reads lists, so a cache-only build that misses
them reports `complete: false` rather than "nothing adds here".

Use is structural, not a consequence of downloading - an empty, freshly configured `tv/`
still makes `/data/media` Sonarr's folder. The chip carries one count (that instance's
share, even when `0`); the rest belongs on the owner card. Never collapse `tracked` and `on
disk`, and keep both free-space readings (this container's `statfs` and what *Arr reports) -
disagreement is the mapping diagnosis.

### Monitoring and free space

Row badges are computed **server-side** so the vocabulary cannot drift: `untracked`,
`unmanaged`, `missing`, `not mounted here`, `empty`, `symlink`, `no access`,
`read-only`. They render at the right of the Path column, after the row actions.
Staged work and the severity glyph stay beside the name. There is no State column.

| Severity | Source | Rendered |
|---|---|---|
| `error` | `not mounted here`, `missing`, `no access` | red error icon |
| `warn` | `unmanaged`, `read-only`, low free space, a root folder its own instance calls inaccessible | amber warning icon |
| `info` | `untracked`, `empty`, `symlink` | nothing |
| `ok` | none of the above | nothing |

`untracked` stays `info` - it fires on every non-media folder. A collapsed row shows a
dimmed warning for worse below. Free space is **per filesystem, never per instance**: one
`statfs` per device id per request, seeded from `FS_ROOTS`, on the mount row rather than in
a column, and a low-space warning only ever lands on a mount or a root folder.

### Filters

- **Filtering is server-side**, and so is every count beside it.
- **Apply `only`, `q` and `limit` before any per-child `stat`.** 64 or fewer is served whole
  and probed; bigger defaults to problems-only, and `empty`/`no access` report `null`.
- **The parser lives in `@fleetarr/shared`** so both sides share the verdict: `path-filter.ts`
  for folders, `media-filter.ts` for titles, `expandBraces` for values in both.
- Folders on the way to a match stay **dimmed**; mounts and anything with a root folder
  below are never filtered away. In `exclude` mode nothing is protected.
- `q` implies `only=all`; excluding does not. An unparseable filter is **never sent** - the
  API rejects it with 400 rather than answering unfiltered.
- **No "Modified" sort** - a level is one `readdir`, which carries no mtime.

## The media view (`/media`)

- **Rows are titles** (`mediaIdentity`, kind-first so a film and a series never merge); a
  `title`-basis row is a guess and says so. One line each; kind, links and size are columns.
- **No row actions.** A bulk operation acts on the **matching** facets only - `monitored:false
  instance:radarr-4k` then delete cannot touch Radarr-HD - while every chip still renders. The
  header checkbox selects the whole match via `GET /media/ids`, not the page.
- **A filter verdict has three values.** Sonarr exposes no `importlist/series`, so `list:X`
  and `NOT list:X` are both unanswerable there. **No boolean helper** collapses it; undecided
  rows are counted with their reason. Kind-inapplicable `none`, app-incapable `unknown`.
- **A space means AND here** (the folder filter's means or); `AND`/`OR`/`NOT` are uppercase,
  so `dead or alive` stays a title search.
- **Whether a copy has a file is a size, not a flag** - the Size column answers three ways
  (a number, `no file`, `unknown`); a badge beside the real faults would read like one.

## The queue engine

- **Two op families.** `ArrOp` always names an instance, `FsOp` never does - a DB `CHECK` on
  `(kind, instance_id)` enforces it. Adding to `QueueOpPayloads` breaks both handler maps, the
  summary renderer, the target resolver, `affectedCountForOp`, `PRESENTATION` and
  `stageKeysFor` - **plus a migration**, which nothing type-checks.
- **`onError` defaults to `pause`** - the run stops, the failed item keeps its code, later
  items stay `pending`. `continue` records and moves on; `abort` cancels the rest. A paused
  run blocks new runs, so two runs never touch one instance at once.
- **`dependsOnId` may cross families**, and is a *single* column - one **producer** per
  dependent (many dependents may share one), so a chain needs sequential POSTs. The executor
  passes the dependency's stored result in; if it failed the dependent is `skipped`. It never
  defers, so **order is load-bearing**: `reorder` rejects a dependent placed before its
  producer, which would silently skip it rather than reorder it.
- **Preflight runs at stage time and again immediately before execution**, so a stale op fails
  with `fs_precondition_failed` rather than acting on an unreviewed disk.
- **Restart recovery**: runs still `running` at boot are parked `paused`, the in-flight item
  `failed` with `interrupted`.

## Storage access

Fleetarr must see media at exactly the same container path the *Arr apps use - no
translation layer, one binding for the whole tree, so a rename stays atomic.

| | |
|---|---|
| Scope | Directories only. No file-level create, rename or delete. |
| Traversal | Resolved against the configured roots; the parent chain is realpath'd so a symlink cannot escape. A symlink *leaf* is shown unresolved, never followed and never mutated. |
| Deleting | Hard delete. Non-empty needs `recursive`. A storage root or mount point is refused. |
| Delete guard | Four checks, never one. `root_folder_under` and `import_list_under` name a *registration*: the dialog stages a `rootFolder.delete` / `importList.setEnabled` in front of the delete, and the guard is **satisfied** rather than overruled - the preflight-request-only `assumeResolved` says so, and the executor's re-run passes nothing, so the check either really cleared or fires for real. `media_under` and `references_unknown` answer to `force` alone; unassigning leaves every stored media path where it was. A list blocks only when `enabled && automatic`. |
| Cross-filesystem moves | **Refused.** Preflight compares device ids and reports how much would have to be copied. |

`/config` is chowned to `PUID:PGID`. **Media roots are never chowned.**

## *Arr API notes

- **Parse narrow, keep raw.** Zod validates only the fields that are rendered; the
  untouched body rides along as `raw` (`ArrResource<TView>`). Never widen a schema to
  "be complete".
- **`PUT` replaces the resource.** Fetch raw → merge changed keys → PUT (`mergeForPut`).
  There is no `PUT /api/v3/rootfolder` - changing one is create → move with the editor →
  delete, which is what the queue models.
- **`/movie` and `/series` do not paginate** - fetched once into `resource_snapshots`, then
  paged server-side. Bulk media writes go through `{movie,series}/editor`, PUT and DELETE.
- **The two apps disagree per field**: `enableAuto`/`enableAutomaticAdd`,
  `addImportExclusion`/`addImportListExclusion`, `sizeOnDisk` vs `statistics.sizeOnDisk`,
  `studio`/`network`. *Arr ignores a key it does not know, so each pair gets a constant.
- **Map errors to codes the UI can act on**, never raw statuses - `arr_unauthorized`,
  `arr_timeout`, `arr_unreachable` and the rest, all in `arr/http.ts`.

## Data and security

- API keys are AES-256-GCM encrypted before hitting SQLite, keyed from `FLEETARR_SECRET` or
  `/config/secret.key`. **The key is never returned by the HTTP API** - keep the `Instance` vs
  `InstanceWithKey` split in `packages/shared/src/instance.ts`. Fleetarr has no auth of its own.

## Toolchain pitfalls

- TypeScript is pinned `~6.0` (`vue-tsc` still resolves `typescript/lib/tsc`, which 7 does not export).
- All build tooling lives in the root `package.json`: `--omit=dev` skips the root's
  devDependencies but not a workspace's, which would then ship in the runtime image.
- Migrations toggle `PRAGMA foreign_keys` outside the transaction and run `foreign_key_check`
  after; inside one it is a no-op, and a rebuild with them on cascades the audit trail away.
  SQLite cannot edit a `CHECK`: widening one rebuilds the table, indexes and all.
- Web tests are headless (Vitest + happy-dom, API mocked); styling is not asserted.
  `better-sqlite3` needs `python3 make g++` in the builder stage for `node-gyp rebuild`.
