/* The first-person weapon's motion at a demo time (viewmodel.js draws it): which of the weapon's view
 * animations play and how far, aiming down the sights, the gun's kick, bob and sway, and the crosshair's
 * spread. Ported from cod4-demo3d (viewanim.js), with CoD2's animation numbers, weapon states and events.
 *
 * Everything is a function of the demo time - nothing is carried from frame to frame - so pausing,
 * seeking and the playback speed need nothing special: the animations run in demo time (faster at 2x /
 * 4x; every shot restarts the fire animation as in the game), and the state after a jump in the timeline
 * is the one the demo gives there.
 *
 * Two sources:
 *   the recorder - the player whose player state the demo holds (the POV, or whom the POV spectates): the
 *     game's own view model state per snapshot (collect.js psWeapon): weapAnim (the animation the client
 *     plays), weaponstate, the offhand grenade, fWeaponPosFrac (ADS), aimSpreadScale (the crosshair),
 *     the view height, the bob cycle, the velocity and the ground entity;
 *   the other players - their weapon events (shots, reloads, rechamber, raise / put away, melee, the
 *     offhand throw; collect.js weapEvents), the legs animation (aiming down the sights: the *_ads ones),
 *     the stance and the positions (speed, jumps) - an approximation. */

// the weapon animation numbers (playerState weapAnim & 0x1ff), matched against the demos: in the weapon
// states they belong to (raising 1 -> 10, dropping 2 -> 9, firing 3 -> 2 / 3 / 5 / 6, rechambering 4 -> 4 / 7,
// reloading 5 -> 11 / 12, reload start 7 -> 13, reload end 9 -> 14, melee 10 / 11 -> 8, offhand 12 / 16 ->
// 17 / 18 (the primary weapon goes down and up again), offhand prepare / hold 13 / 14 -> 19 (the pin))
export const WEAP_ANIMS = ['idle', 'emptyIdle', 'fire', 'lastShot', 'rechamber', 'adsFire', 'adsLastShot', 'adsRechamber',
  'melee', 'drop', 'raise', 'reload', 'reloadEmpty', 'reloadStart', 'reloadEnd', 'altDrop', 'altRaise', 'quickDrop', 'quickRaise',
  'holdFire'];
const LOOPED = new Set(['idle', 'emptyIdle', 'holdFire']);
const ADS_VARIANT = { fire: 'adsFire', lastShot: 'adsLastShot', rechamber: 'adsRechamber' };
const ADS_ANIMS = new Set(['adsFire', 'adsLastShot', 'adsRechamber']);
const FIRE_ANIMS = new Set(['fire', 'lastShot', 'adsFire', 'adsLastShot']);
// the animations that end at a held pose (the gun lowered until the next raise)
const HOLD_END = new Set(['drop', 'quickDrop', 'altDrop']);
// the animations the game plays stretched to the weapon file's time (CG_RegisterWeapon: rate = the animation's
// length / the time; fire, last shot and rechamber play at their own pace). The reload end takes reloadTime there
const STRETCH = { holdFire: 'holdFireTime', melee: 'meleeTime', reload: 'reloadTime', reloadEmpty: 'reloadEmptyTime',
  reloadStart: 'reloadStartTime', reloadEnd: 'reloadTime', raise: 'raiseTime', drop: 'dropTime', altRaise: 'altRaiseTime',
  altDrop: 'altDropTime', quickRaise: 'quickRaiseTime', quickDrop: 'quickDropTime' };
// the weapon states of the offhand throw (WEAPON_OFFHAND_INIT .. WEAPON_OFFHAND_END): the grenade is drawn
// while its pin is pulled and it is thrown (not during the primary weapon's quick drop / raise)
const OFFHAND_STATES = [12, 17];
// demo events (EVENT_NAMES index) of the other players -> animation
const EV = { RELOAD: 150, RELOAD_EMPTY: 151, RELOAD_START: 152, RELOAD_END: 153, RAISE: 154, PUTAWAY: 155, PULLBACK: 157, FIRE: 158,
  FIREB: 159, LASTSHOT: 160, RECHAMBER: 161, MELEE: 163, FIRE_MELEE: 164, PREP_OFFHAND: 165, USE_OFFHAND: 166 };
const EVENT_ANIMS = { [EV.RELOAD]: 'reload', [EV.RELOAD_EMPTY]: 'reloadEmpty', [EV.RELOAD_START]: 'reloadStart', [EV.RELOAD_END]: 'reloadEnd',
  [EV.RAISE]: 'raise', [EV.PUTAWAY]: 'drop', [EV.FIRE]: 'fire', [EV.FIREB]: 'fire', [EV.LASTSHOT]: 'lastShot', [EV.RECHAMBER]: 'rechamber',
  [EV.MELEE]: 'melee', [EV.PREP_OFFHAND]: 'quickDrop', [EV.USE_OFFHAND]: 'quickRaise' };
