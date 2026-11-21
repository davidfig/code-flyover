// Immediate-mode triangles in device pixels: arrows, outlines, anything rebuilt every frame. The caller converts
// from world space on the CPU. Vertex format and shader from golemdocs' TriangleBatch
// (client/src/webgl/shapes/triangleBatch.ts), made immediate like its RectRenderer.

import { createProgram, uniforms } from './program.ts'

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position; // device px
layout(location = 1) in vec4 a_color;    // straight RGBA
uniform vec2 u_viewport;
out vec4 v_color;
void main() {
  gl_Position = vec4(a_position / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
}
`

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`

const VERTEX_BYTES = 12

export class Shapes {
  private readonly program: WebGLProgram
  private readonly u: Record<'u_viewport', WebGLUniformLocation>
  private readonly vao: WebGLVertexArrayObject
  private readonly buffer: WebGLBuffer
  private data = new ArrayBuffer(4096 * VERTEX_BYTES)
  private f32 = new Float32Array(this.data)
  private u32 = new Uint32Array(this.data)
  private count = 0

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX, FRAGMENT)
    this.u = uniforms(gl, this.program, ['u_viewport'] as const)
    this.vao = gl.createVertexArray()
    this.buffer = gl.createBuffer()
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_BYTES, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 8)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private vertex(x: number, y: number, color: number): void {
    if ((this.count + 1) * VERTEX_BYTES > this.data.byteLength) {
      const data = new ArrayBuffer(this.data.byteLength * 2)
      new Uint8Array(data).set(new Uint8Array(this.data))
      this.data = data
      this.f32 = new Float32Array(data)
      this.u32 = new Uint32Array(data)
    }
    const f = this.count * 3
    this.f32[f] = x
    this.f32[f + 1] = y
    this.u32[f + 2] = color
    this.count++
  }

  triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, color: number): void {
    this.vertex(x0, y0, color)
    this.vertex(x1, y1, color)
    this.vertex(x2, y2, color)
  }

  /** A straight segment `width` device px wide. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: number): void {
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * width * 0.5
    const ny = (dx / len) * width * 0.5
    this.triangle(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, color)
    this.triangle(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, color)
  }

  /** A polyline as one strip of quads, joined so a curve has no gaps or doubled-up overlaps at its joints. */
  polyline(points: number[], width: number, color: number): void {
    const n = points.length / 2
    if (n < 2) return
    const half = width * 0.5
    const side: number[] = []
    for (let i = 0; i < n; i++) {
      const p = Math.max(0, i - 1)
      const q = Math.min(n - 1, i + 1)
      const dx = points[q * 2] - points[p * 2]
      const dy = points[q * 2 + 1] - points[p * 2 + 1]
      const len = Math.hypot(dx, dy) || 1
      side.push((-dy / len) * half, (dx / len) * half)
    }
    for (let i = 0; i < n - 1; i++) {
      const ax = points[i * 2], ay = points[i * 2 + 1], bx = points[i * 2 + 2], by = points[i * 2 + 3]
      const anx = side[i * 2], any = side[i * 2 + 1], bnx = side[i * 2 + 2], bny = side[i * 2 + 3]
      this.triangle(ax + anx, ay + any, bx + bnx, by + bny, bx - bnx, by - bny, color)
      this.triangle(ax + anx, ay + any, bx - bnx, by - bny, ax - anx, ay - any, color)
    }
  }

  /** A rectangle's outline, `width` device px wide, drawn inside its edge. */
  outline(x: number, y: number, w: number, h: number, width: number, color: number): void {
    const t = Math.min(width, w / 2, h / 2)
    this.quad(x, y, w, t, color)
    this.quad(x, y + h - t, w, t, color)
    this.quad(x, y + t, t, h - 2 * t, color)
    this.quad(x + w - t, y + t, t, h - 2 * t, color)
  }

  quad(x: number, y: number, w: number, h: number, color: number): void {
    this.triangle(x, y, x + w, y, x + w, y + h, color)
    this.triangle(x, y, x + w, y + h, x, y + h, color)
  }

  /** Draws everything queued since the last flush, in order. */
  flush(viewportWidth: number, viewportHeight: number): void {
    if (this.count === 0) return
    const gl = this.gl
    gl.useProgram(this.program)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform2f(this.u.u_viewport, viewportWidth, viewportHeight)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, this.count * VERTEX_BYTES), gl.STREAM_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, this.count)
    gl.bindVertexArray(null)
    this.count = 0
  }
}
