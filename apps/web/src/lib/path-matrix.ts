import type { Component } from 'vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import {
  matchPathFilter,
  PATH_SEVERITIES,
  type PathFilter,
  type PathFlag,
  type PathImportList,
  type PathMatrixColumn,
  type PathMatrixLevel,
  type PathNode,
  type PathOwner,
  type PathSeverity,
  type PathUse,
} from '@fleetarr/shared';
import { pluralise } from './format';

/**
 * Turning the server's levels into table rows.
 *
 * Everything here is pure: levels in, rows out. The view never walks the tree itself,
 * which is what makes the "a library must never become 812 rows" rule testable.
 */

export interface PathRow {
  /** Stable across re-renders: `:v-for` keys on it. */
  readonly key: string;
  readonly depth: number;
  /** The directory this row belongs to. */
  readonly levelPath: string;
  readonly node: PathNode;
  readonly expanded: boolean;
  /** True when a level for this node has been fetched. */
  readonly hasLevel: boolean;
  /**
   * The worst severity *inside* this node, when its level has been fetched; null when it
   * has not, because "nothing fetched" is not "nothing wrong".
   *
   * A node cannot carry this itself - its children are a separate request - but a level
   * is exactly "what is in this directory", and the store already indexes levels by path.
   */
  readonly childSeverity: PathSeverity | null;
  /** {@link isLeafFolder} for this node - what decides whether the row is selectable. */
  readonly leaf: boolean;
}

export interface FlattenInput {
  readonly levels: Readonly<Record<string, PathMatrixLevel>>;
  readonly expanded: readonly string[];
  readonly focus: string | null;
  /**
   * The active folder filter, when there is one.
   *
   * The server already dropped everything a filter excludes, but it has to keep the
   * folders a pattern only *reaches through* - it cannot know whether a match lies below
   * a level it was not asked for. In a tree those rows are the path to the answer; in a
   * flat list they are noise, so {@link flattenLeaves} is the one place that re-checks.
   */
  readonly filter?: PathFilter | null;
}

/** The synthetic top level - mounts and paths this container cannot see - is keyed ''. */
export const TOP_LEVEL = '';

export function levelKey(path: string | null): string {
  return path ?? TOP_LEVEL;
}

/**
 * A folder the tree will never render children under.
 *
 * Decided from the fetched level, never from `expandable`: a root folder holding 812 films
 * has entries but is deliberately never read below (the server's `expandableOf`), and a
 * folder of 172 episode files is the deepest folder on its branch. A folder whose level was
 * never fetched counts as a leaf - the flat list crawls everything before it asks, and in
 * the tree that is the honest answer until the level is read.
 *
 * One definition, shared: it picks the flat list's rows and the tree's checkboxes, so the
 * same folders are selectable in both views and expanding a folder is the moment the tree
 * learns it is a parent.
 */
export function isLeafFolder(
  path: string,
  levels: Readonly<Record<string, PathMatrixLevel>>,
): boolean {
  const level = levels[path];
  return level === undefined || !level.nodes.some((child) => child.kind === 'directory');
}

/**
 * Depth-first walk of the fetched levels.
 *
 * Every row is a folder. A level that returned a subset of what is really in the directory
 * - a big library summarised to its problems, or a filtered level - says so nowhere in the
 * table: the rows are what they are.
 */
export function flattenLevels(input: FlattenInput): PathRow[] {
  const expanded = new Set(input.expanded);
  const rows: PathRow[] = [];
  const guard = new Set<string>();

  const walk = (key: string, depth: number): void => {
    // A cycle would need a symlink loop the server followed; it never does, but a
    // malformed response must not hang the browser.
    if (guard.has(key)) return;
    guard.add(key);

    const level = input.levels[key];
    if (level === undefined) return;

    for (const node of level.nodes) {
      // This view manages folders, not media files: a plain file sitting in an otherwise
      // ordinary directory is never a row here, in either the tree or the flat list.
      if (node.kind === 'file') continue;

      const childKey = node.path;
      const hasLevel = input.levels[childKey] !== undefined;
      const isExpanded = expanded.has(childKey) && hasLevel;

      rows.push({
        key: `node:${childKey}`,
        depth,
        levelPath: key,
        node,
        expanded: isExpanded,
        hasLevel,
        childSeverity: hasLevel ? input.levels[childKey]?.rollup.severity ?? null : null,
        leaf: isLeafFolder(childKey, input.levels),
      });

      if (isExpanded) walk(childKey, depth + 1);
    }
  };

  const root = input.focus === null ? TOP_LEVEL : input.focus;
  walk(root, 0);
  return rows;
}

