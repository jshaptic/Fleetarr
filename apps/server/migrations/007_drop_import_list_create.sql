-- Fleetarr schema v7: importList.create is gone.
--
-- Copying a list onto another instance was removed from the product, so the op no longer
-- exists in QueueOpPayloads. That is not a cosmetic narrowing of the CHECK: rowToQueueItem
-- looks every stored op up in queuePayloadSchemas and THROWS on a miss, and GET /queue maps
-- every row including history. One surviving importList.create row would make the queue
-- endpoint fail for good - and the only cure, DELETE /queue, is unreachable behind a page
-- that cannot load. So the rows have to go, and once they do the CHECK may as well be
-- honest rather than have v8 copy a dead literal forward.
--
-- Foreign keys are OFF for the whole file (the runner toggles them outside the transaction
-- and runs foreign_key_check afterwards), so nothing cascades on its own: every reference
-- into the doomed rows is cleared by hand first, in this order.

-- The audit trail survives; only its link does. item_id is nullable, QueueEvent.itemId is
-- already `number | null`, and the run log reads by run_id - so a nulled event still
-- renders. Deleting the events instead would be the very cascade the runner guards against.
UPDATE queue_events
   SET item_id = NULL
 WHERE item_id IN (SELECT id FROM queue_items WHERE op = 'importList.create');

-- Nothing chains onto a clone in practice, but depends_on_id is a real self-reference.
-- Nulling it un-gates a dependent; deleting the dependent would destroy unrelated staged
-- work, and every remaining op carries its own ids in its payload.
UPDATE queue_items
   SET depends_on_id = NULL
 WHERE depends_on_id IN (SELECT id FROM queue_items WHERE op = 'importList.create');

DELETE FROM queue_items WHERE op = 'importList.create';

-- SQLite cannot edit a CHECK, so the table is rebuilt whole - as in v3, v5 and v6.
CREATE TABLE queue_items_v7 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    INTEGER          REFERENCES instances(id)   ON DELETE CASCADE,
  kind           TEXT    NOT NULL DEFAULT 'arr' CHECK (kind IN ('arr','fs')),
  run_id         INTEGER          REFERENCES queue_runs(id)  ON DELETE SET NULL,
  depends_on_id  INTEGER          REFERENCES queue_items_v7(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL,
  op             TEXT    NOT NULL CHECK (op IN (
                   'tag.create','tag.rename','tag.delete','tag.merge',
                   'mediaTags.add','mediaTags.remove','mediaTags.set',
                   'rootFolder.create','rootFolder.delete',
                   'media.moveRootFolder','media.refresh',
                   'media.setMonitored','media.setQualityProfile','media.delete',
                   'importList.update','importList.delete','importList.setEnabled',
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

INSERT INTO queue_items_v7 (
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
ALTER TABLE queue_items_v7 RENAME TO queue_items;

CREATE INDEX idx_queue_pending  ON queue_items(status, sort_order);
CREATE INDEX idx_queue_instance ON queue_items(instance_id, status);
CREATE INDEX idx_queue_run      ON queue_items(run_id);
CREATE INDEX idx_queue_kind     ON queue_items(kind, status);
