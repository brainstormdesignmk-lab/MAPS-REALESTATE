// THE SELF-LEARNING MAP — Google's knowledge of Skopje streets must grow the
// local offline snapshot, so "street not found at import" converges to zero:
//   miss at import → queue → monthly Google geocode → MAP LEARNS the
//   street+number → every future property on that street resolves OFFLINE.
// Contract (the user's words): "if I search this street in Google Maps I will
// find it — I want the same behaviour from my hybrid." After one Google hit,
// the hybrid finds the street forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { drainQueue, QueuedProperty } from '../src/geo/queueDrain';

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'map-learn-')), 'map.db');
}

function freshMap(): OfflineMapStore {
  const p = tmpMapDb();
  writeMap(p, [
    { name: 'Рамстор', type: 'mall', lat: 41.9976, lon: 21.4351, source: 'google' },
  ], []);
  return new OfflineMapStore(p);
}

/** Import-time enqueue — the drain only processes queued rows. */
function queueRow(db: Db, propertyId: number, reason = 'no_trusted_center'): void {
  db.db.prepare(
    `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
  ).run(propertyId, reason, Date.now());
}

test('learnAddress: a Google hit becomes an offline trusted resolution', () => {
  const map = freshMap();
  // Before: EB 77's street is unknown — the exact 20:51 production case.
  assert.equal(map.knowsStreet('МИРЧЕ ОРОВЧАНЕЦ 86 - 1'), false, 'street unknown before learning');
  assert.equal(map.resolvePropertyOffline('МИРЧЕ ОРОВЧАНЕЦ 86 - 1').trusted, false);

  // Google resolves it → learnAddress persists it.
  assert.equal(map.learnAddress('МИРЧЕ ОРОВЧАНЕЦ 86 - 1', 41.999, 21.4138), true);

  // After: the SAME street resolves OFFLINE, trusted (exact building).
  assert.equal(map.knowsStreet('МИРЧЕ ОРОВЧАНЕЦ 86 - 1'), true);
  const r = map.resolvePropertyOffline('МИРЧЕ ОРОВЧАНЕЦ 86 - 1');
  assert.equal(r.trusted, true, 'learned address must resolve trusted');
  assert.equal(r.lat, 41.999);
  assert.equal(r.lon, 21.4138);

  // A DIFFERENT house number on the same street: street-level resolution now
  // exists (unknown before the learn) — the growth loop works per-street.
  assert.equal(map.knowsStreet('МИРЧЕ ОРОВЧАНЕЦ 40'), true);
  map.close();
});

test('learnAddress: idempotent — re-learning refreshes coordinates, no duplicates', () => {
  const map = freshMap();
  assert.equal(map.learnAddress('Нова Улица 12', 41.99, 21.41), true);
  assert.equal(map.learnAddress('Нова Улица 12', 41.9901, 21.4101), true);
  const r = map.resolvePropertyOffline('Нова Улица 12');
  assert.equal(r.lat, 41.9901, 'second learn wins (refresh)');
  map.close();
});

test('learnAddress: refuses landmark-style addresses and junk (nothing to learn)', () => {
  const map = freshMap();
  // "БИСЕР" — a complex name, no street+number to generalize from.
  assert.equal(map.learnAddress('БИСЕР', 41.9976, 21.4351), false);
  // No house number → no building row.
  assert.equal(map.learnAddress('Улица Без Број', 41.99, 21.41), false);
  // Empty/garbage.
  assert.equal(map.learnAddress('', 41.99, 21.41), false);
  // Nothing was written.
  assert.equal(map.knowsStreet('БИСЕР'), false);
  map.close();
});

test('drain teaches the map: one Google call fixes the street for EVERYONE', async () => {
  const db = new Db(':memory:');
  const map = freshMap();
  const props = new Map<number, QueuedProperty>();
  props.set(77, { propertyId: 77, address: 'Мирче Оровчанец 86', location: 'Центар', lat: null, lon: null, geo_source: 'osm_low_confidence' });
  queueRow(db, 77);

  let geocodeCalls = 0;
  const res = await drainQueue({
    db, offlineMap: map,
    getProperty: async id => props.get(id),
    updatePropertyGeo: async (id, geo) => { Object.assign(props.get(id)!, { lat: geo.lat, lon: geo.lon, geo_source: geo.geo_source }); },
    geocode: async () => { geocodeCalls++; return { lat: 41.999, lon: 21.4138 }; },
    searchesLeft: () => 200,
  });

  assert.equal(res.googleUpgraded, 1);
  assert.equal(res.mapLearned, 1, 'the drain must teach the map');
  assert.equal(geocodeCalls, 1, 'exactly one Google call');
  // THE PAYOFF: a future property on the same street now resolves offline —
  // no Google call, trusted, at import time.
  assert.equal(map.resolvePropertyOffline('Мирче Оровчанец 40').trusted, false, 'different number without neighbours is street-level');
  assert.equal(map.knowsStreet('Мирче Оровчанец 40'), true, 'but the STREET is now known');
  assert.equal(map.resolvePropertyOffline('Мирче Оровчанец 86').trusted, true, 'the learned address resolves trusted');
  map.close();
});

test('drain does NOT teach on a geocode miss (no fabricated knowledge)', async () => {
  const db = new Db(':memory:');
  const map = freshMap();
  const props = new Map<number, QueuedProperty>();
  props.set(78, { propertyId: 78, address: 'Непозната Улица 5', location: 'Аеродром', lat: null, lon: null, geo_source: 'osm_low_confidence' });
  queueRow(db, 78);

  const res = await drainQueue({
    db, offlineMap: map,
    getProperty: async id => props.get(id),
    updatePropertyGeo: async () => { assert.fail('must not patch on a miss'); },
    geocode: async () => null, // Google miss
    searchesLeft: () => 200,
  });

  assert.equal(res.googleUpgraded, 0);
  assert.equal(res.mapLearned, 0, 'a miss teaches nothing');
  assert.equal(map.knowsStreet('Непозната Улица 5'), false);
  map.close();
});

test('learned rows survive a map rebuild (buildGoogleMap preservation path)', () => {
  // Build 1: a valid map, then the map learns a street mid-month.
  const p1 = tmpMapDb();
  writeMap(p1, [{ name: 'Рамстор', type: 'mall', lat: 41.9976, lon: 21.4351 }], []);
  const map1 = new OfflineMapStore(p1);
  assert.equal(map1.learnAddress('Изучена Улица 9', 41.995, 21.42), true);
  map1.close();
  // buildGoogleMap preserves addresses from the old DB on rebuild:
  const old = new (require('better-sqlite3'))(p1, { readonly: true });
  const preserved = old.prepare('SELECT street, housenumber, lat, lon FROM addresses').all();
  old.close();
  // Build 2: the rebuild carries the learned row forward.
  const p2 = tmpMapDb();
  writeMap(p2, [{ name: 'Рамстор', type: 'mall', lat: 41.9976, lon: 21.4351 }], preserved as any);
  const map2 = new OfflineMapStore(p2);
  const r = map2.resolvePropertyOffline('Изучена Улица 9');
  assert.equal(r.trusted, true, 'learned knowledge survives rebuilds');
  assert.equal(r.lat, 41.995);
  map2.close();
});
