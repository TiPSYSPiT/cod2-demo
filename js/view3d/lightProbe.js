/* The baked light at a point of the map: the lightmap texel of the world surface right below it (and
 * that surface's height: the floor falling debris stops on).
 * For the particle effects (fx.js), which the game lights from its light grid - here the lightmap of the
 * floor under the effect stands in for it (the same light the floor shows: moonlight on a night map,
 * the shade under a roof). An XY grid of the upward-facing lightmapped world triangles finds the highest
 * one under the point; its lightmap coordinates at the point pick the texel - the lightmap's light, plus
 * (lightmapFormat 2) the sun where its sun mask lets it through, x the sun's height (a floor's N.L), as
 * the world's shader draws that floor. */

import { GRID_SUN } from './lightGrid.js';

const CELL = 128;
const UP_Z = 0.3;                        // triangles facing up at least this much (floors, roofs, terrain)
const ABOVE = 24;                        // a surface up to 24 units above the point still counts (the point
                                         // may be a little under an uneven floor)

export class LightProbe {
  /** world: loadWorld()'s result (mesh, info.groups, lightmaps); scale: the world's lightmap factor */
  constructor(world, scale = 1) {
    this.scale = scale;
    this.lightmaps = world.lightmaps || [];
    this.sunMasks = world.sunMasks || null;            // (lightmapFormat 2: the sun's visibility, added x the sun x N.L)
    this.pixels = new Map();
    const geo = world.mesh.geometry;
    this.P = geo.attributes.position.array;
    this.U = geo.attributes.uv1;
    this.I = geo.index.array;
    this.tris = [];                                       // [first index, lightmap]
    this.grid = new Map();
    for (const g of world.info.groups) {
      if (g.sky || g.blend || g.vertexAlpha || !(g.lightmap >= 0)) continue;
      for (let k = g.start; k < g.start + g.count; k += 3) this.add(k, g.lightmap);
    }
  }

  add(k, lm) {
    const P = this.P, I = this.I;
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len || Math.abs(nz) / len < UP_Z) return;        // (either winding: only the facing matters)
    const t = this.tris.length;
    this.tris.push(k, lm);
    const x0 = Math.floor(Math.min(P[a], P[b], P[c]) / CELL), x1 = Math.floor(Math.max(P[a], P[b], P[c]) / CELL);
    const y0 = Math.floor(Math.min(P[a + 1], P[b + 1], P[c + 1]) / CELL), y1 = Math.floor(Math.max(P[a + 1], P[b + 1], P[c + 1]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = x * 65536 + y;
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, cell = []);
      cell.push(t);
    }
  }

  /** true once every lightmap image has arrived */
  get ready() { return this.lightmaps.every(t => !t || (t.image && t.image.width)); }

  /** the lightmap's pixels (RGBA bytes) once its image has arrived, else null (sun: its sun mask's) */
  image(lm, sun = false) {
    const key = sun ? -1 - lm : lm;
    let px = this.pixels.get(key);
    if (px) return px;
    const tex = (sun ? this.sunMasks : this.lightmaps)[lm], img = tex && tex.image;
    if (!img || !img.width || img.nodeName === 'CANVAS' && img.width === 1) return null;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    px = { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
    this.pixels.set(key, px);
    return px;
  }

  /** the highest upward-facing world surface under x y (at most ABOVE units over z): [triangle, w0, w1,
   *  w2, height] or null */
  surfaceBelow(x, y, z) {
    const cell = this.grid.get(Math.floor(x / CELL) * 65536 + Math.floor(y / CELL));
    if (!cell) return null;
    const P = this.P, I = this.I;
    let best = null, bestZ = -Infinity;
    for (const t of cell) {
      const k = this.tris[t];
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      // barycentric coordinates in XY
      const d = (P[b + 1] - P[c + 1]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 1] - P[c + 1]);
      if (!d) continue;
      const w0 = ((P[b + 1] - P[c + 1]) * (x - P[c]) + (P[c] - P[b]) * (y - P[c + 1])) / d;
      const w1 = ((P[c + 1] - P[a + 1]) * (x - P[c]) + (P[a] - P[c]) * (y - P[c + 1])) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const sz = w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2];
      if (sz > z + ABOVE || sz <= bestZ) continue;
      bestZ = sz;
      best = [t, w0, w1, w2, sz];
    }
    return best;
  }

  /** the height of the floor under x y z (falling debris stops there), or null */
  floorAt(x, y, z) {
    const s = this.surfaceBelow(x, y, z);
    return s ? s[4] : null;
  }

  /** [r, g, b] (1 = the texture's own colour) at x y z, or null (no lit surface below / not loaded) */
  lightAt(x, y, z) {
    const best = this.surfaceBelow(x, y, z);
    if (!best) return null;
    const I = this.I, U = this.U;
    const [t, w0, w1, w2] = best, k = this.tris[t], lm = this.tris[t + 1];
    const px = this.image(lm);
    if (!px) return null;
    const ia = I[k], ib = I[k + 1], ic = I[k + 2];
    const u = w0 * U.getX(ia) + w1 * U.getX(ib) + w2 * U.getX(ic);
    const v = w0 * U.getY(ia) + w1 * U.getY(ib) + w2 * U.getY(ic);
    const sx = Math.min(px.w - 1, Math.max(0, Math.floor(u * px.w))), sy = Math.min(px.h - 1, Math.max(0, Math.floor(v * px.h)));
    const o = (sy * px.w + sx) * 4, f = this.scale / 255;
    const out = [px.data[o] * f, px.data[o + 1] * f, px.data[o + 2] * f];
    // the sun on a floor (N ~ up): its visibility there x the sun's light x the sun's height
    const sp = this.sunMasks && this.image(lm, true);
    if (sp) {
      const vis = sp.data[(Math.min(sp.h - 1, Math.max(0, Math.floor(v * sp.h))) * sp.w + Math.min(sp.w - 1, Math.max(0, Math.floor(u * sp.w)))) * 4] / 255;
      const c = GRID_SUN.color.value, k = vis * Math.max(0, GRID_SUN.dir.value.z);
      out[0] += c.x * k; out[1] += c.y * k; out[2] += c.z * k;
    }
    return out;
  }
}
