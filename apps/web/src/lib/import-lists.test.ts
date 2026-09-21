import type { ArrImportList, ArrTagDetail, Instance } from '@fleetarr/shared';
import { describe, expect, it } from 'vitest';
import { buildImportListRows, qualityProfileLabel } from './import-lists';
import type { InstanceSnapshot } from './matrix';

function instance(id: number, name: string, kind: Instance['kind'] = 'radarr'): Instance {
  return {
    id,
    name,
    kind,
    baseUrl: `http://host:${String(7000 + id)}`,
    verifySsl: true,
    enabled: true,
    timeoutMs: 20_000,
    appVersion: '5.0.0',
    lastConnectedAt: '2026-09-01T00:00:00.000Z',
    lastError: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function tag(id: number, label: string): ArrTagDetail {
  return {
    id,
    label,
    indexerIds: [],
    importListIds: [],
    notificationIds: [],
    restrictionIds: [],
    delayProfileIds: [],
  };
}

/** Radarr's shape: it has an Enabled switch, spelled `enabled`. */
function importList(id: number, name: string, overrides: Partial<ArrImportList> = {}): ArrImportList {
  return {
    id,
    name,
    implementation: 'TraktListImport',
    configContract: 'TraktListSettings',
    enabled: true,
    rootFolderPath: '/data/media',
    qualityProfileId: 1,
    tags: [],
    fields: [],
    ...overrides,
  };
}

/** Sonarr's shape: no `enabled` key at all, only `enableAutomaticAdd`. */
function sonarrList(id: number, name: string, overrides: Partial<ArrImportList> = {}): ArrImportList {
  const { enabled: _ignored, ...list } = importList(id, name, overrides);
  return { ...list, implementation: 'TraktImport' };
}

function snapshot(
  id: number,
  name: string,
  parts: Partial<Pick<InstanceSnapshot, 'status' | 'tags' | 'importLists' | 'qualityProfiles'>> & {
    kind?: Instance['kind'];
  } = {},
): InstanceSnapshot {
  return {
    instance: instance(id, name, parts.kind),
    status: parts.status ?? 'ok',
    fetchedAt: '2026-09-01T00:00:00.000Z',
    error: null,
    tags: parts.tags ?? [],
    rootFolders: [],
    importLists: parts.importLists ?? [],
    qualityProfiles: parts.qualityProfiles ?? [],
    collections: [],
  };
}

describe('import list rows', () => {
  it('gives every (list, instance) pair its own row, never folding them by name', () => {
    const rows = buildImportListRows([
      snapshot(1, 'Radarr-4K', {
        importLists: [importList(1, 'Trakt watchlist', { rootFolderPath: '/data/media/movies-4k' })],
      }),
      snapshot(2, 'Radarr-HD', {
        importLists: [
          importList(4, 'trakt watchlist', { rootFolderPath: '/media/movies', enabled: false }),
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.key)).toEqual(['1:1', '2:4']);
    // Each row keeps its own instance's spelling, path and state - the fold hid all three.
    expect(rows.map((row) => row.name)).toEqual(['Trakt watchlist', 'trakt watchlist']);
    expect(rows.map((row) => row.rootFolderPath)).toEqual([
      '/data/media/movies-4k',
      '/media/movies',
    ]);
    expect(rows.map((row) => row.enabled)).toEqual([true, false]);
  });

  it('sorts by list name, then by instance, so copies of one list sit adjacent', () => {
    const rows = buildImportListRows([
      snapshot(2, 'Radarr-HD', {
        importLists: [importList(1, 'Popular'), importList(2, 'Trakt watchlist')],
      }),
      snapshot(1, 'Radarr-4K', { importLists: [importList(3, 'Trakt watchlist')] }),
    ]);

    expect(rows.map((row) => `${row.name}@${row.instanceName}`)).toEqual([
      'Popular@Radarr-HD',
      'Trakt watchlist@Radarr-4K',
      'Trakt watchlist@Radarr-HD',
    ]);
  });

  it('reports a Sonarr list as having no Enabled switch, deliberately not "on"', () => {
    const rows = buildImportListRows([
      snapshot(1, 'Radarr', { importLists: [importList(1, 'A', { enableAuto: true })] }),
      snapshot(2, 'Sonarr', {
        kind: 'sonarr',
        importLists: [sonarrList(2, 'A', { enableAutomaticAdd: true })],
      }),
    ]);

    expect(rows.map((row) => row.enabled)).toEqual([true, null]);
    // Auto add is the switch both apps do have, whichever way they spell it.
    expect(rows.map((row) => row.automatic)).toEqual([true, true]);
  });

  it('an instance that did not answer contributes no rows at all', () => {
    const rows = buildImportListRows([
      snapshot(1, 'Radarr-4K', { importLists: [importList(1, 'Trakt watchlist')] }),
      snapshot(9, 'Radarr-Down', { status: 'error', importLists: [importList(2, 'Stale')] }),
    ]);

    expect(rows.map((row) => row.instanceName)).toEqual(['Radarr-4K']);
  });

  it('resolves tag ids against that instance, and leaves an id it cannot name as an id', () => {
    const rows = buildImportListRows([
      snapshot(1, 'Radarr-4K', {
        tags: [tag(1, 'kids'), tag(2, 'shared')],
        importLists: [importList(1, 'Trakt watchlist', { tags: [2, 1, 7] })],
      }),
    ]);

    expect(rows[0]?.tags).toEqual(['shared', 'kids', '#7']);
  });

  it('never invents a profile name for an id this instance has no profile for', () => {
    const [named, unknown, unset] = buildImportListRows([
      snapshot(1, 'Radarr-4K', {
        qualityProfiles: [{ id: 1, name: 'Ultra-HD' }],
        importLists: [
          importList(1, 'A', { qualityProfileId: 1 }),
          importList(2, 'B', { qualityProfileId: 9 }),
          importList(3, 'C', { qualityProfileId: 0 }),
        ],
      }),
    ]);

    expect(named?.qualityProfileName).toBe('Ultra-HD');
    expect(unknown?.qualityProfileName).toBeNull();
    expect(unset?.qualityProfileName).toBeNull();

    expect(qualityProfileLabel(named!)).toBe('Ultra-HD');
    expect(qualityProfileLabel(unknown!)).toBe('id 9');
    expect(qualityProfileLabel(unset!)).toBe('none set');
  });
});
