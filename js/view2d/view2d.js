/* 2D view: top-down replay on the map's top-down render or zPAM radar image, drawn from the shared
 * Match + Replay state (from cod4-demo3d). Renderer, heatmap, heat panel and video export are the
 * shared modules in js/c2/ui/map. */
import { InfoHint, fadeHint } from '../app/infoHint.js';
import { InspectLayer, LOOK_PRESETS, DEFAULT_LOOK } from './inspect.js';

const C2 = window.C2;
const { el, icon } = C2.ui;
const CFG = C2.mapConfig;

const BOMB_TEXT = { base: 'Bomb at its start position', dropped: 'Dropped', planted: 'Planted', defused: 'Defused', exploded: 'Exploded' };
const BOMB_SOURCE = { objective: 'compass objective', model: 'bomb model', planter: 'in front of the planter, as the game places it',
  'last known': 'position of the planter (≈)', message: 'server message' };
const BG_KEY = 'cod2demo3d.background';
// Inspect (inspect.js): on / off and the look, remembered (localStorage); the camera it tilts to
const INSPECT_KEY = 'cod2demo.inspect', LOOK_KEY = 'cod2demo.inspect.look';
const INSPECT_TILT = 55 * Math.PI / 180, INSPECT_YAW = -35 * Math.PI / 180;
const ORBIT = { minTilt: 5 * Math.PI / 180, maxTilt: 80 * Math.PI / 180 };
const HINT_FLAT = 'Wheel: zoom · drag: pan · double-click: reset · Q / E: rotate';
const HINT_INSPECT = HINT_FLAT + ' · right-drag / Shift + drag: orbit';

export class View2D {
  constructor(replay, container) {
    this.key = '2d';
    this.R = replay;
    this.M = replay.match;
    const M = this.M, d = M.d, app = replay.app;
    this.stage = el('div', { class: 'view-stage view2d' });
    container.append(this.stage);
    // the background's details (the rail's info popover; a missing background shown as a warning); the
    // controls hint fades after a few seconds (infoHint.js)
    this.info = new InfoHint(this.stage, 'Map image details');
    this.hint = this.info.box;
    this.ctrlHint = el('div', { class: 'cam-hint' }, HINT_FLAT);
    this.renderer = new C2.MapRenderer(this.stage, M.rect);
    this.renderer.setRotation(this.loadRotation());
    this.renderer.onChange = () => replay.invalidate();
    this.renderer.canvas.addEventListener('mousemove', e => {
      const r = this.renderer.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.updateBombTitle();
    });
    this.renderer.canvas.addEventListener('mouseleave', () => { this.mouse = null; this.updateBombTitle(); });
    // heatmap: data points per category, raster layer, options panel
    this.heatPts = {};
    this.heatLayer = new C2.HeatLayer(M.rect);
    this.heatUi = C2.mapHeat.create({ app, data: d, onChange: () => replay.invalidate() });
    // map tools (zoom, rotation) bottom right of the map; the heatmap is a popover of the rail (main.js: panels)
    const tool = (name, title, label, fn) => el('button', { class: 'ib', title, 'aria-label': label, onclick: fn }, icon(name));
    const tools = el('div', { class: 'map-tools glass' },
      tool('plus', 'Zoom in', 'Zoom in', () => this.zoomBy(1.25)),
      tool('minus', 'Zoom out', 'Zoom out', () => this.zoomBy(1 / 1.25)),
      tool('rotl', 'Rotate 90° left (Q)', 'Rotate left', () => this.rotate(1)),
      tool('rotr', 'Rotate 90° right (E)', 'Rotate right', () => this.rotate(-1)));
    this.stage.append(tools, this.ctrlHint, this.heatUi.panel, this.heatUi.chip);
    this.panels = [{ key: 'heat', title: 'Heatmap', icon: 'flame', custom: this.heatUi }];
    this.setupInspect(tools);
    // backgrounds: the top-down render of the BSP and zPAM's radar image (assets/maps/backgrounds.js),
    // or the neutral grid; the choice is remembered (a group of the Layers popover)
    const bgs = M.backgrounds || {};
    const kinds = [['topdown', 'Render'], ['radar', 'zPAM radar'], ['grid', 'Grid']].filter(([k]) => k === 'grid' || bgs[k]);
    this.bgSel = el('select', { title: 'Map background', 'aria-label': 'Map background', onchange: e => this.setBackground(e.target.value, true) },
      kinds.map(([k, label]) => el('option', { value: k }, label)));
    this.layerExtras = el('div', { class: 'grp' }, el('h4', null, 'Map', el('span', null, '2D only')), C2.ui.selectRow('Background', this.bgSel));
    let kind = null;
    try { kind = localStorage.getItem(BG_KEY); } catch (err) { /* storage blocked */ }
    if (!kinds.some(([k]) => k === kind)) kind = kinds[0][0];
    this.setBackground(kind);
    this.onKey = e => {
      if (!this.visible || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' && document.activeElement.type !== 'checkbox' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyQ') { e.preventDefault(); this.rotate(1); }
      else if (e.code === 'KeyE') { e.preventDefault(); this.rotate(-1); }
      else if (e.code === 'KeyT' && this.inspect) { e.preventDefault(); this.setInspect(!this.inspectOn, true); }
    };
    window.addEventListener('keydown', this.onKey);
    this.stage.hidden = true;
    this.visible = false;
  }

