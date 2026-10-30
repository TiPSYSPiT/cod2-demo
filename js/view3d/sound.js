/* The game's sounds in the 3D view, heard at the camera.
 *
 * maps3d/_sound/aliases.json (tools/export/sound_export.py) holds CoD2's sound aliases: per alias its
 * variants {f: file, v: volume range, p: pitch range, d: [dist_min, dist_max], pr: probability,
 * ls: loadspec, sec: secondary alias, loop, ch: channel}; zPAM's redefinitions of stock aliases (mods.zpam,
 * used for zPAM demos: its silent weap_raise - zPAM plays the switch sound from the server); and per weapon
 * the sound fields of its weapon file. The demo's sounds come from DemoData.sounds3d (collect.js / build.js):
 *   events [t, name, x, y, z, entity] - name an alias, or 'weapon:<weapon>[:<key>]' for a weapon's own sound
 *          (WSND: fire, last shot, reload, rechamber, raise / put away, pin, throw, melee), chosen as
 *          CG_EntityEvent / CG_FireWeapon choose it;
 *   local  [{t, name}] - the recording player's local sounds (announcer, hit marker, breathing);
 *   loops  [[t0, t1, name, x, y, z, entity]] - an entity's loopSound (planted bomb, MG firing, map fires);
 *   whiz   [[t, sx, sy, sz, ix, iy, iz, shooter]] - a bullet from the shooter's eye to its impact, for the
 *          near-miss whizby (CG_WhizbySound: within 140 units of the listener, 64+ units from the muzzle).
 * The sounds of the player watched in first person are his own: the game's player variants (fireSoundPlayer,
 * step_run_plr_*, gear_rattle_plr_* ...), played at the listener (CG_PlayEntitySoundAlias for the local
 * client). An alias variant loads on this map by the engine's loadspec rule (Com_LoadSoundAliases: the
 * tokens name the map's BSP or all_mp; a leading "!" makes the list an exclusion). While the replay plays
 * forward every event between two frames is played: one variant by probability, its random volume and
 * pitch, attenuated from dist_min to dist_max along the alias's volume falloff curve (SND_Attenuate: the
 * soundaliases/*.vfcurve points, linear between them - weapon1 for footsteps, weapon2 for bullet impacts ...;
 * without one a straight line) and
 * panned left / right by the camera. A seek, a pause or a speed over MAX_SPEED cuts the sounds (short fade)
 * and nothing skipped is caught up; up to MAX_SPEED the pitch follows the speed.
 * The 3D video export renders a range offline for the frames' camera path (render: OfflineAudioContext
 * -> AudioBuffer for the MP4's audio track) or records the live sound (capture, the WebM fallback). */
import { audioContext, DEFAULT_VOLUME } from '../app/audio.js';

const BASE = 'maps3d/_sound/';
const MAX_VOICES = 48;
export const MAX_SPEED = 2;      // faster: silent (every sound would play an octave up and pile up)
const FADE = 0.04;               // s, the fade of a cut
const FETCHES = 8;               // sound files downloaded at a time
const WHIZ_RANGE = 140, WHIZ_MIN = 64, WHIZ_BACK = 16;
let tablePromise = null;

// a weapon's sound by event key (lower case, as the event names): [the watched player's own chain, everybody else's chain, default alias]
// (CG_EntityEvent / CG_FireWeapon: the first field the weapon file sets)
const WSND = {
  fire: [['fireSoundPlayer', 'fireSound'], ['fireSound']],
  last: [['lastShotSoundPlayer', 'lastShotSound', 'fireSoundPlayer', 'fireSound'], ['lastShotSound', 'fireSound']],
  reload: [['reloadSoundPlayer', 'reloadEmptySoundPlayer', 'reloadSound', 'reloadEmptySound'], ['reloadSound', 'reloadEmptySound']],
  reloadempty: [['reloadEmptySoundPlayer', 'reloadSoundPlayer', 'reloadEmptySound', 'reloadSound'], ['reloadEmptySound', 'reloadSound']],
  reloadstart: [['reloadStartSoundPlayer', 'reloadStartSound'], ['reloadStartSound']],
  reloadend: [['reloadEndSoundPlayer', 'reloadEndSound'], ['reloadEndSound']],
  rechamber: [['rechamberSoundPlayer', 'rechamberSound'], ['rechamberSound']],
  raise: [['raiseSound'], ['raiseSound'], 'weap_raise'],
  putaway: [['putawaySound'], ['putawaySound'], 'weap_putaway'],
  alt: [['altSwitchSound'], ['altSwitchSound']],
  pullback: [['pullbackSound'], ['pullbackSound']],
  throw: [['fireSound'], ['fireSound']],
  melee: [['meleeSwipeSound'], ['meleeSwipeSound']],
  pickup: [['pickupSound'], ['pickupSound']],
  ammopickup: [['ammoPickupSound'], ['ammoPickupSound']]
};
// the watched player's own movement sounds (CG_EntityEvent: the _plr tables for the local client)
const PLR = /^(step_run|step_walk|step_prone|land)_([a-z]+)$/;
const PLR_GEAR = { gear_rattle_run: 'gear_rattle_plr_run', gear_rattle_walk: 'gear_rattle_plr_walk' };

