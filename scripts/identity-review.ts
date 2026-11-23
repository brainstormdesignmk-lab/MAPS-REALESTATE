/**
 * REVIEW THE IDENTITY BACKFILL'S REFUSALS — and settle which side holds the
 * wrong point.
 *
 * Every refusal the backfill recorded is a row the map still serves WITHOUT a
 * Google identity: no reviews, no rating, no closed flag. The strict rule
 * refuses for good reasons, but "too far" is ambiguous — either the map's row
 * sits in the wrong place, or Google's answer is a different branch of a chain
 * and refusing was right. Only evidence separates them, and the map already
 * holds most of it: `addresses` (OSM house numbers) is a third witness beside
 * the two pins.
 *
 * So the review decides from FREE evidence first (`decideFree` in
 * `src/geo/identityReview.ts`):
 *
 *   covered       an identified row 0–200 m already carries the place
 *   branch        the candidate's name is already a known row elsewhere
 *   generic-name  the two names share only a KIND word (café, market, mosque)
 *   corroborated  a house number sits within 40 m of the row's pin
 *   unanchored    none of the above — the only rows where a search buys anything
 *
 *   npx tsx scripts/identity-review.ts             # free adjudication
 *   npx tsx scripts/identity-review.ts --write     # + data/identity-class-review.md
 *   npx tsx scripts/identity-review.ts --verify    # one paid search per unanchored row
 *   npx tsx scripts/identity-review.ts --verify --cap=10 --name=Магли
 *
 * `--verify` re-searches ONLY the unanchored rows, records the candidate's
 * type/position/address back into the refusal ledger (so no second run has to
 * buy it again), and prints ready-to-paste `pinfixes` entries for the rows where
 * the address disagrees with the map's pin. Nothing is written to the map by
 * this script.
 */
import '../src/compat/node16';

import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { REPO_ROOT, resolveMapDb } from '../src/geo/runtimeDb';
import { capturePoi } from '../src/geo/serpCapture';
import { createSerpClient, loadSerpApiKeys, remainingLeft } from '../src/geo/serpApi';
import { distM } from '../src/geo/precision';
import { identityKey, samePlaceName, samePlacePoi, streetKey, type MergedPoi } from '../src/geo/offlineMap';
import {
  decideFree, decideVerified, parseGoogleAddress,
  type AddressPoint, type DriftCandidate, type DriftDecision, type DriftRow, type FreeWitness,
} from '../src/geo/identityReview';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

const ARGV = process.argv.slice(2);
const has = (flag: string) => ARGV.includes(flag);
const val = (flag: string): string | undefined => {
  const hit = ARGV.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
};
const WRITE = has('--write');
const VERIFY = has('--verify');
const CAP = val('--cap') ? parseInt(val('--cap')!, 10) : Infinity;
const NAME = val('--name');

const DATA = path.join(REPO_ROOT, 'data');

interface Miss {
  attempts: number; why: string; candidate: string; last: string;
  candidateType?: string | null; candidateAddress?: string | null;
  candidateLat?: number | null; candidateLon?: number | null;
  movedM?: number; placeId?: string | null;
}
interface Row {
  rowid: number; name: string; type: string; lat: number; lon: number;
  place_id: string | null;
}
interface Addr { street: string; housenumber: string; lat: number; lon: number; key: string }

/** The ledger is sharded by worker; the newest record for a row wins. */
function readLedger(): Map<number, { miss: Miss; file: string }> {
  const merged = new Map<number, { miss: Miss; file: string }>();
  for (const f of fs.readdirSync(DATA)) {
    if (!/^identity-backfill-misses.*\.json$/.test(f)) continue;
    let parsed: Record<string, Miss>;
    try { parsed = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) as Record<string, Miss>; }
    catch { continue; }
    for (const [id, miss] of Object.entries(parsed)) {
      const rowid = Number(id);
      if (!Number.isFinite(rowid) || !miss?.why) continue;
      const prev = merged.get(rowid);
      if (!prev || String(miss.last ?? '') >= String(prev.miss.last ?? '')) {
        merged.set(rowid, { miss, file: f });
      }
    }
  }
  return merged;
}

function nearestAddress(addresses: Addr[], lat: number, lon: number): { d: number; at: Addr } | null {
  let best: { d: number; at: Addr } | null = null;
  for (const a of addresses) {
    // An address WITHOUT a house number identifies no building — the fabric
    // carries «Булевар Србија» with an empty number, and counting that as an
    // anchor "corroborated" every pin on the boulevard for free.
    if (!String(a.housenumber ?? '').trim()) continue;
    // Cheap prefilter: 0.01° ≈ 1 km, and no candidate is further than that.
    if (Math.abs(a.lat - lat) > 0.02 || Math.abs(a.lon - lon) > 0.02) continue;
    const d = distM(lat, lon, a.lat, a.lon);
    if (!best || d < best.d) best = { d, at: a };
  }
  return best;
}

