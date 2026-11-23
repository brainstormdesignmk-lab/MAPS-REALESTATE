/**
 * THE PIN-DRIFT REVIEW'S RULES — every one of them was a false verdict first.
 *
 * The 2026-11-23 pass over 63 refused identities read the map's own witnesses
 * and got four of them wrong in ways that would have "fixed" working rows or
 * written assurance where there was none:
 *   • «Betty» was reported covered by the pharmacy next door — distance alone
 *     is not agreement;
 *   • a house number with an EMPTY number («Булевар Србија» with "") anchored
 *     every pin on the boulevard;
 *   • «Авиатор» was "corroborated" by a street Google's café does not stand on,
 *     7.5 km away;
 *   • «Лабораторија» was about to be moved 3.3 km onto someone else's building.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideFree, decideVerified, parseGoogleAddress, sharedNameless,
  type AddressPoint, type DriftCandidate, type DriftRow, type FreeWitness,
} from '../src/geo/identityReview';

const row: DriftRow = { rowid: 1, name: 'Betty', type: 'pharmacy', lat: 41.99, lon: 21.43 };
const cand = (over: Partial<DriftCandidate> = {}): DriftCandidate => ({
  name: 'Pharmacy Betty', lat: 41.9910, lon: 21.4310, address: 'Orce Nikolov 137, Skopje 1000', ...over,
});
const witness = (over: Partial<FreeWitness> = {}): FreeWitness => ({ twins: [], ...over });
const addrAt = (over: Partial<AddressPoint> = {}): AddressPoint => ({
  street: 'Васил Ѓоргов', housenumber: '12', lat: 41.9905, lon: 21.4305, d: 10, fromMapPinM: 10, ...over,
});

test('a neighbour at 4 m is NOT a twin unless the identity rule says one place', () => {
  // The caller builds `twins` with samePlacePoi; this test pins the contract in
  // the reviewer too: an empty twin list means nobody carries the place.
  const d = decideFree(row, cand(), witness({ nearestAddressM: 120 }));
  assert.notEqual(d.reason, 'covered');
  assert.equal(d.action, 'verify');
});

test('an identified twin inside the pool radius settles the row', () => {
  const d = decideFree(row, cand(), witness({ twins: [{ name: 'Betty', d: 5 }] }));
  assert.deepEqual([d.action, d.reason], ['leave', 'covered']);
  assert.match(d.detail, /5m/);
});

test('the candidate name already being a known row elsewhere means a branch', () => {
  const d = decideFree(row, cand(), witness({ branch: { name: 'Pharmacy Betty', d: 1291 } }));
  assert.deepEqual([d.action, d.reason], ['leave', 'branch']);
  assert.match(d.detail, /1291m/);
});

test('a name made only of kind words identifies nothing', () => {
  // The café bug this vocabulary came from: «Caffe Skopje» folds to {caffe}.
  assert.equal(sharedNameless('Caffe Skopje', 'The Dude Specialty Coffee'), true);
  assert.deepEqual(
    [decideFree({ ...row, name: 'Caffe Skopje' }, cand({ name: 'Coffee Bar' }), witness()).reason],
    ['generic-name'],
  );
  // …and two SPELLINGS that only meet on the category word prove nothing at
  // this layer («шпаркасе» ≠ «sparkasse»), so the review stays conservative:
  // a spelling difference is never evidence of one place.
  assert.equal(sharedNameless('Шпаркасе Банка', 'Sparkasse Bank'), true);
  // «Лабораторија» ⇄ «BIOTEK Laboratory»: the folds do not even meet, so there
  // is no shared word to carry an identity — but the reason must not claim they
  // share a KIND word when they share nothing at all.
  assert.equal(sharedNameless('Лабораторија', 'BIOTEK Laboratory'), true);
  assert.match(
    decideFree({ ...row, name: 'Лабораторија' }, cand({ name: 'BIOTEK Laboratory' }), witness()).detail,
    /share no distinctive word/,
  );
});

test('a house number within 40 m of the pin corroborates it — and only then', () => {
  assert.equal(decideFree(row, cand(), witness({ nearestAddressM: 15 })).reason, 'address-corroborated');
  assert.equal(decideFree(row, cand(), witness({ nearestAddressM: 45 })).action, 'verify');
});

test('the paid verdict: the same house number under both pins is agreement', () => {
  const d = decideVerified(row, cand(), witness({ nearestAddressM: 113 }), addrAt({ d: 13, fromMapPinM: 30 }));
  assert.deepEqual([d.action, d.reason], ['leave', 'address-agrees-with-map-pin']);
});

test('the address must describe GOOGLE\'s point before it arbitrates the map\'s', () => {
  // «Авиатор»: Google names Фрањо Клуз 3 but stands 7.5 km from it.
  const d = decideVerified(row, cand(), witness({ nearestAddressM: 42 }), addrAt({ d: 7536, fromMapPinM: 42 }));
  assert.deepEqual([d.action, d.reason], ['inconclusive', 'address-does-not-fit-candidate']);
});

test('a pin only moves inside the sanctioned drift ceiling', () => {
  const near = decideVerified(row, cand(), witness({ nearestAddressM: null }), addrAt({ d: 10, fromMapPinM: 180 }));
  assert.deepEqual([near.action, near.reason], ['fix-pin', 'address-agrees-with-candidate-pin']);
  assert.deepEqual(near.to, { lat: 41.9905, lon: 21.4305 });

  const far = decideVerified(row, cand(), witness({ nearestAddressM: null }), addrAt({ d: 13, fromMapPinM: 3325 }));
  assert.deepEqual([far.action, far.reason], ['inconclusive', 'candidate-too-far']);
  assert.equal(far.to, undefined);
});

test('no resolvable house number is inconclusive, never agreement', () => {
  const d = decideVerified(row, cand({ address: 'XCWQ+FQ4, Kej Dimitar Vlahov, Skopje 1000' }), witness({ nearestAddressM: 891 }), null);
  assert.deepEqual([d.action, d.reason], ['inconclusive', 'address-unknown']);
});

test('SerpApi address lines: the street is not always the first comma part', () => {
  assert.deepEqual(parseGoogleAddress('Orce Nikolov 137, Skopje 1000, North Macedonia'),
    { street: 'Orce Nikolov', number: '137' });
  // postcode first (seen on «Kids Park», «Laboratorium»)
  assert.deepEqual(parseGoogleAddress('1000, Boulevard Jane Sandanski 69, Skopje 1000, North Macedonia'),
    { street: 'Boulevard Jane Sandanski', number: '69' });
  // country first, «no.» before the number
  assert.deepEqual(parseGoogleAddress('MK, Vasil Gjorgov no.12, Skopje 1000, North Macedonia'),
    { street: 'Vasil Gjorgov', number: '12' });
  // ordinal inside the street name is not the house number
  assert.deepEqual(parseGoogleAddress('Булевар 12-та Македонска Бригада 2а, Skopje 1000, North Macedonia'),
    { street: 'Булевар 12-та Македонска Бригада', number: '2а' });
  // a plus code and a city/postcode line are not addresses
  assert.equal(parseGoogleAddress('XCWQ+FQ4, Kej Dimitar Vlahov, Skopje 1000, North Macedonia'), null);
  assert.equal(parseGoogleAddress('1000 Skopje, North Macedonia'), null);
  assert.equal(parseGoogleAddress(null), null);
});
