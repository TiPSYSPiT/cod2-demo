/* The FPS counter over the view, top right under the fullscreen button (Layers, Viewer, FPS counter: off by default,
 * remembered for the session - PLAN.md step 112). Loaded by main.js only when it is switched on (not part of the
 * page's start). It counts the frames the active view draws (the Replay's `frames`: view2d.js draw, the 3D view's
 * loop - a paused view draws none: "idle") over windows of WINDOW_MS and writes the frames per second and the mean time
 * between the frames twice a second, only when the text changed: no page update per frame. A page element over the
 * canvas - never in a video export. */
const WINDOW_MS = 500;

export class FpsMeter {
  /** stage: the element it shows in; count: () => the frames drawn so far (a counter that only grows, or starts again) */
  constructor(stage, count) {
    this.node = document.createElement('div');
    this.node.className = 'fps';
    this.node.hidden = true;
    this.node.setAttribute('aria-hidden', 'true');
    this.node.title = 'Frames the view draws per second · the mean time between them (Layers: FPS counter)';
    stage.append(this.node);
    this.stage = stage;
    this.count = count;
    this.timer = 0;
    this.text = '';
  }
  /** shown and counting, or not */
  set(run) {
    this.node.hidden = !run;
    this.stage.classList.toggle('fps-on', run);     // (the 3D kill feed overlay moves down: css .fps)
    if (run && !this.timer) {
      this.t0 = performance.now();
      this.n0 = this.count();
      this.write('… FPS');
      this.timer = setInterval(() => this.tick(), WINDOW_MS);
    } else if (!run && this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  }
  tick() {
    const now = performance.now(), dt = now - this.t0, c = this.count();
    const n = c >= this.n0 ? c - this.n0 : c;          // (another demo: its counter started again)
    this.t0 = now;
    this.n0 = c;
    this.write(n ? Math.round(n * 1000 / dt) + ' FPS · ' + (dt / n).toFixed(1) + ' ms' : 'idle');
  }
  write(s) {
    if (s === this.text) return;
    this.text = s;
    this.node.textContent = s;
  }
}
