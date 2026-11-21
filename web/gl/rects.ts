// Retained rectangles in world space (the map's boxes and files), uploaded when they change and positioned with
// uniforms, so panning and zooming never touch the buffer. Adapted from golemdocs' RectBatch
// (client/src/webgl/shapes/rectBatch.ts), with an inset per rectangle so a box can be a border plus a fill.

import { createProgram, uniforms } from './program.ts'
import type { Camera } from './camera.ts'

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_rect;   // x, y, width, height in world units
layout(location = 1) in vec4 a_color;  // straight RGBA
layout(location = 2) in float a_inset; // device px to shrink by on each side (a fill inside a border)
uniform vec2 u_camera;                 // world point at the canvas's top-left
uniform float u_scale;                 // device px per world unit
uniform vec2 u_viewport;               // device px
flat out vec4 v_color;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 size = a_rect.zw * u_scale - 2.0 * a_inset;
  // Hairlines stay at least one device pixel so they never vanish; an inset fill with no room left is dropped.
  vec2 grow = a_inset > 0.0 ? vec2(0.0) : max(vec2(1.0) - size, vec2(0.0));
  size = max(size, vec2(0.0));
  vec2 origin = (a_rect.xy - u_camera) * u_scale + a_inset - grow * 0.5;
  vec2 screen = origin + corner * (size + grow);
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
}
`

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
flat in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`

const INSTANCE_BYTES = 24
const FLOATS = INSTANCE_BYTES / 4

export class RectLayer {
  private readonly program: WebGLProgram
  private readonly u: Record<'u_camera' | 'u_scale' | 'u_viewport', WebGLUniformLocation>
  private readonly vao: WebGLVertexArrayObject
  private readonly buffer: WebGLBuffer
  private data = new ArrayBuffer(256 * INSTANCE_BYTES)
  private f32 = new Float32Array(this.data)
  private u32 = new Uint32Array(this.data)
  private count = 0
  private dirty = false

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX, FRAGMENT)
    this.u = uniforms(gl, this.program, ['u_camera', 'u_scale', 'u_viewport'] as const)
    this.vao = gl.createVertexArray()
    this.buffer = gl.createBuffer()
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, INSTANCE_BYTES, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, 16)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, INSTANCE_BYTES, 20)
    gl.vertexAttribDivisor(2, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  clear(): void {
    this.count = 0
    this.dirty = true
  }

  /** A filled rectangle in world units, drawn in the order added. `color` is from rgba(). */
  add(x: number, y: number, w: number, h: number, color: number, insetPx = 0): void {
    if ((this.count + 1) * INSTANCE_BYTES > this.data.byteLength) {
      const data = new ArrayBuffer(this.data.byteLength * 2)
      new Uint8Array(data).set(new Uint8Array(this.data))
      this.data = data
      this.f32 = new Float32Array(data)
      this.u32 = new Uint32Array(data)
    }
    const f = this.count * FLOATS
    this.f32[f] = x
    this.f32[f + 1] = y
    this.f32[f + 2] = w
    this.f32[f + 3] = h
    this.u32[f + 4] = color
    this.f32[f + 5] = insetPx
    this.count++
    this.dirty = true
  }

  /** A box with a one-device-pixel border. */
  addBox(x: number, y: number, w: number, h: number, fill: number, border: number, dpr: number): void {
    this.add(x, y, w, h, border)
    this.add(x, y, w, h, fill, Math.max(1, Math.round(dpr)))
  }

  render(camera: Camera): void {
    if (this.count === 0) return
    const gl = this.gl
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, this.count * INSTANCE_BYTES), gl.STATIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      this.dirty = false
    }
    gl.useProgram(this.program)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform2f(this.u.u_camera, camera.x, camera.y)
    gl.uniform1f(this.u.u_scale, camera.scale * camera.dpr)
    gl.uniform2f(this.u.u_viewport, camera.width * camera.dpr, camera.height * camera.dpr)
    gl.bindVertexArray(this.vao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count)
    gl.bindVertexArray(null)
  }
}
