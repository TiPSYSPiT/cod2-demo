/* Rounds, halves and match phases of a CoD2 demo.
 *
 * Signals (measured on the zPAM 3.34 match demo_match_burgundy.dm_1, see PLAN.md):
 * - every round starts with a fast restart: server command "n" (and "d 13 <time>": the round's
 *   level start time)
 * - the team scores: "G <axis>" / "H <allies>" - one side +1 = that side won the round; both sides
 *   exchanging their values = the halftime side swap
 * - zPAM's serverinfo (config string 0) names the segment: _match_round "Round 7 / 24",
 *   "Ready-up" (before the match, at halftime), "Timeout"; "Round N / M" gives the rule (MR = M / 2)
 * - game messages: MP_ALLIESHAVEBEENELIMINATED, MP_AXISHAVEBEENELIMINATED, MP_EXPLOSIVESPLANTED,
 *   MP_EXPLOSIVESDEFUSED; zPAM prints "Half-time Ready-Up Mode", "... called a time-out ..."
 * - the round clock: a HUD countdown (hud element "timer down") of the round length, created when the
 *   round goes live - in zPAM after the strat time (scr_sd_strat_time, players frozen; its own 6 s
 *   countdown right after the restart). Round start = the clock's end - the round length.
 * Without zPAM (stock S&D) every segment with a round win is a round. Other game types have no
 * rounds: the whole demo is "live". */
