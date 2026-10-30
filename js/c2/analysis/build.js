/* Assemble DemoData - the only object the UI renders from.
 *
 *   C2.analyzeDemo(bytes, fileInfo, onProgress) -> DemoData
 *
 * All times in DemoData are milliseconds since the first snapshot. The shape follows cod4-demo3d's
 * DemoData, so the shared UI (scoreboard, rounds, chat, events, 2D / 3D views) works unchanged. */
C2.define('build', function (C2) {
  'use strict';
  const { stripColors, parseInfostring, fmtTime } = C2.text;
  const K = C2.constants;
  const W = C2.weapons;
  const N = C2.names;
  const PF = C2.collect.PF;

  function csCategory(i) {
    const C = K.CS;
    const single = { 0: 'serverinfo', 1: 'systeminfo', 2: 'game version', 3: 'music', 5: 'team score',
      6: 'team score', 7: 'weapon list', 8: 'items', 12: 'fog', 13: 'level start time', 14: 'vote time',
      15: 'vote string', 16: 'vote yes', 17: 'vote no' };
    if (single[i]) return single[i];
    if (i >= C.DVAR_NAMES && i < C.DVAR_VALUES) return 'dvar name';
    if (i >= C.DVAR_VALUES && i < C.MODELS) return 'dvar value';
    if (i >= C.MODELS && i < C.SOUNDS) return 'model';
    if (i >= C.SOUNDS && i < C.EFFECTS) return 'sound';
    if (i >= C.EFFECTS && i < C.SHELLSHOCKS) return 'effect';
    if (i >= C.SHELLSHOCKS && i < C.SCRIPT_MENUS) return 'shellshock';
    if (i >= C.SCRIPT_MENUS && i < C.LOCALIZED) return 'script menu';
    if (i >= C.LOCALIZED && i < C.MATERIALS) return 'localized string';
    if (i >= C.MATERIALS) return 'material';
    return 'other';
  }

  const pad2 = n => String(n).padStart(2, '0');
  function localStamp(dt) {
    return dt.getFullYear() + pad2(dt.getMonth() + 1) + pad2(dt.getDate()) + pad2(dt.getHours()) + pad2(dt.getMinutes()) + pad2(dt.getSeconds());
  }

  /** protocol of config string 0 -> game version (cod2x/src/shared/shared.h) */
  const PROTOCOLS = { 115: 'CoD2 1.0', 116: 'CoD2 1.1', 117: 'CoD2 1.2', 118: 'CoD2 1.3', 119: 'CoD2 1.3 (Microsoft)', 120: 'CoD2x 1.4' };
  function protocolLabel(p, shortversion) {
    const base = PROTOCOLS[p] || 'protocol ' + p;
    return p === 120 && shortversion ? 'CoD2x ' + shortversion : base;
  }
  /** the side names of the localized team names (dvars g_TeamName_Allies / _Axis) */
  const SIDE_NAMES = { MPUI_AMERICAN: 'American', MPUI_BRITISH: 'British', MPUI_RUSSIAN: 'Russian', MPUI_GERMAN: 'German' };

  function analyzeDemo(bytes, fileInfo, onProgress) {
    const { collector: col, visitor } = C2.collect.createCollector();
    let summary = null, fatal = null;
    try {
      summary = C2.demo.parseDemo(bytes, visitor, onProgress);
    } catch (err) {
      if (err instanceof C2.demo.DemoError) throw err;
      fatal = err;                                  // keep what was read so far
    }
    if (col.firstTime === null) {
      if (fatal) throw fatal;
      throw new C2.demo.DemoError('The demo contains no readable snapshot.');
    }
    return build(col, summary, fatal, fileInfo || {});
  }

  function build(col, summary, fatal, fileInfo) {
    const t0 = col.firstTime;
    const endTime = col.lastTime - t0;
    const rel = t => (t == null ? null : Math.max(0, Math.min(t - t0, endTime)));
    const warnings = [];
    if (fatal) warnings.push('Reading stopped because of an internal error: ' + (fatal.message || fatal) + '. Results are partial.');
    if (summary && summary.truncated) warnings.push('The demo is truncated (the last record is cut off). Everything up to that point is shown.');
    if (summary && !summary.cleanEnd && !summary.truncated) warnings.push('The demo has no end marker.');
    if (summary && summary.stats.snapshotsDropped) warnings.push(summary.stats.snapshotsDropped + ' snapshot(s) could not be decoded (delta reference missing in the file) and were skipped.');
    if (col.issues.length) warnings.push(col.issues.length + ' part(s) of the demo could not be read (see Match details → Events / console): ' + col.issues[0].text);

    // map loads: a gamestate starts a section with its own config strings (a map change in the recording)
    const gsList = col.gamestates.length ? col.gamestates : [{ t: null, configstrings: col.csInitial || col.cs }];
    const sections = gsList.map((g, i) => ({
      start: g.t == null ? 0 : rel(g.t), configstrings: g.configstrings,
      end: i + 1 < gsList.length ? (gsList[i + 1].t == null ? 0 : rel(gsList[i + 1].t)) : endTime
    }));
    let mainIdx = 0;
    sections.forEach((s, i) => { if (s.end - s.start > sections[mainIdx].end - sections[mainIdx].start) mainIdx = i; });
    const main = sections[mainIdx];
    const csInit = main.configstrings;
    const cs = new Map(csInit);
    for (const ch of col.csChanges) { const t = rel(ch.t || col.firstTime); if (t >= main.start && t < main.end) cs.set(ch.index, ch.value); }
    const serverinfo = parseInfostring(cs.get(K.CS.SERVERINFO) || '');
    const serverinfoStart = parseInfostring(csInit.get(K.CS.SERVERINFO) || '');
    const systeminfo = parseInfostring(cs.get(K.CS.SYSTEMINFO) || '');
    const splitList = s => String(s || '').split(/\s+/).filter(Boolean);
    const weapons = splitList(cs.get(K.CS.WEAPONS));
    const weaponLists = sections.map(s => ({ t: s.start, list: splitList(s.configstrings.get(K.CS.WEAPONS)) }));
    for (const ch of col.csChanges) if (ch.index === K.CS.WEAPONS) weaponLists.push({ t: rel(ch.t || col.firstTime), list: splitList(ch.value) });
    weaponLists.sort((a, b) => a.t - b.t);
    const weaponName = (i, t) => {
      if (i === 0) return 'none';
      let list = weaponLists.length ? weaponLists[0].list : weapons;
      for (const w of weaponLists) { if (w.t <= t) list = w.list; else break; }
      return i > 0 && i <= list.length ? list[i - 1] : null;
    };
    const mapName = cfg => (parseInfostring(cfg.get(K.CS.SERVERINFO) || '').mapname || '');
    const mapWindow = { start: main.start, end: main.end < endTime ? main.end : endTime + 1 };
    const mapChanges = [];
    for (let i = 1; i < sections.length; i++) {
      const name = mapName(sections[i].configstrings);
      if (name !== mapName(sections[i - 1].configstrings)) mapChanges.push({ t: sections[i].start, map: name });
    }
    for (const mc of mapChanges) warnings.push('Map change at ' + fmtTime(mc.t) + ': the recording continues on ' + (mc.map || 'another map') + '. Only the main map is analysed.');

    // dvars announced by the server (names 142.., values 238..)
    const dvars = {};
    for (let i = 0; i < K.NUM_DVARS; i++) {
      const name = cs.get(K.CS.DVAR_NAMES + i);
      if (name) dvars[name] = cs.get(K.CS.DVAR_VALUES + i) || '';
    }
    const gametype = (serverinfo.g_gametype || '').toLowerCase();
    const isSD = gametype === 'sd';
    // S&D: the attacking side is the allies on every stock map (the maps' scripts: game["attackers"])
    const attackSide = 'allies', attackSideHeuristic = true;
    const protocol = parseInt(serverinfo.protocol || serverinfoStart.protocol, 10) || null;
    if (protocol != null && !PROTOCOLS[protocol]) warnings.push('Protocol ' + protocol + ' is unknown (known: 115-120). The netcode may differ - check the results.');

    const commands = col.commands.map(c => ({ t: rel(c.t || col.firstTime), seq: c.seq, text: c.text, d: c.d }));
    const csOldByCmd = new Map();
    {
      const cur = new Map(csInit);
      for (const c of commands) {
        if (c.d.verb === 'd' && c.d.index != null) { csOldByCmd.set(c, cur.has(c.d.index) ? cur.get(c.d.index) : null); cur.set(c.d.index, c.d.value); }
      }
    }
    const csChanges = col.csChanges.map(ch => ({ t: rel(ch.t || col.firstTime), index: ch.index, old: ch.old, value: ch.value }));

    // teams (side swaps, A / B)
    const teams = C2.teams.analyzeTeams({ teamTimeline: col.teamTimeline.map(e => ({ t: rel(e.t), client: e.client, team: e.team })) }, 0, endTime);
    const names = col.names;
    const povClient = col.gamestate ? col.gamestate.clientNum : null;
    const allClients = new Set([...names.keys(), ...teams.teamOf.keys()]);
    const playerName = cl => {
      if (cl === K.ENTITYNUM_WORLD) return 'World';
      if (cl == null) return 'n/a';
      if (cl >= 64) return 'Entity ' + cl;
      const n = names.get(cl);
      return n ? stripColors(n.name) : 'Client ' + cl;
    };

    // kills
    const hits = col.hitsTaken.map(h => ({ t: rel(h.t), victim: h.victim, attacker: h.attacker, weapon: h.weapon }));
    const kills = col.kills.map((k, index) => {
      const t = rel(k.t);
      const isMod = (k.parm & 0x80) !== 0;
      const mod = isMod ? K.MEANS_OF_DEATH[k.parm & 0x7f] || 'MOD_UNKNOWN' : null;
      const weapon = isMod ? null : k.parm;
      const world = k.attacker === K.ENTITYNUM_WORLD || k.attacker === K.ENTITYNUM_NONE;
      const entityAttacker = !world && k.attacker >= 64;
      const suicide = k.attacker === k.victim || mod === 'MOD_SUICIDE';
      const aTeam = entityAttacker || world ? null : teams.teamAt(k.attacker, t);
      const vTeam = teams.teamAt(k.victim, t);
      const aSide = teams.rawSideAt(k.attacker, t), vSide = teams.rawSideAt(k.victim, t);
      const teamkill = !suicide && !world && !entityAttacker && (aSide === 1 || aSide === 2) && aSide === vSide;
      let wName = weapon != null ? weaponName(weapon, t) : null;
      let weaponHeuristic = false, weaponSource = weapon != null ? 'obituary' : null;
      // a headshot / bash names the means of death, not the weapon. The weapon of the killer's last bullet
      // hit on the victim when the hit event names one (EV_BULLET_HIT_CLIENT; the CoD2 / CoD2x demos here send
      // weapon 0 - PLAN.md step 44), else the weapon he held (≈: on the 14 demos the same as the weapon of his
      // last shot in 284 of 285 headshots, the other one has no shot sample)
      if (mod === 'MOD_HEAD_SHOT' || mod === 'MOD_MELEE') {
        let hit = null;
        for (const h of hits) { if (h.t > t + 50) break; if (h.t >= t - 300 && h.attacker === k.attacker && h.victim === k.victim && h.weapon) hit = h; }
        if (hit && mod === 'MOD_HEAD_SHOT') { wName = weaponName(hit.weapon, t); weaponSource = 'impact'; }
        else if (k.attackerWeapon != null) { wName = weaponName(k.attackerWeapon, t); weaponHeuristic = true; weaponSource = 'held'; }
        if (wName === 'none') { wName = null; weaponHeuristic = false; weaponSource = null; }
      }
      let label;
      if (mod === 'MOD_HEAD_SHOT') label = wName ? W.label(wName) : 'Unknown weapon';
      else if (mod === 'MOD_MELEE') label = 'Bash' + (wName ? ' (' + W.label(wName) + ')' : '');
      else if (mod) label = W.MOD_LABELS[mod] || mod;
      else label = wName ? W.label(wName) : 'Weapon #' + weapon;
      const dist = k.attackerPos && k.victimPos && !suicide && !world
        ? Math.round(Math.hypot(k.attackerPos[0] - k.victimPos[0], k.attackerPos[1] - k.victimPos[1], k.attackerPos[2] - k.victimPos[2]))
        : null;
      const kill = {
        index, t, attacker: k.attacker, victim: k.victim, weapon, weaponName: mod === 'MOD_MELEE' ? null : wName, weaponLabel: label,
        bashWeapon: mod === 'MOD_MELEE' ? wName : null,
        weaponHeuristic: mod === 'MOD_MELEE' ? false : weaponHeuristic, weaponSource, mod, headshot: mod === 'MOD_HEAD_SHOT', knife: mod === 'MOD_MELEE',
        falling: mod === 'MOD_FALLING', suicide, world, entityAttacker, teamkill,
        attackerTeam: aTeam || null, victimTeam: vTeam || null,
        attackerPos: k.attackerPos, victimPos: k.victimPos, distance: dist, round: -1
      };
      kill.nade = W.isFragGrenadeKill(kill);
      kill.bomb = W.isBombKill(kill);
      kill.car = false;
      return kill;
    });

    // bomb events (S&D): CoD2's messages name nobody - the planter / defuser is found from the positions
    // below (the player held at the site without a weapon; else the one who stood still the longest, ≈)
    const bombEvents = C2.events.bombEvents(commands);
    // rounds
    const R = C2.rounds.analyzeRounds({ commands, csChanges, csInit, teams, kills, endTime, attackSide, isSD,
      teamScores: col.teamScores.map(o => Object.assign({}, o, { t: rel(o.t) })),
      restarts: col.restarts.map(rel), bombEvents, hudTimers: col.hudTimers.map(h => ({ t: rel(h.t), type: h.type, left: h.end - h.t })) });
    const rounds = R.rounds;
    for (let i = 0; i < rounds.length; i++) for (const ki of rounds[i].kills) kills[ki].round = i;
    const phaseAt = t => C2.rounds.phaseAt(R.phases, t);
    for (const k of kills) k.phase = phaseAt(k.t);
    const noMatch = isSD && R.matchStart == null;
    if (noMatch) warnings.push('No match round in this demo (warm-up / ready-up only) - the scoreboard counts nothing.');
    if (R.initialScore.A + R.initialScore.B > 0) {
      warnings.push('The recording starts in the middle of the match at ' + R.initialScore.A + ':' + R.initialScore.B +
        ' - the first ' + (R.initialScore.A + R.initialScore.B) + ' rounds are not in the demo.');
    }
    const halfInfo = { offset: 0, heuristic: false, firstPartial: false, unknown: false };
    const firstRound = rounds.find(r => r.kind === 'round');
    if (firstRound && R.winRule && firstRound.number > 1) {
      const off = Math.floor((firstRound.number - 1) / R.winRule.mr);
      halfInfo.offset = Math.max(0, off - R.halftimes.filter(h => h < firstRound.segStart + 1).length);
      halfInfo.firstPartial = (firstRound.number - 1) % R.winRule.mr !== 0;
      for (const r of rounds) r.half += halfInfo.offset;
    }

    // positions -> typed arrays (only the main map). zPAM's halftime / overtime moves players back to the
    // spawns in a straight line over a few snapshots (~15,000 u/s, PLAN.md step 45): the samples in flight
    // keep the start position, so the views show one teleport (no glide through the map)
    const FLIGHT_SPEED = 3;            // units / ms between two samples (a running player: ~0.2)
    const holdTeleports = P => {
      const fast = j => {
        const dt = P.t[j] - P.t[j - 1];
        return dt > 0 && dt <= 300 && Math.hypot(P.x[j] - P.x[j - 1], P.y[j] - P.y[j - 1]) > FLIGHT_SPEED * dt;
      };
      for (let i = 1; i + 1 < P.t.length; i++) {
        if (!fast(i) || !fast(i + 1) || (P.flags[i] & PF.DEAD)) continue;
        let j = i;
        while (j + 1 < P.t.length && fast(j + 1)) j++;            // i .. j - 1 in flight, j arrives
        for (let k = i; k < j; k++) { P.x[k] = P.x[i - 1]; P.y[k] = P.y[i - 1]; P.z[k] = P.z[i - 1]; }
        i = j;
      }
    };
    const positions = {};
    for (const [cl, tr] of col.tracks) {
      const keep = [];
      for (let i = 0; i < tr.t.length; i++) { const t = tr.t[i] - t0; if (t >= mapWindow.start && t < mapWindow.end) keep.push(i); }
      if (!keep.length) continue;
      const pick = (arr, Type) => Type.from(keep, i => arr[i]);
      positions[cl] = {
        t: Int32Array.from(keep, i => tr.t[i] - t0),
        x: pick(tr.x, Float32Array), y: pick(tr.y, Float32Array), z: pick(tr.z, Float32Array),
        yaw: pick(tr.yaw, Float32Array), pitch: pick(tr.pitch, Float32Array),
        flags: pick(tr.flags, Uint8Array), weapon: pick(tr.weapon, Uint8Array),
        legs: pick(tr.legs, Uint16Array), torso: pick(tr.torso, Uint16Array), lean: pick(tr.lean, Float32Array),
        torsoPitch: pick(tr.torsoPitch, Float32Array), waistPitch: pick(tr.waistPitch, Float32Array),
        icon: pick(tr.icon, Uint8Array)
      };
      holdTeleports(positions[cl]);
    }
    const posAt = (cl, t, maxAge = 150) => {
      const P = positions[cl]; if (!P) return null;
      let lo = 0, hi = P.t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] <= t) lo = m + 1; else hi = m; }
      const i = lo - 1;
      return i >= 0 && t - P.t[i] <= maxAge && !(P.flags[i] & PF.DEAD) ? { x: P.x[i], y: P.y[i], z: P.z[i], i } : null;
    };

    // planter / defuser: the game links the player to the bomb trigger and takes the weapon away for the
    // plant / defuse time (sd.gsc: linkTo + disableWeapon) - the samples with weapon 0 and LINKED; the
    // stretch of at least 2.5 s that ends at the message names the player. When that player is not in
    // the POV's snapshots (≈): the player of the side who moved the least in the 3 s before the message.
    const heldAt = (cl, t) => {
      const P = positions[cl];
      let lo = 0, hi = P.t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] <= t + 600) lo = m + 1; else hi = m; }
      let i = lo - 1;
      while (i >= 0 && !(P.weapon[i] === 0 && (P.flags[i] & PF.LINKED) && !(P.flags[i] & PF.DEAD))) { if (P.t[i] < t - 600) return null; i--; }
      if (i < 0 || P.t[i] < t - 600) return null;
      const end = P.t[i];
      while (i > 0 && P.weapon[i - 1] === 0 && (P.flags[i - 1] & PF.LINKED) && P.t[i] - P.t[i - 1] < 1000) i--;
      return end - P.t[i] >= 2500 ? Math.abs(end - t) : null;
    };
    for (const b of R.bomb) {
      const side = b.action === 'planted' ? attackSide : (attackSide === 'allies' ? 'axis' : 'allies');
      const sideNum = side === 'axis' ? 1 : 2;
      let held = null, heldOff = Infinity;
      for (const cl of Object.keys(positions).map(Number)) {
        if (cl >= 64) continue;
        const off = heldAt(cl, b.t);
        if (off != null && off < heldOff) { heldOff = off; held = cl; }
      }
      if (held != null) {
        const p = posAt(held, b.t, 1000) || posAt(held, b.t - 600, 1000);
        b.client = held; b.clientHeuristic = false;
        if (p) {
          b.pos = [p.x, p.y, p.z];
          // the bomb lies where the game puts it: on the ground 11 units in front of the planter
          // (_utility.gsc getPlant; within 1 - 3 units of the bomb model in the test demos)
          const yaw = positions[held].yaw[p.i] * Math.PI / 180;
          if (b.action === 'planted') { b.bombPos = [p.x + 11 * Math.cos(yaw), p.y + 11 * Math.sin(yaw), p.z]; b.bombSource = 'planter'; }
        }
      } else {
        let best = null, bestMove = Infinity;
        for (const cl of Object.keys(positions).map(Number)) {
          if (cl >= 64 || teams.rawSideAt(cl, b.t) !== sideNum) continue;
          const a = posAt(cl, b.t - 3000, 400), z = posAt(cl, b.t, 400);
          if (!a || !z) continue;
          const move = Math.hypot(z.x - a.x, z.y - a.y);
          if (move < bestMove) { bestMove = move; best = { cl, pos: z }; }
        }
        if (best && bestMove < 48) { b.client = best.cl; b.clientHeuristic = true; b.pos = [best.pos.x, best.pos.y, best.pos.z]; }
      }
      // the bomb model itself, when the POV saw it appear: its own position
      if (b.action === 'planted') {
        const m = col.bombModels.find(x => rel(x.t) >= b.t - 500 && rel(x.t) <= b.t + 3000);
        if (m) { b.bombPos = [m.x, m.y, m.z]; b.bombSource = 'model'; }
        else if (!b.bombPos && b.pos) { b.bombPos = b.pos; b.bombSource = 'last known'; }
      }
      // the bomb site (assets/maps/backgrounds.js: the map's bomb zones) closest to the planter / defuser
      const bg = C2.maps && C2.maps.backgrounds ? C2.maps.backgrounds(serverinfo.mapname) : null;
      if (b.pos && bg && bg.sites) {
        let site = null, sd = Infinity;
        for (const st of bg.sites) { const dd = Math.hypot(st.origin[0] - b.pos[0], st.origin[1] - b.pos[1]); if (dd < sd) { sd = dd; site = st; } }
        if (site && sd < 400) b.site = site.label;
      }
    }

    const resolver = C2.events.nameResolver(col.nameHistory, names);
    const events = C2.events.buildEvents({ commands, rounds, kills, slotEvents: col.slotEvents.map(s => ({ t: rel(s.t) - (s.t === col.firstTime ? 1 : 0), client: s.client, kind: s.kind })),
      resolver, povClient, playerName, endTime, status: R.status, halftimes: R.halftimes, halftimeFromSound: false, phaseAt, bomb: R.bomb, attackSide });
    const leftAt = new Map(), joinedAt = new Map();
    for (const e of events) {
      if (e.type === 'left' && e.clients.length) leftAt.set(e.clients[0], e.t);
      if (e.type === 'joined' && e.clients.length && !joinedAt.has(e.clients[0])) joinedAt.set(e.clients[0], e.t);
      if (e.type === 'disconnected' && e.clients.length && e.t < endTime - 5000 && !leftAt.has(e.clients[0])) leftAt.set(e.clients[0], e.t);
    }
    for (const s of col.slotEvents) if (s.kind === 'connected' && leftAt.has(s.client) && rel(s.t) > leftAt.get(s.client)) leftAt.delete(s.client);
    // a player still in the game when the match ended did not leave early
    if (R.matchEnd != null) for (const [cl, t] of leftAt) if (t >= R.matchEnd) leftAt.delete(cl);
    const plants = new Map(), defuses = new Map();
    for (const b of R.bomb) {
      if (b.client == null || phaseAt(b.t) !== 'live') continue;
      const m = b.action === 'planted' ? plants : defuses;
      m.set(b.client, (m.get(b.client) || 0) + 1);
    }

    // per player counts from the kill feed (live phase only)
    const own = new Map();
    const bump = (cl, key) => { if (cl == null || cl >= 64) return; const o = own.get(cl) || { kills: 0, deaths: 0, headshots: 0, teamkills: 0, teamKilled: 0, nadeKills: 0, nadeDeaths: 0 }; o[key]++; own.set(cl, o); };
    for (const k of kills) {
      if (k.phase !== 'live') continue;
      const { credit, death } = kdRule(k);
      if (k.teamkill) { bump(k.attacker, 'teamkills'); bump(k.victim, 'teamKilled'); }
      if (death) bump(k.victim, 'deaths');
      if (credit) bump(k.attacker, 'kills');
      if (credit && k.headshot) bump(k.attacker, 'headshots');
      if (credit && k.nade) bump(k.attacker, 'nadeKills');
      if (death && k.nade) bump(k.victim, 'nadeDeaths');
    }
    // the game's scoreboard ("b"): score, deaths and ping as the server counts them (last one of the match)
    const boards = col.scoreboards.map(sb => ({ t: rel(sb.t), entries: sb.entries }));
    const lastEntry = new Map();
    const boardUntil = R.matchEnd != null ? R.matchEnd + 15000 : Infinity;
    for (const sb of boards) {
      if (sb.t > boardUntil || (R.matchStart != null && sb.t < R.matchStart)) continue;
      for (const e of sb.entries) if (e.client != null) lastEntry.set(e.client, Object.assign({ t: sb.t }, e));
    }

    const byTeam = { A: [], B: [] };
    const players = [];
    for (const cl of Array.from(allClients).filter(c => c < 64).sort((a, b) => a - b)) {
      const n = names.get(cl) || { name: 'Client ' + cl, clantag: '' };
      const team = teams.teamOf.get(cl) || 'spectator';
      const e = lastEntry.get(cl);
      const o = own.get(cl) || { kills: 0, deaths: 0 };
      const p = {
        client: cl, name: n.name, cleanName: stripColors(n.name).trim(),
        team, isPov: cl === povClient,
        score: e ? e.score : null, kills: o.kills, deaths: o.deaths, assists: null, ping: e ? e.ping : null,
        scoreboardDeaths: e ? e.deaths : null,
        statsSource: 'killfeed', scoreboardTime: e ? e.t : null, killsAfterScoreboard: 0, deathsAfterScoreboard: 0,
        scoreboardSessions: 0, scoreIncomplete: false, ownKills: o.kills, ownDeaths: o.deaths,
        headshots: o.headshots || 0, headshotPct: o.kills ? (o.headshots || 0) / o.kills * 100 : null,
        plants: plants.get(cl) || 0, defuses: defuses.get(cl) || 0,
        teamkills: o.teamkills || 0, teamKilled: o.teamKilled || 0,
        nadeKills: o.nadeKills || 0, nadeDeaths: o.nadeDeaths || 0,
        joinedAt: joinedAt.has(cl) ? joinedAt.get(cl) : null, leftAt: leftAt.has(cl) ? leftAt.get(cl) : null,
        clan: '', clanHeuristic: false
      };
      p.leftEarly = p.leftAt != null;
      players.push(p);
      if (team === 'A' || team === 'B') byTeam[team].push(p);
    }
    // assists: CoD2's scoreboard has none (b: client score ping deaths statusIcon); zPAM counts them (the
    // previous different enemy attacker within 5 s before a kill, sd.gsc) and its own scoreboard menu sends
    // the columns as client cvars (v ui_scoreboard_names / _assists / ..., one line per row, only changed
    // cvars) - to a player with that menu open and to everybody at the intermission; the enemy team's values
    // are "-" for a player during the match (_menu_scoreboard.gsc). Each player's last number; approximate
    // when it is older than the last live kill (assists change only at kills).
    const zpamKey = s => String(s || '').replace(/\^\^[0-9]{2}/g, '').replace(/\^./g, '')
      .replace(/^\s*\[-\]\s*/, '').replace(/^o {2}/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    // The other columns of zPAM's scoreboard the same way (_menu_scoreboard.gsc, _player_stat.gsc): score (kills
    // + 0.5 per assist ...), damage (the damage to enemies who survived it - counted when the enemy starts to heal;
    // shown as hundreds of hp, "12.3" = 1230), grenade kills, plants, defuses - each player's last number per column.
    const zpamAssists = new Map();          // name key -> {value, t}
    const zpamStats = new Map();            // name key -> {score, damage, grenades, plants, defuses: {value, t}}
    const ZPAM_COLS = { scores: 'score', damages: 'damage', grenades: 'grenades', plants: 'plants', defuses: 'defuses' };
    {
      const state = {};
      let cur = null;
      const ups = [];
      for (const c of commands) {
        if (c.d.verb !== 'v' || !c.d.dvars || !c.d.dvars.some(([k]) => k.startsWith('ui_scoreboard_'))) continue;
        if (!cur || c.t - cur.t > 100) ups.push(cur = { t: c.t });
        for (const [k, v] of c.d.dvars) if (k.startsWith('ui_scoreboard_')) state[k] = v;
        cur.names = state.ui_scoreboard_names; cur.assists = state.ui_scoreboard_assists;
        for (const col of Object.keys(ZPAM_COLS)) cur[col] = state['ui_scoreboard_' + col];
      }
      for (const u of ups) {
        const names = String(u.names || '').split('\n'), values = String(u.assists || '').split('\n');
        names.forEach((n, i) => {
          const key = zpamKey(n), v = stripColors(values[i] || '').trim();
          if (key && /^\d+$/.test(v)) zpamAssists.set(key, { value: Number(v), t: u.t });     // (commands: relative times)
          if (!key) return;
          for (const [col, name] of Object.entries(ZPAM_COLS)) {
            const x = stripColors(String(u[col] || '').split('\n')[i] || '').trim();
            if (!/^-?\d+(\.\d+)?$/.test(x)) continue;
            const st = zpamStats.get(key) || {};
            st[name] = { value: name === 'damage' ? Math.round(Number(x) * 100) : Number(x), t: u.t };
            zpamStats.set(key, st);
          }
        });
      }
    }
    if (zpamAssists.size) {
      const lastLiveKill = kills.reduce((a, k) => (k.phase === 'live' && k.t > a ? k.t : a), -Infinity);
      // a name on several client slots (a reconnect): the slot in a team with the most kills
      const owner = new Map();
      for (const p of players) {
        const key = zpamKey(p.name), o = owner.get(key);
        if (zpamAssists.has(key) && (!o || (o.team === 'spectator' && p.team !== 'spectator') || (o.team === p.team && p.kills > o.kills))) owner.set(key, p);
      }
      for (const [key, p] of owner) {
        const a = zpamAssists.get(key);
        Object.assign(p, { assists: a.value, assistsSource: 'zpam', assistsAt: a.t, assistsApprox: a.t < lastLiveKill });
      }
    }
    if (zpamStats.size) {
      const lastLiveKill = kills.reduce((a, k) => (k.phase === 'live' && k.t > a ? k.t : a), -Infinity);
      const owner = new Map();
      for (const p of players) {
        const key = zpamKey(p.name), o = owner.get(key);
        if (zpamStats.has(key) && (!o || (o.team === 'spectator' && p.team !== 'spectator') || (o.team === p.team && p.kills > o.kills))) owner.set(key, p);
      }
      // p.zpam: {score, damage (hp), grenades, plants, defuses, at (the newest value's time), approx (older than the
      // last live kill: later changes are missing)}
      for (const [key, p] of owner) {
        const st = zpamStats.get(key), at = Math.max(...Object.values(st).map(x => x.t));
        p.zpam = Object.fromEntries(Object.entries(st).map(([k, x]) => [k, x.value]));
        p.zpam.at = at;
        p.zpam.approx = at < lastLiveKill;
      }
    }
    const tagInfo = C2.teams.clanTags(byTeam);
    for (const p of players) {
      const t = tagInfo.tags.get(p.client);
      if (t) { p.clan = t.tag; p.clanHeuristic = t.heuristic; }
    }
    // team names: zPAM's _match_team1 / _match_team2 (matched to A / B by the players' names), else
    // the clan tag shared by the team, else "Team A" / "Team B"
    const zpamTeams = [serverinfo._match_team1, serverinfo._match_team2].map(v => stripColors(v || '').trim()).filter(v => v && v !== '-');
    const teamNameOf = key => {
      const members = byTeam[key];
      let best = null, bestN = 0;
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const tn of zpamTeams) {
        const k = norm(tn);
        if (k.length < 2) continue;
        const hitsN = members.filter(p => { const pn = norm(p.cleanName); return pn.includes(k) || (pn.length >= 4 && k.includes(pn)); }).length;
        if (hitsN > bestN) { bestN = hitsN; best = tn; }
      }
      if (best) return { name: best, heuristic: false };
      return tagInfo.teamNames[key] ? { name: tagInfo.teamNames[key].name, heuristic: true } : null;
    };
    const teamList = ['A', 'B'].map(key => {
      const tn = teamNameOf(key);
      return { key, name: tn ? tn.name : 'Team ' + key, nameHeuristic: tn ? tn.heuristic : false,
        clients: byTeam[key].map(p => p.client), wins: R.finalScore[key], halves: [], startSide: key === 'A' ? 'axis' : 'allies' };
    });
    if (teamList[0].name === teamList[1].name) teamList[1].name += ' (2)';
    for (const t of teamList) {
      const halves = [];
      for (const r of rounds) {
        if (r.kind !== 'round') continue;
        halves[r.half - 1] = (halves[r.half - 1] || 0) + (r.winnerTeam === t.key ? 1 : 0);
      }
      t.halves = Array.from(halves, v => v == null ? null : v);
    }
    const diagnostics = { serverScore: R.serverScore, issues: col.issues.slice(0, 50) };
    if (R.serverScore && (R.serverScore.A !== R.finalScore.A || R.serverScore.B !== R.finalScore.B)) {
      warnings.push('Final score from the round analysis (' + R.finalScore.A + ':' + R.finalScore.B +
        ') differs from the team scores sent by the server (' + R.serverScore.A + ':' + R.serverScore.B + ').');
    }

    const chat = C2.events.buildChat({ commands, resolver, rounds, phaseAt });
    const consoleLines = C2.events.buildConsole({ commands, resolver, rounds, gamestate: col.gamestate,
      issues: col.issues.map(i => ({ t: 0, text: i.text })), csCategory, csOld: csOldByCmd, phaseAt });

    // grenades
    const grenades = [];
    // a trajectory (collect.js trajectory()) on the demo's time line
    const relTraj = s => [s[0] - t0, s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8] - t0, s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18] - t0];
    const detOut = d => ({ t: rel(d.t), x: d.x, y: d.y, z: d.z, event: d.event, surf: d.surf, dir: d.dir, start: null });
    const onMainMap = t => t != null && t >= mapWindow.start && t < mapWindow.end;
    for (const key of col.grenadeOrder) {
      const g = col.grenades.get(key);
      if (!onMainMap(rel(g.first))) continue;
      const wName = weaponName(g.weapon, rel(g.first));
      const kind = W.grenadeKind(wName);
      if (!kind && !/grenade/i.test(wName || '')) continue;        // other missiles (none in CoD2 MP)
      // a smoke grenade has no explosion event: it starts smoking where it came to rest
      let det = g.detonation ? detOut(g.detonation) : null;
      if (!det && kind === 'smoke' && g.segments.length) {
        const s = g.segments[g.segments.length - 1];
        if (s[1] !== 5) det = { t: rel(Math.max(s[0], g.first)), x: s[2], y: s[3], z: s[4], event: null, surf: null, dir: null, start: null, derived: true };
      }
      grenades.push({
        entity: g.entity, weapon: wName, kind: kind || 'other',
        launch: g.launch ? rel(g.launch) : null, first: rel(g.first), last: rel(g.last),
        segments: g.segments.map(relTraj),
        detonation: det, thrower: null
      });
    }
    for (const d of col.detonations) {
      if (!onMainMap(rel(d.t))) continue;
      const wName = weaponName(d.weapon, rel(d.t));
      grenades.push({ entity: null, weapon: wName, kind: W.grenadeKind(wName) || 'other', launch: null,
        first: rel(d.t), last: rel(d.t), segments: [], detonation: detOut(d), thrower: null });
    }
    grenades.sort((a, b) => (a.first - b.first));
    // thrower ≈: the nearest living player at the first sighting, if close and clearly the nearest
    for (const g of grenades) {
      if (!g.segments.length) continue;
      const s = g.segments[0], dt = Math.max(0, (g.first - s[0]) / 1000);
      const gx = s[2] + (s[1] === 5 ? s[5] * dt : 0), gy = s[3] + (s[1] === 5 ? s[6] * dt : 0);
      let best = null, bd = Infinity, second = Infinity;
      for (const cl of Object.keys(positions)) {
        if (+cl >= 64) continue;
        const p = posAt(cl, g.first, 100); if (!p) continue;
        const dd = Math.hypot(p.x - gx, p.y - gy);
        if (dd < bd) { second = bd; bd = dd; best = +cl; } else if (dd < second) second = dd;
      }
      if (best != null && bd < 96 && second - bd >= 32) { g.thrower = best; g.throwerHeuristic = true; }
    }

    // bomb track (S&D): planted (the bomb model, else in front of the planter, else at the guessed
    // planter's position ≈) until defused / exploded / round end
    const bombTrack = [];
    if (isSD) {
      for (const r of rounds) {
        const p = (r.bomb || []).find(b => b.action === 'planted');
        if (!p || !p.bombPos) continue;
        const d = (r.bomb || []).find(b => b.action === 'defused');
        const site = p.site || null, [x, y, z] = p.bombPos, source = p.bombSource;
        bombTrack.push({ t: p.t, state: 'planted', x, y, z, carrier: null, site, source });
        if (d) bombTrack.push({ t: d.t, state: 'defused', x, y, z, carrier: null, site, source });
        else if (r.reason === 'Bomb exploded' && r.end != null) bombTrack.push({ t: r.end, state: 'exploded', x, y, z, carrier: null, site, source });
        bombTrack.push({ t: r.segEnd, state: 'none', x: null, y: null, z: null, carrier: null, site: null, source: null });
      }
      bombTrack.sort((a, b) => a.t - b.t);
      // the bomb timer: the server's countdown clock that appears with the plant (zPAM / stock: setClock, 60 s
      // by default) - exact; else the plant -> explosion time of the demo's exploded rounds, else 60 s (≈)
      const clocks = col.hudClocks.map(h => ({ t: rel(h.t), end: rel(h.t) + (h.end - h.t) }));    // (unclamped: past the recording's end)
      const fuses = [];
      for (let i = 0; i + 1 < bombTrack.length; i++) {
        if (bombTrack[i].state === 'planted' && bombTrack[i + 1].state === 'exploded') fuses.push(bombTrack[i + 1].t - bombTrack[i].t);
      }
      fuses.sort((a, b) => a - b);
      const fuse = fuses.length ? fuses[fuses.length >> 1] : 60000;
      for (const b of bombTrack) {
        if (b.state !== 'planted') continue;
        const ck = clocks.find(h => h.t >= b.t - 200 && h.t <= b.t + 1500 && h.end - h.t >= 10000);
        b.explodeAt = ck ? ck.end : b.t + fuse;
        b.timerSource = ck ? 'clock' : fuses.length ? 'exploded rounds' : 'default';
      }
    }

    const fsGame = serverinfo.fs_game || systeminfo.fs_game || '';
    const zpamVersion = serverinfo._zpam || serverinfoStart._zpam || null;
    const ruleset = zpamVersion ? 'zPAM ' + zpamVersion + (R.winRule ? ' · MR' + R.winRule.mr : '') : (R.winRule ? 'MR' + R.winRule.mr : null);
    const mapRaw = serverinfo.mapname || '';
    const recordDate = fileInfo.lastModified
      ? { text: new Date(fileInfo.lastModified).toLocaleString('en-GB'), source: 'file date', heuristic: true, fileDate: true,
          stamp: localStamp(new Date(fileInfo.lastModified)) }
      : null;
    const sideName = v => SIDE_NAMES[String(v || '').toUpperCase()] || null;

    const meta = {
      fileName: fileInfo.name || null, fileSize: fileInfo.size || null,
      protocol, protocolLabel: protocolLabel(protocol, serverinfo.shortversion),
      cleanEnd: summary ? summary.cleanEnd : false, truncated: summary ? summary.truncated : true, damaged: [],
      stats: summary ? summary.stats : null,
      map: mapRaw, mapKey: N.mapKey(mapRaw), mapDisplay: N.mapDisplay(mapRaw),
      gametype: serverinfo.g_gametype || '', gametypeDisplay: N.gametypeDisplay(serverinfo.g_gametype),
      fsGame, mod: fsGame.replace(/^mods\//, '') || (zpamVersion ? 'zPAM ' + zpamVersion : ''),
      ruleset, zpamVersion,
      hostname: serverinfo.sv_hostname || '', serverVersion: serverinfo.shortversion || '',
      gameVersion: cs.get(K.CS.GAME_VERSION) || '',
      povClient, povName: povClient != null ? playerName(povClient) : null,
      durationMs: endTime, firstServerTime: t0, recordDate,
      mapWindow: { start: mapWindow.start, end: Math.min(mapWindow.end, endTime) }, mapChanges,
      minimap: null, fog: null, northYaw: 0,
      weapons, dvars, attackSide, attackSideHeuristic,
      sideNames: { axis: sideName(dvars.g_TeamName_Axis) || 'Axis', allies: sideName(dvars.g_TeamName_Allies) || 'Allies' },
      scorelimit: null, timelimit: null,
      isSearchAndDestroy: isSD
    };

    // weapon / ammo pickups and out-of-grenade attempts (the item is the weapon of that index, CS 7)
    for (const [ta, cl, ev, parm] of col.itemEvents) {
      const t = rel(ta);
      if (!onMainMap(t) || cl < 0 || cl >= 64) continue;
      const w = parm ? weaponName(parm, t) : null, label = w ? C2.weapons.label(w) : null;
      const at = { round: C2.events.roundAt(rounds, t), phase: phaseAt(t) };
      if (ev === K.EV.ITEM_PICKUP && label) events.push(Object.assign({ t, type: 'pickup', text: playerName(cl) + ' picked up ' + label, clients: [cl], weapon: w }, at));
      else if (ev === K.EV.AMMO_PICKUP && label) events.push(Object.assign({ t, type: 'ammo_pickup', text: playerName(cl) + ' picked up ammo (' + label + ')', clients: [cl], weapon: w }, at));
      else if (ev === K.EV.EMPTY_OFFHAND) events.push(Object.assign({ t, type: 'no_grenade', text: playerName(cl) + ' tried to throw a grenade: none left', clients: [cl] }, at));
    }
    events.sort((a, b) => a.t - b.t);
    const data = {
      format: 'cod2-demo3d/1',
      meta, serverinfo, systeminfo, warnings, diagnostics,
      teams: teamList, players, rounds, initialScore: R.initialScore, halfInfo, halftimes: R.halftimes,
      phases: R.phases, match: { start: R.matchStart, end: R.matchEnd, endSource: R.matchEndSource, decided: R.matchDecided, winRule: R.winRule }, swaps: teams.swaps,
      kills, events, chat, console: consoleLines,
      // the game's scoreboard over time (the "b" updates): client -> {t, score, ping, deaths, status} (typed)
      scoreboardTrack: (() => {
        const tr = {};
        for (const sb of col.scoreboards) {
          const t = rel(sb.t);
          if (!onMainMap(t)) continue;
          for (const e of sb.entries) {
            if (e.client == null || e.client < 0 || e.client >= 64) continue;
            const o = tr[e.client] || (tr[e.client] = { t: [], score: [], ping: [], deaths: [], status: [] });
            const n = o.t.length;
            if (n && o.score[n - 1] === e.score && o.ping[n - 1] === e.ping && o.deaths[n - 1] === e.deaths && o.status[n - 1] === e.statusIcon) continue;
            o.t.push(t); o.score.push(e.score | 0); o.ping.push(e.ping | 0); o.deaths.push(e.deaths | 0); o.status.push(e.statusIcon | 0);
          }
        }
        for (const o of Object.values(tr)) {
          o.t = Int32Array.from(o.t); o.score = Int16Array.from(o.score); o.ping = Uint16Array.from(o.ping);
          o.deaths = Int16Array.from(o.deaths); o.status = Uint8Array.from(o.status);
        }
        return tr;
      })(),
      // zPAM's client dvars about the match (_matchinfo.gsc, _weapon_limiter.gsc, _menu_scoreboard.gsc): the last value
      // of each and when it came, plus the time series of the ones that change (null without zPAM)
      zpamInfo: (() => {
        const last = {};
        let any = false;
        const KEEP = /^(ui_matchinfo_|g_teamname_|ui_timeout_info$|ui_allow_|ui_weapons_usedby_|ui_sniper_info$|ui_shotgun_info$|ui_quicksettings_|ui_scoreboard_line_19$|ui_playersleft_list$)/;
        for (const c of commands) {
          if (c.d.verb !== 'v' || !c.d.dvars) continue;
          for (const [k, v] of c.d.dvars) {
            const key = k.toLowerCase();
            if (!KEEP.test(key)) continue;
            any = true;
            const o = last[key] || (last[key] = { value: v, t: c.t, values: [] });
            o.value = v; o.t = c.t;
            if (!o.values.includes(v) && o.values.length < 24) o.values.push(v);
          }
        }
        return any && zpamVersion ? last : null;
      })(),

      // the scripts' head icons (config strings 31..45: CS 30 + the entity's iHeadIcon) -> material name
      headIcons: (() => { const out = {}; for (let i = 1; i <= 15; i++) { const n = cs.get(30 + i); if (n) out[i] = n.toLowerCase(); } return out; })(),
      // zPAM's damage log of the recording player (client dvars pam_damage_debug .. _debug4, _round_report.gsc:
      // every rifle / scoped / shotgun / grenade hit he made, resent after each round):
      // [{t, clock, bomb, damage, health (the victim's health before the hit), weapon, hitLoc, my, enemy, hit,
      //   victim (the player at the enemy's position ≈), round}]
      zpamHits: (() => {
        const state = {}, seen = new Set(), out = [];
        const vec = s => { const m = /\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+)\)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
        for (const c of commands) {
          if (c.d.verb !== 'v' || !c.d.dvars) continue;
          let changed = false;
          for (const [k, v] of c.d.dvars) if (/^pam_damage_debug\d?$/.test(k)) { state[k] = v; changed = true; }
          if (!changed) continue;
          const lines = ['pam_damage_debug', 'pam_damage_debug2', 'pam_damage_debug3', 'pam_damage_debug4'].map(k => state[k] || '').join('\n').split('\n');
          for (const line of lines) {
            const f = line.split('|');
            const m = /^(B )?(\d+:\d\d)$/.exec((f[0] || '').trim());
            if (!m || f.length < 8) continue;
            const key = f[1] + '|' + f[2] + '|' + f[7];
            if (seen.has(key)) continue;
            seen.add(key);
            const kv = {};
            for (const x of f.slice(2)) { const i = x.indexOf(':'); if (i > 0) kv[x.slice(0, i)] = x.slice(i + 1); }
            // (gettime() is the server time of the snapshots: the hit's shot comes in the next snapshot)
            const t = rel(Number(f[1]));
            if (t == null || !onMainMap(t)) continue;
            const enemy = vec(kv.xyz_enemy), my = vec(kv.xyz_my);
            let victim = null, best = 64;
            if (enemy) for (const cl of Object.keys(positions)) {
              if (+cl >= 64 || +cl === povClient) continue;
              const p = posAt(cl, t, 250);
              if (p) { const dd = Math.hypot(p.x - enemy[0], p.y - enemy[1]); if (dd < best) { best = dd; victim = +cl; } }
            }
            out.push({ t, clock: m[2], bomb: !!m[1], damage: Number(kv.dmg), health: Number(kv.health), weapon: f[6], hitLoc: f[7],
              my, enemy, hit: vec(kv.xyz_hit), victim, round: rounds.findIndex(r => t >= r.segStart && t < r.segEnd) });
          }
        }
        return out.sort((a, b) => a.t - b.t);
      })(),
      eventTypes: C2.events.EVENT_TYPES,
      positions, grenades,
      playerModels: (() => {
        const name = i => (i ? cs.get(K.CS.MODELS + i) || null : null);
        const out = {};
        for (const e of col.modelTimeline || []) (out[e.client] || (out[e.client] = [])).push({ t: rel(e.t), body: name(e.model), attach: e.attach.map(name).filter(Boolean) });
        return out;
      })(),
      corpses: col.corpses.map(c => Object.assign({}, c, { t0: rel(c.t0), t1: rel(c.t1) })).filter(c => onMainMap(c.t0)),
      // the game's scoreboard as the server sent it ("b": CG_ParseScores - the teams' scores, per client score, ping,
      // deaths, status icon): [{t, axis, allies, e: [client, score, ping, deaths, status, ...]}], a new one when it changed
      scores: (() => {
        const out = [];
        let last = '';
        for (const sb of col.scoreboards) {
          const t = rel(sb.t);
          if (!onMainMap(t)) continue;
          const e = [];
          for (const x of sb.entries) if (x.client != null && x.client >= 0 && x.client < 64) e.push(x.client, x.score | 0, x.ping | 0, x.deaths | 0, x.statusIcon | 0);
          const key = sb.axis + '|' + sb.allies + '|' + e.join(',');
          if (key === last) continue;
          last = key;
          out.push({ t, axis: sb.axis | 0, allies: sb.allies | 0, e: Int16Array.from(e) });
        }
        return out;
      })(),
      // the scripts' earthquakes (the camera shake): [t, scale, duration ms, radius, x, y, z]
      earthquakes: col.earthquakes.map(r => [rel(r[0])].concat(r.slice(1))).filter(r => onMainMap(r[0])),
      // the mounted MGs' shots [t, x, y, z] (each shakes the camera near the gun)
      mgFire: col.mgFire.map(r => [rel(r[0]), r[1], r[2], r[3]]).filter(r => onMainMap(r[0])).sort((a, b) => a[0] - b[0]),
      // the items on the ground (dropped weapons): {num, weapon, t0, t1 (last seen), segments (trajectories)}
      items: col.items.map(r => ({ num: r.num, weapon: weaponName(r.index, rel(r.t0)), t0: rel(r.t0), t1: rel(r.t1), segments: r.segments.map(relTraj) }))
        .filter(r => r.weapon && onMainMap(r.t0)),
      bombTrack,
      // the mounted MGs' aim (js/view3d/view3d.js): [{x, y, z, yaw, t, pitch, aimYaw}] - pitch / aimYaw relative to the
      // stand, samples on the main map
      turrets: [...col.turrets.values()].map(r => {
        const keep = r.t.map((t, i) => i).filter(i => onMainMap(rel(r.t[i])));
        return { x: r.x, y: r.y, z: r.z, yaw: r.yaw, t: Int32Array.from(keep, i => rel(r.t[i])),
          pitch: Float32Array.from(keep, i => r.pitch[i]), aimYaw: Float32Array.from(keep, i => r.aimYaw[i]) };
      }).filter(r => r.t.length),
      // the sounds of the 3D view (js/view3d/sound.js), as CG_EntityEvent plays them: events [t, alias |
      // 'weapon:<name>[:<key>]', x, y, z, entity]; the POV's local sounds ("s <n>" = config string 590 + n)
      // {t, name}; the entities' loop sounds [t0, t1, alias, x, y, z, entity]; the bullets for the whizby
      // [t, shooter's eye x y z, impact x y z, shooter]
      sounds3d: (() => {
        const S = K.SURFACES, surf = i => S[i] || 'default';
        const csAt = i => cs.get(K.CS.SOUNDS + i) || null;
        const weapon = (i, t, key) => { const w = weaponName(i, t); return w && w !== 'none' ? 'weapon:' + w + (key ? ':' + key : '') : null; };
        const events = [];
        for (const r of col.sndEvents) {
          const t = rel(r[0]);
          if (!onMainMap(t)) continue;
          const names = [];
          if (r[1] === 1) names.push(weapon(r[2], t, r[3] ? 'last' : ''));
          else if (r[1] === 2) names.push(['step_run_', 'step_walk_', 'step_prone_'][r[3]] + surf(r[2]), r[3] ? 'gear_rattle_walk' : 'gear_rattle_run');
          else if (r[1] === 9) names.push('step_run_' + surf(r[2]), 'gear_rattle_run');               // a jump
          else if (r[1] === 3) names.push('land_' + surf(r[2]), r[3] ? 'land_damage' : null);
          else if (r[1] === 4) names.push(r[3] === 1 ? 'melee_hit' : r[3] === 2 ? 'melee_hit_other' : weapon(r[2], t, 'melee'));
          else if (r[1] === 5) { const w = weaponName(r[2], t) || ''; names.push(/smoke/.test(w) ? 'smokegrenade_explode_default' : 'grenade_explode_' + surf(r[3])); }
          else if (r[1] === 6) names.push((r[3] ? 'bullet_large_' : 'bullet_small_') + surf(r[2]));
          // (CG_BulletHitClientEvent plays the small table for the small hit, the spray table for the large one)
          else if (r[1] === 13) names.push((r[3] ? 'bulletspray_small_' : 'bullet_small_') + surf(r[2]));
          else if (r[1] === 7) names.push(csAt(r[2]));
          else if (r[1] === 8) names.push(weapon(r[2], t, r[3]));
          else if (r[1] === 10) names.push('movement_foliage');
          else if (r[1] === 11) names.push('grenade_bounce_' + surf(r[2]));
          else if (r[1] === 12) names.push('player_out_of_ammo');
          for (const name of names) if (name) events.push([t, String(name).toLowerCase(), r[4], r[5], r[6], r[7]]);
        }
        // the breath of the player whose view the demo holds (CG_AddPlayerWeapon: his local sounds - heard only in
        // his first person, e[6] / l[7] = 1): holding it (pm_flags 0x4000) plays weap_sniper_breathin unless a breath
        // sound played within player_breath_snd_delay (1 s), then weap_sniper_heartbeat loops once the breath-in has
        // ended (l[8]: the alias whose length it waits for); letting go plays weap_sniper_breathout (the same delay),
        // or weap_sniper_breathgasp after more than player_breath_hold_time (4.5 s). holds: [t0, t1, client] (the
        // sounds ducked by hold_breath.shock meanwhile)
        const holds = [], breathLoops = [];
        {
          const W = col.psWeapon;
          let start = null, cl = -1, sndUntil = -Infinity, breathIn = false;
          const close = (t, sound) => {
            if (sound) {
              if (t - start > 4500) events.push([rel(t), 'weap_sniper_breathgasp', 0, 0, 0, cl, 1]);
              else if (t >= sndUntil) { events.push([rel(t), 'weap_sniper_breathout', 0, 0, 0, cl, 1]); sndUntil = t + 1000; }
            }
            if (onMainMap(rel(start))) {
              holds.push([rel(start), rel(t), cl]);
              breathLoops.push([rel(start), rel(t), 'weap_sniper_heartbeat', 0, 0, 0, cl, 1, breathIn ? 'weap_sniper_breathin' : null]);
            }
            start = null;
          };
          for (let i = 0; i < W.t.length; i++) {
            const t = W.t[i], c = W.client[i];
            // another player's view, or a gap: what was held ends quietly
            if (start != null && (c !== cl || t - W.t[i - 1] > 1000)) close(W.t[i - 1], false);
            cl = c;
            if (W.hold[i] && start == null) {
              start = t;
              breathIn = t >= sndUntil;
              if (breathIn) { events.push([rel(t), 'weap_sniper_breathin', 0, 0, 0, cl, 1]); sndUntil = t + 1000; }
            } else if (!W.hold[i] && start != null) close(t, true);
          }
          if (start != null) close(W.t[W.t.length - 1], false);
        }
        for (let i = events.length - 1; i >= 0 && events[i][6]; i--) if (!onMainMap(events[i][0])) events.splice(i, 1);
        events.sort((a, b) => a[0] - b[0]);
        const local = [];
        for (const c of commands) {
          if (c.d.verb !== 's' || c.d.sound == null || !onMainMap(c.t)) continue;
          const v = csAt(c.d.sound);
          if (v) local.push({ t: c.t, name: v.toLowerCase() });
        }
        const loops = [];
        for (const r of col.loopSounds) {
          const t0 = rel(r[0]), name = csAt(r[2]);
          if (name && onMainMap(t0)) loops.push([t0, rel(r[1]) + 50, name.toLowerCase(), r[3], r[4], r[5], r[6]]);
        }
        loops.push(...breathLoops);
        loops.sort((a, b) => a[0] - b[0]);
        const whiz = col.whizEvents.map(r => [rel(r[0]), r[1], r[2], r[3], r[4], r[5], r[6], r[7]]).filter(r => onMainMap(r[0]));
        whiz.sort((a, b) => a[0] - b[0]);
        return { events, local, loops, whiz, holds };
      })(),
      shotsSeen: Object.fromEntries([...col.shots].map(([cl, a]) => [cl, a.map(rel)])),
      // the first-person weapon (viewanim.js): the recording player's weapon per snapshot (player state),
      // the weapon events of every player, the hands models of the viewmodel indices
      psWeapon: (() => {
        const W = col.psWeapon, T = { t: Int32Array.from(W.t, rel) };
        const typed = { client: Int8Array, anim: Uint16Array, state: Uint8Array, weapon: Uint8Array, offhand: Uint8Array, ads: Float32Array,
          spread: Float32Array, viewmodel: Uint8Array, bob: Uint8Array, vx: Float32Array, vy: Float32Array, vz: Float32Array,
          ground: Uint16Array, vh: Float32Array, breath: Float32Array, hold: Uint8Array, fuse: Int32Array, friend: Uint8Array,
          pmf: Int32Array, hint: Int16Array, hintStr: Int16Array, mantle: Int32Array, maxHealth: Int16Array, dmgEv: Int32Array,
          dmgYaw: Uint8Array, dmgPitch: Uint8Array, dmgCount: Int16Array,
          pmType: Uint8Array, health: Int16Array, ammoRef: Uint32Array, objRef: Uint32Array, hudRef: Uint32Array,
          speed: Int16Array, vht: Int8Array };
        for (const [k, A] of Object.entries(typed)) T[k] = A.from(W[k]);
        return T;
      })(),
      // the recording player's HUD (hud.js): the tables psWeapon.ammoRef / objRef / hudRef point to, flat with
      // their start offsets; t0 turns the HUD elements' server times into the replay's
      psHud: (() => {
        const flat = list => {
          const start = new Uint32Array(list.length + 1);
          for (let i = 0; i < list.length; i++) start[i + 1] = start[i] + list[i].length;
          const data = new Int32Array(start[list.length]);
          list.forEach((a, i) => data.set(a, start[i]));
          return { start, data };
        };
        const T = col.psTables;
        // the config strings the HUD reads: north yaw (11), the scoreboard's status icons (22 + i), localized strings
        // (1278 + i: the cursor hints' texts, HUD element texts), materials (1566 + i: HUD element and objective images);
        // the client dvars the server sets (zPAM's HUD menus show some) and the game / bold messages (the lower left and
        // the centre message windows)
        const want = i => i === 11 || (i >= 22 && i < 30) || (i >= 1278 && i < 1694);
        const init = {};
        for (const [i, v] of csInit) if (want(i)) init[i] = v;
        return { t0, ammo: flat(T.ammo), obj: flat(T.obj), hud: flat(T.hud),
          cs: { init, changes: csChanges.filter(c => want(c.index) && c.t >= main.start && c.t < main.end).map(c => [c.t, c.index, c.value]) },
          dvars: commands.filter(c => c.d.verb === 'v').flatMap(c => c.d.dvars.map(([n, v]) => [c.t, n.toLowerCase(), v])),
          messages: commands.filter(c => c.d.verb === 'f' || c.d.verb === 'g').map(c => [c.t, c.d.verb, c.d.text]) };
      })(),
      weapEvents: col.weapEvents.map(r => [rel(r[0]), r[1], r[2], r[3]]),
      viewEvents: col.viewEvents.map(r => [rel(r[0]), r[1], r[2], r[3]]),
      viewHands: (() => { const out = {}; for (const i of new Set(col.psWeapon.viewmodel)) { const n = i && cs.get(K.CS.MODELS + i); if (n) out[i] = n.toLowerCase(); } return out; })(),
      fx3d: {
        impacts: col.impacts.map(r => [rel(r[0])].concat(r.slice(1))).filter(r => onMainMap(r[0])),
        playFx: col.playFx.map(r => [rel(r[0])].concat(r.slice(1))).filter(r => onMainMap(r[0])),
        loopFx: [...col.loopFx.values()].map(r => Object.assign({}, r, { t0: rel(r.t0), t1: rel(r.t1) })).filter(r => onMainMap(r.t0)),
        effectNames: (() => { const out = {}; for (let i = 1; i < 64; i++) { const n = cs.get(K.CS.EFFECTS + i); if (n) out[i] = n; } return out; })()
      },
      weaponLists
    };
    // the teams' factions (the player models: playerbody_american / _british / _russian / _german ...): team key ->
    // [[t, faction], ...] - a team's faction changes when it swaps sides
    data.teamFactions = (() => {
      const out = { A: [], B: [] };
      const byClient = new Map(data.players.map(p => [p.client, p.team]));
      const ev2 = [];
      for (const [cl, list] of Object.entries(data.playerModels || {})) {
        const team = byClient.get(+cl);
        if (team !== 'A' && team !== 'B') continue;
        for (const m of list) { const f = /playerbody_(american|british|russian|german)/.exec(m.body || ''); if (f) ev2.push([m.t, team, f[1]]); }
      }
      ev2.sort((a, b) => a[0] - b[0]);
      for (const [t, team, f] of ev2) { const arr = out[team]; if (!arr.length || arr[arr.length - 1][1] !== f) arr.push([t, f]); }
      return out;
    })();
    // opening duels, trades, multikills, clutches, zPAM's round report (combat.js)
    C2.combat.analyze(data);
    return data;
  }

  /** K / D of one kill - THE rule of the scoreboard (only kills of phase "live" count; the caller
   * checks the phase): team kills and suicides give the shooter no kill, deaths by the world
   * (falling) are no deaths. */
  function kdRule(k) {
    return { credit: !k.suicide && !k.world && !k.entityAttacker && !k.teamkill, death: !k.world };
  }

  C2.analyzeDemo = analyzeDemo;
  C2.build = { csCategory, protocolLabel, kdRule };
});
