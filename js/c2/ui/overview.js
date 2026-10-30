/* Quick Overview: the score pill over the view (the score at the playback time, the round, map and
 * mode) and the match facts for the info popover (main.js): the final score on request, map, mode,
 * ruleset, server, POV, length, date, protocol. */
(function (C2) {
  'use strict';
  const { el, clear, coloured, fmtTime, na, approx } = C2.ui;

  /** one compact item: "LABEL value · sub" on one line, cut with an ellipsis; the full text is the tooltip */
  function card(label, value, sub, cls) {
    const node = el('div', { class: 'ov-item ' + (cls || '') },
      el('span', { class: 'ov-label' }, label),
      el('span', { class: 'ov-value' }, value, sub ? el('span', { class: 'ov-sub' }, ' · ', sub) : null));
    node.title = label + ': ' + node.querySelector('.ov-value').textContent.replace(/\s+/g, ' ').trim();
    return node;
  }

  const FINAL_KEY = 'cod2demo3d.showFinalScore';
  let live = null;                   // the score card's live parts (render -> update)

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  /** the bomb timer as the game's clock shows it: whole seconds, rounded up ('0:42') */
  const bombClock = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  /** the score at the playback time (Replay: rounds won so far), the round it is in ('Round 8', ...),
   *  the round time ('01:23') and the planted bomb's timer (match.js bombTimer: {left, heuristic} or null) */
  function update(score, roundText, roundTime, bomb, factions) {
    if (!live) return;
    if (factions) for (const k of ['A', 'B']) {
      const slot = live.flags[k];
      if (!slot || slot.dataset.f === (factions[k] || '')) continue;
      slot.dataset.f = factions[k] || '';
      slot.replaceChildren(C2.ui.factionIcon(factions[k], 14) || '');
    }
    if (live.A) {
      setText(live.A, String(score && score.A != null ? score.A : 0));
      setText(live.B, String(score && score.B != null ? score.B : 0));
    }
    setText(live.round, roundText || '');
    setText(live.time, roundTime || '');
    if (live.bomb) {
      live.bomb.hidden = !bomb;
      if (bomb) {
        setText(live.bombTime, (bomb.heuristic ? '≈ ' : '') + bombClock(bomb.left));
        const title = 'Bomb timer: ' + (bomb.heuristic ? 'derived (' + bomb.source + ': the server\'s clock was not seen)' : 'the server\'s countdown clock');
        if (live.bomb.title !== title) live.bomb.title = title;
      }
    }
  }

  /** root: the score pill; info: the box of the match facts (the info popover) */
  function render(root, app, info) {
    const d = app.data, m = d.meta;
    clear(root);
    clear(info);
    live = { flags: {} };

    // final score
    const [A, B] = d.teams;
    const played = d.rounds.filter(r => r.kind === 'round');
    let scoreCard;
    if (played.length) {
      const teamLabel = (t, cls) => el('span', { class: 'score-team ' + cls, title: t.name + (t.nameHeuristic ? '' : ' (no common clan tag found)') },
        live.flags[t.key] = el('span', { class: 'faction-slot' }),
        t.name, t.nameHeuristic ? approx('team name from the common name prefix of the players') : null);
      const halves = [];
      const hi = d.halfInfo;
      const n = Math.max(A.halves.length, B.halves.length);
      const first = A.halves.findIndex((v, i) => v != null || B.halves[i] != null);
      for (let i = Math.max(0, first); i < n; i++) {
        const label = hi.unknown ? 'half ?' : (i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : (i + 1) + 'th') + ' half';
        const partial = i === first && hi.firstPartial;
        halves.push([label + ' ' + (A.halves[i] || 0) + ':' + (B.halves[i] || 0),
          partial ? [' ', approx('this half started before the recording - only its recorded rounds' + (hi.heuristic ? '; half number from the ruleset (MR/OT) and the start score' : ''))] : null]);
      }
      const initial = d.initialScore.A + d.initialScore.B;
      // the score at the playback time (update(), from the replay) - the final score only on request,
      // so the replay does not give the result away
      const liveA = el('span', null, String(d.initialScore.A || 0)), liveB = el('span', null, String(d.initialScore.B || 0));
      const finalLine = el('div', { class: 'score-halves' },
        'Final ' + A.wins + ' : ' + B.wins + '  ·  ', halves.map((h, i) => [i ? '  ·  ' : '', h]), initial ? '  ·  recording started at ' + d.initialScore.A + ':' + d.initialScore.B : '');
      finalLine.title = finalLine.textContent;
      const toggle = el('button', { class: 'score-final-toggle', type: 'button', title: 'The result of the match (a spoiler while you watch)' });
      const showFinal = on => {
        finalLine.hidden = !on;
        toggle.textContent = on ? 'Hide final score' : 'Show final score';
        try { localStorage.setItem(FINAL_KEY, on ? 'on' : 'off'); } catch (err) { /* not stored */ }
      };
      toggle.onclick = () => showFinal(finalLine.hidden);
      let stored = null;
      try { stored = localStorage.getItem(FINAL_KEY); } catch (err) { /* default */ }
      showFinal(stored === 'on');
      root.append(teamLabel(A, 'a'),
        el('span', { class: 'score-num', title: 'rounds won up to the playback time' + (m.isSearchAndDestroy ? '' : ' (rounds of the round logic)') }, liveA, el('i', null, ':'), liveB),
        teamLabel(B, 'b'));
      scoreCard = el('div', { class: 'ov-final' }, el('div', { class: 'ov-final-head' }, el('h4', null, 'Final score'), toggle), finalLine);
      live = Object.assign(live, { A: liveA, B: liveB });
    } else {
      root.append(el('span', { class: 'score-none' }, 'Score ', na(m.isSearchAndDestroy ? 'no complete round in the demo' : 'no rounds detected - round logic is built for Search & Destroy')));
      scoreCard = null;
      live = { flags: {} };
    }
    // the meta part: round, round time, map and mode
    live.round = el('b'); live.time = el('span', { class: 'mono' });
    live.bombTime = el('span', { class: 'mono' });
    live.bomb = el('span', { class: 'bomb-timer', hidden: true }, el('span', { class: 'bomb-dot', 'aria-hidden': 'true' }), live.bombTime);
    root.append(el('span', { class: 'meta' }, el('span', { class: 'meta-round' }, live.round, ' ', live.time),
      el('span', { class: 'opt' }, (m.mapDisplay || m.map || '?') + ' · ' + (m.gametypeDisplay || m.gametype || '?'))));
    root.append(live.bomb);

    const ruleset = m.ruleset
      ? [m.ruleset, el('span', { class: 'dim' }, m.mod ? '  (' + m.mod + ')' : '')]
      : (m.mod ? m.mod : na('no ruleset announced and no mod (fs_game) set'));
    const date = m.recordDate
      ? [m.recordDate.text, ' ', m.recordDate.fileDate ? el('span', { class: 'dim' }, '(file date)') : approx(m.recordDate.source + ' - the demo stores no recording date')]
      : na('the demo stores no date and the file date is unknown');

    const items = el('div', { class: 'ov-items' });
    info.append(scoreCard || '', items);
    items.append(
      card('Map', m.mapDisplay || na('no map name'), m.map),
      card('Mode', m.gametypeDisplay || na('no game type'), m.gametype),
      card('Ruleset', ruleset),
      card('Protocol', m.protocolLabel, m.gameVersion ? m.gameVersion.split(' ')[0] : null),
      card('Server name', m.hostname ? coloured(m.hostname) : na('no sv_hostname in the serverinfo'), m.serverVersion || null),
      card('Demo POV', m.povClient != null ? app.playerNode(m.povClient) : na('no recording client number'), m.povClient != null ? 'client ' + m.povClient : null),
      card('Length', fmtTime(m.durationMs), (m.stats ? m.stats.snapshots.toLocaleString('en') + ' snapshots' : '')),
      card('Record date', date, null)
    );
    // the rules: the server's settings in the demo (serverinfo, the dvars it announces, zPAM's client dvars)
    const rules = rulesOf(d);
    if (rules.length) {
      const g = el('div', { class: 'ov-items' }, el('div', { class: 'ov-sub-h' }, 'Rules'));
      for (const [label, value, sub] of rules) g.append(card(label, value, sub));
      info.append(g);
    }
    // zPAM's match info (its client dvars: _matchinfo.gsc)
    const zi = d.zpamInfo;
    if (zi) {
      const v = k => (zi[k] ? C2.text.stripColors(zi[k].value).replace(/\s+/g, ' ').trim() : '');
      const name = k => v(k).replace(/^\d+\s+/, '');
      const g = el('div', { class: 'ov-items' }, el('div', { class: 'ov-sub-h', title: "zPAM's match info as the server sent it to the recording player (ui_matchinfo_*): the last values in the demo" }, 'zPAM match info'));
      for (const [label, value, sub] of [
        ['Team 1', name('ui_matchinfo_team1_name'), v('ui_matchinfo_team1_team')],
        ['Team 2', name('ui_matchinfo_team2_name'), v('ui_matchinfo_team2_team')],
        ['Round', v('ui_matchinfo_round'), v('ui_matchinfo_halfinfo').replace(/:\s+/, ': ')],
        ['Match time', v('ui_matchinfo_matchtime').replace(/^Match time:\s*/, ''), v('ui_matchinfo_state')],
        ['Timeouts left', v('ui_timeout_info').replace(/[()]/g, ''), null]
      ]) if (value) g.append(card(label, value, sub || null));
      if (g.children.length > 1) info.append(g);
    }
    // the "≈" marks explain themselves on hover - say so once, under the facts, where any is shown
    if (root.querySelector('.approx') || info.querySelector('.approx')) {
      info.append(el('div', { class: 'ov-legend', title: 'Values marked ≈ are heuristic: the demo does not state them, they are derived. Hover a mark for how.' },
        el('span', { class: 'approx' }, '≈'), ' heuristic value - hover a mark for how it was derived'));
    }
  }

  // zPAM's weapon menu states (_weapon_limiter.gsc: 0 hidden - not on this server, 1 available, 2 disabled - the class
  // limit reached, 3 the recorder's own) -> the weapon of a ui_allow_ name
  const ALLOW_WEAPON = { kar98ksniper: 'kar98k_sniper_mp', enfieldsniper: 'enfield_scope_mp', nagantsniper: 'mosin_nagant_sniper_mp',
    nagant: 'mosin_nagant_mp', m1carbine: 'm1carbine_mp', m1garand: 'm1garand_mp', greasegun: 'greasegun_mp', thompson: 'thompson_mp',
    bar: 'bar_mp', springfield: 'springfield_mp', enfield: 'enfield_mp', sten: 'sten_mp', bren: 'bren_mp', kar98k: 'kar98k_mp', g43: 'g43_mp',
    mp40: 'mp40_mp', mp44: 'mp44_mp', fg42: 'fg42_mp', svt40: 'svt40_mp', ppsh: 'ppsh_mp', pps42: 'pps42_mp', shotgun: 'shotgun_mp' };
  /** the match rules the demo states -> [[label, value, sub]] */
  function rulesOf(d) {
    const m = d.meta, si = d.serverinfo || {}, dv = m.dvars || {}, zi = d.zpamInfo || {}, out = [];
    const yes = v => (v === '1' ? 'on' : v === '0' ? 'off' : v);
    out.push(['Game type', m.gametypeDisplay || m.gametype, m.ruleset || null]);
    if (si.scr_friendlyfire != null) out.push(['Friendly fire', { 0: 'off', 1: 'on', 2: 'reflect', 3: 'shared' }[si.scr_friendlyfire] || si.scr_friendlyfire, null]);
    if (si.scr_killcam != null) out.push(['Kill cam', yes(si.scr_killcam), null]);
    const gt = (m.gametype || '').toLowerCase();
    for (const k of ['scorelimit', 'timelimit', 'roundlimit', 'roundlength']) {
      const v = dv['ui_' + gt + '_' + k] || si['scr_' + gt + '_' + k];
      if (v != null && v !== '') out.push([k.replace('limit', ' limit').replace('length', ' length').replace(/^./, c => c.toUpperCase()), v + (k === 'timelimit' || k === 'roundlength' ? ' min' : ''), null]);
    }
    const fuse = (d.bombTrack || []).find(b => b.state === 'planted' && b.explodeAt != null);
    if (fuse) out.push(['Bomb timer', Math.round((fuse.explodeAt - fuse.t) / 1000) + ' s', fuse.timerSource === 'clock' ? "the server's clock" : '≈ ' + fuse.timerSource]);
    if (si.g_antilag != null) out.push(['Antilag', yes(si.g_antilag), null]);
    // zPAM: the weapons the server offered and the ones limited at times (the recorder's weapon menu)
    const off = [], limited = [];
    for (const [k, o] of Object.entries(zi)) {
      const w = ALLOW_WEAPON[k.replace(/^ui_allow_/, '')];
      if (!k.startsWith('ui_allow_') || !w) continue;
      const label = C2.weapons.label(w);
      if (o.values.every(x => x === '0')) off.push(label);
      else if (o.values.includes('2')) limited.push(label);
    }
    if (off.length) out.push(['Not on the server', off.join(', '), "zPAM's weapon menu (the recorder's team)"]);
    if (limited.length) out.push(['Limited', limited.join(', '), 'the class limit was reached at times']);
    const pistol = zi.ui_allow_pistol, bash = zi.ui_allow_bash;
    if (zi.ui_allow_timeout) out.push(['Timeouts', zi.ui_allow_timeout.values.includes('0') ? 'not allowed' : 'allowed', null]);
    if (pistol && pistol.values.some(x => x !== '0')) out.push(['Pistol', 'selectable at strat time', null]);
    if (bash && bash.values.length) out.push(['Bash mode', bash.values.includes('1') ? 'available' : 'not available', null]);
    return out;
  }

  C2.tabs.overview = { render, update };
})(window.C2);