/**
 * The flat alternative to {@link flattenLevels}: every leaf *folder* under the root, in
 * one list, with no nesting - depth is always 0, which is also what makes a node's own
 * label logic (`depth === 0` ⇒ full path) show the whole path for free.
 *
 * A leaf is a folder with no *sub*folders - which is not the same thing as a folder with
 * no children. A folder holding 172 episode files and nothing else is the deepest folder
 * on that branch, and is exactly what this list is for. {@link isLeafFolder} is the whole
 * of that judgement, and it expects the caller to have crawled everything first (see
 * `loadFlatView`) - its unfetched-is-a-leaf fallback is defensive here, not the normal path.
 *
 * Anything that is not a directory - a file, a symlink - is dropped outright: this is a
 * folder list, and a level legitimately mixes directory and file candidates together.
 *
 * With a filter on, a leaf has to match it *itself*: a folder kept only because a pattern
 * might have continued below it turned out to have nothing below it, so it is an answer
 * to nothing. See {@link FlattenInput.filter}.
 */
export function flattenLeaves(input: FlattenInput): PathRow[] {
  const rows: PathRow[] = [];
  const guard = new Set<string>();

  const walk = (key: string): void => {
    if (guard.has(key)) return;
    guard.add(key);

    const level = input.levels[key];
    if (level === undefined) return;

    for (const node of level.nodes) {
      if (node.kind !== 'directory') continue;

      const childKey = node.path;
      const hasLevel = input.levels[childKey] !== undefined;

      if (!isLeafFolder(childKey, input.levels)) {
        walk(childKey);
        continue;
      }

      if (!keepsLeaf(input.filter ?? null, childKey)) continue;

      rows.push({
        key: `leaf:${childKey}`,
        depth: 0,
        levelPath: key,
        node,
        expanded: false,
        hasLevel,
        childSeverity: null,
        leaf: true,
      });
    }
  };

  const root = input.focus === null ? TOP_LEVEL : input.focus;
  walk(root);
  return rows.sort((a, b) => a.node.path.localeCompare(b.node.path));
}

/** In `exclude` mode everything the server returned is already an answer. */
function keepsLeaf(filter: PathFilter | null, target: string): boolean {
  if (filter === null || !filter.active || filter.mode === 'exclude') return true;
  return matchPathFilter(filter, target) === 'full';
}

/** How a severity is rendered. `ok` and `info` are silent - an icon on every row is noise. */
export const SEVERITY_STYLES: Record<PathSeverity, { icon: Component; classes: string } | null> = {
  ok: null,
  info: null,
  warn: { icon: IconWarning, classes: 'text-drift' },
  error: { icon: IconError, classes: 'text-danger' },
};

/** The worst of a set - `PATH_SEVERITIES` is ordered, so this is a max. */
export function worstSeverity(severities: readonly PathSeverity[]): PathSeverity {
  return severities.reduce<PathSeverity>(
    (worst, entry) =>
      PATH_SEVERITIES.indexOf(entry) > PATH_SEVERITIES.indexOf(worst) ? entry : worst,
    'ok',
  );
}

/**
 * The instances that did not answer.
 *
 * This is where the `unknown` cell went. An instance that could not be read is absent
 * from every row's `owners`, so without saying so once, an empty Used-by cell would read
 * as "nobody uses this folder" - exactly the gap-versus-unknown confusion the fleet
 * matrices refuse to make.
 */
export function unknownColumns(
  columns: readonly PathMatrixColumn[],
): readonly PathMatrixColumn[] {
  return columns.filter((column) => !column.reachable);
}

