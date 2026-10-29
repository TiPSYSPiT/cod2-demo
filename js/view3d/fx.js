/* The game's particle effects in 3D (maps3d/_fx/effects.json, tools/export/fx_export.py): grenade
 * explosions (the impact table's effect for the surface hit), smoke grenades (the weapon's
 * projExplosionEffect), bullet impacts (bullet_small / large / ap / shotgun by event and weapon,
 * the surface hit, facing the surface normal), scripted effects (EV_PLAY_FX: the bomb ...), the
 * server's looping effects (the map's ambient smoke, dust and fires: ET_LOOP_FX entities, present only
 * when the server allows them - zPAM's rules do not) and the muzzle flash of every shot (the weapon's
 * worldFlashEffect at the weapon's tag_flash).
 *
 * An effect is a list of elements; each element spawns `count` particles (delay, life, spawn origin
 * and angles from their ranges) whose state is a function of their age: the curves of the .efx (time
 * 0..1 over the life, times their scale; a "...Rand" curve is the other end of a random range when the
 * element's useRandom... flag is set) give the size, colour, alpha, rotation speed and velocity, the
 * position is the integral of the velocity curves (closed form: they are piecewise linear) plus the
 * gravity. Every random value comes from a hash of the event, the element and the particle, so the
 * state at a demo time is computed directly - seeking is free. Runners (FxRunner) start further
 * effects, deathfx / emitfx elements start them where a particle dies / along its path.
 * Drawn as sprites (billboards; oriented sprites and decals in the effect's frame; tails stretched
 * along the velocity), one batch per material; the blended ones tinted by the lightmap of the floor
 * under the effect (lightProbe.js); colliding elements (usePhysics) come down on the floor under them (the
 * same probe), then vanish (impactKills) or bounce (bounce) and rest. Not drawn: lights, models (debris),
 * camera shakes. */
import * as THREE from 'three';
import { fetchJSON } from './data.js';
import { loadTexture, setMap } from './mapLoader.js';

const C2 = window.C2;
const MAX_PARTICLES = 6000;
const MAX_DEPTH = 3;
const FLASH_MS = 160;                    // shots whose muzzle flash may still be visible
const EMIT_MS = 100;                     // emitfx: one effect per 100 ms of a particle's path
const MAX_EMITS = 24;
const LAND_STEP = 80;                    // ms between the samples of a colliding particle's path
const LANDINGS_PER_FRAME = 40;
const D2R = Math.PI / 180;

/* ---------- deterministic randomness ---------- */
function hash(a, b) {
  let h = (Math.imul(a ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b + 0x632BE5AB) | 0, 0xC2B2AE35)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return h >>> 0;
}
const rnd = (seed, k) => hash(seed, k) / 4294967296;
const lerp = (a, b, f) => a + (b - a) * f;

/* ---------- curves: flat [t, v, ...] (rgb: t r g b), time 0..1 ---------- */
function evalCurve(p, u, dims = 2, k = 1) {
  const n = p.length / dims;
  if (!n) return 0;
  if (u <= p[0] || n === 1) return p[k];
  for (let i = 1; i < n; i++) {
    const t1 = p[i * dims];
    if (u <= t1) {
      const t0 = p[(i - 1) * dims], v0 = p[(i - 1) * dims + k], v1 = p[i * dims + k];
      return t1 > t0 ? v0 + (v1 - v0) * (u - t0) / (t1 - t0) : v1;
    }
  }
  return p[(n - 1) * dims + k];
}
/** the integral of a curve (dims 2) from 0 to u */
function integCurve(p, u) {
  const n = p.length / 2;
  if (!n || u <= 0) return 0;
  let s = 0, tPrev = 0, vPrev = p[1];
  for (let i = 0; i < n; i++) {
    const t = p[i * 2], v = p[i * 2 + 1];
    if (t <= tPrev) { vPrev = v; continue; }
    if (u <= t) { const vu = vPrev + (v - vPrev) * (u - tPrev) / (t - tPrev); return s + (vPrev + vu) * 0.5 * (u - tPrev); }
    s += (vPrev + v) * 0.5 * (t - tPrev);
    tPrev = t; vPrev = v;
  }
  return s + vPrev * (u - tPrev);
}

/* ---------- vectors ---------- */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]); if (l > 1e-9) { v[0] /= l; v[1] /= l; v[2] /= l; } return l; }
/** a frame {f, l, u} (forward = dir) */
export function axisFromDir(dir) {
  const f = [dir[0], dir[1], dir[2]];
  if (!normalize(f)) f.splice(0, 3, 0, 0, 1);
  const ref = Math.abs(f[2]) < 0.95 ? [0, 0, 1] : [1, 0, 0];
  const l = cross(ref, f); normalize(l);
  const u = cross(f, l);
  return { f, l, u };
}
const UP = axisFromDir([0, 0, 1]);
function byteDir(b) {
  const D = C2.constants.BYTE_DIRS;
  return b != null && b >= 0 && b < D.length / 3 ? [D[b * 3], D[b * 3 + 1], D[b * 3 + 2]] : [0, 0, 1];
}