/** the listener of a camera: position and right vector (stereo panning) */
export function listenerOf(camera, fallback = null) {
  if (!camera) return fallback || { pos: [0, 0, 0], right: [1, 0, 0] };
  camera.updateMatrixWorld();
  const m = camera.matrixWorld.elements;
  return { pos: [m[12], m[13], m[14]], right: [m[0], m[1], m[2]] };
}

const rand = (a, b) => a + Math.random() * (b - a);
const ub = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };

/** the value of a falloff curve (points [[fraction, volume], ...]) at fraction x (GraphGetValueFromFraction) */
function curveAt(pts, x) {
  if (!pts || pts.length < 2) return 1 - x;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / Math.max(1e-6, b[0] - a[0]); }
  }
  return pts[pts.length - 1][1];
}

/** the whizby of bullet w for listener L -> its position, or null (CG_WhizbySound) */
export function whizbyAt(w, L) {
  let dx = w[4] - w[1], dy = w[5] - w[2], dz = w[6] - w[3];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1) return null;
  dx /= len; dy /= len; dz /= len;
  const along = (L.pos[0] - w[1]) * dx + (L.pos[1] - w[2]) * dy + (L.pos[2] - w[3]) * dz;
  if (along < WHIZ_MIN || along + WHIZ_MIN > len) return null;
  const px = w[1] + dx * along, py = w[2] + dy * along, pz = w[3] + dz * along;
  if (Math.hypot(px - L.pos[0], py - L.pos[1], pz - L.pos[2]) > WHIZ_RANGE) return null;
  return [px - dx * WHIZ_BACK, py - dy * WHIZ_BACK, pz - dz * WHIZ_BACK];
}

