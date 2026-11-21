// A cached picture of the whole map's diff text, for when the text is small: drawing millions of pixel-sized glyphs
// every frame while you pan is the GPU's whole frame budget (the frame-timing readout showed ~20 ms for 3.6 million).
// Instead the text is drawn into a texture covering the map, at the current zoom rounded up to a power of two, and
// each frame draws that texture as one quad. Within a power of two it's only scaled (down, with mipmaps, so it stays
// sharp).
//
// Two pictures: the one on screen (front), and the next one (back), built a slice of files per frame while the
// front one keeps showing, then swapped in. So crossing a zoom level, or new text arriving, never redraws the whole
// map in one frame.

import { createProgram, uniforms } from './program.ts'

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_rect;     // x, y, width, height in device px
uniform vec2 u_viewport; // device px
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 screen = u_rect.xy + corner * u_rect.zw;
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  // The texture was drawn with the same y-down mapping into a framebuffer whose rows run bottom-up: flip back.
  v_uv = vec2(corner.x, 1.0 - corner.y);
}
`

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_image;
uniform float u_alpha;
in vec2 v_uv;
out vec4 outColor;
void main() { outColor = texture(u_image, v_uv) * u_alpha; } // premultiplied
`

/** One picture: a texture and the framebuffer to draw into it. */
interface Target {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  /** device px per world unit it was drawn at, and the files it holds (see map.ts) */
  level: number
  key: string
}

export class TextCache {
  private program: WebGLProgram
  private u: Record<'u_rect' | 'u_viewport' | 'u_image' | 'u_alpha', WebGLUniformLocation>
  private vao: WebGLVertexArrayObject
  /** on screen, and being built */
  front: Target | null = null
  private back: Target | null = null
  /** the build in progress: what it's for, and the files still to draw into it */
  build: { level: number; key: string; queue: number[] } | null = null
  /** the front picture's text changed since it was built (new layouts): rebuild when the throttle allows */
  dirty = false
  builtAt = -Infinity
  readonly maxSize: number

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX, FRAGMENT)
    this.u = uniforms(gl, this.program, ['u_rect', 'u_viewport', 'u_image', 'u_alpha'] as const)
    this.vao = gl.createVertexArray()
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 4096)
  }

  /** Starts building the next picture: `width` by `height` px, for `level` and `key`, drawing `files` into it. */
  start(width: number, height: number, level: number, key: string, files: number[]) {
    const gl = this.gl
    if (!this.back || this.back.width !== width || this.back.height !== height) {
      if (this.back) this.free(this.back)
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      const levels = Math.floor(Math.log2(Math.max(width, height))) + 1
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this.back = { texture, fbo, width, height, level, key }
    }
    this.back.level = level
    this.back.key = key
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.back.fbo)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.build = { level, key, queue: files.slice() }
    this.dirty = false
  }

  /** Binds the picture being built to draw a slice into it (call `release` after). Its size, or null if none. */
  bindBack(): { width: number; height: number } | null {
    if (!this.back || !this.build) return null
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.back.fbo)
    this.gl.viewport(0, 0, this.back.width, this.back.height)
    return { width: this.back.width, height: this.back.height }
  }

  release(canvasWidth: number, canvasHeight: number) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
    this.gl.viewport(0, 0, canvasWidth, canvasHeight)
  }

  /** The build is done: make its mipmaps and put it on screen. */
  finish(now: number) {
    const gl = this.gl
    if (!this.back) return
    gl.bindTexture(gl.TEXTURE_2D, this.back.texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.bindTexture(gl.TEXTURE_2D, null)
    const old = this.front
    this.front = this.back
    this.back = old
    this.build = null
    this.builtAt = now
  }

  private free(t: Target) {
    this.gl.deleteTexture(t.texture)
    this.gl.deleteFramebuffer(t.fbo)
  }

  /** Forgets both pictures (a new analysis). */
  reset() {
    if (this.front) this.free(this.front)
    if (this.back) this.free(this.back)
    this.front = this.back = null
    this.build = null
    this.dirty = false
  }

  /** Draws the front picture at a device-px rectangle on the canvas. */
  draw(x: number, y: number, w: number, h: number, alpha: number, viewport: { width: number; height: number }) {
    if (!this.front) return
    const gl = this.gl
    gl.useProgram(this.program)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.front.texture)
    gl.uniform1i(this.u.u_image, 0)
    gl.uniform4f(this.u.u_rect, x, y, w, h)
    gl.uniform2f(this.u.u_viewport, viewport.width, viewport.height)
    gl.uniform1f(this.u.u_alpha, alpha)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }
}
