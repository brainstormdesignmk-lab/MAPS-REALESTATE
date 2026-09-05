#!/usr/bin/env npx tsx
// serve-backup.ts — Local REST server that mimics Supabase's PostgREST API.
// Reads from the backup lina.db + images directory created by backup.ts.
// Used as a fallback when Supabase is unreachable.
//
// Usage:
//   npx tsx scripts/serve-backup.ts                           # default port 3000
//   npx tsx scripts/serve-backup.ts 3001                      # custom port
//   BACKUP_DIR=/data/backup npx tsx scripts/serve-backup.ts   # custom dir

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import Database from 'better-sqlite3';

const BACKUP_DIR = process.argv[2] || process.env.BACKUP_DIR || '/home/metropolis2/Documents/NEKRETNINI_BACKUP/backup';
const PORT = Number(process.argv.find(a => /^\d+$/.test(a)) || process.env.BACKUP_PORT || 3000);
const DB_PATH = join(BACKUP_DIR, 'lina.db');
const IMAGES_DIR = join(BACKUP_DIR, 'images');

if (!existsSync(DB_PATH)) {
  console.error(`[serve-backup] Database not found: ${DB_PATH}`);
  console.error('Run `npx tsx scripts/backup.ts` first to create a backup.');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// MIME types for images
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

// Parse PostgREST-style query params: ?select=col1,col2&filter=eq.value&order=col.asc
function parsePostgrestParams(url: string) {
  const u = new URL(url, 'http://localhost');
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  return params;
}

// Apply PostgREST-style filters: is_published=eq.true, or=(...), limit=1
function buildWhereClause(params: Record<string, string>): { sql: string; binds: any[] } {
  const conditions: string[] = [];
  const binds: any[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
    if (key === 'or') {
      // or=(col1.is.null,col2.lte.2026-08-21) — PostgREST OR filter
      const inner = value.replace(/^\(|\)$/g, '');
      const parts = inner.split(',').map(p => {
        const [col, op, ...rest] = p.split('.');
        const val = rest.join('.');
        return buildCondition(col, op, val, binds);
      });
      conditions.push(`(${parts.join(' OR ')})`);
    } else {
      const [col, op, ...rest] = key.split('.');
      // The param key might be "is_published" and value "eq.true"
      if (op) {
        conditions.push(buildCondition(col, op, rest.join('.'), binds));
      } else {
        // key=value style: e.g., "is_published" = "eq.true"
        const val = value;
        if (val.startsWith('eq.')) {
          conditions.push(`"${key}" = ?`);
          binds.push(val.slice(3));
        } else if (val.startsWith('neq.')) {
          conditions.push(`"${key}" != ?`);
          binds.push(val.slice(4));
        } else if (val.startsWith('gt.')) {
          conditions.push(`"${key}" > ?`);
          binds.push(val.slice(3));
        } else if (val.startsWith('gte.')) {
          conditions.push(`"${key}" >= ?`);
          binds.push(val.slice(4));
        } else if (val.startsWith('lt.')) {
          conditions.push(`"${key}" < ?`);
          binds.push(val.slice(3));
        } else if (val.startsWith('lte.')) {
          conditions.push(`"${key}" <= ?`);
          binds.push(val.slice(4));
        } else if (val.startsWith('like.')) {
          conditions.push(`"${key}" LIKE ?`);
          binds.push(val.slice(5));
        } else if (val.startsWith('in.(')) {
          const list = val.slice(4, -1).split(',');
          const placeholders = list.map(() => '?').join(',');
          conditions.push(`"${key}" IN (${placeholders})`);
          binds.push(...list);
        } else {
          conditions.push(`"${key}" = ?`);
          binds.push(val);
        }
      }
    }
  }

  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', binds };
}

function buildCondition(col: string, op: string, val: string, binds: any[]): string {
  switch (op) {
    case 'eq': return `"${col}" = ?`; binds.push(val); // bind added in calling scope
    case 'neq': return `"${col}" != ?`;
    case 'gt': return `"${col}" > ?`;
    case 'gte': return `"${col}" >= ?`;
    case 'lt': return `"${col}" < ?`;
    case 'lte': return `"${col}" <= ?`;
    case 'like': return `"${col}" LIKE ?`;
    case 'is':
      if (val === 'null') return `"${col}" IS NULL`;
      if (val === 'true') return `"${col}" = 1`;
      if (val === 'false') return `"${col}" = 0`;
      return `"${col}" = ?`;
    default: return `"${col}" = ?`;
  }
}

function handleRestTable(table: string, req: IncomingMessage, res: ServerResponse) {
  const params = parsePostgrestParams(req.url || '');

  // Select columns
  const select = params.select || '*';
  // Order
  const order = params.order || '';
  // Limit / offset
  const limit = params.limit ? parseInt(params.limit) : undefined;
  const offset = params.offset ? parseInt(params.offset) : undefined;

  const { sql: where, binds } = buildWhereClause(params);

  let orderBy = '';
  if (order) {
    orderBy = 'ORDER BY ' + order.split(',').map(o => {
      const [col, dir] = o.split('.');
      return `"${col}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    }).join(', ');
  }

  let query = `SELECT ${select} FROM "${table}" ${where} ${orderBy}`;
  if (limit) query += ` LIMIT ${limit}`;
  if (offset) query += ` OFFSET ${offset}`;

  try {
    const rows = db.prepare(query).all(...binds);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Content-Range': `*/${rows.length}`,
    });
    res.end(JSON.stringify(rows));
  } catch (err: any) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// MIME type map for images
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

function handleStoragePath(storagePath: string, req: IncomingMessage, res: ServerResponse) {
  // storagePath like: property-images/{uuid}/{filename}.jpg or {number}/{filename}.jpg
  // Backup stores as: images/{property_number}/{filename}.jpg
  const relativePath = storagePath.replace(/^property-images\//, '');
  const parts = relativePath.split('/');
  const filename = parts.pop()!;
  const idOrNumber = parts.join('/');
  // Try direct path first (property number)
  let filePath = join(IMAGES_DIR, idOrNumber, filename);
  // If not found and looks like a UUID, look up property_number
  if (!existsSync(filePath) && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(idOrNumber)) {
    try {
      const row = db.prepare('SELECT property_number FROM properties WHERE id = ?').get(idOrNumber) as any;
      if (row?.property_number) {
        filePath = join(IMAGES_DIR, String(row.property_number), filename);
      }
    } catch { /* ignore */ }
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const mime = IMAGE_MIME[ext] || 'application/octet-stream';
  const data = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(data);
}

// Simple HTTP server mimicking Supabase REST + Storage
const server = createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  // Health check
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', backup: BACKUP_DIR }));
    return;
  }

  // Supabase REST API: /rest/v1/{table}?select=...&filter=...
  const restMatch = pathname.match(/^\/rest\/v1\/(.+)$/);
  if (restMatch) {
    const table = decodeURIComponent(restMatch[1].split('?')[0]);
    handleRestTable(table, req, res);
    return;
  }

  // Storage API: /storage/v1/object/public/{bucket}/{path}
  const storageMatch = pathname.match(/^\/storage\/v1\/object\/public\/(.+)$/);
  if (storageMatch) {
    const storagePath = decodeURIComponent(storageMatch[1]);
    handleStoragePath(storagePath, req, res);
    return;
  }

  // Fallback: proxy-style routes for direct property access
  // /property/{id} → redirect or serve
  if (pathname.startsWith('/property/')) {
    const id = pathname.split('/')[2];
    try {
      const row = db.prepare('SELECT * FROM properties WHERE id = ? OR property_number = ?').get(id, id);
      if (row) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(row));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'db error' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', routes: ['/rest/v1/{table}', '/storage/v1/object/public/{path}', '/property/{id}', '/health'] }));
});

server.listen(PORT, '0.0.0.0', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  const propCount = (db.prepare('SELECT COUNT(*) as n FROM properties').get() as any)?.n ?? 0;
  const imgCount = existsSync(join(IMAGES_DIR, 'property-images'))
    ? 'yes' : existsSync(IMAGES_DIR) ? 'check subdirs' : 'no images dir';
  console.log(`[serve-backup] Local Supabase fallback running on http://0.0.0.0:${PORT}`);
  console.log(`[serve-backup] Database: ${DB_PATH}`);
  console.log(`[serve-backup] Tables: ${tables.map((t: any) => t.name).join(', ')}`);
  console.log(`[serve-backup] Properties: ${propCount}`);
  console.log(`[serve-backup] Images: ${imgCount}`);
  console.log(`[serve-backup]`);
  console.log(`[serve-backup] Usage in edge functions:`);
  console.log(`[serve-backup]   Set LOCAL_BACKUP_URL=http://192.168.0.27:${PORT}`);
  console.log(`[serve-backup]   Edge functions will try Supabase first, then fall back to this server.`);
});
