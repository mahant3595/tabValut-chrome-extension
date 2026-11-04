// TabVault — generates assets/icon{16,48,128}.png (pure Node, no deps).
// Design: near-black rounded-ish square with a cyan→violet gradient mark.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'assets');

// ------------------------------------------------------------- tiny PNG encoder

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------- drawing

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [7, 8, 13];
  const c1 = [34, 211, 238]; // cyan
  const c2 = [168, 85, 247]; // violet
  const pad = Math.max(1, Math.round(size * 0.12));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const inside = x >= pad && x < size - pad && y >= pad && y < size - pad;
      // rounded corners
      const r = size * 0.22;
      const cx = Math.min(x + 0.5, size - x - 0.5);
      const cy = Math.min(y + 0.5, size - y - 0.5);
      const corner = cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r;
      if (inside && !corner) {
        const t = (x + y) / (2 * (size - 1));
        rgba[i] = mix(c1[0], c2[0], t);
        rgba[i + 1] = mix(c1[1], c2[1], t);
        rgba[i + 2] = mix(c1[2], c2[2], t);
      } else {
        rgba[i] = bg[0];
        rgba[i + 1] = bg[1];
        rgba[i + 2] = bg[2];
      }
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, draw(size));
  console.log(`wrote ${file}`);
}