  /** 'topdown' | 'radar' | 'grid'; remember: the viewer chose it (a map without the stored kind - e.g.
   *  one without exported data, only a grid - must not overwrite the preference for the other maps) */
  setBackground(kind, remember = false) {
    const M = this.M, bgs = M.backgrounds || {}, entry = kind !== 'grid' ? bgs[kind] : null;
    this.bgSel.value = kind;
    this.bgKind = kind;
    if (remember) try { localStorage.setItem(BG_KEY, kind); } catch (err) { /* not stored */ }
    if (!entry) {
      this.renderer.setImage(null, null);
      this.info.set(M.backgrounds ? 'Neutral grid (' + M.rectSource + ').' : 'No exported map data for ' + (M.d.meta.map || 'this map') +
        ' - neutral grid (' + M.rectSource + '). See README: map export.', { warn: !M.backgrounds });
      this.R.invalidate();
      return;
    }
    const r = entry.rect, rect = { minX: Math.min(r[0], r[2]), maxX: Math.max(r[0], r[2]), minY: Math.min(r[1], r[3]), maxY: Math.max(r[1], r[3]) };
    const im = new Image();
    const src = C2.maps.IMAGE_DIR + entry.image;
    im.onload = () => { if (this.bgKind !== kind) return; this.renderer.setImage(im, rect); this.R.invalidate(); };
    im.onerror = () => { this.info.set('Background image ' + src + ' could not be loaded - neutral grid.', { warn: true }); };
    im.src = src;
    this.info.set(kind === 'radar'
      ? 'Background: zPAM 4.09 radar image of ' + bgs.key + ', placed with its .radar calibration (cg_hudRadar*).'
      : 'Background: top-down render of ' + bgs.key + ' from the BSP of the map (textures and lightmaps), aligned to world coordinates.');
  }

  show() { this.visible = true; this.stage.hidden = false; this.renderer.resize(); fadeHint(this.ctrlHint); }
  hide() { this.visible = false; this.stage.hidden = true; if (this.heatUi.close) this.heatUi.close(); }
  destroy() {
    window.removeEventListener('keydown', this.onKey); this.renderer.dispose(); if (this.heatUi.close) this.heatUi.close();
    this.stopCamAnim();
    if (this.inspect) this.inspect.dispose();
    this.stage.remove();
  }

