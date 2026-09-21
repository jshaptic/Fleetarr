import type { Instance } from '@fleetarr/shared';
import { importListAutomatic, importListEnabled } from '@fleetarr/shared';
import { sortSnapshots, type InstanceSnapshot } from './matrix';

/**
 * One import list on one instance.
 *
 * Not a fleet fold. Two instances carrying a list of the same name are two rows, because
 * they are two resources: separate ids, separate root folders, separate tags, separately
 * editable in the *Arr app that owns them. Merging them by name hid all of that behind a
 * chip and made a single-valued Tags or Root folder column impossible to draw.
 *
 * An instance that did not answer contributes no rows at all - unknown, deliberately not
 * "missing". The page states the count once, above the table.
 */
export interface ImportListRow {
  readonly key: string;
  readonly instanceId: number;
  readonly instanceName: string;
  readonly kind: Instance['kind'];
  readonly listId: number;
  readonly name: string;
  readonly implementation: string;
  /** `null` where the app has no Enabled switch at all (Sonarr) - never a guessed `true`. */
  readonly enabled: boolean | null;
  readonly automatic: boolean;
  readonly rootFolderPath: string;
  readonly qualityProfileId: number;
  /** Null when this instance has no profile for the id - never invent a label. */
  readonly qualityProfileName: string | null;
  /** Labels from this instance's own tag list; an id it cannot name stays an id. */
  readonly tags: readonly string[];
}

export function buildImportListRows(snapshots: readonly InstanceSnapshot[]): ImportListRow[] {
  const rows = sortSnapshots(snapshots).flatMap((snapshot): ImportListRow[] => {
    if (snapshot.status !== 'ok') return [];
    const labels = new Map(snapshot.tags.map((tag) => [tag.id, tag.label]));

    return snapshot.importLists.map((list) => ({
      key: `${String(snapshot.instance.id)}:${String(list.id)}`,
      instanceId: snapshot.instance.id,
      instanceName: snapshot.instance.name,
      kind: snapshot.instance.kind,
      listId: list.id,
      name: list.name,
      implementation: list.implementationName ?? list.implementation,
      enabled: importListEnabled(list),
      automatic: importListAutomatic(list),
      rootFolderPath: list.rootFolderPath,
      qualityProfileId: list.qualityProfileId,
      qualityProfileName:
        snapshot.qualityProfiles.find((profile) => profile.id === list.qualityProfileId)?.name ??
        null,
      tags: list.tags.map((id) => labels.get(id) ?? `#${String(id)}`),
    }));
  });

  // Name first so the same list on two instances sits adjacent - drift is still eyeballable
  // without a matrix. `sortSnapshots` above already fixed the tie-break: Radarr, then
  // Sonarr, alphabetical within a kind.
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** The profile cell's three answers: a name, "none set" for an unset id, or the bare id. */
export function qualityProfileLabel(row: ImportListRow): string {
  if (row.qualityProfileName !== null) return row.qualityProfileName;
  return row.qualityProfileId === 0 ? 'none set' : `id ${String(row.qualityProfileId)}`;
}
