/* Decoding of reliable server commands of CoD2 (CG_ServerCommand of the 1.3 client: the first
 * character selects the handler). */
C2.define('servercmd', function (C2) {
  'use strict';
  const { tokenize } = C2.text;
  const NAMES = {
    B: 'map_restart', C: 'set_equipped_offhand', D: 'reverb_deactivate', E: 'channel_volume_set',
    F: 'channel_volume_deactivate', G: 'team_score_axis', H: 'team_score_allies', I: 'menu_show_notify',
    J: 'reset_player_muting', K: 'close_ingame_menu',
    a: 'select_weapon', b: 'scoreboard', c: 'announcement', d: 'configstring', e: 'print',
    f: 'game_message', g: 'bold_game_message', h: 'chat', i: 'team_chat', n: 'map_restart_persist',
    o: 'play_music', p: 'stop_music', q: 'fade_sounds', r: 'reverb', s: 'local_sound', t: 'open_script_menu',
    u: 'close_script_menu', v: 'set_client_dvars', w: 'disconnect'
  };
  const int = s => { const v = parseInt(s, 10); return Number.isFinite(v) ? v : null; };

  function decode(text) {
    const verb = text ? text[0] : '';
    const out = { verb, name: NAMES[verb] || 'unknown' };
    if (verb === 'd') {
      const argv = tokenize(text, 3);
      out.index = argv.length > 1 ? int(argv[1]) : null;
      out.value = argv.length > 2 ? argv[2] : '';
      return out;
    }
    const args = tokenize(text).slice(1);
    out.args = args;
    switch (verb) {
      case 'b': {
        // b <count> <score axis> <score allies> then per client: client score ping deaths statusIcon
        const n = int(args[0]) || 0;
        out.scoreAxis = int(args[1]);
        out.scoreAllies = int(args[2]);
        out.entries = [];
        for (let i = 0; i < Math.min(n, 64); i++) {
          const b = 3 + 5 * i;
          if (b + 5 > args.length) break;
          const v = args.slice(b, b + 5).map(int);
          out.entries.push({ client: v[0], score: v[1], ping: v[2], deaths: v[3], statusIcon: v[4], kills: null, assists: null });
        }
        break;
      }
      case 'h': case 'i': out.text = args[0] || ''; out.scope = verb === 'h' ? 'all' : 'team'; break;
      case 'c': case 'e': case 'f': case 'g': out.text = args[0] || ''; break;
      case 'G': case 'H': out.team = verb === 'G' ? 'axis' : 'allies'; out.score = int(args[0]); break;
      case 'v':
        out.dvars = [];
        for (let i = 0; i < args.length; i += 2) out.dvars.push([args[i], args[i + 1] == null ? '' : args[i + 1]]);
        break;
      case 's': out.sound = int(args[0]); break;
      case 'w': out.reason = args[0] || ''; break;
      default: break;
    }
    return out;
  }

  C2.servercmd = { decode, NAMES };
});
