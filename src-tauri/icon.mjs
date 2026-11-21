// Draws the app's icon (a map of boxes: a module with files coloured like their diffs, one selected, its text as
// lines) into icon-1024.png, for `cargo tauri icon icon-1024.png` (see icon.sh). Plain Node, no image libraries: the
// shapes are rounded rectangles, filled with 4×4 supersampling and written as a PNG with zlib.

import fs from 'node:fs'
import zlib from 'node:zlib'

const S = 1024
const px = new Float32Array(S * S * 4) // premultiplied RGBA, 0..1

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]

/** Is (x, y) inside the rounded rectangle? */
const inside = (x, y, r) => {
  if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) return false
  const cx = Math.min(Math.max(x, r.x + r.r), r.x + r.w - r.r)
  const cy = Math.min(Math.max(y, r.y + r.r), r.y + r.h - r.r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r.r * r.r
}

/** Fills a rounded rectangle (or, with `stroke`, its outline that wide, inside its edge). */
function rect(x, y, w, h, rad, color, { stroke = 0, alpha = 1 } = {}) {
  const [cr, cg, cb] = hex(color)
  const outer = { x, y, w, h, r: rad }
  const inner = { x: x + stroke, y: y + stroke, w: w - 2 * stroke, h: h - 2 * stroke, r: Math.max(0, rad - stroke) }
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let pxl = Math.floor(x); pxl < Math.ceil(x + w); pxl++) {
      let cover = 0
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const fx = pxl + (sx + 0.5) / 4, fy = py + (sy + 0.5) / 4
          if (inside(fx, fy, outer) && !(stroke && inside(fx, fy, inner))) cover++
        }
      if (!cover) continue
      const a = (cover / 16) * alpha
      const i = (py * S + pxl) * 4
      px[i] = cr * a + px[i] * (1 - a)
      px[i + 1] = cg * a + px[i + 1] * (1 - a)
      px[i + 2] = cb * a + px[i + 2] * (1 - a)
      px[i + 3] = a + px[i + 3] * (1 - a)
    }
  }
}

// The macOS icon grid: an 824 px rounded square inside the 1024 canvas.
rect(100, 100, 824, 824, 185, '#f3f0e8')
rect(100, 100, 824, 824, 185, '#d3cdbf', { stroke: 8 })
rect(190, 190, 644, 644, 36, '#ebe6da')
rect(190, 190, 644, 644, 36, '#bfb7a5', { stroke: 10 })
rect(236, 236, 250, 330, 14, '#d3ecd9') // a new file
rect(236, 596, 250, 192, 14, '#f6d3d7') // a deleted one
rect(516, 236, 272, 170, 14, '#d9e6f3') // one that imports a changed file
rect(516, 436, 272, 352, 14, '#fbfaf6') // the selected file, its text showing
// Its lines of text, indented like code.
;[[552, 170], [552, 200], [576, 140], [552, 180], [576, 120], [552, 196]].forEach(([x, w], i) => rect(x, 480 + i * 44, w, 18, 9, '#8a8578', { alpha: 0.6 }))
rect(516, 436, 272, 352, 14, '#1f6feb', { stroke: 18 })

// PNG: 8-bit RGBA, unpremultiplied.
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, o = y * (S * 4 + 1) + 1 + x * 4
    const a = px[i + 3]
    raw[o] = a ? Math.round((px[i] / a) * 255) : 0
    raw[o + 1] = a ? Math.round((px[i + 1] / a) * 255) : 0
    raw[o + 2] = a ? Math.round((px[i + 2] / a) * 255) : 0
    raw[o + 3] = Math.round(a * 255)
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
fs.writeFileSync(
  new URL('./icon-1024.png', import.meta.url),
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
)