  /* ---------- Inspect: the map tilted, as a see-through model (inspect.js) ---------- */
  setupInspect(tools) {
    const M = this.M, entry = M.backgrounds && M.backgrounds.inspect;
    this.inspect = null;
    if (!entry) return;
    const layer = this.inspect = new InspectLayer(entry, M.rect);
    let look = null;
    try { look = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null'); } catch (err) { /* the default look */ }
    layer.look = Object.assign({}, DEFAULT_LOOK, look && typeof look === 'object' ? look : {}, { roof: null });
    layer.onReady = () => {
      if (layer.state === 'failed') {
        this.info.set('Inspect: the map model could not be loaded (' + layer.error + ') - flat map.', { warn: true });
        this.setInspect(false);
      }
      this.R.invalidate();
    };
    this.inspectBtn = el('button', { class: 'ib', title: 'Inspect: the map tilted, as a see-through model (T)', 'aria-label': 'Inspect', 'aria-pressed': 'false',
      onclick: () => this.setInspect(!this.inspectOn, true) }, icon('cube'));
    tools.prepend(this.inspectBtn);
    this.renderer.onOrbit = () => this.syncInspectUi();
    this.panels.push({ key: 'inspect', title: 'Inspect', hint: 'the tilted map', icon: 'cube', node: this.inspectPanel() });
    let on = false;
    try { on = localStorage.getItem(INSPECT_KEY) === 'on'; } catch (err) { /* flat */ }
    if (on) this.setInspect(true, false, false);
  }

  /** Inspect on / off: the camera tilts (animated) and the mesh layer is drawn instead of the background */
  setInspect(on, remember = false, animate = true) {
    const layer = this.inspect, R = this.renderer;
    if (!layer || (on && layer.state === 'failed')) on = false;
    this.inspectOn = on;
    if (remember) try { localStorage.setItem(INSPECT_KEY, on ? 'on' : 'off'); } catch (err) { /* not stored */ }
    if (layer) {
      if (on) { layer.load(); R.layer = layer; R.cam.zRef = layer.zRange[0]; R.orbit = ORBIT; }
      else R.orbit = null;
      this.inspectBtn.classList.toggle('active', on);
      this.inspectBtn.setAttribute('aria-pressed', String(on));
    }
    this.ctrlHint.textContent = on ? HINT_INSPECT : HINT_FLAT;
    const to = on ? { yaw: INSPECT_YAW, tilt: INSPECT_TILT } : { yaw: 0, tilt: 0 };
    this.animateCam(to, animate, () => { if (!this.inspectOn) R.layer = null; });
    this.syncInspectUi();
  }

  /** the camera to {yaw, tilt}, eased over 450 ms (or at once) -> done() */
  animateCam(to, animate, done) {
    const R = this.renderer, from = { yaw: R.cam.yaw, tilt: R.cam.tilt };
    this.stopCamAnim();
    const set = k => { R.cam.yaw = from.yaw + (to.yaw - from.yaw) * k; R.cam.tilt = from.tilt + (to.tilt - from.tilt) * k; this.R.invalidate(); };
    if (!animate || (from.yaw === to.yaw && from.tilt === to.tilt)) { set(1); if (done) done(); return; }
    const t0 = performance.now(), ms = 450;
    const finish = () => { this.stopCamAnim(); set(1); if (done) done(); this.syncInspectUi(); };
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      if (k >= 1) { finish(); return; }
      set(k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
      this.camAnim = requestAnimationFrame(step);
    };
    this.camAnim = requestAnimationFrame(step);
    // (a page in the background gets no animation frames: the end comes anyway)
    this.camTimer = setTimeout(finish, ms + 60);
  }
  stopCamAnim() {
    if (this.camAnim) cancelAnimationFrame(this.camAnim);
    if (this.camTimer) clearTimeout(this.camTimer);
    this.camAnim = this.camTimer = null;
  }

  /** the Inspect popover: on / off, the camera, the roof cut, the look (styles, colours, opacities) */
  inspectPanel() {
    const layer = this.inspect, L = () => layer.look, ui = {};
    const changed = (store = true) => {
      if (store) try { const keep = Object.assign({}, layer.look); delete keep.roof; localStorage.setItem(LOOK_KEY, JSON.stringify(keep)); } catch (err) { /* not stored */ }
      this.R.invalidate();
    };
    const custom = () => { L().preset = 'custom'; ui.preset.value = 'custom'; };
    const row = (label, ctl, title) => el('label', { class: 'sw insp-row', title: title || null }, el('span', { class: 'sw-l' }, label), el('span', { class: 'insp-ctl' }, ...ctl));
    const pct = v => Math.round(v * 100) + ' %';
    const range = (key, label, min, max, step, title) => {
      const val = el('small', { class: 'insp-val' });
      const inp = el('input', { type: 'range', class: 'insp-range', min, max, step, 'aria-label': label });
      inp.addEventListener('input', () => { L()[key] = Number(inp.value); val.textContent = pct(L()[key]); custom(); changed(); });
      ui[key] = () => { inp.value = String(L()[key]); val.textContent = pct(L()[key]); };
      return row(label, [inp, val], title);
    };
    const colour = (key, label, title) => {
      const inp = el('input', { type: 'color', class: 'insp-color', 'aria-label': label });
      inp.addEventListener('input', () => { L()[key] = inp.value; custom(); changed(); });
      ui[key] = () => { inp.value = L()[key]; };
      return row(label, [inp], title);
    };
    const box = (key, label, title) => {
      const inp = el('input', { type: 'checkbox', onchange: e => { L()[key] = e.target.checked; custom(); changed(); } });
      ui[key] = () => { inp.checked = !!L()[key]; };
      return C2.ui.switchRow(label, inp, { title });
    };
    const onBox = el('input', { type: 'checkbox', onchange: e => this.setInspect(e.target.checked, true) });
    ui.on = () => { onBox.checked = !!this.inspectOn; };
    // the camera: the tilt (5..80 degrees)
    const tilt = el('input', { type: 'range', class: 'insp-range', min: 5, max: 80, step: 1, 'aria-label': 'Tilt' });
    const tiltVal = el('small', { class: 'insp-val' });
    tilt.addEventListener('input', () => {
      if (!this.inspectOn) return;
      this.stopCamAnim();
      this.renderer.cam.tilt = Number(tilt.value) * Math.PI / 180; tiltVal.textContent = tilt.value + '°'; this.R.invalidate();
    });
    ui.tilt = () => { const d = Math.round(this.renderer.cam.tilt * 180 / Math.PI); tilt.value = String(Math.max(5, d)); tiltVal.textContent = d + '°'; tilt.disabled = !this.inspectOn; };
    // the roof cut: everything above it left out (the top: off) - for this visit only
    const zr = layer.zRange, top = Math.ceil((zr[1] + 128) / 16) * 16, bottom = Math.floor(zr[0] / 16) * 16;
    const roof = el('input', { type: 'range', class: 'insp-range', min: bottom, max: top, step: 8, 'aria-label': 'Roof cut' });
    const roofVal = el('small', { class: 'insp-val' });
    const roofText = () => (L().roof == null ? 'off' : 'z ' + L().roof);
    roof.addEventListener('input', () => { const v = Number(roof.value); L().roof = v >= top ? null : v; roofVal.textContent = roofText(); changed(false); });
    ui.roof = () => { roof.value = String(L().roof == null ? top : L().roof); roofVal.textContent = roofText(); roof.disabled = !this.inspectOn; };
    ui.preset = el('select', { 'aria-label': 'Style', onchange: e => {
      const p = LOOK_PRESETS[e.target.value];
      if (!p) return;
      Object.assign(layer.look, p, { preset: e.target.value });
      delete layer.look.label;
      this.syncInspectUi(); changed();
    } }, Object.entries(LOOK_PRESETS).map(([k, p]) => el('option', { value: k }, p.label)), el('option', { value: 'custom', hidden: true }, 'Custom'));
    const syncPreset = () => { ui.preset.value = L().preset in LOOK_PRESETS ? L().preset : 'custom'; };
    const resetView = el('button', { class: 'tb small', type: 'button', onclick: () => {
      if (!this.inspectOn) return;
      this.renderer.zoom = 1; this.renderer.pan = { x: 0, y: 0 };
      this.animateCam({ yaw: INSPECT_YAW, tilt: INSPECT_TILT }, true);
    } }, 'Reset view');
    const resetLook = el('button', { class: 'tb small', type: 'button', onclick: () => {
      layer.look = Object.assign({}, DEFAULT_LOOK, { roof: layer.look.roof });
      try { localStorage.removeItem(LOOK_KEY); } catch (err) { /* not stored */ }
      this.syncInspectUi(); this.R.invalidate();
    } }, 'Reset look');
    const node = el('div', { class: 'pop-body insp' },
      el('div', { class: 'grp' },
        C2.ui.switchRow('Inspect', onBox, { title: 'The map tilted, as a see-through model: the walkable floors with their outlines, the walls as a faint volume (T)' }),
        row('Tilt', [tilt, tiltVal], 'How far the map is tilted (right-drag or Shift + drag on the map turns and tilts it)'),
        row('Roof cut', [roof, roofVal], 'Leave out everything above this height - to look into the buildings (for this visit)'),
        el('div', { class: 'insp-btns' }, resetView)),
      el('div', { class: 'grp' }, el('h4', null, 'Look'),
        C2.ui.selectRow('Style', ui.preset),
        colour('floor', 'Floors', 'The walkable floors'),
        range('floorOpacity', 'Floor opacity', 0, 1, 0.02),
        range('heightShade', 'Height shading', 0, 1, 0.05, 'The floors brighter the higher they are'),
        box('byHeight', 'Colour by height', 'The floors coloured by their height (low teal, high amber) instead of their colour'),
        colour('wall', 'Walls', 'The walls and steep faces, as a faint volume'),
        range('wallOpacity', 'Wall opacity', 0, 0.6, 0.01),
        colour('outline', 'Outlines', 'The edges of the floors'),
        range('outlineOpacity', 'Outline opacity', 0, 1, 0.02),
        colour('background', 'Background'),
        range('brightness', 'Brightness', 0.5, 1.6, 0.05, 'The brightness of the map'),
        box('grid', 'Ground grid', 'A grid of 256 units under the map'),
        el('div', { class: 'insp-btns' }, resetLook)));
    this.syncInspectUi = () => { for (const f of Object.values(ui)) if (typeof f === 'function') f(); syncPreset(); };
    this.syncInspectUi();
    return node;
  }
  syncInspectUi() { /* (replaced by inspectPanel) */ }

  /* ---------- one frame ---------- */
  draw(t) {
    const R = this.renderer, M = this.M, d = M.d, RP = this.R, o = RP.opts;
    const ep = M.epochStart(t);
    R.begin();
    R.drawBackground();
    const heatInfo = this.drawHeat(t);
    if (!this.exporting) this.heatUi.info(heatInfo);
    if (heatInfo && !this.heatUi.opts.keep) { this.bombHit = null; return; }

    // the bomb sites (S&D; assets/maps/backgrounds.js)
    if (d.meta.isSearchAndDestroy && M.backgrounds && M.backgrounds.sites) for (const s of M.backgrounds.sites) R.drawSite(s.origin[0], s.origin[1], s.label, s.origin[2]);

    // grenades of the current round
    for (const gr of M.grenades) {
      if (!o.grenadeKinds.has(gr.g.kind) || t < gr.start || t > gr.end || gr.start < ep) continue;
      const det = gr.g.detonation;
      if (!det || t < det.t) {
        const shown = gr.pts.filter(p => p[0] <= t);
        R.drawPath(shown.map(p => [p[1], p[2], p[3]]), gr.cfg.color, 0.85, [4, 3]);
        const cur = shown[shown.length - 1];
        if (cur) R.drawDot(cur[1], cur[2], gr.cfg.color, 1, 3, cur[3]);
      } else {
        const age = t - det.t;
        const fadeStart = gr.cfg.duration - gr.cfg.fade;
        const alpha = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / gr.cfg.fade);
        R.drawPath(gr.pts.map(p => [p[1], p[2], p[3]]), gr.cfg.color, 0.35 * alpha, [4, 3]);
        R.drawCircle(det.x, det.y, gr.cfg.radius, gr.cfg.color, 0.95 * alpha, gr.g.kind === 'smoke' ? 0.35 : 0.22, det.z);
      }
    }

    // the map's intermission camera and hurt triggers (maps3d/<map>/entities.json)
    if (o.mapCams || o.hurt) this.drawMapMarks(o);

    const shown = RP.shownPlayers();
    const hover = this.exporting ? null : RP.hover;
    const dim = cl => (hover != null && cl !== hover) || (RP.focus != null && cl !== RP.focus && hover == null);
    if (o.trails) for (const cl of shown) R.drawTrail(M.trailOf(cl, t).map(s => s.map(p => [p[0], p[1], p[3], p[2]])), M.color(cl), dim(cl) ? 0.45 : 1);

    // kill lines (killer -> victim) and death markers
    for (const k of RP.recentKills(t, CFG.DEATH_MARKER_MS)) {
      if (!shown.has(k.victim) && !shown.has(k.attacker)) continue;
      const age = t - k.t, fade = 1 - age / CFG.DEATH_MARKER_MS;
      const vp = M.deathPos(k);
      if (o.killLines && vp && !k.suicide && !k.world && k.attacker < 64) {
        const ap = M.attackerPos(k);
        if (ap) R.drawPath([[ap[0], ap[1], ap[2]], [vp[0], vp[1], vp[2]]], M.color(k.attacker), 0.75 * fade, k.headshot ? null : [6, 4]);
      }
      if (vp && shown.has(k.victim)) R.drawDeath(vp[0], vp[1], M.color(k.victim), 1 - (age / CFG.DEATH_MARKER_MS) * 0.7, vp[2]);
    }

    // the recording player's hits from zPAM's damage log: a dotted line to the hit point and the damage, 2.5 s
    if (o.hits && M.d.zpamHits && M.d.zpamHits.length) {
      for (const h of M.d.zpamHits) {
        if (h.t > t) break;
        const age = t - h.t;
        if (age > CFG.HIT_MS || !h.my) continue;
        const p = h.hit || h.enemy, fade = 1 - age / CFG.HIT_MS, col = M.color(M.d.meta.povClient);
        R.drawPath([[h.my[0], h.my[1], h.my[2]], [p[0], p[1], p[2]]], col, 0.6 * fade, [2, 3]);
        R.drawHit(p[0], p[1], col, fade, '-' + h.damage + (h.damage >= h.health ? ' ✝' : ''), p[2]);
      }
    }

    // players (hovered / selected on top)
    const povFollow = M.followedAt(t);
    const rank = cl => (cl === hover ? 2 : 0) + (cl === RP.focus ? 1 : 0);
    const order = [...shown].sort((a, b) => rank(a) - rank(b));
    for (const cl of order) {
      const s = M.sampleAt(cl, t);
      if (!s) continue;
      const stale = s.age > CFG.STALE_MS;
      if (stale && (!o.lastKnown || s.age > CFG.LAST_KNOWN_MAX_MS)) continue;
      const hi = cl === hover || cl === RP.focus;
      R.drawPlayer(s, M.color(cl), {
        hollow: stale, alpha: stale ? 0.55 : 1, firing: s.firing, highlight: cl === povFollow, hover: hi,
        label: o.labels || hi ? M.name(cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '') : null
      });
    }
    this.drawBomb(t);
    if (!this.exporting) this.updateBombTitle();
  }

