/**
 * Generates assets/icon.png (512x512) without any image dependencies:
 * a rounded indigo tile, a white check mark, and a red squiggle underline.
 *
 * Run with: node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const SS = 3; // supersampling factor for antialiasing

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRectSDF(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius);
  const qy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance to the thick segment from a to b. */
function segmentSDF(x, y, ax, ay, bx, by, halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - halfWidth;
}

function sampleColor(x, y) {
  // Background tile with a vertical indigo gradient.
  if (roundedRectSDF(x, y, 256, 256, 232, 232, 108) > 0) return null;

  const t = y / SIZE;
  let color = [
    Math.round(88 + t * 26), // 88 -> 114
    Math.round(80 - t * 22), // 80 -> 58
    Math.round(220 - t * 26), // 220 -> 194
  ];

  // Red squiggle underline: a sine wave stroked as a chain of segments.
  const waveY = 372;
  const amplitude = 26;
  const period = 108;
  for (let i = 0; i < 40; i++) {
    const ax = 132 + (i * 248) / 40;
    const bx = 132 + ((i + 1) * 248) / 40;
    const ay = waveY + amplitude * Math.sin((ax / period) * Math.PI * 2);
    const by = waveY + amplitude * Math.sin((bx / period) * Math.PI * 2);
    if (segmentSDF(x, y, ax, ay, bx, by, 11) < 0) return [239, 68, 68];
  }

  // White check mark above the squiggle.
  const shortArm = segmentSDF(x, y, 168, 240, 226, 296, 22);
  const longArm = segmentSDF(x, y, 226, 296, 348, 152, 22);
  if (Math.min(shortArm, longArm) < 0) return [255, 255, 255];

  return color;
}

// Render with supersampling, compositing against transparent outside the tile.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  const rowStart = py * (SIZE * 4 + 1);
  raw[rowStart] = 0; // PNG filter type: none
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const color = sampleColor(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        if (color) {
          r += color[0];
          g += color[1];
          b += color[2];
          hits++;
        }
      }
    }
    const samples = SS * SS;
    const offset = rowStart + 1 + px * 4;
    if (hits === 0) {
      raw.writeUInt32BE(0, offset);
    } else {
      raw[offset] = Math.round(r / hits);
      raw[offset + 1] = Math.round(g / hits);
      raw[offset + 2] = Math.round(b / hits);
      raw[offset + 3] = Math.round((hits / samples) * 255);
    }
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "assets", "icon.png"), png);
console.log(`Wrote assets/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)`);
