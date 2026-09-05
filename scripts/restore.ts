#!/usr/bin/env npx tsx
// restore.ts — Push local backup back to Supabase.
// On-demand. Use when Supabase was down and you need to restore data.
//
// Usage:
//   npx tsx scripts/restore.ts /path/to/backup           # restore all tables
//   npx tsx scripts/restore.ts /path/to/backup properties # restore one table
//
// WARNING: This OVERWRITES the remote data. Always back up first.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'euuaycmxfqiruspwjxhd';
const BACKUP_DIR = process.argv[2];
const TABLE_FILTER = process.argv[3]; // optional: restore only one table
const REST_URL = `https://${PROJECT_REF}.supabase.co/rest/v1`;
const DATE = new Date().toISOString();

function getMgmtToken(): string {
  return readFileSync(`${process.env.HOME}/.supabase/access-token`, 'utf8').trim();
}

function upsertRows(table: string, rows: any[], token: string): number {
  if (rows.length === 0) return 0;

  // Batch in chunks of 100 (Supabase REST limit for bulk operations)
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const body = JSON.stringify(batch);
    try {
      execSync(
        `curl -s -X POST "${REST_URL}/${table}" ` +
        `-H "Authorization: Bearer ${token}" ` +
        `-H "apikey: ${token}" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Prefer: resolution=merge-duplicates" ` +
        `-d '${body.replace(/'/g, "'\\''")}'`,
        { encoding: 'utf8', timeout: 60000 }
      );
      upserted += batch.length;
    } catch (e) {
      console.error(`  ERROR upserting batch ${i}-${i + batch.length}: ${(e as Error).message}`);
    }
  }
  return upserted;
}

if (!BACKUP_DIR) {
  console.error('Usage: npx tsx scripts/restore.ts /path/to/backup [table]');
  process.exit(1);
}

const token = getMgmtToken();
console.log('=== Supabase Restore ===');
console.log(`Project:   ${PROJECT_REF}`);
console.log(`Backup:    ${BACKUP_DIR}`);
console.log(`Date:      ${DATE}`);
console.log('');

// Find all JSON files
const jsonDir = join(BACKUP_DIR, 'json');
const files = readdirSync(jsonDir).filter(f => f.endsWith('.json'));

let totalRestored = 0;
for (const file of files) {
  const table = file.replace('.json', '');
  if (TABLE_FILTER && table !== TABLE_FILTER) continue;

  const rows = JSON.parse(readFileSync(join(jsonDir, file), 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(`  ${table}: 0 rows (skipped)`);
    continue;
  }

  console.log(`  ${table}: restoring ${rows.length} rows...`);
  const count = upsertRows(table, rows, token);
  console.log(`  ${table}: ${count} rows upserted`);
  totalRestored += count;
}

console.log('');
console.log('=== Restore Complete ===');
console.log(`Total rows restored: ${totalRestored}`);