  /** the map's intermission camera (mp_global_intermission) and hurt triggers (trigger_hurt), loaded once */
  drawMapMarks(o) {
    if (this.mapEnts === undefined) {
      this.mapEnts = null;
      const key = this.M.backgrounds && this.M.backgrounds.key;
      if (key) fetch(C2.maps.IMAGE_DIR + key + '/entities.json').then(r => (r.ok ? r.json() : null))
        .then(j => { this.mapEnts = j; this.R.invalidate(); }).catch(() => {});
      return;
    }
    const E = this.mapEnts;
    if (!E) return;
    if (o.hurt) for (const h of E.hurt || []) this.renderer.drawBox(h.mins, h.maxs, '#ff5a3c', 'hurt ' + h.dmg + (h.dmg >= 100 ? ' (kill)' : '') + ' · z ' + Math.round(h.mins[2]) + '…' + Math.round(h.maxs[2]));
    if (o.mapCams) for (const s of E.spawns || []) if (s.classname === 'mp_global_intermission' && s.origin) this.renderer.drawCamera(s.origin[0], s.origin[1], (s.angles || [0, 0, 0])[1], 'intermission', s.origin[2]);
  }

  drawHeat(t) {
    const o = this.heatUi.opts, L = this.heatLayer, RP = this.R;
    if (o.cat === 'off') return null;
    const pts = this.heatPts[o.cat] || (this.heatPts[o.cat] = C2.heatPoints.build(this.M.d, o.cat));
    const players = o.players ? [...o.players].sort((x, y) => x - y).join(',') : '*';
    const fkey = o.cat + '|' + o.team + '|' + o.side + '|' + players;
    if (this.heatMaskKey !== fkey) { this.heatMask = C2.heatPoints.mask(pts, o.team, o.side, o.players); this.heatMaskKey = fkey; }
    const [from, end] = RP.pb.range;
    const to = o.upTo ? t : end;
    const key = fkey + '|' + from + '|' + (o.upTo ? 'upto' : end);
    const now = performance.now();
    const throttle = !this.exporting && o.upTo && RP.pb.playing && L.key === key && to >= L.until && now - (this.heatAt || 0) < CFG.HEAT.THROTTLE_MS;
    if (!throttle) { L.accumulate(key, pts, this.heatMask, from, to); this.heatAt = now; }
    this.renderer.drawRaster(L.paint(o.radius, o.intensity), L.rect, 1);
    return { n: L.n, missing: L.missing, unattributed: L.unattributed, filtered: o.team !== 'both' || o.side !== 'both' || !!o.players };
  }

