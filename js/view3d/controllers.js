/* The game's player angle controllers: how the engine turns the legs, torso, neck and head of a player
 * model towards the view, leans it and tilts it on slopes when prone - CoD2's own code: BG_PlayerAngles,
 * BG_SwingAngles, BG_Player_DoControllersInternal and BG_Player_DoControllers of the 1.3 client (the decompile in
 * cod2x/src/other) and, when the server's g_cod2x is 3 or more (CoD2x 1.4: every player of such a server runs it),
 * CoD2x's versions of them (cod2x/src/shared/animation.cpp, PLAN.md step 101). The skeletons' controller bones:
 * back_low, back_mid, back_up, neck, head, pelvis and the root tag_origin.
 *
 * Every client frame the game swings three angles towards their goals with a speed that grows with the distance
 * (BG_SwingAngles: max(0.5, |distance| x 0.05) x frame ms x speed):
 *   torso yaw   towards the view yaw - plus 0.3 x the movement direction when not prone, firing or aiming (1.3);
 *               clamp 45° while firing, 90° otherwise
 *   legs yaw    towards the view yaw + the movement direction (the demos carry it: ps.movementYaw in the entity's
 *               angles2[1], collect.js), once they differ by more than 40° or while moving; clamp 150°; the strafe
 *               animations follow the view itself, prone they lie along the prone direction
 *   torso pitch towards 0.6 x the view pitch (clamp 45°)
 * at speed 0.2 (bg_swingSpeed; the pitch 0.15). CoD2x (g_cod2x >= 3): speed 1 (the body follows the view at
 * once), no 0.3 x direction on the torso, no 40° tolerance for the legs standing.
 * The root (tag_origin) carries the legs yaw; the spine bones take the torso's difference to the legs, neck and
 * head the view's difference to the torso; lean rolls the torso and shifts the root sideways; prone, the entity's
 * fTorsoPitch / fWaistPitch tilt root, back and pelvis to the slope. The controller angles follow their goals at
 * most 0.36° per ms, the root offset 0.1 units per ms. CoD2x adds: the diagonal fix (the lower back's pitch / roll
 * turned by its yaw against the root's), a lean-left offset while moving, a flatter prone pose (backwards, reloading,
 * firing), the head on ladders, the crouch <-> prone bounce, and a time blend of all controllers (100 - 400 ms)
 * whenever the movement type changes (moving forward / back / sideways, stance, lean ...).
 *
 * The movement types and strafing of the legs animations come from playeranim.script (anims.json moveTypes,
 * cod2-assets' animtree.script_movetypes); an older export without them: from the animations' names.
 *
 * The state depends on its history, so it is simulated along the demo's samples in steps of at most 16 ms (with
 * checkpoints every CHECK samples): the same demo time always gives the same angles, also when seeking. */
import { upperBound } from '../app/match.js';

const C2 = window.C2;
const CFG = C2.mapConfig;
const PF = C2.collect.PF;
const SWING_SPEED = 0.2, PITCH_SPEED = 0.15, LEG_YAW_TOLERANCE = 40;   // bg_swingSpeed, BG_PlayerAngles
const STEP_MS = 16, CHECK = 10, ANGLE_RATE = 0.36, OFFSET_RATE = 0.1;
const PRONE_TIME = 400, CROUCH_TIME = 200;                              // PLAYER_PRONE_TIME, PLAYER_CROUCH_TIME
const MOVING = /walk|run|sprint|crawl|stumble/;
const STRAFE = /_(left|right)(_loop)?(_pistol|_grenade)?$/;
const MIN_SPEED = 40;                    // units/s: slower is standing (no legs direction; the fallback only)

