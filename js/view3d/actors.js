/* Players in 3D: a capsule in the team colour (standing 72, crouched 50 units high, prone lying
 * along the view direction), a ring for the selected player, a muzzle flash while firing and HTML name labels
 * projected on top; optional (Display popover, off by default): the view line from the eye with the real pitch
 * (View lines). Driven by Match.sampleAt - the same positions the 2D view draws (from cod4-demo3d's actors.js).
 * Mode "models": the player's real character (body, head, helmet from the demo's client state, see
 * characters.js) animated with the legs / torso animation the demo sends, optionally with a ring in the team
 * colour at the feet (Player rings); the capsule stays the pick target and is drawn while a model is missing.
 * The view lines and the team rings exist only while switched on (setViewLines / setRings). */
import * as THREE from 'three';
import { Character } from './characters.js';
import { Controllers, stanceBlendMs, legsStance } from './controllers.js';
import { entityMatrix } from './modelBatch.js';
import { corpseAt } from '../app/match.js';
import { gridUniforms, gridMaterial } from './lightGrid.js';
import { cloneMaterial } from './mapLoader.js';

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
const LEGS_BLEND = 200;                        // ms: a crossfade with nothing known before it
const STANCE_WINDOW = 400;                     // ms: BG_SetNewAnimation's stance window (ci + 1196 = time + 400)
const CHAIN_MAX = 8;                           // crossfades still running at once, at most (50 ms samples: 400 ms)
const CORPSE_POOL = 24;                        // corpses kept hidden for reuse
const PHASE_WALK = 64;                         // loop -> loop changes followed back for a loop's phase, at most
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** a moving looping animation (run, walk, crawl, strafe): played by the ground covered, its phase carried on */
const movingLoop = c => !!(c && c.loop && c.speed > 0);
/** a loop's period in s (as Character.apply plays it: the last key frame is the first) */
const period = c => Math.max(1, c.keyFrames - 1) / c.rate;
/** BG_RunLerpFrameRate's limits on a moving animation's rate (the ground speed over the clip's moveSpeed): at least
 *  0.1, at most 2 (moveSpeed > 150), 3 - (moveSpeed - 20) / 130 (20 - 150) or 3 (< 20) */
const rateLimits = speed => [0.1, speed > 150 ? 2 : speed >= 20 ? 3 - (speed - 20) / 130 : 3];
const frac = x => x - Math.floor(x);

const _bm = new THREE.Matrix4(), _bo = new THREE.Matrix4(), _tw = new THREE.Vector3(), _cs = new THREE.Vector3(), _cp = new Array(6);
/** a world matrix -> {pos, axis: {f, l, u}} (its x / y / z axes, unit length) */
export function frameOf(m) {
  const e = m.elements, n = (a, b, c) => { const l = Math.hypot(a, b, c) || 1; return [a / l, b / l, c / l]; };
  return { pos: [e[12], e[13], e[14]], axis: { f: n(e[0], e[1], e[2]), l: n(e[4], e[5], e[6]), u: n(e[8], e[9], e[10]) } };
}