export class SoundSystem {
  /** -> SoundSystem, or null when no sounds are exported */
  static async load(mapName) {
    if (!tablePromise) tablePromise = fetch(BASE + 'aliases.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    const table = await tablePromise;
    return table && table.aliases ? new SoundSystem(table, mapName) : null;
  }

  constructor(table, mapName) {
    this.table = table;
    this.bsp = String(mapName || '').toLowerCase();
    this.mod = null;                   // 'zpam': zPAM's alias redefinitions apply
    this.enabled = false;
    this.volume = DEFAULT_VOLUME;
    this.ctx = null;
    this.buffers = new Map();          // file -> Promise<AudioBuffer|null>
    this.ready = new Map();            // file -> AudioBuffer (decoded)
    this.voices = 0;
    this.sources = new Map();          // the playing sources -> their gain (cut)
    this.loopsOn = new Map();          // loop index -> {src, g, p, v, vol}
    this.lastT = null;
    this.seeks = null;
    this.events = []; this.local = []; this.loops = []; this.whiz = []; this.holds = [];
    this.duck = null;                  // the channel volumes while the watched player holds his breath (or null)
  }

  setDemo(match) {
    const s = match.d.sounds3d || {};
    this.events = s.events || [];
    this.local = s.local || [];
    this.loops = s.loops || [];
    this.whiz = s.whiz || [];
    this.holds = s.holds || [];
    this.mod = match.d.meta && match.d.meta.zpamVersion ? 'zpam' : null;
    this.times = Float64Array.from(this.events, e => e[0]);
    this.localTimes = Float64Array.from(this.local, e => e.t);
    this.whizTimes = Float64Array.from(this.whiz, e => e[0]);
  }

  /** audio on / off (the browsers start audio only after a click) -> enabled */
  enable(on) {
    if (on && !this.ctx) {
      // (the page's context - audio.js: started by the click that loaded the demo)
      this.ctx = audioContext();
      if (!this.ctx) return false;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.preload();
    }
    this.enabled = !!on && !!this.ctx;
    if (!this.enabled) this.stopAll();
    if (this.ctx) { if (this.enabled) this.ctx.resume().catch(() => {}); else this.ctx.suspend().catch(() => {}); }
    this.lastT = null;
    return this.enabled;
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** loadspec spec loads on this map (Com_LoadSoundAliases) */
  loads(spec) {
    const s = String(spec || '').trim().toLowerCase();
    if (!s) return true;
    const hit = s.split(/\s+/).some(x => { x = x.replace(/^!/, ''); return x === this.bsp || x === 'all_mp'; });
    return s[0] === '!' ? !hit : hit;
  }

  /** the alias a sound event plays (own: of the player watched in first person) -> name or null */
  resolve(name, own) {
    if (name.startsWith('weapon:')) {
      const [, weapon, key = 'fire'] = name.split(':');
      const w = this.table.weapons[weapon] || {}, k = WSND[key];
      if (!k) return null;
      for (const f of own ? k[0] : k[1]) if (w[f]) return w[f];
      return k[2] || null;
    }
    if (own) {
      if (PLR_GEAR[name]) return PLR_GEAR[name];
      const m = PLR.exec(name);
      if (m && m[2] !== 'damage') return m[1] + '_plr_' + m[2];
    }
    return name;
  }

  /** the variants of an alias valid on this map, zPAM's redefinition first */
  variants(name) {
    if (!name) return null;
    const mod = this.mod && this.table.mods && this.table.mods[this.mod];
    const list = mod && Object.prototype.hasOwnProperty.call(mod, name) ? mod[name] : this.table.aliases[name];
    if (!list) return null;
    const ok = list.filter(v => this.loads(v.ls));
    return ok.length ? ok : null;
  }

  /** file -> Promise<AudioBuffer|null>; at most FETCHES downloads at a time (the preload asks for hundreds),
   *  a failed one is asked again on its next play */
  buffer(file) {
    if (!this.buffers.has(file)) {
      const p = this.fetchSlot().then(release => fetch(BASE + file).then(r => (r.ok ? r.arrayBuffer() : null)).finally(release))
        .then(b => (b ? this.decoder().decodeAudioData(b) : null))
        .then(buf => { if (buf) this.ready.set(file, buf); else this.buffers.delete(file); return buf; })
        .catch(() => { this.buffers.delete(file); return null; });
      this.buffers.set(file, p);
    }
    return this.buffers.get(file);
  }
  fetchSlot() {
    this.slots = this.slots || { busy: 0, wait: [] };
    const S = this.slots;
    const release = () => { S.busy--; const next = S.wait.shift(); if (next) next(); };
    return new Promise(res => {
      const go = () => { S.busy++; res(release); };
      if (S.busy < FETCHES) go(); else S.wait.push(go);
    });
  }

  /** a context to decode with: the live one, else (the export without live sound) an offline one */
  decoder() {
    if (this.ctx) return this.ctx;
    if (!this.dctx) this.dctx = new OfflineAudioContext(1, 1, 48000);
    return this.dctx;
  }

  /** one variant of an alias by its probability */
  pick(list) {
    let total = 0;
    for (const v of list) total += v.pr || 1;
    let r = Math.random() * total, v = list[0];
    for (const x of list) { r -= x.pr || 1; if (r <= 0) { v = x; break; } }
    return v;
  }

  /** the length of an alias's (first) sound in ms, 0 until it is decoded */
  lengthOf(name) {
    const list = this.variants(name), buf = list && this.ready.get(list[0].f);
    return buf ? buf.duration * 1000 / ((list[0].p[0] + list[0].p[1]) / 2) : 0;
  }

  /** the distance gain and pan of variant v at pos for listener L (pos null: at the listener) -> [gain, pan] or null */
  place(v, pos, L) {
    let gain = 1, pan = 0;
    if (pos && L) {
      const dx = pos[0] - L.pos[0], dy = pos[1] - L.pos[1], dz = pos[2] - L.pos[2];
      const d = Math.hypot(dx, dy, dz);
      const [d0, d1] = v.d;
      if (d > d1) return null;
      if (d > d0) gain = Math.max(0, curveAt(v.fc && this.table.curves ? this.table.curves[v.fc] : null, (d - d0) / Math.max(1, d1 - d0)));
      if (d > 1) pan = Math.max(-1, Math.min(1, (dx * L.right[0] + dy * L.right[1] + dz * L.right[2]) / d));
    }
    return [gain, pan * 0.8];
  }
  /** a random volume of variant v at pos -> [gain, pan] or null (too quiet / too far) */
  mix(v, pos, L) {
    const p = this.place(v, pos, L);
    if (!p) return null;
    p[0] *= rand(v.v[0], v.v[1]);
    return p[0] < 0.005 ? null : p;
  }

  /** every alias the demo can play (both variants of a player's own sounds), with the secondary aliases */
  aliasNames() {
    const out = new Set(), add = n => {
      if (!n || out.has(n)) return;
      out.add(n);
      for (const v of this.variants(n) || []) if (v.sec) add(v.sec);
    };
    for (const e of this.events) { add(this.resolve(e[1], false)); add(this.resolve(e[1], true)); }
    for (const l of this.local) add(l.name);
    for (const l of this.loops) add(l[2]);
    if (this.whiz.length) add('whizby');
    return out;
  }
  /** decode the files of every alias the demo plays */
  preload() { for (const n of this.aliasNames()) for (const v of this.variants(n) || []) this.buffer(v.f); }

  /** the channel volumes at t while client fp holds his breath (CG_AddPlayerWeapon: hold_breath.shock's
   *  cg_shock_volume_<channel>, faded in by DiffTrack at player_breath_snd_lerp 2 / s; back at once on letting go)
   *  -> {channel: factor} or null */
  duckAt(t, fp) {
    const V = this.table && this.table.holdBreath;
    if (fp == null || !V || !this.holds.length) return null;
    let lo = 0, hi = this.holds.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.holds[m][0] <= t) lo = m + 1; else hi = m; }
    const h = lo > 0 ? this.holds[lo - 1] : null;
    if (!h || t >= h[1] || h[2] !== fp) return null;
    const f = 1 - Math.exp(-2 * (t - h[0]) / 1000), out = {};
    for (const [ch, vol] of Object.entries(V)) out[ch] = (vol - 1) * f + 1;
    return out;
  }
  duckOf(v, duck = this.duck) { return duck && duck[v.ch] != null ? duck[v.ch] : 1; }