const fmt = (d: number): string => `${Math.round(d)}m`;

/** Google's stated address → the house number in OUR fabric → a coordinate.
 *  Null when the candidate names no resolvable house number, which is the
 *  common case and the honest answer. */
function resolveAddressPoint(addresses: Addr[], candidate: DriftCandidate, row: DriftRow): AddressPoint | null {
  if (candidate.lat == null || candidate.lon == null) return null;
  const parsed = parseGoogleAddress(candidate.address);
  if (!parsed) return null;
  const key = streetKey(parsed.street);
  const hit = addresses.find(a => (a.key || streetKey(a.street)) === key
    && String(a.housenumber ?? '').toLowerCase() === parsed.number);
  if (!hit) return null;
  return {
    street: hit.street, housenumber: hit.housenumber, lat: hit.lat, lon: hit.lon,
    d: distM(candidate.lat, candidate.lon, hit.lat, hit.lon),
    fromMapPinM: distM(row.lat, row.lon, hit.lat, hit.lon),
  };
}

async function main(): Promise<void> {
  const resolved = resolveMapDb();
  const dbFile = resolved?.file ?? path.join(DATA, 'skopje-pois.db');
  if (!fs.existsSync(dbFile)) { console.error(`Map DB not found: ${dbFile}`); process.exit(1); }
  const db = new Database(dbFile, { readonly: true });
  const all = db.prepare('SELECT rowid, name, type, lat, lon, place_id FROM pois').all() as Row[];
  const addresses = db.prepare('SELECT street, housenumber, lat, lon, key FROM addresses').all() as Addr[];
  const byId = new Map(all.map(r => [r.rowid, r]));
  db.close();

  const ledger = readLedger();
  const byWhy = new Map<string, number>();
  /** too-far whose NAMES agree — the pin-drift candidates a human must rule on. */
  const drift: Array<{ row: Row; miss: Miss; file: string }> = [];
  let gone = 0;
  for (const [rowid, { miss, file }] of ledger) {
    byWhy.set(miss.why, (byWhy.get(miss.why) ?? 0) + 1);
    const row = byId.get(rowid);
    if (!row) { gone++; continue; }
    if (miss.why !== 'too-far') continue;
    if (samePlaceName(row.name, miss.candidate, 0, false, true).same) drift.push({ row, miss, file });
  }

  const identified = all.filter(r => r.place_id);
  const decisions = drift.map(d => {
    // A twin is a row the identity rule says is THE SAME PLACE — distance alone
    // proved nothing: «Betty» was "covered" by the pharmacy next door at 4 m,
    // which is exactly the false agreement the strict accept rule exists to stop.
    const here: MergedPoi = { name: d.row.name, type: d.row.type, lat: d.row.lat, lon: d.row.lon, dist: 0 };
    const twins = identified
      .filter(r => r.rowid !== d.row.rowid && Math.abs(r.lat - d.row.lat) <= 0.004 && Math.abs(r.lon - d.row.lon) <= 0.006)
      .filter(r => samePlacePoi(here, {
        name: r.name, type: r.type, lat: r.lat, lon: r.lon,
        dist: distM(here.lat, here.lon, r.lat, r.lon), place_id: r.place_id ?? undefined,
      }).same)
      .map(r => ({ name: r.name, d: distM(d.row.lat, d.row.lon, r.lat, r.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    const candKey = identityKey(d.miss.candidate);
    const branchRow = identified
      .filter(r => r.rowid !== d.row.rowid && identityKey(r.name) === candKey && Array.from(new Set(candKey.split(' '))).length > 0)
      .map(r => ({ name: r.name, d: distM(d.row.lat, d.row.lon, r.lat, r.lon) }))
      .sort((a, b) => a.d - b.d)[0];
    const near = nearestAddress(addresses, d.row.lat, d.row.lon);
    const witness: FreeWitness = {
      twins,
      branch: branchRow && branchRow.d > 200 ? branchRow : null,
      nearestAddressM: near ? near.d : null,
      nearestAddress: near ? { street: near.at.street, housenumber: near.at.housenumber } : null,
    };
    const candidate: DriftCandidate = {
      name: d.miss.candidate,
      type: d.miss.candidateType ?? null,
      lat: d.miss.candidateLat ?? null,
      lon: d.miss.candidateLon ?? null,
      address: d.miss.candidateAddress ?? null,
      placeId: d.miss.placeId ?? null,
    };
    // EVIDENCE ONCE PAID FOR IS NEVER BOUGHT AGAIN: a row whose ledger entry
    // carries the candidate's position and address is adjudicated right here,
    // with no network. `--verify` then only has work for rows that never had a
    // witness recorded.
    const evidence = candidate.lat != null && candidate.lon != null;
    const freeDecision = decideFree(d.row, candidate, witness);
    const decision = evidence && freeDecision.action === 'verify'
      ? decideVerified(d.row, candidate, witness, resolveAddressPoint(addresses, candidate, d.row))
      : freeDecision;
    return { ...d, witness, candidate, evidence, decision };
  });

  console.log('=== identity backfill — refusal review ===');
  console.log(`refusals on record: ${ledger.size}` + (gone ? ` (${gone} rows since merged/healed — nothing to review)` : ''));
  for (const [why, n] of [...byWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${why}: ${n}`);
  const byAction = new Map<string, number>();
  for (const d of decisions) byAction.set(d.decision.reason, (byAction.get(d.decision.reason) ?? 0) + 1);
  console.log('');
  console.log(`pin-drift candidates (names agree, distance refused): ${decisions.length}`);
  for (const [reason, n] of [...byAction].sort((a, b) => b[1] - a[1])) console.log(`  ${reason}: ${n}`);
  console.log('');
  for (const d of decisions.sort((a, b) => a.row.name.localeCompare(b.row.name))) {
    const tag = d.decision.action === 'verify' ? 'SEARCH' : 'settled';
    console.log(`  [${tag}] ${d.row.name} (${d.row.type}) ⇄ «${d.miss.candidate}» — ${d.decision.detail}`);
  }

  const paid = VERIFY ? await verifyPass(decisions) : [];

  if (WRITE) writeReport([...decisions, ...paid], { ledger: ledger.size, gone, byWhy });
  if (VERIFY && paid.length === 0 && decisions.some(d => d.decision.action === 'verify')) process.exit(1);
}

type Reviewed = {
  row: Row; miss: Miss; file: string; witness: FreeWitness;
  candidate: DriftCandidate; decision: DriftDecision;
  /** The ledger already holds the candidate's position + address. */
  evidence?: boolean;
};

/** One search per unanchored row; the verdict is written by the address. */
async function verifyPass(rows: Reviewed[]): Promise<Reviewed[]> {
  const queue = rows.filter(r => r.decision.action === 'verify' && !r.evidence && (!NAME || r.row.name.includes(NAME))).slice(0, CAP);
  if (queue.length === 0) { console.log('\n--verify: nothing unanchored to search'); return []; }
  const keys = loadSerpApiKeys(REPO_ROOT);
  if (keys.length === 0) { console.error('✗ no SerpApi keys on disk — nothing searched'); process.exit(1); }
  const client = createSerpClient(keys, { log: console.log });
  console.log(`\n--verify: ${queue.length} unanchored row(s), ${keys.length} key(s)`);

  // The address fabric is needed again here (resolve Google's address to a point).
  const db = new Database((resolveMapDb()?.file ?? path.join(DATA, 'skopje-pois.db')), { readonly: true });
  const addresses = db.prepare('SELECT street, housenumber, lat, lon, key FROM addresses').all() as Addr[];
  db.close();

  await client.probe();
    console.log(`budget: ${remainingLeft(client)} search(es) left`);
    const ledgerEdits = new Map<string, Record<string, Miss>>();
    const fixes: Array<{ row: Row; decision: DriftDecision }> = [];
    const decided: Reviewed[] = [];
    for (const [i, r] of queue.entries()) {
      const data = await client.search(`${r.row.name}, Скопје`, `@${r.row.lat},${r.row.lon},15z`);
      if (!data) { console.log(`  ✗ ${r.row.name}: no response (not billed)`); continue; }
      const raw = data?.local_results ?? data?.place_results ?? [];
      const list: any[] = Array.isArray(raw) ? raw : (raw?.title ? [raw] : []);
      const cap = list.map(x => capturePoi(x, r.row.type)).find(Boolean);
      if (!cap) { console.log(`  ✗ ${r.row.name}: no usable candidate`); continue; }
      const addr = resolveAddressPoint(addresses, {
        name: cap.name, lat: cap.lat, lon: cap.lon, address: cap.address,
      }, r.row);
      const witness: FreeWitness = {
        ...r.witness,
        nearestAddressM: (() => {
          let best: number | null = null;
          for (const a of addresses) {
            if (!String(a.housenumber ?? '').trim()) continue;
            if (Math.abs(a.lat - r.row.lat) > 0.02 || Math.abs(a.lon - r.row.lon) > 0.02) continue;
            const d = distM(r.row.lat, r.row.lon, a.lat, a.lon);
            if (best == null || d < best) best = d;
          }
          return best;
        })(),
      };
      const refreshed: DriftCandidate = {
        name: cap.name, type: cap.type, lat: cap.lat, lon: cap.lon, address: cap.address, placeId: cap.place_id,
      };
      const decision = decideVerified(r.row, refreshed, witness, addr);
      decided.push({ ...r, candidate: refreshed, witness, decision });

      // Record the witness in the ledger: the next review of this row is free.
      const shard = ledgerEdits.get(r.file) ?? (() => {
        const parsedFile = JSON.parse(fs.readFileSync(path.join(DATA, r.file), 'utf8')) as Record<string, Miss>;
        ledgerEdits.set(r.file, parsedFile);
        return parsedFile;
      })();
      shard[String(r.row.rowid)] = {
        ...(shard[String(r.row.rowid)] ?? r.miss),
        attempts: r.miss.attempts,
        why: r.miss.why,
        candidate: cap.name,
        last: new Date().toISOString(),
        candidateType: cap.type ?? null,
        candidateAddress: cap.address ?? null,
        candidateLat: cap.lat ?? null,
        candidateLon: cap.lon ?? null,
        movedM: cap.lat != null && cap.lon != null ? Math.round(distM(r.row.lat, r.row.lon, cap.lat, cap.lon)) : undefined,
        placeId: cap.place_id ?? null,
      };

      const moved = cap.lat != null && cap.lon != null ? fmt(distM(r.row.lat, r.row.lon, cap.lat, cap.lon)) : 'no position';
      console.log(`  [${i + 1}/${queue.length}] ${r.row.name} ⇄ «${cap.name}» (${cap.type}) ${moved}`
        + `${cap.address ? ` · ${cap.address}` : ''}`);
      console.log(`        → ${decision.action} (${decision.reason}): ${decision.detail}`);
      if (decision.action === 'fix-pin') fixes.push({ row: r.row, decision });
      await new Promise(res => setTimeout(res, 1100));
    }

    for (const [file, body] of ledgerEdits) {
      fs.writeFileSync(path.join(DATA, file), `${JSON.stringify(body, null, 2)}\n`);
    }
    if (fixes.length > 0) {
      console.log('\n── pinfixes for data/address-overrides.json (review before applying) ──');
      console.log(JSON.stringify({
        pinfixes: fixes.map(f => ({
          name: f.row.name, lat: +f.decision.to!.lat.toFixed(6), lon: +f.decision.to!.lon.toFixed(6),
          why: f.decision.detail,
        })),
      }, null, 2));
    } else {
      console.log('\nno pin needs to move — every unanchored row\'s own address agreed with it');
    }
    console.log(`\nspent ${client.spent} search(es); ${remainingLeft(client)} left`);
    return decided;
}

function writeReport(
  decisions: Reviewed[],
  meta: { ledger: number; gone: number; byWhy: Map<string, number> },
): void {
  const out = path.join(DATA, 'identity-class-review.md');
  const byReason = new Map<string, number>();
  for (const d of decisions) byReason.set(d.decision.reason, (byReason.get(d.decision.reason) ?? 0) + 1);
  const lines = [
    '# Identity backfill — refusal review',
    '',
    `Generated ${new Date().toISOString()} from the refusal ledger.`,
    '',
    `- refusals on record: **${meta.ledger}**` + (meta.gone ? ` (${meta.gone} rows merged/healed since — ignore)` : ''),
    ...([...meta.byWhy].sort((a, b) => b[1] - a[1]).map(([why, n]) => `- ${why}: **${n}**`)),
    '',
    `## Pin-drift candidates — names agree, distance refused (${decisions.length})`,
    '',
    'Adjudicated from free map evidence; only `unanchored` rows justify a paid search.',
    '',
    ...([...byReason].sort((a, b) => b[1] - a[1]).map(([why, n]) => `- ${why}: **${n}**`)),
    '',
    '| row | type | map point | Google candidate | verdict |',
    '| --- | --- | --- | --- | --- |',
    ...decisions.map(d => `| ${d.row.name} | ${d.row.type} | ${d.row.lat.toFixed(5)}/${d.row.lon.toFixed(5)} | ${d.miss.candidate} | ${d.decision.action} — ${d.decision.reason}: ${d.decision.detail} |`),
    '',
  ];
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`\nreport: ${out}`);
}

main().catch(e => { console.error(`✗ ${(e as Error).message}`); process.exit(2); });