export function rootFolderOwners(node: PathNode): readonly PathOwner[] {
  return node.owners.filter((owner) => owner.use === 'rootFolder');
}

/**
 * One root folder a rename of `node` can carry along - either the folder itself, or one
 * sitting under it. The dialog checkboxes are per instance; the chain is per root.
 */
export interface AlignRoot {
  readonly path: string;
  readonly rootFolderId: number | null;
}

export interface AlignTarget {
  readonly instanceId: number;
  readonly name: string;
  readonly kind: 'radarr' | 'sonarr';
  readonly roots: readonly AlignRoot[];
}

/**
 * Every instance a rename of this folder can realign.
 *
 * Rooting *at* the folder is the original case. Rooting *under* it is the one a parent
 * rename used to miss: the disk moved, the nested registrations stayed, and *Arr marked
 * them unavailable. Both belong on the same dialog so they cannot drift apart.
 */
export function alignTargetsFor(node: PathNode): AlignTarget[] {
  const targets: AlignTarget[] = [];

  for (const owner of node.owners) {
    const roots: AlignRoot[] = [];
    if (owner.use === 'rootFolder') {
      roots.push({ path: node.path, rootFolderId: owner.rootFolderId });
    }
    for (const folder of owner.rootFoldersUnder) {
      roots.push({ path: folder.path, rootFolderId: folder.id });
    }
    if (roots.length === 0) continue;
    targets.push({
      instanceId: owner.instanceId,
      name: owner.name,
      kind: owner.kind,
      roots,
    });
  }

  return targets;
}

export interface RootFolderCellTarget {
  readonly instanceId: number;
  readonly rootFolderId: number;
  readonly path: string;
}

/**
 * The root folders to remove for a path - one per owning instance.
 *
 * No target-selection argument any more: a folder's owners *are* the answer to "which
 * instance", and the dialog names each one before anything is staged.
 */
export function rootFolderTargets(node: PathNode): RootFolderCellTarget[] {
  return rootFolderOwners(node).map((owner) => ({
    instanceId: owner.instanceId,
    rootFolderId: owner.rootFolderId ?? 0,
    path: node.path,
  }));
}

/**
 * Of a selection, the folders a delete may actually be staged for.
 *
 * Eligibility is not re-derived here: `actionsFor` already decides when a folder may be
 * pruned - not a mount, on disk, and nothing anywhere would lose media by it - and a second
 * copy of that rule is a second place for it to drift.
 *
 * A selected folder under another selected folder is dropped, because the parent's recursive
 * delete takes it along: its own `fs.delete` would then fail its re-run preflight with
 * `source_exists`, turning one staged batch into a paused run. The pair is reachable because
 * selection survives collapsing a branch, so the descendant can be off screen by the time the
 * ancestor is picked.
 */
export function prunableFolders(nodes: readonly PathNode[]): PathNode[] {
  const eligible = nodes.filter((node) => actionsFor(node).includes('prune'));
  return eligible.filter(
    (node) => !eligible.some((other) => other !== node && isUnder(node.path, other.path)),
  );
}

/** Strictly under: a path is never its own ancestor. */
function isUnder(target: string, ancestor: string): boolean {
  return target.startsWith(`${ancestor}/`);
}

/** Instances tracking media at or under a path, for the relocation warning. */
export function trackedBy(
  node: PathNode,
): Array<{ instanceId: number; name: string; mediaCount: number }> {
  return node.owners
    .filter((owner) => owner.mediaUnder > 0)
    .map((owner) => ({
      instanceId: owner.instanceId,
      name: owner.name,
      mediaCount: owner.mediaUnder,
    }));
}

/**
 * What the Media column says: the title when exactly one instance tracks an item here,
 * otherwise how many items the owners hold at or under it.
 *
 * Summed rather than maxed, and broken down in the tooltip, because a 4K/HD split has two
 * instances counting the same films and neither number alone is the truth.
 */
