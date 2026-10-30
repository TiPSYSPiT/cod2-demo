/* The game's HUD in first person, drawn on a 2D canvas (the overlay over the 3D view, and every frame of the
 * video export). Everything is the game's: the layout from the HUD menu files (ui_mp/hud.menu, the stock game's
 * or zPAM's: tools/export/hud_export.py -> maps3d/_hud/hud.json), the fonts, images and strings from the game
 * files, and what the client code draws (the decompiled 1.3 client, cod2x/src/other):
 *   placement    CalcScreenPlacement: the 640 x 480 screen, one scale (height / 480) for both axes, anchored
 *                left / centre / right and top / centre / bottom - a wider screen keeps the HUD at its edges
 *   fonts        UI_GetFontHandle: small / normal / big / extra big by the text's height on the screen
 *                (ui_smallFont 0.25, ui_bigFont 0.4, ui_extraBigFont 0.55); a text scale of 1 is 48 units high
 *   compass      CG_DrawPlayerCompassBack / the face (rotated by the view yaw - the map's north, with the
 *                face's spring CG_UpdateCompassOrientation) / CG_DrawCompassFriendlies (teammates in the
 *                snapshot, their firing pings, the enemies' firing pings) / the objective pointers
 *                (cg_hudCompassSize 1, cg_hudCompassMaxRange 1500, MinRange / MinRadius 0, pings 2 s)
 *   ammo         CG_DrawPlayerAmmoValue: clip "%2i" | reserve "%3i", the clip pulsing red at a third of its
 *                size, the reserve red at a fifth of the maximum (and the counter's back); the weapon name
 *                1.8 s after a switch
 *   grenades     CG_DrawOffHandIcon / Ammo / Name: the frag and smoke grenades the player owns (their HUD
 *                icon, the count red at 0)
 *   messages     CG_Obituary + CL_DeathMessagePrint into the game message window (Con_DrawNotify: x 6, above
 *                the compass, 12 units a line, 5 s, scrolling in 250 ms, fading in 250 / out 500 ms, the
 *                oldest 3 of 8 lines cut short by a new one); "You killed" / "Killed by" centred low
 *                (CG_PriorityCenterPrint, 7 s); the server's game messages in the same window and its bold
 *                messages in the centre
 *   script HUD   CG_Draw2dHudElems: the server's HUD elements in the player state (the team score of the
 *                stock game and zPAM, zPAM's players left, the round clock ...), with their fades, moves and
 *                scale changes
 * Exact for the recording player (the demo has one player state); for another player the compass, the
 * messages and the team score. */
import { fetchJSON, fetchData } from './data.js';

const C2 = window.C2;
const BASE = 'maps3d/_hud/';
const D2R = Math.PI / 180;
// the colour codes ^0 .. ^7 (g_color_table), ^8 / ^9: g_TeamColor_Allies / Axis (CL_LookupColor). The team colours
// are the server's dvars - the game scripts set them per faction (American green, British blue, Russian red, German
// grey); the engine's defaults when a demo has none
const TEAM_ALLIES = [0.5, 0.5, 1], TEAM_AXIS = [1, 0.5, 0.5];
const BASE_COLORS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 1]];
const dvarColor = (v, def) => { const a = String(v || '').trim().split(/\s+/).slice(0, 3).map(Number); return a.length === 3 && a.every(Number.isFinite) ? a : def; };
const WHITE = [1, 1, 1];
const LOW = [0.89, 0.18, 0.01];             // the low ammo colour of the client code
const FONT_SMALL = 0.25, FONT_BIG = 0.4, FONT_EXTRABIG = 0.55;
// the client's defaults (setMatch: the server's values from the demo replace them)
const COMPASS = { size: 1, maxRange: 1500, minRange: 0, minRadius: 0, ping: 2000, objMaxRange: 2048, objMinAlpha: 1 };
const NOTIFY = { x: 6, line: 12, time: 5000, scroll: 250, fadeIn: 250, fadeOut: 500, ring: 8, cut: 3 };
const BOLD = { line: 12, time: 8000 };
const MOD_ICONS = { MOD_MELEE: 'killiconmelee', MOD_HEAD_SHOT: 'killiconheadshot', MOD_CRUSH: 'killiconcrush',
  MOD_FALLING: 'killiconfalling', MOD_SUICIDE: 'killiconsuicide' };
const OFFHAND_NAMES = ['', 'WEAPON_FRAGGRENADE', 'WEAPON_SMOKEGRENADE'];
// the client's defaults of the dvars the player-state parts use (CG_RegisterDvars of the decompiled 1.3 client; the
// overlay's regenPauseTime from the Windows build: 5000)
const HEALTH = { fade: 2000, fadeTime: 700, pulseCritical: 0.33, pulseInjured: 1, rateCritical: 500, rateInjured: 1000, lagSpeed: 0.0012 };
const LOW_HEALTH = { pulseStart: 0.35, one: 150, two: 320, three: 400, twoMul: 0.7, threeMul: 0.6, endAlpha: 0, endTime: 700,
  regenPause: 5000, mags: [1, 0.8, 0.6, 0.3] };
const STANCE = { fade: 1700, fadeTime: 700, proneY: -160, blocked: 1500 };
const DAMAGE = { w: 128, h: 64, offset: 128, time: 2000, flash: 500 };
const HINT_FADE = 100;
const HINT_ICONS = [null, null, 'gfx/icons/hint_usable', 'hint_health', 'hint_friendly'];
// the scoreboard: cg_scoreboardBannerHeight 24, 12 unit rows, the list width (382, 374 with a scroll bar) and the
// columns of the client's table (type: 6 voice, 5 status, 0 name, 2 score, 3 deaths, 4 ping; share of the width;
// title; 2 = right aligned)
const SB = { banner: 24, item: 12, widths: [382, 374], cols: [[6, 0.05, '', 0], [5, 0.05, '', 0], [0, 0.47, '', 0],
  [2, 0.13, 'CGAME_SB_SCORE', 2], [3, 0.13, 'CGAME_SB_DEATHS', 2], [4, 0.17, 'CGAME_SB_PING', 2]] };
/** CG_FadeColor: 1 from start, fading over the last fadeTime of total ms; 0 before / after (or without a start) */
const fade = (t, start, total, fadeTime) => {
  if (start == null) return 0;
  const age = t - start;
  if (age < 0 || age >= total) return 0;
  return total - age < fadeTime ? (total - age) / fadeTime : 1;
};
const hash32 = x => { let h = Math.imul((x | 0) ^ 0x9E3779B9, 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); return (h ^ (h >>> 16)) >>> 0; };
// ownerdraw numbers of the HUD menus (ui/menudefinition.h) and the option that shows them
const OWNERDRAW = { 5: 'ammo', 6: 'ammo', 81: 'ammo', 84: 'compass', 85: 'compass', 86: 'compass', 89: 'compass',
  100: 'grenades', 101: 'grenades', 102: 'grenades', 103: 'grenades', 104: 'grenades', 105: 'grenades',
  79: 'health', 95: 'health', 109: 'lowHealth', 20: 'stance', 72: 'hints', 80: 'hints' };
// the parts drawn from the recording player's player state only
const RECORDER_PARTS = new Set(['ammo', 'grenades', 'server', 'health', 'lowHealth', 'stance', 'hints', 'matchinfo']);
// the team score: the server's HUD elements of _hud_teamscore.gsc (stock 1.3 and zPAM) / _hud_playerscore.gsc
// (deathmatch) at these places (left / top): the icons at 6, 28 / 50, the scores at 36 and the "/ limit" at 49
const SCORE_SPOTS = new Set(['6,28', '6,50', '36,26', '36,48', '49,26', '49,48']);
const ENTITYNUM_WORLD = 1022;

export const HUD_PARTS = [['compass', 'Compass', true], ['score', 'Team score', false], ['killfeed', 'Kill feed', false],
  ['ammo', 'Ammo', true], ['grenades', 'Grenades', true], ['server', 'Server HUD', false], ['lowHealth', 'Low health', true],
  ['health', 'Health bar', false], ['damage', 'Damage direction', true], ['stance', 'Stance', true], ['hints', 'Hints', true],
  ['scoreboard', 'Scoreboard', true], ['matchinfo', 'zPAM match info', true]];

const lower = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m + 1; else hi = m; } return lo - 1; };
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const norm360 = a => ((a % 360) + 360) % 360;
const norm180 = a => { a = norm360(a); return a > 180 ? a - 360 : a; };
const u2f = (() => { const b = new DataView(new ArrayBuffer(4)); return u => { b.setUint32(0, u >>> 0); return b.getFloat32(0); }; })();
const rgba = c => [(c & 255) / 255, ((c >>> 8) & 255) / 255, ((c >>> 16) & 255) / 255, ((c >>> 24) & 255) / 255];
const fmtG = v => String(Number(v.toPrecision(6)));
const timer = (ms, tenths) => {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
  const base = h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  return tenths ? base + '.' + d : base;
};

