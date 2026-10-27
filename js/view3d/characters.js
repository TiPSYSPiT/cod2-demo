/* Player characters in 3D: the game's own body / head / helmet models, animated with the game's own
 * animations (maps3d/_characters, tools/export/characters_export.py).
 *
 * - models.json / .bin: each model's LOD 0, skinned to its skeleton (bones: name, parent, local bind
 *   translation + rotation). The body's bones drive the attachments: a head or helmet binds its
 *   vertices to the body's bones of the same name (as the game does); its own extra bones (the face)
 *   ride along as children with their bind transforms.
 * - anims.json / .bin: the "multiplayer" anim tree's animations by the index the demo sends
 *   (legsAnim / torsoAnim, bit 0x200 = restart toggle): per bone rotation keys (replace the bind
 *   rotation) and translation keys (added to the bind translation), at the animation's frame rate.
 * A player plays the legs animation on the whole body and the torso animation (shooting, reloading,
 * throwing) on top for the bones it has keys for, from the time the demo switched to it; a new legs
 * animation crossfades from the old one, a torso animation fades in and out (actors.js). */
import * as THREE from 'three';
import { fetchJSON, fetchBinary } from './data.js';
import { loadTexture, setMap } from './mapLoader.js';

import { gridUniforms, setGridUniforms, gridMaterial } from './lightGrid.js';

const BASE = 'maps3d/_characters/';
const D2R = Math.PI / 180;
/** the bones the game's angle controllers turn (controllers.js: 6 × [pitch, yaw, roll] in this order) */
export const CONTROLLER_BONES = ['back_low', 'back_mid', 'back_up', 'neck', 'head', 'pelvis'];

export class CharacterLibrary {
  constructor() {
    this.ready = null;
    this.templates = new Map();
    this.textures = new Map();
  }

  /** loads models + animations once -> true when available */
  load() {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const [mj, aj] = await Promise.all([fetchJSON(BASE + 'models.json'), fetchJSON(BASE + 'anims.json')]);
          const [mb, ab] = await Promise.all([fetchBinary(BASE + mj.file, { expected: mj.byteLength }), fetchBinary(BASE + aj.file, { expected: aj.byteLength })]);
          this.modelsInfo = mj; this.modelsBuf = mb;
          this.animsInfo = aj; this.animsBuf = ab;
          this.clips = new Map();
          return true;
        } catch (err) {
          console.warn('player models not available:', err.message);
          return false;
        }
      })();
    }
    return this.ready;
  }

  texture(file) {
    if (!file) return null;
    if (!this.textures.has(file)) {
      const t = loadTexture('maps3d/' + file);
      t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this.textures.set(file, t);
    }
    return this.textures.get(file);
  }

  /** model template: {geometry, materials, bones, bindWorld (Matrix4 per bone)} or null */
  template(name) {
    if (!name || !this.modelsInfo) return null;
    name = String(name).toLowerCase();
    if (this.templates.has(name)) return this.templates.get(name);
    const m = this.modelsInfo.models[name];
    if (!m) { this.templates.set(name, null); return null; }
    const B = this.modelsBuf, G = m.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(B, G.position.offset, G.position.length / 4), 3));
    geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(B, G.normal.offset, G.normal.length), 4), 3, 0, true));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(B, G.uv.offset, G.uv.length / 4), 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array(B, G.joints.offset, G.joints.length), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Uint8Array(B, G.weights.offset, G.weights.length), 4, true));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(B, G.index.offset, G.index.length / 2), 1));
    const materials = [];
    m.groups.forEach((g, i) => {
      geo.addGroup(g.start, g.count, i);
      const tex = this.texture(g.texture);
      // a little of the colour map as emission: the scene lights alone leave the characters dark
      const mat = new THREE.MeshLambertMaterial({ color: tex ? 0xffffff : 0x777777, alphaTest: g.alphaTest ? 0.5 : 0,
        emissive: 0x4a4a4a, side: g.alphaTest ? THREE.DoubleSide : THREE.FrontSide });
      setMap(mat, 'map', tex, g.alphaTest ? 'clear' : 'grey');
      setMap(mat, 'emissiveMap', tex, g.alphaTest ? 'clear' : 'grey');
      materials.push(mat);
    });
    // the exported normals light the skinned meshes wrong (black): smooth normals from the triangles
    geo.deleteAttribute('normal');
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // the bind pose in model space
    const bindWorld = [];
    const local = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    m.bones.forEach((b, i) => {
      local.compose(p.fromArray(b.t), q.set(b.q[0], b.q[1], b.q[2], b.q[3]), one);
      bindWorld[i] = b.parent >= 0 ? bindWorld[b.parent].clone().multiply(local) : local.clone();
    });
    const tpl = { name, geometry: geo, materials, bones: m.bones, bindWorld, triangles: m.triangles };
    this.templates.set(name, tpl);
    return tpl;
  }

  /** the animation of a tree index (null when none / not exported) */
  clip(index) {
    if (!this.animsInfo || index == null) return null;
    const name = this.animsInfo.table[index & 0x1ff];
    if (!name) return null;
    if (this.clips.has(name)) return this.clips.get(name);
    const a = this.animsInfo.anims[name];
    let clip = null;
    if (a) {
      const B = this.animsBuf;
      clip = { name, frames: a.frames, keyFrames: a.keyFrames, rate: a.rate || 30, loop: a.loop, speed: a.speed || 0, tracks: a.tracks.map(t => ({
        bone: this.animsInfo.bones[t[0]],
        rf: t[2] ? new Uint16Array(B, t[1], t[2]) : null, rq: t[2] ? new Float32Array(B, t[3], t[2] * 4) : null,
        tf: t[5] ? new Uint16Array(B, t[4], t[5]) : null, tv: t[5] ? new Float32Array(B, t[6], t[5] * 3) : null })) };
    }
    this.clips.set(name, clip);
    return clip;
  }
  /** the world model of a weapon ('kar98k_mp' -> 'xmodel/weapon_kar98') or null */
  weaponModel(weapon) {
    const t = this.modelsInfo && this.modelsInfo.weapons;
    return (t && weapon && t[String(weapon).toLowerCase()]) || null;
  }
  /** the tree index of an animation name (fallback poses) */
  indexOf(name) { return this.animsInfo ? this.animsInfo.table.indexOf(name) : -1; }
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const EMISSIVE = 0x4a / 255;                             // the materials' emissive grey (template())
const clampLight = v => Math.round(Math.min(1, Math.max(0.2, v)) * 50) / 50;   // (steps of 0.02: fewer updates)
/** key interval of frame f in a key frame list -> [i, j, fraction] */
function keyAt(frames, f) {
  const n = frames.length;
  if (n === 1 || f <= frames[0]) return [0, 0, 0];
  if (f >= frames[n - 1]) return [n - 1, n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (frames[m] <= f) lo = m; else hi = m; }
  return [lo, hi, (f - frames[lo]) / Math.max(1, frames[hi] - frames[lo])];
}

