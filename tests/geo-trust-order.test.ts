// TRUST ORDER — a street-level map match must never outrank an address-level
// pin, and a building-level match must still win.
//
// The map's own address resolution is preferred over the feed's geocode (the
// EB 94 lesson). But resolveSearchCenter applied that preference
// unconditionally: ANY trusted map result that disagreed by >50 m won.
// 'osm_street_anchor' is a Google-verified STREET CENTROID — the resolver only
// reaches it after the exact-building AND interpolation stages both failed, so
// it is street granularity by construction and cannot be the more precise
// answer for an address the feed already resolved to a point.
//
// The real case (EB 62, "ТЦ ОЛИМПИКО", Тафталиџе): the row's pin sits ~246 m
// from the mall — which is where the agency's own data/address-overrides.json
// puts ТЦ Олимпико — while the map's street anchor sits 2.2 km away. The
// runtime served the anchor.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { OfflineMapStore, writeMap, type OfflineResolve } from '../src/geo/offlineMap';
import { resolveSearchCenter, setOfflineMapRef, type PropertyRow } from '../src/geo/landmarks';

const REAL_OLIMPICO = { lat: 42.0005215, lon: 21.39187 };   // address-overrides.json
const MAP_WRONG_ANCHOR = { lat: 42.01375, lon: 21.40812 };  // the map's street centroid

function buildMap(addresses: Array<{ street: string; housenumber: string; lat: number; lon: number; source?: string }>): OfflineMapStore {
  const p = path.join(os.tmpdir(), `geo-trust-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(p, [], addresses);
  const store = new OfflineMapStore(p);
  setOfflineMapRef(store);
  return store;
}

beforeEach(() => { setOfflineMapRef(undefined); });

describe('resolveSearchCenter trust order', () => {
  it('a street centroid never outranks an address-level stored pin (EB 62)', () => {
    const map = buildMap([{ street: 'ТЦ ОЛИМПИКО', housenumber: '', ...MAP_WRONG_ANCHOR, source: 'google_street' }]);

    // Guard against a VACUOUS test: the map must really be offering a trusted
    // street anchor here, or this would pass for the wrong reason.
    const anchor: OfflineResolve = map.resolvePropertyOffline('ТЦ ОЛИМПИКО');
    assert.equal(anchor.trusted, true, 'fixture must produce a trusted anchor');
    assert.equal(anchor.source, 'osm_street_anchor', `fixture source: ${anchor.source}`);

    const row: PropertyRow = {
      id: 62, eb: 62, address: 'ТЦ ОЛИМПИКО',
      lat: REAL_OLIMPICO.lat, lon: REAL_OLIMPICO.lon, geo_source: 'google_cached',
    };
    const c = resolveSearchCenter(row);
    assert.equal(c.source, 'stored', `the row's own pin must win, got source=${c.source}`);
    assert.equal(c.lat, REAL_OLIMPICO.lat);
    assert.equal(c.lon, REAL_OLIMPICO.lon);
  });

  it('a building-level match still overrides a bad stored pin (EB 82)', () => {
    const exactPoint = { lat: 41.9882403, lon: 21.4665335 };
    const map = buildMap([{ street: 'Јане Сандански', housenumber: '35', ...exactPoint, source: 'osm' }]);
    assert.equal(map.resolvePropertyOffline('Јане Сандански 35').source, 'osm_building');

    // The bad pin the live feed carried (585 m away).
    const row: PropertyRow = {
      id: 82, eb: 82, address: 'Јане Сандански 35',
      lat: 41.9933, lon: 21.4646, geo_source: 'google_cached',
    };
    const c = resolveSearchCenter(row);
    assert.equal(c.source, 'map', 'an exact building must still win');
    assert.equal(c.lat, exactPoint.lat);
  });

  it('a street anchor still serves as the fallback when no trusted pin exists', () => {
    buildMap([{ street: 'ТЦ ОЛИМПИКО', housenumber: '', ...MAP_WRONG_ANCHOR, source: 'google_street' }]);
    const row: PropertyRow = {
      id: 99, eb: 99, address: 'ТЦ ОЛИМПИКО',
      lat: 41.99, lon: 21.40, geo_source: 'osm_low_confidence',
    };
    const c = resolveSearchCenter(row);
    assert.equal(c.source, 'map', 'with nothing trusted to outrank, the anchor is the best honest answer');
    assert.equal(c.trusted, true);
  });

  it('an interpolated match (address-level) still overrides — The EB 78 shape', () => {
    // Two mapped neighbours on the street let the resolver interpolate house 23.
    const map = buildMap([
      { street: 'Народен Фронт', housenumber: '21', lat: 41.9930, lon: 21.4172, source: 'osm' },
      { street: 'Народен Фронт', housenumber: '25', lat: 41.9935, lon: 21.4168, source: 'osm' },
    ]);
    assert.equal(map.resolvePropertyOffline('Народен Фронт 23').source, 'osm_interpolated');

    const row: PropertyRow = {
      id: 78, eb: 78, address: 'Народен Фронт 23',
      lat: 41.9936, lon: 21.415, geo_source: 'google_cached',
    };
    const c = resolveSearchCenter(row);
    assert.equal(c.source, 'map', 'an interpolation between real neighbours is address-level');
    assert.equal(c.lat, 41.99325);
    assert.equal(c.lon, 21.417);
  });
});
