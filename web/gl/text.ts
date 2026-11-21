// Diff text on the GPU: MTSDF glyphs, one instanced quad per glyph, sharp at any zoom. Ported from golemdocs
// (client/src/webgl/text: gpuFace.ts, glyphTable.ts, textShaders.ts, textRenderer.ts, textBatch.ts, and
// shapes/rectBatch.ts for the row backgrounds), without its page colours, emoji and instance packing.
//
// A file's text is laid out in its own "text px" (12px monospace at text scale 1), with y down from the top of its
// first line. Drawing places it with uniforms: where its origin is on screen, how many device px a text px is,
// how far it's scrolled, and how faded it is; and clips it to its box with the scissor. So zooming, panning,
// scrolling and fading never touch a buffer.

import { createProgram, uniforms } from './program.ts'

/** Bytes per glyph instance: x, y (baseline), size (text px per em) as float32; glyph uint16 + pad; colour RGBA8. */
export const GLYPH_BYTES = 20
/** Bytes per rectangle instance: x, y, width, height (text px) as float32; colour RGBA8. */
export const RECT_BYTES = 20

// ---------- the font face ----------

/** The glyph layout msdf-atlas-gen writes (the JSON beside each atlas image). */
export interface AtlasLayout {
  atlas: { distanceRange: number; size: number; width: number; height: number }
  metrics: { lineHeight: number; ascender: number; descender: number }
  glyphs: {
    unicode: number
    advance: number
    planeBounds?: { left: number; top: number; right: number; bottom: number }
    atlasBounds?: { left: number; top: number; right: number; bottom: number }
  }[]
}

// The glyph table: two RGBA32F texels per glyph (plane bounds in ems, atlas UVs), folded into rows of 128 glyphs
// so no face needs a texture taller than WebGL's guaranteed 2048 (glyphTable.ts in golemdocs; the shader uses the
// same math).
const GLYPH_COLUMNS_SHIFT = 7
const GLYPH_COLUMNS = 1 << GLYPH_COLUMNS_SHIFT
const GLYPH_TABLE_WIDTH = GLYPH_COLUMNS * 2

/** Codepoint → glyph index, and the em advance (one for the whole face: it's monospace). */
export interface FaceMetrics {
  glyphOf: Record<number, number>
  advance: number
  ascender: number
  lineHeight: number
}

export function faceMetrics(layout: AtlasLayout): FaceMetrics {
  const glyphOf: Record<number, number> = {}
  layout.glyphs.forEach((g, i) => (glyphOf[g.unicode] = i))
  const m = layout.glyphs.find((g) => g.unicode === 0x4d) // "M"
  return { glyphOf, advance: m?.advance ?? 0.6, ascender: -layout.metrics.ascender, lineHeight: layout.metrics.lineHeight }
}

/** One face on the GPU: its MTSDF atlas and glyph table. Draws nothing until the atlas image has loaded. */
export class GpuFace {
  readonly glyphTable: WebGLTexture
  atlas: WebGLTexture | null = null
  readonly distanceRangeEm: number
  readonly atlasWidth: number
  readonly atlasHeight: number

  constructor(private readonly gl: WebGL2RenderingContext, layout: AtlasLayout) {
    const { atlas, glyphs } = layout
    this.distanceRangeEm = atlas.distanceRange / atlas.size
    this.atlasWidth = atlas.width
    this.atlasHeight = atlas.height
    const rows = Math.max(1, Math.ceil(glyphs.length / GLYPH_COLUMNS))
    const table = new Float32Array(rows * GLYPH_TABLE_WIDTH * 4)
    glyphs.forEach((g, i) => {
      const p = g.planeBounds
      const a = g.atlasBounds
      if (!p || !a) return
      const o = i * 8
      // y down, as the layout's top-origin atlas is.
      table.set([p.left, p.top, p.right, p.bottom, a.left / atlas.width, a.top / atlas.height, a.right / atlas.width, a.bottom / atlas.height], o)
    })
    this.glyphTable = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTable)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, GLYPH_TABLE_WIDTH, rows)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GLYPH_TABLE_WIDTH, rows, gl.RGBA, gl.FLOAT, table)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** The atlas image. The distance field must reach the GPU byte for byte: no premultiply, no colour management. */
  setAtlas(image: ImageBitmap): void {
    const gl = this.gl
    this.atlas = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.atlas)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.atlasWidth, this.atlasHeight)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image)
    // No mipmaps: glyphs are packed tightly, so smaller levels bleed neighbours together. Minified text is
    // supersampled in the fragment shader instead.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    image.close()
  }
}

