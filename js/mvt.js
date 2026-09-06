// Minimal Mapbox Vector Tile (MVT / protobuf) decoder — enough to read the
// named places out of the tiles the map already downloads. No dependencies.
// decodeTile(bytes, {z, x, y}) → { [layerName]: { extent, features: [{ type, properties, geometry }] } }
// Geometry is converted to lon/lat: points [[lon,lat]], lines [[[lon,lat],…]], polygons [[ring],…].

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get eof() {
    return this.p >= this.b.length;
  }
  varint() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.b[this.p++];
      if (shift < 28) result += (byte & 0x7f) << shift;
      else result += (byte & 0x7f) * 2 ** shift; // beyond 32 bits: lose exactness past 2^53, fine for tags
      shift += 7;
    } while (byte >= 0x80);
    return result;
  }
  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.p += 8;
    else if (wireType === 2) this.p += this.varint();
    else if (wireType === 5) this.p += 4;
    else throw new Error(`bad wire type ${wireType}`);
  }
  bytes() {
    const len = this.varint();
    const out = this.b.subarray(this.p, this.p + len);
    this.p += len;
    return out;
  }
  string() {
    return new TextDecoder().decode(this.bytes());
  }
  double() {
    const v = this.view.getFloat64(this.p, true);
    this.p += 8;
    return v;
  }
  float() {
    const v = this.view.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }
}

const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(bytes) {
  const r = new Reader(bytes);
  while (!r.eof) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;
    switch (field) {
      case 1:
        return r.string();
      case 2:
        return r.float();
      case 3:
        return r.double();
      case 4:
      case 5:
        return r.varint();
      case 6:
        return zigzag(r.varint());
      case 7:
        return r.varint() !== 0;
      default:
        r.skip(wt);
    }
  }
  return null;
}

function readPacked(r, wt) {
  if (wt !== 2) return [r.varint()];
  const sub = new Reader(r.bytes());
  const out = [];
  while (!sub.eof) out.push(sub.varint());
  return out;
}

function readFeature(bytes, keys, values) {
  const r = new Reader(bytes);
  const f = { id: null, type: 0, properties: {}, geom: [] };
  while (!r.eof) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;
    if (field === 1) f.id = r.varint();
    else if (field === 2) {
      const tags = readPacked(r, wt);
      for (let i = 0; i + 1 < tags.length; i += 2) f.properties[keys[tags[i]]] = values[tags[i + 1]];
    } else if (field === 3) f.type = r.varint();
    else if (field === 4) f.geom = readPacked(r, wt);
    else r.skip(wt);
  }
  return f;
}

function readLayer(bytes) {
  const r = new Reader(bytes);
  const layer = { name: '', extent: 4096, keys: [], values: [], rawFeatures: [] };
  while (!r.eof) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;
    if (field === 1) layer.name = r.string();
    else if (field === 2) layer.rawFeatures.push(r.bytes());
    else if (field === 3) layer.keys.push(r.string());
    else if (field === 4) layer.values.push(readValue(r.bytes()));
    else if (field === 5) layer.extent = r.varint();
    else r.skip(wt);
  }
  return layer;
}

/** Tile-local integer coords → lon/lat. */
function projector({ z, x, y }, extent) {
  const n = 2 ** z;
  return (px, py) => {
    const lon = ((x + px / extent) / n) * 360 - 180;
    const yy = (y + py / extent) / n;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180) / Math.PI;
    return [lon, lat];
  };
}

function decodeGeometry(geom, type, project) {
  let cx = 0;
  let cy = 0;
  const parts = [];
  let cur = null;
  for (let i = 0; i < geom.length; ) {
    const cmdInt = geom[i++];
    const cmd = cmdInt & 7;
    const count = cmdInt >> 3;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < count; k++) {
        cx += zigzag(geom[i++]);
        cy += zigzag(geom[i++]);
        if (cmd === 1) {
          cur = [];
          parts.push(cur);
        }
        cur?.push(project(cx, cy));
      }
    } else if (cmd === 7) {
      if (cur && cur.length) cur.push(cur[0]);
    } else break;
  }
  if (type === 1) return parts.flat(); // points
  return parts; // line strings or polygon rings
}

export function decodeTile(bytes, tile) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const r = new Reader(u8);
  const layers = {};
  while (!r.eof) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;
    if (field === 3) {
      const layer = readLayer(r.bytes());
      const project = projector(tile, layer.extent);
      layers[layer.name] = {
        extent: layer.extent,
        features: layer.rawFeatures.map((fb) => {
          const f = readFeature(fb, layer.keys, layer.values);
          return { id: f.id, type: f.type, properties: f.properties, geometry: decodeGeometry(f.geom, f.type, project) };
        }),
      };
    } else r.skip(wt);
  }
  return layers;
}

/** Slippy-map tile containing a lon/lat at zoom z. */
export function tileAt(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}