const TYPES = { Particle: 'sprite', Emitter: 'sprite', Cloud: 'sprite', OrientedParticle: 'oriented', Tail: 'tail',
  Decal: 'decal', FxRunner: 'runner' };
const range = (v, def) => (Array.isArray(v) && v.length ? [v[0], v.length > 1 ? v[1] : v[0]] : def);

/** an element of the .efx made ready for evaluation */
function prepare(el) {
  const fl = new Set(el.flags || []), sp = new Set(el.spawnFlags || []);
  const c = el.curves || {};
  const cv = name => (c[name] && c[name].p && c[name].p.length ? c[name].p : null);
  const sc = name => (c[name] && c[name].s && c[name].s.length ? [c[name].s[0], c[name].s.length > 1 ? c[name].s[1] : c[name].s[0]] : [1, 1]);
  const vel = (pre, randFlag) => ['X', 'Y', 'Z'].map(a => ({ base: cv(pre + a), rand: fl.has(randFlag) ? cv(pre + a + 'Rand') : null, scale: sc(pre + a) }));
  const count = range(el.count, [1, 1]).map(Math.round);
  return {
    type: TYPES[el.type] || null, name: el.name,
    count: [Math.min(count[0], count[1]), Math.max(count[0], count[1])],
    life: range(el.life, [1000, 1000]).sort((a, b) => a - b), delay: range(el.delay, [0, 0]).sort((a, b) => a - b),
    even: sp.has('evenDistribution'), sphere: sp.has('orgOnSphere'), cylinder: sp.has('orgOnCylinder'),
    axisFromSphere: sp.has('axisFromSphere'),
    origin: Array.isArray(el.origin) && el.origin.length >= 3 ? el.origin : null,
    radius: range(el.radius, [0, 0]), height: range(el.height, [0, 0]),
    rotation: range(el.rotation, [0, 0]), gravity: range(el.gravity, [0, 0]),
    absVel: fl.has('absoluteVel') || sp.has('absoluteVel'), absVel2: fl.has('absoluteVel2'),
    vel: vel('velocity', 'useRandomVelocity'), vel2: vel('velocity2', 'useRandomVelocity2'),
    size: cv('size'), sizeRand: fl.has('useRandomSize') ? cv('sizeRand') : null, sizeScale: sc('size'),
    size2: el.nonUniformScale && el.nonUniformScale[0] ? cv('size2') : null, size2Rand: fl.has('useRandomSize2') ? cv('size2Rand') : null, size2Scale: sc('size2'),
    length: cv('length'), lengthRand: fl.has('useRandomLength') ? cv('lengthRand') : null, lengthScale: sc('length'),
    rgb: cv('rgb'), rgbRand: fl.has('useRandomColors') ? cv('rgbRand') : null,
    alpha: cv('alpha'), alphaRand: fl.has('useRandomAlpha') ? cv('alphaRand') : null,
    rotDelta: cv('rotationDelta'), rotDeltaRand: fl.has('useRandomRotationDelta') ? cv('rotationDeltaRand') : null, rotScale: sc('rotationDelta'),
    physics: fl.has('usePhysics'), kills: fl.has('impactKills'), bounce: range(el.bounce, null),
    // the older syntax: constant velocity / acceleration ranges (min xyz, max xyz) and a rotation speed range
    velConst: Array.isArray(el.velocity) && el.velocity.length >= 3 ? (el.velocity.length >= 6 ? el.velocity : el.velocity.concat(el.velocity)) : null,
    accel: Array.isArray(el.acceleration) && el.acceleration.length >= 3 ? (el.acceleration.length >= 6 ? el.acceleration : el.acceleration.concat(el.acceleration)) : null,
    rotSpeed: Array.isArray(el.rotationDelta) && typeof el.rotationDelta[0] === 'number' ? range(el.rotationDelta) : null,
    shaders: fl.has('useModel') ? [] : (el.shaders || []),
    playfx: el.playfx || null, deathfx: el.deathfx || null, emitfx: fl.has('emitFx') ? el.emitfx || null : null,
    // the camera distance the element spawns at: one value = up to that distance
    spawnRange: (r => (Array.isArray(r) && r.length ? (r.length > 1 ? [r[0], r[1]] : [0, r[0]]) : null))(el.spawnRange || el.cullrange),
    atlasStart: el.sequenceStartFrameMode ? Number(el.sequenceStartFrameMode[0]) : 0,
    atlasFixed: el.sequenceFixedFrameValue ? el.sequenceFixedFrameValue[0] : 0,
    atlasFps: el.sequencePlayRateMode && Number(el.sequencePlayRateMode[0]) === 1 ? (el.sequenceFixedFpsValue || [0])[0] : null,
    atlasLoop: el.sequenceLoopMode ? Number(el.sequenceLoopMode[0]) === 1 : false
  };
}