/** Loads a face: its glyph layout (JSON) at once, its atlas image as it arrives (calls onLoad then). */
export async function loadFace(gl: WebGL2RenderingContext, base: string, onLoad: () => void): Promise<{ face: GpuFace; metrics: FaceMetrics }> {
  const layout = (await fetch(base + '.json').then((r) => r.json())) as AtlasLayout
  const face = new GpuFace(gl, layout)
  void fetch(base + '.webp')
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
    .then((image) => {
      face.setAtlas(image)
      onLoad()
    })
  return { face, metrics: faceMetrics(layout) }
}

// ---------- shaders ----------

const TEXT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_position; // pen on the baseline, text px
layout(location = 1) in float a_size;    // text px per em
layout(location = 2) in uint a_glyph;
layout(location = 3) in vec4 a_color;
uniform highp sampler2D u_glyphTable;    // glyph g: row g >> 7, texel (g & 127) * 2 = plane bounds (em), next = atlas UVs
uniform vec2 u_translate;                // where text px (0, 0) is, device px
uniform float u_scale;                   // device px per text px
uniform vec2 u_viewport;                 // device px
uniform float u_distanceRangeEm;
uniform float u_alpha;                   // the file's fade
out vec2 v_uv;
flat out float v_screenPxRange;
flat out vec4 v_color;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  int g = int(a_glyph);
  ivec2 at = ivec2((g & 127) * 2, g >> 7);
  vec4 plane = texelFetch(u_glyphTable, at, 0);
  vec4 atlas = texelFetch(u_glyphTable, at + ivec2(1, 0), 0);
  vec2 local = mix(plane.xy, plane.zw, corner);
  vec2 screen = (a_position + local * a_size) * u_scale + u_translate;
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_uv = mix(atlas.xy, atlas.zw, corner);
  v_screenPxRange = max(u_distanceRangeEm * a_size * u_scale, 1.0);
  v_color = vec4(a_color.rgb, a_color.a * u_alpha);
}
`

const TEXT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
uniform mediump sampler2D u_atlas;
uniform vec2 u_atlasSize;
in highp vec2 v_uv;
flat in float v_screenPxRange;
flat in vec4 v_color;
out vec4 outColor;
float median(float r, float g, float b) { return max(min(r, g), min(max(r, g), b)); }
float coverage(highp vec2 uv, float pxRange) {
  vec3 msdf = textureLod(u_atlas, uv, 0.0).rgb;
  return clamp((median(msdf.r, msdf.g, msdf.b) - 0.5) * pxRange + 0.5, 0.0, 1.0);
}
void main() {
  highp vec2 dx = dFdx(v_uv);
  highp vec2 dy = dFdy(v_uv);
  // Zoomed-out text spans several atlas texels per pixel and shimmers: average a rotated 2x2 grid instead.
  float footprint = max(length(dx * u_atlasSize), length(dy * u_atlasSize));
  float c;
  if (footprint > 1.5) {
    c = 0.25 * (
      coverage(v_uv - 0.125 * dx - 0.375 * dy, v_screenPxRange) +
      coverage(v_uv + 0.375 * dx - 0.125 * dy, v_screenPxRange) +
      coverage(v_uv + 0.125 * dx + 0.375 * dy, v_screenPxRange) +
      coverage(v_uv - 0.375 * dx + 0.125 * dy, v_screenPxRange));
  } else c = coverage(v_uv, v_screenPxRange);
  float alpha = v_color.a * c;
  outColor = vec4(v_color.rgb * alpha, alpha);
}
`

const RECT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_rect;  // x, y, width, height in text px
layout(location = 1) in vec4 a_color;
uniform vec2 u_translate;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_alpha;
flat out vec4 v_color;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 screen = (a_rect.xy + corner * a_rect.zw) * u_scale + u_translate;
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  float a = a_color.a * u_alpha;
  v_color = vec4(a_color.rgb * a, a);
}
`

const RECT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
flat in vec4 v_color;
out vec4 outColor;
void main() { outColor = v_color; }
`

// ---------- a file's text: glyphs and backgrounds ----------

