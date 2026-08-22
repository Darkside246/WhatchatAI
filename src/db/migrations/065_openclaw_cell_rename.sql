-- Real-environment verification (this session, 2026-08-22) found that
-- `openclaw fleet` does not exist in the stable, pinned openclaw@2026.7.1-2
-- release - it is unreleased work living only in openclaw's own beta line
-- (2026.8.1-beta.*), which this platform will never deploy on. The prior
-- "Fleet" naming throughout this schema now describes a mechanism this
-- platform does not use and does not call - keeping it would be actively
-- misleading, not just imprecise, so this migration renames the table and
-- its "fleet_cell_id" columns to the neutral "cell"/"cell_id" naming the
-- new OpenClawCellRuntime abstraction uses. No production data exists
-- under the old names (no real cell has ever been created - Fleet was
-- never actually callable), so this is a clean rename, not a live
-- migration of real rows.
ALTER TABLE openclaw_fleet_cells RENAME TO openclaw_cells;
ALTER TABLE openclaw_cells RENAME COLUMN fleet_cell_id TO cell_id;
ALTER TABLE openclaw_tool_executions RENAME COLUMN fleet_cell_id TO cell_id;

ALTER INDEX idx_openclaw_fleet_cells_security_status RENAME TO idx_openclaw_cells_security_status;
