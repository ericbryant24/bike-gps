import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapLink, labelFromText, unshorten } from '../js/links.js';

test('full Google Maps place link: exact coordinates from the data blob, name from the path', () => {
  const r = parseMapLink("https://www.google.com/maps/place/Whit's+Frozen+Custard/@40.0329,-83.0189,17z/data=!3m1!4b1!4m6!3m5!1s0x8838:0x1!8m2!3d40.0323456!4d-83.0165432!16s");
  assert.equal(r.kind, 'coords');
  assert.equal(r.lat, 40.0323456);
  assert.equal(r.lon, -83.0165432);
  assert.equal(r.label, "Whit's Frozen Custard");
  assert.equal(r.approx, false);
});

test('Google link with only a map centre is approximate; search links become queries; q=lat,lng works', () => {
  const approx = parseMapLink('https://www.google.com/maps/place/Goodale+Park/@39.9762,-83.0070,16z');
  assert.equal(approx.kind, 'coords');
  assert.equal(approx.approx, true);
  assert.equal(approx.label, 'Goodale Park');
  assert.deepEqual(parseMapLink('https://www.google.com/maps/search/kroger+near+me/'), { kind: 'query', query: 'kroger near me' });
  assert.deepEqual(parseMapLink('https://www.google.com/maps/search/?api=1&query=Glen+Echo+Park+Columbus'), { kind: 'query', query: 'Glen Echo Park Columbus' });
  const q = parseMapLink('https://maps.google.com/?q=39.9612,-83.0007');
  assert.equal(q.kind, 'coords');
  assert.equal(q.lat, 39.9612);
  const dir = parseMapLink('https://www.google.com/maps/dir/Columbus/Glen+Echo+Park/@40.02,-83.01,14z');
  assert.equal(dir.label, 'Glen Echo Park');
});

test('short links are flagged and keep the shared place name', () => {
  const r = parseMapLink("Whit's Frozen Custard\nhttps://maps.app.goo.gl/AbCdEf123");
  assert.deepEqual(r, { kind: 'short', url: 'https://maps.app.goo.gl/AbCdEf123', label: "Whit's Frozen Custard" });
  assert.equal(parseMapLink('https://goo.gl/maps/XyZ').kind, 'short');
  assert.equal(labelFromText('Check this out: https://maps.app.goo.gl/x'), 'Check this out:');
  assert.equal(labelFromText('https://maps.app.goo.gl/x'), '');
});

test('Apple Maps, OpenStreetMap, geo: and Bing', () => {
  const a = parseMapLink("https://maps.apple.com/?ll=40.0323,-83.0165&q=Whit's%20Frozen%20Custard");
  assert.equal(a.kind, 'coords');
  assert.equal(a.label, "Whit's Frozen Custard");
  assert.deepEqual(parseMapLink('https://maps.apple.com/?address=3339%20N%20High%20St%2C%20Columbus'), { kind: 'query', query: '3339 N High St, Columbus' });
  const o = parseMapLink('https://www.openstreetmap.org/?mlat=39.9762&mlon=-83.0070#map=17/39.9762/-83.0070');
  assert.equal(o.lat, 39.9762);
  const g = parseMapLink('geo:40.0323,-83.0165?q=40.0323,-83.0165(Whit%27s)');
  assert.equal(g.kind, 'coords');
  assert.equal(g.label, "Whit's");
  const b = parseMapLink('https://www.bing.com/maps?cp=40.0323~-83.0165&lvl=16');
  assert.equal(b.lon, -83.0165);
});

test('non-map text is ignored', () => {
  assert.equal(parseMapLink('kroger'), null);
  assert.equal(parseMapLink('https://example.com/page'), null);
  assert.equal(parseMapLink(''), null);
});

test('unshorten uses the service response and fails soft', async () => {
  const ok = await unshorten('https://maps.app.goo.gl/x', { fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, resolved_url: 'https://www.google.com/maps/place/A/@1,2,3z/data=!3d1.5!4d2.5' }) }) });
  assert.equal(parseMapLink(ok).lat, 1.5);
  assert.equal(await unshorten('https://maps.app.goo.gl/x', { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await unshorten('https://maps.app.goo.gl/x', { fetchImpl: async () => { throw new Error('offline'); } }), null);
});
