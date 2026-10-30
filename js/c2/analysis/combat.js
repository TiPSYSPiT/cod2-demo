/* Round combat statistics from the kills and rounds (DOM-free; build.js runs it on the finished data):
 * the opening duel (the round's first kill: first blood), trades (a kill that avenges a teammate the victim
 * killed within TRADE_MS), multikills (kills of one player in one round) and clutches (the last player of
 * a team alive against one or more enemies; won when the team wins the round). Only match rounds, only
 * kills while the round is live (up to its decision), with the scoreboard rule for credit (kdRule). The
 * players of a round are the team members the demo shows in it (a position in the round) - a player never
 * sent to the POV in a round is not counted there.
 * Also zPAM's round report (scr_sd_round_report): after each round zPAM prints the recording player's
 * own hits - kills with the damage and hit location of the first hit, hits that did not kill, and how he
 * was killed - for rifle, scoped, shotgun and grenade hits only (_round_report.gsc). */
C2.define('combat', function (C2) {
  'use strict';
  const TRADE_MS = 5000;
  const live = r => r.kind === 'round';

  /** the players of team key in round r: members with a position in it */
  function roster(d, r, key) {
    const out = [];
    for (const p of d.players) {
      if (p.team !== key) continue;
      const P = d.positions[p.client];
      if (!P || !P.t.length) continue;
      let lo = 0, hi = P.t.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] < r.segStart) lo = m + 1; else hi = m; }
      if (lo < P.t.length && P.t[lo] < r.segEnd) out.push(p.client);
    }
    return out;
  }

  function analyze(d) {
    const kdRule = C2.build.kdRule;
    const stats = new Map(d.players.map(p => [p.client, { openingKills: 0, openingDeaths: 0, trades: 0, tradedDeaths: 0,
      multi: { 2: 0, 3: 0, 4: 0, 5: 0 }, clutchesWon: 0, clutchesPlayed: 0, clutches: [] }]));
    const S = cl => stats.get(cl);
    for (let ri = 0; ri < d.rounds.length; ri++) {
      const r = d.rounds[ri];
      if (!live(r)) continue;
      const until = r.end != null ? r.end : r.segEnd;
      const ks = r.kills.map(i => d.kills[i]).filter(k => k.phase === 'live' && k.t <= until);
      const credited = ks.filter(k => kdRule(k).credit);
      const combat = { opening: null, trades: [], multikills: [], clutches: [] };
      // the opening duel
      const first = credited[0];
      if (first) {
        first.opening = true;
        combat.opening = first.index;
        if (S(first.attacker)) S(first.attacker).openingKills++;
        if (S(first.victim)) S(first.victim).openingDeaths++;
      }
      // trades: the killer of a teammate killed within TRADE_MS
      for (const k of credited) {
        for (let j = credited.indexOf(k) - 1; j >= 0; j--) {
          const p = credited[j];
          if (k.t - p.t > TRADE_MS) break;
          if (p.attacker === k.victim && p.victimTeam === k.attackerTeam && p.victim !== k.attacker) {
            k.tradeOf = p.index;
            p.tradedBy = k.index;
            combat.trades.push(k.index);
            if (S(k.attacker)) S(k.attacker).trades++;
            if (S(p.victim)) S(p.victim).tradedDeaths++;
            break;
          }
        }
      }
      // multikills
      const per = new Map();
      for (const k of credited) per.set(k.attacker, (per.get(k.attacker) || 0) + 1);
      for (const [cl, n] of per) {
        if (n < 2) continue;
        combat.multikills.push({ client: cl, kills: n });
        if (S(cl)) S(cl).multi[Math.min(5, n)]++;
      }
      combat.multikills.sort((a, b) => b.kills - a.kills);
      // clutches: per team the moment it is down to its last player while the enemy still lives
      const keys = ['A', 'B'], alive = {};
      for (const key of keys) alive[key] = new Set(roster(d, r, key));
      if (alive.A.size && alive.B.size) {
        const done = new Set();
        const check = t => {
          for (const key of keys) {
            const other = alive[key === 'A' ? 'B' : 'A'];
            if (done.has(key) || alive[key].size !== 1 || !other.size) continue;
            done.add(key);
            const cl = [...alive[key]][0];
            const c = { client: cl, team: key, vs: other.size, t, won: r.winnerTeam === key };
            combat.clutches.push(c);
            const s = S(cl);
            if (s) { s.clutchesPlayed++; if (c.won) s.clutchesWon++; s.clutches.push({ round: ri, vs: c.vs, won: c.won }); }
          }
        };
        check(r.start != null ? r.start : r.segStart);
        for (const k of ks) {
          for (const key of keys) alive[key].delete(k.victim);
          check(k.t);
        }
      }
      r.combat = combat;
    }
    for (const p of d.players) p.combat = stats.get(p.client);
    for (const r of d.rounds) if (r.statusLines) r.report = parseReport(r.statusLines);
  }

  const HP = /(\d+)hp/;
  /** zPAM's round report among a round's status lines -> {lines: [{time, bomb, kind, team, damage, location,
   *  weapon, first: {damage, location, weapon} | null, text}], kills, hits, damage (of the hits that did not
   *  kill)} or null */
  function parseReport(lines) {
    const at = lines.findIndex(l => /^\s*Round report:\s*$/.test(C2.text.stripColors(l)));
    if (at < 0) return null;
    const out = [];
    for (const raw of lines.slice(at + 1)) {
      const text = C2.text.stripColors(raw).trim();
      const m = /^(B )?(\d+:\d\d) (team kill \d+|kill \d+|team hit|hit|killed)(.*)$/.exec(text);
      if (!m) continue;
      const kind = m[3].includes('kill') && m[3] !== 'killed' ? 'kill' : m[3] === 'killed' ? 'killed' : 'hit';
      let rest = m[4];
      const e = { time: m[2], bomb: !!m[1], kind, team: m[3].startsWith('team'), damage: null, location: null, weapon: null, first: null, text };
      const part = s => {
        const o = { damage: null, location: null, weapon: null };
        const hp = HP.exec(s); if (hp) o.damage = +hp[1];
        const loc = / to ([A-Za-z_ ]+?)(?: \(|,|$| \^| \*| via )/.exec(s); if (loc) o.location = loc[1].trim();
        const w = /\(([^)]+)\)/.exec(s) || / via (.+?)\s*$/.exec(s); if (w) o.weapon = w[1].trim();
        return o;
      };
      const split = rest.indexOf(', first ');
      if (split >= 0) { e.first = part(rest.slice(split + 8)); rest = rest.slice(0, split); }
      Object.assign(e, part(rest));
      out.push(e);
    }
    if (!out.length) return null;
    const hits = out.filter(e => e.kind === 'hit');
    return { lines: out, kills: out.filter(e => e.kind === 'kill' && !e.team).length, hits: hits.length,
      damage: hits.reduce((a, e) => a + (e.damage || 0), 0) };
  }

  C2.combat = { analyze, parseReport, TRADE_MS };
});
