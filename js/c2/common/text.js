/* Text helpers: CoD colour codes, info strings, engine tokenizer. */
C2.define('text', function (C2) {
  'use strict';
  const CTRL_RE = /[\x00-\x1f\x7f]/g;
  const CODE = /[0-9:;<=>?]/;              // (^: ^; ^< ^= ^> ^? render in the default colour)

  /** CoD colour codes -> [{text, color ('0'..'9' | null = default)}]. The game (RB_DrawTextWithCursor of
   *  the 1.3 client; CoD2x keeps it, mss32/drawing.cpp) takes "^" + a digit as a colour and draws any
   *  other caret as a caret, so a name's "^^24" shows as "^4" in colour 2. A run of carets followed by
   *  codes is taken here as one code - the colour of its first character, the run's carets and as many
   *  codes as carets dropped (zPAM's removeColorsFromString) - so the names keep no "^4" leftovers. */
  function colorRuns(s) {
    s = String(s == null ? '' : s).replace(CTRL_RE, '');
    const out = [];
    let text = '', color = null;
    for (let i = 0; i < s.length;) {
      let k = 0;
      while (s[i + k] === '^') k++;
      if (k && i + k < s.length && CODE.test(s[i + k])) {
        if (text) out.push({ text, color });
        text = '';
        color = /[0-9]/.test(s[i + k]) ? s[i + k] : null;
        let j = i + k + 1, n = 1;
        while (n < k && j < s.length && CODE.test(s[j])) { j++; n++; }
        i = j;
      } else if (k) { text += s.slice(i, i + k); i += k; } else { text += s[i]; i++; }
    }
    if (text) out.push({ text, color });
    return out;
  }

  /** Remove colour codes (colorRuns: "^1", also runs like "^^24") and control / localisation marker
   *  bytes (0x14-0x16). */
  function stripColors(s) {
    return colorRuns(s).map(r => r.text).join('');
  }

  /** "\key\value\key\value" -> object */
  function parseInfostring(s) {
    const parts = String(s || '').split('\\');
    if (parts[0] === '') parts.shift();
    const out = {};
    for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return out;
  }

  const isSpace = c => { const o = c.charCodeAt(0); return o <= 0x20 && o !== 0x14 && o !== 0x15 && o !== 0x16; };

  /** Port of Cmd_TokenizeStringInternal; the last allowed token gets the raw remainder. */
  function tokenize(text, maxTokens = 512) {
    const argv = [];
    let i = 0;
    const n = text.length;
    for (;;) {
      for (;;) {
        while (i < n && isSpace(text[i])) i++;
        if (i >= n) return argv;
        if (text.startsWith('//', i)) return argv;
        if (text.startsWith('/*', i)) {
          const j = text.indexOf('*/', i + 2);
          if (j < 0) return argv;
          i = j + 2;
          continue;
        }
        break;
      }
      if (--maxTokens === 0) { argv.push(text.slice(i)); return argv; }
      if (text[i] === '"') {
        let j = i + 1, buf = '';
        while (j < n && text[j] !== '"') {
          if (text[j] === '\\' && text[j + 1] === '"') j++;
          buf += text[j++];
        }
        argv.push(buf);
        if (j >= n) return argv;
        i = j + 1;
        if (i >= n) return argv;
      } else {
        let j = i;
        while (j < n && !isSpace(text[j]) && !(text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*'))) j++;
        argv.push(text.slice(i, j));
        i = j;
      }
    }
  }

  /** ms -> "mm:ss" ("h:mm:ss" from one hour) - the one time format of the app (UI and warnings) */
  function fmtTime(ms) {
    if (ms == null || !Number.isFinite(ms)) return 'n/a';
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  C2.text = { stripColors, colorRuns, parseInfostring, tokenize, fmtTime };
});
