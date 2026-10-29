/* One pass over the demo: collects the raw facts the analysis needs.
 * Times are absolute server times here; build.js converts them to "ms since the first snapshot".
 *
 * Sources per snapshot (see PLAN.md):
 * - the player state: the recording client, or the player it follows (pm_flags FOLLOW) - position,
 *   view angles, stance, weapon, health; free spectating (pm_type 4) and dead (6) are not positions
 * - the player entities (eType 1, number = client): every other player the server sends
 * - corpses (eType 2), missiles (eType 4: grenades), event entities (eType 10 + event: obituary,
 *   explosions, bullet impacts ...)
 * - the client states: name and team of every client
 * - the server commands (chat, messages, scores, round restarts, config string updates) */
C2.define('collect', function (C2) {
  'use strict';
  const { u2f } = C2.msg;
  const { ES, CS, PS } = C2.delta;
  const K = C2.constants;
  const { decode } = C2.servercmd;
  const EV = K.EV;

  const E = {
    type: ES.eType, flags: ES.eFlags, posType: ES['pos.trType'], posTime: ES['pos.trTime'],
    px: ES['pos.trBase[0]'], py: ES['pos.trBase[1]'], pz: ES['pos.trBase[2]'],
    vx: ES['pos.trDelta[0]'], vy: ES['pos.trDelta[1]'], vz: ES['pos.trDelta[2]'],
    pitch: ES['apos.trBase[0]'], yaw: ES['apos.trBase[1]'], roll: ES['apos.trBase[2]'],
    other: ES.otherEntityNum, attacker: ES.attackerEntityNum, parm: ES.eventParm, weapon: ES.weapon,
    seq: ES.eventSequence, events: [0, 1, 2, 3].map(i => ES['events[' + i + ']']),
    parms: [0, 1, 2, 3].map(i => ES['eventParms[' + i + ']']), surf: ES.surfType, index: ES.index,
    legs: ES.legsAnim, torso: ES.torsoAnim, lean: ES.leanf, clientNum: ES.clientNum, time: ES.time, time2: ES.time2,
    scale: ES.scale, delay: ES['angles2[1]'], dir: [0, 1, 2].map(i => ES['origin2[' + i + ']']),
    torsoPitch: ES.fTorsoPitch, waistPitch: ES.fWaistPitch, ground: ES.groundEntityNum,
    aim: [ES['angles2[0]'], ES['angles2[1]']]
  };
  const P = {
    client: PS.clientNum, pmType: PS.pm_type, pmFlags: PS.pm_flags, eFlags: PS.eFlags, weapon: PS.weapon,
    ox: PS['origin[0]'], oy: PS['origin[1]'], oz: PS['origin[2]'], pitch: PS['viewangles[0]'], yaw: PS['viewangles[1]'],
    seq: PS.eventSequence, events: [0, 1, 2, 3].map(i => PS['events[' + i + ']']),
    parms: [0, 1, 2, 3].map(i => PS['eventParms[' + i + ']']), legs: PS.legsAnim, torso: PS.torsoAnim,
    lean: PS.leanf, viewHeight: PS.viewHeightCurrent, damageEvent: PS.damageEvent, damageYaw: PS.damageYaw,
    damageCount: PS.damageCount,
    // the first-person weapon (viewanim.js): the view animation (index + 0x200 restart toggle), weapon state,
    // offhand grenade, ADS fraction, crosshair spread (0..255), hands model, bob cycle, velocity, ground
    weapAnim: PS.weapAnim, weaponState: PS.weaponstate, offhand: PS.offHandIndex, ads: PS.fWeaponPosFrac,
    spread: PS.aimSpreadScale, viewmodel: PS.viewmodelIndex, bob: PS.bobCycle, ground: PS.groundEntityNum,
    vel: [0, 1, 2].map(i => PS['velocity[' + i + ']']), breath: PS.holdBreathScale, fuse: PS.grenadeTimeLeft,
    // the HUD (hud.js): the weapons owned (two bit fields)
    weapBits: [PS['weapons[0]'], PS['weapons[1]']]
  };
  const C = { team: CS.team, model: CS.modelindex, name: [0, 4, 8, 12, 16, 20, 24, 28].map(i => CS['name[' + i + ']']),
    attach: [0, 1, 2, 3, 4, 5].map(i => CS['attachModelIndex[' + i + ']']) };
  const SHOT_EVENTS = new Set([EV.FIRE_WEAPON, EV.FIRE_WEAPONB, EV.FIRE_WEAPON_LASTSHOT, EV.FIRE_WEAPON_MG42]);
  // the weapon events of every player (EV_RELOAD .. EV_USE_OFFHAND): what the first-person weapon of a
  // player without a player state plays (viewanim.js)
  const WEAP_EVENTS = new Set([EV.RELOAD, EV.RELOAD_FROM_EMPTY, EV.RELOAD_START, EV.RELOAD_END, EV.RAISE_WEAPON, EV.PUTAWAY_WEAPON,
    EV.PULLBACK_WEAPON, EV.FIRE_WEAPON, EV.FIRE_WEAPONB, EV.FIRE_WEAPON_LASTSHOT, EV.RECHAMBER_WEAPON, EV.MELEE_SWIPE, EV.FIRE_MELEE,
    EV.PREP_OFFHAND, EV.USE_OFFHAND]);
  const EXPLOSIONS = new Set([EV.GRENADE_EXPLODE, EV.ROCKET_EXPLODE, EV.ROCKET_EXPLODE_NOMARKS, EV.CUSTOM_EXPLODE,
    EV.CUSTOM_EXPLODE_NOMARKS]);
  const IMPACTS = new Set([EV.BULLET_HIT_SMALL, EV.BULLET_HIT_LARGE, EV.SHOTGUN_HIT, EV.BULLET_HIT_AP]);
  const CLIENT_HITS = new Set([EV.BULLET_HIT_CLIENT_SMALL, EV.BULLET_HIT_CLIENT_LARGE]);

  /* position flags */
  // LINKED: held by an entity (zPAM / stock S&D link a planting / defusing player to the bomb trigger):
  // the POV's pm_type NORMAL_LINKED; another player: no ground entity (also true in the air)
  // TURRET: on a mounted MG (EF_USETURRET) - the gun is the turret, the player's own weapon is not drawn
  const PF = { TRANSMITTED: 1, CROUCH: 2, PRONE: 4, FIRING: 8, DEAD: 16, FROM_PS: 32, LINKED: 64, TURRET: 128 };
  const ENTITYNUM_NONE = 1023;

  class PosTrack {
    constructor() {
      this.t = []; this.x = []; this.y = []; this.z = []; this.yaw = []; this.pitch = []; this.flags = []; this.weapon = [];
      this.legs = []; this.torso = []; this.lean = []; this.torsoPitch = []; this.waistPitch = [];
    }
    push(t, x, y, z, yaw, pitch, flags, weapon, legs, torso, lean, torsoPitch = 0, waistPitch = 0) {
      const n = this.t.length;
      if (n && this.t[n - 1] === t) return;               // one sample per snapshot time
      this.t.push(t); this.x.push(x); this.y.push(y); this.z.push(z);
      this.yaw.push(yaw); this.pitch.push(pitch); this.flags.push(flags); this.weapon.push(weapon);
      this.legs.push(legs | 0); this.torso.push(torso | 0); this.lean.push(lean || 0);
      this.torsoPitch.push(torsoPitch || 0); this.waistPitch.push(waistPitch || 0);    // (prone on a slope)
    }
  }

  /** the 8 name words of a client state -> string (latin-1) */
  function clientName(st) {
    let s = '';
    for (const slot of C.name) {
      const v = st[slot];
      for (let k = 0; k < 4; k++) {
        const ch = (v >>> (8 * k)) & 255;
        if (!ch) return s;
        s += String.fromCharCode(ch);
      }
    }
    return s;
  }

  function createCollector() {
    const c = {
      gamestate: null,
      cs: new Map(),                // current config strings
      csInitial: null,
      gamestates: [],               // {t (null = start), configstrings}
      csChanges: [],                // {t, index, old, value}
      commands: [],                 // {t, seq, text, d}
      names: new Map(),             // client -> {name, clantag}
      nameHistory: [],              // {t, client, name, clantag, source}
      teamTimeline: [],             // {t, client, team}
      modelTimeline: [],            // {t, client, model, attach: [model indices]}
      slotEvents: [],               // {t, client, kind: 'connected'|'disconnected'}
      kills: [],                    // {t, victim, attacker, parm, victimPos, attackerPos, attackerWeapon}
      tracks: new Map(),            // client -> PosTrack
      corpses: [],                  // {client, t0, t1, x, y, z, yaw, legs, torso}
      grenades: new Map(),          // key -> grenade
      grenadeOrder: [],
      detonations: [],              // explosions without a matching grenade
      scoreboards: [],              // {t, axis, allies, entries}
      teamScores: [],               // {t, axis, allies} after each G / H
      restarts: [],                 // server times of 'n' (fast restart = new round)
      levelStarts: [],              // {t, value} of config string 13 (the round's start time)
      hudTimers: [],                // {t, type, end} HUD countdowns seen by the POV (round clock, strat time)
      bombModels: [],               // {t, x, y, z} the planted bomb (script model xmodel/mp_tntbomb) when it appears
      issues: [],
      firstTime: null, lastTime: null,
      snapshots: 0,
      povTimeline: [],              // {t, client} changes of the followed client
      povStates: [],                // {t, client, health, pmType, weapon, damageCount}
      shots: new Map(),             // client -> [t] of fire events
      // the recording player's weapon per snapshot (the player state: viewanim.js)
      psWeapon: { t: [], client: [], anim: [], state: [], weapon: [], offhand: [], ads: [], spread: [], viewmodel: [], bob: [],
        vx: [], vy: [], vz: [], ground: [], vh: [], breath: [], fuse: [], friend: [],
        pmType: [], health: [], ammoRef: [], objRef: [], hudRef: [] },
      // the recording player's HUD state (hud.js): the distinct ammo states ([weapons bits 0, 1, ammo[64],
      // clip[64]]), objective lists and HUD element lists (the elements in use, current then archival, after a
      // header [count current, count archival]) psWeapon's rows point to
      psTables: { ammo: [], obj: [], hud: [] },
      weapEvents: [],               // [t, client, event, weapon] (WEAP_EVENTS)
      impacts: [],                  // [t, x, y, z, dir, surfType, weapon, event]
      hitsTaken: [],                // bullet hits on clients: {t, victim, attacker, weapon}
      playFx: [],                   // [t, x, y, z, effect id]
      // the looping effects the server runs (playLoopedFx: the maps' ambient smoke, dust ... when the
      // server allows them - zPAM's rules switch them off): num -> {fx: config string index, delay (ms),
      // x y z, dir, t0, t1 (first / last seen)}
      loopFx: new Map(),
      // the sounds of the 3D view: [t, kind, a, b, x, y, z, entity]; kind 1 shot (a = weapon index),
      // 2 footstep (a = surface, b = 0 run / 1 walk / 2 prone), 3 landing (a = surface), 4 melee (b = 1 hit),
      // 5 explosion (a = weapon index, b = surface, smoke: custom explode), 6 bullet impact (a = surface,
      // b = 1 large), 7 sound alias (a = sound index: config string 590 + a)
      sndEvents: [],
      scriptEnts: [],
      // the mounted MGs (eType turret): num -> {x, y, z, yaw (the stand), t: [], pitch: [], aimYaw: []} - the gun's
      // aim relative to the stand (angles2: CG_UpdateTurretBones turns tag_aim / tag_aim_animated by it; idle
      // ones rest at pitch -20); a sample when it changes, plus the unchanged one before (for interpolation)
      turrets: new Map()
    };
    const track = cl => { let t = c.tracks.get(cl); if (!t) c.tracks.set(cl, t = new PosTrack()); return t; };
    const addTime = (map, cl, t) => { let a = map.get(cl); if (!a) map.set(cl, a = []); if (a[a.length - 1] !== t) a.push(t); };
    const SURF = K.SURFACES.length;
    /** the sound of a player event ev at x y z (entity number src) */
    const playerSound = (ev, parm, weapon, x, y, z, src, t) => {
      if (SHOT_EVENTS.has(ev)) c.sndEvents.push([t, 1, weapon, 0, x, y, z, src]);
      else if (ev >= EV.FOOTSTEP_RUN_DEFAULT && ev < EV.JUMP_DEFAULT) {
        const k = ev - EV.FOOTSTEP_RUN_DEFAULT;
        c.sndEvents.push([t, 2, k % SURF, Math.floor(k / SURF), x, y, z, src]);
      } else if (ev >= EV.LANDING_DEFAULT && ev < EV.FOLIAGE_SOUND) c.sndEvents.push([t, 3, (ev - EV.LANDING_DEFAULT) % SURF, 0, x, y, z, src]);
      else if (ev === EV.MELEE_SWIPE || ev === EV.MELEE_HIT || ev === EV.MELEE_MISS) c.sndEvents.push([t, 4, weapon, ev === EV.MELEE_HIT ? 1 : 0, x, y, z, src]);
      else if (ev === EV.SOUND_ALIAS || ev === EV.SOUND_ALIAS_AS_MASTER) c.sndEvents.push([t, 7, parm, 0, x, y, z, src]);
    };
    let prevEvents = new Set();     // event entities of the previous snapshot (number:eType:time)
    let prevEntities = new Map();   // number -> state of the previous snapshot
    const lastClient = new Map();   // client -> client state
    let lastPsClient = -1, prevPsSeq = null, prevPsClient = -1, lastScores = { axis: null, allies: null };
    const lastWeapon = new Map();   // client -> weapon index held (last sample)
    const lastPos = new Map();      // client -> [t, x, y, z]
    const corpseRec = new Map();    // corpse entity number -> record
    const missileKey = new Map();   // entity number -> grenade key

    function setName(client, name, t, source) {
      const prev = c.names.get(client);
      if (prev && prev.name === name) return;
      c.names.set(client, { name, clantag: '' });
      c.nameHistory.push({ t, client, name, clantag: '', source });
    }
    function csUpdate(t, index, value) {
      if (index == null) return;
      const old = c.cs.has(index) ? c.cs.get(index) : null;
      c.cs.set(index, value);
      c.csChanges.push({ t, index, old, value });
      if (index === K.CS.LEVEL_START_TIME) c.levelStarts.push({ t, value: parseInt(value, 10) });
    }

    // HUD countdowns (hud element type 7 = timer down; the round clock and zPAM's strat time are level
    // HUD elements, so every client gets them): each new one once, with its end time
    const HE = C2.delta.HE, NH = C2.delta.NH, timerSeen = new Set();
    function doHudTimers(ps, t) {
      for (const arr of [ps.hudCurrent, ps.hudArchival]) {
        if (!arr) continue;
        for (let i = 0; i < C2.delta.MAX_HUDELEMS; i++) {
          const type = arr[i * NH + HE.type], end = arr[i * NH + HE.time];
          if (type !== 7 || !end) continue;
          const key = type + '|' + end;
          if (timerSeen.has(key)) continue;
          timerSeen.add(key);
          c.hudTimers.push({ t, type, end });
        }
      }
    }

    // the HUD tables (psTables): the player state shares a part that did not change with the previous one,
    // so a new array is a candidate for a new entry (the same content again reuses the entry)
    const psLast = { ammo: null, clip: null, w0: null, w1: null, obj: null, cur: null, arc: null, refs: [0, 0, 0] };
    const psKeys = { ammo: new Map(), obj: new Map(), hud: new Map() };
    function psRef(kind, arr) {
      const key = arr.join(',');
      let r = psKeys[kind].get(key);
      if (r == null) { r = c.psTables[kind].length; c.psTables[kind].push(arr); psKeys[kind].set(key, r); }
      return r;
    }
    function hudUsed(a) {
      let n = 0;
      while (n < C2.delta.MAX_HUDELEMS && a[n * NH + HE.type]) n++;
      return n;
    }
    function doPsTables(ps, f) {
      const L = psLast, W = c.psWeapon;
      const w0 = f[P.weapBits[0]], w1 = f[P.weapBits[1]];
      if (ps.ammo !== L.ammo || ps.clip !== L.clip || w0 !== L.w0 || w1 !== L.w1) {
        const a = new Int32Array(130);
        a[0] = w0; a[1] = w1; a.set(ps.ammo.subarray(0, 64), 2); a.set(ps.clip.subarray(0, 64), 66);
        L.refs[0] = psRef('ammo', a); L.ammo = ps.ammo; L.clip = ps.clip; L.w0 = w0; L.w1 = w1;
      }
      if (ps.objectives !== L.obj) { L.refs[1] = psRef('obj', Int32Array.from(ps.objectives)); L.obj = ps.objectives; }
      if (ps.hudCurrent !== L.cur || ps.hudArchival !== L.arc) {
        const nc = hudUsed(ps.hudCurrent), na = hudUsed(ps.hudArchival);
        const a = new Int32Array(2 + (nc + na) * NH);
        a[0] = nc; a[1] = na; a.set(ps.hudCurrent.subarray(0, nc * NH), 2); a.set(ps.hudArchival.subarray(0, na * NH), 2 + nc * NH);
        L.refs[2] = psRef('hud', a); L.cur = ps.hudCurrent; L.arc = ps.hudArchival;
      }
      W.ammoRef.push(L.refs[0]); W.objRef.push(L.refs[1]); W.hudRef.push(L.refs[2]);
    }

    function onSnapshot(s) {
      const t = s.serverTime;
      if (c.firstTime === null) c.firstTime = t;
      if (c.lastTime !== null && t < c.lastTime) c.issues.push({ t, text: 'server time went backwards (' + c.lastTime + ' -> ' + t + ')' });
      c.lastTime = t;
      c.snapshots++;
      doClients(s, t);
      doPlayerState(s, t);
      doHudTimers(s.ps, t);
      doEntities(s, t);
    }

    function doClients(s, t) {
      const seen = new Set();
      for (const st of s.clients) {
        const cl = st[0];
        seen.add(cl);
        const prev = lastClient.get(cl);
        if (!prev) c.slotEvents.push({ t, client: cl, kind: 'connected' });
        if (prev !== st) {
          setName(cl, clientName(st), t, 'clientstate');
          if (!prev || prev[C.team] !== st[C.team]) c.teamTimeline.push({ t, client: cl, team: st[C.team] });
          if (!prev || prev[C.model] !== st[C.model] || C.attach.some(a => prev[a] !== st[a])) {
            c.modelTimeline.push({ t, client: cl, model: st[C.model], attach: C.attach.map(a => st[a]) });
          }
        }
        lastClient.set(cl, st);
      }
      for (const cl of [...lastClient.keys()]) {
        if (seen.has(cl)) continue;
        lastClient.delete(cl);
        c.slotEvents.push({ t, client: cl, kind: 'disconnected' });
        c.teamTimeline.push({ t, client: cl, team: -1 });
      }
    }

    function doPlayerState(s, t) {
      const f = s.ps.f;
      const cl = f[P.client];
      const pmType = f[P.pmType], health = s.ps.stats[0];
      if (cl !== lastPsClient) { c.povTimeline.push({ t, client: cl }); lastPsClient = cl; }
      const lastState = c.povStates[c.povStates.length - 1];
      if (!lastState || lastState.client !== cl || lastState.health !== health || lastState.pmType !== pmType ||
        lastState.weapon !== f[P.weapon] || lastState.damageCount !== f[P.damageCount]) {
        c.povStates.push({ t, client: cl, health, pmType, weapon: f[P.weapon], damageCount: f[P.damageCount] });
      }
      // events of the player state (EV_FIRE_WEAPON ...), as CG_CheckPlayerstateEvents
      if (cl === prevPsClient && prevPsSeq != null) {
        const seq = f[P.seq];
        const n = (seq - prevPsSeq) & 255;
        if (n > 0 && n <= 4) {
          // BG_AddPredictableEventToPlayerstate: events[sequence & 3] = event, then sequence++
          for (let i = prevPsSeq; i < prevPsSeq + n; i++) {
            const ev = f[P.events[i & 3]] & 0xff;
            if (SHOT_EVENTS.has(ev)) addTime(c.shots, cl, t);
            if (WEAP_EVENTS.has(ev)) c.weapEvents.push([t, cl, ev, f[P.weapon]]);
            playerSound(ev, f[P.parms[i & 3]] & 0xff, f[P.weapon], u2f(f[P.ox]), u2f(f[P.oy]), u2f(f[P.oz]), cl, t);
          }
        }
      }
      prevPsSeq = f[P.seq]; prevPsClient = cl;
      if (cl < 0 || cl >= 64) return;
      const W = c.psWeapon;
      W.t.push(t); W.client.push(cl); W.anim.push(f[P.weapAnim]); W.state.push(f[P.weaponState]); W.weapon.push(f[P.weapon]);
      W.offhand.push(f[P.offhand]); W.ads.push(u2f(f[P.ads])); W.spread.push(u2f(f[P.spread])); W.viewmodel.push(f[P.viewmodel]);
      W.bob.push(f[P.bob]); W.vx.push(u2f(f[P.vel[0]])); W.vy.push(u2f(f[P.vel[1]])); W.vz.push(u2f(f[P.vel[2]]));
      W.ground.push(f[P.ground]); W.vh.push(u2f(f[P.viewHeight])); W.breath.push(u2f(f[P.breath])); W.fuse.push(f[P.fuse] | 0);
      // pm_flags 0x100000: the crosshair rests on a teammate (the server sets it; CG_DrawCrosshair draws it green)
      W.friend.push(f[P.pmFlags] & 0x100000 ? 1 : 0);
      W.pmType.push(pmType); W.health.push(health);
      doPsTables(s.ps, f);
      const alive = (pmType === K.PM.NORMAL || pmType === K.PM.NORMAL_LINKED) && health > 0;
      if (!alive) return;
      const pmf = f[P.pmFlags], ef = f[P.eFlags];
      let flags = PF.TRANSMITTED | PF.FROM_PS;
      if (pmf & K.PMF.CROUCH) flags |= PF.CROUCH;
      if (pmf & K.PMF.PRONE) flags |= PF.PRONE;
      if (ef & K.EF.FIRING) flags |= PF.FIRING;
      if (ef & K.EF.USETURRET) flags |= PF.TURRET;
      if (pmType === K.PM.NORMAL_LINKED) flags |= PF.LINKED;
      const x = u2f(f[P.ox]), y = u2f(f[P.oy]), z = u2f(f[P.oz]);
      track(cl).push(t, x, y, z, u2f(f[P.yaw]), u2f(f[P.pitch]), flags, f[P.weapon], f[P.legs], f[P.torso], u2f(f[P.lean]));
      lastWeapon.set(cl, f[P.weapon]);
      lastPos.set(cl, [t, x, y, z]);
    }

    function doTurret(e, num, t) {
      const p = u2f(e[E.aim[0]]), y = u2f(e[E.aim[1]]);
      let r = c.turrets.get(num);
      if (!r) c.turrets.set(num, r = { x: u2f(e[E.px]), y: u2f(e[E.py]), z: u2f(e[E.pz]), yaw: u2f(e[E.yaw]), t: [], pitch: [], aimYaw: [], last: null });
      const n = r.t.length;
      if (!n || r.pitch[n - 1] !== p || r.aimYaw[n - 1] !== y) {
        if (n && r.last && r.last[0] > r.t[n - 1]) { r.t.push(r.last[0]); r.pitch.push(r.last[1]); r.aimYaw.push(r.last[2]); }
        r.t.push(t); r.pitch.push(p); r.aimYaw.push(y);
      }
      r.last = [t, p, y];
    }

    function doEntities(s, t) {
      const events = new Set();
      const cur = new Map();
      const psClient = s.ps.f[P.client];
      for (const e of s.entities) {
        const num = e[0], et = e[E.type];
        cur.set(num, e);
        if (et >= K.ET.EVENTS) {
          // an event entity fires once while it stays in the snapshots (CG_CheckEvents: previousEvent)
          const key = num + ':' + et + ':' + e[E.time];
          events.add(key);
          if (!prevEvents.has(key)) onEvent(e, et - K.ET.EVENTS, t);
          continue;
        }
        const prev = prevEntities.get(num);
        // entity events (eventSequence ring), only when the entity was there before; an exploding
        // grenade turns into a general entity that carries EV_GRENADE_EXPLODE (G_ExplodeMissile)
        if (prev && prev[E.type] < K.ET.EVENTS && prev[E.seq] !== e[E.seq]) {
          const n = (e[E.seq] - prev[E.seq]) & 255;
          if (n > 0 && n <= 4) {
            for (let i = prev[E.seq]; i < prev[E.seq] + n; i++) {
              const ev = e[E.events[i & 3]] & 0xff;
              if (et === K.ET.PLAYER && SHOT_EVENTS.has(ev)) addTime(c.shots, num, t);
              if (et === K.ET.PLAYER && WEAP_EVENTS.has(ev) && num !== psClient) c.weapEvents.push([t, num, ev, e[E.weapon]]);
              if (EXPLOSIONS.has(ev)) onExplosion(e, ev, t, e[E.parms[i & 3]]);
              else playerSound(ev, e[E.parms[i & 3]] & 0xff, e[E.weapon], u2f(e[E.px]), u2f(e[E.py]), u2f(e[E.pz]), num, t);
            }
          }
        }
        if (et === K.ET.PLAYER && num < 64 && num !== psClient) doPlayer(e, num, t);
        else if (et === K.ET.PLAYER_CORPSE) doCorpse(e, num, t);
        else if (et === K.ET.MISSILE) doMissile(e, num, t, prev);
        else if (et === K.ET.SCRIPTMOVER && !prev && /\/mp_tntbomb$/i.test(c.cs.get(K.CS.MODELS + e[E.index]) || '')) {
          c.bombModels.push({ t, x: u2f(e[E.px]), y: u2f(e[E.py]), z: u2f(e[E.pz]) });
        }
        else if (et === K.ET.TURRET) doTurret(e, num, t);
        else if (et === K.ET.LOOP_FX) {
          const key = num + ':' + e[E.scale];
          let r = c.loopFx.get(key);
          if (!r) c.loopFx.set(key, r = { fx: e[E.scale], delay: u2f(e[E.delay]) | 0, x: u2f(e[E.px]), y: u2f(e[E.py]), z: u2f(e[E.pz]),
            dir: E.dir.map(k => u2f(e[k])), t0: t, t1: t });
          r.t1 = t;
        }
      }
      // corpses and missiles that left the snapshot
      for (const [num, rec] of corpseRec) if (!cur.has(num) || cur.get(num)[E.type] !== K.ET.PLAYER_CORPSE) { rec.t1 = t; corpseRec.delete(num); }
      for (const [num, key] of missileKey) {
        const e = cur.get(num);
        if (!e || e[E.type] !== K.ET.MISSILE) { const g = c.grenades.get(key); if (g) g.gone = t; missileKey.delete(num); }
      }
      prevEvents = events;
      prevEntities = cur;
    }

    function doPlayer(e, num, t) {
      const ef = e[E.flags];
      let flags = PF.TRANSMITTED;
      if (ef & K.EF.CROUCH) flags |= PF.CROUCH;
      if (ef & K.EF.PRONE) flags |= PF.PRONE;
      if (ef & K.EF.FIRING) flags |= PF.FIRING;
      if (ef & K.EF.DEAD) flags |= PF.DEAD;
      if (ef & K.EF.USETURRET) flags |= PF.TURRET;
      if (e[E.ground] === ENTITYNUM_NONE) flags |= PF.LINKED;
      const x = u2f(e[E.px]), y = u2f(e[E.py]), z = u2f(e[E.pz]);
      track(num).push(t, x, y, z, u2f(e[E.yaw]), u2f(e[E.pitch]), flags, e[E.weapon], e[E.legs], e[E.torso], u2f(e[E.lean]),
        u2f(e[E.torsoPitch]), u2f(e[E.waistPitch]));
      lastWeapon.set(num, e[E.weapon]);
      lastPos.set(num, [t, x, y, z]);
    }

    function doCorpse(e, num, t) {
      let rec = corpseRec.get(num);
      const cl = e[E.clientNum];
      if (!rec || rec.client !== cl) {
        rec = { num, client: cl, t0: t, t1: t, x: u2f(e[E.px]), y: u2f(e[E.py]), z: u2f(e[E.pz]), yaw: u2f(e[E.yaw]),
          legs: e[E.legs], torso: e[E.torso] };
        corpseRec.set(num, rec);
        c.corpses.push(rec);
      }
      rec.t1 = t;
    }

    function doMissile(e, num, t, prev) {
      let key = missileKey.get(num);
      // a new missile in this slot: new entity, or another weapon / launch time
      if (key == null || !prev || prev[E.type] !== K.ET.MISSILE || prev[E.weapon] !== e[E.weapon]) {
        key = num + '@' + t;
        missileKey.set(num, key);
        c.grenades.set(key, { entity: num, weapon: e[E.weapon], launch: e[E.time2] || null, first: t, last: t, segments: [], detonation: null, gone: null });
        c.grenadeOrder.push(key);
      }
      const g = c.grenades.get(key);
      g.last = t;
      const seg = [e[E.posTime], e[E.posType], u2f(e[E.px]), u2f(e[E.py]), u2f(e[E.pz]), u2f(e[E.vx]), u2f(e[E.vy]), u2f(e[E.vz])];
      const ls = g.segments[g.segments.length - 1];
      if (!ls || ls.some((v, i) => v !== seg[i])) g.segments.push(seg);
    }

    function onExplosion(e, ev, t, parm) {
      const x = u2f(e[E.px]), y = u2f(e[E.py]), z = u2f(e[E.pz]);
      const det = { t, x, y, z, event: ev, surf: e[E.surf], dir: parm, start: null };
      c.sndEvents.push([t, 5, e[E.weapon], e[E.surf], x, y, z, e[0]]);
      // the grenade itself: the missile entity explodes in its own slot (eType missile -> general)
      const own = missileKey.has(e[0]) ? c.grenades.get(missileKey.get(e[0])) : null;
      if (own && !own.detonation) { own.detonation = det; return; }
      // else (an event entity): the grenade whose last known position is closest
      let best = null, bd = Infinity;
      for (const key of c.grenadeOrder.slice(-40)) {
        const g = c.grenades.get(key);
        if (g.detonation || g.last < t - 600 || g.first > t) continue;
        const s = g.segments[g.segments.length - 1];
        if (!s) continue;
        const dt = Math.max(0, (t - s[0]) / 1000);
        const gx = s[2] + (s[1] === 5 ? s[5] * dt : 0), gy = s[3] + (s[1] === 5 ? s[6] * dt : 0);
        const d = Math.hypot(gx - x, gy - y);
        if (d < bd) { bd = d; best = g; }
      }
      if (best && bd < 400) best.detonation = det;
      else c.detonations.push(Object.assign({ weapon: e[E.weapon] }, det));
    }

    function onEvent(e, ev, t) {
      if (ev === EV.OBITUARY) {
        const victim = e[E.other], attacker = e[E.attacker];
        const vp = lastPos.get(victim), ap = lastPos.get(attacker);
        c.kills.push({ t, victim, attacker, parm: e[E.parm],
          victimPos: vp && t - vp[0] <= 1000 ? [vp[1], vp[2], vp[3]] : null,
          attackerPos: ap && t - ap[0] <= 1000 ? [ap[1], ap[2], ap[3]] : null,
          attackerWeapon: lastWeapon.has(attacker) ? lastWeapon.get(attacker) : null });
      } else if (EXPLOSIONS.has(ev)) {
        onExplosion(e, ev, t, e[E.parm]);
      } else if (IMPACTS.has(ev)) {
        c.impacts.push([t, u2f(e[E.px]), u2f(e[E.py]), u2f(e[E.pz]), e[E.parm], e[E.surf], e[E.weapon], ev]);
        c.sndEvents.push([t, 6, e[E.surf], ev === EV.BULLET_HIT_SMALL ? 0 : 1, u2f(e[E.px]), u2f(e[E.py]), u2f(e[E.pz]), e[0]]);
      } else if (ev === EV.SOUND_ALIAS || ev === EV.SOUND_ALIAS_AS_MASTER) {
        c.sndEvents.push([t, 7, e[E.parm], 0, u2f(e[E.px]), u2f(e[E.py]), u2f(e[E.pz]), e[0]]);
      } else if (CLIENT_HITS.has(ev)) {
        // (the shooter is in clientNum - attackerEntityNum is always 0; weapon is 0 as well, PLAN.md step 44)
        c.hitsTaken.push({ t, victim: e[E.other], attacker: e[E.clientNum], weapon: e[E.weapon] });
      } else if (ev === EV.PLAY_FX) {
        c.playFx.push([t, u2f(e[E.px]), u2f(e[E.py]), u2f(e[E.pz]), e[E.parm]]);
      }
    }

    const visitor = {
      onGamestate(gs) {
        if (!c.gamestate) c.gamestate = gs;
        c.gamestates.push({ t: c.lastTime, configstrings: new Map(gs.configstrings) });
        for (const [k, v] of gs.configstrings) c.cs.set(k, v);
        if (!c.csInitial) c.csInitial = new Map(gs.configstrings);
        prevEntities = new Map();
        prevEvents = new Set();
        missileKey.clear();
      },
      onConfigstring(u) { csUpdate(u.serverTime, u.index, u.value); },
      onServerCommand(cmd) {
        const d = decode(cmd.text);
        const t = cmd.serverTime;
        c.commands.push({ t, seq: cmd.seq, text: cmd.text, d });
        if (d.verb === 'd') csUpdate(t, d.index, d.value);
        else if (d.verb === 'b') c.scoreboards.push({ t, axis: d.scoreAxis, allies: d.scoreAllies, entries: d.entries });
        else if (d.verb === 'G' || d.verb === 'H') {
          lastScores = Object.assign({}, lastScores, { [d.team]: d.score });
          c.teamScores.push({ t, axis: lastScores.axis, allies: lastScores.allies, changed: d.team });
        } else if (d.verb === 'n' || d.verb === 'B') {
          c.restarts.push(t);
          prevEntities = new Map();
          missileKey.clear();
        }
      },
      onSnapshot,
      onIssue(i) { c.issues.push({ t: null, text: i.text }); }
    };
    return { collector: c, visitor };
  }

  C2.collect = { createCollector, PF, clientName };
});
