// THE WALGREENS LESSON, PINNED: Google's fuzzy geographic expansion leaks
// places far outside Skopje into every tile scrape (a supermarket search
// returned "Walgreens Pharmacy" — California, and "NewYork-Presbyterian" —
// New York). 1,118 of 8,562 live rows were foreign. THE CONTRACT:
//   1. capturePoi results are gated by insideSkopjeBbox at the scraper —
//      nothing outside the bbox is ever inserted;
//   2. the map self-prunes (pruneOutsideBbox) — contamination of ANY origin
//      cannot survive a monthly run;
//   3. the feed's own landmark CHAIN ("во потегот меѓу X и Y") tops the
//      nearby rotation up to 3 verified anchors, deduped against POIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { capturePoi, insideSkopjeBbox } from '../src/geo/serpCapture';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { LandmarkService } from '../src/geo/landmarks';

// ── 1. The scraper gate ──────────────────────────────────────────────

test('insideSkopjeBbox: Skopje in, Walgreens-class out', () => {
  assert.equal(insideSkopjeBbox(41.9981, 21.4254), true, 'ТЦ Олимписки');
  assert.equal(insideSkopjeBbox(41.95, 21.35), true, 'exact corner — inclusive');
  assert.equal(insideSkopjeBbox(42.05, 21.5), true, 'exact corner — inclusive');
  assert.equal(insideSkopjeBbox(37.7749, -122.4194), false, 'Walgreens, San Francisco');
  assert.equal(insideSkopjeBbox(40.7128, -74.006), false, 'New York hospital');
  assert.equal(insideSkopjeBbox(42.2, 21.4), false, 'just north of the bbox');
});

test('capturePoi returns foreign places (the gate, not the capture, is the filter)', () => {
  const walgreens = capturePoi(
    { title: 'Walgreens Pharmacy', gps_coordinates: { latitude: 37.7749, longitude: -122.4194 }, type: 'pharmacy' },
    'pharmacy',
  );
  assert.ok(walgreens, 'capture must still map the row — filtering happens at insert');
  assert.equal(insideSkopjeBbox(walgreens!.lat, walgreens!.lon), false, 'but the gate rejects it');
});

// ── 2. The map self-prunes ───────────────────────────────────────────

function buildMapWithForeign(): { store: OfflineMapStore; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `bbox-prune-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'ТЦ Олимписки', type: 'mall', lat: 41.9990, lon: 21.4178, source: 'osm' },
    { name: 'ОУ Гоце Делчев', type: 'school', lat: 42.0018, lon: 21.4132, source: 'osm' },
    // The contamination, exactly as it was found live:
    { name: 'Walgreens Pharmacy', type: 'pharmacy', lat: 37.7749, lon: -122.4194, source: 'google' },
    { name: 'NewYork-Presbyterian Hospital', type: 'hospital', lat: 40.7128, lon: -74.006, source: 'google' },
    { name: 'ExtraMile', type: 'gas_station', lat: 41.5, lon: 21.0, source: 'google' },
  ], []);
  return { store: new OfflineMapStore(dbPath), dbPath };
}

test('pruneOutsideBbox deletes every foreign row and keeps all Skopje rows', () => {
  const { store, dbPath } = buildMapWithForeign();
  try {
    assert.ok(store.findPoiByName('Walgreens Pharmacy'), 'foreign row present before prune');
    assert.ok(store.findPoiByName('ТЦ Олимписки'), 'Skopje row present before prune');

    const deleted = store.pruneOutsideBbox();
    assert.equal(deleted, 3, 'Walgreens + NewYork-Presbyterian + ExtraMile');

    assert.equal(store.findPoiByName('Walgreens Pharmacy'), undefined, 'foreign row gone');
    assert.equal(store.findPoiByName('NewYork-Presbyterian Hospital'), undefined, 'foreign row gone');
    assert.ok(store.findPoiByName('ТЦ Олимписки'), 'Skopje row survives');
    assert.ok(store.findPoiByName('ОУ Гоце Делчев'), 'Skopje row survives');
    // Idempotent: a second prune deletes nothing.
    assert.equal(store.pruneOutsideBbox(), 0);
  } finally { store.close(); fs.rmSync(dbPath, { force: true }); }
});

// ── 3. Feed landmark pairs top up the rotation ───────────────────────

test('feed landmark chain tops the rotation up (deduped, coords only)', () => {
  const dbPath = path.join(os.tmpdir(), `bbox-pairs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  // POIs near Бутелска 4, Бутел: only ONE within the 500m POI cap; the chain
  // anchor "ТЦ Бутел" sits at ~700m — validated by the map (≤900m window) but
  // OUTSIDE the POI rotation → only the pair top-up can bring it in.
  writeMap(dbPath, [
    { name: 'ОУ Страхинја Гавриловић', type: 'school', lat: 42.0015, lon: 21.4045, source: 'osm' }, // ≈120m
    { name: 'ТЦ Бутел', type: 'mall', lat: 42.0055, lon: 21.4060, source: 'osm' },                  // ≈700m
  ], []);
  const osm = new OfflineMapStore(dbPath);
  const svc = new LandmarkService(new (require('../src/store/db').Db)(':memory:'), { osm: false, offlineMap: osm });
  const nearby = svc.nearbyLandmarks({
    id: 57, eb: 57, address: 'Бутелска 4', location: 'Бутел',
    lat: 42.0005, lon: 21.4045, geo_source: 'stored',
    // The feed's own chain: school (also a POI hit — dedupe check), ТЦ Бутел
    // (map-validated, beyond the POI cap — MUST be topped in), and an anchor
    // with no map row (must NOT carry invented coords).
    details: 'во потегот меѓу ОУ Страхинја Гавриловић и ТЦ Бутел, спроти скопската градина.',
  });
  try {
    const names = nearby.map(n => n.landmark);
    assert.ok(names.includes('ОУ Страхинја Гавриловић'), `POI anchor present: ${names.join(' | ')}`);
    assert.ok(names.includes('ТЦ Бутел'), `map-validated chain anchor must top the rotation up beyond the 500m POI cap: ${names.join(' | ')}`);
    assert.ok(!names.some(n => /скопската градина/i.test(n)), `unvalidated anchor must not appear: ${names.join(' | ')}`);
    assert.ok(nearby.every(n => Number.isFinite(n.lat) && Number.isFinite(n.lon)), 'every served anchor carries real coords');
  } finally { osm.close(); fs.rmSync(dbPath, { force: true }); }
});
