/* The 2D view's Inspect layer: the map as a see-through model under the 2D markers, in the look of a tactical radar
 * (the walkable floors as layers with their outlines, the walls as a faint volume, a ground grid). The mesh is
 * maps3d/<map>/inspect.json + inspect.bin (cod2-assets src/cod2ff/viewer/export_maps.py export_inspect); it is drawn with WebGL 2 into a
 * canvas of its own, which the 2D renderer draws as its background (renderer.js drawLayer) - the live view and
 * the video export the same way. The camera is the 2D renderer's (its matrix for the plane z = zRef, the height
 * term kz, the yaw and tilt): the markers drawn on top line up with the mesh. The map does not move: the image is
 * drawn again only when the camera, the size or the look change - otherwise the last one is reused.
 *
 * Passes: the background and the grid; the volume (blended, no depth test: a faint glass); the floors into a
 * frame buffer with depth (the nearest floor at a pixel - overlapping surfaces do not add up), laid over once
 * with the floor opacity; the outlines on top. A roof cut drops everything above a height (per pixel). */
import { fetchBinary, fetchJSON, checkedView } from '../view3d/data.js';

const C2 = window.C2;

/** the look (Inspect popover, localStorage LOOK_KEY): colours '#rrggbb', opacities 0..1 */
export const LOOK_PRESETS = {
  radar: { label: 'Radar (green)', background: '#0e1824', floor: '#5f9664', floorOpacity: 0.3, heightShade: 0.35, byHeight: false,
    wall: '#4e6276', wallOpacity: 0.12, outline: '#96d78c', outlineOpacity: 0.4, grid: true, brightness: 1 },
  height: { label: 'Height colours', background: '#0b0f14', floor: '#5f9664', floorOpacity: 0.42, heightShade: 0, byHeight: true,
    wall: '#5a6470', wallOpacity: 0.12, outline: '#d8dee6', outlineOpacity: 0.28, grid: true, brightness: 1 },
  blueprint: { label: 'Blueprint', background: '#0d2a4a', floor: '#3d6fa3', floorOpacity: 0.3, heightShade: 0.3, byHeight: false,
    wall: '#9fc3e6', wallOpacity: 0.08, outline: '#e6f2ff', outlineOpacity: 0.5, grid: true, brightness: 1 },
  mono: { label: 'Grey', background: '#101114', floor: '#8a8f96', floorOpacity: 0.3, heightShade: 0.35, byHeight: false,
    wall: '#5c6068', wallOpacity: 0.14, outline: '#e3e5e8', outlineOpacity: 0.35, grid: false, brightness: 1 }
};
export const DEFAULT_LOOK = Object.assign({ preset: 'radar', roof: null }, LOOK_PRESETS.radar);