// the legs animation's movement (bits; from its movetypes): IDLE the idle / idlecr condition of BG_PlayerAngles, FW / BW
// CoD2x's isMovingFW / isMovingBW, CROUCH / PRONE its BG_IsCrouchingAnim / BG_IsProneAnim (the stance transitions)
const M = { IDLE: 1, FW: 2, BW: 4, LEFT: 8, RIGHT: 16, CLIMBUP: 32, CLIMBDOWN: 64, CROUCH: 128, PRONE: 256, KNOWN: 512 };
const MT_BITS = {
  idle: M.IDLE, idlecr: M.IDLE | M.CROUCH, idleprone: M.PRONE,
  run: M.FW, walk: M.FW, runcr: M.FW | M.CROUCH, walkcr: M.FW | M.CROUCH, walkprone: M.FW | M.PRONE,
  runbk: M.BW, walkbk: M.BW, runcrbk: M.BW | M.CROUCH, walkcrbk: M.BW | M.CROUCH, walkpronebk: M.BW | M.PRONE,
  turnrightcr: M.CROUCH, turnleftcr: M.CROUCH, stumble_crouch_forward: M.CROUCH, stumble_crouch_backward: M.CROUCH,
  climbup: M.CLIMBUP, climbdown: M.CLIMBDOWN
};
// CoD2x's controller movement types (only their change matters)
const CT = { MOVING: 1, BACK: 2, LEFT: 4, RIGHT: 8, LEFT_STRAFE: 16, RIGHT_STRAFE: 32, STAND: 64, CROUCH: 128, PRONE: 256,
  STAND_LEAN_LEFT: 512, CROUCH_LEAN_LEFT: 1024, PRONE_BACK_RELOAD: 2048, PRONE_BACK_FIRE: 4096, PRONE_FORWARD_RELOAD: 8192,
  CLIMBUP: 16384, CLIMBDOWN: 32768 };

const norm360 = a => ((a % 360) + 360) % 360;
/** AngleDelta(a, b): a - b in -180 .. 180 */
const delta = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; else if (d < -180) d += 360; return d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const D2R = Math.PI / 180;

/** BG_SwingAngles on state[key] / state[flag] */
function swing(st, key, flag, dest, tol, clampTol, speed, dt) {
  if (!st[flag]) {
    const s = delta(st[key], dest);
    if (s > tol || s < -tol) st[flag] = 1;
  }
  if (!st[flag]) return;
  const s = delta(dest, st[key]);
  const move = dt * Math.max(0.5, Math.abs(s) * 0.05) * speed;
  if (s < 0) {
    if (s < -move) st[key] = norm360(st[key] - move);
    else { st[key] = norm360(st[key] + s); st[flag] = 0; }
  } else if (s > move) st[key] = norm360(st[key] + move);
  else { st[key] = norm360(st[key] + s); st[flag] = 0; }
  const s2 = delta(dest, st[key]);
  if (s2 > clampTol) st[key] = norm360(dest - clampTol);
  else if (s2 < -clampTol) st[key] = norm360(dest + clampTol);
}

/** BG_PlayerAngles: the legs / torso yaw and the torso pitch swing towards their goals */
function playerAngles(st, inp, dt, cx) {
  const view = norm360(inp.yaw), speed = cx ? 1 : SWING_SPEED, climb = inp.mv & (M.CLIMBUP | M.CLIMBDOWN);
  if (inp.turret || climb || inp.mantle) { st.torsoYawing = 1; st.pitching = 1; st.legsYawing = 1; }
  else if (inp.mv & M.IDLE) { if (inp.firing) { st.torsoYawing = 1; st.pitching = 1; } }
  else { st.torsoYawing = 1; st.pitching = 1; st.legsYawing = 1; }
  let legsDest = view + inp.moveYaw, torsoDest, clampTol = 90;
  if (climb) { torsoDest = legsDest; clampTol = 0; }
  else if (inp.mantle) { torsoDest = view; legsDest = view; }
  else if (inp.prone) torsoDest = view;
  else if (inp.firing) { torsoDest = view; clampTol = 45; }
  else if (inp.ads || cx) torsoDest = view;
  else torsoDest = view + inp.moveYaw * 0.3;
  swing(st, 'torso', 'torsoYawing', torsoDest, 0, clampTol, speed, dt);
  if (inp.prone) { st.legsYawing = 0; st.legs = norm360(cx === 3 ? view : view + inp.moveYaw); }
  else if (inp.mv & (M.LEFT | M.RIGHT)) { st.legsYawing = 0; swing(st, 'legs', 'legsYawing', view, 0, 150, speed, dt); }
  else swing(st, 'legs', 'legsYawing', legsDest, st.legsYawing || cx ? 0 : LEG_YAW_TOLERANCE, 150, speed, dt);
  if (inp.turret) { st.torso = view; st.legs = view; }
  else if (climb) { st.torso = norm360(view + inp.moveYaw); st.legs = st.torso; }
  const dest = inp.turret || climb || inp.mantle ? 0 : delta(inp.pitch, 0) * 0.6;
  swing(st, 'pitch', 'pitching', dest, 0, 45, cx ? 1 : PITCH_SPEED, dt);
}

