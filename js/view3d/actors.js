/* Players in 3D: a capsule in the team colour (standing 72, crouched 50 units high, prone lying
 * along the view direction), an aim line from the eye with the real pitch, a ring for the selected
 * player, a muzzle flash while firing and HTML name labels projected on top. Driven by
 * Match.sampleAt - the same positions the 2D view draws (from cod4-demo3d's actors.js).
 * Mode "models": the player's real character (body, head, helmet from the demo's client state, see
 * characters.js) animated with the legs / torso animation the demo sends, with a ring in the team
 * colour at the feet; the capsule stays the pick target and is drawn while a model is missing. */
import * as THREE from 'three';
import { Character } from './characters.js';
import { Controllers } from './controllers.js';

const C2 = window.C2;
const CFG = C2.mapConfig;
const RADIUS = 14;
const PRONE_R = 11;
export const EYE = { stand: 60, crouch: 40, prone: 11 };
const HEIGHT = { stand: 72, crouch: 50 };
const AIM_LEN = 90;

const D2R = Math.PI / 180;
/** CoD view angles -> unit forward vector (pitch > 0 looks down) */
export function forward(yaw, pitch, out = new THREE.Vector3()) {
  const cp = Math.cos(pitch * D2R);
  return out.set(cp * Math.cos(yaw * D2R), cp * Math.sin(yaw * D2R), -Math.sin(pitch * D2R));
}
export function stanceOf(s) { return s.prone ? 'prone' : s.crouch ? 'crouch' : 'stand'; }
const LEGS_BLEND = 200, TORSO_BLEND = 120;     // ms: crossfade of the models' animations
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** the index of the first sample at or after time t (times ascending) */
function lowerIndex(T, t) { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return Math.min(lo, T.length - 1); }

export class Actors {
  constructor(scene, labelLayer, match, library) {
    this.scene = scene;
    this.M = match;
    this.library = library || null;
    this.controllers = library ? new Controllers(match, library) : null;   // legs / torso / head turns, lean, slopes
    this.mode = 'simple';
    this.starts = new Map();
    this.corpseItems = new Map();      // client@t0 -> {ch} the corpses shown in mode "models"           // client -> {legs: Int32Array, torso: Int32Array} start time of each sample's animation
    this.layer = labelLayer;
    this.root = new THREE.Group();
    this.root.name = 'players';
    scene.add(this.root);
    this.items = new Map();
    // one capsule per stance (CapsuleGeometry runs along Y, centred on the origin)
    this.geo = {
      stand: new THREE.CapsuleGeometry(RADIUS, HEIGHT.stand - 2 * RADIUS, 4, 12),
      crouch: new THREE.CapsuleGeometry(RADIUS, HEIGHT.crouch - 2 * RADIUS, 4, 12),
      prone: new THREE.CapsuleGeometry(PRONE_R, 66 - 2 * PRONE_R, 4, 12)
    };
    this.ringGeo = new THREE.RingGeometry(RADIUS + 6, RADIUS + 10, 32);
    this.teamRingGeo = new THREE.RingGeometry(13, 17, 28);
  }

  /** 'simple' (capsules) | 'models' (the characters; loads them on first use) */
  setMode(mode) {
    this.mode = mode === 'models' && this.library ? 'models' : 'simple';
    if (this.mode === 'models' && !this.libReady) {
      this.library.load().then(ok => { this.libReady = ok; if (!ok) this.failed = true; if (this.onLoaded) this.onLoaded(); });
    }
  }

  /** the muzzle of a client's weapon as drawn now: {pos, dir} - the weapon model's tag_flash in mode
   *  "models", else in front of the eyes along the view - or null */
  muzzle(cl) {
    const it = this.items.get(cl);
    if (!it || !it.visible || !it.sample) return null;
    const w = it.modelShown && it.char && it.char.weapon;
    if (w && w.userData.flash) {
      w.updateWorldMatrix(true, false);
      const p = w.userData.flash.clone().applyMatrix4(w.matrixWorld);
      const d = new THREE.Vector3(1, 0, 0).transformDirection(w.matrixWorld);
      return { pos: [p.x, p.y, p.z], dir: [d.x, d.y, d.z] };
    }
    const s = it.sample, f = forward(s.yaw, s.pitch, new THREE.Vector3());
    return { pos: [it.eye.x + f.x * 34, it.eye.y + f.y * 34, it.eye.z - 8 + f.z * 34], dir: [f.x, f.y, f.z] };
  }

