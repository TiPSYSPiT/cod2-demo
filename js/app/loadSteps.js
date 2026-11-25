/* The steps of a demo's load with their times (PLAN.md step 112) - the start page's indicator (index.html) for a
 * demo: download (a link), reading the file, parsing (the worker's real progress), the match analysis, then the view's
 * own - 3D: its code (three.js), the map geometry (real progress), shaders, textures (n of m), props, lighting, the
 * first frame; 2D: the map image. main.js makes one per load with the steps it expects (the view the demo opens in)
 * and shows it in the progress area until the viewer is up, then over the view; the views report through the
 * replay's `loadTrack` (only the steps it has). A bar weighted by the steps, the time per step and in all (ms under
 * 1 s, else s), from the moment the file was picked; it fades out when every step is done. Written only when
 * something changed, at most every RENDER_MS. */
const C2 = window.C2;
const { el } = C2.ui;
const RENDER_MS = 200;
const fmt = ms => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');
const lc = s => s.charAt(0).toLowerCase() + s.slice(1);

export class LoadTrack {
  /** t0: when the load began (performance.now()) */
  constructor(t0 = performance.now()) {
    this.t0 = t0;
    this.steps = new Map();          // key -> {label, weight, start, end, frac, detail, note, state}
    this.finished = false;
    this.ui = null;
    this.timer = 0;
    this.dirty = true;
  }
  /** a step expected: label (its row), doing (the head line while it runs: "Parsing the messages"), weight (its share
   *  of the bar) */
  add(key, label, doing, weight = 1) {
    if (!this.steps.has(key)) this.steps.set(key, { label, doing, weight, start: null, end: null, frac: 0, detail: '', note: '' });
    this.changed();
    return this;
  }
  has(key) { return this.steps.has(key) && !this.finished; }
  /** the step began (also: progress / end begin it) */
  start(key) {
    const s = this.steps.get(key);
    if (!s || this.finished || s.start != null) return;
    s.start = performance.now();
    this.changed();
  }
  /** real progress of a step: frac 0..1, detail: a short text ("42 %", "120 of 310") */
  progress(key, frac, detail = '') {
    const s = this.steps.get(key);
    if (!s || this.finished || s.end != null) return;
    if (s.start == null) s.start = performance.now();
    s.frac = Math.max(0, Math.min(1, frac));
    s.detail = detail;
    this.changed();
  }
  /** the step is done; note: shown instead of its time ("none", "not loaded") */
  end(key, note = '') {
    const s = this.steps.get(key);
    if (!s || this.finished || s.end != null) return;
    if (s.start == null) s.start = performance.now();
    s.end = performance.now();
    s.frac = 1;
    s.note = note;
    this.changed();
    this.check();
  }
  /** the steps that will not come (another view chose, no 3D data): done without a time */
  skip(keys, note = 'skipped') {
    for (const k of keys) { const s = this.steps.get(k); if (s && s.end == null) { s.end = s.start = performance.now(); s.note = note; } }
    this.changed();
    this.check();
  }
  /** the steps not done yet */
  pending() { return [...this.steps.entries()].filter(([, s]) => s.end == null).map(([k]) => k); }
  check() {
    if (this.finished || this.pending().length) return;
    this.finished = true;
    this.total = performance.now() - this.t0;
    this.render(true);
    clearInterval(this.timer);
    this.timer = 0;
    if (this.ui && this.ui.panel) {
      const p = this.ui.panel;
      p.classList.add('out');
      setTimeout(() => p.remove(), 320);
    }
    if (this.onFinish) this.onFinish(this);
  }
  /** the step times as one line (for a tooltip, the console) */
  summary() {
    return [...this.steps.values()].filter(s => s.end != null && !s.note).map(s => lc(s.label) + ' ' + fmt(s.end - s.start)).join(', ');
  }

  /* ---------- the display ---------- */
  /** show in nodes {now, total, fill, steps} (main.js: the progress area's), or - over the view - in a panel of its own
   *  in `parent` */
  attach(nodes) {
    this.ui = nodes;
    this.rows = null;
    this.changed();
    if (!this.timer && !this.finished) this.timer = setInterval(() => this.render(), RENDER_MS);
    this.render(true);
  }
  panelIn(parent) {
    const now = el('span', { class: 'boot-now' }), total = el('span', { class: 'boot-total' });
    const fill = el('div', { class: 'progress-fill' }), steps = el('ol', { class: 'boot-steps' });
    const panel = el('div', { class: 'load-panel glass', role: 'status', 'aria-label': 'Loading the demo' },
      el('div', { class: 'boot-head' }, now, total), el('div', { class: 'progress-bar' }, fill), steps);
    parent.append(panel);
    this.attach({ now, total, fill, steps, panel });
  }
  detach() {
    clearInterval(this.timer);
    this.timer = 0;
    if (this.ui && this.ui.panel) this.ui.panel.remove();
    this.ui = null;
  }
  /** gone without finishing (another demo, an error) */
  dispose() { this.finished = true; this.detach(); }
  changed() { this.dirty = true; }
  render(force = false) {
    const u = this.ui;
    if (!u) return;
    const put = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };
    put(u.total, fmt(this.finished ? this.total : performance.now() - this.t0));
    if (!this.dirty && !force) return;
    this.dirty = false;
    let sum = 0, got = 0, cur = null;
    for (const s of this.steps.values()) {
      sum += s.weight;
      got += s.weight * (s.end != null ? 1 : s.frac);
      if (!cur && s.end == null && s.start != null) cur = s;
    }
    if (!cur) for (const s of this.steps.values()) if (s.end == null) { cur = s; break; }
    const sx = 'scaleX(' + (sum ? got / sum : 0).toFixed(3) + ')';
    if (u.fill.style.transform !== sx) u.fill.style.transform = sx;
    put(u.now, this.finished ? 'Ready' : cur ? cur.doing + (cur.detail ? ' … ' + cur.detail : ' …') : 'Loading …');
    // the rows: built once per display, then only their class and time
    if (!this.rows || this.rows.size !== this.steps.size) {
      this.rows = new Map();
      u.steps.replaceChildren();
      for (const [k, s] of this.steps) {
        const time = el('time'), li = el('li', null, el('span', null, s.label), time);
        u.steps.append(li);
        this.rows.set(k, { li, time });
      }
    }
    for (const [k, s] of this.steps) {
      const r = this.rows.get(k), cls = s.end != null ? (s.note ? 'done skip' : 'done') : s.start != null ? 'now' : '';
      if (r.li.className !== cls) r.li.className = cls;
      put(r.time, s.end != null ? (s.note || fmt(s.end - s.start)) : '');
    }
  }
}