/** CoD2x animation_adjustRotation: a child's pitch / roll turned by its yaw against the parent's */
function adjust(a, k, parentYaw) {
  const r = (a[k + 1] - parentYaw) * D2R, c = Math.cos(r), s = Math.sin(r), p = a[k], ro = a[k + 2];
  a[k] = p * c - ro * s; a[k + 2] = p * s + ro * c;
}

/** BG_Player_DoControllersInternal: goal angles of the controller bones and the root -> out; CoD2x's movement type
 *  (returned) and its blend time (out.time) */
const HEAD = [0, 0, 0], TORSO = [0, 0, 0];      // (scratch: no arrays per step)
function goals(st, inp, out, cx) {
  const a = out.angles, tag = out.tag, off = out.offset;
  a.fill(0); tag.fill(0); off.fill(0); out.time = 0;
  if (inp.turret) return st.mt;                 // (on a mounted MG: none - the gunner animations aim the body)
  const climb = inp.mv & (M.CLIMBUP | M.CLIMBDOWN);
  let torsoP = 0;
  if (!climb) {
    torsoP = st.pitch;
    if (inp.prone) { torsoP = delta(torsoP, 0); torsoP = torsoP <= 0 ? torsoP * 0.25 : torsoP * 0.5; }
  }
  const head = HEAD, torso = TORSO;
  head[0] = delta(inp.pitch, torsoP); head[1] = delta(inp.yaw, st.torso); head[2] = 0;
  torso[0] = delta(torsoP, 0); torso[1] = delta(st.torso, st.legs); torso[2] = 0;
  const f = inp.lean * (2 - Math.abs(inp.lean));                      // GetLeanFraction
  torso[2] = f * 50 * 0.925; head[2] = torso[2];
  if (f) off[1] += inp.crouch ? (f <= 0 ? -f * 12.5 : -f * 2.5) : (f <= 0 ? -f * 5 : -f * 2.5);
  tag[1] = delta(st.legs, inp.yaw);
  const slope = inp.torsoPitch || inp.waistPitch ? delta(inp.torsoPitch, inp.waistPitch) : 0;
  if (inp.prone) {
    if (f) head[2] *= 0.5;
    const c = Math.cos(torso[1] * D2R), s = Math.sin(torso[1] * D2R);
    tag[0] += inp.torsoPitch;
    off[0] += (1 - c) * -24;
    off[1] += s * -12;
    if (f * s > 0) off[1] += -f * (1 - c) * 16;
    a[0] = slope; a[1] = torso[2] * -1.2; a[2] = torso[2] * 0.3;
    a[3] = 0; a[4] = torso[1] * 0.1 - torso[2] * 0.2; a[5] = torso[2] * 0.2;
    a[6] = torso[0]; a[7] = torso[1] * 0.8 + torso[2]; a[8] = torso[2] * -0.2;
  } else {
    if (f && (!inp.crouch || f <= 0)) { torso[2] *= 1.25; head[2] *= 1.25; }
    tag[2] += f * 3.75;
    a[0] = torso[0] * 0.2 + slope; a[1] = torso[1] * 0.4; a[2] = torso[2] * 0.5;
    a[3] = torso[0] * 0.3; a[4] = torso[1] * 0.4; a[5] = torso[2] * 0.5;
    a[6] = torso[0] * 0.5; a[7] = torso[1] * 0.2; a[8] = torso[2] * -0.6;
  }
  a[9] = head[0] * 0.3; a[10] = head[1] * 0.3; a[11] = 0;
  a[12] = head[0] * 0.7; a[13] = head[1] * 0.7; a[14] = head[2] * -0.3;
  a[15] = inp.torsoPitch || inp.waistPitch ? delta(inp.waistPitch, inp.torsoPitch) : 0;
  if (!cx) return 0;

  // CoD2x (g_cod2x >= 3)
  const fw = !!(inp.mv & M.FW), bw = !fw && !!(inp.mv & M.BW), left = !!(inp.mv & M.LEFT), right = !left && !!(inp.mv & M.RIGHT);
  const my = inp.moveYaw;
  let mt = (fw ? CT.MOVING : bw ? CT.BACK : 0) | (left ? CT.LEFT : right ? CT.RIGHT : 0);
  if ((fw && my > 20) || (bw && my < -20)) mt |= CT.LEFT_STRAFE;
  else if ((fw && my < -20) || (bw && my > 20)) mt |= CT.RIGHT_STRAFE;
  if (!inp.prone) {
    mt |= inp.crouch ? CT.CROUCH : CT.STAND;
    out.time = 250;
    if (f < 0 && (fw || bw) && my > 0 && my < 90) {          // moving left while leaning left: a bit to the left
      const k = inp.crouch ? 3.8 : 7.2;
      tag[0] += -f * k; tag[2] -= -f * k;
      mt |= inp.crouch ? CT.CROUCH_LEAN_LEFT : CT.STAND_LEAN_LEFT;
    }
    if (inp.crouch && f < 0 && (fw || bw)) {                  // crouched, leaning left: the head lower
      a[0] += 40 * -f; a[1] += 30 * -f; a[3] += -20 * -f; a[6] += -20 * -f;
    }
    adjust(a, 0, tag[1]);                                     // the diagonal fix
  } else {
    mt |= CT.PRONE;
    out.time = 400;
    const l = inp.lean, scale = l < 0 ? (0.25 + l) / 0.25 : l > 0 ? (0.25 - l) / 0.25 : 1;
    a[0] += -30 * scale; a[3] += 30 * scale;                  // the backside flatter
    if ((fw || bw) && !(left || right)) { a[0] += -10 * scale; a[3] += 10 * scale; }
    a[15] += 3;
    const reload = inp.torsoName && /reload/.test(inp.torsoName);
    if (bw && scale !== 0) {
      off[1] += -8; off[2] += -3; a[0] += -20; a[15] += 7;
      if (!inp.torsoName) off[2] += -3;
      else if (reload) { a[15] += 14; off[2] += -3; mt |= CT.PRONE_BACK_RELOAD; }
      else { a[15] += 13; off[2] += -3; out.time = 100; mt |= CT.PRONE_BACK_FIRE; }
    } else if ((left || right) && scale !== 0) { off[2] += -1; out.time = 150; }
    else if (fw && reload) { a[15] += 3; mt |= CT.PRONE_FORWARD_RELOAD; }
  }
  if (climb) {                                                // ladders: the head towards the view
    const p = delta(inp.pitch, 0), up = !!(inp.mv & M.CLIMBUP);
    a[9] = (up ? 30 : -30) + clamp(p, -80, 70); a[10] = -12 + delta(inp.yaw, st.torso); a[11] = -9;
    adjust(a, 9, 0);
    if (up) {
      const sp = Math.sin(clamp(p, 0, 90) * D2R);
      a[9] += sp * Math.sin(clamp(my, -90, 0) * D2R) * 45; a[10] += sp * Math.sin(clamp(my, 0, 90) * D2R) * 30;
    }
    mt |= up ? CT.CLIMBUP : CT.CLIMBDOWN;
  }
  // crouch -> prone (a bounce on touching the ground) and prone -> crouch: over PLAYER_PRONE_TIME from the legs change
  if ((st.trType === 2 || st.trType === 3) && st.time > st.trStart && st.time < st.trStart + PRONE_TIME) {
    const fr = (st.time - st.trStart) / PRONE_TIME;
    if (st.trType === 2) {
      const c1 = 0.5 * (1 - Math.cos(2 * Math.PI * clamp(fr / 0.6, 0, 1))), c2 = 0.5 * (1 - Math.cos(2 * Math.PI * clamp((fr - 0.4) / 0.6, 0, 1)));
      off[0] += c1 * -5; off[2] += c2 * 12; tag[0] += c2 * -10; a[0] += c2 * 10;
    } else off[0] += 0.5 * (1 - Math.cos(2 * Math.PI * fr)) * -5;
  }
  return mt;
}