  /** when each sample's legs / torso animation started (the value incl. the restart bit changed) */
  startsOf(cl) {
    let s = this.starts.get(cl);
    if (s) return s;
    const P = this.M.d.positions[cl];
    const n = P ? P.t.length : 0;
    // per sample: when its animation started, and the one it replaced (value, start; -1: none) for the
    // crossfade
    s = {};
    for (const k of ['legs', 'torso']) {
      const start = new Int32Array(n), prev = new Int32Array(n).fill(-1), prevStart = new Int32Array(n), V = P ? P[k] : null;
      for (let i = 0; i < n; i++) {
        const gap = i === 0 || P.t[i] - P.t[i - 1] > 1000 || !V;        // (no animation field: nothing to fade)
        if (gap) { start[i] = P.t[i]; continue; }
        if (V[i] !== V[i - 1]) { start[i] = P.t[i]; prev[i] = V[i - 1]; prevStart[i] = start[i - 1]; }
        else { start[i] = start[i - 1]; prev[i] = prev[i - 1]; prevStart[i] = prevStart[i - 1]; }
      }
      s[k] = start; s[k + 'Prev'] = prev; s[k + 'PrevStart'] = prevStart;
    }
    // the distance walked up to each sample (horizontal; a gap in the samples adds nothing): moving
    // animations advance by it (animSec)
    const dist = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const gap = P.t[i] - P.t[i - 1] > 1000;
      dist[i] = dist[i - 1] + (gap ? 0 : Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]));
    }
    s.dist = dist;
    this.starts.set(cl, s);
    return s;
  }

  /** the map's light under a player (lightProbe.js), looked up again after 16 units of movement */
  /** the light grid's light at a model (lightGrid.js), sampled again when it moved 4 units */
  gridAt(holder, x, y, z) {
    const c = holder.gridCache;
    if (c && Math.abs(c.x - x) < 4 && Math.abs(c.y - y) < 4 && Math.abs(c.z - z) < 4) return c.s;
    const s = this.grid.sample(x, y, z, c && c.s ? c.s : undefined);
    holder.gridCache = { x, y, z, s };
    return s;
  }

  lightAt(holder, x, y, z) {
    const c = holder.lightCache;
    if (c && Math.abs(c.x - x) < 16 && Math.abs(c.y - y) < 16 && Math.abs(c.z - z) < 16 && c.l) return c.l;
    const l = this.probe.lightAt(x, y, z + 24);
    holder.lightCache = { x, y, z, l };
    return l;
  }

  /** the client's models at time t from the client states: {body, attach} or null */
  modelsAt(cl, t) {
    const list = this.M.d.playerModels && this.M.d.playerModels[cl];
    if (!list || !list.length) return null;
    let e = null;
    for (const x of list) { if (x.t <= t) e = x; else break; }
    e = e || list[0];
    return e && e.body ? e : null;
  }

  /** the character of a player item for the given models (built on first use) */
  character(it, models) {
    const key = models.body + '|' + models.attach.join('|');
    if (it.charKey === key) return it.char;
    if (it.char) it.char.group.visible = false;
    it.chars = it.chars || new Map();
    let ch = it.chars.get(key);
    if (!ch) {
      ch = new Character(this.library, models.body, models.attach);
      if (!ch.ok) ch = null; else this.root.add(ch.group);
      it.chars.set(key, ch);
    }
    it.char = ch; it.charKey = key;
    return ch;
  }

  /** legs / torso animation of a sample, with stance fallbacks for animations the export has not */
  animate(ch, cl, s, t) {
    const L = this.library;
    const st = this.startsOf(cl), i = s.i;
    const stance = L.clip(L.indexOf(s.prone ? 'pb_prone_aim' : s.crouch ? 'pb_crouch_alert' : 'pb_stand_alert'));
    const legs = L.clip(s.legs) || stance;
    // a looping moving animation (run, walk, crawl) advances by the distance covered since it started over
    // its own speed - the feet keep step with the ground - within 0.4 - 2x the real time; others by time
    const P = this.M.d.positions[cl];
    const distNow = st.dist[i] + Math.hypot(s.x - P.x[i], s.y - P.y[i]);
    const animSec = (clip, startT) => {
      const real = (t - startT) / 1000;
      if (!clip || !clip.loop || !clip.speed) return real;
      const j = Math.max(0, lowerIndex(P.t, startT));
      const d = (distNow - st.dist[j]) / clip.speed;
      return Math.min(2 * real, Math.max(0.4 * real, d));
    };
    // a new legs animation fades in over LEGS_BLEND ms while the old one keeps playing
    const opts = {};
    const sinceLegs = t - st.legs[i];
    if (st.legsPrev[i] >= 0 && sinceLegs < LEGS_BLEND) {
      opts.prevLegs = L.clip(st.legsPrev[i]) || stance;
      opts.prevLegsSec = animSec(opts.prevLegs, st.legsPrevStart[i]);
      opts.legsW = smooth(sinceLegs / LEGS_BLEND);
    }
    // a torso animation (fire, reload, throw) fades in / out over TORSO_BLEND ms over the legs
    const sinceTorso = t - st.torso[i];
    let torso = (s.torso & 0x1ff) ? L.clip(s.torso) : null, torsoSec = sinceTorso / 1000;
    opts.torsoW = torso ? smooth(sinceTorso / TORSO_BLEND) : 1;
    if (!torso && st.torsoPrev[i] > 0 && (st.torsoPrev[i] & 0x1ff) && sinceTorso < TORSO_BLEND) {
      torso = L.clip(st.torsoPrev[i]);
      torsoSec = (t - st.torsoPrevStart[i]) / 1000;
      opts.torsoW = 1 - smooth(sinceTorso / TORSO_BLEND);
    }
    ch.pose(legs, animSec(legs, st.legs[i]), torso, torsoSec, opts);
    const c = this.controllers && this.controllers.at(cl, t);
    if (c) ch.applyControllers(c);
    // (on a mounted MG the gun is the turret's: no weapon in the hand)
    ch.setWeapon(s.turret ? null : L.weaponModel(s.weapon ? this.M.weaponName(s.weapon, t) : null));
  }

  item(cl) {
    let it = this.items.get(cl);
    if (it) return it;
    const color = new THREE.Color(this.M.color(cl));
    const body = new THREE.Mesh(this.geo.stand, new THREE.MeshLambertMaterial({ color, transparent: true }));
    const group = new THREE.Group();
    group.add(body);
    const aimGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const aim = new THREE.Line(aimGeo, new THREE.LineBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.35), transparent: true }));
    aim.frustumCulled = false;
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffb35c, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ring.renderOrder = 5;
    const fire = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff0b4 }));
    const teamRing = new THREE.Mesh(this.teamRingGeo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
    teamRing.renderOrder = 4;
    const label = document.createElement('div');
    label.className = 'p3-label';
    label.style.setProperty('--tc', '#' + color.getHexString());     // the name in the team colour (styles.css)
    this.layer.append(label);
    // the markers throw no shadow (shadows.js: every other mesh of the actors does)
    ring.userData.noCookie = fire.userData.noCookie = teamRing.userData.noCookie = true;
    it = { cl, group, body, aim, ring, fire, label, color, teamRing, visible: false, pos: new THREE.Vector3(), eye: new THREE.Vector3(), sample: null };
    this.root.add(group, aim, ring, fire, teamRing);
    this.items.set(cl, it);
    return it;
  }

  /** place every player at time t; opts: {shown:Set, focus, hover, labels, lastKnown} */
  update(t, opts) {
    const M = this.M, fwd = new THREE.Vector3();
    for (const it of this.items.values()) it.visible = false;
    for (const cl of opts.shown) {
      const s = M.sampleAt(cl, t);
      if (!s) continue;
      const stale = s.age > CFG.STALE_MS;
      if (stale && (!opts.lastKnown || s.age > CFG.LAST_KNOWN_MAX_MS)) continue;
      const it = this.item(cl);
      it.visible = true;
      it.sample = s;
      it.stale = stale;
      const st = stanceOf(s);
      it.pos.set(s.x, s.y, s.z);
      forward(s.yaw, s.pitch, fwd);
      const b = it.body;
      b.geometry = this.geo[st];
      if (st === 'prone') {
        // lying along the view direction (capsule axis Y turned onto the yaw), centre behind the origin
        b.rotation.set(0, 0, s.yaw * D2R - Math.PI / 2);
        b.position.set(s.x - Math.cos(s.yaw * D2R) * 14, s.y - Math.sin(s.yaw * D2R) * 14, s.z + PRONE_R);
      } else {
        b.rotation.set(Math.PI / 2, 0, 0);
        b.position.set(s.x, s.y, s.z + HEIGHT[st] / 2);
      }
      const focus = cl === opts.focus, hover = cl === opts.hover;
      b.material.opacity = stale ? 0.35 : 1;
      b.material.wireframe = stale;
      b.material.emissive.set(hover || focus ? 0x333333 : 0x000000);
      it.eye.set(s.x, s.y, s.z + EYE[st]);
      const a = it.aim.geometry.attributes.position.array;
      a[0] = it.eye.x; a[1] = it.eye.y; a[2] = it.eye.z;
      a[3] = it.eye.x + fwd.x * AIM_LEN; a[4] = it.eye.y + fwd.y * AIM_LEN; a[5] = it.eye.z + fwd.z * AIM_LEN;
      it.aim.geometry.attributes.position.needsUpdate = true;
      it.aim.visible = !stale;
      it.fire.visible = s.firing && !stale && !this.realFlash;   // (realFlash: fx.js draws the weapon's own flash)
      it.fire.position.set(it.eye.x + fwd.x * 34, it.eye.y + fwd.y * 34, it.eye.z - 8 + fwd.z * 34);
      // the real model (mode "models"): at the feet, turned by the yaw, posed by the demo's animations
      let ch = null;
      if (this.mode === 'models' && this.libReady && !stale) {
        const models = this.modelsAt(cl, t);
        ch = models ? this.character(it, models) : null;
      }
      if (it.char && it.char !== ch) it.char.group.visible = false;
      if (ch) {
        ch.group.visible = true;
        ch.group.position.set(s.x, s.y, s.z);
        ch.group.rotation.set(0, 0, s.yaw * D2R);
        this.animate(ch, cl, s, t);
        if (this.grid) ch.setGrid(this.gridAt(it, s.x, s.y, s.z));
        if (this.probe) ch.setLight(this.lightAt(it, s.x, s.y, s.z));       // (no grid: the floor's light)
      }
      it.modelShown = !!ch;
      b.visible = !ch;
      it.teamRing.visible = !!ch;
      it.teamRing.position.set(s.x, s.y, s.z + 1);
      it.ring.visible = focus || hover;
      it.ring.position.set(s.x, s.y, s.z + 1.5);
      it.ring.material.color.set(focus ? 0xffb35c : 0xffffff);
      const name = M.name(cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '');
      it.labelText = opts.labels || focus || hover ? name + (focus && !stale ? '  ·  ' + M.weaponLabel(s.weapon, t) : '') : '';
      it.label.classList.toggle('stale', stale);
      it.label.classList.toggle('focus', focus);
    }
    this.updateCorpses(t, opts);
    for (const it of this.items.values()) {
      it.group.visible = it.visible;
      if (!it.visible) { it.aim.visible = false; it.ring.visible = false; it.fire.visible = false; it.teamRing.visible = false; if (it.char) it.char.group.visible = false; }
    }
  }

  /** mode "models": the demo's corpse entities (DemoData.corpses), each playing the death animation the
   *  server chose from the time the corpse appeared, held on its last frame until it disappears */
  updateCorpses(t, opts) {
    const want = new Set();
    if (this.mode === 'models' && this.libReady) {
      for (const c of this.M.d.corpses || []) {
        if (t < c.t0 || t > c.t1 || !opts.shown.has(c.client)) continue;
        const key = c.client + '@' + c.t0;
        want.add(key);
        let h = this.corpseItems.get(key);
        if (!h) {
          const models = this.modelsAt(c.client, c.t0);
          const ch = models ? new Character(this.library, models.body, models.attach) : null;
          h = { ch: ch && ch.ok ? ch : null };
          if (h.ch) { this.root.add(h.ch.group); h.ch.group.position.set(c.x, c.y, c.z); h.ch.group.rotation.set(0, 0, c.yaw * D2R); }
          this.corpseItems.set(key, h);
        }
        if (!h.ch) continue;
        h.ch.group.visible = true;
        const clip = this.library.clip(c.legs) || this.library.clip(this.library.indexOf('pb_stand_death_chest_blowback'));
        h.ch.pose(clip, (t - c.t0) / 1000, null, 0);
        if (this.grid) h.ch.setGrid(this.gridAt(h, c.x, c.y, c.z));
        if (this.probe) h.ch.setLight(this.lightAt(h, c.x, c.y, c.z));
      }
    }
    for (const [key, h] of this.corpseItems) {
      if (want.has(key)) continue;
      if (h.ch) h.ch.dispose();
      this.corpseItems.delete(key);
    }
  }

  /** X-Ray (xray.js): the living players as drawn now - not a last known position, not the first-person
   *  camera's own player -> [{cl, root, color, z}] */
  xrayTargets(hideClient) {
    const out = [];
    for (const it of this.items.values()) {
      if (!it.visible || it.stale || it.cl === hideClient) continue;
      const root = it.modelShown && it.char ? it.char.group : it.body;
      if (root.visible) out.push({ cl: it.cl, root, color: it.color, z: it.pos.z });
    }
    return out;
  }

  /** X-Ray "Player + name": hidden = Map client -> nothing of him in sight (the name gets a badge); null: none */
  setXrayHidden(hidden) {
    for (const it of this.items.values()) it.xrayHidden = !!(hidden && hidden.get(it.cl));
  }

  /** HTML labels above the heads (after the camera moved) */
  projectLabels(camera, w, h, hideClient) {
    const v = new THREE.Vector3();
    for (const it of this.items.values()) {
      const show = it.visible && it.labelText && it.cl !== hideClient;
      it.label.classList.toggle('xray-hidden', !!(show && it.xrayHidden));
      if (show) {
        const top = it.sample && it.sample.prone ? 30 : it.sample && it.sample.crouch ? 58 : 80;
        v.set(it.pos.x, it.pos.y, it.pos.z + top).project(camera);
        const onScreen = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
        if (onScreen) {
          it.label.style.display = '';
          it.label.style.left = ((v.x + 1) / 2 * w).toFixed(1) + 'px';
          it.label.style.top = ((1 - v.y) / 2 * h).toFixed(1) + 'px';
          if (it.label.textContent !== it.labelText) it.label.textContent = it.labelText;
          continue;
        }
      }
      it.label.style.display = 'none';
    }
  }

  /** the player under the mouse ray, or null */
  pick(raycaster) {
    const bodies = [...this.items.values()].filter(it => it.visible).map(it => it.body);
    const hit = raycaster.intersectObjects(bodies, false)[0];
    if (!hit) return null;
    for (const it of this.items.values()) if (it.body === hit.object) return it.cl;
    return null;
  }

  /** hide a player completely (first-person camera: the followed player's own capsule) */
  hide(cl) {
    const it = this.items.get(cl);
    if (!it) return;
    it.group.visible = false; it.aim.visible = it.ring.visible = it.fire.visible = it.teamRing.visible = false;
    if (it.char) it.char.group.visible = false;
  }

  dispose() {
    for (const it of this.items.values()) it.label.remove();
    this.scene.remove(this.root);
  }
}