/** the fonts (glyph tables over one image) and the drawing of text runs, cached per text, size and colour */
class Fonts {
  constructor(info, atlas) {
    this.atlas = atlas;
    this.fonts = {};
    for (const [name, f] of Object.entries(info)) {
      const map = new Map();
      for (const g of f.glyphs) map.set(g[0], g);
      this.fonts[name] = { name, height: f.height, map, fallback: f.glyphs[14] };
    }
    this.cache = new Map();
    this.codes = BASE_COLORS.concat([TEAM_ALLIES, TEAM_AXIS]);
  }
  /** UI_GetFontHandle: kind 0 default / 1 normal, 2 big, 3 small, 4 bold, 5 console */
  pick(kind, scale, real) {
    const F = this.fonts;
    if (kind === 5) return F.consoleFont;
    if (kind === 3) return F.smallFont;
    if (kind === 2) return F.bigFont;
    const h = scale * real;
    if (h <= FONT_SMALL) return F.smallFont;
    if (kind === 4) return h >= FONT_BIG ? F.boldFont : F.normalFont;
    if (h >= FONT_EXTRABIG) return F.extraBigFont;
    return h >= FONT_BIG ? F.bigFont : F.normalFont;
  }
  glyph(font, code) { return (code >= 32 && font.map.get(code)) || font.fallback; }
  /** the text's width (virtual units; colour codes skipped) */
  width(font, text, scale) {
    const k = scale * 48 / font.height;
    let w = 0, best = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 94 && i + 1 < text.length && /[0-9]/.test(text[i + 1])) { i++; continue; }
      if (c === 10) { best = Math.max(best, w); w = 0; continue; }
      w += this.glyph(font, c)[3] * k;
    }
    return Math.max(best, w);
  }
  /** the colour runs of a text: [[text, colour]] (^0 .. ^9 switch, base = the starting colour) */
  runs(text, base) {
    const out = [];
    let cur = '', col = base;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '^' && i + 1 < text.length && /[0-9]/.test(text[i + 1])) {
        if (cur) out.push([cur, col]);
        cur = ''; col = this.codes[Number(text[i + 1])];
        i++;
        continue;
      }
      cur += text[i];
    }
    if (cur) out.push([cur, col]);
    return out;
  }
  /** one run (no colour codes) rendered white at k device pixels per glyph pixel, tinted -> {canvas, ox, oy}
   *  (ox / oy: the canvas' corner from the pen position at the baseline, device pixels) */
  run(font, text, k, color) {
    const key = font.name + '|' + k.toFixed(3) + '|' + color.join(',') + '|' + text;
    let r = this.cache.get(key);
    if (r) return r;
    let x = 0, minY = 0, maxY = 0, maxX = 0;
    for (const ch of text) { const g = this.glyph(font, ch.charCodeAt(0)); minY = Math.min(minY, g[2]); maxY = Math.max(maxY, g[2] + g[5]); maxX = Math.max(maxX, x + g[1] + g[4]); x += g[3]; }
    const w = Math.max(1, Math.ceil(Math.max(maxX, x) * k) + 2), h = Math.max(1, Math.ceil((maxY - minY) * k) + 2);
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g2 = cv.getContext('2d');
    g2.imageSmoothingEnabled = true;
    const A = this.atlas;
    x = 0;
    for (const ch of text) {
      const g = this.glyph(font, ch.charCodeAt(0));
      if (g[4] && g[5]) g2.drawImage(A, g[6] * A.width, g[7] * A.height, (g[8] - g[6]) * A.width, (g[9] - g[7]) * A.height, 1 + (x + g[1]) * k, 1 + (g[2] - minY) * k, g[4] * k, g[5] * k);
      x += g[3];
    }
    g2.globalCompositeOperation = 'source-in';
    g2.fillStyle = 'rgb(' + color.map(c => Math.round(c * 255)).join(',') + ')';
    g2.fillRect(0, 0, w, h);
    r = { canvas: cv, ox: -1, oy: minY * k - 1, adv: x * k };
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(key, r);
    return r;
  }
}

export class Hud {
  constructor() {
    this.C = Object.assign({}, COMPASS);
    this.data = null;
    this.ready = null;
    this.images = new Map();          // material (lower case) -> ImageBitmap
    this.tints = new Map();
    this.parts = Object.fromEntries(HUD_PARTS.map(([k, , on]) => [k, on]));
    this.M = null;
  }

