// SUSPECT-PAIRS REPORT (the doc's P16) — find rows in skopje-pois.db that are
// probably THE SAME PLACE under different identities, so the override list
// shrinks to true anomalies. Heuristics, pure-local, read-only:
//   1. Same place_id, different names (split identity — merge candidates)
//   2. Same normalized name, >50m apart (drifted duplicate)
//   3. Same phone (when captured), >50m apart (phone = identity evidence)
//   4. Near-identical names <30m apart with BOTH having place_id but differing
//      (two Google rows for one place — keep the one with more reviews)
// Output: a markdown report to stdout; --json for machine consumption.
// Usage:
//   npx tsx scripts/suspect-pairs.ts            # human report
//   npx tsx scripts/suspect-pairs.ts --json     # machine report
import '../src/compat/node16';
import Database from 'better-sqlite3';

const POIS_DB = process.env.SKOPJE_POIS_DB ?? 'data/skopje-pois.db';
const AS_JSON = process.argv.includes('--json');

interface Row {
  name: string; type: string; lat: number; lon: number; source?: string;
  place_id?: string | null; phone?: string | null; review_count?: number | null;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function main(): void {
  const db = new Database(POIS_DB, { readonly: true });
  // Schema-tolerant: a pre-capture DB has no phone/review_count columns —
  // select only what exists (those heuristics then simply don't fire).
  const cols = (db.prepare('PRAGMA table_info(pois)').all() as Array<{ name: string }>).map(c => c.name);
  const sel = ['name, type, lat, lon, source',
    cols.includes('place_id') ? 'place_id' : 'NULL AS place_id',
    cols.includes('phone') ? 'phone' : 'NULL AS phone',
    cols.includes('review_count') ? 'review_count' : 'NULL AS review_count',
  ].join(', ');
  const rows = db.prepare(`SELECT ${sel} FROM pois`).all() as Row[];
  db.close();

  // Bucket by coarse grid cell (~250m) so pair comparison is O(n·k), not O(n²).
  const cell = (lat: number, lon: number): string => `${Math.round(lat * 400)}:${Math.round(lon * 260)}`;
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const k = cell(r.lat, r.lon);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }

  const suspects: Array<{ kind: string; a: Row; b: Row; evidence: string }> = [];
  const seenPair = new Set<string>();
  const pairKey = (a: Row, b: Row): string => [a.name, b.name].sort().join('|') + Math.round(a.lat * 400) + Math.round(b.lat * 400);

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const d = distM(a, b);
        const key = pairKey(a, b);
        if (seenPair.has(key)) continue;

        // 1. Same place_id, different names — split identity
        if (a.place_id && b.place_id && a.place_id === b.place_id
          && normName(a.name) !== normName(b.name)) {
          seenPair.add(key);
          suspects.push({ kind: 'same-place_id-different-name', a, b, evidence: `place_id ${a.place_id}, ${d}m apart` });
          continue;
        }
        // 2. Same normalized name, drifted >50m
        if (normName(a.name) === normName(b.name) && d > 50) {
          seenPair.add(key);
          suspects.push({ kind: 'same-name-drifted', a, b, evidence: `${d}m apart` });
          continue;
        }
        // 3. Same phone (identity evidence), any name difference
        if (a.phone && b.phone && a.phone === b.phone
          && normName(a.name) !== normName(b.name) && d > 50) {
          seenPair.add(key);
          suspects.push({ kind: 'same-phone', a, b, evidence: `phone ${a.phone}, ${d}m apart` });
          continue;
        }
        // 4. Both Google-identified, <30m, same-ish name, different ids — pick by reviews
        if (a.place_id && b.place_id && a.place_id !== b.place_id && d < 30
          && (normName(a.name).includes(normName(b.name)) || normName(b.name).includes(normName(a.name)))) {
          seenPair.add(key);
          suspects.push({ kind: 'dual-identified-near', a, b, evidence: `${d}m apart, distinct ids — keep richer reviews` });
        }
      }
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ total: suspects.length, suspects }, null, 2));
    return;
  }
  console.log(`# Suspect pairs — ${POIS_DB}\n`);
  console.log(`Scanned ${rows.length} rows. Found ${suspects.length} suspect pair(s).\n`);
  const byKind = new Map<string, typeof suspects>();
  for (const s of suspects) {
    const arr = byKind.get(s.kind) ?? [];
    arr.push(s);
    byKind.set(s.kind, arr);
  }
  for (const [kind, list] of byKind) {
    console.log(`## ${kind} (${list.length})\n`);
    for (const s of list.slice(0, 40)) {
      console.log(`- "${s.a.name}" (${s.a.source ?? '?'}, ${s.a.review_count ?? '—'} rev) ↔ "${s.b.name}" (${s.b.source ?? '?'}, ${s.b.review_count ?? '—'} rev) — ${s.evidence}`);
    }
    if (list.length > 40) console.log(`- … and ${list.length - 40} more`);
    console.log('');
  }
  if (suspects.length === 0) console.log('Clean — no anomalies detected. The override list should hold only true anomalies.');
}

main();