/** One file's laid-out text on the GPU. Uploaded once (or when its layout changes), drawn with uniforms. */
export class TextBlock {
  private glyphVao: WebGLVertexArrayObject
  private glyphBuffer: WebGLBuffer
  private rectVao: WebGLVertexArrayObject
  private rectBuffer: WebGLBuffer
  glyphs = 0
  rects = 0

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.glyphVao = gl.createVertexArray()
    this.glyphBuffer = gl.createBuffer()
    gl.bindVertexArray(this.glyphVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, GLYPH_BYTES, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, GLYPH_BYTES, 8)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, GLYPH_BYTES, 12)
    gl.vertexAttribDivisor(2, 1)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, GLYPH_BYTES, 16)
    gl.vertexAttribDivisor(3, 1)
    this.rectVao = gl.createVertexArray()
    this.rectBuffer = gl.createBuffer()
    gl.bindVertexArray(this.rectVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, RECT_BYTES, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, RECT_BYTES, 16)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  /** Replaces its contents with instances the worker laid out. */
  upload(glyphs: ArrayBuffer, glyphCount: number, rects: ArrayBuffer, rectCount: number): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(glyphs, 0, glyphCount * GLYPH_BYTES), gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(rects, 0, rectCount * RECT_BYTES), gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    this.glyphs = glyphCount
    this.rects = rectCount
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteVertexArray(this.glyphVao)
    gl.deleteVertexArray(this.rectVao)
    gl.deleteBuffer(this.glyphBuffer)
    gl.deleteBuffer(this.rectBuffer)
  }

  /** @internal for TextRenderer */
  vaos() {
    return { glyph: this.glyphVao, rect: this.rectVao }
  }
}

/** Where and how to draw one block this frame. */
export interface Placement {
  /** device px of text px (0, 0): the block's origin, already moved by its scroll */
  x: number
  y: number
  /** device px per text px */
  scale: number
  /** the file's fade, 0 to 1 */
  alpha: number
  /** clip rectangle, device px from the canvas's top-left */
  clip: { x: number; y: number; w: number; h: number }
}

export class TextRenderer {
  private readonly text: WebGLProgram
  private readonly rect: WebGLProgram
  private readonly ut: Record<'u_glyphTable' | 'u_atlas' | 'u_translate' | 'u_scale' | 'u_viewport' | 'u_distanceRangeEm' | 'u_alpha' | 'u_atlasSize', WebGLUniformLocation>
  private readonly ur: Record<'u_translate' | 'u_scale' | 'u_viewport' | 'u_alpha', WebGLUniformLocation>

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.text = createProgram(gl, TEXT_VERTEX, TEXT_FRAGMENT)
    this.ut = uniforms(gl, this.text, ['u_glyphTable', 'u_atlas', 'u_translate', 'u_scale', 'u_viewport', 'u_distanceRangeEm', 'u_alpha', 'u_atlasSize'] as const)
    this.rect = createProgram(gl, RECT_VERTEX, RECT_FRAGMENT)
    this.ur = uniforms(gl, this.rect, ['u_translate', 'u_scale', 'u_viewport', 'u_alpha'] as const)
    gl.useProgram(this.text)
    gl.uniform1i(this.ut.u_atlas, 0)
    gl.uniform1i(this.ut.u_glyphTable, 1)
  }

  /** Draws blocks (backgrounds, then text) each clipped to its box. Leaves the scissor off. */
  render(face: GpuFace, blocks: { block: TextBlock; at: Placement }[], viewport: { width: number; height: number }): void {
    const gl = this.gl
    if (!blocks.length) return
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)
    const clip = (c: Placement['clip']) => {
      // The scissor's origin is the bottom-left.
      const x = Math.max(0, Math.floor(c.x))
      const y = Math.max(0, Math.floor(viewport.height - (c.y + c.h)))
      gl.scissor(x, y, Math.max(0, Math.ceil(c.w + (c.x - x))), Math.max(0, Math.ceil(c.h)))
    }
    // Backgrounds first, for every block, so text never sits under a neighbour's row colours.
    gl.useProgram(this.rect)
    gl.uniform2f(this.ur.u_viewport, viewport.width, viewport.height)
    for (const { block, at } of blocks) {
      if (!block.rects) continue
      clip(at.clip)
      gl.uniform2f(this.ur.u_translate, at.x, at.y)
      gl.uniform1f(this.ur.u_scale, at.scale)
      gl.uniform1f(this.ur.u_alpha, at.alpha)
      gl.bindVertexArray(block.vaos().rect)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, block.rects)
    }
    if (face.atlas) {
      gl.useProgram(this.text)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, face.atlas)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, face.glyphTable)
      gl.uniform2f(this.ut.u_viewport, viewport.width, viewport.height)
      gl.uniform1f(this.ut.u_distanceRangeEm, face.distanceRangeEm)
      gl.uniform2f(this.ut.u_atlasSize, face.atlasWidth, face.atlasHeight)
      for (const { block, at } of blocks) {
        if (!block.glyphs) continue
        clip(at.clip)
        gl.uniform2f(this.ut.u_translate, at.x, at.y)
        gl.uniform1f(this.ut.u_scale, at.scale)
        gl.uniform1f(this.ut.u_alpha, at.alpha)
        gl.bindVertexArray(block.vaos().glyph)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, block.glyphs)
      }
    }
    gl.bindVertexArray(null)
    gl.disable(gl.SCISSOR_TEST)
  }
}