export class FxPlayer {
  constructor(scene, match) {
    this.M = match;
    this.root = new THREE.Group();
    this.root.name = 'fx';
    scene.add(this.root);
    // the first-person weapon's muzzle flashes: drawn in the view model's pass, after the gun (viewmodel.js)
    this.viewRoot = new THREE.Group();
    this.viewRoot.name = 'fx view';
    this.batches = new Map();
    this.durations = new Map();
    this.events = [];
    this.landings = new Map();            // particle seed -> its landing on the floor (colliding elements)
    this.enabled = true;
    this.muzzleOf = null;                 // (client, t) -> {pos, dir} of the weapon's muzzle, set by the view
    this.cam = new THREE.Vector3();
    this.camRight = [1, 0, 0]; this.camUp = [0, 0, 1];
  }

  /** maps3d/_fx/effects.json -> true when the effects are available */
  load() {
    if (!this.ready) {
      this.ready = fetchJSON('maps3d/_fx/effects.json').then(doc => {
        this.doc = doc;
        this.defs = new Map();
        for (const [name, elems] of Object.entries(doc.effects || {})) this.defs.set(name, elems.map(prepare));
        this.buildEvents();
        return true;
      }).catch(err => { console.warn('effects not available:', err.message); return false; });
    }
    return this.ready;
  }

  def(name) { return name ? this.defs.get(String(name).toLowerCase()) || null : null; }

  /** the longest an effect is visible (ms), its runners' effects included */
  duration(name, depth = 0) {
    if (this.durations.has(name)) return this.durations.get(name);
    const def = this.def(name);
    let d = 0;
    // (no depth limit here: the value is cached per name and must not depend on where it was asked first;
    // the 0 set below ends cycles, 16 levels only guard against a runaway)
    if (def && depth < 16) {
      this.durations.set(name, 0);
      for (const e of def) {
        let x = e.delay[1] + (e.type === 'runner' ? 0 : e.life[1]);
        if (e.type === 'runner' && e.playfx) x += Math.max(...e.playfx.map(n => this.duration(n, depth + 1)));
        if (e.deathfx) x += Math.max(...e.deathfx.map(n => this.duration(n, depth + 1)));
        if (e.emitfx) x += Math.max(...e.emitfx.map(n => this.duration(n, depth + 1)));
        d = Math.max(d, x);
      }
    }
    this.durations.set(name, d);
    return d;
  }

  /** the demo's effect events, sorted by time: {name, t0, origin, axis, seed, ground} */
  buildEvents() {
    const d = this.M.d, doc = this.doc, S = C2.constants.SURFACES, EVN = C2.constants.EVENT_NAMES;
    const surf = i => S[i] || 'default';
    // the impact table, with the map's own overrides (fx/maps/mp/<map>: the exact map name, as the game)
    const own = (doc.mapImpacts || {})[String(d.meta.map || '').toLowerCase()] || {};
    const table = (type, s) => {
      for (const r of [own[type], doc.impacts[type]]) if (r && r[s] !== undefined) return r[s];
      const r = own[type] && own[type].default !== undefined ? own[type] : doc.impacts[type];
      return r ? r.default || null : null;
    };
    const out = [];
    const add = (name, t0, x, y, z, axis, seed) => {
      name = name ? String(name).toLowerCase() : null;
      if (!name || !this.def(name) || t0 == null) return;
      out.push({ name, t0, origin: [x, y, z], axis, seed: seed >>> 0, ground: axis.f[2] > 0.6 ? z - 1 : -Infinity, end: t0 + this.duration(name) });
    };
    // grenades: frag explosions by the surface hit, smoke grenades by the weapon
    (d.grenades || []).forEach((g, i) => {
      const det = g.detonation;
      if (!det) return;
      const w = doc.weapons[String(g.weapon || '').toLowerCase()];
      const name = g.kind === 'smoke' ? w && w.explode : table('grenade_explode', surf(det.surf));
      const axis = det.dir != null && !det.derived ? axisFromDir(byteDir(det.dir)) : UP;
      add(name, det.t, det.x, det.y, det.z, axis, hash(i, det.t));
    });
    // bullet impacts on the world and on players; their weapon field is empty in the demos, so the weapon
    // is the one of the player who fired in the same snapshot (when exactly one did): shotguns -> shotgun
    const shooters = new Map();
    for (const [cl, ts] of Object.entries(d.shotsSeen || {})) for (const ts1 of ts) {
      const a = shooters.get(ts1);
      if (a) a.push(+cl); else shooters.set(ts1, [+cl]);
    }
    const weaponOf = (weapon, t) => {
      if (weapon) return this.M.weaponName(weapon, t);
      const cls = shooters.get(t);
      const s = cls && cls.length === 1 ? this.M.sampleAt(cls[0], t) : null;
      return s ? this.M.weaponName(s.weapon, t) : null;
    };
    const fx3d = d.fx3d || {};
    (fx3d.impacts || []).forEach((r, i) => {
      const [t, x, y, z, dir, st, weapon, ev] = r;
      const evName = EVN[ev] || '';
      const w = weaponOf(weapon, t);
      const cls = w && doc.weapons[w.toLowerCase()] ? doc.weapons[w.toLowerCase()].class : null;
      const type = cls === 'spread' ? 'shotgun' : /_ap$/.test(evName) ? 'bullet_ap' : /large/.test(evName) ? 'bullet_large' : 'bullet_small';
      const s = /client/.test(evName) ? 'flesh' : surf(st);
      const axis = axisFromDir(byteDir(dir));
      add(table(type + '_normal', s), t, x, y, z, axis, hash(i, t + 7));
      add(table(type + '_reflect', s), t, x, y, z, axis, hash(i, t + 11));
    });
    // scripted effects (EV_PLAY_FX): the effect's config string
    const names = fx3d.effectNames || {};
    (fx3d.playFx || []).forEach((r, i) => {
      const n = names[r[4]];
      if (n) add(/\.efx$/i.test(n) ? n : n + '.efx', r[0], r[1], r[2], r[3], UP, hash(i, r[0] + 13));
    });
    out.sort((a, b) => a.t0 - b.t0);
    this.events = out;
    // the server's looping effects (playLoopedFx: the map's ambient smoke, dust, fires, when the server
    // allowed them): restarted every `delay` ms from server time 0, while the entity is in the demo
    this.loopFx = (fx3d.loopFx || []).map((r, i) => {
      const n = names[r.fx];
      const name = n ? (/\.efx$/i.test(n) ? n : n + '.efx').toLowerCase() : null;
      if (!name || !this.def(name)) return null;
      const axis = axisFromDir(r.dir && (r.dir[0] || r.dir[1] || r.dir[2]) ? r.dir : [0, 0, 1]);
      return { name, delay: Math.max(50, r.delay || 1000), origin: [r.x, r.y, r.z], axis, ground: axis.f[2] > 0.6 ? r.z - 1 : -Infinity,
        t0: r.t0, t1: r.t1, dur: this.duration(name), key: hash(i, Math.round(r.x) * 31 + Math.round(r.y)) };
    }).filter(Boolean);
    this.maxDur = out.reduce((m, e) => Math.max(m, e.end - e.t0), 0);
    // the shots, per client, for the muzzle flashes
    this.shots = Object.entries(d.shotsSeen || {}).map(([cl, ts]) => ({ cl: +cl, ts }));
  }

