/* Team identity, side swaps and clan tags.
 *
 * The client state says which side (axis / allies) a player is on. Teams swap
 * sides at halftime (and at every overtime swap), so a team is defined
 * by its members: a "swap" is a moment when most playing clients change side
 * together; a player's team is his side normalised by the number of swaps
 * before that moment. Team A = the team on the axis side at the start. */
C2.define('teams', function (C2) {
  'use strict';
  const SWAP_WINDOW = 5000;

  function analyzeTeams(col, firstTime, lastTime) {
    // per client: list of [t, team]
    const byClient = new Map();
    for (const e of col.teamTimeline) {
      if (!byClient.has(e.client)) byClient.set(e.client, []);
      byClient.get(e.client).push([e.t, e.team]);
    }
    // side flips 1 <-> 2
    const flips = [];
    for (const [client, list] of byClient) {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1][1], b = list[i][1];
        if ((a === 1 && b === 2) || (a === 2 && b === 1)) flips.push({ t: list[i][0], client });
      }
    }
    flips.sort((a, b) => a.t - b.t);
    const playingAt = t => {
      let n = 0;
      for (const list of byClient.values()) {
        let team = -1;
        for (const [tt, tm] of list) { if (tt <= t) team = tm; else break; }
        if (team === 1 || team === 2) n++;
      }
      return n;
    };
    // clusters of flips, each flip at most SWAP_WINDOW after the previous one
    // (players switch one after another, measured spread up to 8 s)
    const clusters = [];
    for (const f of flips) {
      const last = clusters[clusters.length - 1];
      if (last && f.t - last.end <= SWAP_WINDOW) { last.end = f.t; last.clients.add(f.client); }
      else clusters.push({ t: f.t, end: f.t, clients: new Set([f.client]) });
    }
    const swapClusters = clusters.filter(cl => {
      const playing = playingAt(cl.t - 1);
      return cl.clients.size >= 2 && cl.clients.size >= 0.6 * playing;
    });
    const swaps = swapClusters.map(cl => cl.t);
    /** swaps completed before t (a swap counts once it has fully happened) */
    const swapsBefore = t => { let n = 0; for (const s of swapClusters) if (s.end <= t) n++; return n; };
    /** swaps that apply to a side value a client holds from t0 on */
    const swapsFor = (client, t0) => {
      let n = 0;
      for (const s of swapClusters) {
        if (s.end < t0) n++;
        else if (t0 >= s.t && t0 <= s.end && s.clients.has(client)) n++;   // his own flip within the swap
      }
      return n;
    };

    // normalised team per client, weighted by time
    const teamOf = new Map();
    const membership = new Map();       // client -> [{t0, t1, key}]
    for (const [client, list] of byClient) {
      const weight = { A: 0, B: 0 };
      const spans = [];
      for (let i = 0; i < list.length; i++) {
        const [t0, side] = list[i];
        const t1 = i + 1 < list.length ? list[i + 1][0] : lastTime;
        if (side !== 1 && side !== 2) continue;
        const parity = swapsFor(client, t0) % 2;
        const norm = parity ? 3 - side : side;
        const key = norm === 1 ? 'A' : 'B';
        weight[key] += Math.max(1, t1 - t0);
        spans.push({ t0, t1, key });
      }
      membership.set(client, spans);
      if (weight.A || weight.B) teamOf.set(client, weight.A >= weight.B ? 'A' : 'B');
      else teamOf.set(client, 'spectator');
    }

    /** side ('axis' / 'allies') of team key at time t */
    const sideOf = (key, t) => {
      const odd = swapsBefore(t) % 2 === 1;
      if (key === 'A') return odd ? 'allies' : 'axis';
      return odd ? 'axis' : 'allies';
    };
    /** team key playing a side at time t */
    const teamOnSide = (side, t) => (sideOf('A', t) === side ? 'A' : 'B');
    /** raw side of a client at time t from the client states: 1 axis, 2 allies, else 0/3/-1 */
    const rawSideAt = (client, t) => {
      const list = byClient.get(client);
      if (!list) return -1;
      let side = -1;
      for (const [tt, tm] of list) { if (tt <= t) side = tm; else break; }
      return side;
    };
    /** team key a client belonged to at time t (from his membership spans) */
    const teamAt = (client, t) => {
      const spans = membership.get(client) || [];
      for (const s of spans) if (t >= s.t0 && t < s.t1) return s.key;
      return teamOf.get(client) || null;
    };

    return { swaps, swapClusters, teamOf, membership, sideOf, teamOnSide, rawSideAt, teamAt, byClient };
  }

  /* ---- team names: the server's (zPAM / CoD2x) and the players' clan tags ---- */

  // comparison key, case- and leetspeak-insensitive: "W@rZ" = "WarZ" = "warz"
  const LEET = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't' };
  const tagKey = tag => tag.toLowerCase().replace(/[@43!105$7]/g, c => LEET[c]).replace(/[^a-z0-9]/g, '');
  const plainKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // a tag ends at any other character ("ALPHA Shooter", "W@rZ/Sky", "inf.eS NATHZN", "=TAG= x", "RL|x") or where
  // the colour changes ("^4ATMOS^7JAMES"); the apostrophe and ! @ $ belong to it ("elvta'rs", "C!TRON$", "W@rZ")
  const CUT = /[^A-Za-z0-9'!@$]/;
  // shown tag: separators dropped from both ends, brackets kept ("__flamingos_" -> "flamingos", "[ < T N F > ]")
  const TRIM = /^[^A-Za-z0-9'!@$([{<]+|[^A-Za-z0-9'!@$)\]}>]+$/g;
  const MAX_TAG = 16;
  // the server's stand-ins, not a name: zPAM's "-" / "?", CoD2x's pickup teams ("<captain>'s team"), the factions
  const GENERIC = /^(?:-|\?|team ?[12ab]|.+'s team|mpui_\w+|allies|axis|americans?|british|russians?|germans?)$/i;
  const STRONG = 0.8, MIN_SHARE = 0.6;

  /** possible clan tags of one name (with colour codes): its beginnings and ends up to a cut, at most MAX_TAG
   *  characters, the player's own name left over - as Map key -> {spelling} */
  function tagCandidates(raw) {
    const runs = C2.text.colorRuns(raw);
    const text = runs.map(r => r.text).join('');
    const cuts = new Set();
    let pos = 0;
    for (const r of runs) { if (pos) cuts.add(pos); pos += r.text.length; }
    for (let i = 0; i < text.length; i++) if (CUT.test(text[i])) { cuts.add(i); cuts.add(i + 1); }
    const out = new Map();
    const add = (part, rest) => {
      const s = part.replace(TRIM, '').trim();
      if (!s || s.length > MAX_TAG || !/[A-Za-z0-9]/.test(rest)) return;
      let k = tagKey(s);
      // a tag of symbols and single letters ("(.Y.)") is compared as written
      if (k.length < 2) { const w = s.replace(/\s+/g, ''); if (w.length < 3 || /^[A-Za-z0-9]+$/.test(w)) return; k = 'sym:' + w; }
      if (!out.has(k)) out.set(k, { spelling: s });
    };
    for (const c of cuts) {
      if (c <= 0 || c >= text.length) continue;
      add(text.slice(0, c), text.slice(c));
      add(text.slice(c), text.slice(0, c));
    }
    return out;
  }

  /** explicit tag patterns of one player (clean name): [TAG]name, (TAG)name, TAG|name */
  function explicitTag(name) {
    let m = name.match(/^\s*[[({<]([^\])}>]{1,12})[\])}>]/);
    if (m) return m[0].trim();
    m = name.match(/^\s*([^\s|]{1,12})\s*\|/);
    if (m) return m[1];
    return '';
  }

  /** the clan tag of each team: shared by at least 2 and MIN_SHARE of its players (each client once, with every
   *  name it had) and more common there than in the other team; ties -> the longer tag ("inf" / "inf.eS") */
  function teamTags(members) {
    const votes = {};
    for (const key of ['A', 'B']) {
      const v = new Map();
      for (const m of members[key]) {
        const own = new Map();
        for (const n of m.names) for (const [k, c] of tagCandidates(n)) if (!own.has(k)) own.set(k, c.spelling);
        m.cands = own;
        for (const [k, s] of own) {
          const e = v.get(k) || { n: 0, spellings: new Map() };
          e.n++; e.spellings.set(s, (e.spellings.get(s) || 0) + 1);
          v.set(k, e);
        }
      }
      votes[key] = v;
    }
    const out = {};
    for (const key of ['A', 'B']) {
      const other = key === 'A' ? 'B' : 'A', size = members[key].length, osize = members[other].length;
      let best = null;
      for (const [k, e] of votes[key]) {
        const share = e.n / size, o = votes[other].get(k), oshare = o && osize ? o.n / osize : 0;
        if (e.n < 2 || share < MIN_SHARE || oshare >= share) continue;
        const score = share - oshare;
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && k.length > best.key.length)) best = { key: k, score, share, e };
      }
      if (!best) { out[key] = null; continue; }
      // shown: the most frequent spelling ("W@rZ" x4 beats "WarZ" x1)
      let name = '', bn = 0;
      for (const [s, n] of best.e.spellings) if (n > bn) { name = s; bn = n; }
      out[key] = { key: best.key, name, share: best.share, players: best.e.n, size };
    }
    return out;
  }

  /**
   * Team names and the players' clan tags.
   *   members: {A, B: [{client, name (clean), names (every name the client had, with colour codes)}]}
   *   server: [team1, team2] - zPAM's _match_team1 / 2 (clean; '' or '-' when none)
   *   evidence: {1: {A, B}, 2: {A, B}} - votes for the server's team 1 / 2 being A or B (build.js: the side
   *     of g_TeamName_Allies / _Axis when sent, zPAM's match info scores against the rounds won)
   *   fileName: the demo's file name (zPAM names its recordings <player>_<team 1>_<team 2>_<map>) - a hint only
   * Order: a clan tag of at least STRONG of the team, the server's name, a weaker tag, the server's stand-in
   * ("<captain>'s team"), the file name, "Team A" / "Team B".
   * Returns {teams: {A, B: {name, source ('tag' | 'server' | 'file' | 'none'), tag, server, share, players, size}},
   *   tags: Map client -> {tag, heuristic}}.
   */
  function teamNames({ members, server = [], evidence = null, fileName = '' }) {
    const tags = teamTags(members);
    const inNames = (k, needle) => members[k].some(m => m.names.some(x => plainKey(C2.text.stripColors(x)).includes(needle)));
    // the server's names to A / B: the evidence, and the players' names (the captain of "X's team", a name in
    // the players' names, a tag in the name: "ELVTARSAK" ~ "elvta'rs")
    const names = server.map(s => String(s || '').trim()).map(s => (s === '-' ? '' : s));
    const vote = { 1: { A: 0, B: 0 }, 2: { A: 0, B: 0 } };
    if (evidence) for (const i of [1, 2]) for (const k of ['A', 'B']) vote[i][k] += (evidence[i] && evidence[i][k]) || 0;
    names.forEach((n, i) => {
      if (!n) return;
      const cap = n.match(/^(.+)'s team$/i);
      const needle = plainKey(cap ? cap[1] : n);
      if (needle.length < 2) return;
      for (const k of ['A', 'B']) {
        for (const m of members[k]) if (m.names.some(x => plainKey(C2.text.stripColors(x)).includes(needle))) vote[i + 1][k] += 2;
        const t = tags[k];
        if (t && !cap && t.key.length >= 3 && (needle.startsWith(t.key) || t.key.startsWith(needle))) vote[i + 1][k] += 2;
      }
    });
    const serverOf = { A: '', B: '' };
    if (names[0] || names[1]) {
      const a = (vote[1].A - vote[1].B) + (vote[2].B - vote[2].A);
      if (Math.abs(a) >= 1) {
        serverOf[a > 0 ? 'A' : 'B'] = names[0];
        serverOf[a > 0 ? 'B' : 'A'] = names[1];
      }
    }
    // the file name: zPAM's <player>_<team 1>_<team 2>_<map>[_n], the teams cut to 7 / 11 characters; a part
    // counts for the team whose players' names hold it ("2crazYsteam": "2crazY's team" of 2crazY's team)
    const fileOf = { A: '', B: '' };
    const parts = String(fileName || '').replace(/\.dm_1$/i, '').split('_');
    if (parts.length >= 4) {
      for (const part of parts.slice(1, 3)) {
        const cap = part.match(/^(.+)steam$/i), needle = plainKey(cap ? cap[1] : part);
        if (needle.length < 3) continue;
        const hit = ['A', 'B'].filter(k => inNames(k, needle));
        if (hit.length === 1 && !fileOf[hit[0]]) fileOf[hit[0]] = cap ? cap[1] + '\'s team' : part;
      }
    }
    const teams = {};
    for (const k of ['A', 'B']) {
      const t = tags[k], sv = serverOf[k], real = sv && !GENERIC.test(sv);
      const base = { tag: t ? t.name : '', server: sv, share: t ? t.share : 0, players: t ? t.players : 0, size: members[k].length };
      let name, source;
      if (t && t.share >= STRONG) { name = t.name; source = 'tag'; }
      else if (real) { name = sv; source = 'server'; }
      else if (t) { name = t.name; source = 'tag'; }
      else if (sv) { name = sv; source = 'server'; }
      else if (fileOf[k]) { name = fileOf[k]; source = 'file'; }
      else { name = 'Team ' + k; source = 'none'; }
      teams[k] = Object.assign(base, { name, source });
    }
    if (teams.A.name.toLowerCase() === teams.B.name.toLowerCase()) teams.B.name += ' (2)';
    // each player's clan tag: his spelling of his team's tag, else his own explicit one
    const clan = new Map();
    for (const k of ['A', 'B']) {
      for (const m of members[k]) {
        const t = tags[k];
        if (t && m.cands && m.cands.has(t.key)) { clan.set(m.client, { tag: m.cands.get(t.key), heuristic: true }); continue; }
        const e = explicitTag(m.name || '');
        clan.set(m.client, e ? { tag: e, heuristic: true } : { tag: '', heuristic: false });
      }
    }
    return { teams, tags: clan };
  }

  C2.teams = { analyzeTeams, teamNames, tagKey, tagCandidates };
});