export function mediaSummary(node: PathNode): { label: string; detail: string } | null {
  if (node.owners.length === 0) return null;

  const tracked = node.owners.filter((owner) => owner.use === 'tracked');
  const detail = node.owners
    .map((owner) => `${owner.name}: ${String(owner.mediaUnder)} item(s)`)
    .join('\n');

  if (tracked.length === 1 && tracked[0]?.title !== null) {
    return { label: tracked[0]?.title ?? '', detail };
  }

  const total = node.owners.reduce((sum, owner) => sum + owner.mediaUnder, 0);
  return total === 0 ? null : { label: String(total), detail };
}

// ------------------------------------------------------------------ the owner card

/**
 * What one instance's claim on one folder says, in three registers: a headline, a couple
 * of numbers small enough to sit on the chip, and the full breakdown for the card.
 *
 * All three are pure functions of one `PathOwner`, so the chip and the card can never
 * disagree about what an instance is doing with a folder - the same reason the flag and
 * severity vocabularies are computed once, server-side.
 */

/**
 * How this instance uses the folder, as a sentence. The chip tooltip and the card
 * headline share it so they cannot disagree.
 */
export function ownerHeadline(owner: PathOwner): string {
  switch (owner.use) {
    case 'rootFolder':
      return owner.accessible === false
        ? 'used as a root folder — it cannot see it'
        : 'used as a root folder';
    case 'tracked':
      return owner.title === null ? 'used to track an item here' : `used to track “${owner.title}”`;
    case 'containsRoot':
      return `used for ${pluralise(owner.rootFoldersUnder.length, 'root folder')} below`;
    case 'ancestor':
      return 'used for media below this folder';
    case 'importList':
      return 'used by an import list';
  }
}

/**
 * The one number that belongs on the chip: how much of this folder is that instance's.
 *
 * The count the row's Media column cannot be. That column sums the fleet, so a 4K/HD
 * split counts the same films twice there and neither number alone answers "how much of
 * this is yours". Everything else an owner knows is a sentence, not a number, and reads
 * as noise squeezed onto a chip - so it lives on the card.
 *
 * Always rendered, zero included: a chip with no number would leave "this instance tracks
 * nothing here" indistinguishable from "we did not count".
 */
export interface OwnerMetric {
  readonly value: number;
  readonly title: string;
}

export function ownerMedia(owner: PathOwner): OwnerMetric {
  return {
    value: owner.mediaUnder,
    title:
      owner.mediaUnder === 0
        ? `${owner.name}: nothing tracked at or under this folder`
        : `${owner.name}: ${pluralise(owner.mediaUnder, 'item')} at or under this folder, ${String(owner.mediaWithFiles)} of them on disk`,
  };
}

export interface OwnerFact {
  readonly label: string;
  readonly value: string;
  /** Named things behind the number - list names. */
  readonly detail: readonly string[];
  readonly tone: 'normal' | 'warn' | 'muted';
}

/** "1 list adds here", "2 lists add here" - the verb has to agree with the count. */
function adds(count: number): string {
  return count === 1 ? 'adds' : 'add';
}

/** One list, named and stated - never the folder it fills. That belongs on that folder's row. */
function describeList(list: PathImportList): string {
  const state = !list.enabled ? 'disabled' : list.automatic ? 'adds automatically' : 'manual add';
  return `${list.name} - ${state}`;
}

/**
 * How this instance uses the folder, as a fact - same shape as Media, so the card is one
 * definition list of "used as / used for" rather than a headline plus a dump of sections.
 */
function ownerUseFact(owner: PathOwner): OwnerFact {
  switch (owner.use) {
    case 'rootFolder':
      return {
        label: 'Used as',
        value: owner.accessible === false ? 'root folder — it cannot see it' : 'root folder',
        detail: [],
        tone: owner.accessible === false ? 'warn' : 'normal',
      };
    case 'tracked':
      return {
        label: 'Used as',
        value: owner.title === null ? 'a tracked item' : `tracks “${owner.title}”`,
        detail: [],
        tone: 'normal',
      };
    case 'containsRoot':
      return {
        label: 'Used for',
        value: `${pluralise(owner.rootFoldersUnder.length, 'root folder')} below`,
        detail: [],
        tone: 'normal',
      };
    case 'ancestor':
      return {
        label: 'Used for',
        value: 'media below this folder',
        detail: [],
        tone: 'normal',
      };
    case 'importList':
      return {
        label: 'Used by',
        value: 'an import list',
        detail: [],
        tone: 'warn',
      };
  }
}