/** one client frame of BG_PlayerAngles + BG_Player_DoControllers at time `now` (ms) */
function step(st, inp, dt, now, cx, snap) {
  st.time = now;
  playerAngles(st, inp, dt, cx);
  const mt = goals(st, inp, st.goal, cx), g = st.goal;
  if (snap) {
    st.angles.set(g.angles); st.tag.set(g.tag); st.offset.set(g.offset); st.mt = mt; st.mvEnd = -Infinity;
    return;
  }
  if (cx) {
    // CoD2x: a new movement type blends every controller from where it is to its goal over its time
    if (mt !== st.mt) {
      st.mt = mt; st.mvTime = g.time > 0 ? g.time : 300; st.mvEnd = now + st.mvTime;
      st.mvStart.set(st.angles, 0); st.mvStart.set(st.tag, 18); st.mvStart.set(st.offset, 21);
    }
    const raw = 1 - (st.mvEnd - now) / st.mvTime;
    if (raw >= 0 && raw <= 1) {
      const S = st.mvStart, q = 1 - raw;
      for (let k = 0; k < 18; k++) st.angles[k] = S[k] * q + g.angles[k] * raw;
      for (let k = 0; k < 3; k++) { st.tag[k] = S[18 + k] * q + g.tag[k] * raw; st.offset[k] = S[21 + k] * q + g.offset[k] * raw; }
      return;
    }
  }
  const max = dt * ANGLE_RATE;
  for (let k = 0; k < 18; k++) st.angles[k] += clamp(g.angles[k] - st.angles[k], -max, max);
  for (let k = 0; k < 3; k++) st.tag[k] += clamp(g.tag[k] - st.tag[k], -max, max);
  const dx = g.offset[0] - st.offset[0], dy = g.offset[1] - st.offset[1], dz = g.offset[2] - st.offset[2];
  const len = Math.hypot(dx, dy, dz), mo = dt * OFFSET_RATE;
  if (len <= mo) st.offset.set(g.offset);
  else { st.offset[0] += dx / len * mo; st.offset[1] += dy / len * mo; st.offset[2] += dz / len * mo; }
}

