// scripts/capture-place-urls.ts
//
// For every POI in the offline map whose `place_url` is still NULL, resolve
// Google's CANONICAL place URL (https://www.google.com/maps/place/<name>/data=...!1s<hex>...)
// via a warm headless Chrome, shorten it (keyless tinyurl), and store it.
//
// WHY: a "каде е?" landmark link must OPEN the landmark's place card. The bare
// `maps/@lat,lon,17z` view just centers the map (no landmark), and long/deep-
// linked forms get truncated by the client console. The stored short canonical
// is exactly what goo.gl shares expand to — the one format proven to survive.
//
// The request path NEVER uses this — network lives only here (scripts/).
// The script is idempotent: rows already having place_url are skipped, and
// failed lookups are left NULL for the next run.
//
// Usage:
//   npx tsx scripts/capture-place-urls.ts --limit 50            # google rows only, first 50
//   npx tsx scripts/capture-place-urls.ts --limit 50 --osm      # also OSM rows
//   npx tsx scripts/capture-place-urls.ts --name "ПЗУ Аптека Линцура 2"   # one exact row
//
// Requires: google-chrome on PATH (Chrome is installed on this workstation).
// Prefer to run right after `npm run map:pull` / the monthly refresh.

import '../src/compat/node16';

import * as http from 'http';
import * as https from 'https';
import { spawn, execFileSync } from 'child_process';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const POIS_DB = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
const CHROME = (process.env.CHROME_BIN ?? 'google-chrome');

// ── tinyurl — keyless URL shortener. Returns the short link or null. ────────
function shorten(url: string, retries = 2): Promise<string | null> {
  return new Promise((resolve) => {
    const doTry = (left: number) => {
      const req = https.get(
        'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(url),
        (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            const t = d.trim();
            resolve(/^https?:\/\/.+\..+$/.test(t) ? t : null);
          });
        },
      );
      req.setTimeout(8000, () => req.destroy());
      req.on('error', () => {
        if (left > 0) setTimeout(() => doTry(left - 1), 500);
        else resolve(null);
      });
    };
    doTry(retries);
  });
}

// ── Minimal CDP client over a raw WebSocket (Node built-ins only) ──────────
interface Cdp {
  call(method: string, params?: unknown): Promise<any>;
  on(method: string, cb: (p: any) => void): void;
  close(): void;
}

