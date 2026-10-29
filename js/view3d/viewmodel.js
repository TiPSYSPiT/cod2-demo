/* The first-person weapon: the gun the followed player holds, in the hands the game gives them
 * (maps3d/_characters/viewmodels.json + vanims.json, tools/export/viewmodels_export.py), animated with the
 * weapon's own view animations as the demo drives them (viewanim.js), the crosshair and the sniper scope.
 * Ported from cod4-demo3d (viewmodel.js); the crosshair and the scope as CoD2 draws them (CG_DrawCrosshair,
 * CG_DrawWeapReticle of the 1.3 client).
 *
 * As in the game it is one skeleton of two models: the hands (the server's setViewmodel - playerState
 * viewmodelIndex - else the weapon file's handModel) and the gun (gunModel), the gun's root j_gun on the
 * hands' tag_weapon. An animation's rotation keys replace a bone's rotation, its translation keys are added
 * to the bind translation (as the player animations, characters.js). The hands' root tag_view is the eye:
 * the rig hangs at the first-person camera with its view axes (model space X forward, Y left, Z up), moved
 * by the bob, sway and kick offsets.
 *
 * Drawn after the scene in a pass of its own with the depth buffer cleared and a near plane of 0.5 units:
 * on top of the world, never in a wall - the game draws its view model the same way. Lit like the players:
 * the map's light grid at the eye. The crosshair and the scope overlay follow in an orthographic pass in the
 * game's 640 x 480 screen units (scaled to the canvas height) - part of the canvas, so also in the video export. */
import * as THREE from 'three';
import { fetchJSON, fetchBinary } from './data.js';
import { loadTexture } from './mapLoader.js';
import { CharacterLibrary } from './characters.js';
import { gridUniforms, setGridUniforms, gridMaterial } from './lightGrid.js';
import { ViewAnimator } from './viewanim.js';

const BASE = 'maps3d/_characters/';
const D2R = Math.PI / 180;
// model space (X forward, Y left, Z up) -> camera space (-Z forward, -X left, Y up)
const MODEL_TO_CAMERA = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  0, -1, 0, 0,
  0, 0, 1, 0,
  -1, 0, 0, 0,
  0, 0, 0, 1));
// the game's cg_fov (default 80): a horizontal fov of the 4:3 screen
export const CG_FOV = 80;
const vFov43 = h => 2 * Math.atan(Math.tan(h * D2R / 2) * 0.75) / D2R;
const hFov43 = v => 2 * Math.atan(Math.tan(v * D2R / 2) / 0.75) / D2R;
/** the first-person camera's vertical fov: cg_fov 80 on the game's 4:3 screen (wider screens see more aside) */
export const FP_FOV = vFov43(CG_FOV);

/** the view models and their animations (the player models' library, on other files) */
class ViewModelLibrary extends CharacterLibrary {
  load() {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const [mj, aj] = await Promise.all([fetchJSON(BASE + 'viewmodels.json'), fetchJSON(BASE + 'vanims.json')]);
          const [mb, ab] = await Promise.all([fetchBinary(BASE + mj.file, { expected: mj.byteLength }), fetchBinary(BASE + aj.file, { expected: aj.byteLength })]);
          this.modelsInfo = mj; this.modelsBuf = mb;
          this.animsInfo = aj; this.animsBuf = ab;
          this.clips = new Map();
          return true;
        } catch (err) {
          console.warn('first-person weapons not available:', err.message);
          return false;
        }
      })();
    }
    return this.ready;
  }
  /** a view animation by name (characters.js clip format) or null */
  clipNamed(name) {
    if (!this.animsInfo || !name) return null;
    if (this.clips.has(name)) return this.clips.get(name);
    const a = this.animsInfo.anims[name];
    let clip = null;
    if (a) {
      const B = this.animsBuf;
      const last = Math.max(1, a.loop ? a.keyFrames - 1 : a.frames - 1);
      clip = { name, frames: a.frames, keyFrames: a.keyFrames, rate: a.rate || 30, loop: a.loop, duration: last / (a.rate || 30), tracks: a.tracks.map(t => ({
        bone: this.animsInfo.bones[t[0]],
        rf: t[2] ? new Uint16Array(B, t[1], t[2]) : null, rq: t[2] ? new Float32Array(B, t[3], t[2] * 4) : null,
        tf: t[5] ? new Uint16Array(B, t[4], t[5]) : null, tv: t[5] ? new Float32Array(B, t[6], t[5] * 3) : null })) };
    }
    this.clips.set(name, clip);
    return clip;
  }
}

