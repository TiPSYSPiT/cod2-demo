/* The things on the move or on the ground that the game draws as models: the grenades in flight (the weapon
 * file's projectileModel, eType 4) and the dropped weapons (eType 3 items: the weapon's world model; a dying
 * player drops his gun and a grenade). Both where the demo's entities have them: their trajectories (position and
 * angles, BG_EvaluateTrajectory - a grenade spins with its apos, an item settles), while the entity is in the
 * snapshots (an item out of the recorder's view keeps its place until it shows up again or is gone).
 * Drawn with modelBatch.js (pooled instances, lit by the light grid). */
import * as THREE from 'three';
import { evalTrajectory, trajectoryAt } from '../app/match.js';
import { ModelBatches, entityMatrix } from './modelBatch.js';

export class WorldItems {
  constructor(scene, match, library) {
    this.M = match;
    this.lib = library;
    this.batches = new ModelBatches(scene, library);
    this.enabled = true;
    this.m = new THREE.Matrix4();
    this.p = new Array(6);
    const d = match.d;
    // the items by appearance (each with its light cache)
    this.items = (d.items || []).filter(r => r.segments.length).map(r => ({ r, start: r.t0, end: r.t1, cache: {} }));
    // the grenades from their launch (or first sight) to the explosion / their last sight
    this.grenades = (d.grenades || []).filter(g => g.segments.length).map(g => ({
      g, start: Math.max(g.segments[0][0], g.launch != null ? g.launch : g.first),
      end: g.detonation ? g.detonation.t : g.last + 50, cache: {}
    }));
    this.maxItem = this.items.reduce((m, it) => Math.max(m, it.end - it.start), 0);
  }

  setGrid(grid) { this.batches.setGrid(grid); }

  /** the models at demo time t -> the grenades drawn (their keys: effects.js leaves out its markers for them) */
  update(t) {
    const B = this.batches, L = this.lib, drawn = new Set();
    B.begin();
    if (this.enabled && L && L.modelsInfo) {
      const P = this.p, m = this.m;
      const proj = L.modelsInfo.projectiles || {};
      for (const it of this.grenades) {
        if (t < it.start || t >= it.end) continue;
        const model = proj[String(it.g.weapon || '').toLowerCase()];
        if (!model) continue;
        evalTrajectory(trajectoryAt(it.g.segments, t), t, P);
        if (B.add(model, entityMatrix(m, P[0], P[1], P[2], P[3], P[4], P[5]), P[0], P[1], P[2], it.cache)) drawn.add(it.g);
      }
      for (const it of this.items) {
        if (t < it.start || t > it.end) continue;
        const model = L.weaponModel(it.r.weapon);
        if (!model) continue;
        evalTrajectory(trajectoryAt(it.r.segments, t), t, P);
        B.add(model, entityMatrix(m, P[0], P[1], P[2], P[3], P[4], P[5]), P[0], P[1], P[2] + 4, it.cache);
      }
    }
    B.end();
    return drawn;
  }

  setEnabled(on) { this.enabled = on; }

  dispose() { this.batches.dispose(); }
}