function rawWs(url: string, onMsg: (m: any) => void): Promise<{ send: (s: string) => void; close: () => void }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (_res, socket) => {
      let buf = Buffer.alloc(0);
      socket.on('error', reject);
      const send = (payload: string) => {
        const data = Buffer.from(payload, 'utf8');
        const mask = crypto.randomBytes(4);
        let hdr: Buffer;
        if (data.length < 126) hdr = Buffer.from([0x81, 0x80 | data.length]);
        else if (data.length < 65536) {
          hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(data.length, 2);
        } else {
          hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(data.length), 2);
        }
        const masked = Buffer.from(data);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        socket.write(Buffer.concat([hdr, mask, masked]));
      };
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          let maskKey: Buffer | null = null;
          if (masked) { maskKey = buf.subarray(off, off + 4); off += 4; }
          if (buf.length < off + len) break;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 1) {
            let text = payload.toString('utf8');
            if (maskKey) {
              const mm = Buffer.from(payload);
              for (let i = 0; i < mm.length; i++) mm[i] ^= maskKey[i % 4];
              text = mm.toString('utf8');
            }
            try { onMsg(JSON.parse(text)); } catch { /* non-JSON frame */ }
          } else if (op === 8) { socket.end(); }
        }
      });
      resolve({ send, close: () => { try { socket.end(); } catch {} } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function cdpConnect(port: number): Promise<Cdp> {
  const list = await new Promise<any[]>((res, rej) => {
    http.get(`http://127.0.0.1:${port}/json`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = await rawWs(page.webSocketDebuggerUrl, (m: any) => {
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); (m.error ? rej(new Error(m.error.message)) : res(m.result)); }
    else if (m.method && listeners.has(m.method)) { for (const cb of listeners.get(m.method)!) { try { cb(m.params); } catch {} } }
  });
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, Array<(p: any) => void>>();
  let id = 0;
  const call = (method: string, params: unknown = {}) => new Promise<any>((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return {
    call,
    on: (method, cb) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method)!.push(cb); },
    close: () => ws.close(),
  };
}

// ── render the search page and pull the canonical place URL ────────────────
async function canonicalPlaceUrl(cdp: Cdp, name: string, _lat: number, _lon: number): Promise<string | null> {
  const q = encodeURIComponent(`${name}, Скопје`);
  await cdp.call('Page.navigate', { url: `https://www.google.com/maps/search/?api=1&query=${q}` });
  // The canonical URL is NOT a plain anchor: Google renders it inside a
  // login/continue wrapper whose href is percent-encoded. So we decode every
  // anchor href and look for one carrying BOTH the hex place id (!1s0x) and
  // the feature id (!16s) inside a /maps/place/ path. Both ids are required:
  // without !16s the URL opens the map but NOT the place card (verified).
  // The canonical URL is embedded percent-encoded in the rendered DOM (inside
  // a /maps/place/ continue-wrapper). Rather than fight anchor timing, we poll
  // the RAW outerHTML for the hex place-id token (!1s0x) — the same token that
  // always coexists with the full canonical — then return a window around it
  // for Node to parse. Deterministic across loads.
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    const res = await cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const html = document.documentElement.outerHTML;
        const i = html.indexOf('!1s0x');
        if (i === -1) return null;
        const start = Math.max(0, i - 900);
        return html.slice(start, i + 300);
      })()`,
      returnByValue: true,
    });
    const v = res?.result?.value;
    if (process.env.CAPTURE_DEBUG) {
      const title = res?.result?.value ? null : ((await cdp.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }))?.result?.value);
      console.error('[cap-debug] iter token=' + (typeof v === 'string' && v.indexOf('!1s0x') !== -1) + ' vlen=' + (typeof v === 'string' ? v.length : 'n/a') + ' title=' + JSON.stringify(title));
    }
    if (v && typeof v === 'string' && v.indexOf('!1s0x') !== -1) {
      const marker = 'https://www.google.com/maps/place/';
      // The canonical is the `continue=` value of the login wrapper:
      //   href="https://accounts.google.com/ServiceLogin?...&continue=https%3A%2F%2Fwww.google.com%2Fmaps%2Fplace%2F<enc-name>%2F@lat,lon,17z%2Fdata%3D...!1s0x...!16s...&service=local&..."
      // The wrapper's separators are &amp; (entity-serialized), so a raw '&'
      // search is unreliable. The canonical itself never contains a literal
      // '?' — the first '?' after `continue=` is the ?ved= tracking split —
      // so: locate the encoded marker, slice from after `continue=`, cut at '?'.
      const enc = v.indexOf('continue=https%3A%2F%2Fwww.google.com%2Fmaps%2Fplace');
      if (enc === -1) continue;
      let encUrl = v.slice(enc + 'continue='.length);
      const qCut = encUrl.indexOf('?');
      const aCut = encUrl.indexOf('&');
      const cut = aCut === -1 ? qCut : (qCut === -1 ? aCut : Math.min(qCut, aCut));
      if (cut > 0) encUrl = encUrl.slice(0, cut);
      // Decode ONCE: the wrapper double-encodes, so one decode gives the
      // canonical with the name percent-encoded and the data tokens intact.
      let canon = decodeURIComponent(encUrl);
      const mi = canon.indexOf(marker);
      if (mi >= 0) canon = canon.slice(mi);
      const at = canon.indexOf('/@');
      if (at > marker.length && canon.indexOf('!1s0x') !== -1 && canon.indexOf('!16s') !== -1) {
        // The name is still percent-encoded from the decode pass → send it
        // through URL construction: parse and re-serialize the place URL.
        const namePart = canon.slice(marker.length, at).trim();
        const rest = canon.slice(at);
        const decodedName = decodeURIComponent(namePart);
        // The wrapper encodes spaces as '+' — turn them into real spaces.
        const cleanName = decodedName.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanName.length > 1) {
          return marker + encodeURIComponent(cleanName).replace(/%20/g, '+') + rest;
        }
      }
    }
  }
  return null;
}

// ── launch Chrome with a fresh profile, return CDP port ────────────────────
function launchChrome(): Promise<number> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
    const port = 9300 + Math.floor(Math.random() * 500);
    const proc = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
      '--window-size=640,800', 'about:blank',
    ], { stdio: 'ignore' });
    let tried = 0;
    const iv = setInterval(() => {
      tried++;
      http.get(`http://127.0.0.1:${port}/json/version`, r => { r.resume(); r.on('end', () => { clearInterval(iv); resolve(port); }); })
        .on('error', () => {
          if (tried > 120 || proc.exitCode !== null) { // ~36s budget
            clearInterval(iv);
            try { proc.kill('SIGKILL'); } catch {}
            reject(new Error('chrome did not open CDP port'));
          }
        });
    }, 300);
  });
}

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const limit = parseInt(arg('--limit') ?? '0', 10) || 0;
  const includeOsm = process.argv.includes('--osm');
  const onlyName = arg('--name');

  const db = new Database(POIS_DB);
  // Column may already exist (fresh map builds include it) — make it idempotent.
  const cols = db.prepare('PRAGMA table_info(pois)').all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'place_url')) {
    db.exec('ALTER TABLE pois ADD COLUMN place_url TEXT');
    console.log('[capture] added place_url column');
  }

  let rows: Array<{ name: string; lat: number; lon: number; source: string }>;
  if (onlyName) {
    rows = db.prepare('SELECT name, lat, lon, source FROM pois WHERE name = ?').all(onlyName) as any;
  } else {
    const sourceFilter = includeOsm ? '' : "AND source = 'google'";
    rows = db.prepare(
      `SELECT name, lat, lon, source FROM pois WHERE (place_url IS NULL OR place_url = '') ${sourceFilter} ORDER BY name LIMIT ?`
    ).all(limit || 1_000_000) as any;
  }
  console.log(`[capture] ${rows.length} rows to resolve (${onlyName ? 'named' : includeOsm ? 'google+osm' : 'google-only'}) in ${POIS_DB}`);
  if (rows.length === 0) { db.close(); return; }

  let chrome: any;
  try { chrome = execFileSync('which', [CHROME]).toString().trim(); } catch { throw new Error('google-chrome not found'); }
  const port = await launchChrome();
  const cdp = await cdpConnect(port);
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');

  let done = 0, failed = 0, shortened = 0, storedCanonical = 0;
  const update = db.prepare('UPDATE pois SET place_url = ? WHERE name = ? AND lat = ? AND lon = ?');

  for (const r of rows) {
    done++;
    process.stdout.write(`\r[capture] ${done}/${rows.length} — ${r.name.slice(0, 40)}`);
    try {
      const canon = await canonicalPlaceUrl(cdp, r.name, r.lat, r.lon);
      if (canon) {
        const short = await shorten(canon);
        if (short) { update.run(short, r.name, r.lat, r.lon); shortened++; }
        else { update.run(canon, r.name, r.lat, r.lon); storedCanonical++; } // shortener down — keep the full canonical
      } else {
        failed++;
      }
      await new Promise(res => setTimeout(res, 250)); // be gentle
    } catch (e) {
      failed++;
      console.error(`\n[capture] error on ${r.name}: ${(e as Error).message}`);
    }
  }

  console.log(`\n[capture] done: ${done} rows, ${shortened} shortened, ${storedCanonical} canonical-only, ${failed} unresolved`);
  cdp.close();
  db.close();
  process.exit(0);
}

main().catch(e => { console.error('[capture] fatal:', e); process.exit(1); });