const SHOT_EVENTS = new Set([EV.FIRE, EV.FIREB, EV.LASTSHOT]);
// no crosshair while the weapon is raised / dropped, reloaded or swung (CG_DrawCrosshair: weapon states 1, 2, 5,
// 10, 11); the other players: the same actions
const NO_RETICLE_STATES = new Set([1, 2, 5, 10, 11]);
const NO_RETICLE_ACTIONS = new Set(['raise', 'drop', 'quickRaise', 'quickDrop', 'altRaise', 'altDrop', 'reload', 'reloadEmpty', 'melee']);
const BLEND = 0.12, FIRE_BLEND = 0.04;        // s: cross-fade between animations (a shot restarts at once)
const ENTITYNUM_NONE = 1023;
const RUN_SPEED = 190;                         // units / s: full movement offsets
const BOB_AMP = [0.007, 0.0075, 0.03], BOB_MAX = 8;   // bg_bobAmplitudeStanding / Ducked / Prone, bg_bobMax

const lower = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m + 1; else hi = m; } return lo - 1; };
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
// a deterministic random number in [0, 1) per shot (the gun kick: the same after every seek)
const hash01 = n => { let x = (n | 0) ^ 0x9e3779b9; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

export class ViewAnimator {
  /** M: the match; legsName(index) -> the legs animation's name (CharacterLibrary) or null */
  constructor(M, legsName) {
    this.M = M; this.legsName = legsName;
    this.events = new Map();             // client -> {t: Int32Array, ev, w}
    this.dist = new Map();               // client -> cumulative ground distance per position sample
    this.adsLegs = new Map();            // legs anim index -> aiming down the sights
    this.buildRecorder();
  }

  /* ---------- per demo ---------- */
  /** the recorder's rows: the start of each weapAnim run (the toggle bit marks a restart) */
  buildRecorder() {
    const W = this.M.d.psWeapon;
    this.rec = null;
    if (!W || !W.t.length) return;
    const n = W.t.length, start = new Float64Array(n), first = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const same = i > 0 && W.client[i] === W.client[i - 1] && W.anim[i] === W.anim[i - 1] && W.weapon[i] === W.weapon[i - 1] && W.t[i] - W.t[i - 1] < 500;
      if (same) { start[i] = start[i - 1]; first[i] = first[i - 1]; }
      // a new run started between the snapshots: the middle (the game changed it within that time)
      else { start[i] = i > 0 && W.t[i] - W.t[i - 1] < 500 ? (W.t[i - 1] + W.t[i]) / 2 : W.t[i]; first[i] = i; }
    }
    this.rec = { W, start, first };
  }

  /** a client's weapon events -> {t, ev, w (weapon name)} sorted */
  eventsOf(cl) {
    let E = this.events.get(cl);
    if (E) return E;
    const list = [];
    for (const r of this.M.d.weapEvents || []) if (r[1] === cl && EVENT_ANIMS[r[2]]) list.push([r[0], r[2], this.M.weaponName(r[3], r[0])]);
    list.sort((a, b) => a[0] - b[0]);
    E = { t: Int32Array.from(list, e => e[0]), ev: list.map(e => e[1]), w: list.map(e => e[2]) };
    this.events.set(cl, E);
    return E;
  }

  /** does a legs animation aim down the sights (pb_stand_ads, pb_crouch_ads, pb_rifle_idlea_ads ...) */
  legsAds(index) {
    const k = index & 0x1ff;
    let v = this.adsLegs.get(k);
    if (v === undefined) {
      const name = this.legsName ? this.legsName(k) : null;
      if (name == null) return false;                          // (the animations not loaded yet: asked again)
      v = /_ads/.test(name);
      this.adsLegs.set(k, v);
    }
    return v;
  }

  /** cumulative ground distance of a client's samples (the bob phase of the other players) */
  distOf(cl) {
    let D = this.dist.get(cl);
    if (D) return D;
    const P = this.M.d.positions[cl];
    D = new Float64Array(P ? P.t.length : 0);
    for (let i = 1; i < D.length; i++) {
      const d = Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]);
      D[i] = D[i - 1] + (d < 64 && P.t[i] - P.t[i - 1] < 300 ? d : 0);
    }
    this.dist.set(cl, D);
    return D;
  }

  /* ---------- per frame ---------- */
  /** the recorder's row at t when it is client cl's (and recent) -> index or -1 */
  recorderRow(cl, t) {
    const R = this.rec;
    if (!R) return -1;
    const i = lower(R.W.t, t);
    return i >= 0 && R.W.client[i] === cl && t - R.W.t[i] < 250 ? i : -1;
  }

  /** the hands model the server set for the recorder (playerState viewmodelIndex) or null */
  handsOf(cl, t) {
    const ri = this.recorderRow(cl, t);
    return ri >= 0 ? (this.M.d.viewHands || {})[this.rec.W.viewmodel[ri]] || null : null;
  }

  /** the state of client cl's first-person weapon at t.
   *  s: the client's sample (M.sampleAt); entryOf(name) -> the view model entry (viewmodel.js) or null;
   *  clipInfo(name) -> {duration, loop} or null.
   *  -> {weapon, entry, layers [{clip, time, weight, override}], offset {pos [f, l, u], rot [p, y, r] deg},
   *      ads (0..1), adsIn (aiming in), spread (deg), spread255 (aimSpreadScale), fuse (ms), recorder, action} */
  state(cl, t, s, entryOf, clipInfo) {
    const M = this.M;
    const ri = this.recorderRow(cl, t);
    const W = ri >= 0 ? this.rec.W : null;
    // the weapon: the recorder's (the offhand grenade while he throws it), else the sample's
    let wIdx = W ? W.weapon[ri] : s.weapon;
    const animIdx = W ? W.anim[ri] & 0x1ff : -1;
    if (W && W.state[ri] >= OFFHAND_STATES[0] && W.state[ri] <= OFFHAND_STATES[1] && W.offhand[ri] && animIdx !== 17 && animIdx !== 18) wIdx = W.offhand[ri];
    const weapon = M.weaponName(wIdx, t);
    const entry = weapon ? entryOf(weapon) : null;
    const out = { weapon, entry, layers: [], ads: 0, adsIn: true, spread: 0, spread255: 0, fuse: 0, recorder: !!W,
      offset: { pos: [0, 0, 0], rot: [0, 0, 0] }, action: null };
    if (!entry) return out;
    const A = entry.anims || {}, P = entry.params || {};
    // the playback rate of an animation and its duration at that rate (s)
    const rate = key => { const c = A[key] && clipInfo(A[key]), tm = STRETCH[key] && P[STRETCH[key]]; return c && tm > 0 && c.duration > 0 ? c.duration / tm : 1; };
    const dur = key => { const c = A[key] && clipInfo(A[key]); return c ? c.duration / rate(key) : null; };
    const has = key => !!(A[key] && clipInfo(A[key]));
    const idleKey = has('idle') ? 'idle' : null;

    // ---- the action: key, time (s) into it, the previous key and its time ----
    let key = null, time = 0, prevKey = null, prevTime = 0, sinceStart = 0;
    if (W) {
      key = WEAP_ANIMS[animIdx] || 'idle';
      const start = this.rec.start[ri];
      time = sinceStart = (t - start) / 1000;
      const f = this.rec.first[ri];
      if (f > 0 && W.client[f - 1] === cl && W.weapon[f - 1] === W.weapon[ri]) {
        prevKey = WEAP_ANIMS[W.anim[f - 1] & 0x1ff] || 'idle';
        prevTime = (t - this.rec.start[f - 1]) / 1000;
      }
      out.fuse = W.fuse[ri];
      out.friend = !!(W.friend && W.friend[ri]);       // the crosshair on a teammate (pm_flags 0x100000)
    } else {
      const E = this.eventsOf(cl);
      let k = lower(E.t, t);
      // events of another weapon (the one put away) do not drive this one
      while (k >= 0 && E.w[k] && E.w[k] !== weapon && E.ev[k] !== EV.PUTAWAY && E.ev[k] !== EV.PREP_OFFHAND) k--;
      if (k >= 0 && t - E.t[k] < 6000) {
        key = this.eventKey(E, k);
        time = sinceStart = (t - E.t[k]) / 1000;
        // the segmented reload (shotgun, bolt-action snipers): the rounds go in (the reload animation, looped) until reload_end
        if (key === 'reloadStart' && dur('reloadStart') != null && time > dur('reloadStart') && has('reload')) {
          const d0 = dur('reloadStart'), d1 = Math.max(0.1, dur('reload'));
          prevKey = 'reloadStart'; prevTime = time;
          time = (time - d0) % d1; key = 'reload'; sinceStart = time;
        } else if (k > 0 && E.t[k] - E.t[k - 1] < 3000 && (!E.w[k - 1] || E.w[k - 1] === weapon)) {
          prevKey = this.eventKey(E, k - 1);
          prevTime = (t - E.t[k - 1]) / 1000;
        }
      }
    }
    // ---- aiming down the sights ----
    let ads = 0, adsIn = true;
    if (W) {
      ads = W.ads[ri];
      if (ri + 1 < W.t.length && W.client[ri + 1] === cl && W.t[ri + 1] > W.t[ri]) {
        adsIn = W.ads[ri + 1] >= W.ads[ri];
        ads += (W.ads[ri + 1] - ads) * clamp01((t - W.t[ri]) / (W.t[ri + 1] - W.t[ri]));
      } else if (ri > 0) adsIn = W.ads[ri] >= W.ads[ri - 1];
    } else [ads, adsIn] = this.adsOther(cl, t, P);
    // the ADS variant of a shot / rechamber (the recorder's number already says it)
    if (!W && key && ADS_VARIANT[key] && ads > 0.5 && has(ADS_VARIANT[key])) key = ADS_VARIANT[key];
    if (!W && prevKey && ADS_VARIANT[prevKey] && ads > 0.5 && has(ADS_VARIANT[prevKey])) prevKey = ADS_VARIANT[prevKey];
    const actionOn = key && !LOOPED.has(key) && (dur(key) == null || time <= dur(key) || HOLD_END.has(key));
    // no sights during the other actions (the game leaves ADS for a reload, a switch, a melee)
    if (!W && actionOn && !FIRE_ANIMS.has(key) && !ADS_ANIMS.has(key) && key !== 'rechamber') ads = 0;
    out.ads = ads; out.adsIn = adsIn;

    // ---- the layers: the hip set (cross-faded) under the ADS layer ----
    const hip = [];
    const push = (list, k, tm, w) => {
      if (w <= 0.001) return;
      const name = A[k];
      const c = name && clipInfo(name);
      if (!c) { if (k !== 'idle' && idleKey) push(list, 'idle', t / 1000, w); return; }
      const ct = tm * rate(k);
      const x = c.loop || LOOPED.has(k) ? (c.duration > 0 ? ct % c.duration : 0) : Math.min(Math.max(0, ct), c.duration);
      list.push({ clip: name, time: x, weight: w, key: k });
    };
    const blendTime = FIRE_ANIMS.has(key) ? FIRE_BLEND : BLEND;
    if (key && key !== 'idle') {
      const d = dur(key);
      const ended = d != null && !LOOPED.has(key) && time > d && !HOLD_END.has(key);
      if (ended) {
        // back to the idle after the action's end
        const w = clamp01((time - d) / BLEND);
        push(hip, key, d, 1 - w); push(hip, idleKey || key, t / 1000, w);
      } else {
        const w = clamp01(sinceStart / blendTime);
        if (prevKey && w < 1) push(hip, prevKey, prevTime, 1 - w);
        else if (!prevKey && w < 1 && idleKey) push(hip, 'idle', t / 1000, 1 - w);
        push(hip, key, time, prevKey || idleKey ? w : 1);
      }
    } else push(hip, 'idle', t / 1000, 1);
    for (const l of hip) out.layers.push(l);
    // ADS: the weapon's adsUp animation moves only tag_torso - its first frame is the hip position of the hands
    // and the gun (the other animations leave tag_torso at the eye), its last the sights; it plays at the sights'
    // fraction (always: 0 = hip) over the other animations, which keep moving the rest
    if (has('adsUp')) {
      const ov = [];
      push(ov, 'adsUp', (dur('adsUp') || 0) * clamp01(ads), 1);
      for (const l of ov) out.layers.push(Object.assign(l, { override: true }));
    }
    out.action = key;
    out.noReticle = W ? NO_RETICLE_STATES.has(W.state[ri]) : !!(actionOn && NO_RETICLE_ACTIONS.has(key));

    // ---- the motion and the crosshair ----
    this.motion(out, cl, t, s, W, ri, P, ads);
    const sp = this.spread(cl, t, s, W, ri, P);
    out.spread = sp.deg; out.spread255 = sp.scale255;
    return out;
  }

  /** the animation of the other player's event k (put away followed by a raise of the same weapon within
   *  3 s: the quick drop of an offhand throw; the raise after it: quick) */
  eventKey(E, k) {
    const ev = E.ev[k];
    let key = EVENT_ANIMS[ev] || 'idle';
    if (ev === EV.PUTAWAY) {
      for (let j = k + 1; j < E.t.length && E.t[j] - E.t[k] < 3000; j++) if (E.ev[j] === EV.RAISE) { if (E.w[j] === E.w[k]) key = 'quickDrop'; break; }
    } else if (ev === EV.RAISE) {
      for (let j = k - 1; j >= 0 && E.t[k] - E.t[j] < 3000; j--) if (E.ev[j] === EV.PUTAWAY || E.ev[j] === EV.PREP_OFFHAND) { if (E.w[j] === E.w[k]) key = 'quickRaise'; break; }
    }
    return key;
  }

  /** the other player's ADS fraction: the legs animation's *_ads since its last change, at the weapon's
   *  transition times -> [fraction, aiming in] */
  adsOther(cl, t, P) {
    const Ps = this.M.d.positions[cl];
    if (!Ps || !Ps.legs) return [0, true];
    const i = lower(Ps.t, t);
    if (i < 0) return [0, true];
    const on = this.legsAds(Ps.legs[i]);
    let j = i;
    while (j > 0 && i - j < 40 && this.legsAds(Ps.legs[j - 1]) === on && t - Ps.t[j - 1] < 2000) j--;
    const since = (t - (j > 0 ? (Ps.t[j - 1] + Ps.t[j]) / 2 : Ps.t[j])) / 1000;
    const tin = P.adsTransInTime || 0.25, tout = P.adsTransOutTime || 0.25;
    return on ? [clamp01(since / tin), true] : [clamp01(1 - since / tout), false];
  }

  /** stance offsets (duckedOfs / proneOfs), the movement offsets (standMove / duckedMove / proneMove), the bob,
   *  the landing dip, the idle sway (hipIdleAmount / adsIdleAmount), the turn sway (sway*) and the gun kick
   *  (hipGunKick* / adsGunKick*) -> out.offset (model space: x forward, y left, z up; pitch > 0 down, yaw > 0
   *  left, roll) */
  motion(out, cl, t, s, W, ri, P, ads) {
    const M = this.M, pos = out.offset.pos, rot = out.offset.rot, v = k => P[k] || 0;
    // stance (0 stand .. 1 crouched, prone): the recorder's view height, else the flags of the last 250 ms
    let crouch = 0, prone = 0;
    if (W) {
      const vh = W.vh[ri];
      prone = clamp01((40 - vh) / 29); crouch = clamp01((60 - vh) / 20) - prone;
    } else {
      let n = 0;
      for (let k = 0; k <= 5; k++) { const x = M.sampleAt(cl, t - k * 50); if (!x) continue; n++; if (x.prone) prone++; else if (x.crouch) crouch++; }
      if (n) { prone /= n; crouch /= n; }
    }
    const stand = clamp01(1 - crouch - prone);
    // horizontal and vertical speed, on the ground
    let vx = 0, vy = 0, vz = 0, ground = true;
    if (W) {
      vx = W.vx[ri]; vy = W.vy[ri]; vz = W.vz[ri]; ground = W.ground[ri] !== ENTITYNUM_NONE;
    } else {
      const a = M.sampleAt(cl, t - 50);
      if (a) { vx = (s.x - a.x) * 20; vy = (s.y - a.y) * 20; vz = (s.z - a.z) * 20; }
      ground = Math.abs(vz) < 40;
    }
    const speed = Math.hypot(vx, vy), move = clamp01(speed / RUN_SPEED) * (ground ? 1 : 0.3);
    // stance offsets (the weapon file's, units) and movement offsets (scaled: the prone ones are large)
    pos[0] += crouch * v('duckedOfsF') + prone * v('proneOfsF');
    pos[1] -= crouch * v('duckedOfsR') + prone * v('proneOfsR');
    pos[2] += crouch * v('duckedOfsU') + prone * v('proneOfsU');
    const mv = (a, b, c) => stand * v(a) + crouch * v(b) + prone * v(c) * 0.05;
    const noAds = 1 - ads;
    pos[0] += move * noAds * mv('standMoveF', 'duckedMoveF', 'proneMoveF');
    pos[1] -= move * noAds * mv('standMoveR', 'duckedMoveR', 'proneMoveR');
    pos[2] += move * noAds * mv('standMoveU', 'duckedMoveU', 'proneMoveU');
    rot[0] += move * noAds * mv('standRotP', 'duckedRotP', 'proneRotP');
    rot[1] += move * noAds * mv('standRotY', 'duckedRotY', 'proneRotY');
    rot[2] += move * noAds * mv('standRotR', 'duckedRotR', 'proneRotR');
    // bob (BG_CalculateWeaponAngles): angles from the bob cycle, the speed and the stance's bg_bobAmplitude*;
    // less while aiming down the sights (adsBobFactor), none at full ADS with a scope
    const B = this.bobInputs(cl, t, s, W, ri, speed, crouch, prone), ph = B.cycle + Math.PI / 4;
    const bs = B.speed * 0.16, a1 = Math.min(10, B.amp * bs), a2 = Math.min(10, 1.5 * B.amp * bs);
    const bp = -0.75 * (Math.sin(4 * ph + Math.PI / 2) * 0.2 + Math.sin(2 * ph)) * a1, by = -Math.sin(ph) * a1;
    const br = Math.min(0, Math.sin(ph - 0.4712389) * a2);
    let bk = ads ? 1 - (1 - (P.adsBobFactor != null ? P.adsBobFactor : 1)) * ads : 1;
    if (out.entry.strings && out.entry.strings.adsOverlayShader) bk *= 1 - ads;
    rot[0] += bp * bk; rot[1] += by * bk; rot[2] += br * bk;
    // the landing dip: a fall that ended within the last 0.6 s
    const land = this.landing(cl, t, W, ri);
    if (land) {
      const k = Math.min(1, land.speed / 350) * Math.sin(Math.PI * Math.min(1, land.dt / 0.3)) * Math.exp(-land.dt * 4);
      pos[2] -= 2.2 * k; rot[0] += 2.5 * k;
    }
    // the idle sway (the weapon file's amount and speed; crouched / prone scaled); holding the breath (scoped) calms it
    const breath = W ? clamp01(W.breath[ri]) : 0;
    const idleAmt = (ads > 0.5 ? v('adsIdleAmount') : v('hipIdleAmount')) * (stand + crouch * (P.idleCrouchFactor || 1) + prone * (P.idleProneFactor || 1)) * (1 - 0.8 * breath);
    const idleSpd = (ads > 0.5 ? P.adsIdleSpeed : P.hipIdleSpeed) || 1, ts = t / 1000 * idleSpd;
    rot[0] += idleAmt * 0.012 * Math.sin(ts * 1.1);
    rot[1] += idleAmt * 0.012 * Math.sin(ts * 0.7 + 1.3);
    // leaning: the gun slides along the right vector of (0, 0, -2 f), (1 - ADS) x f x 1.6 units (CG_CalculateWeaponPosition;
    // not at full ADS)
    const lf = s && s.lean ? s.lean * (2 - Math.abs(s.lean)) : 0;
    if (lf && ads < 1) {
      const d = (1 - ads) * lf * 1.6, r = -2 * lf * Math.PI / 180;
      pos[1] -= Math.cos(r) * d; pos[2] -= Math.sin(r) * d;
    }
    // the turn sway (the gun lags behind the view)
    const sw = this.sway(cl, t, P, ads, !!(out.entry.strings && out.entry.strings.adsOverlayShader));
    rot[0] -= sw.pitch; rot[1] -= sw.yaw; pos[1] -= sw.horiz; pos[2] -= sw.vert;
    // the gun kick: the shots of the last 1.2 s through the weapon's kick spring
    const k = this.kick(cl, t, P, ads);
    rot[0] -= k[0]; rot[1] += k[1];
  }

  /** the bob's inputs: the cycle (rad, BG_GetBobCycle: the recorder's bobCycle / 255 * 2 pi, else the distance
   *  walked, one cycle per 2 steps), the horizontal speed and the stance's amplitude (bg_bobAmplitudeStanding
   *  0.007, Ducked 0.0075, Prone 0.03: the view height 40 / 11, else the stance mix) */
  bobInputs(cl, t, s, W, ri, speed, crouch, prone) {
    const M = this.M;
    let cycle;
    if (W) {
      let b = W.bob[ri];
      if (ri + 1 < W.t.length && W.client[ri + 1] === cl && W.t[ri + 1] > W.t[ri]) {
        let d = W.bob[ri + 1] - b; if (d < -128) d += 256;
        b += d * clamp01((t - W.t[ri]) / (W.t[ri + 1] - W.t[ri]));
      }
      cycle = b / 255 * Math.PI * 2 + Math.PI * 2;
    } else {
      const Ps = M.d.positions[cl], D = this.distOf(cl), i = lower(Ps.t, t);
      let d = i >= 0 ? D[i] : 0;
      if (i >= 0 && i + 1 < Ps.t.length && Ps.t[i + 1] > Ps.t[i]) d += (D[i + 1] - D[i]) * clamp01((t - Ps.t[i]) / (Ps.t[i + 1] - Ps.t[i]));
      cycle = d / 96 * Math.PI;
    }
    const amp = W ? (W.vh[ri] === 40 ? BOB_AMP[1] : W.vh[ri] === 11 ? BOB_AMP[2] : BOB_AMP[0])
      : (1 - crouch - prone) * BOB_AMP[0] + crouch * BOB_AMP[1] + prone * BOB_AMP[2];
    return { cycle, speed, amp };
  }

  /** the first-person camera's bob at t (CG_CalcViewValues: BG_GetVerticalBobFactor / HorizontalBobFactor, at
   *  most bg_bobMax 8 units) -> {up, right} (units) */
  viewBob(cl, t, s) {
    const ri = this.recorderRow(cl, t), W = ri >= 0 ? this.rec.W : null;
    let speed = 0, crouch = 0, prone = 0;
    if (W) speed = Math.hypot(W.vx[ri], W.vy[ri]);
    else {
      const a = this.M.sampleAt(cl, t - 50);
      if (a) speed = Math.hypot(s.x - a.x, s.y - a.y) * 20;
      prone = s.prone ? 1 : 0; crouch = !s.prone && s.crouch ? 1 : 0;
    }
    const B = this.bobInputs(cl, t, s, W, ri, speed, crouch, prone), a = Math.min(BOB_MAX, B.speed * B.amp);
    return { up: (Math.sin(4 * B.cycle + Math.PI / 2) * 0.2 + Math.sin(2 * B.cycle)) * 0.75 * a, right: Math.sin(B.cycle) * a };
  }

  /** the turn sway at t, as the game's BG_CalculateWeaponPosition_Sway tracks it frame by frame (60 frames / s
   *  here, from the view angles of the samples over the last 1.5 s): the view's change per 1/60 s, held within
   *  swayMaxAngle, times swayPitchScale / YawScale (angles) and swayVertScale / HorizScale (offset) is the target
   *  the sway follows at swayLerpSpeed (DiffTrack); while aiming down the sights the ads* values (by the ADS
   *  fraction), none for a scoped weapon -> {pitch, yaw (deg), horiz, vert (units)} */
  sway(cl, t, P, ads, scoped) {
    const out = { pitch: 0, yaw: 0, horiz: 0, vert: 0 };
    if (ads > 0 && scoped) return out;
    const mix = (k, a) => (P[k] || 0) + ((P[a] || 0) - (P[k] || 0)) * (P.aimDownSight ? ads : 0);
    const max = mix('swayMaxAngle', 'adsSwayMaxAngle'), lerp = mix('swayLerpSpeed', 'adsSwayLerpSpeed');
    const sp = mix('swayPitchScale', 'adsSwayPitchScale'), sy = mix('swayYawScale', 'adsSwayYawScale');
    const sh = mix('swayHorizScale', 'adsSwayHorizScale'), sv = mix('swayVertScale', 'adsSwayVertScale');
    if (!lerp) return out;
    const dt = 1 / 60, track = (tgt, cur) => { const d = tgt - cur, step = d * lerp * dt; return Math.abs(step) > Math.abs(d) ? tgt : cur + step; };
    let prev = this.M.sampleAt(cl, t - 1500);
    for (let k = t - 1500 + dt * 1000; k <= t + 0.5; k += dt * 1000) {
      const s = this.M.sampleAt(cl, Math.min(k, t));
      if (!s || !prev) { prev = s; continue; }
      let dy = s.yaw - prev.yaw; dy = ((dy + 540) % 360) - 180;
      const dp = Math.max(-max, Math.min(max, s.pitch - prev.pitch)), dyc = Math.max(-max, Math.min(max, dy));
      out.horiz = track(sh * dyc, out.horiz); out.vert = track(sv * dp, out.vert);
      out.pitch = track(sp * dp, out.pitch); out.yaw = track(sy * dyc, out.yaw);
      prev = s;
    }
    return out;
  }

  /** a fall that ended within 0.6 s before t -> {dt (s since), speed (units / s)} or null */
  landing(cl, t, W, ri) {
    if (W) {
      for (let j = ri; j > 0 && t - W.t[j] < 600 && W.client[j - 1] === cl; j--) {
        if (W.ground[j] !== ENTITYNUM_NONE && W.ground[j - 1] === ENTITYNUM_NONE) return W.vz[j - 1] < -120 ? { dt: (t - W.t[j]) / 1000, speed: -W.vz[j - 1] } : null;
      }
      return null;
    }
    const Ps = this.M.d.positions[cl], i = lower(Ps.t, t);
    for (let j = i; j > 1 && t - Ps.t[j] < 600; j--) {
      const dt0 = (Ps.t[j - 1] - Ps.t[j - 2]) / 1000, dt1 = (Ps.t[j] - Ps.t[j - 1]) / 1000;
      if (!(dt0 > 0 && dt1 > 0) || dt0 > 0.2 || dt1 > 0.2) continue;
      const v0 = (Ps.z[j - 1] - Ps.z[j - 2]) / dt0, v1 = (Ps.z[j] - Ps.z[j - 1]) / dt1;
      if (v0 < -150 && v1 > -30) return { dt: (t - Ps.t[j - 1]) / 1000, speed: -v0 };
    }
    return null;
  }

  /** the gun kick's angles (deg: pitch up, yaw) at t, as the game's BG_CalculateWeaponPosition_GunRecoil_
   *  SingleAngle integrates them: every shot adds a speed in the weapon file's range (hip / adsGunKickPitchMin ..
   *  Max, YawMin .. Max; a random number per shot, the same after every seek); per step the angle moves by the
   *  speed (held within gunMaxPitch / gunMaxYaw), a constant acceleration (GunKickAccel) pulls it back, the speed
   *  decays by GunKickSpeedDecay (a share per second) and GunKickStaticDecay (deg / s), held within SpeedMax;
   *  below 0.25 deg and 1 deg / s both rest. Integrated from the shots of the last 1.5 s in 5 ms steps. */
  kick(cl, t, P, ads) {
    const shots = this.shotsOf(cl);
    const k = lower(shots, t);
    let j = k;
    while (j >= 0 && shots[j] > t - 1500) j--;
    if (k < 0 || j === k) return [0, 0];
    const pre = ads > 0.5 ? 'adsGunKick' : 'hipGunKick', g = n => P[pre + n] || 0;
    const accel = g('Accel'), smax = g('SpeedMax'), sdec = g('SpeedDecay'), stat = g('StaticDecay');
    const max = [P.gunMaxPitch || 0, P.gunMaxYaw || 0];
    const ang = [0, 0], spd = [0, 0], dt = 0.005;
    let tm = shots[j + 1], next = j + 1;
    while (tm < t) {
      while (next <= k && shots[next] <= tm) {
        spd[0] += g('PitchMin') + (g('PitchMax') - g('PitchMin')) * hash01(shots[next] * 7 + cl);
        spd[1] += g('YawMin') + (g('YawMax') - g('YawMin')) * hash01(shots[next] * 13 + cl);
        next++;
      }
      for (let a = 0; a < 2; a++) {
        if (Math.abs(ang[a]) <= 0.25 && Math.abs(spd[a]) < 1) { ang[a] = 0; spd[a] = 0; continue; }
        ang[a] += spd[a] * dt;
        if (ang[a] > max[a]) { ang[a] = max[a]; if (spd[a] > 0) spd[a] = 0; }
        else if (ang[a] < -max[a]) { ang[a] = -max[a]; if (spd[a] < 0) spd[a] = 0; }
        if (ang[a] > 0) spd[a] -= accel * dt; else if (ang[a] < 0) spd[a] += accel * dt;
        spd[a] -= sdec * spd[a] * dt;
        spd[a] = spd[a] > 0 ? Math.max(0, spd[a] - stat * dt) : Math.min(0, spd[a] + stat * dt);
        spd[a] = Math.max(-smax, Math.min(smax, spd[a]));
      }
      tm += dt * 1000;
    }
    return ang;
  }

  /** the shot times of a client (fire events: the recorder's and the others') */
  shotsOf(cl) {
    const key = 'shots' + cl;
    if (!this[key]) {
      const a = [];
      for (const r of this.M.d.weapEvents || []) if (r[1] === cl && SHOT_EVENTS.has(r[2])) a.push(r[0]);
      this[key] = Int32Array.from(a);
    }
    return this[key];
  }

  /** the crosshair's spread: the recorder's aimSpreadScale between the stance's minimum and maximum (by the view
   *  height, as the game's BG_GetSpreadForWeapon); the others: the stance by the flags, the scale from the speed
   *  and the recent shots (hipSpreadMoveAdd / FireAdd / DecayRate) -> {deg, scale255} */
  spread(cl, t, s, W, ri, P) {
    const v = k => P[k] || 0;
    let mn, mx, scale;
    if (W) {
      const vh = W.vh[ri];
      if (vh <= 40) { const f = (vh - 11) / 29; mn = (v('hipSpreadDuckedMin') - v('hipSpreadProneMin')) * f + v('hipSpreadProneMin'); mx = (v('hipSpreadDuckedMax') - v('hipSpreadProneMax')) * f + v('hipSpreadProneMax'); }
      else { const f = (vh - 40) / 20; mn = (v('hipSpreadStandMin') - v('hipSpreadDuckedMin')) * f + v('hipSpreadDuckedMin'); mx = (v('hipSpreadMax') - v('hipSpreadDuckedMax')) * f + v('hipSpreadDuckedMax'); }
      let a = W.spread[ri];
      if (ri + 1 < W.t.length && W.client[ri + 1] === cl && W.t[ri + 1] > W.t[ri]) a += (W.spread[ri + 1] - a) * clamp01((t - W.t[ri]) / (W.t[ri + 1] - W.t[ri]));
      scale = a / 255;
    } else {
      [mn, mx] = s.prone ? [v('hipSpreadProneMin'), v('hipSpreadProneMax')] : s.crouch ? [v('hipSpreadDuckedMin'), v('hipSpreadDuckedMax')] : [v('hipSpreadStandMin'), v('hipSpreadMax')];
      const a = this.M.sampleAt(cl, t - 100);
      const speed = a ? Math.hypot(s.x - a.x, s.y - a.y) * 10 : 0;
      let fire = 0;
      const shots = this.shotsOf(cl), decay = (s.prone ? v('hipSpreadProneDecay') : s.crouch ? v('hipSpreadDuckedDecay') : v('hipSpreadDecayRate')) || 4;
      for (let k = lower(shots, t); k >= 0 && t - shots[k] < 2000; k--) fire += v('hipSpreadFireAdd') * 0.25 * Math.exp(-decay * (t - shots[k]) / 1000);
      scale = clamp01(clamp01(speed / RUN_SPEED) * Math.min(1, v('hipSpreadMoveAdd') / 5) + fire);
    }
    return { deg: (mx - mn) * scale + mn, scale255: scale * 255 };
  }
}