/** key interval of frame f in a key frame list -> [i, j, fraction] */
function keyAt(frames, f) {
  const n = frames.length;
  if (n === 1 || f <= frames[0]) return [0, 0, 0];
  if (f >= frames[n - 1]) return [n - 1, n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (frames[m] <= f) lo = m; else hi = m; }
  return [lo, hi, (f - frames[lo]) / Math.max(1, frames[hi] - frames[lo])];
}

export class ViewModel {
  constructor() {
    this.library = new ViewModelLibrary();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FP_FOV, 1, 0.5, 2000);
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.scene.add(this.root);
    // the lights without a light grid (an older export): as the main scene's
    this.hemi = new THREE.HemisphereLight(0xdde6f0, 0x3a3328, 1.7);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.3);
    this.scene.add(this.hemi, this.sun);
    this.rigs = new Map();               // gun|hands -> rig group, null (failed)
    this.current = null;                 // the shown rig
    this.enabled = true;                 // Display: First-person weapon
    this.crosshair = true;               // Display: Crosshair
    this.shown = false;
    this.grid = null; this.gridU = null; this.gridSample = null; this.gridAt = null;
    this.onLoaded = null;
    this.state = null;                   // the last viewanim.js state (tests)
    this.requested = false;
    // the overlay pass: the crosshair (the reticle images) and the scope (pixels, origin at the centre)
    this.hud = new THREE.Scene();
    this.hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.texs = new Map();
    this.sprite = () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false })); m.visible = false; this.hud.add(m); return m; };
    this.sides = [this.sprite(), this.sprite(), this.sprite(), this.sprite()];
    this.center = this.sprite();
    this.scope = null;                   // {group, quad, bars}
  }

  /** the match (a new demo): the animation driver; legsName(index) -> the legs animation's name */
  setMatch(M, legsName) { this.anim = new ViewAnimator(M, legsName); this.M = M; }

  /** the map's light grid (lightGrid.js): the view model is then lit like the players */
  setGrid(grid) { this.grid = grid || null; }

  changed() { if (this.onLoaded) this.onLoaded(); }

  /** the library: loaded on the first use of the first-person camera */
  request() {
    if (this.requested) return;
    this.requested = true;
    this.library.load().then(ok => { this.table = ok ? this.library.modelsInfo : null; this.changed(); });
  }

  /** the view model entry of a demo weapon name (mp40_mp ...) or null */
  entry(name) {
    const W = this.table && this.table.weapons;
    if (!W || !name) return null;
    const n = String(name).toLowerCase();
    return W[n] || W[n + '_mp'] || null;
  }

  clipInfo(name) { return this.library.clipNamed(name); }

  /** the view model of client cl at t: sample s (null: dead / not visible -> hidden) -> the state or null */
  update(cl, t, s) {
    this.state = null;
    let obj = null;
    if (s && (this.enabled || this.crosshair)) this.request();
    if (s && this.table && this.anim && (this.enabled || this.crosshair)) {
      const st = this.anim.state(cl, t, s, n => this.entry(n), n => this.clipInfo(n));
      this.state = st;
      if (this.enabled && st.entry) {
        const e = st.entry;
        // the hands: the server's for the recorder (viewmodelIndex), else the weapon file's
        const hands = (e.params.isHandModelOverridable || st.recorder) ? (this.anim.handsOf(cl, t) || e.hands) : e.hands;
        const group = this.rig(e.gun, hands);
        if (group) { this.pose(group, st); obj = group; }
      }
    }
    // the game does not draw the view model while the scope overlay is up, nor on a mounted MG (EF_USETURRET:
    // the turret is the gun - CG_AddViewWeapon)
    if (obj && (this.overlayFrac() > 0 || (s && s.turret))) obj = null;
    if (this.state && s && s.turret) this.state.noReticle = true;
    if (obj !== this.current) {
      if (this.current) this.current.visible = false;
      this.current = obj;
      if (obj) obj.visible = true;
    }
    this.shown = !!obj;
    return this.state;
  }

  /** the scope overlay's opacity (CG_DrawWeapReticle): the weapon's adsOverlayShader, over the last part of the
   *  sights' transition (adsZoomInFrac aiming in, adsZoomOutFrac out) */
  overlayFrac() {
    const st = this.state, e = st && st.entry;
    if (!this.enabled || !e || !e.strings.adsOverlayShader || !this.table.overlays[e.strings.adsOverlayShader] || !(st.ads > 0)) return 0;
    const P = e.params, f = (st.adsIn ? P.adsZoomInFrac : P.adsZoomOutFrac) || 0.5;
    const x = (st.ads - (1 - f)) / f;
    return x <= 0.01 ? 0 : Math.min(1, x);
  }

  /** the zoom of the sights (CG_CalcFov): 0 = hip .. 1 = the weapon's adsZoomFov, over the last adsZoomInFrac /
   *  adsZoomOutFrac of the transition */
  zoomFrac() {
    const st = this.state, P = st && st.entry && st.entry.params;
    if (!this.enabled || !P || !P.adsZoomFov || !(st.ads > 0)) return 0;
    const f = (st.adsIn ? P.adsZoomInFrac : P.adsZoomOutFrac) || 0.5;
    return Math.min(1, Math.max(0, (st.ads - (1 - f)) / f));
  }

  /** the vertical field of view of the first-person camera at the base fov: the weapon's adsZoomFov (a
   *  horizontal fov of the 4:3 screen, relative to cg_fov 80) */
  fov(base) {
    const z = this.zoomFrac();
    if (!z) return base;
    const P = this.state.entry.params, scale = hFov43(base) / CG_FOV;
    return base + (vFov43(Math.min(170, P.adsZoomFov * scale)) - base) * z;
  }

  /** the view model's own fov: the scene's, or the weapon's adsZoomGunFov while aiming (bazooka, panzerschreck) */
  gunFov(base, sceneFov) {
    const z = this.zoomFrac(), P = this.state && this.state.entry && this.state.entry.params;
    if (!z || !P || !P.adsZoomGunFov) return sceneFov;
    const scale = hFov43(base) / CG_FOV;
    return base + (vFov43(Math.min(170, P.adsZoomGunFov * scale)) - base) * z;
  }

  /** the rig of gun + hands (built when the library is loaded) */
  rig(gun, hands) {
    const key = gun + '|' + (hands || '');
    if (this.rigs.has(key)) return this.rigs.get(key);
    const lib = this.library, G = lib.template(gun), H = hands ? lib.template(hands) : null;
    let group = null;
    if (G) group = this.build(G, H);
    else console.warn('first-person weapon: no model', gun);
    this.rigs.set(key, group);
    return group;
  }

  /** one skeleton: the hands' bones, the gun's under the hands' tag_weapon (its root j_gun at the tag) */
  build(G, H) {
    const group = new THREE.Group();
    group.name = 'viewmodel ' + G.name;
    group.visible = false;
    const rig = { group, bones: [], rest: [], index: new Map(), maps: new Map(), meshes: [], lit: null };
    const make = tpl => tpl.bones.map(b => { const o = new THREE.Bone(); o.name = b.name; o.position.fromArray(b.t); o.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]); return o; });
    const add = (tpl, bones, isRoot) => tpl.bones.forEach((b, i) => {
      if (rig.index.has(b.name)) return;
      rig.index.set(b.name, rig.bones.length);
      rig.bones.push(bones[i]);
      rig.rest.push(isRoot(i) ? { t: new THREE.Vector3(), q: new THREE.Quaternion() } : { t: new THREE.Vector3().fromArray(b.t), q: new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]) });
    });
    let hb = null;
    if (H) {
      hb = make(H);
      H.bones.forEach((b, i) => { if (b.parent >= 0) hb[b.parent].add(hb[i]); else group.add(hb[i]); });
      add(H, hb, () => false);
    }
    const gb = make(G);
    const tag = hb ? hb[H.bones.findIndex(b => b.name === 'tag_weapon')] || hb[0] : group;
    G.bones.forEach((b, i) => {
      if (b.parent >= 0) gb[b.parent].add(gb[i]);
      else { tag.add(gb[i]); gb[i].position.set(0, 0, 0); gb[i].quaternion.identity(); }
    });
    add(G, gb, i => G.bones[i].parent < 0);
    group.updateMatrixWorld(true);
    const skin = (tpl, bones) => {
      const mesh = new THREE.SkinnedMesh(tpl.geometry, tpl.materials);
      mesh.frustumCulled = false;
      group.add(mesh);
      mesh.bind(new THREE.Skeleton(bones, tpl.bindWorld.map(m => m.clone().invert())), new THREE.Matrix4());
      rig.meshes.push(mesh);
    };
    if (H) skin(H, hb);
    skin(G, gb);
    // the muzzle (the effect of a shot plays there: fx.js)
    rig.flash = gb[G.bones.findIndex(b => b.name === 'tag_flash')] || null;
    group.userData.rig = rig;
    group.userData.triangles = G.triangles + (H ? H.triangles : 0);
    rig.q = new Float32Array(4 * rig.bones.length); rig.p = new Float32Array(3 * rig.bones.length);
    rig.wq = new Float32Array(rig.bones.length); rig.wp = new Float32Array(rig.bones.length);
    this.root.add(group);
    return group;
  }

  /** pose a rig: the layers' animations blended per bone (bones no layer moves keep their rest pose), an
   *  override layer (ADS) then replaces the bones it moves; the bob / sway / kick offsets */
  pose(group, st) {
    const rig = group.userData.rig, n = rig.bones.length, Q = rig.q, Pp = rig.p, wq = rig.wq, wp = rig.wp;
    Q.fill(0); Pp.fill(0); wq.fill(0); wp.fill(0);
    const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion();
    for (const pass of [false, true]) {
      for (const L of st.layers) {
        if (!!L.override !== pass) continue;
        const c = this.library.clipNamed(L.clip);
        if (!c) continue;
        let map = rig.maps.get(L.clip);
        if (!map) { map = c.tracks.map(tr => rig.index.has(tr.bone) ? rig.index.get(tr.bone) : -1); rig.maps.set(L.clip, map); }
        const last = Math.max(1, c.loop ? c.keyFrames - 1 : c.frames - 1);
        const f = Math.min(Math.max(0, L.time * c.rate), last);
        const w = pass ? 1 : L.weight;
        for (let k = 0; k < c.tracks.length; k++) {
          const b = map[k];
          if (b < 0) continue;
          const tr = c.tracks[k];
          if (tr.rf) {
            const [i, j, u] = keyAt(tr.rf, f);
            q0.fromArray(tr.rq, i * 4);
            if (i !== j) { q1.fromArray(tr.rq, j * 4); q0.slerp(q1, u); }
            if (pass) { Q[4 * b] = q0.x; Q[4 * b + 1] = q0.y; Q[4 * b + 2] = q0.z; Q[4 * b + 3] = q0.w; wq[b] = 1; }
            else {
              // the same hemisphere as what is accumulated
              const s = Q[4 * b] * q0.x + Q[4 * b + 1] * q0.y + Q[4 * b + 2] * q0.z + Q[4 * b + 3] * q0.w < 0 ? -w : w;
              Q[4 * b] += q0.x * s; Q[4 * b + 1] += q0.y * s; Q[4 * b + 2] += q0.z * s; Q[4 * b + 3] += q0.w * s; wq[b] += w;
            }
          }
          if (tr.tf) {
            const [i, j, u] = keyAt(tr.tf, f), V = tr.tv, R = rig.rest[b].t;
            const x = R.x + V[3 * i] + (V[3 * j] - V[3 * i]) * u, y = R.y + V[3 * i + 1] + (V[3 * j + 1] - V[3 * i + 1]) * u, z = R.z + V[3 * i + 2] + (V[3 * j + 2] - V[3 * i + 2]) * u;
            if (pass) { Pp[3 * b] = x; Pp[3 * b + 1] = y; Pp[3 * b + 2] = z; wp[b] = 1; }
            else { Pp[3 * b] += x * w; Pp[3 * b + 1] += y * w; Pp[3 * b + 2] += z * w; wp[b] += w; }
          }
        }
      }
    }
    for (let b = 0; b < n; b++) {
      const bone = rig.bones[b], r = rig.rest[b];
      if (wq[b] > 0) {
        let x = Q[4 * b], y = Q[4 * b + 1], z = Q[4 * b + 2], w = Q[4 * b + 3];
        const rest = 1 - Math.min(1, wq[b]);
        if (rest > 0) {
          const s = x * r.q.x + y * r.q.y + z * r.q.z + w * r.q.w < 0 ? -rest : rest;
          x += r.q.x * s; y += r.q.y * s; z += r.q.z * s; w += r.q.w * s;
        }
        bone.quaternion.set(x, y, z, w).normalize();
      } else bone.quaternion.copy(r.q);
      if (wp[b] > 0) {
        const rest = 1 - Math.min(1, wp[b]), k = wp[b] > 1 ? 1 / wp[b] : 1;
        bone.position.set(Pp[3 * b] * k + r.t.x * rest, Pp[3 * b + 1] * k + r.t.y * rest, Pp[3 * b + 2] * k + r.t.z * rest);
      } else bone.position.copy(r.t);
    }
    // the offsets of bob, sway, kick (model space; pitch > 0 down = about +Y, yaw > 0 left = about +Z)
    const o = st.offset;
    group.position.set(o.pos[0], o.pos[1], o.pos[2]);
    group.quaternion.setFromEuler(new THREE.Euler(o.rot[2] * D2R, o.rot[0] * D2R, o.rot[1] * D2R, 'ZYX'));
  }

  /** the muzzle of the shown view model in world space (camera = the first-person camera) -> {pos, dir} or null */
  muzzle(camera) {
    const g = this.current, rig = g && g.userData.rig;
    if (!rig || !rig.flash) return null;
    this.place(camera);
    this.root.updateMatrixWorld(true);
    const m = rig.flash.matrixWorld, e = m.elements;
    return { pos: [e[12], e[13], e[14]], dir: [e[0], e[1], e[2]] };
  }

  /** the rig at the camera, with its axes */
  place(camera) {
    this.root.position.copy(camera.position);
    this.root.quaternion.copy(camera.quaternion).multiply(MODEL_TO_CAMERA);
  }

  /** the light grid at the eye: own copies of the materials once their textures are there, lit like the players */
  light(camera) {
    const g = this.current, rig = g && g.userData.rig;
    if (!this.grid || !rig) return;
    if (!rig.lit) {
      if (rig.meshes.some(m => [].concat(m.material).some(x => !x.map || x.map.isDataTexture))) return;   // (still loading)
      if (!this.gridU) this.gridU = gridUniforms();
      rig.lit = true;
      for (const m of rig.meshes) {
        m.material = [].concat(m.material).map(x => gridMaterial(x.clone(), this.gridU) || x);
        if (m.material.length === 1) m.material = m.material[0];
      }
    }
    const p = camera.position;
    if (!this.gridAt || Math.abs(this.gridAt.x - p.x) > 4 || Math.abs(this.gridAt.y - p.y) > 4 || Math.abs(this.gridAt.z - p.z) > 4) {
      this.gridSample = this.grid.sample(p.x, p.y, p.z - 4, this.gridSample || undefined);
      this.gridAt = p.clone();
      if (this.gridSample) setGridUniforms(this.gridU, this.gridSample);
    }
  }

  /** draw over the finished frame of `camera` (the first-person camera at the eye): the gun, then the
   *  crosshair or the scope; base = the camera's fov without the zoom */
  render(renderer, camera, base, sceneLights, flashes) {
    if (this.shown && this.current) {
      const C = this.camera;
      C.position.copy(camera.position);
      C.quaternion.copy(camera.quaternion);
      C.fov = this.gunFov(base, camera.fov); C.aspect = camera.aspect;
      C.updateProjectionMatrix();
      this.place(camera);
      this.light(camera);
      if (sceneLights) {
        const [h, sun] = sceneLights;
        this.hemi.color.copy(h.color); this.hemi.groundColor.copy(h.groundColor); this.hemi.intensity = h.intensity;
        this.sun.color.copy(sun.color); this.sun.position.copy(sun.position); this.sun.intensity = sun.intensity;
      }
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.scene, C);
      // the muzzle flash (fx.js: the view flash effect at the muzzle), over the gun with its depth
      if (flashes && flashes.children.length) renderer.render(flashes, C);
      renderer.autoClear = auto;
    }
    this.renderHud(renderer, camera);
  }

  /** a HUD image; mip = false for the reticles (8 - 32 px drawn at about their size: a mipmap would average the
   *  white line and its dark outline into grey) */
  texture(file, mip = true) {
    if (!this.texs.has(file)) {
      const t = loadTexture('maps3d/' + file);
      t.colorSpace = THREE.NoColorSpace;
      if (!mip) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
      this.texs.set(file, t);
    }
    return this.texs.get(file);
  }

  /** the crosshair as CG_DrawCrosshair draws it: the weapon's reticleSide image four times (rotated 0 / 90 / 180 /
   *  270 degrees) at the spread's distance on the screen - max(reticleMinOfs, tan(spread) x 240 / tan(fov / 2)) in
   *  640 x 480 units - and the reticleCenter image in the middle; both shrink and fade while the sights come up
   *  (adsCrosshairInFrac / OutFrac) and fade with the spread (1 - aimSpreadScale / 255); none at full ADS. The
   *  scope overlay: the weapon's adsOverlayShader in its adsOverlayWidth x Height, black around it. */
  renderHud(renderer, camera) {
    const st = this.state, e = st && st.entry, P = e && e.params;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const W = size.x, H = size.y, px = H / 480;
    let any = false;
    const hideAll = () => { for (const m of this.sides) m.visible = false; this.center.visible = false; };
    // the reticle's scale and opacity while the sights come up
    let scale = 1, alpha = 0;
    if (st && P && this.crosshair && st.ads < 0.999 && !st.noReticle) {
      if (st.ads > 0) {
        const f = (st.adsIn ? P.adsCrosshairInFrac : P.adsCrosshairOutFrac) || 1;
        let x = st.ads - (1 - f); if (x > 0) x /= f;
        if (x > 0) scale = 1 - 0.5 * x;
      }
      alpha = Math.max(0, 1 - st.spread255 / 255) * (1 - this.overlayFrac());
      // the game's weapon reticle fades with the sights (CG_DrawWeapReticle: the scoped weapons' overlay)
      if (st.ads > 0) alpha *= Math.max(0, Math.min(1, 1 - (st.ads - 0.8) / 0.2));
    }
    hideAll();
    // the crosshair's colour: green on a teammate (CG_DrawCrosshair: 0.25 / 1 / 0.25), else white
    const g = st && st.friend ? 0.25 : 1;
    for (const m of [...this.sides, this.center]) m.material.color.setRGB(g, 1, g);
    if (alpha > 0.01) {
      const R = this.table.reticles;
      // the sides
      const side = e.strings.reticleSide && R[e.strings.reticleSide];
      if (side) {
        const s = (P.reticleSideSize || 6) * scale * px;
        const ofs = Math.max(P.reticleMinOfs || 0, Math.tan(st.spread * scale * D2R) * 240 / Math.tan(camera.fov * D2R / 2)) * px;
        const tex = this.texture(side.texture, false);
        const put = (m, x, y, rot) => {
          m.material.map = tex; m.material.opacity = alpha; m.material.needsUpdate = m.material.version === 0;
          m.position.set(x, y, 0); m.scale.set(s, s, 1); m.rotation.z = -rot * D2R; m.visible = true;
        };
        // (the image's tick points down: its inner end at the spread's distance)
        put(this.sides[0], 0, ofs + s / 2, 0); put(this.sides[1], ofs + s / 2, 0, 90);
        put(this.sides[2], 0, -ofs - s / 2, 180); put(this.sides[3], -ofs - s / 2, 0, 270);
      }
      // the centre (the grenades: it pulses with the cooked fuse)
      const center = e.strings.reticleCenter && R[e.strings.reticleCenter];
      if (center) {
        let c = (P.reticleCenterSize || 3);
        if (e.strings.weaponType === 'grenade' && st.fuse > 0 && P.cookOffHold) c += (st.fuse % 1000) / 100;
        const m = this.center;
        m.material.map = this.texture(center.texture, false); m.material.opacity = alpha; m.material.needsUpdate = m.material.version === 0;
        m.position.set(0, 0, 0); m.scale.set(c * scale * px, c * scale * px, 1); m.visible = true;
      }
      any = true;
    }
    // the scope
    const of = this.overlayFrac();
    if (of > 0) {
      const ov = this.table.overlays[e.strings.adsOverlayShader];
      this.buildScope();
      const sc = this.scope;
      sc.quad.material.map = this.texture(ov.texture); sc.quad.material.opacity = of; sc.quad.material.needsUpdate = true;
      const w = (P.adsOverlayWidth || 480) * px, h = (P.adsOverlayHeight || 480) * px;
      sc.quad.scale.set(w, h, 1);
      // black around the overlay
      const sideW = Math.max(0, (W - w) / 2) + 2, topH = Math.max(0, (H - h) / 2) + 2;
      sc.bars[0].scale.set(sideW, H + 4, 1); sc.bars[0].position.set(-W / 2 + sideW / 2 - 1, 0, 0);
      sc.bars[1].scale.set(sideW, H + 4, 1); sc.bars[1].position.set(W / 2 - sideW / 2 + 1, 0, 0);
      sc.bars[2].scale.set(W + 4, topH, 1); sc.bars[2].position.set(0, H / 2 - topH / 2 + 1, 0);
      sc.bars[3].scale.set(W + 4, topH, 1); sc.bars[3].position.set(0, -H / 2 + topH / 2 - 1, 0);
      for (const b of sc.bars) b.material.opacity = of;
      sc.group.visible = true;
      any = true;
    } else if (this.scope) this.scope.group.visible = false;
    if (!any) return;
    const C = this.hudCam;
    C.left = -W / 2; C.right = W / 2; C.top = H / 2; C.bottom = -H / 2; C.updateProjectionMatrix();
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.hud, C);
    renderer.autoClear = auto;
  }

  buildScope() {
    if (this.scope) return;
    const group = new THREE.Group();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
    group.add(quad);
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthTest: false, depthWrite: false });
    const bars = [0, 1, 2, 3].map(() => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), black); group.add(m); return m; });
    group.visible = false;
    this.hud.add(group);
    this.scope = { group, quad, bars };
  }

  /** triangles of the shown view model (stats) */
  triangles() { return this.shown && this.current ? (this.current.userData.triangles || 0) : 0; }

  dispose() {
    this.root.traverse(o => { if (o.isSkinnedMesh) o.skeleton.dispose(); });
    for (const g of this.rigs.values()) if (g && g.userData.rig.lit) for (const m of g.userData.rig.meshes) [].concat(m.material).forEach(x => x.dispose());
    for (const t of this.texs.values()) t.dispose();
    this.hud.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    for (const tpl of this.library.templates.values()) if (tpl) { tpl.geometry.dispose(); tpl.materials.forEach(m => m.dispose()); }
    this.scene.clear(); this.hud.clear();
  }
}
