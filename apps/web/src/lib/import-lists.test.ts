import type { ArrImportList, Instance } from '@fleetarr/shared';
import { describe, expect, it } from 'vitest';
import {
  canCloneImportList,
  importListCloneCandidates,
  importListOwnerFacts,
  importListOwners,
  ownerStateLabel,
} from './import-lists';
import { buildImportListRows, type InstanceSnapshot } from './matrix';

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

function snapshot(
  id: number,
  name: string,
  parts: Partial<Pick<InstanceSnapshot, 'status' | 'importLists' | 'qualityProfiles'>> & {
    kind?: Instance['kind'];
  } = {},
): InstanceSnapshot {
  return {
    instance: instance(id, name, parts.kind),
    status: parts.status ?? 'ok',
    fetchedAt: '2026-09-01T00:00:00.000Z',
    error: null,
    tags: [],
    rootFolders: [],
    importLists: parts.importLists ?? [],
    qualityProfiles: parts.qualityProfiles ?? [],
    collections: [],
  };
}

describe('import list owners', () => {
  it('chips only the instances that have the list, never the missing or unknown', () => {
    const fleet = [
      snapshot(1, 'Radarr-4K', { importLists: [importList(1, 'Trakt watchlist')] }),
      snapshot(2, 'Radarr-HD', { importLists: [] }),
      snapshot(9, 'Radarr-Down', { status: 'error' }),
    ];
    const row = buildImportListRows(fleet)[0];
    if (row === undefined) throw new Error('expected a row');

    const owners = importListOwners(row, fleet);
    expect(owners.map((owner) => owner.name)).toEqual(['Radarr-4K']);
    expect(owners[0]?.listId).toBe(1);
    expect(row.presentOn).not.toContain(9);
  });

  it('carries instance kind so the chip initials can colour by app', () => {
    const fleet = [
      snapshot(1, 'Radarr-4K', { importLists: [importList(1, 'Shared')] }),
      snapshot(2, 'Sonarr', { kind: 'sonarr', importLists: [importList(8, 'Shared')] }),
    ];
    const row = buildImportListRows(fleet)[0];
    if (row === undefined) throw new Error('expected a row');

    expect(importListOwners(row, fleet).map((owner) => owner.kind)).toEqual(['radarr', 'sonarr']);
  });
});

describe('clone candidates', () => {
  it('offers only healthy same-kind instances that do not already have the list', () => {
    const fleet = [
      snapshot(1, 'Radarr-4K', { importLists: [importList(1, 'Popular')] }),
      snapshot(2, 'Radarr-HD', { importLists: [] }),
      snapshot(3, 'Sonarr', { kind: 'sonarr', importLists: [] }),
      snapshot(9, 'Radarr-Down', { status: 'error' }),
    ];
    const row = buildImportListRows(fleet)[0];
    if (row === undefined) throw new Error('expected a row');

    const candidates = importListCloneCandidates(row, fleet);
    expect(candidates.map((entry) => entry.name)).toEqual(['Radarr-4K', 'Radarr-HD']);
    expect(candidates.find((entry) => entry.name === 'Radarr-4K')?.alreadyHas).toBe(true);
    expect(candidates.find((entry) => entry.name === 'Radarr-HD')?.alreadyHas).toBe(false);
    expect(canCloneImportList(row, fleet)).toBe(true);
  });

  it('hides the + when every same-kind instance already has the list', () => {
    const fleet = [
      snapshot(1, 'Radarr-4K', { importLists: [importList(1, 'Shared')] }),
      snapshot(2, 'Radarr-HD', { importLists: [importList(2, 'Shared')] }),
      snapshot(3, 'Sonarr', { kind: 'sonarr', importLists: [] }),
    ];
    const row = buildImportListRows(fleet)[0];
    if (row === undefined) throw new Error('expected a row');

    expect(canCloneImportList(row, fleet)).toBe(false);
  });
});

describe('chip and card copy', () => {
  it('puts on/off on the chip and the rest on the card, without drift language', () => {
    const fleet = [
      snapshot(1, 'Radarr-4K', {
        importLists: [
          importList(1, 'A', {
            enabled: true,
            enableAuto: true,
            rootFolderPath: '/data/media/movies-4k',
            qualityProfileId: 4,
          }),
        ],
        qualityProfiles: [{ id: 4, name: 'Ultra-HD' }],
      }),
    ];
    const row = buildImportListRows(fleet)[0];
    if (row === undefined) throw new Error('expected a row');
    const [on] = importListOwners(row, fleet);

    expect(ownerStateLabel(on!)).toEqual({ value: 'on', title: 'Enabled, automatic add on' });
    expect(on?.qualityProfileName).toBe('Ultra-HD');

    const facts = importListOwnerFacts(on!);
    expect(facts.map((fact) => fact.label)).toEqual(['State', 'Root folder', 'Profile']);
    expect(facts[1]).toMatchObject({ value: '/data/media/movies-4k', tone: 'normal', detail: [] });
    expect(facts[2]).toMatchObject({ value: 'Ultra-HD', tone: 'normal', detail: [] });
  });

  it('keeps a raw id when the instance has no matching profile, and none set when the id is 0', () => {
    const fleet = [
      snapshot(1, 'Radarr-4K', {
        importLists: [
          importList(1, 'A', { qualityProfileId: 9 }),
          importList(2, 'B', { qualityProfileId: 0 }),
        ],
        qualityProfiles: [{ id: 1, name: 'HD-1080p' }],
      }),
    ];
    const rows = buildImportListRows(fleet);
    const unknownRow = rows.find((row) => row.name === 'A');
    const unsetRow = rows.find((row) => row.name === 'B');
    if (unknownRow === undefined || unsetRow === undefined) throw new Error('expected both rows');

    const unknown = importListOwners(unknownRow, fleet)[0];
    const unset = importListOwners(unsetRow, fleet)[0];

    expect(importListOwnerFacts(unknown!)[2]).toMatchObject({ value: 'id 9', tone: 'muted' });
    expect(importListOwnerFacts(unset!)[2]).toMatchObject({ value: 'none set', tone: 'muted' });
  });
});