export class Character {
  constructor(lib, body, attach) {
    this.lib = lib;
    this.group = new THREE.Group();
    this.triangles = 0;
    const tb = lib.template(body);
    this.ok = !!tb;
    if (!tb) return;
    // the body's bones in their bind pose
    this.bones = tb.bones.map(b => { const o = new THREE.Bone(); o.name = b.name; o.position.fromArray(b.t); o.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]); return o; });
    this.bind = tb.bones;
    this.byName = new Map();
    this.indexOf = new Map(tb.bones.map((b, i) => [this.bones[i], i]));
    tb.bones.forEach((b, i) => { this.byName.set(b.name, this.bones[i]); if (b.parent >= 0) this.bones[b.parent].add(this.bones[i]); else this.group.add(this.bones[i]); });
    const mesh = new THREE.SkinnedMesh(tb.geometry, tb.materials);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.group.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(this.bones, tb.bindWorld.map(m => m.clone().invert())), new THREE.Matrix4());
    this.meshes = [mesh];
    this.triangles += tb.triangles;
    for (const a of attach || []) this.attach(a);
  }

  /** a head / helmet: bound to the body's bones of the same name; its other bones become children */
  attach(name) {
    const t = this.lib.template(name);
    if (!t) return;
    const bones = t.bones.map((b, i) => {
      const own = this.byName.get(b.name);
      if (own) return own;
      const o = new THREE.Bone();
      o.name = b.name; o.position.fromArray(b.t); o.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      return o;
    });
    t.bones.forEach((b, i) => { if (this.byName.has(b.name)) return; const parent = b.parent >= 0 ? bones[b.parent] : this.group; parent.add(bones[i]); });
    const mesh = new THREE.SkinnedMesh(t.geometry, t.materials);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    mesh.bind(new THREE.Skeleton(bones, t.bindWorld.map(m => m.clone().invert())), new THREE.Matrix4());
    this.meshes.push(mesh);
    this.triangles += t.triangles;
  }

  /** the weapon in the right hand: its world model (origin = the grip) on the body's tag_weapon_right;
   *  null / unknown removes it. One mesh per model, kept for when the player switches back. */
  setWeapon(model) {
    if (model === this.weaponKey) return;
    this.weaponKey = model;
    if (this.weapon) this.weapon.visible = false;
    this.weapon = null;
    const hand = this.byName.get('tag_weapon_right');
    if (!model || !hand) return;
    this.weapons = this.weapons || new Map();
    let mesh = this.weapons.get(model);
    if (mesh === undefined) {
      const t = this.lib.template(model);
      mesh = t ? new THREE.Mesh(t.geometry, t.materials) : null;
      if (mesh) {
        mesh.frustumCulled = false; hand.add(mesh);
        if (this.lit && ![].concat(mesh.material).some(x => !x.map || x.map.isDataTexture)) this.ownMaterials(mesh);
        // the muzzle: the model's tag_flash in its bind pose (fx.js plays the flash there)
        const k = t.bones.findIndex(b => b.name === 'tag_flash');
        if (k >= 0) mesh.userData.flash = new THREE.Vector3().setFromMatrixPosition(t.bindWorld[k]);
      }
      this.weapons.set(model, mesh);
    }
    if (mesh) { mesh.visible = true; this.weapon = mesh; }
  }

  /** reset every body bone to the bind pose */
  rest() {
    this.bones.forEach((o, i) => { const b = this.bind[i]; o.position.fromArray(b.t); o.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]); });
  }

  /** apply a clip at time `sec` since its start (looping or held at the end) */
  apply(clip, sec) {
    if (!clip) return;
    const last = Math.max(1, (clip.loop ? clip.keyFrames - 1 : clip.frames - 1));
    let f = sec * clip.rate;
    f = clip.loop ? ((f % last) + last) % last : Math.min(Math.max(0, f), last);
    for (const tr of clip.tracks) {
      const o = this.byName.get(tr.bone);
      if (!o) continue;
      if (tr.rf) {
        const [i, j, u] = keyAt(tr.rf, f);
        qa.fromArray(tr.rq, i * 4);
        if (i !== j) { qb.fromArray(tr.rq, j * 4); qa.slerp(qb, u); }
        o.quaternion.copy(qa);
      }
      if (tr.tf) {
        const [i, j, u] = keyAt(tr.tf, f);
        const b = this.bind[this.indexOf.get(o)];
        const v = tr.tv;
        const x = v[i * 3] + (v[j * 3] - v[i * 3]) * u, y = v[i * 3 + 1] + (v[j * 3 + 1] - v[i * 3 + 1]) * u, z = v[i * 3 + 2] + (v[j * 3 + 2] - v[i * 3 + 2]) * u;
        o.position.set(b.t[0] + x, b.t[1] + y, b.t[2] + z);
      }
    }
  }

  /** pose: legs clip + torso clip (each with its seconds since start); opts: prevLegs / prevLegsSec /
   *  legsW (the legs animation it replaces, faded out: w = 0 old .. 1 new), torsoW (the torso clip's
   *  weight over the legs) */
  pose(legs, legsSec, torso, torsoSec, opts = {}) {
    this.rest();
    if (opts.prevLegs && opts.legsW < 1) {
      this.apply(opts.prevLegs, opts.prevLegsSec);
      this.snapshot();
      this.rest();
      this.apply(legs, legsSec);
      this.mixFromSnapshot(opts.legsW);
    } else this.apply(legs, legsSec);
    if (torso) {
      const w = opts.torsoW == null ? 1 : opts.torsoW;
      if (w <= 0) return;
      if (w < 1) this.snapshot();
      this.apply(torso, torsoSec);
      if (w < 1) this.mixFromSnapshot(w);
    }
  }

  /** the game's angle controllers (controllers.js) on top of the animation: the root (tag_origin)
   *  gets its yaw / pitch / roll and offset, the controller bones (back_low, back_mid, back_up, neck,
   *  head, pelvis) turn about the root's axes at their own position, parents first (from cod4-demo3d) */
  applyControllers(c) {
    if (!this.ctrl) {
      const bones = CONTROLLER_BONES.map((n, k) => ({ bone: this.byName.get(n), k })).filter(x => x.bone)
        .sort((x, y) => this.bones.indexOf(x.bone) - this.bones.indexOf(y.bone));
      this.ctrl = { root: this.byName.get('tag_origin'), bones, q: new THREE.Quaternion(), W: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'ZYX') };
    }
    const { root, bones, q, W, e } = this.ctrl;
    const angles = (a, k) => q.setFromEuler(e.set(a[k + 2] * D2R, a[k] * D2R, a[k + 1] * D2R, 'ZYX'));   // yaw · pitch · roll
    if (root) {
      root.quaternion.premultiply(angles(c.tag, 0));
      root.position.x += c.offset[0]; root.position.y += c.offset[1];
    }
    for (const { bone, k } of bones) {
      const a = c.angles;
      if (!a[3 * k] && !a[3 * k + 1] && !a[3 * k + 2]) continue;
      // the parent's orientation in the root's frame
      W.identity();
      for (let o = bone.parent; o && o !== root && o !== this.group; o = o.parent) W.premultiply(o.quaternion);
      angles(a, 3 * k);
      const Wi = W.clone().invert();
      bone.quaternion.premultiply(Wi.multiply(q).multiply(W)).normalize();
    }
  }

  /** remember the body bones' pose */
  snapshot() {
    const n = this.bones.length;
    if (!this.snap || this.snap.length < n * 7) this.snap = new Float32Array(n * 7);
    this.bones.forEach((o, i) => { o.quaternion.toArray(this.snap, i * 7); o.position.toArray(this.snap, i * 7 + 4); });
  }

  /** the pose = snapshot -> current by w (slerp / lerp per bone) */
  mixFromSnapshot(w) {
    const S = this.snap;
    this.bones.forEach((o, i) => {
      qa.fromArray(S, i * 7);
      qa.slerp(o.quaternion, w);
      o.quaternion.copy(qa);
      const k = i * 7 + 4;
      o.position.set(S[k] + (o.position.x - S[k]) * w, S[k + 1] + (o.position.y - S[k + 1]) * w, S[k + 2] + (o.position.z - S[k + 2]) * w);
    });
  }

  /** the map's light at the player ([r, g, b], 1 = the texture's own colour; lightProbe.js): tints the
   *  character with its own copies of the shared materials (made once its textures have arrived) */
  /** the light of the map's light grid at the model (lightGrid.js: sample): the game's model lighting */
  setGrid(s) {
    if (!s) return;
    if (!this.gridU) {
      if (!this.lit) {
        const meshes = this.meshes.concat(this.weapons ? [...this.weapons.values()].filter(Boolean) : []);
        if (meshes.some(m => [].concat(m.material).some(x => !x.map || x.map.isDataTexture))) return;   // (still loading)
        this.gridU = gridUniforms();
        this.lit = [];
        for (const m of meshes) this.ownMaterials(m);
      } else {
        // lit by the floor light so far (setLight): now from the grid
        this.gridU = gridUniforms();
        for (const mat of this.lit) gridMaterial(mat, this.gridU);
      }
    }
    setGridUniforms(this.gridU, s);
  }

  setLight(rgb) {
    if (!rgb || this.gridU) return;
    if (!this.lit) {
      const meshes = this.meshes.concat(this.weapons ? [...this.weapons.values()].filter(Boolean) : []);
      if (meshes.some(m => [].concat(m.material).some(x => !x.map || x.map.isDataTexture))) return;   // (still loading)
      this.lit = [];
      for (const m of meshes) this.ownMaterials(m);
    }
    const r = clampLight(rgb[0]), g = clampLight(rgb[1]), b = clampLight(rgb[2]);
    if (this.light && this.light[0] === r && this.light[1] === g && this.light[2] === b) return;
    this.light = [r, g, b];
    for (const mat of this.lit) {
      mat.color.setRGB(r, g, b);
      mat.emissive.setRGB(EMISSIVE * r, EMISSIVE * g, EMISSIVE * b);
    }
  }

  ownMaterials(mesh) {
    mesh.material = [].concat(mesh.material).map(x => x.clone());
    if (mesh.material.length === 1) mesh.material = mesh.material[0];
    for (const mat of [].concat(mesh.material)) {
      this.lit.push(mat);
      if (this.gridU) gridMaterial(mat, this.gridU);
      else if (this.light) { mat.color.setRGB(...this.light); mat.emissive.setRGB(...this.light.map(c => EMISSIVE * c)); }
    }
  }

  dispose() {
    this.group.removeFromParent();
    if (this.lit) for (const mat of this.lit) mat.dispose();
  }
}
