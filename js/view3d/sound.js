/* The game's sounds in the 3D view, heard at the camera.
 *
 * maps3d/_sound/aliases.json (tools/export/sound_export.py) holds CoD2's sound aliases: per alias its
 * variants {f: file, v: volume range, p: pitch range, d: [dist_min, dist_max], pr: probability,
 * ls: loadspec, sec: secondary alias}; and per weapon its fireSound. The demo's sounds come from
 * DemoData.sounds3d (collect.js / build.js): shots, footsteps, landings, melee, explosions, bullet
 * impacts and the server's sound alias events at their positions, plus the recording player's local
 * sounds (announcer, hit marker). While the replay plays forward every event between two frames is
 * played: one variant by probability, its random volume and pitch, attenuated linearly from dist_min
 * to dist_max and panned left / right by the camera. Seeking, pausing and the speed need nothing
 * special: only the events of the last frame step are played (pitch follows the speed).
 * The 3D video export renders a range offline for the frames' camera path (render: OfflineAudioContext
 * -> AudioBuffer for the MP4's audio track) or records the live sound (capture, the WebM fallback). */
const BASE = 'maps3d/_sound/';
const MAX_VOICES = 40;
let tablePromise = null;

/** the listener of a camera: position and right vector (stereo panning) */
export function listenerOf(camera, fallback = null) {
  if (!camera) return fallback || { pos: [0, 0, 0], right: [1, 0, 0] };
  camera.updateMatrixWorld();
  const m = camera.matrixWorld.elements;
  return { pos: [m[12], m[13], m[14]], right: [m[0], m[1], m[2]] };
}

const rand = (a, b) => a + Math.random() * (b - a);