  /** play alias `name` at pos (null = at the listener, unattenuated) */
  play(name, pos, L, rate, depth = 0) {
    const list = this.variants(name);
    if (!list || this.voices >= MAX_VOICES) return;
    const v = this.pick(list);
    const buf = this.ready.get(v.f);
    if (!buf) { this.buffer(v.f); return; }
    const m = this.mix(v, pos, L);
    if (m) {
      const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf;
      src.playbackRate.value = rand(v.p[0], v.p[1]) * rate;
      g.gain.value = m[0] * this.duckOf(v);
      let node = g;
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = m[1]; g.connect(p); node = p; }
      node.connect(this.master);
      src.connect(g);
      this.voices++;
      this.sources.set(src, g);
      src.onended = () => { this.voices--; this.sources.delete(src); g.disconnect(); };
      src.start();
    }
    if (v.sec && depth < 2) this.play(v.sec, pos, L, rate, depth + 1);
  }

  /** the entity loops at time t: start, follow the listener, stop (live) */
  updateLoops(t, L, fp, on) {
    for (let i = 0; i < this.loops.length; i++) {
      const l = this.loops[i];
      // (a local loop of the watched player only: the heartbeat, after the breath-in)
      const active = on && t >= l[0] + (l[8] ? this.lengthOf(l[8]) : 0) && t < l[1] && (!l[7] || l[6] === fp);
      let s = this.loopsOn.get(i);
      if (!active) { if (s) this.stopLoop(i); continue; }
      const pos = fp != null && l[6] === fp ? null : [l[3], l[4], l[5]];
      if (!s) {
        const list = this.variants(l[2]);
        if (!list) continue;
        const v = this.pick(list), buf = this.ready.get(v.f);
        if (!buf) { this.buffer(v.f); continue; }
        const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = (v.p[0] + v.p[1]) / 2;
        g.gain.value = 0;
        src.connect(g).connect(p).connect(this.master);
        src.start(0, Math.random() * buf.duration);
        s = { src, g, p, v, vol: (v.v[0] + v.v[1]) / 2 };
        this.loopsOn.set(i, s);
      }
      const m = this.place(s.v, pos, L) || [0, 0];
      s.g.gain.setTargetAtTime(m[0] * s.vol * this.duckOf(s.v), this.ctx.currentTime, 0.03);
      s.p.pan.setTargetAtTime(m[1], this.ctx.currentTime, 0.03);
    }
  }
  stopLoop(i) {
    const s = this.loopsOn.get(i);
    if (!s) return;
    this.loopsOn.delete(i);
    const now = this.ctx.currentTime;
    try { s.g.gain.cancelScheduledValues(now); s.g.gain.setValueAtTime(s.g.gain.value, now); s.g.gain.linearRampToValueAtTime(0, now + FADE); s.src.stop(now + FADE); } catch (err) { /* stopped */ }
    s.src.onended = () => s.g.disconnect();
  }

  /** the sounds of (last frame, t] at the camera; pb: the playback (playing, speed, seeks); fp: the client
   *  watched in first person (his own sounds) */
  update(t, camera, pb, fp = null) {
    if (!this.enabled || !this.ctx) { this.lastT = t; return; }
    const last = this.lastT, seeks = pb.seeks || 0;
    this.lastT = t;
    const cut = this.seeks != null && seeks !== this.seeks;
    this.seeks = seeks;
    const on = pb.playing && (pb.speed || 1) <= MAX_SPEED;
    const L = listenerOf(camera);
    if (cut || !on || last == null || t < last || t - last > 1500) {
      // a seek, a pause, too fast or a jump: what rings is cut, nothing skipped is caught up
      if (this.sources.size || this.loopsOn.size) this.stopAll();
      return;
    }
    this.duck = this.duckAt(t, fp);
    if (t === last) { this.updateLoops(t, L, fp, true); return; }
    const rate = Math.max(0.5, Math.min(MAX_SPEED, pb.speed || 1));
    for (let i = ub(this.times, last), n = ub(this.times, t); i < n; i++) {
      const e = this.events[i], own = fp != null && e[5] === fp;
      if (e[6] && !own) continue;                              // (the watched player's own local sound)
      this.play(this.resolve(e[1], own), own ? null : [e[2], e[3], e[4]], L, rate);
    }
    for (let i = ub(this.localTimes, last), n = ub(this.localTimes, t); i < n; i++) this.play(this.local[i].name, null, null, rate);
    for (let i = ub(this.whizTimes, last), n = ub(this.whizTimes, t); i < n; i++) {
      const w = this.whiz[i];
      if (w[7] === fp) continue;
      const p = whizbyAt(w, L);
      if (p) this.play('whizby', p, L, rate);
    }
    this.updateLoops(t, L, fp, true);
  }

  /** cut every sound (a short fade) */
  stopAll() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const [s, g] of this.sources) {
      try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + FADE); s.stop(now + FADE); } catch (err) { /* stopped */ }
    }
    this.sources.clear();
    for (const i of [...this.loopsOn.keys()]) this.stopLoop(i);
  }

  /** the live sound into a recording instead of the speakers (the WebM export) -> {track, release} */
  capture() {
    if (!this.ctx || !this.master || !this.ctx.createMediaStreamDestination) return null;
    const dest = this.ctx.createMediaStreamDestination(), master = this.master, ctx = this.ctx;
    master.disconnect();
    master.connect(dest);
    return { track: dest.stream.getAudioTracks()[0], release: () => {
      try { master.disconnect(); } catch (err) { /* not connected */ }
      master.connect(ctx.destination);
    } };
  }

  /** the sound of an exported range: times = the demo time of each video frame, fps, speed, path = the
   *  camera of each frame [{pos, right}], fp = the client in first person per frame (or null) -> AudioBuffer
   *  (stereo, 48 kHz) of the video's length; silent above MAX_SPEED, as the live sound */
  async render({ times, fps, speed, path, fp = [], rate = 48000, onProgress = null }) {
    const n = times.length;
    if (!n) return null;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(n / fps * rate)), rate);
    if (speed > MAX_SPEED) return ctx.startRendering();
    const out = ctx.createGain();
    out.gain.value = 0.55;                                    // (many sounds overlap: no clipping)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.12;
    out.connect(comp).connect(ctx.destination);
    const step = speed * 1000 / fps;
    // demo time -> video time (s), null inside a skipped stretch
    const videoTime = t => {
      if (t < times[0]) return (t - times[0]) / speed / 1000;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; }
      const gap = t - times[lo];
      if (gap > step * 1.5 && lo < n - 1) return null;
      return (lo + gap / step) / fps;
    };
    const frame = vt => Math.max(0, Math.min(n - 1, Math.floor(vt * fps)));
    const L = vt => path[frame(vt)] || path[path.length - 1];
    const fpAt = vt => (fp[frame(Math.max(0, vt))] != null ? fp[frame(Math.max(0, vt))] : null);
    // the sounds of the range (from 2 s before: a long one may reach into it), one variant each
    const plans = [];
    const add = (name, pos, vt, depth = 0) => {
      const list = this.variants(name);
      if (!list) return;
      const v = this.pick(list);
      const m = this.mix(v, pos, pos ? L(Math.max(0, vt)) : null);
      if (m) m[0] *= this.duckOf(v, this.duckAt(times[frame(Math.max(0, vt))], fpAt(vt)));
      if (m) plans.push({ v, m, vt, pitch: rand(v.p[0], v.p[1]) });
      if (v.sec && depth < 2) add(v.sec, pos, vt, depth + 1);
    };
    const t0 = times[0] - 2000, t1 = times[n - 1];
    for (const e of this.events) {
      if (e[0] < t0) continue;
      if (e[0] > t1) break;
      const vt = videoTime(e[0]);
      if (vt == null) continue;
      const own = e[5] === fpAt(vt);
      if (e[6] && !own) continue;
      add(this.resolve(e[1], own), own ? null : [e[2], e[3], e[4]], vt);
    }
    for (const l of this.local) {
      if (l.t < t0) continue;
      if (l.t > t1) break;
      const vt = videoTime(l.t);
      if (vt != null) add(l.name, null, vt);
    }
    for (const w of this.whiz) {
      if (w[0] < times[0]) continue;
      if (w[0] > t1) break;
      const vt = videoTime(w[0]);
      if (vt == null || w[7] === fpAt(vt)) continue;
      const p = whizbyAt(w, L(vt));
      if (p) add('whizby', p, vt);
    }
    // the loops: from where they start (or the range's start) to where they end, at the listener of their start
    const loops = [];
    for (const l of this.loops) {
      const l0 = l[0] + (l[8] ? this.lengthOf(l[8]) : 0);
      if (l[1] <= times[0] || l0 > t1 || l0 >= l[1]) continue;
      if (l[7] && l[6] !== fpAt(videoTime(Math.max(l0, times[0])) || 0)) continue;
      const a = videoTime(Math.max(l0, times[0])), b = l[1] > t1 ? n / fps : videoTime(l[1]);
      if (a == null || b == null || b <= a) continue;
      const list = this.variants(l[2]);
      if (!list) continue;
      const v = this.pick(list), own = l[6] === fpAt(a);
      const m = this.place(v, own ? null : [l[3], l[4], l[5]], L(a));
      if (m && m[0] > 0.005) loops.push({ v, a, b, m: [m[0] * (v.v[0] + v.v[1]) / 2, m[1]] });
    }
    const files = [...new Set(plans.map(p => p.v.f).concat(loops.map(l => l.v.f)))];
    let done = 0;
    await Promise.all(files.map(f => this.buffer(f).then(() => { done++; if (onProgress) onProgress(done / files.length); })));
    const voice = (buf, r, gain, pan) => {
      const src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
      src.buffer = buf;
      src.playbackRate.value = r;
      g.gain.value = gain;
      p.pan.value = pan;
      src.connect(g).connect(p).connect(out);
      return src;
    };
    for (const p of plans) {
      const buf = this.ready.get(p.v.f);
      if (!buf) continue;
      const r = p.pitch * speed, dur = buf.duration / r;
      if (p.vt + dur <= 0) continue;
      voice(buf, r, p.m[0], p.m[1]).start(Math.max(0, p.vt), p.vt < 0 ? -p.vt * r : 0);
    }
    for (const l of loops) {
      const buf = this.ready.get(l.v.f);
      if (!buf) continue;
      const src = voice(buf, (l.v.p[0] + l.v.p[1]) / 2 * speed, l.m[0], l.m[1]);
      src.loop = true;
      src.start(l.a, Math.random() * buf.duration);
      src.stop(l.b);
    }
    return ctx.startRendering();
  }

  dispose() { this.stopAll(); if (this.master) this.master.disconnect(); this.master = null; this.ctx = null; this.enabled = false; }
}
