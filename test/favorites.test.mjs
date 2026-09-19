import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFavorite, removeFavorite, renameFavorite, findFavoriteNear, searchFavorites, toResult } from '../js/favorites.js';

const whits = { label: "Whit's Frozen Custard", lat: 40.0323456, lon: -83.0165432, kind: 'restaurant' };

test('add, dedupe nearby, rename, remove', () => {
  let { list, fav } = addFavorite([], { ...whits, name: 'Custard' });
  assert.equal(list.length, 1);
  assert.equal(fav.name, 'Custard');
  assert.equal(fav.label, "Whit's Frozen Custard");
  // Saving again 10 m away renames instead of duplicating.
  ({ list, fav } = addFavorite(list, { ...whits, lat: whits.lat + 0.00009, name: 'Whits' }));
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Whits');
  assert.equal(findFavoriteNear(list, whits).id, fav.id);
  assert.equal(findFavoriteNear(list, { lat: 40.05, lon: -83.03 }), null);
  ({ list } = addFavorite(list, { name: 'Home', label: '4457 Rosemary Parkway', lat: 40.0525, lon: -83.0226 }));
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'Home');
  list = renameFavorite(list, list[0].id, '  Casa  ');
  assert.equal(list[0].name, 'Casa');
  assert.equal(renameFavorite(list, list[0].id, '   ')[0].name, 'Casa');
  list = removeFavorite(list, list[0].id);
  assert.equal(list.length, 1);
  assert.equal(addFavorite([], { label: '', lat: 1, lon: 2 }).fav.name, 'Saved place');
});

test('search matches the saved name or the original place name, nearest first', () => {
  const { list } = addFavorite(addFavorite([], { ...whits, name: 'Custard' }).list, { name: 'Home', label: '4457 Rosemary Parkway', lat: 40.0525, lon: -83.0226 });
  const near = { lat: 40.05, lon: -83.03 };
  assert.deepEqual(searchFavorites(list, 'hom', near).map((r) => r.label), ['Home']);
  assert.deepEqual(searchFavorites(list, "whit's", near).map((r) => r.label), ['Custard']); // original name still matches
  assert.equal(searchFavorites(list, 'kroger', near).length, 0);
  assert.equal(searchFavorites(list, '', near).length, 0);
  const r = searchFavorites(list, 'c', near)[0];
  assert.equal(r.kind, 'saved');
  assert.equal(r.tier, 1);
  assert.ok(r.favId);
  assert.equal(toResult(list[0]).address, '4457 Rosemary Parkway');
  assert.equal(toResult({ name: 'X', label: 'X', lat: 0, lon: 0 }).address, '');
});
