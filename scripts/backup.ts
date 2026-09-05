#!/usr/bin/env npx tsx
// backup.ts — Full backup of Supabase FREEBUFF project to local storage.
// On-demand (not cron). Run manually when you want a snapshot.
//
// Usage:
//   npx tsx scripts/backup.ts                         # backup to default dir
//   npx tsx scripts/backup.ts /path/to/backup          # custom backup dir
//   BACKUP_DIR=/data/backup npx tsx scripts/backup.ts  # via env var

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'euuaycmxfqiruspwjxhd';
const BACKUP_DIR = process.argv[2] || process.env.BACKUP_DIR || '/home/metropolis2/Documents/NEKRETNINI_BACKUP/backup';
const REST_URL = `https://${PROJECT_REF}.supabase.co/rest/v1`;
const STORAGE_URL = `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/property-images`;
const DATE = new Date().toISOString();

const TABLES = [
  'properties',
  'property_images',
  'property_contacts',
  'customer_leads',
  'hermes_events',
  'landmark_resolution_log',
  'owner_lookup_log',
  'price_change_log',
  'price_changes',
  'profiles',
];

function getProjectKeys(): { anon: string; serviceRole: string } {
  const envAnon = process.env.SUPABASE_ANON_KEY || '';
  const envSvc = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (envAnon && envSvc) return { anon: envAnon, serviceRole: envSvc };
  try {
    const mgmtToken = readFileSync(`${process.env.HOME}/.supabase/access-token`, 'utf8').trim();
    const result = execSync(
      `curl -s "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys" -H "Authorization: Bearer ${mgmtToken}"`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const keys = JSON.parse(result);
    const anon = envAnon || keys.find((k: any) => k.name === 'anon')?.api_key || '';
    const serviceRole = envSvc || keys.find((k: any) => k.name === 'service_role')?.api_key || '';
    return { anon, serviceRole };
  } catch {
    return { anon: envAnon, serviceRole: envSvc };
  }
}

function curlJson(url: string, headers: Record<string, string> = {}): any {
  try {
    const headerStr = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
    const result = execSync(`curl -s "${url}" ${headerStr}`, { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(result);
  } catch {
    return [];
  }
}

function pullTable(table: string, apiKey: string): any[] {
  const allRows: any[] = [];
  let offset = 0;
  const limit = 1000;
  const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  while (true) {
    const batch = curlJson(
      `${REST_URL}/${table}?select=*&order=created_at&offset=${offset}&limit=${limit}`,
      headers
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    allRows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return allRows;
}

function downloadImages(images: any[], props: any[], anonKey: string): { downloaded: number; skipped: number; failed: number } {
  const imagesDir = join(BACKUP_DIR, 'images');
  mkdirSync(imagesDir, { recursive: true });

  const idToPn = new Map<string, string>();
  for (const p of props) idToPn.set(p.id || '', p.property_number || 'unknown');

  let downloaded = 0, skipped = 0, failed = 0;

  for (const img of images) {
    const imageUrl = img.image_url;
    if (!imageUrl) continue;

    const pn = idToPn.get(img.property_id) || img.property_id?.slice(0, 8) || 'unknown';
    const propDir = join(imagesDir, String(pn));
    mkdirSync(propDir, { recursive: true });

    const filename = imageUrl.split('/').pop()?.split('?')[0] || 'image.jpg';
    const dest = join(propDir, filename);

    if (existsSync(dest)) { skipped++; continue; }

    const fullUrl = imageUrl.startsWith('http') ? imageUrl : `${STORAGE_URL}/${imageUrl}`;
    try {
      execSync(`curl -sL -o "${dest}" "${fullUrl}"`, { timeout: 30000 });
      const stat = require('fs').statSync(dest);
      if (stat.size > 100) { downloaded++; } else { failed++; require('fs').unlinkSync(dest); }
    } catch { failed++; }
  }

  return { downloaded, skipped, failed };
}

function createSqlite(tables: Map<string, any[]>): void {
  const dbPath = join(BACKUP_DIR, 'lina.db');
  const db = new Database(dbPath);

  for (const [table, rows] of tables) {
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const colDefs = cols.map(c => `"${c}" TEXT`).join(', ');
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
    db.exec(`CREATE TABLE "${table}" (${colDefs})`);

    const placeholders = cols.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO "${table}" VALUES (${placeholders})`);
    const insertMany = db.transaction((rows: any[]) => {
      for (const row of rows) {
        insert.run(...cols.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          if (typeof v === 'object') return JSON.stringify(v);
          if (typeof v === 'boolean') return v ? 1 : 0;
          return v;
        }));
      }
    });
    insertMany(rows);

    // Create index on property_number for properties table
    if (table === 'properties') {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_properties_number ON properties(property_number)`);
    }
    if (table === 'property_images') {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_images_property ON property_images(property_id)`);
    }
  }

  db.close();
}

// --- Main ---
console.log('=== Supabase Full Backup ===');
console.log(`Project:   ${PROJECT_REF}`);
console.log(`Backup to: ${BACKUP_DIR}`);
console.log(`Date:      ${DATE}`);
console.log('');

mkdirSync(join(BACKUP_DIR, 'json'), { recursive: true });
mkdirSync(join(BACKUP_DIR, 'images'), { recursive: true });

const keys = getProjectKeys();
// Use service_role key to bypass RLS — it has full data access
const apiKey = keys.serviceRole || keys.anon;
if (!apiKey) {
  console.error('ERROR: No API access. Set SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY or ensure ~/.supabase/access-token exists.');
  process.exit(1);
}
console.log(`  API key: ${apiKey.substring(0, 20)}... (${keys.serviceRole ? 'service_role' : 'anon'})`);

// 1) Pull all tables
console.log('--- Pulling tables ---');
const tableData = new Map<string, any[]>();
let totalRows = 0;
for (const table of TABLES) {
  const rows = pullTable(table, apiKey);
  tableData.set(table, rows);
  const jsonPath = join(BACKUP_DIR, 'json', `${table}.json`);
  writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
  console.log(`  ${table}: ${rows.length} rows`);
  totalRows += rows.length;
}

// 2) Download images
console.log('');
console.log('--- Downloading images ---');
const images = tableData.get('property_images') || [];
const props = tableData.get('properties') || [];
const imgStats = downloadImages(images, props, apiKey);
console.log(`  Downloaded: ${imgStats.downloaded}, Skipped: ${imgStats.skipped}, Failed: ${imgStats.failed}`);

// 3) Create SQLite mirror
console.log('');
console.log('--- Creating local SQLite mirror ---');
createSqlite(tableData);
console.log(`  lina.db created (${TABLES.length} tables, ${totalRows} rows)`);

// 4) Write sync state
console.log('');
console.log('--- Writing sync state ---');
const state: any = {
  lastSync: DATE,
  projectRef: PROJECT_REF,
  backupDir: BACKUP_DIR,
  totalRows,
  tables: {},
};
for (const [table, rows] of tableData) {
  state.tables[table] = rows.length;
}
writeFileSync(join(BACKUP_DIR, 'sync-state.json'), JSON.stringify(state, null, 2));
console.log('  sync-state.json written');

// 5) Summary
console.log('');
console.log('=== Backup Complete ===');
console.log(`Location: ${BACKUP_DIR}`);
console.log(`Tables:   ${TABLES.length}`);
console.log(`Rows:     ${totalRows}`);
console.log(`Images:   ${imgStats.downloaded + imgStats.skipped} (${imgStats.downloaded} new)`);
console.log(`SQLite:   ${join(BACKUP_DIR, 'lina.db')}`);
console.log('');
console.log('To serve locally:');
console.log(`  cd ${BACKUP_DIR} && python3 -m http.server 3000`);
console.log('');
console.log('To restore to Supabase:');
console.log(`  npx tsx scripts/restore.ts ${BACKUP_DIR}`);
