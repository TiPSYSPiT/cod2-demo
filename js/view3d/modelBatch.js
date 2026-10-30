/* Many copies of the small rigid models (maps3d/_characters/models.json: the grenades in flight, dropped weapons,
 * the effects' model particles - shell casings, the burnt smoke grenade, debris): one InstancedMesh per model,
 * refilled every frame (begin / add / end), grown when a frame needs more. Lit as the game lights its models:
 * the map's light grid at each copy (lightGrid.js, per-instance attributes as the map's props), sampled again
 * only when the copy moved 4 units; until the grid is there the scene lights. */
import * as THREE from 'three';
import { propGridMaterial } from './lightGrid.js';
import { setMap } from './mapLoader.js';

const START = 16;

export class ModelBatches {
  /** parent: the scene node; lib: the CharacterLibrary (its templates) */
  constructor(parent, lib) {
    this.root = new THREE.Group();
    this.root.name = 'model batches';
    parent.add(this.root);
    this.lib = lib;
    this.grid = null;
    this.batches = new Map();         // model -> batch (null: no such model)
    this.m4 = new THREE.Matrix4();
  }

  setGrid(grid) {
    if (this.grid === grid) return;
    this.grid = grid;
    // (the meshes are made again with the grid's material)
    for (const b of this.batches.values()) if (b) this.free(b);
    this.batches.clear();
  }

  batch(model) {
    let b = this.batches.get(model);
    if (b !== undefined) return b;
    if (!this.lib || !this.lib.modelsInfo) return null;              // (still loading)
    const tpl = this.lib.template(model);
    b = null;
    if (tpl) {
      const geo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) if (tpl.geometry.attributes[k]) geo.setAttribute(k, tpl.geometry.attributes[k]);
      geo.setIndex(tpl.geometry.index);
      for (const g of tpl.geometry.groups) geo.addGroup(g.start, g.count, g.materialIndex);
      geo.boundingSphere = tpl.geometry.boundingSphere;
      // own copies of the materials, their colour maps set again (a copy would keep a stand-in while the texture loads)
      const groups = this.lib.modelsInfo.models[tpl.name].groups;
      const mats = tpl.materials.map((m, i) => {
        const c = m.clone(), g = groups[i], tex = g && this.lib.texture(g.texture);
        if (tex) { setMap(c, 'map', tex, g.alphaTest ? 'clear' : 'grey'); setMap(c, 'emissiveMap', tex, g.alphaTest ? 'clear' : 'grey'); }
        if (this.grid) propGridMaterial(c, false);
        return c;
      });
      b = { tpl, geo, mats, mesh: null, cap: 0, n: 0 };
    }
    this.batches.set(model, b);
    return b;
  }

  /** (re)make a batch's mesh for cap copies */
  grow(b, cap) {
    if (b.mesh) { this.root.remove(b.mesh); b.mesh.dispose(); }
    b.cap = cap;
    b.mesh = new THREE.InstancedMesh(b.geo, b.mats.length === 1 ? b.mats[0] : b.mats, cap);
    b.mesh.frustumCulled = false;
    b.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.grid) {
      b.C = Array.from({ length: 6 }, () => new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      b.S = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
      // (an own geometry per size: the instanced attributes belong to it)
      const geo = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(b.geo.attributes)) geo.setAttribute(k, a);
      geo.setIndex(b.geo.index);
      for (const g of b.geo.groups) geo.addGroup(g.start, g.count, g.materialIndex);
      b.C.forEach((a, k) => geo.setAttribute('gridC' + k, a));
      geo.setAttribute('gridSun', b.S);
      if (b.ownGeo) b.ownGeo.dispose();
      b.ownGeo = geo;
      b.mesh.geometry = geo;
    }
    this.root.add(b.mesh);
  }

  begin() { for (const b of this.batches.values()) if (b) b.n = 0; }

  /** a copy of `model` with the world matrix m (Matrix4) at the point x y z (its light); cache: an object kept with
   *  the copy (its grid sample) or null. -> false when the model is not available */
  add(model, m, x, y, z, cache) {
    const b = this.batch(model);
    if (!b) return false;
    if (b.n >= b.cap) {
      const old = b.mesh, n = b.n;
      this.grow(b, Math.max(START, b.cap * 2));
      if (old && n) {
        b.mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, n * 16));
        if (this.grid && b.oldC) for (let k = 0; k < 6; k++) b.C[k].array.set(b.oldC[k].subarray(0, n * 4));
        if (this.grid && b.oldS) b.S.array.set(b.oldS.subarray(0, n));
      }
    }
    b.mesh.setMatrixAt(b.n, m);
    if (this.grid) {
      let s = cache && cache.gridS;
      if (!s || !cache || Math.abs(cache.gx - x) > 4 || Math.abs(cache.gy - y) > 4 || Math.abs(cache.gz - z) > 4) {
        s = this.grid.sample(x, y, z, cache && cache.gridS ? cache.gridS : undefined) || { coef: new Float32Array(24).fill(0.5), sun: 1 };
        if (cache) { cache.gridS = s; cache.gx = x; cache.gy = y; cache.gz = z; }
      }
      const i = b.n;
      for (let k = 0; k < 24; k++) b.C[k >> 2].array[i * 4 + (k & 3)] = s.coef[k];
      b.S.array[i] = s.sun;
      b.oldC = b.C.map(a => a.array); b.oldS = b.S.array;
    }
    b.n++;
    return true;
  }

  end() {
    for (const b of this.batches.values()) {
      if (!b || !b.mesh) continue;
      b.mesh.count = b.n;
      b.mesh.visible = b.n > 0;
      if (!b.n) continue;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (this.grid) { for (const a of b.C) a.needsUpdate = true; b.S.needsUpdate = true; }
    }
  }

  /** the copies drawn now (for the stats) */
  count() { let n = 0; for (const b of this.batches.values()) if (b) n += b.n; return n; }

  free(b) {
    if (b.mesh) { this.root.remove(b.mesh); b.mesh.dispose(); }
    if (b.ownGeo) b.ownGeo.dispose();
    b.geo.dispose();
    for (const m of b.mats) m.dispose();
  }

  dispose() {
    for (const b of this.batches.values()) if (b) this.free(b);
    this.batches.clear();
    this.root.removeFromParent();
  }
}

const D2R = Math.PI / 180;
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
/** the world matrix of an entity at x y z with the game's angles (pitch, yaw, roll: AnglesToAxis) into m */
export function entityMatrix(m, x, y, z, pitch, yaw, roll, scale = 1) {
  _e.set(roll * D2R, pitch * D2R, yaw * D2R, 'ZYX');
  return m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(scale, scale, scale));
}
