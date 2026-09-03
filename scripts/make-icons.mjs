// Generates the PWA icons as PNGs with no dependencies (zlib is built in).
// Draws with signed-distance functions and 4x4 supersampling.
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
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- scene (unit coordinates 0..1) --------------------------------------------
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

function shade(x, y, maskable) {
  // Background
  const bg = maskable ? -1 : sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22);
  if (bg > 0) return [0, 0, 0, 0];
  let col = TEAL;
  // Soft inner vignette ring
  const s = maskable ? 0.8 : 1; // keep content inside the maskable safe zone
  const u = (x - 0.5) / s + 0.5, v = (y - 0.5) / s + 0.5;
  const routeD = sdPolyline(u, v, ROUTE);
  const shadowD = sdPolyline(u + 0.012, v + 0.016, ROUTE);
  if (shadowD < 0.055) col = DARK;
  if (routeD < 0.055) col = WHITE;
  // Start dot
  if (Math.hypot(u - 0.24, v - 0.80) < 0.075) col = WHITE;
  if (Math.hypot(u - 0.24, v - 0.80) < 0.045) col = TEAL;
  // Destination pin (circle + point)
  const pinD = Math.min(Math.hypot(u - 0.74, v - 0.255), sdSeg(u, v, 0.74, 0.255, 0.74, 0.37) - 0.03);
  if (pinD < 0.085) col = WHITE;
  if (pinD < 0.06) col = RED;
  if (Math.hypot(u - 0.74, v - 0.255) < 0.028) col = WHITE;
  return [...col, 255];
}

function render(size, maskable) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, maskable);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; }
      out[i + 3] = a / (SS * SS);
    }
  }
  return png(size, size, out);
}

mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-192.png', render(192, false));
writeFileSync('icons/icon-512.png', render(512, false));
writeFileSync('icons/icon-maskable-512.png', render(512, true));
writeFileSync('icons/apple-touch-icon.png', render(180, true));
console.log('icons written');
