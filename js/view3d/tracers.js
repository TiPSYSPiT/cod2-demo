/* Bullet tracers in 3D, as the 1.3 client draws them (CG_BulletTrajectoryEffects, CG_SpawnTracer, CG_DrawTracer).
 *
 * Every bullet that hits the world (DemoData.sounds3d.whiz: shooter's eye -> impact, the shooter) gets a tracer with
 * the chance cg_tracerChance - never the bullets of the player watched in first person (the game spawns none for the
 * local player). The tracer is a local entity flying from the muzzle at cg_tracerSpeed; it is drawn as a camera-facing
 * quad of cg_tracerLength behind its head, cg_tracerWidth wide - wider with the distance from the camera
 * (cg_tracerScale over cg_tracerScaleDistRange beyond cg_tracerScaleMinDist), with the additive material
 * gfx/misc/tracer (maps3d/_hud/tracer.png). The values: the server's client dvars in the demo (zPAM sets chance 1,
 * width 1, length 1000, speed 20000), else the client's defaults. The chance is decided per bullet by a hash, so a
 * seek or the export shows the same tracers. */
import * as THREE from 'three';
import { loadTexture } from './mapLoader.js';

const DEFAULTS = { cg_tracerchance: 0.4, cg_tracerwidth: 0.8, cg_tracerspeed: 4500, cg_tracerlength: 160,
  cg_tracerscale: 50, cg_tracerscalemindist: 5000, cg_tracerscaledistrange: 25000 };
const MAX = 96;                        // tracers drawn at once
const MAX_LIFE_MS = 3000;              // (a tracer of a long shot at the default speed: ~1 s)

const hash01 = (a, b) => {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
};

export class Tracers {
  constructor(scene, match) {
    this.whiz = (match.d.sounds3d && match.d.sounds3d.whiz) || [];
    this.times = Float64Array.from(this.whiz, w => w[0]);
    // the server's values (the last one it set) over the client's defaults
    const P = Object.assign({}, DEFAULTS);
    for (const [, n, v] of (match.d.psHud && match.d.psHud.dvars) || []) if (n in P && Number.isFinite(Number(v))) P[n] = Number(v);
    this.p = P;
    this.enabled = true;
    const pos = new Float32Array(MAX * 4 * 3), uv = new Float32Array(MAX * 4 * 2), idx = [];
    for (let i = 0; i < MAX; i++) {
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    const tex = loadTexture('maps3d/_hud/tracer.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** the width at distance d from the camera (CG_DrawTracer) */
  width(d) {
    const P = this.p, w = P.cg_tracerwidth, s = P.cg_tracerscale;
    if (s === 1) return w;
    const x = P.cg_tracerscalemindist ? d - P.cg_tracerscalemindist : d;
    if (x <= 0) return w;
    if (!(P.cg_tracerscaledistrange > 0)) return w * s;
    const f = x / P.cg_tracerscaledistrange * s;
    return w * (f >= 1 ? Math.min(s, f) : 1);
  }

  /** the tracers at time t for the camera; muzzleOf(cl) -> {pos} of a shooter's weapon now, or null; fp: the
   *  client watched in first person (his own bullets have none) */
  update(t, camera, muzzleOf, fp) {
    let n = 0;
    const P = this.p;
    if (this.enabled && P.cg_tracerchance > 0 && this.whiz.length) {
      const pos = this.geo.attributes.position.array, cam = camera.position;
      let lo = 0, hi = this.times.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.times[m] < t - MAX_LIFE_MS) lo = m + 1; else hi = m; }
      for (let i = lo; i < this.whiz.length && this.whiz[i][0] <= t && n < MAX; i++) {
        const w = this.whiz[i];
        if (w[7] === fp || hash01(w[0], w[7] * 7919 + i) >= P.cg_tracerchance) continue;
        const mz = muzzleOf ? muzzleOf(w[7]) : null;
        const sx = mz ? mz.pos[0] : w[1], sy = mz ? mz.pos[1] : w[2], sz = mz ? mz.pos[2] : w[3];
        let dx = w[4] - sx, dy = w[5] - sy, dz = w[6] - sz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1) continue;
        dx /= dist; dy /= dist; dz /= dist;
        const head = Math.min(dist, P.cg_tracerspeed * (t - w[0]) / 1000), tail = Math.max(0, head - P.cg_tracerlength);
        if (tail >= dist) continue;
        const ax = sx + dx * tail, ay = sy + dy * tail, az = sz + dz * tail;
        const bx = sx + dx * head, by = sy + dy * head, bz = sz + dz * head;
        // the side vector: across the tracer, facing the camera
        const mx = (ax + bx) / 2 - cam.x, my = (ay + by) / 2 - cam.y, mz2 = (az + bz) / 2 - cam.z;
        let px = dy * mz2 - dz * my, py = dz * mx - dx * mz2, pz = dx * my - dy * mx;
        const pl = Math.hypot(px, py, pz) || 1;
        px /= pl; py /= pl; pz /= pl;
        const wa = this.width(Math.hypot(ax - cam.x, ay - cam.y, az - cam.z)), wb = this.width(Math.hypot(bx - cam.x, by - cam.y, bz - cam.z));
        pos.set([ax - px * wa, ay - py * wa, az - pz * wa, ax + px * wa, ay + py * wa, az + pz * wa,
          bx - px * wb, by - py * wb, bz - pz * wb, bx + px * wb, by + py * wb, bz + pz * wb], n * 12);
        n++;
      }
      if (n) this.geo.attributes.position.needsUpdate = true;
    }
    this.geo.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
    return n;
  }

  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); this.mesh.material.map && this.mesh.material.map.dispose(); this.mesh.material.dispose(); }
}