const fresh = () => ({ legs: 0, torso: 0, pitch: 0, legsYawing: 0, torsoYawing: 0, pitching: 0, time: 0,
  mt: 0, mvTime: 300, mvEnd: -Infinity, mvStart: new Float32Array(24), trType: 0, trStart: -Infinity,
  angles: new Float32Array(18), tag: new Float32Array(3), offset: new Float32Array(3),
  goal: { angles: new Float32Array(18), tag: new Float32Array(3), offset: new Float32Array(3), time: 0 } });
const copy = s => copyInto(fresh(), s);
/** state s into d (d's arrays kept) -> d */
function copyInto(d, s) {
  d.legs = s.legs; d.torso = s.torso; d.pitch = s.pitch; d.legsYawing = s.legsYawing; d.torsoYawing = s.torsoYawing; d.pitching = s.pitching;
  d.time = s.time; d.mt = s.mt; d.mvTime = s.mvTime; d.mvEnd = s.mvEnd; d.mvStart.set(s.mvStart); d.trType = s.trType; d.trStart = s.trStart;
  d.angles.set(s.angles); d.tag.set(s.tag); d.offset.set(s.offset);
  return d;
}

/** a legs animation value -> its movement bits (M) - from anims.json moveTypes, else from its name */
export function legsMove(lib, v) {
  const info = lib && lib.animsInfo;
  if (!info) return 0;
  const idx = v & 0x1ff;
  let C = info._move;
  if (!C) {
    C = info._move = new Uint16Array(info.table.length);
    const T = info.moveTypes;
    for (let i = 0; i < C.length; i++) {
      const e = T && T[i];
      if (e) { let b = M.KNOWN; for (const n of e[0]) b |= MT_BITS[n] || 0; if (e[1] === 1) b |= M.LEFT; else if (e[1] === 2) b |= M.RIGHT; C[i] = b; continue; }
      const n = info.table[i] || '';
      if (!n) continue;
      const moving = MOVING.test(n), prone = /prone/.test(n), crouch = /crouch/.test(n);
      let b = (moving ? (/back|_bk/.test(n) ? M.BW : M.FW) : prone ? 0 : M.IDLE) | (prone ? M.PRONE : crouch ? M.CROUCH : 0);
      if (moving && STRAFE.test(n)) b |= /_left/.test(n) ? M.LEFT : M.RIGHT;
      if (/climbup/.test(n)) b = M.CLIMBUP; else if (/climbdown/.test(n)) b = M.CLIMBDOWN;
      C[i] = b;
    }
  }
  return C[idx];
}