const rgb = hex => { const n = parseInt(String(hex).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

const MESH_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uM;
out vec3 vW;
void main() { vW = aPos; gl_Position = uM * vec4(aPos, 1.0); }`;
// uMode: 0 a colour (the floors: brighter higher up by uShade, or the height ramp), 1 the walls (lit by their
// facing), 2 lines; everything above uRoof (world z) dropped
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vW;
uniform vec4 uColor;
uniform int uMode;
uniform float uRoof;
uniform vec2 uZ;
uniform float uShade;
uniform bool uByHeight;
uniform float uBright;
out vec4 o;
vec3 ramp(float k) {
  vec3 a = vec3(0.16, 0.59, 0.67), b = vec3(0.43, 0.75, 0.35), c = vec3(0.92, 0.73, 0.27);
  return k < 0.5 ? mix(a, b, k * 2.0) : mix(b, c, k * 2.0 - 1.0);
}
void main() {
  if (vW.z > uRoof) discard;
  float k = clamp((vW.z - uZ.x) / max(1.0, uZ.y - uZ.x), 0.0, 1.0);
  vec3 c = uColor.rgb;
  if (uMode == 0) c = uByHeight ? ramp(k) : c * (1.0 - uShade * 0.5 + uShade * k);
  else if (uMode == 1) {
    vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
    c *= 0.62 + 0.38 * abs(n.x * 0.6 + n.y * 0.8);
  }
  o = vec4(c * uBright, uColor.a);
}`;
const QUAD_VS = `#version 300 es
in vec2 aP;
out vec2 vUv;
void main() { vUv = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;
const QUAD_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 o;
void main() { vec4 c = texture(uTex, vUv); o = vec4(c.rgb, c.a * uAlpha); }`;

export class InspectLayer {
  /** entry: backgrounds.js inspect {file, zRange}; rect: the 2D world rectangle {minX, ...} */
  constructor(entry, rect) {
    this.entry = entry;
    this.rect = rect;
    this.look = Object.assign({}, DEFAULT_LOOK);
    this.zRange = entry.zRange || [0, 256];
    this.state = 'idle';             // idle -> loading -> ready | failed
    this.error = null;
    this.onReady = null;
    this.key = null;
  }

  /** the mesh and the GL resources, once -> this (state 'ready' or 'failed') */
  load() {
    if (this.loading) return this.loading;
    this.state = 'loading';
    return (this.loading = (async () => {
      try {
        const dir = C2.maps.IMAGE_DIR;
        const info = await fetchJSON(dir + this.entry.file);
        const base = this.entry.file.replace(/[^/]*$/, '');
        const buf = await fetchBinary(dir + base + info.file, { expected: info.byteLength });
        this.info = info;
        this.setup(buf);
        this.state = 'ready';
      } catch (err) {
        this.state = 'failed';
        this.error = err.message || String(err);
        console.warn('Inspect view:', this.error);
      }
      if (this.onReady) this.onReady(this);
      return this;
    })());
  }

  setup(buf) {
    const info = this.info, L = info.layout;
    const canvas = this.canvas = document.createElement('canvas');
    const gl = this.gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('this browser has no WebGL 2');
    const T = { int16: Int16Array, uint16: Uint16Array, uint32: Uint32Array };
    const view = (part) => { const a = L[part]; return checkedView(T[a.type], buf, a.offset, a.length / T[a.type].BYTES_PER_ELEMENT, 'inspect.bin'); };
    const prog = (vs, fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
      return p;
    };
    this.mesh = prog(MESH_VS, MESH_FS);
    this.quad = prog(QUAD_VS, QUAD_FS);
    this.u = {};
    for (const n of ['uM', 'uColor', 'uMode', 'uRoof', 'uZ', 'uShade', 'uByHeight', 'uBright']) this.u[n] = gl.getUniformLocation(this.mesh, n);
    this.uq = { uTex: gl.getUniformLocation(this.quad, 'uTex'), uAlpha: gl.getUniformLocation(this.quad, 'uAlpha') };
    // the mesh: one vertex buffer (int16 positions relative to the origin), three index ranges
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, view('position'), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.mesh, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.SHORT, false, 0, 0);
    this.itype = L.floor.type === 'uint32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const isz = L.floor.type === 'uint32' ? 4 : 2;
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    const all = new Uint8Array(L.floor.length + L.volume.length + L.edges.length);
    all.set(new Uint8Array(buf, L.floor.offset, L.floor.length), 0);
    all.set(new Uint8Array(buf, L.volume.offset, L.volume.length), L.floor.length);
    all.set(new Uint8Array(buf, L.edges.offset, L.edges.length), L.floor.length + L.volume.length);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, all, gl.STATIC_DRAW);
    this.parts = {
      floor: [0, L.floor.length / isz],
      volume: [L.floor.length, L.volume.length / isz],
      edges: [L.floor.length + L.volume.length, L.edges.length / isz]
    };
    // the ground grid (256 units) under the lowest floor, in its own buffer
    const o = info.origin, R = this.rect, step = 256, gz = (info.zBounds ? Math.max(info.zBounds[0], this.zRange[0] - 64) : this.zRange[0]) - 4;
    const lines = [];
    for (let x = Math.ceil(R.minX / step) * step; x <= R.maxX; x += step) lines.push(x - o[0], R.minY - o[1], gz, x - o[0], R.maxY - o[1], gz);
    for (let y = Math.ceil(R.minY / step) * step; y <= R.maxY; y += step) lines.push(R.minX - o[0], y - o[1], gz, R.maxX - o[0], y - o[1], gz);
    this.gridVao = gl.createVertexArray();
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    this.gridCount = lines.length / 3;
    // the full-screen quad (the floors' layer laid over)
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const ql = gl.getAttribLocation(this.quad, 'aP');
    gl.enableVertexAttribArray(ql);
    gl.vertexAttribPointer(ql, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.state = 'failed'; this.error = 'the WebGL context was lost'; });
  }

  /** the floors' frame buffer at w x h */
  target(w, h) {
    const gl = this.gl;
    if (this.fb && this.fbW === w && this.fbH === h) return this.fb;
    if (this.fb) { gl.deleteFramebuffer(this.fb); gl.deleteTexture(this.fbTex); gl.deleteRenderbuffer(this.fbDepth); }
    this.fbTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fbTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.fbDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fbTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.fbDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbW = w; this.fbH = h;
    return this.fb;
  }

  /** the clip-space matrix (column-major) of the renderer's camera for the mesh's local positions */
  clipMatrix(r) {
    const m = r.matrix(), C = r.cam, o = this.info.origin, w = r.w, h = r.h;
    const th = r.rot * Math.PI / 2 + C.yaw, st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(C.tilt), cp = Math.cos(C.tilt);
    const R = this.rect, zr = this.info.zBounds || this.zRange;
    // depth: toward the viewer = -(the turned y) sin(tilt) + (z - zRef) cos(tilt); scaled into -1..1
    const span = Math.hypot(R.maxX - R.minX, R.maxY - R.minY) + (zr[1] - zr[0]) + 512;
    const ex = m.a * o[0] + m.c * o[1] + m.e, ey = m.b * o[0] + m.d * o[1] + m.f;
    const dz0 = (st * (o[0] - m.cx) + ct * (o[1] - m.cy)) * sp + C.zRef * cp;
    return new Float32Array([
      2 * m.a / w, -2 * m.b / h, st * sp / span * 2, 0,
      2 * m.c / w, -2 * m.d / h, ct * sp / span * 2, 0,
      0, 2 * m.kz / h, -cp / span * 2, 0,
      2 * ex / w - 1, 1 - 2 * (ey + m.kz * C.zRef) / h, dz0 / span * 2, 1
    ]);
  }

  /** the layer drawn for renderer r (its camera and size) -> the canvas, or null while not ready */
  render(r) {
    if (this.state !== 'ready') { if (this.state === 'idle') this.load(); return null; }
    const gl = this.gl, c = this.canvas, W = r.canvas.width, H = r.canvas.height, Lk = this.look;
    const m = r.matrix();
    const key = [W, H, m.a, m.b, m.c, m.d, m.e, m.f, m.kz, r.cam.zRef, r.cam.yaw, r.cam.tilt, JSON.stringify(Lk)].join('|');
    if (key === this.key && !gl.isContextLost()) return c;
    this.key = key;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const M = this.clipMatrix(r), u = this.u, roof = Lk.roof == null ? 1e9 : Lk.roof;
    const bg = rgb(Lk.background);
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.mesh);
    gl.uniformMatrix4fv(u.uM, false, M);
    gl.uniform1f(u.uRoof, roof);
    gl.uniform2f(u.uZ, this.zRange[0], this.zRange[1]);
    gl.uniform1f(u.uShade, Lk.heightShade);
    gl.uniform1i(u.uByHeight, Lk.byHeight ? 1 : 0);
    gl.uniform1f(u.uBright, Lk.brightness);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const draw = (part, mode) => { const [off, n] = this.parts[part]; if (n) gl.drawElements(mode, n, this.itype, off); };
    // the grid
    if (Lk.grid) {
      gl.bindVertexArray(this.gridVao);
      gl.uniform1i(u.uMode, 2);
      gl.uniform4f(u.uColor, 0.47, 0.6, 0.73, 0.16);
      gl.uniform1f(u.uRoof, 1e9);
      gl.drawArrays(gl.LINES, 0, this.gridCount);
      gl.uniform1f(u.uRoof, roof);
    }
    gl.bindVertexArray(this.vao);
    // the volume: a faint glass
    if (Lk.wallOpacity > 0) {
      const w = rgb(Lk.wall);
      gl.uniform1i(u.uMode, 1);
      gl.uniform4f(u.uColor, w[0], w[1], w[2], Lk.wallOpacity);
      draw('volume', gl.TRIANGLES);
    }
    // the floors: the nearest at each pixel, into the frame buffer, then laid over once
    if (Lk.floorOpacity > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.target(W, H));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      const f = rgb(Lk.floor);
      gl.uniform1i(u.uMode, 0);
      gl.uniform4f(u.uColor, f[0], f[1], f[2], 1);
      draw('floor', gl.TRIANGLES);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.useProgram(this.quad);
      gl.bindVertexArray(this.quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fbTex);
      gl.uniform1i(this.uq.uTex, 0);
      gl.uniform1f(this.uq.uAlpha, Lk.floorOpacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(this.mesh);
      gl.bindVertexArray(this.vao);
    }
    // the outlines on top
    if (Lk.outlineOpacity > 0) {
      const l = rgb(Lk.outline);
      gl.uniform1i(u.uMode, 2);
      gl.uniform4f(u.uColor, l[0], l[1], l[2], Lk.outlineOpacity);
      draw('edges', gl.LINES);
    }
    gl.bindVertexArray(null);
    return c;
  }

  dispose() {
    const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.gl = null;
    this.state = 'failed';
  }
}
