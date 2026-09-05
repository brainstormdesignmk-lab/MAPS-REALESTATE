// maps-realestate: standalone geo stack.
//
// This is the geo-only shim of LINA's src/store/db.ts. The maps repo never
// hosts chats, appointments, owners or enrichment — it only needs:
//   • landmarks            — property_id-keyed landmark cache (upgrade-only tiers)
//   • geo_reresolve_queue  — deterministic async re-resolution queue
// Schema mirrors LINA v7 EXACTLY so a DB written here is readable by the bot
// and vice-versa (the sync contract: machines may run either repo against the
// same data/lina.db).
//
// Everything else (sessions, appointments, owners, ...) is intentionally
// absent — do not add bot tables here.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import * as path from 'path';

export class Db {
  readonly db: Database.Database;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      -- v7 schema: keyed by property_id (not address_key) — no two buildings
      -- collide. tier: feed|extract|google|osm_poi|osm_low_confidence —
      -- upgrade-only writes. No TTL — freshness comes from the monthly cron.
      CREATE TABLE IF NOT EXISTS landmarks (
        property_id  INTEGER PRIMARY KEY,
        landmark     TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT '',
        maps_url     TEXT,
        source       TEXT NOT NULL DEFAULT 'table',
        tier         TEXT,
        resolved_at  TEXT,
        nearby       TEXT   -- JSON array of top-3 nearby landmarks with coords
      );
      -- v7: geo re-resolve queue — properties that need a better center or a
      -- landmark re-pick (monthly refresh Phase C drains it).
      CREATE TABLE IF NOT EXISTS geo_reresolve_queue (
        property_id INTEGER PRIMARY KEY,
        reason      TEXT NOT NULL,   -- 'no_landmark'|'low_confidence_center'|'poison_sweep'|'no_trusted_center'
        created_at  INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}