  drawBomb(t) {
    const M = this.M, e = M.bombAt(t), R = this.renderer, B = CFG.BOMB;
    this.bombHit = null;
    if (!e) return;
    let pos = null, opts = {}, text;
    if (e.state === 'carried') {
      const s = M.sampleAt(e.carrier, t);
      if (!s || s.age > CFG.STALE_MS) return;
      R.drawRing(s.x, s.y, B.color, CFG.PLAYER_RADIUS_PX + 3.5, 0.9, s.z);
      pos = [s.x, s.y, s.z];
      opts = { dx: 8, dy: -8, round: true };
      text = 'Carried by ' + M.name(e.carrier);
    } else if (e.state === 'unknown') {
      if (e.x == null) return;
      pos = [e.x, e.y, e.z];
      opts = { alpha: B.unknownAlpha, hollow: true };
      text = 'Bomb position unknown (not visible to POV) - last known position';
    } else if (e.state === 'exploded') {
      const age = t - e.t;
      if (age > B.explodedMs || e.x == null) return;
      pos = [e.x, e.y, e.z];
      opts = { burst: age / B.explodedMs, alpha: 1 - 0.6 * age / B.explodedMs };
      text = 'Exploded' + (e.site ? ' - site ' + e.site : '');
    } else {
      if (e.x == null) return;
      pos = [e.x, e.y, e.z];
      if (e.state === 'planted') {
        const bt = M.bombTimer(t);
        opts = { pulse: ((t - e.t) % B.pulseMs) / B.pulseMs, label: bt ? (bt.heuristic ? '≈' : '') + Math.ceil(bt.left / 1000) + 's' : null };
      }
      if (e.state === 'defused') opts = { color: B.defusedColor };
      text = BOMB_TEXT[e.state] + (e.site ? ' - site ' + e.site : '');
    }
    const sp = R.drawBomb(pos[0], pos[1], Object.assign(opts, { z: pos[2] }));
    if (e.source && BOMB_SOURCE[e.source]) text += ' (position: ' + BOMB_SOURCE[e.source] + ')';
    this.bombHit = { x: sp.x, y: sp.y, text };
  }

