/**
 * Generates the original Maman app icon as a 1024x1024 PNG with zero external
 * dependencies (raw pixel buffer + zlib + hand-built PNG chunks). The result
 * feeds `tauri icon` to produce all platform sizes.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const S = 1024;
const px = new Uint8Array(S * S * 4);

const BODY_FROM = [0x4f, 0x46, 0xe5]; // indigo
const BODY_TO = [0xa5, 0xa6, 0xf6]; // lavender
const FACE = [0xff, 0xf7, 0xea]; // cream
const INK = [0x3b, 0x3e, 0x6b];
const BLUSH = [0xf2, 0xb8, 0xb5];

function put(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  px[i] = Math.round(r * na + px[i] * (1 - na));
  px[i + 1] = Math.round(g * na + px[i + 1] * (1 - na));
  px[i + 2] = Math.round(b * na + px[i + 2] * (1 - na));
  px[i + 3] = Math.max(px[i + 3], a);
}

function ellipse(cx, cy, rx, ry, color, alpha = 255) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) {
        const edge = Math.min(1, (1 - d) * rx * 0.15); // soft edge
        put(x, y, color, Math.round(alpha * Math.min(1, edge)));
      }
    }
  }
}

function gradientBody(cx, cy, r) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d <= 1) {
        // radial: lavender highlight upper-left → indigo rim
        const hx = (x - (cx - r * 0.35)) / r;
        const hy = (y - (cy - r * 0.45)) / r;
        const t = Math.min(1, Math.hypot(hx, hy));
        const c = BODY_FROM.map((f, i) => Math.round(BODY_TO[i] * (1 - t) + f * t));
        const edge = Math.min(1, (1 - d) * r * 0.08);
        put(x, y, c, Math.round(255 * Math.min(1, edge)));
      }
    }
  }
}

function stroke(x1, y1, x2, y2, width, color) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    ellipse(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width, width, color);
  }
}

// antennae
stroke(400, 300, 330, 170, 22, BODY_FROM);
ellipse(325, 160, 42, 42, BODY_TO);
stroke(624, 300, 694, 170, 22, BODY_FROM);
ellipse(699, 160, 42, 42, BODY_TO);

// body
gradientBody(512, 600, 360);

// face patch
ellipse(512, 540, 240, 185, FACE, 245);

// blush
ellipse(350, 590, 45, 26, BLUSH, 200);
ellipse(674, 590, 45, 26, BLUSH, 200);

// eyes
ellipse(430, 500, 42, 58, INK);
ellipse(594, 500, 42, 58, INK);
ellipse(416, 478, 13, 13, [255, 255, 255]);
ellipse(580, 478, 13, 13, [255, 255, 255]);

// smile
for (let x = 460; x <= 564; x++) {
  const t = (x - 460) / 104;
  const y = 640 + Math.sin(t * Math.PI) * 34;
  ellipse(x, y, 10, 10, INK);
}

// ---- PNG encoding ----
function crc32(buf) {
  let c,
    table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src-tauri", "icons", "source.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
