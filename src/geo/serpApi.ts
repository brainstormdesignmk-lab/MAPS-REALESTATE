/**
 * THE PAID SEARCH CLIENT — one implementation for every script that spends
 * SerpApi quota.
 *
 * There were two shapes of this in the scripts: `backfill-identity`'s rotation
 * loop and, about to be, the pin-drift review's copy. Quota is money, and a copy
 * of this loop is a copy of the pacing, the 429 handling, the key rotation and
 * the "a failed request is never billed" rule — four things that must not drift
 * apart between two callers hitting the same account.
 *
 * Rules kept from the original (all of them learned in the field):
 *   • `left === 0` means EXHAUSTED, `left === -1` means NOT YET PROBED — a
 *     client that has not probed must still try, or a script started without
 *     `probe()` silently spends nothing;
 *   • a 429 or a "run out / invalid / expired" error retires that key and moves
 *     to the next one; anything else that fails returns null (nothing billed);
 *   • a pinned worker (`keyOnly`) never borrows a sibling's quota — it stops.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The two places every paid script has always read keys from. */
export function loadSerpApiKeys(repoRoot: string): string[] {
  const keys: string[] = [];
  if (process.env.SERPAPI_KEY) keys.push(process.env.SERPAPI_KEY);
  const gmapsFile = path.join(repoRoot, 'GOOGLEMAPS_API_KEY.txt');
  const serpFile = path.join(repoRoot, 'data', 'serpapi-key.txt');
  for (const file of [serpFile, gmapsFile]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || /^[A-Z]/.test(t)) continue;
      if (/^[0-9a-f]{40,}$/i.test(t) && !keys.includes(t)) keys.push(t);
    }
  }
  return keys;
}

export interface SerpClientOptions {
  log?: (msg: string) => void;
  /** Pin this process to one key (a sharded worker). */
  keyOnly?: number | null;
}

export interface SerpClient {
  readonly keys: string[];
  readonly left: number[];
  /** Reads `plan_searches_left` per key. Call before `search()`. */
  probe(): Promise<void>;
  /** Searches used by this process so far. */
  readonly spent: number;
  /** One paced search. `null` = no key could serve it, nothing was billed. */
  search(query: string, ll: string): Promise<any | null>;
}

export function createSerpClient(keys: string[], opts: SerpClientOptions = {}): SerpClient {
  const log = opts.log ?? (() => {});
  const keyOnly = opts.keyOnly ?? null;
  const left: number[] = keys.map(() => -1);
  let keyIdx = 0;
  let spent = 0;

  const client: SerpClient = {
    keys,
    left,
    get spent() { return spent; },
    async probe(): Promise<void> {
      for (let i = 0; i < keys.length; i++) {
        try {
          const res = await fetch(`https://serpapi.com/account?api_key=${keys[i]}`);
          const data = await res.json() as { plan_searches_left?: number };
          left[i] = typeof data.plan_searches_left === 'number' ? data.plan_searches_left : 0;
        } catch {
          left[i] = 0;
        }
      }
    },
    async search(query: string, ll: string): Promise<any | null> {
      for (let attempt = 0; attempt < keys.length; attempt++) {
        if (keyOnly !== null) {
          if (left[keyOnly] === 0) return null;
          keyIdx = keyOnly;
        }
        const i = keyIdx % Math.max(1, keys.length);
        if (left[i] === 0) { keyIdx++; continue; }
        const url = `https://serpapi.com/search?engine=google_maps&type=search&q=${encodeURIComponent(query)}&hl=en&ll=${encodeURIComponent(ll)}&api_key=${keys[i]}`;
        let data: any = null;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30_000);
          const res = await fetch(url, { signal: ctrl.signal });
          clearTimeout(timer);
          if (res.status === 429) { left[i] = 0; keyIdx++; continue; }
          data = await res.json();
        } catch (e) {
          log(`  ⚠ request failed: ${(e as Error).message}`);
          return null;
        }
        const err = String(data?.error ?? '');
        if (/run out|invalid api key|expired/i.test(err)) {
          left[i] = 0;
          keyIdx++;
          continue;
        }
        if (err) { log(`  ⚠ SerpApi: ${err}`); return null; }
        if (left[i] > 0) left[i]--;
        spent++;
        keyIdx++;
        return data;
      }
      return null;
    },
  };
  return client;
}

/** Sum of `plan_searches_left` across keys (only meaningful after `probe()`). */
export function remainingLeft(client: SerpClient): number {
  return client.left.reduce((sum, n) => sum + Math.max(0, n), 0);
}
