// Generates iOS launch images (apple-touch-startup-image) as PNGs with no
// dependencies: the app's route-and-pin glyph centred on the brand teal, one
// file per iPhone screen size. iOS shows a plain white screen for an installed
// web app unless an image with the exact device pixel size exists.
//   node scripts/make-splash.mjs   → splash/*.png + the <link> tags on stdout
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(width, height, rgb) {
  // 8-bit RGB (no alpha): a third smaller than RGBA for a flat-colour image.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the glyph, same geometry as scripts/make-icons.mjs (unit coordinates) ----
const TEAL = [15, 118, 110], WHITE = [255, 255, 255], RED = [239, 68, 68], DARK = [8, 60, 56];
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - hw + r, dy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const sdSeg = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * h, py - dy * h);
};
const sdPolyline = (x, y, pts) => {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, sdSeg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return d;
};
const ROUTE = [[0.24, 0.80], [0.24, 0.52], [0.50, 0.52], [0.50, 0.30], [0.72, 0.30]];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const step = (d, aa) => Math.max(0, Math.min(1, 0.5 - d / aa));

/** Colour of the glyph at unit point (x, y) over a teal ground. */
function shade(x, y, aa) {
  let c = TEAL;
  // soft shadow under the route
  const sh = sdPolyline(x - 0.012, y + 0.016, ROUTE) - 0.055;
  c = mix(c, DARK, 0.55 * step(sh, aa * 3));
  // route
  const rd = sdPolyline(x, y, ROUTE) - 0.048;
  c = mix(c, WHITE, step(rd, aa));
  // start ring
  const s = ROUTE[0];
  const ring = Math.abs(Math.hypot(x - s[0], y - s[1]) - 0.055) - 0.028;
  c = mix(c, WHITE, step(ring, aa));
  const hole = Math.hypot(x - s[0], y - s[1]) - 0.03;
  c = mix(c, TEAL, step(hole, aa));
  // destination pin: red capsule with white outline and dot
  const e = ROUTE[ROUTE.length - 1];
  const capOut = sdRoundRect(x, y, e[0] + 0.03, e[1], 0.11, 0.155, 0.11);
  c = mix(c, WHITE, step(capOut, aa));
  const capIn = sdRoundRect(x, y, e[0] + 0.03, e[1], 0.085, 0.13, 0.085);
  c = mix(c, RED, step(capIn, aa));
  const dot = Math.hypot(x - (e[0] + 0.03), y - (e[1] - 0.06)) - 0.026;
  c = mix(c, WHITE, step(dot, aa));
  return c;
}

/** Render the glyph into a w×h teal canvas, glyph side = `side` px, centred (slightly above centre). */
function render(w, h, side) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set(TEAL, i * 3);
  const x0 = Math.round((w - side) / 2);
  const y0 = Math.round(h * 0.44 - side / 2);
  const SS = 3;
  const aa = 1.5 / side;
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = shade((px + (sx + 0.5) / SS) / side, (py + (sy + 0.5) / SS) / side, aa);
        acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
      }
      const o = ((y0 + py) * w + x0 + px) * 3;
      if (o >= 0 && o < rgb.length) rgb.set(acc.map((v) => Math.round(v / (SS * SS))), o);
    }
  }
  return png(w, h, rgb);
}

// iPhone screens: CSS width × height and pixel ratio. Portrait only.
const DEVICES = [
  ['iphone-17-pro-max', 440, 956, 3],
  ['iphone-air', 420, 912, 3],
  ['iphone-16-pro-max', 430, 932, 3],
  ['iphone-16-plus', 428, 926, 3],
  ['iphone-16-pro', 402, 874, 3],
  ['iphone-16', 393, 852, 3],
  ['iphone-14', 390, 844, 3],
  ['iphone-13-mini', 375, 812, 3],
  ['iphone-11-pro-max', 414, 896, 3],
  ['iphone-11', 414, 896, 2],
  ['iphone-8-plus', 414, 736, 3],
  ['iphone-8', 375, 667, 2],
];

mkdirSync('splash', { recursive: true });
const links = [];
for (const [name, cw, ch, dpr] of DEVICES) {
  const w = cw * dpr, h = ch * dpr;
  const side = Math.round(w * 0.42);
  writeFileSync(`splash/${name}.png`, render(w, h, side));
  links.push(`  <link rel="apple-touch-startup-image" media="screen and (device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="./splash/${name}.png" />`);
  process.stderr.write(`${name} ${w}x${h}\n`);
}
console.log(links.join('\n'));
