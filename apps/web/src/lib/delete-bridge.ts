import type { FsCheckStatus, FsPreflight } from '@fleetarr/shared';

/**
 * Turning a delete's refusal into something the dialog can offer to fix.
 *
 * `preflightDelete` grades the *Arr side as four separate checks, and the split is the
 * whole point: two of them name a registration a staged operation can clear, two name a
 * fact only `force` can overrule. This module is the one place that knows which is which,
 * so the two delete dialogs cannot drift apart on it.
 *
 * Every predicate here reads a *server* verdict. None of them re-derives one - ticking a
 * bridge box re-runs the preflight with `assumeResolved`, and the answer that comes back
 * decides whether `force` is still on the table. Deciding that in the browser would put a
 * safety verdict in the one place that cannot see the fleet.
 */

/** Cleared by staging a `rootFolder.delete` / `importList.setEnabled` ahead of the delete. */
export const BRIDGEABLE = { rootFolders: 'root_folder_under', importLists: 'import_list_under' } as const;

/**
 * Not bridgeable, at any price.
 *
 * `media_under` survives an unassign - Radarr and Sonarr keep each item's stored path when
 * a root folder is removed - so the honest remedies are a remap, a `media.delete`, or
 * `force`. `references_unknown` is a fleet Fleetarr could not read; a promise to clear what
 * you could not see is worth nothing.
 */
export const UNBRIDGEABLE = ['media_under', 'references_unknown'] as const;

function statusOf(preflight: FsPreflight | null, id: string): FsCheckStatus | null {
  return preflight?.checks.find((check) => check.id === id)?.status ?? null;
}

/**
 * True while a check is anything but `ok`.
 *
 * Deliberately not "is a blocker": `force` and `assumeResolved` both downgrade a blocker to
 * a warning, so a blocker test would make each checkbox vanish the moment it was ticked and
 * the re-run preflight came back.
 */
function raised(preflight: FsPreflight | null, id: string): boolean {
  const status = statusOf(preflight, id);
  return status !== null && status !== 'ok';
}

export function needsRootFolderBridge(preflight: FsPreflight | null): boolean {
  return raised(preflight, BRIDGEABLE.rootFolders);
}

export function needsImportListBridge(preflight: FsPreflight | null): boolean {
  return raised(preflight, BRIDGEABLE.importLists);
}

/** Whether anything is left that only `force` can get past. */
export function needsForce(preflight: FsPreflight | null): boolean {
  return UNBRIDGEABLE.some((id) => raised(preflight, id));
}

export interface UnassignTarget {
  readonly instanceId: number;
  readonly instanceName: string;
  readonly rootFolderId: number;
  readonly path: string;
}

export interface DisableListTarget {
  readonly instanceId: number;
  readonly instanceName: string;
  readonly importListId: number;
  readonly name: string;
}

/**
 * Every root folder at or *under* the path, one target each.
 *
 * Read off the preflight rather than off `PathNode.owners`, because an owner that merely
 * contains a root folder carries a null `rootFolderId` - the id lives in `rootFoldersUnder`,
 * and only the server's reference list has both halves in one place.
 */
export function unassignTargets(preflight: FsPreflight | null): UnassignTarget[] {
  return (preflight?.references ?? []).flatMap((reference) =>
    reference.rootFolders.map((folder) => ({
      instanceId: reference.instanceId,
      instanceName: reference.instanceName,
      rootFolderId: folder.id,
      path: folder.path,
    })),
  );
}

/**
 * Every *enabled* list aimed at the path, automatic or not.
 *
 * Only an automatic one refuses the delete, but a manual one is still left pointing at a
 * folder that is gone, and disabling is reversible - so the offer covers both and clears
 * the warning along with the blocker. A list that is already disabled is left alone: it
 * was never a finding.
 */
export function disableListTargets(preflight: FsPreflight | null): DisableListTarget[] {
  return (preflight?.references ?? []).flatMap((reference) =>
    reference.importLists
      .filter((list) => list.enabled)
      .map((list) => ({
        instanceId: reference.instanceId,
        instanceName: reference.instanceName,
        importListId: list.id,
        name: list.name,
      })),
  );
}

/** The `assumeResolved` to ask the preflight with, given what the dialog has ticked. */
export function assumeResolved(unassign: boolean, disableLists: boolean): {
  rootFolders?: boolean;
  importLists?: boolean;
} {
  return {
    ...(unassign ? { rootFolders: true } : {}),
    ...(disableLists ? { importLists: true } : {}),
  };
}