  /** hud.json, the font image and every HUD image (once) -> true when the HUD can be drawn */
  load() {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const d = await fetchJSON(BASE + 'hud.json');
          const bitmap = async rel => createImageBitmap(await (await fetchData('maps3d/' + rel)).blob());
          const atlas = await bitmap(d.fontImage.image);
          await Promise.all(Object.entries(d.materials).map(async ([name, m]) => {
            if (m.image) { try { this.images.set(name, await bitmap(m.image)); } catch (err) { /* drawn as nothing */ } }
          }));
          this.data = d;
          this.fonts = new Fonts(d.fonts, atlas);
          if (this.M) this.setMatch(this.M);
          return true;
        } catch (err) {
          console.warn('HUD not available:', err.message);
          return false;
        }
      })();
    }
    return this.ready;
  }

  /** the match: the layout (zPAM's for a zPAM server), the weapon lists' ammo slots, the config strings, client
   *  dvars and messages over time, the obituaries */
  setMatch(M) {
    this.M = M;
    // the compass with the server's HUD settings (its client dvars in the demo, cg_hudCompass* / cg_hudObjective*),
    // else the client's defaults
    this.C = Object.assign({}, COMPASS);
    const cv = {};
    for (const [, n, v] of (M.d.psHud && M.d.psHud.dvars) || []) cv[n] = Number(v);
    const set = (k, n, f = x => x) => { if (Number.isFinite(cv[n])) this.C[k] = f(cv[n]); };
    set('size', 'cg_hudcompasssize'); set('maxRange', 'cg_hudcompassmaxrange'); set('minRange', 'cg_hudcompassminrange');
    set('minRadius', 'cg_hudcompassminradius'); set('ping', 'cg_hudcompasssoundpingfadetime', x => x * 1000);
    set('objMaxRange', 'cg_hudobjectivemaxrange'); set('objMinAlpha', 'cg_hudobjectiveminalpha');
    const d = M.d, D = this.data;
    if (!D) return;
    const sv = d.meta.dvars || {};
    this.allies = dvarColor(sv.g_TeamColor_Allies, TEAM_ALLIES);
    this.axis = dvarColor(sv.g_TeamColor_Axis, TEAM_AXIS);
    this.fonts.codes = BASE_COLORS.concat([this.allies, this.axis]);
    this.layout = (d.meta.zpamVersion && D.layouts.zpam) || D.layouts.stock;
    this.H = d.psHud || null;
    this.W = d.psWeapon || null;
    // weapon lists -> per weapon index its HUD entry and ammo / clip slot (BG_SetupAmmoIndexes / ClipIndexes:
    // numbered by the ammo / clip names in the order the weapons were registered, the empty weapon 0 first)
    this.lists = (d.weaponLists || []).map(l => {
      const an = [''], cn = [''], out = [null];
      for (const name of l.list) {
        const w = D.weapons[name] || {};
        let ai = an.indexOf(w.ammoName || ''); if (ai < 0) { ai = an.length; an.push(w.ammoName || ''); }
        let ci = cn.indexOf(w.clipName || ''); if (ci < 0) { ci = cn.length; cn.push(w.clipName || ''); }
        out.push({ name, w, ammo: ai, clip: ci });
      }
      return { t: l.t, weapons: out };
    });
    // config strings (north yaw, HUD element strings, materials) over time
    const cs = new Map();
    if (this.H) {
      for (const [i, v] of Object.entries(this.H.cs.init)) cs.set(Number(i), [[-Infinity, v]]);
      for (const [t, i, v] of this.H.cs.changes) { if (!cs.has(i)) cs.set(i, []); cs.get(i).push([t, v]); }
    }
    this.cs = cs;
    // client dvars set by the server: name -> [[t, value]]
    const dv = new Map();
    if (this.H) for (const [t, n, v] of this.H.dvars) { if (!dv.has(n)) dv.set(n, []); dv.get(n).push([t, v]); }
    this.dvars = dv;
    // the game message window: the obituaries and the server's game messages; the bold window
    const kills = d.kills.map(k => ({ t: k.t, kind: 'kill', k }));
    const msgs = this.H ? this.H.messages.filter(m => m[1] === 'f').map(m => ({ t: m[0], kind: 'msg', text: m[2] })) : [];
    this.notify = kills.concat(msgs).sort((a, b) => a.t - b.t);
    this.notifyT = this.notify.map(e => e.t);
    this.bold = this.H ? this.H.messages.filter(m => m[1] === 'g').map(m => ({ t: m[0], kind: 'msg', text: m[2] })) : [];
    this.boldT = this.bold.map(e => e.t);
    this.killT = d.kills.map(k => k.t);
    this.teams = new Map(d.teams.map(t => [t.key, t]));
    this._damages = null;
  }

  // ---- lookups ----
  csAt(i, t) { const a = this.cs.get(i); if (!a) return ''; let v = ''; for (const [ct, cv] of a) { if (ct <= t) v = cv; else break; } return v; }
  dvarAt(n, t) { const a = this.dvars.get(String(n).toLowerCase()); if (!a) return ''; let v = ''; for (const [dt, dvv] of a) { if (dt <= t) v = dvv; else break; } return v; }
  weaponAt(index, t) {
    let l = null;
    for (const x of this.lists) { if (x.t <= t) l = x; else break; }
    return l && index > 0 && index < l.weapons.length ? l.weapons[index] : null;
  }
  /** the side (axis / allies) of client cl at t: the team's start side, swapped at every half time */
  side(cl, t) {
    const p = this.M.player(cl), team = p && this.teams.get(p.team);
    if (!team || (team.startSide !== 'axis' && team.startSide !== 'allies')) return null;
    let s = team.startSide;
    for (const w of this.M.d.swaps || []) if (w <= t) s = s === 'axis' ? 'allies' : 'axis';
    return s;
  }
  teamColor(cl, t) { const s = this.side(cl, t); return s === 'allies' ? this.allies : s === 'axis' ? this.axis : WHITE; }
  /** a localized string: a reference -> the English text; "REF\x15param\x14REF2..." with &&1, &&2 */
  localize(s) {
    if (!s) return '';
    const S = this.data.strings;
    const parts = s.split(/([\x14\x15])/);
    const head = parts[0];
    const params = [];
    for (let i = 1; i < parts.length; i += 2) params.push(parts[i] === '\x14' ? (S[parts[i + 1]] != null ? S[parts[i + 1]] : parts[i + 1]) : parts[i + 1]);
    if (!head) return params.join('');
    let out = S[head] != null ? S[head] : head;
    out = out.replace(/&&(\d)/g, (m, n) => (params[n - 1] != null ? params[n - 1] : ''));
    return out.replace(/&&(\d)/g, (m, n) => (params[n - 1] != null ? params[n - 1] : ''));
  }
  /** the recording player's player state row at t (the snapshot at or before t) or -1 */
  row(cl, t) { return this.W ? this.M.psRow(cl, t) : -1; }

  // ---- drawing primitives ----
  /** the screen: device pixels, the safe area (insets: the viewer's own controls over the canvas) */
  screen(g, w, h, insets) {
    const i = insets || { l: 0, t: 0, r: 0, b: 0 };
    const aw = Math.max(1, w - i.l - i.r), ah = Math.max(1, h - i.t - i.b);
    this.S = { g, w, h, l: i.l, t: i.t, aw, ah, s: ah / 480 };
  }
  /** CalcScreenPlacement: a virtual rectangle with its alignments -> device pixels [x, y, w, h]; the fullscreen
   *  alignment (4: the low-health overlay) stretches over the whole view, the others keep to the safe area */
  place(x, y, w, h, ha, va) {
    const S = this.S, s = S.s;
    let X, Y, Wd = w * s, Hd = h * s;
    switch (ha) {
      case 1: X = S.l + x * s; break;
      case 2: case 7: X = S.l + S.aw / 2 + x * s; break;
      case 3: X = S.l + S.aw + x * s; break;
      case 4: X = x * S.w / 640; Wd = w * S.w / 640; break;
      case 5: X = x; Wd = w; break;
      default: X = S.l + (S.aw - 640 * s) / 2 + x * s;
    }
    switch (va) {
      case 1: case 0: case 6: Y = S.t + y * s; break;
      case 2: case 7: Y = S.t + S.ah / 2 + y * s; break;
      case 3: Y = S.t + S.ah + y * s; break;
      case 4: Y = y * S.h / 480; Hd = h * S.h / 480; break;
      case 5: Y = y; Hd = h; break;
      default: Y = S.t + y * s;
    }
    return [X, Y, Wd, Hd];
  }
  tinted(name, color) {
    const img = this.images.get(name);
    if (!img || (color[0] === 1 && color[1] === 1 && color[2] === 1)) return img || null;
    const key = name + '|' + color.join(',');
    let cv = this.tints.get(key);
    if (!cv) {
      cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(img.width, img.height) : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = 'rgb(' + color.map(c => Math.round(c * 255)).join(',') + ')';
      g.fillRect(0, 0, img.width, img.height);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(img, 0, 0);
      this.tints.set(key, cv);
    }
    return cv;
  }
  /** an image in a device rectangle, tinted, with alpha; rotated (degrees, clockwise) about its centre;
   *  mirrored */
  pic(name, r, color, alpha, angle = 0, flip = false) {
    const g = this.S.g, m = name && this.data.materials[name.toLowerCase()];
    if (!m || alpha <= 0) return;
    g.globalAlpha = clamp01(alpha);
    if (m.color) {           // $white / $black
      const c = m.color === 'black' ? [0, 0, 0] : color;
      g.fillStyle = 'rgb(' + c.map(v => Math.round(v * 255)).join(',') + ')';
      g.fillRect(r[0], r[1], r[2], r[3]);
      return;
    }
    const img = this.tinted(name.toLowerCase(), color);
    if (!img) return;
    if (!angle && !flip) { g.drawImage(img, r[0], r[1], r[2], r[3]); return; }
    g.save();
    g.translate(r[0] + r[2] / 2, r[1] + r[3] / 2);
    if (angle) g.rotate(angle * D2R);
    if (flip) g.scale(-1, 1);
    g.drawImage(img, -r[2] / 2, -r[3] / 2, r[2], r[3]);
    g.restore();
  }
  /** a text at a device position (x: the pen's start, y: the baseline), scale (virtual), font kind, colour
   *  (^ codes switch it), alpha, style 3 = shadowed (6: more) -> its width (device pixels) */
  text(str, x, y, scale, kind, color, alpha, style = 3) {
    if (!str || alpha <= 0) return 0;
    const S = this.S, g = S.g, F = this.fonts, font = F.pick(kind, scale, S.s);
    const k = scale * 48 / font.height * S.s;
    const shadow = style === 3 || style === 6 ? Math.max(1, Math.round(S.s * (style === 6 ? 2 : 1))) : 0;
    let px = x, py = y, total = 0;
    g.globalAlpha = clamp01(alpha);
    for (const line of str.split('\n')) {
      px = x;
      for (const [t, c] of F.runs(line, color)) {
        if (shadow) { const r = F.run(font, t, k, [0, 0, 0]); g.drawImage(r.canvas, Math.round(px + r.ox + shadow), Math.round(py + r.oy + shadow)); }
        const r = F.run(font, t, k, c);
        g.drawImage(r.canvas, Math.round(px + r.ox), Math.round(py + r.oy));
        px += r.adv;
      }
      total = Math.max(total, px - x);
      py += scale * 48 * S.s;
    }
    return total;
  }
  textWidth(str, scale, kind) { return this.fonts.width(this.fonts.pick(kind, scale, this.S.s), str, scale); }

  // ---- the frame ----
  /** draws the HUD of client cl at replay time t into g (device size w x h); view: {x, y, yaw} of the first-person
   *  camera; insets: the viewer's controls over the canvas (device pixels) */
  draw(g, w, h, t, cl, view, insets) {
    if (!this.data || !this.M || cl == null) return;
    this.screen(g, w, h, insets);
    const ri = this.row(cl, t);
    const st = { t, cl, view, ri, recorder: ri >= 0, side: this.side(cl, t) };
    const P = this.parts;
    g.save();
    g.imageSmoothingEnabled = true;
    // the HUD menus in the menu file's order
    for (const menu of this.layout) {
      for (const it of menu.items) {
        const part = it.ownerdraw ? OWNERDRAW[it.ownerdraw] : menu.name === 'matchinfo_ingame' ? 'matchinfo' : (it.dvar || it.style || it.text ? 'server' : null);
        if (!part || !P[part]) continue;
        if (RECORDER_PARTS.has(part) && !st.recorder) continue;
        if (!this.dvarTest(it, t)) continue;
        this.item(menu, it, st);
      }
    }
    // the damage direction and flash (the recorder's damage feedback)
    if (P.damage && st.recorder && view) this.damage(st, view);
    // the server's HUD elements (the team score, the rest)
    if ((P.score || (P.server && st.recorder)) && this.H) this.hudElems(st, P.score, P.server && st.recorder);
    // the message windows
    if (P.killfeed || P.server) this.notifyWindow(st, P.killfeed, P.server);
    if (P.server) this.boldWindow(st);
    if (P.killfeed) this.centerPrint(st);
    // the scoreboard: held Tab or the intermission (pm_type 5); zPAM's own while the recorder had it open
    if (P.scoreboard) {
      if (this.showScores || (st.recorder && this.W.pmType[st.ri] === 5)) this.scoreboard(st);
      const Z = this.data.layouts.zpamScoreboard;
      if (Z && st.recorder && this.M.d.meta.zpamVersion && this.dvarAt('ui_scoreboard_visible', t) === '1') {
        for (const menu of Z) for (const it of menu.items) if (this.dvarTest(it, t)) this.item(menu, it, st);
      }
    }
    g.restore();
  }

  dvarTest(it, t) {
    if (!it.dvartest) return true;
    const v = this.dvarAt(it.dvartest, t);
    if (it.showdvar) return it.showdvar.includes(v);
    if (it.hidedvar) return !it.hidedvar.includes(v);
    return true;
  }
  /** a menu item: its rectangle (menu + item, the menu's alignment unless the item has its own) */
  rectOf(menu, it) {
    const m = menu.rect, r = it.rect;
    const ha = r[4] || m[4] || 0, va = r[5] || m[5] || 0;
    return { x: m[0] + r[0], y: m[1] + r[1], w: r[2], h: r[3], ha, va };
  }

  item(menu, it, st) {
    const R = this.rectOf(menu, it), fc = it.forecolor || [1, 1, 1, 1];
    const col = fc.slice(0, 3), alpha = fc[3] == null ? 1 : fc[3];
    switch (it.ownerdraw) {
      case 85: this.pic(it.background, this.place(R.x, R.y, R.w, R.h, R.ha, R.va), col, alpha); return;
      case 84: this.pic(it.background, this.place(R.x, R.y, R.w, R.h, R.ha, R.va), col, alpha, this.compassAngle(st)); return;
      case 86: this.objectives(R, st, col, alpha); return;
      case 89: this.friendlies(R, st, col, alpha); return;
      case 6: case 5: case 81: this.ammo(it, R, st, col, alpha); return;
      case 100: case 101: case 102: case 103: case 104: case 105: this.offhand(it, R, st, col, alpha); return;
      case 79: case 95: this.health(it, R, st, col, alpha); return;
      case 109: this.lowHealth(it, R, st, col, alpha); return;
      case 20: this.stance(it, R, st, col, alpha); return;
      case 72: this.cursorHint(it, R, st, col, alpha); return;
      case 80: this.mantleHint(it, R, st, col, alpha); return;
      default: break;
    }
    // a plain item (zPAM's menus): filled / image background, dvar text
    if (it.style === 1 && it.backcolor) {
      const bc = it.backcolor, r = this.place(R.x, R.y, R.w, R.h, R.ha, R.va);
      if (it.background) this.pic(it.background, r, bc.slice(0, 3), bc[3]);
      else { const g = this.S.g; g.globalAlpha = clamp01(bc[3]); g.fillStyle = 'rgb(' + bc.slice(0, 3).map(v => Math.round(v * 255)).join(',') + ')'; g.fillRect(r[0], r[1], r[2], r[3]); }
    }
    if (it.text && !it.dvar) {
      // a fixed text (zPAM's menus: "@REFERENCE" localized)
      const text = this.localize(String(it.text).replace(/^@/, ''));
      const scale = it.textscale || 0.55, kind = it.textfont || 0;
      const tw = this.textWidth(text.split('\n')[0], scale, kind);
      const ax = (it.textalignx || 0) - (it.textalign === 1 ? tw / 2 : it.textalign === 2 ? tw : 0);
      const p = this.place(R.x + ax, R.y + (it.textaligny || 0), 0, 0, R.ha, R.va);
      this.text(text, p[0], p[1], scale, kind, col, alpha, it.textstyle || 0);
      return;
    }
    if (it.dvar) {
      const text = this.dvarAt(it.dvar, st.t);
      if (!text) return;
      const scale = it.textscale || 0.55, kind = it.textfont || 0;
      const tw = this.textWidth(text.split('\n')[0], scale, kind);
      const ax = (it.textalignx || 0) - (it.textalign === 1 ? tw / 2 : it.textalign === 2 ? tw : 0);
      const p = this.place(R.x + ax, R.y + (it.textaligny || 0), 0, 0, R.ha, R.va);
      this.text(text, p[0], p[1], scale, kind, col, alpha, it.textstyle || 0);
    }
  }

  // ---- the player-state parts: health, low health, stance, hints, damage ----
  /** the recording player's health fraction in row ri (stats[0] / stats[2]; none when dead) */
  healthFrac(ri) {
    const W = this.W;
    if (ri < 0 || W.pmType[ri] === 6 || !(W.health[ri] > 0) || !(W.maxHealth[ri] > 0)) return 0;
    return Math.min(1, W.health[ri] / W.maxHealth[ri]);
  }
  /** the time of the last change of key (or of pred(row) when given) before row ri, within limit ms -> t or null */
  lastChange(st, key, limit, pred = null) {
    const W = this.W, A = W[key];
    for (let k = st.ri; k > 0 && W.client[k - 1] === st.cl && st.t - W.t[k] < limit; k--) {
      if (pred ? pred(k) : A[k] !== A[k - 1]) return W.t[k];
    }
    return null;
  }
  /** the damage feedback events of the recording player (CG_TransitionPlayerState -> CG_DamageFeedback: a new
   *  damageEvent with a damageCount): [{t, cl, yaw, pitch, count}] */
  damages() {
    if (this._damages) return this._damages;
    const W = this.W, out = [];
    for (let i = 1; W && i < W.t.length; i++) {
      if (W.client[i] !== W.client[i - 1] || W.dmgEv[i] === W.dmgEv[i - 1] || !W.dmgCount[i]) continue;
      out.push({ t: W.t[i], cl: W.client[i], yaw: W.dmgYaw[i], pitch: W.dmgPitch[i], count: W.dmgCount[i] });
    }
    this._damages = out;
    this._damageT = out.map(d => d.t);
    return out;
  }

  /** owner draws 79 / 95: the health bar (cg_drawHealth - 0 in the game, so a switch that is off), its back and cross;
   *  shown for hud_fade_healthbar 2 s after the last damage (CG_MenuShowNotify 0), the last 0.7 s fading. The bar: the
   *  item's colour, its green part raised below half health ((f + 0.2) g + 0.3), red and blue lowered above; the
   *  health lost goes from the old to the new value at 1.2 / s in red. The back and cross pulse in the low colour
   *  below hud_health_startpulse_injured 1 (every hud_health_pulserate_injured 1 s; critical below 0.33: 0.5 s) */
  health(it, R, st, col, alpha) {
    const D = this.damages(), i = lower(this._damageT, st.t);
    let last = null;
    for (let k = i; k >= 0 && st.t - D[k].t <= HEALTH.fade; k--) if (D[k].cl === st.cl) { last = D[k].t; break; }
    const fa = fade(st.t, last, HEALTH.fade, HEALTH.fadeTime);
    if (!fa) return;
    const r = this.place(R.x, R.y, R.w, R.h, R.ha, R.va), f = this.healthFrac(st.ri);
    if (it.ownerdraw === 95) {
      this.pic(it.background, r, col, alpha * fa);
      if (!f || f >= HEALTH.pulseInjured) return;
      const rate = f < HEALTH.pulseCritical ? HEALTH.rateCritical : HEALTH.rateInjured;
      this.pic(it.background, r, LOW, Math.min(alpha * fa, (rate - (st.t % rate)) / rate));
      return;
    }
    const c = col.slice();
    if (f <= 0.5) c[1] = (f + 0.2) * c[1] + 0.3;
    else { c[0] *= (1 - f) * 2; c[2] *= (1 - f) * 2; }
    if (f > 0) this.picPart(it.background, [r[0], r[1], r[2] * f, r[3]], 0, f, c, alpha * fa);
    // the health just lost: from the value before a drop down to the health at 1.2 / s
    const W = this.W;
    let lag = f;
    for (let k = st.ri; k > 0 && W.client[k - 1] === st.cl && st.t - W.t[k] < 1000; k--) {
      const before = this.healthFrac(k - 1);
      if (before > this.healthFrac(k)) lag = Math.max(lag, before - HEALTH.lagSpeed * (st.t - W.t[k]));
    }
    if (lag > f) this.picPart(it.background, [r[0] + r[2] * f, r[1], r[2] * (lag - f), r[3]], f, lag, [1, 0, 0], alpha * fa);
  }

  /** owner draw 109: the low-health overlay (CG_OwnerDraw, hud_healthOverlay_*): a hit that leaves the health under
   *  0.35 starts pulses - per pulse 150 ms to pulseMags[n], 320 ms to x 0.7, 400 ms to x 0.6 - the count going up once
   *  regenPauseTime 5 s minus three pulses have passed since the hit; after the 4th the overlay fades out over 0.7 s.
   *  The state machine run over the last 20 s (from rest: a sequence ends a few seconds after the last hit) */
  lowHealth(it, R, st, col, alpha) {
    const W = this.W, L = LOW_HEALTH;
    const f = this.healthFrac(st.ri);
    if (!f) return;
    let i = st.ri;
    while (i > 0 && W.client[i - 1] === st.cl && st.t - W.t[i - 1] < 20000) i--;
    let lastH = this.healthFrac(i), hit = -1e9, count = 0, active = false, phase = 0, start = -1e9, dur = 0, from = 0, to = 0;
    const step = (tau, h) => {
      if (lastH > h && h < L.pulseStart) { hit = tau; count = 0; }
      lastH = h;
      if (start + dur > tau || (h >= L.pulseStart && !active)) return false;
      active = true; from = to; start = tau;
      if (count <= 3) {
        const m = L.mags[count];
        if (phase === 0) { to = clamp01(m); dur = L.one; phase = 1; }
        else if (phase === 1) { to = clamp01(m * L.twoMul); dur = L.two; phase = 2; }
        else {
          to = clamp01(m * L.threeMul); dur = L.three; phase = 0;
          if (tau >= L.regenPause + hit - 3 * (L.one + L.two + L.three)) count++;
        }
      } else { active = false; to = L.endAlpha; dur = L.endTime; phase = 0; }
      return true;
    };
    // the rows (health changes) and the phase ends, in time order, up to t
    for (let k = i; k <= st.ri; k++) {
      const tk = W.t[k], h = this.healthFrac(k);
      while (start + dur <= tk && (active || lastH < L.pulseStart) && start + dur <= st.t) { if (!step(start + dur, lastH)) break; }
      step(tk, h);
    }
    for (let n = 0; n < 64 && start + dur <= st.t && (active || lastH < L.pulseStart); n++) if (!step(start + dur, lastH)) break;
    const el = st.t - start;
    const a = dur > 0 && el < dur ? from + (to - from) * (el / dur) : to;
    if (a > 0) this.pic(it.background, this.place(R.x, R.y, R.w, R.h, R.ha, R.va), col, alpha * a);
  }

  /** owner draw 20: the stance icon (stance_stand / crouch / prone by pm_flags), shown for hud_fade_stance 1.7 s after
   *  the stance changed, the last 0.7 s fading; "Prone Blocked" pulsing for 1.5 s, 160 units over the bottom, while
   *  pm_flags 0x10000 says the server refused to go prone */
  stance(it, R, st, col, alpha) {
    const W = this.W, pf = W.pmf[st.ri];
    const changed = this.lastChange(st, 'pmf', STANCE.fade, k => (W.pmf[k] & 3) !== (W.pmf[k - 1] & 3));
    const fa = fade(st.t, changed, STANCE.fade, STANCE.fadeTime);
    if (fa) {
      const icon = pf & 1 ? 'stance_prone' : pf & 2 ? 'stance_crouch' : 'stance_stand';
      const x = R.x + (this.C.size - 1) * 160 * 0.7;        // (the compass' size: cg_hudCompassSize)
      this.pic(icon, this.place(x, R.y, R.w, R.h, R.ha, R.va), col, alpha * fa);
    }
    // the prone-blocked message: from the first blocked snapshot, 1.5 s, again after that while it lasts
    let end = -Infinity;
    for (let k = st.ri; k > 0 && W.client[k - 1] === st.cl && st.t - W.t[k] < 4000; k--) {
      if ((W.pmf[k] & 0x10000) && !(W.pmf[k - 1] & 0x10000)) { end = W.t[k] + STANCE.blocked; break; }
    }
    if (end > st.t) {
      const text = this.localize('CGAME_PRONE_BLOCKED'), scale = it.textscale || 0.21, kind = it.textfont || 0;
      const a = Math.abs(Math.sin((end - st.t) / STANCE.blocked * 540 * D2R));
      const p = this.place(-this.textWidth(text, scale, kind) / 2, STANCE.proneY, 0, 0, 7, 3);
      this.text(text, p[0], p[1], scale, kind, col, alpha * a, it.textstyle || 0);
    }
  }

  /** a key's name as the game prints it (the default binds of default_mp.cfg: the recorder's own are not in the demo) */
  keyName(command) {
    const k = (this.data.binds || {})[command];
    if (!k) return this.localize('KEY_UNBOUND');
    const s = this.data.strings['KEY_' + k];
    return s != null ? s : k;
  }
  /** owner draw 72: the cursor hint (cg_cursorHints 4: steady): the icon of ps.cursorHint (2 hint_usable, 3 health, 4
   *  friendly, 5.. a weapon: its HUD icon, wide like its kill icon) and its text - a weapon's "Press USE [F] to pick up"
   *  / "... to swap for", else the server's hint string (config string 1278 + cursorHintString, &&1 = the key of
   *  +activate); fading over 100 ms after the hint went */
  cursorHint(it, R, st, col, alpha) {
    const W = this.W;
    let k = st.ri;
    while (k >= 0 && W.client[k] === st.cl && !W.hint[k] && st.t - W.t[k] < HINT_FADE + 60) k--;
    if (k < 0 || W.client[k] !== st.cl || !W.hint[k]) return;
    const gone = k < st.ri ? W.t[k + 1] : null;
    const a = gone == null ? 1 : Math.max(0, 1 - (st.t - gone) / HINT_FADE);
    if (!a) return;
    const hint = W.hint[k], hs = W.hintStr[k], t = st.t;
    let icon = HINT_ICONS[hint] || null, ratio = 1, text = '';
    if (hint >= 5 && hint <= 132) {
      const e = this.weaponAt(hint - 4, t);
      if (!e) return;
      icon = e.w.hudIcon; ratio = e.w.wideKillIcon ? 2 : 1;
      if (e.w.weaponClass !== 'turret') {
        // the slot is free (pick up), or another gun of its class is in it (swap); the same gun: the icon alone
        const A = this.ammoState({ ri: k }), slot = c => (c === 'pistol' ? 'pistol' : c === 'grenade' ? 'grenade' : 'primary');
        let l = null; for (const x of this.lists) { if (x.t <= t) l = x; else break; }
        const owned = [];
        for (let i = 1; l && i < l.weapons.length; i++) if (A.owned(i) && !(l.weapons[i].w.offhandClass > 0)) owned.push(i);
        if (owned.includes(hint - 4)) text = '';
        else {
          const same = owned.filter(i => slot(l.weapons[i].w.weaponClass) === slot(e.w.weaponClass)).length;
          const full = slot(e.w.weaponClass) === 'primary' ? same >= 2 : same >= 1;
          text = this.localize((full ? 'PLATFORM_SWAPWEAPONS' : 'PLATFORM_PICKUPNEWWEAPON') + '\x15' + this.keyName('+activate'));
        }
      } else if (hs >= 0) text = this.localize(this.csAt(1278 + hs, t) + '\x15' + this.keyName('+activate'));
    } else if (hs >= 0) text = this.localize(this.csAt(1278 + hs, t) + '\x15' + this.keyName('+activate'));
    else if (hint === 3) text = this.localize('PLATFORM_PICKUPHEALTH\x15' + this.keyName('+activate'));
    if (!icon) return;
    this.hintLine(it, R, text, icon, ratio, col, alpha * a);
  }
  /** a hint: the text, then its icon after it, centred on the item (CG_OwnerDraw 72 / 80) */
  hintLine(it, R, text, icon, ratio, col, alpha) {
    const scale = it.textscale || 0.21, kind = it.textfont || 0, style = it.textstyle || 0;
    const tw = text ? this.textWidth(text, scale, kind) : 0, iw = R.w * ratio;
    const x0 = text ? R.x - (iw + tw) / 2 : R.x - (R.w - (ratio > 1 ? R.w / 2 : 0)) / 2;
    if (text) { const p = this.place(x0, R.y + scale * 48 / 2, 0, 0, R.ha, R.va); this.text(text, p[0], p[1], scale, kind, col, alpha, style); }
    this.pic(icon, this.place(x0 + tw, R.y - R.h / 2, iw, R.h, R.ha, R.va), col, alpha);
  }
  /** owner draw 80: the mantle hint ("Press [Space] to " and the hint_mantle icon) while the player state's mantle
   *  flags hold 8 (cg_drawMantleHint 1) */
  mantleHint(it, R, st, col, alpha) {
    if (!(this.W.mantle[st.ri] & 8)) return;
    this.hintLine(it, R, this.localize('PLATFORM_MANTLE\x15' + this.keyName('+gostand')), 'hint_mantle', 1, WHITE, alpha);
  }

  /** the damage direction (CG_DrawDamageDirectionIndicators): per damage of the last cg_hudDamageIconTime 2 s (8
   *  slots) hit_direction, 128 x 64 pixels at 128 pixels from the centre, turned to where the damage came from
   *  (damageYaw +- 10 degrees at random - here a fixed hash), fading over its second half; none while aiming down
   *  the sights. And the red flash of CG_DamageFeedback: (0.2, 0, 0) over the screen for 0.5 s, as strong as the
   *  damage (x 0.2, 5 .. 90) along the view */
  damage(st, view) {
    const D = this.damages(), S = this.S, g = S.g, t = st.t;
    const i = lower(this._damageT, t);
    // (the icon's size and offset are screen pixels in the client: the canvas' device pixels here)
    const img = this.images.get('hit_direction');
    const slots = [];
    for (let k = i; k >= 0 && t - D[k].t < DAMAGE.time && slots.length < 8; k--) if (D[k].cl === st.cl) slots.push(D[k]);
    for (const d of slots) {
      const age = t - d.t;
      // the flash
      if (age < DAMAGE.flash) {
        const kick = Math.min(90, Math.max(5, d.count * 0.2));
        let kp = kick;
        if (d.yaw !== 255 || d.pitch !== 255) {
          const dy = d.yaw / 255 * 360 * D2R, dp = d.pitch / 255 * 360 * D2R, vy = view.yaw * D2R, vp = (view.pitch || 0) * D2R;
          const dir = [Math.cos(dp) * Math.cos(dy), Math.cos(dp) * Math.sin(dy), -Math.sin(dp)];
          const fw = [Math.cos(vp) * Math.cos(vy), Math.cos(vp) * Math.sin(vy), -Math.sin(vp)];
          kp = (dir[0] * fw[0] + dir[1] * fw[1] + dir[2] * fw[2]) * kick;
        }
        const a = Math.min(5, Math.abs(kp * (DAMAGE.flash - age)) / 500) / 5 * 0.7;
        if (a > 0) { g.globalAlpha = a; g.fillStyle = 'rgb(51,0,0)'; g.fillRect(0, 0, S.w, S.h); }
      }
      if (d.yaw === 255 && d.pitch === 255) continue;
      if (!img || view.ads) continue;
      const yaw = d.yaw / 255 * 360 + ((hash32(d.t * 31 + d.cl) / 4294967296) - 0.5) * 20;
      const a = Math.min(1, 2 - 2 * age / DAMAGE.time);
      const cx = S.l + S.aw / 2, cy = S.t + S.ah / 2;
      g.save();
      g.globalAlpha = clamp01(a);
      g.translate(cx, cy); g.rotate((view.yaw - yaw + 180) * D2R);
      g.drawImage(img, -DAMAGE.w / 2, -(DAMAGE.offset + DAMAGE.h), DAMAGE.w, DAMAGE.h);
      g.restore();
    }
  }

  /** a part of an image (texture s from s0 to s1) in a device rectangle, tinted */
  picPart(name, r, s0, s1, color, alpha) {
    const img = name && this.tinted(name.toLowerCase(), color);
    if (!img || alpha <= 0 || r[2] <= 0) return;
    const g = this.S.g, w = img.width;
    g.globalAlpha = clamp01(alpha);
    g.drawImage(img, w * s0, 0, Math.max(1, w * (s1 - s0)), img.height, r[0], r[1], r[2], r[3]);
  }

  // ---- the scoreboard ----
  /** the game's scoreboard (CG_DrawScoreboard): held Tab or the intermission; the last scores the server sent ("b":
   *  CG_ParseScores). 400 x 430 at (120, 22), 80 % black, white lines; the game type and the map (0.41), the objective
   *  text (0.24, wrapped at 374); the columns (the client's table: voice 0.05, status 0.05, name 0.47, score 0.13, deaths
   *  0.13, ping 0.17 of 382 units - 374 with a scroll bar) and their titles (0.3); per team a banner (the
   *  g_ScoresBanner_* flag, 32 high: "Team (n players)", the team's score and average ping in its colour) and a 12 unit
   *  row per player (0.22, shrunk to fit; the watched player's row lit in the team colour, every second row darker);
   *  the leading team first; the free players (deathmatch), the spectators; the server's name at the bottom (its
   *  address is not in the demo) */
  scoreboard(st) {
    const M = this.M, d = M.d, t = st.t, D = this.data;
    const S = d.scores || [];
    let si = -1; for (let k = S.length - 1; k >= 0; k--) if (S[k].t <= t) { si = k; break; }
    const sc = si >= 0 ? S[si] : null;
    const box = (x, y, w, h, color, a) => { const r = this.place(x, y, w, h, 0, 0), g = this.S.g; g.globalAlpha = clamp01(a); g.fillStyle = 'rgb(' + color.map(v => Math.round(v * 255)).join(',') + ')'; g.fillRect(r[0], r[1], r[2], r[3]); };
    const txt = (s, x, y, scale, color, a = 1, style = 3) => { const p = this.place(x, y, 0, 0, 0, 0); this.text(s, p[0], p[1], scale, 0, color, a, style); };
    box(120, 22, 400, 430, [0, 0, 0], 0.8);
    for (const r of [[123, 25, 394, 2], [123, 447, 394, 2], [123, 27, 2, 420], [516, 27, 2, 420], [125, 51, 390, 1], [125, 432, 390, 1]]) box(...r, WHITE, 0.1);
    // the game type, the map
    const sv = d.meta.dvars || {}, si0 = d.serverinfo || {};
    const gt = this.localize(D.gametypes[String(d.meta.gametype || si0.g_gametype || '').toLowerCase()] || d.meta.gametype || '');
    const mapKey = String(d.meta.map || '').toLowerCase().replace(/^.*\//, '');
    const mapName = (D.mapNames && D.mapNames[mapKey]) || mapKey.replace(/^mp_/, '');
    txt(gt, 129, 51 - (24 - 0.41 * 48) * 0.5, 0.41, WHITE);
    let ms = 0.41;
    while (ms > 0.075 && this.textWidth(gt, 0.41, 0) + this.textWidth(mapName, ms, 0) + 4 > 386) ms -= 0.025;
    txt(mapName, 511 - (this.textWidth(mapName, ms, 0) + 4), 51 - (24 - ms * 48) * 0.5, ms, WHITE);
    // the server's name at the bottom
    const host = si0.sv_hostname || sv.sv_hostname || '';
    let hs = 0.2;
    while (hs > 0.075 && this.textWidth(host, hs, 0) + 4 > 386) hs -= 0.01;
    txt(host, 129, 447 - (14 - hs * 48) * 0.5, hs, WHITE);
    // the objective text (cg_objectiveText), wrapped at 374
    let y = 52;
    const obj = this.localize(this.dvarAt('cg_objectivetext', t));
    if (obj) {
      let yy = 56;
      for (const para of obj.replace(/\\n/g, '\n').split('\n')) {
        let line = '';
        for (const w of para.split(' ')) {
          const tryL = line ? line + ' ' + w : w;
          if (line && this.textWidth(tryL, 0.24, 0) > 374) { txt(line, 129, yy + 10.08, 0.24, WHITE); yy += 12; line = w; } else line = tryL;
        }
        txt(line, 129, yy + 10.08, 0.24, WHITE); yy += 12;
      }
      box(125, yy + 2, 390, 1, WHITE, 0.1);
      y = yy + 3;
    }
    // the players by team (1 axis, 2 allies; 0 free: deathmatch; 3 spectators) and the teams' counts, average pings
    const rows = [], count = [0, 0, 0, 0], ping = [0, 0, 0, 0];
    const dm = String(d.meta.gametype || '').toLowerCase() === 'dm';
    for (let k = 0; sc && k + 4 < sc.e.length; k += 5) {
      const cl = sc.e[k], side = this.side(cl, t), p = M.player(cl);
      const team = side === 'axis' ? 1 : side === 'allies' ? 2 : dm || !p || p.team !== 'spectator' ? (dm ? 0 : 3) : 3;
      rows.push({ cl, score: sc.e[k + 1], ping: sc.e[k + 2], deaths: sc.e[k + 3], status: sc.e[k + 4], team });
      count[team]++; ping[team] += sc.e[k + 2];
    }
    const teamsOn = count[1] || count[2];
    const need = (teamsOn ? 2 * SB.banner + 8 + 10 : 10) + (count[0] ? SB.banner + 4 : 0) + (count[3] ? SB.banner + 4 : 0) + rows.length * SB.item;
    const width = need > 432 - y ? SB.widths[1] : SB.widths[0];
    // the column titles
    let x = 129;
    const hy = y + 4;
    for (const [type, w, title, right] of SB.cols) {
      if (title) { const s = this.localize(title); txt(s, x + (right === 2 ? w * width - this.textWidth(s, 0.3, 0) : 0), hy + 11.76, 0.3, WHITE); }
      x += w * width;
    }
    y = hy + 14;
    const bannerH = SB.banner / 0.75;
    const teamColor = team => (team === 2 ? this.allies : team === 1 ? this.axis : WHITE);
    const banner = team => {
      if (y + SB.banner > 432) return false;
      const n = count[team];
      const name = team === 2 ? sv.g_TeamName_Allies : team === 1 ? sv.g_TeamName_Axis : team === 3 ? 'CGAME_SPECTATORS' : null;
      let text = this.localize((n === 1 ? 'CGAME_SB_PLAYER' : 'CGAME_SB_PLAYERS') + '\x15' + n);
      if (name) text = this.localize(name) + ' (' + text + ')';
      const flag = team === 2 ? sv.g_ScoresBanner_Allies : team === 1 ? sv.g_ScoresBanner_Axis : team === 3 ? sv.g_ScoresBanner_Spectators : sv.g_ScoresBanner_None;
      if (flag) this.pic(flag, this.place(129, y, width, bannerH, 0, 0), WHITE, 1);
      const c = teamColor(team), by = y + SB.banner * 0.84;
      txt(text, 133, by, 0.32, c);
      if (team === 1 || team === 2) {
        let cx = 129;
        for (const [type, w, , right] of SB.cols) {
          const v = type === 2 ? (team === 1 ? sc.axis : sc.allies) : type === 4 ? (n ? Math.round(ping[team] / n) : 0) : null;
          if (v != null) { const s = String(v); txt(s, cx + (right === 2 ? w * width - this.textWidth(s, 0.32, 0) : 0), by, 0.32, c); }
          cx += w * width;
        }
      }
      y += bannerH;
      return true;
    };
    const list = team => {
      let odd = false;
      for (const r of rows) {
        if (r.team !== team) continue;
        if (y + 12 > 432) return;
        if (r.cl === st.cl) box(129, y, width, 12, teamColor(team), 0.2);
        else if (odd) box(129, y, width, 12, [0, 0, 0], 0.15);
        let cx = 129;
        for (const [type, w, , right] of SB.cols) {
          const cw = w * width;
          if (type === 6) {
            const s = this.M.sampleAt(r.cl, t);
            if (s && s.age < 1000 && (s.icon & 64)) this.pic('voice_on', this.place(cx, y, 13, 13, 0, 0), WHITE, 1);
          } else if (type === 5) {
            const icon = r.status > 0 && r.status <= 8 ? this.csAt(22 + r.status, t) : '';
            if (icon) this.pic(icon, this.place(cx, y, 13, 13, 0, 0), WHITE, 1);
          } else {
            const s = type === 0 ? (this.M.player(r.cl) || {}).name || '' : type === 2 ? (team === 3 ? '' : String(r.score)) : type === 3 ? (team === 3 ? '' : String(r.deaths)) : String(r.ping);
            if (s) {
              let fs = 0.22;
              while (fs > 0.05 && this.textWidth(s, fs, 0) > cw) fs -= 0.02;
              txt(s, cx + (right === 2 ? cw - this.textWidth(s, fs, 0) : 0), y + 10.08, fs, WHITE, 1, fs >= 0.16 ? 3 : 0);
            }
          }
          cx += cw;
        }
        y += 12;
        odd = !odd;
      }
    };
    if (teamsOn) {
      // the leading team first (a tie: the one that led last)
      let lead = 2;
      for (let k = si; k >= 0; k--) { const s = S[k]; if (s.axis !== s.allies) { lead = s.axis > s.allies ? 1 : 2; break; } }
      const other = lead === 1 ? 2 : 1;
      if (banner(lead)) list(lead);
      y += 4;
      if (banner(other)) list(other);
      y += 4;
    }
    if (count[0]) { if (banner(0)) list(0); y += 4; }
    if (count[3] && banner(3)) list(3);
  }

  // ---- compass ----
  /** the face's angle: the view yaw - the map's north, through the face's spring over the last second
   *  (CG_UpdateCompassOrientation: 5 ms steps, 1000 deg / s^2 towards the target, damping) */
  compassAngle(st) {
    const north = Number(this.csAt(11, st.t)) || 0;
    const M = this.M;
    let disp = null, v = 0;
    for (let k = st.t - 1000; k <= st.t; k += 5) {
      const s = M.sampleAt(st.cl, k);
      if (!s) { disp = null; continue; }
      const target = norm360(s.yaw - north);
      if (disp == null) { disp = target; v = 0; continue; }
      let diff = norm180(disp - target);
      const dt = 0.005;
      if (Math.abs(diff) < 0.25 && Math.abs(v) < 1) { disp = target; v = 0; continue; }
      diff = norm180(v * dt + diff);
      if (diff > 0) v -= 1000 * dt; else if (diff < 0) v += 1000 * dt;
      v += -2 * v * dt;
      if (v <= 0) { if (diff < 0) v += -3.5 * v * dt; v += dt; if (v > 0) v = 0; }
      else { if (diff > 0) v += -3.5 * v * dt; v -= dt; if (v < 0) v = 0; }
      v = Math.max(-30000, Math.min(30000, v));
      disp = norm360(target + diff);
    }
    return disp == null ? norm360(st.view.yaw - north) : disp;
  }
  /** the point of a world position on the compass (virtual, the compass item's alignment) and its alpha */
  compassPoint(R, st, x, y, size, clampRange) {
    const C = this.C, dx = x - st.view.x, dy = y - st.view.y;
    const dist = Math.hypot(dx, dy);
    const a = norm360(Math.atan2(dy, dx) / D2R - st.view.yaw) * D2R;
    let r;
    if (clampRange) r = Math.min(C.maxRange, dist) / C.maxRange;
    else if (dist <= C.minRange) r = C.minRadius;
    else if (dist < C.maxRange) r = 1 - (1 - C.minRadius) * (C.maxRange - dist) / (C.maxRange - C.minRange);
    else r = 1;
    r *= C.size * 43.75;
    let alpha = 1;
    if (dist > C.maxRange) alpha = dist < C.objMaxRange ? 1 - (1 - C.objMinAlpha) * (dist - C.maxRange) / (C.objMaxRange - C.maxRange) : C.objMinAlpha;
    const cx = R.x + R.w * C.size * 0.5, cy = R.y + R.h * C.size * 0.5 - (C.size - 1) * R.h;
    return { x: cx - size / 2 - Math.sin(a) * r, y: cy - size / 2 - Math.cos(a) * r, alpha };
  }
  /** the objectives (state 4 = current) of the recording player's state: their icon (material config string)
   *  or "objective"; another player sees those of everyone and of his team */
  objectives(R, st, col, alpha) {
    const H = this.H, W = this.W;
    if (!H || !W) return;
    let ri = st.ri;
    if (ri < 0) { ri = lower(W.t, st.t); if (ri < 0) return; }
    const o0 = H.obj.start[W.objRef[ri]], O = H.obj.data, STRIDE = 7;
    const teamNum = st.side === 'axis' ? 1 : st.side === 'allies' ? 2 : 0;
    for (let i = 0; i < 16; i++) {
      const b = o0 + i * STRIDE;
      if (O[b] !== 4) continue;
      const team = O[b + 6];
      if (!st.recorder && team && team !== teamNum) continue;
      let x = u2f(O[b + 1]), y = u2f(O[b + 2]);
      const ent = O[b + 5];
      if (ent !== 1023 && ent < 64) { const s = this.M.sampleAt(ent, st.t); if (s) { x = s.x; y = s.y; } }
      const icon = O[b + 4], name = icon > 0 && icon < 128 ? this.csAt(1566 + icon, st.t) : '';
      const size = 16 * this.C.size, p = this.compassPoint(R, st, x, y, size, false);
      this.pic(this.data.materials[(name || '').toLowerCase()] ? name : 'objective', this.place(p.x, p.y, size, size, R.ha, R.va), col, Math.min(alpha, p.alpha));
    }
  }
  /** teammates in the snapshot (seen within 800 ms): an arrow along their view; a teammate who fired within
   *  2 s: the firing ping over it, fading; enemies who fired within 2 s: a ping where they fired */
  friendlies(R, st, col, alpha) {
    const M = this.M, d = M.d, size = 10 * this.C.size;
    if (!st.side) return;
    for (const p of d.players) {
      const cl = p.client;
      if (cl === st.cl) continue;
      const side = this.side(cl, st.t);
      if (!side) continue;
      const shots = (d.shotsSeen || {})[cl];
      const k = shots ? lower(shots, st.t) : -1;
      const shotAgo = k >= 0 ? st.t - shots[k] : Infinity;
      if (side === st.side) {
        const s = M.sampleAt(cl, st.t);
        if (!s || s.age > 800) continue;
        const pt = this.compassPoint(R, st, s.x, s.y, size, false);
        const r = this.place(pt.x, pt.y, size, size, R.ha, R.va), ang = norm360(st.view.yaw - s.yaw);
        const ping = shotAgo <= this.C.ping ? 1 - shotAgo / this.C.ping : 0;
        const a = Math.min(alpha, pt.alpha);
        if (!ping || ping !== 1) this.pic('objective_friendly', r, col, a, ang);
        if (ping) this.pic('compassping_friendlyfiring', r, col, Math.min(a, ping), ang);
      } else if (shotAgo <= this.C.ping) {
        const s = M.sampleAt(cl, shots[k]);
        if (!s) continue;
        const pt = this.compassPoint(R, st, s.x, s.y, size, true);
        this.pic('compassping_enemyfiring', this.place(pt.x, pt.y, size, size, R.ha, R.va), col, Math.min(alpha, 1 - shotAgo / this.C.ping));
      }
    }
  }

  // ---- ammo, weapon name, grenades ----
  ammoState(st) {
    const H = this.H, W = this.W, ri = st.ri;
    const a0 = H.ammo.start[W.ammoRef[ri]], A = H.ammo.data;
    return {
      owned: w => (w < 32 ? (A[a0] >>> w) & 1 : (A[a0 + 1] >>> (w - 32)) & 1) === 1,
      ammo: i => A[a0 + 2 + i], clip: i => A[a0 + 66 + i]
    };
  }
  /** BG_GetTotalAmmoReserve: the weapon's ammo (its clip for a clip-only weapon), or the sum over the owned weapons
   *  of its shared ammo cap */
  reserve(wi, A, t) {
    const e = this.weaponAt(wi, t);
    if (!e) return 0;
    const cap = e.w.sharedAmmoCapName;
    if (!cap) return e.w.clipOnly ? A.clip(e.clip) : A.ammo(e.ammo);
    let l = null;
    for (const x of this.lists) { if (x.t <= t) l = x; else break; }
    const seenA = new Set(), seenC = new Set();
    let sum = 0;
    for (let i = 1; l && i < l.weapons.length; i++) {
      const o = l.weapons[i];
      if (!A.owned(i) || o.w.sharedAmmoCapName !== cap) continue;
      if (o.w.clipOnly) { if (!seenC.has(o.clip)) { seenC.add(o.clip); sum += A.clip(o.clip); } }
      else if (!seenA.has(o.ammo)) { seenA.add(o.ammo); sum += A.ammo(o.ammo); }
    }
    return sum;
  }
  ammo(it, R, st, col, alpha) {
    const W = this.W, t = st.t, wi = W.weapon[st.ri];
    if (!wi) return;
    const e = this.weaponAt(wi, t);
    // (a weapon without ammo - a mounted MG, binoculars - shows no counter)
    if (!e || (!e.w.ammoName && !e.w.clipName)) return;
    const A = this.ammoState(st);
    const reserve = this.reserve(wi, A, t);
    const clip = e.w.clipOnly ? -1 : A.clip(e.clip);
    const maxA = Math.min(e.w.maxAmmo || 0, 999), size = Math.min(e.w.clipSize || 0, 999);
    const lowAmmo = maxA >= 0 && maxA * 0.2 >= Math.min(reserve, 999);
    const lowClip = clip >= 0 && size > 0 && size * 0.33 >= Math.min(clip, 999);
    if (it.ownerdraw === 6) { this.pic(it.background, this.place(R.x, R.y, R.w, R.h, R.ha, R.va), lowAmmo ? LOW : col, alpha); return; }
    const scale = it.textscale || 0.5, kind = it.textfont || 0, style = it.textstyle || 0;
    if (it.ownerdraw === 81) {
      // the weapon name: 1.8 s after the weapon changed, the last 0.7 s fading
      let k = st.ri;
      while (k > 0 && W.client[k - 1] === st.cl && W.weapon[k - 1] === wi && t - W.t[k - 1] < 2600) k--;
      const since = t - W.t[k];
      if (since >= 1800 || (k > 0 && W.weapon[k - 1] === wi)) return;
      const a = since > 1100 ? (1800 - since) / 700 : 1;
      const name = this.localize(e.w.displayName || e.name);
      const p = this.place(R.x + R.w - this.textWidth(name, scale, kind) - 28, R.y, 0, 0, R.ha, R.va);
      this.text(name, p[0], p[1], scale, kind, col, alpha * a, style);
      return;
    }
    // the counter: clip at the left (pulsing red when low), reserve at the right, "|" between
    const pulse = lowClip ? ((t % 800) / 800) : 0;
    const cs = clip >= 0 ? String(Math.min(clip, 999)).padStart(2, ' ') : null;
    const rs = String(Math.min(reserve, 999)).padStart(3, ' ');
    const at = (x, s, c, a) => { const p = this.place(x, R.y, 0, 0, R.ha, R.va); this.text(s, p[0], p[1], scale, kind, c, a, style); };
    if (cs == null) { at(R.x + (R.w - this.textWidth(rs, scale, kind)) * 0.5, rs, lowAmmo ? LOW : col, alpha); return; }
    at(R.x, cs, col, alpha);
    if (lowClip) at(R.x, cs, LOW, Math.min(alpha, 1 - pulse));
    at(R.x + R.w - this.textWidth(rs, scale, kind), rs, lowAmmo ? LOW : col, alpha);
    at(R.x + (R.w - this.textWidth('|', scale, kind)) * 0.5 - 5, '|', lowAmmo ? LOW : col, alpha);
  }
  /** the grenades of a class (1 frag, 2 smoke): icon of the equipped / first available, the count (clips of the
   *  owned weapons of the class, red at 0), the name (stock layout) */
  offhand(it, R, st, col, alpha) {
    const W = this.W, t = st.t;
    if (W.pmType[st.ri] > 5) return;
    const cls = it.ownerdraw === 100 || it.ownerdraw === 102 || it.ownerdraw === 104 ? 1 : 2;
    let l = null;
    for (const x of this.lists) { if (x.t <= t) l = x; else break; }
    if (!l) return;
    const A = this.ammoState(st);
    let avail = 0, equipped = 0, count = 0;
    for (let i = 1; i < l.weapons.length; i++) {
      const o = l.weapons[i];
      if (o.w.offhandClass !== cls || !A.owned(i)) continue;
      if (!equipped) equipped = i;
      if (!avail && A.clip(o.clip) > 0) avail = i;
      count += A.clip(o.clip);
    }
    const first = avail || equipped;
    if (!first) return;
    const scale = it.textscale || 0.5, kind = it.textfont || 0, style = it.textstyle || 0;
    if (it.ownerdraw === 100 || it.ownerdraw === 101) {
      const sel = W.offhand[st.ri], so = sel && l.weapons[sel];
      const wi = so && so.w.offhandClass === cls ? sel : first;
      this.pic(l.weapons[wi].w.hudIcon, this.place(R.x, R.y, R.w, R.h, R.ha, R.va), col, alpha);
    } else if (it.ownerdraw === 102 || it.ownerdraw === 103) {
      const p = this.place(R.x, R.y, 0, 0, R.ha, R.va);
      this.text(String(count), p[0], p[1], scale, kind, count ? col : LOW, alpha, style);
    } else {
      const p = this.place(R.x, R.y, 0, 0, R.ha, R.va);
      this.text(this.localize(OFFHAND_NAMES[cls]), p[0], p[1], scale, kind, col, alpha, style);
    }
  }

  // ---- the server's HUD elements ----
  hudElems(st, score, rest) {
    const H = this.H, W = this.W;
    let ri = st.ri;
    if (ri < 0) { ri = lower(W.t, st.t); if (ri < 0) return; }
    const h0 = H.hud.start[W.hudRef[ri]], D = H.hud.data, NH = C2.delta.NH, HE = C2.delta.HE;
    const n = D[h0] + D[h0 + 1], els = [];
    for (let i = 0; i < n; i++) {
      const b = h0 + 2 + i * NH;
      const e = {}; for (const k in HE) e[k] = D[b + HE[k]];
      for (const k of ['x', 'y', 'z', 'fontScale', 'value', 'sort', 'fromX', 'fromY']) e[k] = u2f(e[k]);
      if (!e.type || e.type === 13) continue;
      const isScore = (e.alignScreen === 9 || e.fromAlignScreen === 9) && SCORE_SPOTS.has(Math.round(e.x) + ',' + Math.round(e.y));
      if (isScore ? !score : !rest) continue;
      els.push([e, i]);
    }
    els.sort((a, b) => a[0].sort - b[0].sort || a[1] - b[1]);
    for (const fg of [0, 1]) for (const [e] of els) if ((e.foreground ? 1 : 0) === fg) this.hudElem(e, st);
  }
  /** CG_GetHudElemInfo + CG_Draw2dHudElems for one element (times: the server's -> the replay's) */
  hudElem(e, st) {
    const now = st.t + this.H.t0;
    // colour (fade)
    let color = rgba(e.color);
    if (e.fadeTime > 0 && now - e.fadeStartTime < e.fadeTime) {
      const f = clamp01((now - e.fadeStartTime) / e.fadeTime), from = rgba(e.fromColor);
      color = color.map((c, i) => from[i] + (c - from[i]) * f);
    }
    if (color[3] <= 0) return;
    // font and texts
    const kind = e.font === 1 ? 4 : e.font === 2 ? 5 : 0;
    const scale = e.fontScale * (e.font === 1 ? 0.5 : e.font === 2 ? 1 / 3 : 0.25);
    const fh = scale * 48;
    let label = e.label ? this.localize(this.csAt(1310 + e.label, st.t)) : '', text = '';
    switch (e.type) {
      case 1: text = e.text ? this.localize(this.csAt(1310 + e.text, st.t)) : ''; break;
      case 2: text = fmtG(e.value); break;
      case 3: { const c = Math.round(e.value); const p = this.M.player(c); text = p ? p.name : ''; break; }
      case 7: text = timer(e.time + 999 - now, false); break;
      case 8: text = timer(now - e.time, false); break;
      case 9: text = timer(e.time + 99 - now, true); break;
      case 10: text = timer(now - e.time, true); break;
      default: break;
    }
    if (label && text && label.includes('&&1')) { text = label.replace('&&1', text); label = ''; }
    const isText = [1, 2, 3, 4, 5, 7, 8, 9, 10].includes(e.type);
    const lw = label ? this.textWidth(label, scale, kind) : 0, tw = text ? this.textWidth(text, scale, kind) : 0;
    // size (material / clock: width / height with the scale change)
    const scaled = (to, from) => {
      let v = to || fh;
      if (e.scaleTime > 0 && now - e.scaleStartTime < e.scaleTime) v = (from || fh) + (v - (from || fh)) * clamp01((now - e.scaleStartTime) / e.scaleTime);
      return v;
    };
    let w = 0, h = 0;
    if (isText) { w = tw + lw; h = fh; } else if (e.type === 6 || e.type === 11 || e.type === 12) { w = scaled(e.width, e.fromWidth); h = scaled(e.height, e.fromHeight); }
    // position (alignment of the element and of the screen; the move)
    const pos = (x, y, org, scr) => {
      const ax = (org >> 2) & 3, ay = org & 3;
      x -= ax === 1 ? w / 2 : ax === 2 ? w : 0;
      y -= ay === 1 ? h / 2 : ay === 2 ? h : 0;
      return this.place(x, y, w, h, (scr >> 3) & 7, scr & 7);
    };
    let r = pos(e.x, e.y, e.alignOrg, e.alignScreen);
    if (e.moveTime > 0 && now - e.moveStartTime < e.moveTime) {
      const f = clamp01((now - e.moveStartTime) / e.moveTime), r0 = pos(e.fromX, e.fromY, e.fromAlignOrg, e.fromAlignScreen);
      r = r.map((v, i) => r0[i] + (v - r0[i]) * f);
    } else { r[0] = Math.round(r[0]); r[1] = Math.round(r[1]); }
    const col = color.slice(0, 3), a = color[3];
    if (isText) {
      const base = r[1] + fh * this.S.s;
      let x = r[0];
      if (label) x += this.text(label, x, base, scale, kind, col, a, 3);
      if (text) this.text(text, x, base, scale, kind, col, a, 3);
      return;
    }
    const mat = e.materialIndex > 0 && e.materialIndex < 128 ? this.csAt(1566 + e.materialIndex, st.t) : '';
    if (!mat) return;
    if (e.type === 6) { this.pic(mat, r, col, a); return; }
    // a clock (11 down, 12 up): the face and its needle at the elapsed share of the duration
    const elapsed = e.type === 11 ? Math.max(0, e.time - now) : Math.max(0, now - e.time);
    const ang = e.duration ? norm360(elapsed * 360 / e.duration) : norm360(elapsed * 0.006);
    this.pic(mat, r, col, a);
    this.pic(mat + 'needle', r, col, a, ang);
  }

  // ---- messages ----
  /** a message window (a ring of 8 lines: a new line cuts the oldest 3 to their fade out) -> the lines alive at t:
   *  {e, start, end} */
  window(events, times, t, time) {
    const lines = [];
    const from = lower(times, t - time - 2000) + 1, to = lower(times, t);
    for (let i = Math.max(0, from); i <= to; i++) {
      const e = events[i];
      lines.push({ e, start: e.t, end: e.t + time });
      if (lines.length > NOTIFY.ring) lines.shift();
      // the 3 oldest of the ring: cut to the fade out
      const n = lines.length;
      if (n === NOTIFY.ring) for (let k = 0; k < NOTIFY.cut; k++) lines[k].end = Math.min(lines[k].end, e.t + NOTIFY.fadeOut);
    }
    return lines.filter(L => L.start <= t && L.end > t);
  }
  /** Con_DrawMessageWindow: lines from the newest at the bottom upwards, a new line scrolling in */
  drawWindow(lines, t, x0, y0, ha, va, lineH, center, drawLine) {
    let offset = 0;
    for (const L of lines) if (t - L.start < NOTIFY.scroll) offset += (1 - (t - L.start) / NOTIFY.scroll) * lineH;
    let y = y0 + offset - lineH;
    for (let i = lines.length - 1; i >= 0; i--) {
      const L = lines[i];
      let a = 1;
      if (t - L.start < NOTIFY.fadeIn) a = (t - L.start) / NOTIFY.fadeIn;
      if (L.end - t < NOTIFY.fadeOut) a = Math.min(a, (L.end - t) / NOTIFY.fadeOut);
      drawLine(L, x0, y, ha, va, a);
      y -= lineH;
    }
  }
  notifyWindow(st, kills, msgs) {
    const evs = this.notify.filter(e => (e.kind === 'kill' ? kills : msgs));
    const times = evs.map(e => e.t);
    const lines = this.window(evs, times, st.t, NOTIFY.time);
    if (!lines.length) return;
    // above the compass: the compass menu's y - (size - 1) * height + 12, bottom aligned; x 6, left aligned
    const cm = this.layout.find(m => m.name === 'Compass');
    const y0 = (cm ? cm.rect[1] - (this.C.size - 1) * cm.rect[3] : -140) + 12;
    const scale = NOTIFY.line / 48;
    this.drawWindow(lines, st.t, NOTIFY.x, y0, 1, 3, NOTIFY.line, false, (L, x, y, ha, va, a) => {
      const p = this.place(x, y, 0, 0, ha, va), base = p[1] + NOTIFY.line * this.S.s;
      if (L.e.kind === 'msg') { this.text(this.localize(L.e.text), p[0], base, scale, 0, WHITE, a, 3); return; }
      this.deathMessage(L.e.k, p[0], p[1], base, scale, a);
    });
  }
  /** CL_DeathMessagePrint: attacker (team colour), " ", the kill icon, " ", victim (team colour) */
  deathMessage(k, x, top, base, scale, a) {
    const t = k.t, S = this.S;
    const world = k.attacker === ENTITYNUM_WORLD || k.attacker >= 64;
    const self = k.attacker === k.victim;
    const attacker = !world && !self ? (this.M.player(k.attacker) || {}).name || '' : '';
    const victim = (this.M.player(k.victim) || {}).name || '';
    let icon = 'killicondied', wide = false, flip = false;
    if (k.mod) icon = MOD_ICONS[k.mod] || 'killicondied';
    else {
      const e = this.weaponAt(k.weapon, t);
      if (e && e.w.killIcon) { icon = e.w.killIcon; wide = !!e.w.wideKillIcon; flip = !!e.w.flipKillIcon; }
    }
    let px = x;
    if (attacker) px += this.text(attacker + '^7 ', px, base, scale, 0, this.teamColor(k.attacker, t), a, 3);
    const lh = NOTIFY.line * S.s, iw = (wide ? 2.8 : 1.4) * lh, ih = 1.4 * lh;
    this.pic(icon, [px, top + lh / 2 - ih / 2, iw, ih], WHITE, a, 0, flip);
    px += iw + this.textWidth(' ', scale, 0) * S.s;
    this.text(victim, px, base, scale, 0, this.teamColor(k.victim, t), a, 3);
  }
  boldWindow(st) {
    const lines = this.window(this.bold, this.boldT, st.t, BOLD.time);
    if (!lines.length) return;
    const lineH = BOLD.line + 4, scale = lineH / 48;
    this.drawWindow(lines, st.t, 0, -60, 7, 7, lineH, true, (L, x, y, ha, va, a) => {
      const text = this.localize(L.e.text), w = this.textWidth(text, scale, 4);
      const p = this.place(x - w / 2, y, 0, 0, ha, va);
      this.text(text, p[0], p[1] + lineH * this.S.s, scale, 4, WHITE, a, 3);
    });
  }
  /** "You killed X" / "Killed by X" for the first-person player (CG_Obituary -> CG_PriorityCenterPrint: 7 s, the
   *  last 0.1 s fading; centred, 60 units over the bottom) */
  centerPrint(st) {
    const i = lower(this.killT, st.t);
    for (let j = i; j >= 0 && st.t - this.killT[j] < 7000; j--) {
      const k = this.M.d.kills[j];
      if (k.attacker === k.victim || k.victim >= 64) continue;
      let msg = null;
      const tk = k.attacker < 64 && this.side(k.attacker, k.t) && this.side(k.attacker, k.t) === this.side(k.victim, k.t);
      if (k.attacker === st.cl) msg = 'CGAME_YOUKILLED\x15' + (tk ? '^1&&2^7 ' + (this.M.player(k.victim) || {}).name + '\x14CGAME_TEAMMATE' : (this.M.player(k.victim) || {}).name);
      else if (k.victim === st.cl && k.attacker < 64) msg = 'CGAME_YOUWEREKILLED\x15' + (tk ? '^1&&2^7 ' + (this.M.player(k.attacker) || {}).name + '\x14CGAME_TEAMMATE' : (this.M.player(k.attacker) || {}).name);
      if (!msg) continue;
      const left = 7000 - (st.t - k.t), a = left < 100 ? left / 100 : 1;
      const scale = 9 / 32, text = this.localize(msg), h = scale * 48;
      const w = this.textWidth(text, scale, 0);
      const p = this.place(-w / 2, -60 - 1.2 * h, 0, 0, 7, 3);
      this.text(text, p[0], p[1], scale, 0, WHITE, a, 3);
      return;
    }
  }
}