/** CoD2x animation_getStanceTransitionType: 1 stand -> crouch, 2 crouch -> prone, 3 prone -> crouch, 4 crouch -> stand */
export function stanceTransition(lib, from, to) {
  const a = legsMove(lib, from), b = legsMove(lib, to);
  const ca = !!(a & M.CROUCH), cb = !!(b & M.CROUCH), pa = !!(a & M.PRONE), pb = !!(b & M.PRONE);
  if (!ca && !pa && cb) return 1;
  if (ca && pb) return 2;
  if (pa && cb) return 3;
  if (ca && !cb && !pb) return 4;
  return 0;
}

/** a legs value's stance bits (1 crouch, 2 prone; 0 standing or unknown) - the game's BG_IsCrouchingAnim /
 *  BG_IsProneAnim tests of the animation's movetype, which open BG_SetNewAnimation's 400 ms stance window */
export function legsStance(lib, v) {
  const m = legsMove(lib, v);
  return (m & M.CROUCH ? 1 : 0) | (m & M.PRONE ? 2 : 0);
}

/** CoD2x BG_SetNewAnimation: a stance change's legs crossfade (ms), or null (the viewer's own) */
export function stanceBlendMs(lib, from, to) {
  switch (stanceTransition(lib, from, to)) {
    case 1: case 4: return CROUCH_TIME;
    case 2: return PRONE_TIME * 0.58;         // (in the first person the drop is faster)
    case 3: return PRONE_TIME;
    default: return null;
  }
}

export class Controllers {
  /** match: Match, lib: CharacterLibrary (the legs animations' names and movement types) */
  constructor(match, lib) {
    this.M = match; this.lib = lib; this.cache = new Map();
    this.cx = (match.d.meta && match.d.meta.cod2x) >= 3 ? match.d.meta.cod2x : 0;   // CoD2x's rules (g_cod2x)
    this.inp = {};                     // (input's result, reused: read before the next call)
  }

  /** the legs' direction relative to the view (degrees) without the demo's movementYaw (older data): 0, or ±45 for
   *  the diagonals, from the velocity */
  moveDir(P, i, yaw) {
    const j = i + 1 < P.t.length && P.t[i + 1] - P.t[i] <= CFG.GAP_MS ? i : i - 1;
    if (j < 0 || j + 1 >= P.t.length) return 0;
    const dt = (P.t[j + 1] - P.t[j]) / 1000, vx = P.x[j + 1] - P.x[j], vy = P.y[j + 1] - P.y[j];
    if (!(dt > 0) || Math.hypot(vx, vy) / dt < MIN_SPEED) return 0;
    const d = delta(Math.atan2(vy, vx) / D2R, yaw);
    const ad = Math.abs(d);
    if (ad <= 67.5) return Math.max(-45, Math.min(45, Math.round(d / 45) * 45));               // forward (diagonal)
    if (ad >= 112.5) { const e = d - Math.sign(d) * 180; return Math.max(-45, Math.min(45, Math.round(e / 45) * 45)); }   // backward
    return 0;                                                                                     // sideways: the strafe animation
  }

  /** inputs of sample i of client cl (the view angles interpolated towards sample i + 1 at time t) */
  input(P, i, t) {
    const info = this.lib.animsInfo;
    let yaw = P.yaw[i], pitch = P.pitch[i], lean = P.lean ? P.lean[i] : 0;
    // (the view angles and the lean between the samples, as the client lerps them: ci->lerpLean)
    if (i + 1 < P.t.length && t > P.t[i] && P.t[i + 1] - P.t[i] <= CFG.GAP_MS && !(P.flags[i + 1] & PF.DEAD)) {
      const f = (t - P.t[i]) / (P.t[i + 1] - P.t[i]);
      yaw += delta(P.yaw[i + 1], yaw) * f; pitch += delta(P.pitch[i + 1], pitch) * f;
      if (P.lean) lean += (P.lean[i + 1] - lean) * f;
    }
    const fl = P.flags[i], o = this.inp, tv = P.torso ? P.torso[i] & 0x1ff : 0;
    o.yaw = yaw; o.pitch = pitch; o.lean = lean;
    o.moveYaw = P.moveYaw ? P.moveYaw[i] : this.moveDir(P, i, yaw);
    o.torsoPitch = P.torsoPitch ? P.torsoPitch[i] : 0; o.waistPitch = P.waistPitch ? P.waistPitch[i] : 0;
    o.crouch = !!(fl & PF.CROUCH); o.prone = !!(fl & PF.PRONE); o.firing = !!(fl & PF.FIRING);
    o.ads = !!(fl & PF.ADS); o.mantle = !!(fl & PF.MANTLE); o.turret = !!(fl & PF.TURRET);
    o.mv = legsMove(this.lib, P.legs[i]);
    o.torsoName = tv && info ? info.table[tv] || 'torso' : null;
    return o;
  }