C2.define('rounds', function (C2) {
  'use strict';
  const { stripColors, parseInfostring } = C2.text;
  const K = C2.constants;

  /** "Round 7 / 24" -> {mr: 12, total: 24}; overtime unknown in CoD2 zPAM 3 */
  function winRule(label) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(label || ''));
    if (!m) return null;
    const total = parseInt(m[2], 10);
    return total >= 2 ? { mr: Math.floor(total / 2), total, ot: 3, otFromRuleset: false } : null;
  }
  /** match decided: one team has more than half of the rounds */
  function isDecided(rule, a, b) {
    if (!rule) return false;
    return a > rule.mr || b > rule.mr;
  }

  /**
   * ctx: {commands (t relative, d decoded), csChanges (t relative), csInit (Map), teamScores (t relative),
   *       restarts (relative), kills, teams (teams.js), endTime, attackSide, isSD, bombEvents}
   */
  function analyzeRounds(ctx) {
    const { commands, csChanges, csInit, kills, teams, endTime, attackSide, isSD } = ctx;
    const defendSide = attackSide === 'allies' ? 'axis' : 'allies';
    // zPAM's _match_round over time
    const roundLabels = [];
    let si = parseInfostring(csInit.get(K.CS.SERVERINFO) || '');
    if (si._match_round != null) roundLabels.push({ t: 0, value: si._match_round });
    for (const ch of csChanges) {
      if (ch.index !== K.CS.SERVERINFO) continue;
      const v = parseInfostring(ch.value || '')._match_round;
      if (v != null && (!roundLabels.length || roundLabels[roundLabels.length - 1].value !== v)) roundLabels.push({ t: ch.t, value: v });
    }
    const zpam = roundLabels.length > 0;
    const labelAt = t => { let v = null; for (const l of roundLabels) { if (l.t <= t) v = l.value; else break; } return v; };

    // messages
    const msgs = [];
    for (const c of commands) {
      if (c.d.verb === 'f' || c.d.verb === 'g' || c.d.verb === 'c' || c.d.verb === 'e') msgs.push({ t: c.t, text: stripColors(c.d.text || '').trim() });
    }
    const bomb = (ctx.bombEvents || []).slice();

    // team scores: wins (one side +1) and halftime swaps (the values exchanged)
    const scoreObs = ctx.teamScores.filter(o => o.axis != null && o.allies != null);
    const wins = [], swaps = [];
    let prev = null;
    for (const o of scoreObs) {
      if (prev && (o.axis !== prev.axis || o.allies !== prev.allies)) {
        const dAx = o.axis - prev.axis, dAl = o.allies - prev.allies;
        if (dAx === 1 && dAl === 0) wins.push({ t: o.t, side: 'axis', axis: o.axis, allies: o.allies });
        else if (dAl === 1 && dAx === 0) wins.push({ t: o.t, side: 'allies', axis: o.axis, allies: o.allies });
        else if (o.axis === prev.allies || o.allies === prev.axis) swaps.push(o.t);
      }
      prev = o;
    }
    // "G 7, H 7, H 7, G 5" at halftime: the first G already equals the old allies value - the swap shows
    // in two steps; merge swap marks closer than 1 s
    const swapTimes = [];
    for (const t of swaps) if (!swapTimes.length || t - swapTimes[swapTimes.length - 1] > 1000) swapTimes.push(t);

    // segments between restarts
    const restarts = ctx.restarts.filter(t => t > 0);
    const bounds = [0, ...restarts, endTime + 1];
    const segments = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      if (bounds[i + 1] - bounds[i] < 200) continue;
      segments.push({ start: bounds[i], end: bounds[i + 1], restart: i > 0 || restarts.includes(0) });
    }
    // the round clock: the first HUD countdown of at least 20 s in the 20 s after a restart; the round
    // length is the duration most clocks had when they appeared (a clock seen first mid-round - the
    // recording started late - is shorter)
    // (hudTimers: {t, left} - left = the time left on the countdown when it appeared, ms)
    // A strat countdown right after the restart: the clock comes when it ends (an earlier long countdown
    // is the timeout's, called during the strat time - that round never went live)
    const all = ctx.hudTimers || [], timers = all.filter(h => h.left >= 20000);
    const clockOf = seg => {
      const strat = all.find(h => h.left < 20000 && h.t >= seg.start - 200 && h.t < seg.start + 3000);
      const from = strat ? strat.t + strat.left - 500 : seg.start - 200;
      return timers.find(h => h.t >= from && h.t < Math.min(seg.end, seg.start + 20000));
    };
    const lengths = new Map();
    for (const seg of segments) {
      const c = clockOf(seg);
      if (c && c.t > seg.start) { const len = Math.round(c.left / 1000) * 1000; lengths.set(len, (lengths.get(len) || 0) + 1); }
    }
    const roundLength = [...lengths].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const liveStart = seg => {
      const c = roundLength && clockOf(seg);
      return c ? Math.min(seg.end, Math.max(seg.start, c.t + c.left - roundLength[0])) : seg.start;
    };

    const halftimeMsgs = msgs.filter(m => /half-?time/i.test(m.text) && /ready-?up/i.test(m.text)).map(m => m.t);
    const timeoutMsgs = msgs.filter(m => /called a time-?out/i.test(m.text) || /^timeout ready-?up/i.test(m.text)).map(m => m.t);

    const rounds = [];
    for (const seg of segments) {
      const inSeg = t => t >= seg.start && t < seg.end;
      // the label arrives ~0.3 s after the restart
      const label = zpam ? labelAt(Math.min(seg.end - 1, seg.start + 1500)) : null;
      const m = label ? /^\s*Round\s+(\d+)\s*\/\s*(\d+)/i.exec(stripColors(label)) : null;
      const win = wins.find(w => inSeg(w.t));
      if (zpam ? !m : !win) continue;
      const segMsgs = msgs.filter(x => inSeg(x.t));
      const segBomb = bomb.filter(b => inSeg(b.t));
      const r = {
        kind: 'round', zpamNumber: m ? parseInt(m[1], 10) : null, zpamTotal: m ? parseInt(m[2], 10) : null,
        segStart: seg.start, segEnd: Math.min(seg.end, endTime),
        start: liveStart(seg), end: win ? win.t : null,
        winnerSide: win ? win.side : null, winnerTeam: null,
        reason: null, reasonSource: null, reasonHeuristic: false,
        complete: !!win, bomb: segBomb, statusLines: segMsgs.map(x => x.text),
        startedBeforeRecording: !seg.restart
      };
      if (win) r.winnerTeam = teams.teamOnSide(win.side, win.t - 1);
      r.kills = kills.filter(k => k.t >= seg.start && k.t < seg.end).map(k => k.index);
      if (win) decideReason(r, win, segMsgs, segBomb);
      rounds.push(r);
    }
    // a timeout replays the round: zPAM restarts the same "Round N" after it - the earlier, unfinished
    // segment of that number is not a round of its own
    for (let i = rounds.length - 2; i >= 0; i--) {
      const a = rounds[i], b = rounds[i + 1];
      if (a.zpamNumber != null && a.zpamNumber === b.zpamNumber && !a.complete) { a.kind = 'interrupted'; }
    }

    function decideReason(r, win, segMsgs, segBomb) {
      const near = re => segMsgs.some(x => re.test(x.text) && Math.abs(x.t - win.t) < 3000);
      const planted = segBomb.some(b => b.action === 'planted' && b.t <= win.t);
      const defused = segBomb.some(b => b.action === 'defused');
      const elim = side => side === attackSide ? 'Attack eliminated' : 'Defence eliminated';
      if (defused || near(/^MP_EXPLOSIVESDEFUSED/)) { r.reason = 'Bomb defused'; r.reasonSource = 'game message'; return; }
      if (near(/^MP_ALLIESHAVEBEENELIMINATED/)) { r.reason = elim('allies'); r.reasonSource = 'game message'; return; }
      if (near(/^MP_AXISHAVEBEENELIMINATED/)) { r.reason = elim('axis'); r.reasonSource = 'game message'; return; }
      if (near(/^MP_TIMEHASEXPIRED|time(?: limit)? (?:has )?(?:expired|reached)/i)) { r.reason = 'Time'; r.reasonSource = 'game message'; return; }
      if (!isSD) return;
      // S&D rules: attackers win after a plant without an elimination message = the bomb exploded;
      // defenders win without a message = time ran out
      r.reasonHeuristic = true;
      r.reasonSource = 'derived from the S&D rules (no game message)';
      if (win.side === attackSide) r.reason = planted ? 'Bomb exploded' : elim(defendSide);
      else r.reason = 'Time';
    }

    // halftimes: the side swaps of the scores and zPAM's half-time messages ("Half-time Ready-Up Mode",
    // "Half-time Overtime Ready-Up Mode": the overtime starts without a swap) - a message with a swap
    // close to it is the same halftime
    const halftimes = swapTimes.slice();
    for (const t of halftimeMsgs) {
      if (halftimes.some(h => h > t - 10000 && h < t + 180000)) continue;
      if (halftimes.some(h => Math.abs(h - t) < 5000)) continue;
      halftimes.push(t);
    }
    halftimes.sort((a, b) => a - b);
    // numbering, halves, sides, score
    const rule = winRule((roundLabels.find(l => /round\s+\d+\s*\/\s*\d+/i.test(l.value)) || {}).value);
    const first = rounds.find(r => r.kind === 'round');
    // the score at the start: the team scores before the first round (a recording that starts mid-match)
    let initial = { A: 0, B: 0 };
    if (first) {
      let o = null;
      for (const x of scoreObs) { if (x.t <= first.segStart + 1500) o = x; else break; }
      if (o) {
        const aSide = teams.sideOf('A', first.segStart + 1500);
        initial = { A: aSide === 'axis' ? o.axis : o.allies, B: aSide === 'axis' ? o.allies : o.axis };
        if (first.zpamNumber === 1) initial = { A: 0, B: 0 };
      }
    }
    const score = { A: initial.A, B: initial.B };
    let n = 0, decidedAt = null;
    for (const r of rounds) {
      r.half = 1 + halftimes.filter(h => h < r.segStart + 1).length;
      if (r.kind === 'round' && decidedAt != null) r.kind = 'aftermatch';
      if (r.kind === 'interrupted') { r.label = (r.zpamNumber != null ? r.zpamNumber : n + 1) + '*'; r.kind = 'aftermatch'; r.interrupted = true; }
      else if (r.kind === 'aftermatch') r.label = 'A';
      else { n++; r.number = r.zpamNumber != null ? r.zpamNumber : initial.A + initial.B + n; r.label = String(r.number); }
      if (r.kind === 'round' && r.winnerTeam) {
        score[r.winnerTeam]++;
        if (rule && decidedAt == null && (isDecided(rule, score.A, score.B) || (r.zpamTotal && r.zpamNumber >= r.zpamTotal))) { decidedAt = r.end; r.decidesMatch = true; }
      }
      r.scoreAfter = { A: score.A, B: score.B };
      const sideA = teams.sideOf('A', r.start + 1);
      r.sides = { A: sideA === attackSide ? 'attack' : 'defence', B: sideA === attackSide ? 'defence' : 'attack' };
      r.duration = r.end != null ? r.end - r.start : null;
    }
    // an interrupted round (timeout) is neither counted nor shown as "after the match"
    for (const r of rounds) if (r.interrupted) r.kind = 'interrupted';

    // the server's team scores at the last round win
    let serverScore = null;
    const lastWin = wins.filter(w => rounds.some(r => r.kind === 'round' && r.end === w.t)).pop();
    if (lastWin) {
      const aSide = teams.sideOf('A', lastWin.t - 1);
      serverScore = { A: aSide === 'axis' ? lastWin.axis : lastWin.allies, B: aSide === 'axis' ? lastWin.allies : lastWin.axis };
    }

    // ---- phases over the whole demo: warmup, live, halftime, timeout, aftermatch ----
    const matchRounds = rounds.filter(r => r.kind === 'round');
    const matchStart = matchRounds.length ? matchRounds[0].segStart : null;
    const matchEnd = decidedAt;
    const phases = [];
    const push = (phase, start, detail) => {
      const last = phases[phases.length - 1];
      if (last && last.phase === phase && last.detail === detail) return;
      phases.push({ phase, start, detail: detail || null });
    };
    if (!isSD && !matchRounds.length) push('live', 0, 'no round logic for this game mode');
    else {
      let prevMatch = null;
      for (const seg of segments) {
        const a = seg.start, b = seg.end;
        const r = rounds.find(x => x.segStart === a);
        if (r && r.kind === 'round') {
          push('live', a, 'R' + r.label);
          if (matchEnd != null && matchEnd >= a && matchEnd < b) push('aftermatch', matchEnd + 1, 'win rule');
          prevMatch = r;
          continue;
        }
        const label = zpam ? stripColors(labelAt(Math.min(b - 1, a + 1500)) || '') : '';
        let phase, detail = label || null;
        if (matchEnd != null && a > matchEnd) phase = 'aftermatch';
        else if (r && r.kind === 'interrupted') { phase = 'timeout'; detail = 'round interrupted by a timeout'; }
        else if (/time-?out/i.test(label)) phase = 'timeout';
        else if (!prevMatch) phase = 'warmup';
        else if (timeoutMsgs.some(t => t >= a - 2000 && t < b)) phase = 'timeout';
        else if (halftimes.some(h => h >= (prevMatch.end != null ? prevMatch.end : prevMatch.segStart) - 1000 && h < b)) phase = 'halftime';
        else phase = 'timeout';                  // (a pause without a message: most likely a timeout)
        if (phase === 'halftime' && !detail && halftimeMsgs.some(t => t >= a - 2000 && t < b)) {
          const m = msgs.find(x => x.t >= a - 2000 && x.t < b && /half-?time/i.test(x.text) && /ready-?up/i.test(x.text));
          if (m && /overtime/i.test(m.text)) detail = 'overtime';
        }
        push(phase, a, detail);
      }
      if (!phases.length) push('warmup', 0, null);
    }
    return { rounds, halftimes, halftimeFromSound: false, bomb, bombRejected: [], status: msgs, restarts,
      finalScore: score, initialScore: initial, serverScore, lastRoundEnd: lastWin ? lastWin.t : null,
      phases, matchStart, matchEnd, matchEndSource: matchEnd != null ? 'win rule' : null, matchDecided: decidedAt != null,
      winRule: rule, zpam };
  }

  function phaseAt(phases, t) {
    let lo = 0, hi = phases.length - 1, best = phases.length ? phases[0] : null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (phases[m].start <= t) { best = phases[m]; lo = m + 1; } else hi = m - 1; }
    return best ? best.phase : 'live';
  }

  C2.rounds = { analyzeRounds, phaseAt, winRule, isDecided };
});
