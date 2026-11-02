/* The game's scoreboard while the viewer holds Tab (hud.js: CG_DrawScoreboard, the last scores the server sent): a
 * canvas over the views - 2D, 3D, first person, fullscreen - clear of the viewer's own controls, redrawn while the
 * time moves. Only the viewer's Tab shows it: the demo's own scoreboard (the recording player's +scores, the
 * intermission, zPAM's) is left out, and the video exports never draw it. */
import { Hud } from '../view3d/hud.js';

/** the viewer's controls over a canvas (rail, score, drawer, the playback bar) as the HUD's safe area: per control the
 *  canvas edge it hugs, inset past it (device pixels) */
export function uiInsets(canvas, dpr) {
  const c = canvas.getBoundingClientRect(), ins = { l: 0, t: 0, r: 0, b: 0 }, gap = 8;
  // (in fullscreen the player bar floats over the view only while the mouse moves: the HUD stays put)
  const fs = !!document.fullscreenElement;
  for (const sel of ['#rail', '#overview', '#drawer', '#controls']) {
    if (fs && sel === '#controls') continue;
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      if (!r.width || !r.height || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue;
      const cand = { l: r.right - c.left, r: c.right - r.left, t: r.bottom - c.top, b: c.bottom - r.top };
      const edge = Object.keys(cand).reduce((a, b) => (cand[a] <= cand[b] ? a : b));
      ins[edge] = Math.max(ins[edge], cand[edge] + gap);
    }
  }
  for (const k in ins) ins[k] = Math.round(ins[k] * dpr);
  return ins;
}

export class ScoresOverlay {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scores-layer';
    this.canvas.hidden = true;
    parent.append(this.canvas);
    this.hud = new Hud();
    this.replay = null;
    this.held = false;
    this.raf = 0;
    this.key = '';
    this.insets = null; this.insetsAt = 0;
  }
  /** the demo shown (null: none) */
  setReplay(replay) {
    this.hide();
    this.replay = replay;
    if (!replay) { this.hud.clearMatch(); return; }   // (the old demo must not stay in memory)
    this.hud.setMatch(replay.match);
    // the HUD font and images ready before the first Tab (a first load takes a few seconds)
    setTimeout(() => { if (this.replay === replay) this.hud.load(); }, 2000);
  }
  get shown() { return this.held; }
  show() {
    if (this.held || !this.replay) return;
    this.held = true;
    this.key = ''; this.insets = null;
    this.hud.load().then(ok => { if (ok && this.held && !this.raf) this.tick(); });
  }
  hide() {
    this.held = false;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    const cv = this.canvas;
    cv.hidden = true;
    if (cv.width) { cv.width = 0; cv.height = 0; }
  }
  /** one frame while held: redrawn when the time, the size or the watched player changed */
  tick() {
    this.raf = 0;
    if (!this.held || !this.replay || !this.hud.data) return;
    const R = this.replay, cv = this.canvas;
    cv.hidden = false;
    const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    // the watched player's row lit: the first-person player, else the selected one
    const v = R.view, cl = v && v.fpClient != null ? v.fpClient : R.focus;
    const t = R.pb.t;
    const now = performance.now();
    if (!this.insets || now - this.insetsAt > 500) { this.insets = uiInsets(cv, dpr); this.insetsAt = now; this.key = ''; }
    const key = w + 'x' + h + '|' + Math.floor(t) + '|' + cl;
    if (key !== this.key) {
      this.key = key;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);
      this.hud.drawScores(g, w, h, t, cl, this.insets);
    }
    this.raf = requestAnimationFrame(() => this.tick());
  }
}
