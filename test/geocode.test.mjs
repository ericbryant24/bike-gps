import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellingVariants, parseLatLon } from '../js/geocode.js';

test('spelling variants cover straight and curly apostrophes', () => {
  assert.deepEqual(spellingVariants('whits'), ["whit's", 'whit\u2019s']);
  assert.deepEqual(spellingVariants("Whit's"), ['Whit\u2019s', 'Whits']);
  assert.deepEqual(spellingVariants('Whit\u2019s'), ["Whit's", 'Whits']);
  assert.deepEqual(spellingVariants('kroger'), []);
  assert.deepEqual(spellingVariants('bus'), []);
});

test('coordinate parsing', () => {
  assert.deepEqual(parseLatLon('39.96, -83.00'), { lat: 39.96, lon: -83 });
  assert.equal(parseLatLon('Glen Echo'), null);
});