  batch(name, view = false) {
    const key = view ? name + '#view' : name;
    let b = this.batches.get(key);
    if (b !== undefined) return b;
    const m = this.doc.materials[name];
    b = null;
    if (m && m.texture) {
      // (one texture per file: the view flashes' batches share the world's)
      this.texCache = this.texCache || new Map();
      let tex = this.texCache.get(m.texture);
      if (!tex) {
        tex = loadTexture('maps3d/' + m.texture);
        tex.colorSpace = THREE.NoColorSpace; tex.flipY = false;
        this.texCache.set(m.texture, tex);
      }
      const add = m.blend === 'add';
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: add ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false });
      if (m.decal) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4; }
      setMap(mat, 'map', tex, 'clear');
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = add ? 7 : 6;
      (view ? this.viewRoot : this.root).add(mesh);
      b = { mesh, add, cap: 0, list: [], atlas: m.atlas || [1, 1] };
    }
    this.batches.set(key, b);
    return b;
  }

  /** draw the effects at demo time t (ms) for the camera */
  update(t, camera) {
    for (const b of this.batches.values()) if (b) b.list.length = 0;
    this.count = 0;
    this.landBudget = this.simPerFrame === Infinity ? Infinity : LANDINGS_PER_FRAME;   // (the video export: all)
    if (this.enabled && this.defs) {
      this.cam.setFromMatrixPosition(camera.matrixWorld);
      const e = camera.matrixWorld.elements;
      this.camRight = [e[0], e[1], e[2]]; this.camUp = [e[4], e[5], e[6]];
      // events alive at t (sorted by start: from the first that may still run)
      const ev = this.events;
      let lo = 0, hi = ev.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].t0 < t - this.maxDur) lo = m + 1; else hi = m; }
      for (let i = lo; i < ev.length && ev[i].t0 <= t; i++) if (ev[i].end >= t) this.effect(ev[i], t, 0);
      this.loops(t);
      this.flashes(t);
    }
    for (const b of this.batches.values()) if (b) this.upload(b);
  }

  /** the looping effects: the starts of the last `dur` ms (started before the demo too: already running) */
  loops(t) {
    for (const L of this.loopFx || []) {
      if (t < L.t0 || t > L.t1 + L.dur) continue;
      if (L.light === undefined && this.probe) {
        const o = L.origin, l = this.probe.lightAt(o[0] + L.axis.f[0] * 8, o[1] + L.axis.f[1] * 8, o[2] + L.axis.f[2] * 8);
        if (l || this.probe.ready) L.light = l;
      }
      const first = Math.ceil((t - L.dur) / L.delay), last = Math.min(Math.floor(t / L.delay), Math.floor(L.t1 / L.delay));
      for (let k = Math.max(first, last - 400); k <= last; k++) {
        this.effect({ name: L.name, t0: k * L.delay, origin: L.origin, axis: L.axis, seed: hash(L.key, k), ground: L.ground,
          light: L.light === undefined ? null : L.light }, t, 0);
      }
    }
  }

  /** muzzle flashes of the shots of the last FLASH_MS, at the muzzle as it is now */
  flashes(t) {
    if (!this.muzzleOf) return;
    for (const { cl, ts } of this.shots) {
      let lo = 0, hi = ts.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t - FLASH_MS) lo = m + 1; else hi = m; }
      for (let i = lo; i < ts.length && ts[i] <= t; i++) {
        const mz = this.muzzleOf(cl, ts[i], t);
        if (!mz || !mz.weapon) continue;
        const w = this.doc.weapons[mz.weapon.toLowerCase()];
        const name = mz.flash || (w && w.flash);          // (the first-person view: the weapon's view flash)
        if (!name || !this.def(name)) continue;
        this.effect({ name, t0: ts[i], origin: mz.pos, axis: axisFromDir(mz.dir), seed: hash(cl, ts[i]), ground: -Infinity, view: !!mz.view }, t, 0);
      }
    }
  }

  effect(inst, t, depth) {
    const def = this.def(inst.name);
    if (!def) return;
    // the map's light at the effect (lightProbe.js: the lightmap of the floor below), once per event
    if (inst.light === undefined && this.probe) {
      const o = inst.origin, l = this.probe.lightAt(o[0] + inst.axis.f[0] * 8, o[1] + inst.axis.f[1] * 8, o[2] + inst.axis.f[2] * 8);
      if (l || this.probe.ready) inst.light = l;            // (null until the lightmaps have arrived: asked again)
    }
    for (let k = 0; k < def.length; k++) this.elem(inst, def[k], k, t, depth);
  }

  elem(inst, e, k, t, depth) {
    if (e.spawnRange && e.spawnRange[1] > 0) {
      const o = inst.origin, dc = Math.hypot(this.cam.x - o[0], this.cam.y - o[1], this.cam.z - o[2]);
      if (dc < e.spawnRange[0] || dc > e.spawnRange[1]) return;
    }
    const s0 = hash(inst.seed, k * 7919 + 1);
    const n = e.count[0] + Math.floor(rnd(s0, 0) * (e.count[1] - e.count[0] + 1));
    for (let i = 0; i < n; i++) {
      if (this.count >= MAX_PARTICLES) return;
      const ps = hash(s0, i + 17);
      const delay = e.even && n > 1 ? lerp(e.delay[0], e.delay[1], i / (n - 1)) : lerp(e.delay[0], e.delay[1], rnd(ps, 1));
      const begin = inst.t0 + delay;
      if (begin > t) continue;
      const P = this.spawn(inst, e, ps);
      if (e.type === 'runner') {
        if (!e.playfx || depth >= MAX_DEPTH) continue;
        const name = e.playfx[Math.floor(rnd(ps, 30) * e.playfx.length)];
        if (t - begin > this.duration(name)) continue;
        this.effect({ name, t0: begin, origin: P.pos, axis: inst.axis, seed: hash(ps, 31), ground: inst.ground, light: inst.light }, t, depth + 1);
        continue;
      }
      const life = lerp(e.life[0], e.life[1], rnd(ps, 2));
      const age = t - begin;
      if (life <= 0) continue;
      if (depth < MAX_DEPTH) {
        if (e.deathfx && age >= life) {
          const name = e.deathfx[Math.floor(rnd(ps, 32) * e.deathfx.length)];
          if (age - life <= this.duration(name)) this.effect({ name, t0: begin + life, origin: this.position(e, P, life, life), axis: inst.axis, seed: hash(ps, 33), ground: inst.ground, light: inst.light }, t, depth + 1);
        }
        if (e.emitfx) {
          const name = e.emitfx[Math.floor(rnd(ps, 34) * e.emitfx.length)], dur = this.duration(name);
          const first = Math.max(0, Math.ceil((age - dur) / EMIT_MS)), last = Math.min(Math.floor(Math.min(age, life) / EMIT_MS), first + MAX_EMITS);
          for (let j = first; j <= last; j++) this.effect({ name, t0: begin + j * EMIT_MS, origin: this.position(e, P, j * EMIT_MS, life), axis: inst.axis, seed: hash(ps, 40 + j), ground: inst.ground, light: inst.light }, t, depth + 1);
        }
      }
      if (age >= life || !e.shaders.length) continue;
      if (e.kills) { const land = this.landing(e, P, life); if (land && age >= land.t) continue; }   // gone on impact
      const shader = e.shaders.length > 1 ? e.shaders[Math.floor(rnd(ps, 3) * e.shaders.length)] : e.shaders[0];
      const b = this.batch(shader, !!inst.view);
      if (b) this.sprite(b, inst, e, P, ps, age, life);
    }
  }

  /** a particle's spawn: world position, its velocity frame and its random factors */
  spawn(inst, e, ps) {
    const A = inst.axis, o = [0, 0, 0];
    if (e.origin) {
      const b = e.origin;
      if (b.length >= 6) for (let c = 0; c < 3; c++) o[c] = lerp(b[c], b[c + 3], rnd(ps, 4 + c));
      else for (let c = 0; c < 3; c++) o[c] = b[c];
    }
    const rad = lerp(e.radius[0], e.radius[1], rnd(ps, 7));
    if (e.sphere && rad) {
      const z = rnd(ps, 8) * 2 - 1, a = rnd(ps, 9) * Math.PI * 2, r = Math.sqrt(1 - z * z);
      o[0] += z * rad; o[1] += r * Math.cos(a) * rad; o[2] += r * Math.sin(a) * rad;
    } else if (e.cylinder) {
      const a = rnd(ps, 9) * Math.PI * 2;
      o[0] += lerp(e.height[0], e.height[1], rnd(ps, 10));
      o[1] += Math.cos(a) * rad; o[2] += Math.sin(a) * rad;
    }
    const off = [A.f[0] * o[0] + A.l[0] * o[1] + A.u[0] * o[2], A.f[1] * o[0] + A.l[1] * o[1] + A.u[1] * o[2], A.f[2] * o[0] + A.l[2] * o[1] + A.u[2] * o[2]];
    let frame = A;
    if (e.axisFromSphere) {
      const d = [off[0], off[1], off[2]];
      if (normalize(d) > 1e-3) frame = axisFromDir(d);
      else { const z = rnd(ps, 11) * 2 - 1, a = rnd(ps, 12) * Math.PI * 2, r = Math.sqrt(1 - z * z); frame = axisFromDir([r * Math.cos(a), r * Math.sin(a), z]); }
    }
    return { pos: [inst.origin[0] + off[0], inst.origin[1] + off[1], inst.origin[2] + off[2]], frame, ps, ground: inst.ground,
      g: lerp(e.gravity[0], e.gravity[1], rnd(ps, 13)) };
  }

  /** position at `age` ms: spawn + the integral of the velocity curves + gravity (stopped on the ground
   *  under the effect for usePhysics elements) */
  position(e, P, age, life) {
    const p = this.rawPosition(e, P, age, life);
    if (!e.physics) return p;
    // on the map's floor (lightProbe.js), once its landing is known; else a flat ground at the effect
    const land = this.landing(e, P, life);
    if (land) {
      if (age < land.t) return p;
      if (land.segs) {
        for (const s of land.segs) if (age < s.t1) {
          const dt = (age - s.t0) / 1000;
          return [s.p0[0] + s.v[0] * dt, s.p0[1] + s.v[1] * dt, s.p0[2] + s.v[2] * dt + 0.5 * P.g * dt * dt];
        }
        return land.rest.slice();
      }
      return land.p.slice();
    }
    if (p[2] < P.ground) {
      let lo = 0, hi = age;
      for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (this.rawPosition(e, P, m, life)[2] < P.ground) hi = m; else lo = m; }
      const q = this.rawPosition(e, P, lo, life);
      q[2] = Math.max(q[2], P.ground);
      return q;
    }
    return p;
  }

  /** where a colliding particle first comes down through the floor below it: {t (ms of its life), p}
   *  ({t: Infinity} if never), cached per particle (its path is fixed); null while not computed yet (at
   *  most LANDINGS_PER_FRAME new ones per frame) or without the map */
  landing(e, P, life) {
    if (!this.probe) return null;
    let L = this.landings.get(P.ps);
    if (L !== undefined) return L;
    if (this.landBudget <= 0) return null;
    this.landBudget--;
    L = { t: Infinity, p: null };
    let prev = this.rawPosition(e, P, 0, life), tPrev = 0;
    for (let t = LAND_STEP; tPrev < life; t += LAND_STEP) {
      const tt = Math.min(t, life), q = this.rawPosition(e, P, tt, life);
      const f = this.probe.floorAt(q[0], q[1], Math.max(prev[2], q[2]));
      if (f != null && q[2] < f && prev[2] >= f - 1) {            // came down through the floor
        let lo = tPrev, hi = tt;
        for (let k = 0; k < 7; k++) {
          const m = (lo + hi) / 2, r = this.rawPosition(e, P, m, life), fm = this.probe.floorAt(r[0], r[1], r[2] + 8);
          if (fm != null && r[2] < fm) hi = m; else lo = m;
        }
        const r = this.rawPosition(e, P, hi, life);
        const fr = this.probe.floorAt(r[0], r[1], r[2] + 8);
        L = { t: hi, p: [r[0], r[1], (fr != null ? fr : f) + 0.5] };
        if (e.bounce && !e.kills) this.bounces(e, P, life, L);
        break;
      }
      prev = q; tPrev = tt;
    }
    if (this.landings.size > 50000) this.landings.clear();
    this.landings.set(P.ps, L);
    return L;
  }

  /** the hops after the first impact (efx "bounce": the share of the speed kept, a random range): the
   *  velocity just before it reflected off the floor (taken as level), then ballistic arcs under the
   *  element's gravity, each landing on the floor height under it; at rest once the rebound is slow */
  bounces(e, P, life, L) {
    const k = lerp(e.bounce[0], e.bounce[1], rnd(P.ps, 70)), g = P.g;
    if (!(k > 0) || !(g < 0)) return;
    const a = this.rawPosition(e, P, Math.max(0, L.t - 8), life), b = this.rawPosition(e, P, L.t, life);
    let v = [(b[0] - a[0]) / 0.008, (b[1] - a[1]) / 0.008, (b[2] - a[2]) / 0.008];
    let t0 = L.t, p0 = L.p.slice();
    L.segs = [];
    for (let n = 0; n < 3; n++) {
      v = [v[0] * k, v[1] * k, -v[2] * k];
      if (v[2] < 30) break;
      const flight = -2 * v[2] / g;                             // s until back at the launch height
      const t1 = t0 + flight * 1000;
      L.segs.push({ t0, t1, p0, v: v.slice() });
      if (t1 >= life) break;
      const x = p0[0] + v[0] * flight, y = p0[1] + v[1] * flight;
      const fz = this.probe.floorAt(x, y, p0[2] + 8);
      p0 = [x, y, (fz != null ? fz : p0[2] - 0.5) + 0.5];
      v = [v[0], v[1], -v[2]];
      t0 = t1;
    }
    L.rest = p0;
  }

  rawPosition(e, P, age, life) {
    const u = Math.min(1, age / life), ls = life / 1000, out = [P.pos[0], P.pos[1], P.pos[2]];
    const add = (vel, abs, k0) => {
      const L = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const v = vel[c];
        if (!v.base) continue;
        let I = integCurve(v.base, u);
        if (v.rand) I = lerp(I, integCurve(v.rand, u), rnd(P.ps, k0 + c));
        L[c] = I * lerp(v.scale[0], v.scale[1], rnd(P.ps, k0 + 3 + c)) * ls;
      }
      if (abs) { out[0] += L[0]; out[1] += L[1]; out[2] += L[2]; return; }
      const F = P.frame;
      for (let c = 0; c < 3; c++) out[c] += F.f[c] * L[0] + F.l[c] * L[1] + F.u[c] * L[2];
    };
    add(e.vel, e.absVel, 14);
    add(e.vel2, e.absVel2, 20);
    const s = Math.min(age, life) / 1000;
    if (e.velConst || e.accel) {
      const L = [0, 0, 0], F = P.frame;
      for (let c = 0; c < 3; c++) {
        if (e.velConst) L[c] += lerp(e.velConst[c], e.velConst[c + 3], rnd(P.ps, 26 + c)) * s;
        if (e.accel) L[c] += 0.5 * lerp(e.accel[c], e.accel[c + 3], rnd(P.ps, 29 + c)) * s * s;
      }
      for (let c = 0; c < 3; c++) out[c] += F.f[c] * L[0] + F.l[c] * L[1] + F.u[c] * L[2];
    }
    out[2] += 0.5 * P.g * s * s;
    return out;
  }

  sprite(b, inst, e, P, ps, age, life) {
    const u = age / life;
    const pick = (base, rand, key, dims = 2, k = 1) => {
      let v = base ? evalCurve(base, u, dims, k) : 1;
      if (rand) v = lerp(v, evalCurve(rand, u, dims, k), rnd(ps, key));
      return v;
    };
    let alpha = e.alpha ? pick(e.alpha, e.alphaRand, 50) : 1;
    if (alpha <= 0.004) return;
    const col = e.rgb ? [1, 2, 3].map(k => pick(e.rgb, e.rgbRand, 51, 4, k)) : [1, 1, 1];
    // blended sprites and decals take the map's light (smoke at night is dark); additive ones glow
    if (!b.add && inst.light) for (let c = 0; c < 3; c++) col[c] *= Math.min(1, Math.max(0.1, inst.light[c]));
    const w = (e.size ? pick(e.size, e.sizeRand, 52) : 1) * lerp(e.sizeScale[0], e.sizeScale[1], rnd(ps, 53));
    const h = e.size2 ? pick(e.size2, e.size2Rand, 54) * lerp(e.size2Scale[0], e.size2Scale[1], rnd(ps, 55)) : w;
    if (w <= 0.05 && h <= 0.05) return;
    let rot = lerp(e.rotation[0], e.rotation[1], rnd(ps, 56));
    if (e.rotDelta) {
      let I = integCurve(e.rotDelta, u);
      if (e.rotDeltaRand) I = lerp(I, integCurve(e.rotDeltaRand, u), rnd(ps, 57));
      rot += I * e.rotScale[0] * life / 1000;                         // degrees per second
    }
    if (e.rotSpeed) rot += lerp(e.rotSpeed[0], e.rotSpeed[1], rnd(ps, 57)) * age / 1000;
    rot *= D2R;
    let pos = this.position(e, P, age, life), tan, bin, half = [w, h];
    if (e.type === 'oriented' || e.type === 'decal') {
      const A = e.type === 'decal' ? inst.axis : P.frame;
      tan = A.l; bin = A.u;
      if (e.type === 'decal') pos = [pos[0] + A.f[0] * 0.5, pos[1] + A.f[1] * 0.5, pos[2] + A.f[2] * 0.5];
    } else if (e.type === 'tail') {
      const p0 = this.position(e, P, Math.max(0, age - 16), life);
      const v = [pos[0] - p0[0], pos[1] - p0[1], pos[2] - p0[2]];
      if (!normalize(v)) return;
      const len = (e.length ? pick(e.length, e.lengthRand, 58) : 1) * lerp(e.lengthScale[0], e.lengthScale[1], rnd(ps, 59));
      pos = [pos[0] - v[0] * len * 0.5, pos[1] - v[1] * len * 0.5, pos[2] - v[2] * len * 0.5];
      const dc = [this.cam.x - pos[0], this.cam.y - pos[1], this.cam.z - pos[2]];
      tan = cross(v, dc); if (!normalize(tan)) return;
      bin = v; half = [w, Math.max(len * 0.5, w)]; rot = 0;
    } else { tan = this.camRight; bin = this.camUp; }
    const c = Math.cos(rot), s = Math.sin(rot);
    const rt = [c * tan[0] + s * bin[0], c * tan[1] + s * bin[1], c * tan[2] + s * bin[2]];
    const rb = [s * tan[0] - c * bin[0], s * tan[1] - c * bin[1], s * tan[2] - c * bin[2]];
    // the atlas frame
    let uv = [0, 0, 1, 1];
    const [cols, rows] = b.atlas, nf = cols * rows;
    if (nf > 1) {
      let idx = e.atlasStart === 0 ? Math.floor(e.atlasFixed) : Math.floor(rnd(ps, 60) * nf);
      if (e.atlasFps != null) idx += Math.floor(e.atlasFps * age / 1000);
      else idx += Math.floor(nf * u);
      idx = e.atlasLoop ? ((idx % nf) + nf) % nf : Math.min(idx, nf - 1);
      uv = [(idx % cols) / cols, Math.floor(idx / cols) / rows, 1 / cols, 1 / rows];
    }
    const d2 = (pos[0] - this.cam.x) ** 2 + (pos[1] - this.cam.y) ** 2 + (pos[2] - this.cam.z) ** 2;
    b.list.push({ p: pos, rt, rb, s0: half[0], s1: half[1], uv, col: [col[0], col[1], col[2], Math.min(1, alpha)], d2 });
    this.count++;
  }

  upload(b) {
    const list = b.list;
    if (!b.add) list.sort((x, y) => y.d2 - x.d2);                    // blended sprites back to front
    const n = list.length;
    const geo = b.mesh.geometry;
    b.mesh.visible = n > 0;
    if (!n) return;
    if (n > b.cap) {
      // a new geometry: WebGL buffers keep their size (three.js cannot grow an uploaded attribute)
      if (b.cap) { geo.dispose(); b.mesh.geometry = new THREE.BufferGeometry(); b.cap = 0; return this.upload(b); }
      b.cap = Math.max(64, Math.ceil(n * 1.5));
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.cap * 8), 2).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.cap * 16), 4).setUsage(THREE.DynamicDrawUsage));
      const idx = new Uint32Array(b.cap * 6);
      for (let i = 0; i < b.cap; i++) idx.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 2, 4 * i + 3, 4 * i], 6 * i);
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    const P = geo.attributes.position.array, U = geo.attributes.uv.array, C = geo.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const q = list[i], o = 12 * i, rt = q.rt, rb = q.rb;
      for (let k = 0; k < 3; k++) {
        const l = rt[k] * q.s0, u = rb[k] * q.s1;
        P[o + k] = q.p[k] - l + u; P[o + 3 + k] = q.p[k] - l - u; P[o + 6 + k] = q.p[k] + l - u; P[o + 9 + k] = q.p[k] + l + u;
      }
      const [s0, t0, ds, dt] = q.uv;
      U.set([s0, t0 + dt, s0, t0, s0 + ds, t0, s0 + ds, t0 + dt], 8 * i);
      for (let v = 0; v < 4; v++) C.set(q.col, 16 * i + 4 * v);
    }
    geo.setDrawRange(0, n * 6);
    geo.attributes.position.needsUpdate = true; geo.attributes.uv.needsUpdate = true; geo.attributes.color.needsUpdate = true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) for (const b of this.batches.values()) if (b) b.mesh.visible = false;
  }

  dispose() {
    for (const b of this.batches.values()) if (b) { b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
    this.root.removeFromParent();
  }
}