export class SoundSystem {
  /** -> SoundSystem, or null when no sounds are exported */
  static async load(mapName) {
    if (!tablePromise) tablePromise = fetch(BASE + 'aliases.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    const table = await tablePromise;
    return table && table.aliases ? new SoundSystem(table, mapName) : null;
  }

  constructor(table, mapName) {
    this.table = table;
    this.map = String(mapName || '').toLowerCase().replace(/^mp_/, '');
    this.enabled = false;
    this.volume = 0.8;
    this.ctx = null;
    this.buffers = new Map();          // file -> Promise<AudioBuffer|null>
    this.ready = new Map();            // file -> AudioBuffer (decoded)
    this.voices = 0;
    this.sources = new Set();          // the playing sources (stopAll)
    this.lastT = null;
    this.events = [];
    this.local = [];
  }

  setDemo(match) {
    const s = match.d.sounds3d || { events: [], local: [] };
    this.events = s.events;
    this.local = s.local;
    this.times = Float64Array.from(this.events, e => e[0]);
    this.localTimes = Float64Array.from(this.local, e => e.t);
  }

  /** audio on / off (the browsers start audio only after a click) -> enabled */
  enable(on) {
    if (on && !this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.preload();
    }
    this.enabled = !!on && !!this.ctx;
    if (this.ctx) { if (this.enabled) this.ctx.resume().catch(() => {}); else this.ctx.suspend().catch(() => {}); }
    this.lastT = null;
    return this.enabled;
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** the variants of an alias valid on this map (loadspec: "!map" excludes, a plain list includes only) */
  variants(name) {
    if (name.startsWith('weapon:')) {
      const w = this.table.weapons[name.slice(7)];
      name = w && w.fireSound ? w.fireSound.toLowerCase() : '';
    }
    const list = this.table.aliases[name];
    if (!list) return null;
    const ok = list.filter(v => {
      const toks = String(v.ls || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!toks.length) return true;
      if (toks.some(x => x === '!' + this.map || x === '!mp_' + this.map)) return false;
      const plain = toks.filter(x => !x.startsWith('!'));
      return !plain.length || plain.includes(this.map) || plain.includes('mp_' + this.map);
    });
    return ok.length ? ok : null;
  }

  buffer(file) {
    if (!this.buffers.has(file)) {
      this.buffers.set(file, fetch(BASE + file).then(r => (r.ok ? r.arrayBuffer() : null))
        .then(b => (b ? this.decoder().decodeAudioData(b) : null))
        .then(buf => { if (buf) this.ready.set(file, buf); return buf; })
        .catch(() => null));
    }
    return this.buffers.get(file);
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

  /** gain and pan of variant v at pos for listener L (pos null: at the listener) -> [gain, pan] or null */
  mix(v, pos, L) {
    let gain = rand(v.v[0], v.v[1]), pan = 0;
    if (pos && L) {
      const dx = pos[0] - L.pos[0], dy = pos[1] - L.pos[1], dz = pos[2] - L.pos[2];
      const d = Math.hypot(dx, dy, dz);
      const [d0, d1] = v.d;
      if (d > d1) return null;
      if (d > d0) gain *= Math.max(0, 1 - (d - d0) / Math.max(1, d1 - d0));
      if (d > 1) pan = Math.max(-1, Math.min(1, (dx * L.right[0] + dy * L.right[1] + dz * L.right[2]) / d));
    }
    return gain < 0.005 ? null : [gain, pan * 0.8];
  }

  /** decode the files of every alias the demo plays */
  preload() {
    const names = new Set(this.events.map(e => e[1]).concat(this.local.map(l => l.name)));
    for (const n of names) for (const v of this.variants(n) || []) this.buffer(v.f);
  }

  /** play alias `name` at pos (null = at the listener, unattenuated) */
  play(name, pos, L, rate, depth = 0) {
    const list = this.variants(name);
    if (!list || this.voices >= MAX_VOICES) return;
    const v = this.pick(list);
    const buf = this.ready.get(v.f);
    if (!buf) { this.buffer(v.f); return; }
    const m = this.mix(v, pos, L);
    if (!m) return;
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = rand(v.p[0], v.p[1]) * rate;
    g.gain.value = m[0];
    let node = g;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = m[1]; g.connect(p); node = p; }
    node.connect(this.master);
    src.connect(g);
    this.voices++;
    this.sources.add(src);
    src.onended = () => { this.voices--; this.sources.delete(src); g.disconnect(); };
    src.start();
    if (v.sec && depth < 2) this.play(v.sec, pos, L, rate, depth + 1);
  }

  /** the sounds of (last frame, t] at the camera; pb: the playback (playing, speed) */
  update(t, camera, pb) {
    if (!this.enabled || !this.ctx) { this.lastT = t; return; }
    const last = this.lastT;
    this.lastT = t;
    if (!pb.playing || last == null || t <= last || t - last > 1500) return;
    const L = listenerOf(camera);
    const rate = Math.max(0.5, Math.min(2, pb.speed || 1));
    const ub = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };
    for (let i = ub(this.times, last), n = ub(this.times, t); i < n; i++) {
      const e = this.events[i];
      this.play(e[1], [e[2], e[3], e[4]], L, rate);
    }
    for (let i = ub(this.localTimes, last), n = ub(this.localTimes, t); i < n; i++) this.play(this.local[i].name, null, null, rate);
  }

  stopAll() {
    for (const s of this.sources) try { s.stop(); } catch (err) { /* stopped */ }
    this.sources.clear();
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
   *  camera of each frame [{pos, right}] -> AudioBuffer (stereo, 48 kHz) of the video's length */
  async render({ times, fps, speed, path, rate = 48000, onProgress = null }) {
    const n = times.length;
    if (!n) return null;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(n / fps * rate)), rate);
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
    const L = vt => path[Math.max(0, Math.min(n - 1, Math.floor(vt * fps)))] || path[path.length - 1];
    // the sounds of the range (from 2 s before: a long one may reach into it), one variant each
    const plans = [];
    const add = (name, pos, vt, depth = 0) => {
      const list = this.variants(name);
      if (!list) return;
      const v = this.pick(list);
      const m = this.mix(v, pos, pos ? L(Math.max(0, vt)) : null);
      if (m) plans.push({ v, m, vt, pitch: rand(v.p[0], v.p[1]) });
      if (v.sec && depth < 2) add(v.sec, pos, vt, depth + 1);
    };
    const t0 = times[0] - 2000, t1 = times[n - 1];
    for (const e of this.events) {
      if (e[0] < t0) continue;
      if (e[0] > t1) break;
      const vt = videoTime(e[0]);
      if (vt != null) add(e[1], [e[2], e[3], e[4]], vt);
    }
    for (const l of this.local) {
      if (l.t < t0) continue;
      if (l.t > t1) break;
      const vt = videoTime(l.t);
      if (vt != null) add(l.name, null, vt);
    }
    const files = [...new Set(plans.map(p => p.v.f))];
    let done = 0;
    await Promise.all(files.map(f => this.buffer(f).then(() => { done++; if (onProgress) onProgress(done / files.length); })));
    for (const p of plans) {
      const buf = this.ready.get(p.v.f);
      if (!buf) continue;
      const r = p.pitch * speed, dur = buf.duration / r;
      if (p.vt + dur <= 0) continue;
      const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
      src.buffer = buf;
      src.playbackRate.value = r;
      g.gain.value = p.m[0];
      pan.pan.value = p.m[1];
      src.connect(g).connect(pan).connect(out);
      src.start(Math.max(0, p.vt), p.vt < 0 ? -p.vt * r : 0);
    }
    return ctx.startRendering();
  }

  dispose() { this.stopAll(); if (this.ctx) this.ctx.close().catch(() => {}); this.ctx = null; this.enabled = false; }
}
