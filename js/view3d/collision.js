/* What blocks the light grid's visibility traces (RB_GetLightingAtPoint of the 1.3 client: CM_BoxSightTrace
 * from the model's lighting origin to a grid point, contents 0x2001): the world's solid brushes and its
 * terrain / patch triangles, exported as collision.bin (tools/export/export_maps.py export_collision):
 * float32 brush bounds (6 per brush), uint32 first plane per brush (+ the end), float32 planes (nx ny nz
 * dist, outward), float32 triangle vertices, uint32 triangles. A 2D grid of 256-unit cells lists the
 * brushes and triangles over each cell; a trace tests those under its own bounds. */
import { fetchBinary } from './data.js';

const CELL = 256;

export class Collision {
  /** dir: maps3d/<map>/, c: world.json collision -> Collision or null */
  static async load(dir, c) {
    if (!c) return null;
    const expected = (c.brushes * 6 + c.brushes + 1 + c.planes * 4 + c.verts * 3 + c.tris * 3) * 4;
    return new Collision(await fetchBinary(dir + c.file, { expected }), c);
  }

  constructor(buf, c) {
    let o = 0;
    const take = (T, n) => { const a = new T(buf, o, n); o += n * 4; return a; };
    this.bounds = take(Float32Array, c.brushes * 6);
    this.starts = take(Uint32Array, c.brushes + 1);
    this.planes = take(Float32Array, c.planes * 4);
    this.verts = take(Float32Array, c.verts * 3);
    this.tris = take(Uint32Array, c.tris * 3);
    this.nb = c.brushes;
    this.cells = new Map();            // cell key -> [brush i | triangle ~i]
    for (let i = 0; i < c.brushes; i++) {
      const b = this.bounds, k = i * 6;
      this.addBox(i, b[k], b[k + 1], b[k + 3], b[k + 4]);
    }
    const v = this.verts, t = this.tris;
    for (let i = 0; i < c.tris; i++) {
      const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, d = t[i * 3 + 2] * 3;
      this.addBox(~i, Math.min(v[a], v[b], v[d]), Math.min(v[a + 1], v[b + 1], v[d + 1]), Math.max(v[a], v[b], v[d]), Math.max(v[a + 1], v[b + 1], v[d + 1]));
    }
    this.stamp = new Uint32Array(c.brushes + c.tris);
    this.pass = 0;
  }

  addBox(id, x0, y0, x1, y1) {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const key = cx * 65536 + cy;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, list = []);
        list.push(id);
      }
    }
  }

  /** does the segment a -> b pass through a brush or a triangle? */
  blocked(ax, ay, az, bx, by, bz) {
    const pass = ++this.pass;
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const z0 = Math.min(az, bz), z1 = Math.max(az, bz);
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(cx * 65536 + cy);
        if (!list) continue;
        for (const id of list) {
          const s = id >= 0 ? id : this.nb + ~id;
          if (this.stamp[s] === pass) continue;
          this.stamp[s] = pass;
          if (id >= 0) {
            const b = this.bounds, k = id * 6;
            if (x1 < b[k] || x0 > b[k + 3] || y1 < b[k + 1] || y0 > b[k + 4] || z1 < b[k + 2] || z0 > b[k + 5]) continue;
            if (this.brushHit(id, ax, ay, az, bx, by, bz)) return true;
          } else if (this.triHit(~id, ax, ay, az, bx - ax, by - ay, bz - az)) return true;
        }
      }
    }
    return false;
  }

  /** the segment clipped by the brush's planes (6 axial + its own): something left = hit */
  brushHit(i, ax, ay, az, bx, by, bz) {
    let enter = 0, leave = 1;
    const clip = (d1, d2) => {
      if (d1 > 0 && d2 > 0) return false;                 // all in front of this plane: outside
      if (d1 <= 0 && d2 <= 0) return true;
      const t = d1 / (d1 - d2);
      if (d1 > 0) { if (t > enter) enter = t; } else if (t < leave) leave = t;
      return enter <= leave;
    };
    const b = this.bounds, k = i * 6;
    if (!clip(b[k] - ax, b[k] - bx) || !clip(ax - b[k + 3], bx - b[k + 3]) || !clip(b[k + 1] - ay, b[k + 1] - by) ||
        !clip(ay - b[k + 4], by - b[k + 4]) || !clip(b[k + 2] - az, b[k + 2] - bz) || !clip(az - b[k + 5], bz - b[k + 5])) return false;
    const p = this.planes;
    for (let j = this.starts[i]; j < this.starts[i + 1]; j++) {
      const o = j * 4;
      if (!clip(p[o] * ax + p[o + 1] * ay + p[o + 2] * az - p[o + 3], p[o] * bx + p[o + 1] * by + p[o + 2] * bz - p[o + 3])) return false;
    }
    return true;
  }

  /** segment (origin a, direction d, 0..1) through triangle i (either side; Moeller-Trumbore) */
  triHit(i, ax, ay, az, dx, dy, dz) {
    const v = this.verts, t = this.tris;
    const p = t[i * 3] * 3, q = t[i * 3 + 1] * 3, r = t[i * 3 + 2] * 3;
    const e1x = v[q] - v[p], e1y = v[q + 1] - v[p + 1], e1z = v[q + 2] - v[p + 2];
    const e2x = v[r] - v[p], e2y = v[r + 1] - v[p + 1], e2z = v[r + 2] - v[p + 2];
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-9) return false;
    const f = 1 / det, sx = ax - v[p], sy = ay - v[p + 1], sz = az - v[p + 2];
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const w = f * (dx * qx + dy * qy + dz * qz);
    if (w < 0 || u + w > 1) return false;
    const s = f * (e2x * qx + e2y * qy + e2z * qz);
    return s >= 0 && s <= 1;
  }
}