/**
 * The card body. Every fact is stated even when it is a zero, because "no import list
 * points here" and "we did not look" are different answers and only one of them is true.
 *
 * There is no Root folder section: that the instance roots here (or below) is the
 * use line, and listing the folders a parent contains mixed those paths into the
 * import lists.
 */
export function ownerFacts(owner: PathOwner, path: string): OwnerFact[] {
  const facts: OwnerFact[] = [ownerUseFact(owner)];

  if (owner.mediaUnder === 0) {
    facts.push({ label: 'Media', value: 'nothing tracked here', detail: [], tone: 'muted' });
  } else {
    const backlog = owner.mediaUnder - owner.mediaWithFiles;
    facts.push({
      label: 'Media',
      value: `${pluralise(owner.mediaUnder, 'item')} at or under here`,
      detail: [
        `${String(owner.mediaWithFiles)} on disk`,
        // The gap is a fact about the instance, not about the folder: a monitored film
        // nobody has downloaded is *meant* to have no folder yet.
        ...(backlog > 0 ? [`${String(backlog)} monitored, not downloaded`] : []),
      ],
      tone: 'normal',
    });
  }

  const here = owner.importLists.filter((list) => list.path === path);
  const below = owner.importLists.filter((list) => list.path !== path);

  if (owner.importLists.length === 0) {
    facts.push({ label: 'Import lists', value: 'none point here', detail: [], tone: 'muted' });
  } else {
    // Lists aimed at a descendant root folder still belong on this card (they fill
    // something under here) but they are named only - the folder they land in is that
    // row's business, and prefixing "tv:" made a parent look like it *was* those lists'
    // root folder.
    facts.push({
      label: 'Import lists',
      value:
        below.length === 0
          ? `${pluralise(here.length, 'list')} ${adds(here.length)} here`
          : here.length === 0
            ? pluralise(below.length, 'list')
            : `${pluralise(here.length, 'list')} ${adds(here.length)} here, ${String(below.length)} more`,
      detail: owner.importLists.map(describeList),
      tone: owner.use === 'importList' ? 'warn' : 'normal',
    });
  }

  return facts;
}

/** Chip tone per claim. A root folder its own instance cannot see is the loud one. */
export const USE_CLASSES: Record<PathUse, string> = {
  rootFolder: 'border-sync/40 bg-sync/8 text-ink hover:border-sync/70',
  tracked: 'border-line bg-transparent text-muted hover:border-line-strong',
  containsRoot: 'border-line-strong bg-transparent text-muted hover:border-accent/60',
  ancestor: 'border-line bg-transparent text-muted hover:border-line-strong',
  importList: 'border-drift/50 bg-drift/10 text-drift',
};

export type PathAction =
  | 'addRoot'
  | 'remap'
  | 'rename'
  | 'move'
  | 'prune'
  | 'focus';

/**
 * A row offers exactly what the folder itself allows.
 *
 * There is no target-instance argument: the folder's own `owners` answer "which instance"
 * for everything that removes or realigns, and the dialogs ask for everything that adds.
 * That is what lets the fleet bar be a filter rather than a hidden action target.
 *
 * Four things are deliberately absent. Creating a folder was a row action, which meant one
 * dialog per folder for the job that is never singular - laying out
 * `{movies,series}/{russian,western}/4k`. It is one toolbar button now, taking the same
 * brace expansion the filter does, so a row no longer has to be found before a folder that
 * does not exist yet can be named.
 *
 * `align` was a second row action beside `rename`, asking the same first question - the new
 * name - and differing only in whether the *Arr half was staged. It is the same dialog now:
 * `rename` offers the instances rooting at *or under* the folder as checkboxes, so the
 * choice is made where the name is typed rather than by picking the right button beforehand.
 *
 * `remove` was a row button beside them, staging a removal for every instance rooting at
 * the folder at once. Removal is per instance, and the owner chip already names the one it
 * is about, so it lives on the owner card - one instance, named, with its media count in
 * front of you - and the toolbar keeps the batch version for a selection.
 *
 * And renaming an individual *media* folder is offered as a plain disk rename, never as an
 * align chain. `media.moveRootFolder` only sets `rootFolderPath` and `media.refresh`
 * re-reads each item's stored path, so nothing in the current operation set can make *Arr
 * adopt a renamed media folder - it would report the item missing instead. Offering one
 * would be a lie dressed as a feature.
 */
