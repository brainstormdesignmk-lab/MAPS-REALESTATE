// THE FIELD-NAME LESSON, PINNED. SerpApi's Google Maps `local_results` item
// carries `reviews` (number) and `price` (string) — NOT `review_count` /
// `price_level`. Reading the wrong names returned null for EVERY place, so
// the prominence signal (review count → ranking weight) was silently dropped.
// Contract: capturePoi reads the API's real field names, accepts the old ones
// defensively, and never fabricates a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePoi } from '../src/geo/serpCapture';

const base = {
  title: 'Веро',
  gps_coordinates: { latitude: 41.995, longitude: 21.43 },
};

test('capturePoi reads SerpApi `reviews` into review_count', () => {
  const cap = capturePoi({ ...base, reviews: 1873, rating: 4.4 }, 'supermarket');
  assert.ok(cap);
  assert.equal(cap!.review_count, 1873);
  assert.equal(cap!.rating, 4.4);
});

test('capturePoi reads SerpApi `price` into price_level', () => {
  const cap = capturePoi({ ...base, price: '$$' }, 'supermarket');
  assert.ok(cap);
  assert.equal(cap!.price_level, '$$');
});

test('capturePoi still accepts the legacy key names defensively', () => {
  const cap = capturePoi({ ...base, review_count: 12, price_level: '$' }, 'supermarket');
  assert.ok(cap);
  assert.equal(cap!.review_count, 12);
  assert.equal(cap!.price_level, '$');
});

test('capturePoi keeps identity (data_id / data_cid) on every place', () => {
  const hex = capturePoi({ ...base, data_id: '0x80f2a1b3:0x2c1f9e4d' }, 'supermarket');
  assert.equal(hex!.place_id, '0x80f2a1b3:0x2c1f9e4d');
  // data_cid decimal → hex pair when data_id is absent.
  const cid = capturePoi({ ...base, data_cid: 3178173008127822 }, 'supermarket');
  assert.match(cid!.place_id ?? '', /^0x[0-9a-f]+:0x[0-9a-f]+$/);
});

test('capturePoi yields null (not a fabricated value) when the API omits a field', () => {
  const cap = capturePoi(base, 'supermarket');
  assert.ok(cap);
  assert.equal(cap!.review_count, null);
  assert.equal(cap!.rating, null);
  assert.equal(cap!.price_level, null);
  assert.equal(cap!.place_id, null);
});
