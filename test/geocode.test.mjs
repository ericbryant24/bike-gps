import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellingVariants, parseLatLon } from '../js/geocode.js';

test('spelling variants for possessive names', () => {
  assert.deepEqual(spellingVariants('whits'), ["whit's", 'whit']);
  assert.deepEqual(spellingVariants("Whit's"), ['Whits']);
  assert.deepEqual(spellingVariants('kroger'), []);
  assert.deepEqual(spellingVariants('bus'), []);
});

test('coordinate parsing', () => {
  assert.deepEqual(parseLatLon('39.96, -83.00'), { lat: 39.96, lon: -83 });
  assert.equal(parseLatLon('Glen Echo'), null);
});
