// Generates assets/pi.png: a 512x512 white-background PNG with a black Pi
// symbol, used as the default ntfy icon via the versioned jsDelivr URL.
//
// Pure Node (zlib + a minimal PNG encoder); no image libraries required.
// Run from the package root: node scripts/generate-pi-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const SUPER_SAMPLES = 4; // samples per axis per pixel

// Rounded-rectangle signed distance: negative values are inside the shape.
function roundedRectDistance(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  return (
    Math.min(Math.max(dx, dy), 0) +
    Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) -
    radius
  );
}

// Pi glyph geometry in normalized [0,1] coordinates.
function piGlyphDistance(px, py) {
  const bar = roundedRectDistance(px, py, 0.5, 0.27, 0.36, 0.075, 0.07);
  const leftLeg = roundedRectDistance(px, py, 0.352, 0.56, 0.052, 0.225, 0.05);
  const rightLeg = roundedRectDistance(px, py, 0.63, 0.51, 0.052, 0.175, 0.05);
  const rightFoot = roundedRectDistance(
    px,
    py,
    0.645,
    0.67,
    0.082,
    0.03,
    0.028,
  );
  return Math.min(bar, leftLeg, rightLeg, rightFoot);
}

function coverage(x, y) {
  let inside = 0;
  const step = 1 / SUPER_SAMPLES;
  for (let sy = 0; sy < SUPER_SAMPLES; sy += 1) {
    for (let sx = 0; sx < SUPER_SAMPLES; sx += 1) {
      const px = (x + (sx + 0.5) * step) / SIZE;
      const py = (y + (sy + 0.5) * step) / SIZE;
      if (piGlyphDistance(px, py) <= 0) {
        inside += 1;
      }
    }
  }
  return inside / (SUPER_SAMPLES * SUPER_SAMPLES);
}

// --- Minimal PNG encoder (RGB, 8-bit, filter 0) ---

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const rgb = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const alpha = coverage(x, y); // 0 = white, 1 = black
    const value = Math.round(255 * (1 - alpha));
    const offset = (y * SIZE + x) * 3;
    rgb[offset] = value;
    rgb[offset + 1] = value;
    rgb[offset + 2] = value;
  }
}

const output = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "pi.png"), encodePng(SIZE, SIZE, rgb));
console.log("wrote assets/pi.png");
