import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractDetailsLandmark } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap, type Center } from '../src/geo/offlineMap';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tmpDb(): string {
  return path.join(os.tmpdir(), `details-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function buildTestMap(): OfflineMapStore {
  const dbPath = tmpDb();
  const pois = [
    { name: 'Рамстор Мол', type: 'mall', lat: 42.000, lon: 21.428, source: 'google' },
    { name: 'Градежен факултет', type: 'university', lat: 42.003, lon: 21.433, source: 'osm' },
  ];
  writeMap(dbPath, pois, []);
  return new OfflineMapStore(dbPath);
}

describe('extractDetailsLandmark', () => {
  let offlineMap: OfflineMapStore;
  const center: Center = { lat: 42.0, lon: 21.43, trusted: true };

  beforeEach(() => {
    offlineMap = buildTestMap();
  });

  it('description "спроти Рамстор" + Ramstore in pois → landmark with coords', () => {
    const result = extractDetailsLandmark(
      'Станот е спроти Рамстор Мол, на одлична локација.',
      center,
      offlineMap,
    );
    assert.ok(result, 'should match "спроти Рамстор"');
    assert.ok(result!.name.includes('Рамстор'), `name should contain Рамстор, got: ${result!.name}`);
    assert.ok(result!.lat !== null, 'lat should be set when POI found');
    assert.ok(result!.lon !== null, 'lon should be set when POI found');
  });

  it('same description, POI absent → landmark name set, lat/lon null', () => {
    const result = extractDetailsLandmark(
      'Станот е спроти Непостојно Место 123, мирна улица.',
      center,
      offlineMap,
    );
    assert.ok(result, 'should still match the regex');
    assert.ok(result!.name.length > 0, 'name should be set');
    assert.equal(result!.lat, null, 'lat must be null when POI not in table');
    assert.equal(result!.lon, null, 'lon must be null when POI not in table');
  });

  // ── THE PROSE DEFECT (the fix list's purge, durable half) ────────────────
  // The capture class swallowed the sentence AFTER the anchor, so the cache
  // held landmarks like "Сити Мол. Купатилото и Кујната се комплет" — real
  // production rows for EB 48, 63 and 79. The reported names come from the
  // agents' own descriptions verbatim; the landmark must stop at the place.
  const PROSE_OPIS: Array<[number, string, string]> = [
    [48, 'Се издава трособен стан во Карпош 3 во близина на Сити Мол. Купатилото и Кујната се комплет изреновирани, Малку постар намештај.Идеално за студенти 4 кат без лифт.', 'Сити Мол'],
    [63, 'Се Продава Гарсоњера во Сутерен на Зграда. Гарсоњерата е комплетно реновирана и е на Одлична Локација , во близина на Црногорска Амбасада. Поседува Посебна Спална Соба која не е во имотен лист.', 'Црногорска Амбасада'],
    [79, 'Издава стан во Центар, на почеток на Водно, спроти главниот влез на Клинички Центар. Станот има дневна, спална, кујна и бања со тоалет.', 'главниот влез на Клинички Центар'],
  ];

  for (const [eb, opis, expected] of PROSE_OPIS) {
    it(`EB ${eb}: the extracted name stops at the sentence end (never the ad's prose)`, () => {
      const result = extractDetailsLandmark(opis, center, offlineMap);
      assert.ok(result, `EB ${eb} must still yield a landmark`);
      assert.equal(result!.name, expected);
      assert.ok(!/\./.test(result!.name), `no sentence punctuation in a landmark name: ${result!.name}`);
    });
  }

  it('an abbreviation is not a sentence end — "с. Влае" survives whole, the prose after it does not', () => {
    const result = extractDetailsLandmark('Издава се стан во близина на с. Влае. Станот има две спални соби.', center, offlineMap);
    assert.ok(result, 'should extract the anchor');
    assert.equal(result!.name, 'с. Влае', 'the abbreviation dot must not cut the name in half');
  });

  it('handler must never emit a coordinate link for a null-coords landmark', () => {
    // Simulate what the handler does: check lat/lon before building link
    const result = extractDetailsLandmark(
      'Кај Непостојното Место, тивка улица.',
      center,
      offlineMap,
    );
    assert.ok(result, 'should extract a name');
    // The handler guard: only build link when coords exist
    const wouldEmitLink = result!.lat !== null && result!.lon !== null;
    assert.equal(wouldEmitLink, false, 'must NOT emit coordinate link for null-coords landmark');
  });
});
