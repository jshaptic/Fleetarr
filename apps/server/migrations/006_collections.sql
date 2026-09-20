-- Fleetarr schema v6: Radarr collections.
--
-- A collection is a root folder consumer and a tag holder at once, so it has to be able to
-- appear in the queue. Four new ops - collection.update (the Radarr collection editor) and
-- collectionTags.add/remove/set - and the first new target_kind since v1, 'collection'.
--
-- Two tables are rebuilt in ONE file on purpose: a queue op the database will not store and
-- a snapshot resource it will not cache are one feature, and splitting them would permit a
-- half-applied state where collection.update inserts fail a CHECK while the collections
-- snapshot already writes.
--
-- SQLite cannot edit a CHECK, so each table is rebuilt whole. The migration runner disables
-- foreign keys around the pending batch, so dropping the old tables does not cascade
-- queue_events or the instances relationship away, and runs foreign_key_check afterwards.

CREATE TABLE queue_items_v6 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    INTEGER          REFERENCES instances(id)   ON DELETE CASCADE,
  kind           TEXT    NOT NULL DEFAULT 'arr' CHECK (kind IN ('arr','fs')),
  run_id         INTEGER          REFERENCES queue_runs(id)  ON DELETE SET NULL,
  depends_on_id  INTEGER          REFERENCES queue_items_v6(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL,
  op             TEXT    NOT NULL CHECK (op IN (
                   'tag.create','tag.rename','tag.delete','tag.merge',
                   'mediaTags.add','mediaTags.remove','mediaTags.set',
                   'rootFolder.create','rootFolder.delete',
                   'media.moveRootFolder','media.refresh',
                   'media.setMonitored','media.setQualityProfile','media.delete',
                   'importList.create','importList.update','importList.delete','importList.setEnabled',
                   'collection.update',
                   'collectionTags.add','collectionTags.remove','collectionTags.set',
                   'fs.mkdir','fs.rename','fs.move','fs.delete')),
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN (
                   'pending','running','succeeded','failed','skipped','cancelled')),
  target_kind    TEXT    NOT NULL CHECK (target_kind IN (
                   'tag','rootFolder','importList','collection','movie','series','path')),
  target_id      INTEGER,
  target_label   TEXT    NOT NULL,
  summary        TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  affected_count INTEGER NOT NULL DEFAULT 1,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT,
  error_message  TEXT,
  http_status    INTEGER,
  result         TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at     TEXT,
  finished_at    TEXT,
  CHECK ((kind = 'arr' AND instance_id IS NOT NULL) OR (kind = 'fs' AND instance_id IS NULL))
);

INSERT INTO queue_items_v6 (
  id, instance_id, kind, run_id, depends_on_id, sort_order, op, status, target_kind,
  target_id, target_label, summary, payload, affected_count, attempts, error_code,
  error_message, http_status, result, created_at, updated_at, started_at, finished_at
)
SELECT
  id, instance_id, kind, run_id, depends_on_id, sort_order, op, status, target_kind,
  target_id, target_label, summary, payload, affected_count, attempts, error_code,
  error_message, http_status, result, created_at, updated_at, started_at, finished_at
FROM queue_items;

DROP TABLE queue_items;
ALTER TABLE queue_items_v6 RENAME TO queue_items;

CREATE INDEX idx_queue_pending  ON queue_items(status, sort_order);
CREATE INDEX idx_queue_instance ON queue_items(instance_id, status);
CREATE INDEX idx_queue_run      ON queue_items(run_id);
CREATE INDEX idx_queue_kind     ON queue_items(kind, status);

-- The collections snapshot. Unlike importListMovie this payload is the VERBATIM body:
-- collectionTags.* round-trips it back through mergeForPut, which is exactly the case the
-- keep-raw rule exists for.

CREATE TABLE resource_snapshots_v6 (
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  resource    TEXT    NOT NULL CHECK (resource IN (
                'tag','tagDetail','rootFolder','importList','qualityProfile','media',
                'importListMovie','collection')),
  payload     TEXT    NOT NULL,   -- verbatim JSON array, except importListMovie
  fetched_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (instance_id, resource)
) WITHOUT ROWID;

INSERT INTO resource_snapshots_v6 (instance_id, resource, payload, fetched_at)
SELECT instance_id, resource, payload, fetched_at FROM resource_snapshots;

DROP TABLE resource_snapshots;
ALTER TABLE resource_snapshots_v6 RENAME TO resource_snapshots;