export function actionsFor(node: PathNode): PathAction[] {
  const flags = new Set<PathFlag>(node.flags);
  const rootFolders = rootFolderOwners(node);
  const actions: PathAction[] = [];

  // Nothing on disk to act on, and no path to browse into. Its root-folder owners are
  // still chips, so removing one is still a click away - on the card, where it belongs.
  if (flags.has('unseen')) return [];

  if (node.canAddRootFolder) actions.push('addRoot');

  // Any root folder, not only one with media in it: use is structural, so a configured but
  // still empty root folder is exactly the one worth re-pointing before anything lands in it.
  if (flags.has('rootFolder') && rootFolders.length > 0) {
    actions.push('remap');
  }

  if (flags.has('missing')) return actions;

  if (node.exists && node.kind === 'directory') {
    if (!flags.has('mount')) {
      actions.push('rename', 'move');
      // Pruning is only offered when nothing anywhere would lose media by it, and when no
      // instance roots below it: deleting the parent of an empty-but-configured root
      // folder takes out a root folder that has no media to speak for it. An instance
      // that did not answer is not an owner, so it contributes neither - the same
      // conclusion the old `!cell.known || cell.mediaUnder === 0` check reached.
      const holdsSomething = node.owners.some(
        (owner) => owner.mediaUnder > 0 || owner.rootFoldersUnder.length > 0,
      );
      if (!holdsSomething) actions.push('prune');
    }
    if (node.expandable) actions.push('focus');
  }

  return actions;
}

/** Badge vocabulary. Same tokens the storage explorer used, re-keyed to server flags. */
export const FLAG_STYLES: Record<PathFlag, { label: string; classes: string; title: string }> = {
  mount: {
    label: 'mount',
    classes: 'border-accent/50 bg-accent/10 text-accent',
    title: 'A configured FS_ROOTS mount - it can never be renamed, moved or deleted',
  },
  rootFolder: {
    label: 'root folder',
    classes: 'border-sync/50 bg-sync/10 text-sync',
    title: 'A root folder on at least one instance',
  },
  untracked: {
    label: 'untracked',
    classes: 'border-drift/50 bg-drift/10 text-drift',
    title: 'Inside a root folder, but no instance tracks anything at or under it',
  },
  unmanaged: {
    label: 'unmanaged',
    classes: 'border-drift/50 bg-drift/10 text-drift',
    title: 'Holds media, but sits under no root folder on any instance',
  },
  missing: {
    label: 'missing',
    classes: 'border-danger/50 bg-danger/10 text-danger',
    title: 'An instance points at this path, but it does not exist on disk',
  },
  unseen: {
    label: 'not mounted here',
    classes: 'border-danger/50 bg-danger/10 text-danger',
    title:
      'A root folder outside FS_ROOTS - a volume mapping difference, not missing media',
  },
  empty: {
    label: 'empty',
    classes: 'border-line-strong bg-raised text-muted',
    title: 'Directory has no entries',
  },
  symlink: {
    label: 'symlink',
    classes: 'border-accent/50 bg-accent/10 text-accent',
    title: 'Fleetarr never follows or mutates symlinks',
  },
  unreadable: {
    label: 'no access',
    classes: 'border-danger/50 bg-danger/10 text-danger',
    title: 'The container cannot read this path - check PUID/PGID and permissions',
  },
  readOnly: {
    label: 'read-only',
    classes: 'border-drift/50 bg-drift/10 text-drift',
    title: 'Readable but not writable - a staged rename or move here would fail',
  },
};
