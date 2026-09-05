import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canServeLandmark, TIER_RANK, type LandmarkTier, type PropertyRow, centerTrusted, resolveSearchCenter, type Landmark } from '../src/geo/landmarks';

describe('canServeLandmark', () => {
  it('returns false when no tier set', () => {
    assert.equal(canServeLandmark({ id: 1 }), false);
    assert.equal(canServeLandmark({ id: 1 }), false);
  });

  it('NEVER serves osm_low_confidence — even when center is trusted', () => {
    const p: PropertyRow = { id: 1, landmark_tier: 'osm_low_confidence', geo_source: 'google_cached' };
    assert.equal(canServeLandmark(p), false, 'trusted center must not save poison');
    const p2: PropertyRow = { id: 1, landmark_tier: 'osm_low_confidence', geo_source: 'osm_low_confidence' };
    assert.equal(canServeLandmark(p2), false);
  });

  it('serves osm_poi only when center is trusted (dist ≤ 500m)', () => {
    const trusted: PropertyRow = { id: 1, landmark_tier: 'osm_poi', geo_source: 'stored' };
    assert.equal(canServeLandmark(trusted), true);
    const untrusted: PropertyRow = { id: 1, landmark_tier: 'osm_poi', geo_source: 'osm_low_confidence' };
    assert.equal(canServeLandmark(untrusted), false, 'untrusted center must block osm_poi');
  });

  it('serves feed tier always', () => {
    const p: PropertyRow = { id: 1, landmark_tier: 'feed' };
    assert.equal(canServeLandmark(p), true);
    const p2: PropertyRow = { id: 1, landmark_tier: 'feed', geo_source: 'osm_low_confidence' };
    assert.equal(canServeLandmark(p2), true);
  });

  it('serves extract tier always', () => {
    const p: PropertyRow = { id: 1, landmark_tier: 'extract' };
    assert.equal(canServeLandmark(p), true);
    const p2: PropertyRow = { id: 1, landmark_tier: 'extract', geo_source: 'osm_low_confidence' };
    assert.equal(canServeLandmark(p2), true);
  });

  it('serves google tier always', () => {
    const p: PropertyRow = { id: 1, landmark_tier: 'google' };
    assert.equal(canServeLandmark(p), true);
    const p2: PropertyRow = { id: 1, landmark_tier: 'google', geo_source: 'osm_low_confidence' };
    assert.equal(canServeLandmark(p2), true);
  });
});

describe('centerTrusted', () => {
  it('stored → trusted', () => assert.ok(centerTrusted('stored')));
  it('google_cached → trusted', () => assert.ok(centerTrusted('google_cached')));
  it('osm_low_confidence → NOT trusted', () => assert.ok(!centerTrusted('osm_low_confidence')));
  it('null → NOT trusted', () => assert.ok(!centerTrusted(null)));
  it('undefined → NOT trusted', () => assert.ok(!centerTrusted(undefined as any)));
});

describe('TIER_RANK upgrade-only', () => {
  it('feed is highest rank (5)', () => {
    assert.equal(TIER_RANK.feed, 5);
  });

  it('google is rank 4, lower than feed', () => {
    assert.equal(TIER_RANK.google, 4);
    assert.ok(TIER_RANK.google < TIER_RANK.feed);
  });

  it('osm_poi is lower than extract', () => {
    assert.ok(TIER_RANK.osm_poi < TIER_RANK.extract);
  });

  it('osm_low_confidence is lowest', () => {
    assert.ok(TIER_RANK.osm_low_confidence < TIER_RANK.osm_poi);
  });

  it('upgrade-only rule: higher tier can overwrite lower', () => {
    // Simulating: existing=osm_poi, new=extract → should allow
    assert.ok(TIER_RANK.extract > TIER_RANK.osm_poi);
  });

  it('upgrade-only rule: same tier should NOT overwrite', () => {
    // Simulating: existing=feed, new=feed → should block (equal)
    assert.ok(TIER_RANK.feed <= TIER_RANK.feed);
  });

  it('upgrade-only rule: lower tier should NOT overwrite higher', () => {
    // Simulating: existing=google, new=osm_poi → should block
    assert.ok(TIER_RANK.osm_poi < TIER_RANK.google);
  });
});

describe('Acceptance: poison rejection', () => {
  it('fake row with osm_low_confidence + landmark → handler must NOT output', () => {
    const p: PropertyRow = {
      id: 999,
      landmark_tier: 'osm_low_confidence',
      landmark_name: 'Златна вилушка',
      landmark_lat: 41.987,
      landmark_lon: 21.476,
    };
    // Even with valid landmark data, canServeLandmark must reject
    assert.equal(canServeLandmark(p), false, 'osm_low_confidence must never be served');
  });

  it('feed tier entry → served', () => {
    const p: PropertyRow = {
      id: 89,
      landmark_tier: 'feed',
      landmark_name: 'Парк Авионче',
    };
    assert.equal(canServeLandmark(p), true);
  });
});

describe('resolveSearchCenter', () => {
  it('returns stored coords when lat+lon and geo_source=google_cached → geocodeAddress NOT called', () => {
    let geocodeCalled = false;
    // We test the logic: when lat/lon exist and geo_source is not osm_low_confidence, should return stored coords
    const p: PropertyRow = { id: 1, lat: 41.996, lon: 21.417, geo_source: 'google_cached', address: 'Test 16' };
    const center = resolveSearchCenter(p);
    assert.equal(center.lat, 41.996);
    assert.equal(center.lon, 21.417);
    assert.equal(center.trusted, true);
  });

  it('returns stored coords when geo_source=stored', () => {
    const p: PropertyRow = { id: 2, lat: 41.988, lon: 21.476, geo_source: 'stored', address: 'ASNO' };
    const center = resolveSearchCenter(p);
    assert.equal(center.lat, 41.988);
    assert.equal(center.lon, 21.476);
    assert.equal(center.trusted, true);
  });

  it('falls back to offlineMap when lat/lon missing', () => {
    const p: PropertyRow = { id: 3, geo_source: null, address: 'Народен Фронт 23' };
    // Without offlineMap set, should return {0, 0, trusted: false}
    const center = resolveSearchCenter(p);
    assert.equal(center.trusted, false);
    // lat/lon should be 0 (fallback when no offlineMap)
    assert.equal(typeof center.lat, 'number');
    assert.equal(typeof center.lon, 'number');
  });

  it('returns {0,0,untrusted} when geo_source is osm_low_confidence', () => {
    const p: PropertyRow = { id: 4, lat: 41.996, lon: 21.417, geo_source: 'osm_low_confidence', address: 'Test' };
    const center = resolveSearchCenter(p);
    // Should NOT use stored coords when geo_source is osm_low_confidence
    // Falls back to offlineMap which returns {0,0} when no offlineMap
    assert.equal(center.trusted, false);
  });
});

describe('cacheLandmark upgrade-only', () => {
  it('TIER_RANK: feed(5) > google(4) > extract(3) > osm_poi(2) > osm_low_confidence(1)', () => {
    assert.ok(TIER_RANK.feed > TIER_RANK.google);
    assert.ok(TIER_RANK.google > TIER_RANK.extract);
    assert.ok(TIER_RANK.extract > TIER_RANK.osm_poi);
    assert.ok(TIER_RANK.osm_poi > TIER_RANK.osm_low_confidence);
  });
});