export class Actors {
  constructor(scene, labelLayer, match, library) {
    this.scene = scene;
    this.M = match;
    this.library = library || null;
    this.controllers = library ? new Controllers(match, library) : null;   // legs / torso / head turns, lean, slopes
    this.mode = 'simple';
    this.starts = new Map();           // client -> {legs: Int32Array, torso: Int32Array} start time of each sample's animation
    this.hands = new Map();            // client -> {t, left} the gun-hand switches (gunLeft)
    this.corpseItems = new Map();      // client@t0 -> {ch, mkey} the corpses shown in mode "models"
    this.corpsePool = new Map();       // models key -> [Character] hidden corpses for reuse (releaseCorpse)
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
    this.viewLines = false;            // the view lines and the team rings (setViewLines / setRings)
    this.rings = false;
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
    // (on a mounted MG: the turret's muzzle - view3d.js turretOf / turretMuzzle)
    const tm = it.sample.turret && this.turretMuzzle ? this.turretMuzzle(cl) : null;
    if (tm) return tm;
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

  /** the ejection port of a client's weapon as drawn now (its world model's tag_brass, mode "models") ->
   *  {pos, axis: {f, l, u}} or null */
  brass(cl) {
    const it = this.items.get(cl);
    if (!it || !it.visible || !it.sample) return null;
    const w = it.modelShown && it.char && it.char.weapon;
    if (!w || !w.userData.brass) return null;
    w.updateWorldMatrix(true, false);
    return frameOf(_bm.multiplyMatrices(w.matrixWorld, w.userData.brass));
  }

  /** the ejection port of a client's weapon at time t when it was not drawn then (a seek): the weapon's
   *  tag_brass with the gun held along the view at the eye (12 forward, 5 right, 6 down) -> as brass() or null */
  brassAt(cl, t) {
    const s = this.M.sampleAt(cl, t), L = this.library;
    if (!s || s.age > CFG.STALE_MS || !L || !L.modelsInfo) return null;
    const model = L.weaponModel(this.M.weaponName(s.weapon, t)), tpl = model && L.template(model);
    const k = tpl ? tpl.bones.findIndex(b => b.name === 'tag_brass') : -1;
    if (k < 0) return null;
    entityMatrix(_bm, s.x, s.y, s.z + EYE[stanceOf(s)], s.pitch, s.yaw, 0);
    return frameOf(_bm.multiply(_bo.makeTranslation(12, -5, -6)).multiply(tpl.bindWorld[k]));
  }

  /** when each sample's legs / torso animation started, and the distance walked (build.js animStarts: made by the
   *  analysis; a demo analysed without it - a test's own data - gets it here) */
  startsOf(cl) {
    let s = this.starts.get(cl);
    if (s) return s;
    const P = this.M.d.positions[cl];
    s = (P && P.starts) || C2.animStarts(P, P ? this.M.drawn(cl) : null);
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
    // a looping moving animation (run, walk, crawl) advances by the distance covered over its own speed - the feet
    // keep step with the ground - at a rate within the game's limits (rateLimits), from the phase it started at
    // (phaseOf); others by time
    const P = this.M.d.positions[cl];
    const Q = this.M.drawn(cl), distNow = st.dist[i] + Math.hypot(s.x - Q.x[i], s.y - Q.y[i]);
    const animSec = x => {
      const clip = x.clip;
      if (!movingLoop(clip)) return (t - x.start) / 1000;
      const [lo, hi] = rateLimits(clip.speed), dt = Math.max(0, t - P.t[i]) / 1000;
      const sec = this.advance(P, st, x.from, clip, i) + Math.min(hi * dt, Math.max(lo * dt, (distNow - st.dist[i]) / clip.speed));
      return (P.legs && clip === L.clip(P.legs[x.from]) ? this.phaseOf(cl, P, st, x.from) * period(clip) : 0) + sec;
    };
    // a new legs animation fades in over the game's crossfade time (blendMs) while the old one keeps playing; a torso
    // animation (fire, reload, throw) fades in / out the same way over the legs, or from the torso animation it replaces. A
    // change while the one before is still fading fades from that mix (the chain, oldest first: chainOf)
    // On a mounted MG the demo sends the gunner's blend block (standMG42_aim / _fire, prone...): the gunner clips
    // nearest the gun's aim (CharacterLibrary.gunnerBlend); their root faces the gun's yaw turned by the clips' own
    // root turn (dyaw) and they aim the body themselves - no angle controllers (both by the gunner pose's share)
    const tu = (s.turret || (P.legs && L.blendDef(P.legs[i]))) && this.turretAim ? this.turretAim(cl, t, s) : null;
    const tw = tu && tu.a.prop.tag ? tu.a.prop.tag('tag_weapon', tu.pitch, tu.yaw, _tw) : null;
    // the crossfade times: the game's (blendMs); CoD2x (g_cod2x >= 3) gives a stance change's legs its own time
    const cx = !!(this.controllers && this.controllers.cx);
    const legsChain = this.chainOf(P, st, 'legs', i, t, (a, b, j) => (cx && stanceBlendMs(L, a, b)) || this.blendMs(P, st, a, b, j, cx), v => {
      const def = L.blendDef(v), g = def && tw ? L.gunnerBlend(def, s.z - tw.z, tu.yaw) : null;
      return g ? { clip: g.clip, dyaw: g.dyaw } : { clip: L.clip(v) || stance };
    });
    for (const x of legsChain) x.sec = animSec(x);
    const torsoChain = this.chainOf(P, st, 'torso', i, t, (a, b, j) => this.blendMs(P, st, a, b, j, cx), v => ({ clip: (v & 0x1ff) ? L.clip(v) : null }));
    for (const x of torsoChain) x.sec = (t - x.start) / 1000;
    ch.poseLayers(legsChain, torsoChain);
    let gw = 0, dyaw = 0;
    for (let k = 0; k < legsChain.length; k++) {
      if (legsChain[k].dyaw == null) continue;
      let e = k === 0 ? 1 : legsChain[k].w;                 // (the layer's share of the result)
      for (let j = k + 1; j < legsChain.length; j++) e *= 1 - legsChain[j].w;
      gw += e; dyaw += e * legsChain[k].dyaw;
    }
    // (turret_think: the root's yaw = the gun's + the clips' root turn; measured on 69 turret moments of 3 maps - the
    // hands 3 - 6 units from the gun's tag_weapon, the other sign or none 4 - 8)
    if (gw > 0) ch.group.rotation.z = (s.yaw + dyaw) * D2R;
    const c = this.controllers && this.controllers.at(cl, t);
    if (c) ch.applyControllers(c, 1 - gw);
    // (on a mounted MG the gun is the turret's: no weapon in the hand)
    ch.setWeapon(s.turret ? null : L.weaponModel(s.weapon ? this.M.weaponName(s.weapon, t) : null), this.gunLeft(cl, t));
  }

  /** the crossfade chain of a legs / torso animation at sample i, time t, oldest first: [{...make(value), start, w}] -
   *  the current value, and while it is still fading in (t - its start < blend ms) the value before it, and so on
   *  (at most CHAIN_MAX deep; a layer that has finished fading hides everything before it, so the walk stops there);
   *  blend: (value before, value, the sample it starts at) -> ms; from: that sample */
  chainOf(P, st, k, i, t, blend, make) {
    const V = P[k], from = st[k + 'From'], fresh = st[k + 'Fresh'], out = [];
    let j = i;
    for (let d = 0; d < CHAIN_MAX; d++) {
      const a = from[j], start = P.t[a];
      const x = make(V ? V[j] : 0);
      const ms = V && a > 0 && !fresh[a] ? blend(V[a - 1], V[j], a) : LEGS_BLEND;
      x.start = start; x.from = a; x.w = smooth((t - start) / Math.max(1, ms));
      out.unshift(x);
      if (x.w >= 1 || fresh[a] || a === 0) break;
      j = a - 1;
    }
    return out;
  }

  /** BG_SetNewAnimation's crossfade (ms) from legs / torso value a to b, starting at sample j: the new animation's
   *  blendtime (anims.json blendTimes, the game's initialLerp; 200 for no animation), without one at least 120 (the
   *  new animation moves), 250 (the old one moves) or 170 ms; and (1.3 - CoD2x leaves it out) at least to the end of
   *  the stance window, 400 ms after the legs last changed stance (crouch / prone movetype) */
  blendMs(P, st, a, b, j, cx) {
    const L = this.library, BT = L.animsInfo && L.animsInfo.blendTimes;
    const ia = a & 0x1ff, ib = b & 0x1ff, ca = ia ? L.clip(ia) : null, cb = ib ? L.clip(ib) : null;
    const oldMoves = !!(ca && ca.speed > 0);
    let ms;
    if (!ib) ms = Math.max(200, oldMoves ? 250 : 170);
    else ms = (BT && BT[ib]) || (cb && cb.speed > 0 ? 120 : oldMoves ? 250 : 170);
    const V = P.legs, T = P.t;
    if (!cx && V) for (let k = j; k > 0 && T[j] - T[k] < STANCE_WINDOW; k--) {
      if (T[k] - T[k - 1] > 1000) break;
      if (V[k] !== V[k - 1] && legsStance(L, V[k]) !== legsStance(L, V[k - 1])) { ms = Math.max(ms, T[k] + STANCE_WINDOW - T[j]); break; }
    }
    return ms;
  }

  /** a moving loop's play time (s) from sample a to sample k: per sample step the ground covered over the clip's
   *  speed, within the game's rate limits (BG_RunLerpFrameRate, per frame - not over the whole run, where a pause
   *  would let it catch up). Cached per start sample and clip, grown on demand */
  advance(P, st, a, clip, k) {
    const C = st.adv || (st.adv = new Map()), key = a + ':' + clip.name;
    let c = C.get(key);
    if (!c) C.set(key, c = [0]);
    if (a + c.length <= k) {
      const [lo, hi] = rateLimits(clip.speed);
      for (let m = a + c.length; m <= k && m < P.t.length; m++) {
        const dt = (P.t[m] - P.t[m - 1]) / 1000, d = (st.dist[m] - st.dist[m - 1]) / clip.speed;
        c.push(c[c.length - 1] + Math.min(hi * dt, Math.max(lo * dt, d)));
      }
    }
    return c[Math.max(0, Math.min(k - a, c.length - 1))];
  }

  /** the phase (0 - 1) of the legs animation starting at sample a (BG_SetNewAnimation): a moving loop replacing
   *  another moving loop goes on at the old one's phase (XAnimGetTime: no step hitch on run -> strafe); another moving
   *  loop starts at frac(time mod (length + 200) / (length + 200) + clientNum x 0.36), so players who start running
   *  together don't step in lockstep; anything else at 0. Followed back over at most PHASE_WALK changes, cached */
  phaseOf(cl, P, st, a) {
    const memo = st.phase || (st.phase = new Map());
    if (memo.has(a)) return memo.get(a);
    const L = this.library, V = P.legs, from = st.legsFrom, fresh = st.legsFresh;
    const prevOf = r => (r > 0 && !fresh[r] ? from[r - 1] : -1);
    const runs = [a];
    for (let r = a, n = 0; n < PHASE_WALK; n++) {
      const p = prevOf(r);
      if (p < 0 || memo.has(p) || !movingLoop(L.clip(V[r])) || !movingLoop(L.clip(V[p]))) break;
      runs.push(p); r = p;
    }
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k], c = L.clip(V[r]);
      let ph = 0;
      if (movingLoop(c)) {
        const p = prevOf(r), pc = p >= 0 ? L.clip(V[p]) : null;
        if (movingLoop(pc) && memo.has(p)) ph = frac((memo.get(p) * period(pc) + this.advance(P, st, p, pc, r)) / period(pc));
        else { const len = c.frames / c.rate * 1000 + 200; ph = frac((P.t[r] % len) / len + cl * 0.36); }
      }
      memo.set(r, ph);
    }
    return memo.get(a);
  }

  /** is a client's gun in the left hand at t? CG_ProcessClientNoteTracks: an anim_gunhand = "left" / "right"
   *  notetrack of a legs or torso animation the player plays past sets it (grenade throws, rifle reloads), until
   *  the next one - nothing else resets it (a standing rifle reload or a crouched throw leaves it left) */
  gunLeft(cl, t) {
    let ev = this.hands.get(cl);
    if (!ev) {
      const L = this.library, P = this.M.d.positions[cl], st = this.startsOf(cl);
      if (!L || !L.animsInfo || !P) return false;
      ev = { t: [], left: [] };
      const list = [];
      for (const k of ['legs', 'torso']) {
        const S = st[k], V = P[k], n = P.t.length;
        if (!V) continue;
        for (let i = 0; i < n;) {
          let j = i + 1;
          while (j < n && S[j] === S[i]) j++;
          const clip = (V[i] & 0x1ff) ? L.clip(V[i]) : null;
          if (clip && clip.gunhand) {
            // (played until the next animation, or to the last sample before a gap)
            const end = j < n && P.t[j] - P.t[j - 1] <= 1000 ? P.t[j] : P.t[j - 1] + 50;
            for (const [f, h] of clip.gunhand) { const tn = S[i] + f / clip.rate * 1000; if (tn < end) list.push([tn, h === 'left']); }
          }
          i = j;
        }
      }
      list.sort((a, b) => a[0] - b[0]);
      for (const [tn, l] of list) { ev.t.push(tn); ev.left.push(l); }
      this.hands.set(cl, ev);
    }
    let lo = 0, hi = ev.t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev.t[m] <= t) lo = m + 1; else hi = m; }
    return lo > 0 && ev.left[lo - 1];
  }

  item(cl) {
    let it = this.items.get(cl);
    if (it) return it;
    const color = new THREE.Color(this.M.color(cl));
    const body = new THREE.Mesh(this.geo.stand, new THREE.MeshLambertMaterial({ color, transparent: true }));
    const group = new THREE.Group();
    group.add(body);
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffb35c, side: THREE.DoubleSide, forceSinglePass: true, transparent: true, opacity: 0.9, depthTest: false }));
    ring.renderOrder = 5;
    const fire = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff0b4 }));
    const label = document.createElement('div');
    label.className = 'p3-label';
    label.style.setProperty('--tc', '#' + color.getHexString());     // the name in the team colour (styles.css)
    this.layer.append(label);
    // the markers throw no shadow (shadows.js: every other mesh of the actors does)
    ring.userData.noCookie = fire.userData.noCookie = true;
    it = { cl, group, body, aim: null, ring, fire, label, color, teamRing: null, visible: false, pos: new THREE.Vector3(), eye: new THREE.Vector3(), sample: null };
    this.root.add(group, ring, fire);
    this.items.set(cl, it);
    return it;
  }

  /** the view lines (View lines) on / off: off, every player's line goes (made again when switched on) */
  setViewLines(on) {
    this.viewLines = on;
    if (on) return;
    for (const it of this.items.values()) {
      if (!it.aim) continue;
      this.root.remove(it.aim); it.aim.geometry.dispose(); it.aim.material.dispose(); it.aim = null;
    }
  }
  /** the team rings at the feet of the player models (Player rings) on / off: off, every ring goes */
  setRings(on) {
    this.rings = on;
    if (on) return;
    for (const it of this.items.values()) {
      if (!it.teamRing) continue;
      this.root.remove(it.teamRing); it.teamRing.material.dispose(); it.teamRing = null;
    }
  }
  /** a player's view line: from the eye along the view, in a lighter team colour */
  aimOf(it) {
    if (!it.aim) {
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      it.aim = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: it.color.clone().lerp(new THREE.Color(0xffffff), 0.35), transparent: true }));
      it.aim.frustumCulled = false;
      this.root.add(it.aim);
    }
    return it.aim;
  }
  /** a player's team ring on the ground */
  teamRingOf(it) {
    if (!it.teamRing) {
      it.teamRing = new THREE.Mesh(this.teamRingGeo, new THREE.MeshBasicMaterial({ color: it.color, side: THREE.DoubleSide, forceSinglePass: true, transparent: true, opacity: 0.85, depthWrite: false }));
      it.teamRing.renderOrder = 4;
      it.teamRing.userData.noCookie = true;           // (no shadow: shadows.js)
      this.root.add(it.teamRing);
    }
    return it.teamRing;
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
      if (this.viewLines && !stale) {
        const aim = this.aimOf(it), a = aim.geometry.attributes.position.array;
        a[0] = it.eye.x; a[1] = it.eye.y; a[2] = it.eye.z;
        a[3] = it.eye.x + fwd.x * AIM_LEN; a[4] = it.eye.y + fwd.y * AIM_LEN; a[5] = it.eye.z + fwd.z * AIM_LEN;
        aim.geometry.attributes.position.needsUpdate = true;
        aim.visible = true;
      } else if (it.aim) it.aim.visible = false;
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
      if (this.rings && ch) {
        const r = this.teamRingOf(it);
        r.visible = true;
        r.position.set(s.x, s.y, s.z + 1);
      } else if (it.teamRing) it.teamRing.visible = false;
      it.ring.visible = focus || hover;
      it.ring.position.set(s.x, s.y, s.z + 1.5);
      it.ring.material.color.set(focus ? 0xffb35c : 0xffffff);
      const name = M.name(cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '');
      it.labelText = (opts.labels && !this.isEnemy(cl, opts.enemyOf)) || focus || hover ? name + (focus && !stale ? '  ·  ' + M.weaponLabel(s.weapon, t) : '') : '';
      it.label.classList.toggle('stale', stale);
      it.label.classList.toggle('focus', focus);
    }
    this.updateCorpses(t, opts);
    for (const it of this.items.values()) {
      it.group.visible = it.visible;
      if (!it.visible) {
        it.ring.visible = false; it.fire.visible = false;
        if (it.aim) it.aim.visible = false;
        if (it.teamRing) it.teamRing.visible = false;
        if (it.char) it.char.group.visible = false;
      }
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
          const mkey = models ? models.body + '|' + models.attach.join('|') : null;
          // a hidden corpse of the same models from the pool (building one stalls a frame), else a new one
          const pool = mkey && this.corpsePool.get(mkey);
          let ch = pool && pool.length ? pool.pop() : null;
          if (!ch && models) { ch = new Character(this.library, models.body, models.attach); if (ch.ok) this.root.add(ch.group); else ch = null; }
          h = { ch, mkey };
          this.corpseItems.set(key, h);
        }
        if (!h.ch) continue;
        h.ch.group.visible = true;
        // where the corpse is now: its trajectory (falling, sliding with the death animation, tilted to the slope it came
        // to rest on - Match corpseAt, as the game's CG_Corpse), every frame (seeks and speeds give the same place)
        const p = corpseAt(c, t, _cp);
        entityMatrix(_bm, p[0], p[1], p[2], p[3], p[4], p[5]).decompose(h.ch.group.position, h.ch.group.quaternion, _cs);
        const clip = this.library.clip(c.legs) || this.library.clip(this.library.indexOf('pb_stand_death_chest_blowback'));
        h.ch.pose(clip, (t - c.t0) / 1000);
        if (this.grid) h.ch.setGrid(this.gridAt(h, p[0], p[1], p[2]));
        if (this.probe) h.ch.setLight(this.lightAt(h, p[0], p[1], p[2]));
      }
    }
    for (const [key, h] of this.corpseItems) {
      if (want.has(key)) continue;
      if (h.ch) this.releaseCorpse(h);
      this.corpseItems.delete(key);
    }
  }
  /** a corpse no longer shown: hidden into the pool of its models (up to CORPSE_POOL in all), else disposed */
  releaseCorpse(h) {
    h.ch.group.visible = false;
    let n = 0; for (const p of this.corpsePool.values()) n += p.length;
    if (n >= CORPSE_POOL) { h.ch.dispose(); return; }
    let p = this.corpsePool.get(h.mkey);
    if (!p) this.corpsePool.set(h.mkey, p = []);
    p.push(h.ch);
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

  /** the players' and corpses' LODs for the camera (characters.js setLod; the game's lod scale: tan(fov_x / 2) /
   *  tan(40 deg), the view's fov as the 4:3 horizontal fov cg_fov is) */
  updateLods(camera) {
    const p = camera.position;
    const scale = Math.tan(Math.atan(Math.tan(camera.fov * Math.PI / 360) * 4 / 3)) / Math.tan(40 * Math.PI / 180);
    const lod = ch => { if (!ch || !ch.group.visible || !ch.setLod) return; const g = ch.group.position; ch.setLod(Math.hypot(g.x - p.x, g.y - p.y, g.z - p.z) * scale); };
    for (const it of this.items.values()) lod(it.char);
    for (const h of this.corpseItems.values()) lod(h.ch);
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

  /** is cl an enemy of client ref? (the other team; in a deathmatch everyone else; none for a spectator / no ref) */
  isEnemy(cl, ref) {
    if (ref == null || ref < 0 || cl === ref) return false;
    const M = this.M, a = M.player(ref), b = M.player(cl);
    if (String(M.d.meta.gametype || '').toLowerCase() === 'dm') return !!a;
    return !!(a && b && (a.team === 'A' || a.team === 'B') && (b.team === 'A' || b.team === 'B') && a.team !== b.team);
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
    it.group.visible = false; it.ring.visible = it.fire.visible = false;
    if (it.aim) it.aim.visible = false;
    if (it.teamRing) it.teamRing.visible = false;
    if (it.char) it.char.group.visible = false;
  }

  /** stand-ins of every player model and held weapon model the demo shows, with their materials as drawn (the
   *  template's, and the light grid's own copies: Character.setGrid / setWeapon) - compiled with the map's load
   *  (View3D.compileAhead): their programs were otherwise linked at the first draw of a new lit variant in the middle
   *  of the playback (17 - 43 ms). Kept while the grid stays (the programs live as long as a material uses them).
   *  -> THREE.Group or null (no models) */
  warmup() {
    if (this.mode !== 'models' || !this.libReady) return null;
    if (this.warm && this.warm.grid === this.grid) return this.warm.group;
    const L = this.library, D = this.M.d, skinned = new Set(), rigid = new Set();
    for (const list of Object.values(D.playerModels || {})) for (const e of list || []) if (e && e.body) { skinned.add(e.body); for (const a of e.attach || []) skinned.add(a); }
    for (const w of D.weaponLists || []) for (const n of w.list || []) { const m = L.weaponModel(n); if (m) rigid.add(m); }
    const group = new THREE.Group(), u = this.grid ? gridUniforms() : null, own = [];
    const add = (t, isSkinned) => {
      for (const lit of u ? [false, true] : [false]) {
        let mats = [].concat(t.materials);
        if (lit) { mats = mats.map(m => gridMaterial(cloneMaterial(m), u)); own.push(...mats); }
        const mesh = isSkinned ? new THREE.SkinnedMesh(t.geometry, mats) : new THREE.Mesh(t.geometry, mats);
        if (isSkinned) mesh.bind(new THREE.Skeleton(t.bones.map(() => new THREE.Bone())), new THREE.Matrix4());
        mesh.frustumCulled = false;
        group.add(mesh);
      }
    };
    for (const name of skinned) {
      const t0 = L.template(name);
      if (t0) for (let lv = 0; lv < t0.lods; lv++) { const t = lv ? L.template(name, lv) : t0; if (t) add(t, true); }
    }
    for (const name of rigid) { const t = L.template(name); if (t) add(t, false); }
    if (this.warm) for (const m of this.warm.own) m.dispose();
    this.warm = { grid: this.grid, group, own };
    return group;
  }

  dispose() {
    if (this.warm) for (const m of this.warm.own) m.dispose();
    for (const it of this.items.values()) it.label.remove();
    this.scene.remove(this.root);
  }
}