  /** a new life / a gap / a new round restarts the simulation at sample i */
  restartsAt(P, i) {
    if (i === 0 || (P.flags[i - 1] & PF.DEAD)) return true;
    if (P.t[i] - P.t[i - 1] > 1000) return true;
    return this.M.epochStart(P.t[i]) > P.t[i - 1];
  }

  /** advance state st over sample i's interval up to time t (exclusive of sample i + 1) */
  run(P, i, st, from, to) {
    // (CoD2x: a legs change between stances starts its transition)
    if (this.cx && i > 0 && from === P.t[i] && P.legs[i] !== P.legs[i - 1] && (P.legs[i] & 0x1ff)) {
      const k = stanceTransition(this.lib, P.legs[i - 1], P.legs[i]);
      if (k) { st.trType = k; st.trStart = from; }
    }
    for (let t = from; t < to;) {
      const dt = Math.min(STEP_MS, to - t);
      t += dt;
      step(st, this.input(P, i, t), dt, t, this.cx, false);
    }
  }

  start(P, i) {
    const st = fresh(), inp = this.input(P, i, P.t[i]);
    st.legs = st.torso = norm360(inp.yaw);
    st.pitch = norm360(clamp(delta(inp.pitch, 0) * 0.6, -45, 45));
    step(st, inp, 0, P.t[i], this.cx, true);
    return st;
  }

  /** controller state of client cl at time t: {angles: 6 × [pitch, yaw, roll], tag: [pitch, yaw, roll] of the root
   *  relative to the view yaw, offset: [forward, left, up]} or null */
  at(cl, t) {
    const P0 = this.M.d.positions[cl];
    if (!P0 || !P0.legs || !this.lib.animsInfo) return null;
    const i = upperBound(P0.t, t) - 1;
    if (i < 0 || (P0.flags[i] & PF.DEAD)) return null;
    let C = this.cache.get(cl);
    // (the samples with the positions and view angles as drawn: Match.drawn)
    const P = C ? C.P : (() => { const Q = this.M.drawn(cl); return Object.assign({}, P0, { x: Q.x, y: Q.y, yaw: Q.yaw, pitch: Q.pitch }); })();
    if (!C) {
      // per sample the latest restart at or before it; checkpoint sample index -> state at that sample
      const R = new Int32Array(P.t.length);
      for (let j = 1; j < R.length; j++) R[j] = this.restartsAt(P, j) ? j : R[j - 1];
      // (work: the state run from a checkpoint, out: the result - both reused frame after frame)
      this.cache.set(cl, C = { P, restart: R, states: new Map(), work: fresh(), out: { angles: null, tag: null, offset: null } });
    }
    const r = C.restart[i], S = C.states;
    let k = i - ((i - r) % CHECK), st;
    for (let c = k; c >= r; c -= CHECK) {
      if (S.has(c)) { st = copyInto(C.work, S.get(c)); k = c; break; }
    }
    if (!st) { st = this.start(P, r); k = r; S.set(r, copy(st)); }
    for (let j = k; j < i; j++) {
      this.run(P, j, st, P.t[j], P.t[j + 1]);
      if ((j + 1 - r) % CHECK === 0 && !S.has(j + 1)) S.set(j + 1, copy(st));
    }
    this.run(P, i, st, P.t[i], t);
    const o = C.out;
    o.angles = st.angles; o.tag = st.tag; o.offset = st.offset;
    return o;
  }
}