  updateBombTitle() {
    const h = this.bombHit, m = this.mouse;
    const on = !!(h && m && Math.hypot(h.x - m.x, h.y - m.y) <= CFG.BOMB.hitPx);
    const title = on ? h.text : '';
    if (this.renderer.canvas.title !== title) this.renderer.canvas.title = title;
  }

  zoomBy(f) {
    const R = this.renderer, cx = R.w / 2, cy = R.h / 2;
    const [wx, wy] = R.inv(cx, cy);
    R.zoom = Math.min(12, Math.max(0.5, R.zoom * f));
    const [nx, ny] = R.pt(wx, wy);
    R.pan.x += cx - nx; R.pan.y += cy - ny;
    this.R.invalidate();
  }

  loadRotation() {
    try {
      const v = localStorage.getItem(CFG.ROTATION_KEY + (this.M.d.meta.map || ''));
      if (v != null && /^[0-3]$/.test(v)) return Number(v);
    } catch (err) { /* storage blocked: the default */ }
    return CFG.ROTATION_DEFAULT;
  }
  rotate(dir) {
    const R = this.renderer;
    R.setRotation(R.rot + dir);
    try { localStorage.setItem(CFG.ROTATION_KEY + (this.M.d.meta.map || ''), String(R.rot)); } catch (err) { /* not stored */ }
    this.R.invalidate();
  }

  /* ---------- video export (exportVideo.js) ---------- */
  exportVideo() {
    const RP = this.R, view = this;
    const state = {
      get d() { return RP.d; }, get scope() { return RP.scope; }, get pb() { return RP.pb; },
      get base() { return RP.base; }, get timeline() { return RP.timeline; }, get renderer() { return view.renderer; }
    };
    C2.mapExport.open({
      state,
      roundAtOrBefore: t => RP.match.roundAtOrBefore(t),
      drawFrame(renderer, t) {
        const keep = view.renderer;
        view.renderer = renderer; view.exporting = true;
        try { view.draw(t); } finally { view.renderer = keep; view.exporting = false; }
      },
      done() { view.heatLayer.invalidate(); RP.invalidate(); }
    });
  }
}
