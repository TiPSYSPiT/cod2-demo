/* 3D view: the exported CoD2 map (world mesh from the BSP, textures, lightmaps, sky), the players as
 * capsules, kill lines, grenades, the bomb, and four camera modes, drawn from the shared Replay state -
 * so time, selection and filters carry over from 2D. From cod4-demo3d's view3d.js (without its game
 * lighting, characters, effects and sound - see PLAN.md). */
import * as THREE from 'three';
import '../c2/ui/killfeed.js';
import { loadWorld, groundPlane, resolveMap, textureArrivals, releaseStandins } from './mapLoader.js';
import { LightProbe } from './lightProbe.js';
import { Actors, EYE, stanceOf } from './actors.js';
import { Effects } from './effects.js';
import { FxPlayer } from './fx.js';
import { Cameras, MODES } from './cameras.js';
import { Props } from './props.js';
import { Sky } from './sky.js';
import { SoundSystem } from './sound.js';
import { CharacterLibrary } from './characters.js';
import { InfoHint, fadeHint, holdHint } from '../app/infoHint.js';
import { CookieShadows } from './shadows.js';
import { LightGrid } from './lightGrid.js';
import { gameObjectFilter, Exploders } from './gameObjects.js';
import { XRay, XRAY_MODES } from './xray.js';

const C2 = window.C2;
const { el, icon, switchRow, selectRow } = C2.ui;
const CFG = C2.mapConfig;
const CAM_KEY = 'cod2demo3d.camera';
const PROPS_KEY = 'cod2demo3d.props';
const KILLFEED_KEY = 'cod2demo3d.killfeed';      // 'on' / 'off' (default on)
const KILL_ICONS_KEY = 'cod2demo3d.killIcons';    // 'on' / 'off' (default off)
const FX_KEY = 'cod2demo3d.fx';                  // 'game' / 'simple'
const PLAYERS_KEY = 'cod2demo3d.players';        // 'simple' / 'models'
const SOUND_KEY = 'cod2demo3d.sound';            // 'on' / 'off' (default off) and '.volume'
const SHADOWS_KEY = 'cod2demo3d.shadows';        // 'on' / 'off' (default on)
const MODE_HELP = { orbit: 'Left drag: rotate · right drag: pan · wheel: zoom · click a player: select',
  free: 'Drag: look · W A S D: move · R / F: up / down · Shift: fast · wheel: speed',
  follow: 'Follows the selected player · drag: turn around them · wheel: distance',
  fp: 'Eyes of the selected player (their real view angles)' };
const stored = key => { try { return localStorage.getItem(key); } catch (err) { return null; } };
const store = (key, v) => { try { localStorage.setItem(key, v); } catch (err) { /* not stored */ } };
// X-Ray: remembered for the browser session only (the user's choice)
const XRAY_KEY = 'cod2demo3d.xray';              // 'off' / 'player' / 'names'
const sessionGet = key => { try { return sessionStorage.getItem(key); } catch (err) { return null; } };
const sessionSet = (key, v) => { try { sessionStorage.setItem(key, v); } catch (err) { /* not stored */ } };

export class View3D {
  constructor(replay, container) {
    this.key = '3d';
    this.R = replay;
    this.M = replay.match;
    this.visible = false;
    this.t = replay.pb.t;
    this.stage = el('div', { class: 'view-stage view3d' });
    this.stage.hidden = true;
    container.append(this.stage);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: true });   // (stencil: X-Ray)
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;    // gamma-space colours, as the game
    this.stage.append(this.renderer.domElement);
    this.labels = el('div', { class: 'label-layer' });
    this.stage.append(this.labels);
    this.info = new InfoHint(this.stage, 'Map and data details');
    this.hint = this.info.box;
    this.info.set('Loading the 3D map …', { open: true });
    this.camHint = el('div', { class: 'cam-hint', hidden: true });
    this.stage.append(this.camHint);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b0c);
    this.camera = new THREE.PerspectiveCamera(65, 1, 4, 80000);
    // the world is lit by its lightmaps; these lights only shade the players, props and lightmap-less parts
    this.hemi = new THREE.HemisphereLight(0xdde6f0, 0x3a3328, 1.7);
    this.hemi.position.set(0, 0, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.3);
    this.sun.position.set(-0.4, -0.5, 1);
    scene.add(this.hemi, this.sun);
    this.characters = new CharacterLibrary();
    this.actors = new Actors(scene, this.labels, this.M, this.characters);
    this.actors.onLoaded = () => { this.R.invalidate(); this.needsRender = true; if (this.actors.failed) this.playersSel.parentNode.title = 'The player models are not exported (tools/export/characters_export.py)'; };
    this.effects = new Effects(scene, this.labels, this.M);
    // the game's particle effects (fx.js): explosions, smoke, impacts, muzzle flashes
    this.fx = new FxPlayer(scene, this.M);
    this.fx.muzzleOf = (cl, ts, t) => {
      const s = this.M.sampleAt(cl, t);
      const mz = s && s.age <= CFG.STALE_MS ? this.actors.muzzle(cl) : null;
      return mz ? Object.assign(mz, { weapon: this.M.weaponName(s.weapon, t) }) : null;
    };
    this.killfeed = new C2.killfeed.Overlay(this.stage, replay.app, this.M.d);
    // the players' and corpses' shadows (shadows.js, CoD2's shadow cookies); ?shadows=off
    this.shadows = new CookieShadows();
    this.needsRender = true;
    this.onArrive = textureArrivals.onArrive = () => { this.needsRender = true; };
    this.cams = new Cameras(this.camera, this.renderer.domElement, () => { this.needsRender = true; });
    this.buildToolbar();
    this.setKillfeed(stored(KILLFEED_KEY) !== 'off');
    this.setKillIcons(stored(KILL_ICONS_KEY) === 'on');
    let mode = 'orbit';
    const m0 = stored(CAM_KEY);
    if (MODES.some(m => m[0] === m0)) mode = m0;
    this.setMode(mode);
    this.setPlayersMode(stored(PLAYERS_KEY) === 'simple' ? 'simple' : 'models');
    this.setFxMode(stored(FX_KEY) === 'simple' ? 'simple' : 'game');
    this.setShadows(new URLSearchParams(location.search).get('shadows') !== 'off' && stored(SHADOWS_KEY) !== 'off');
    this.xray = new XRay(this.renderer);
    this.setXray(sessionGet(XRAY_KEY));

    // click a player to select them (not after a drag)
    let down = null;
    this.renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const cl = this.actors.pick(ray);
      if (cl != null) this.R.setFocus(cl);
    });
    // ?debug: the surface picker (debugPick.js, loaded only then)
    if (new URLSearchParams(location.search).has('debug')) import('./debugPick.js').then(m => m.attachDebugPick(this));
    this.offFocus = replay.on(what => { if (what === 'focus') this.syncPlayerSelect(); });
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.loop = this.loop.bind(this);
    this.last = null;
    this.load();
  }

  /* ---------- map ---------- */
  async load() {
    const M = this.M, map = M.d.meta.map;
    let name = null;
    try { name = await resolveMap(map); } catch (err) { name = null; }
    if (name) {
      try {
        const w = await loadWorld(name, { onProgress: f => { this.info.set('Loading the 3D map ' + name + ' … ' + Math.round(f * 100) + ' %', { open: true }); } });
        this.world = w;
        // the entities the game type deletes, the bomb sites' exploders (gameObjects.js)
        const keep = gameObjectFilter(M.d.meta.gametype);
        this.exploders = new Exploders();
        for (const m of w.mesh.material) {
          const g = m.userData.group;
          if (!g) continue;
          if (!keep(g.gameobject)) m.visible = false;
          else if (g.exploder) this.exploders.add(g.exploder.site, g.exploder.show, v => { m.visible = v; });
        }
        this.scene.add(w.group);
        this.shadows.invalidate();
        this.scene.background = new THREE.Color(0x8ea2b4);
        if (w.info.sky) Sky.load('maps3d/' + name + '/', w.info.sky).then(sky => {
          if (!sky || this.world !== w) return;
          this.sky = sky; this.scene.add(sky.mesh); this.needsRender = true;
        }).catch(err => console.warn('sky not loaded:', err));
        const b = w.info.bounds;
        const span = b ? Math.max(b.maxs[0] - b.mins[0], b.maxs[1] - b.mins[1]) : 8000;
        this.scene.fog = new THREE.Fog(0x8ea2b4, span * 1.2, span * 4);
        // the sun of the map (worldspawn "sundirection": pitch yaw roll towards the sun)
        const sun = w.info.sun || {};
        if (sun.direction) {
          const [p, y] = sun.direction.map(a => a * Math.PI / 180);
          this.sun.position.set(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));   // towards the sun
        }
        if (sun.color) this.sun.color.setRGB(...sun.color);
        this.effects.setSites(w.sites || []);
        try { this.fx.probe = this.actors.probe = new LightProbe(w, w.lightScale); } catch (err) { console.warn('light probe:', err); }
        // the models' light: the map's light grid (lightGrid.js), when exported
        LightGrid.load('maps3d/' + name + '/', w.info).then(g => {
          if (!g || this.world !== w) return;
          g.apply();
          this.actors.grid = g;
          if (this.props) this.props.applyGrid(g);
          this.R.invalidate(); this.needsRender = true;
        }).catch(err => console.warn('light grid not loaded:', err));
        // the map's static models (misc_model): props.js, when exported
        try {
          this.props = await Props.load('maps3d/' + name + '/', { gametype: M.d.meta.gametype });
          if (this.props && this.world === w) {
            for (const p of this.props.exploderParts) this.exploders.add(p.site, p.show, p.apply);
            // the mounted MGs' aim from the demo (DemoData.turrets), matched to the placements by their origin
            this.turretAims = [];
            for (const r of M.d.turrets || []) {
              const p = this.props.turrets.find(q => Math.hypot(q.origin[0] - r.x, q.origin[1] - r.y, q.origin[2] - r.z) < 4);
              if (p) this.turretAims.push({ track: r, prop: p, pitch: null, yaw: null });
            }
            if (this.t != null) this.aimTurrets(this.t);
            this.scene.add(this.props.group);
            this.shadows.invalidate();
            if (this.actors.grid) this.props.applyGrid(this.actors.grid);
            this.propsSel.value = this.props.setMode(stored(PROPS_KEY) || 'high');
            this.propsRow.hidden = false;
          }
        } catch (err) { console.warn('props not loaded:', err); }
        this.mapName = name;
        this.updateHint();
        // the game's sounds (sound.js; ?sound=off: none) - the property is `sounds`; the 3D video export
        // reads it as `view.sound` and renders the range's sound offline (sound.js render)
        if (new URLSearchParams(location.search).get('sound') !== 'off') {
          SoundSystem.load(name).then(snd => {
            if (!snd || this.world !== w) return;
            this.sounds = snd;
            snd.setDemo(this.M);
            snd.setVolume(this.soundVolume);
            this.soundRows.hidden = false;
            if (this.soundWanted && navigator.userActivation && navigator.userActivation.hasBeenActive) this.setSound(true);
            else if (this.soundWanted) this.soundNote.textContent = 'click to start';
          }).catch(err => console.warn('sounds not loaded:', err));
        }
      } catch (err) {
        console.error(err);
        this.fallback('The 3D map data for ' + name + ' could not be loaded (' + err.message + ').');
      }
    } else {
      // (for visitors; the developer's hint goes to the console)
      this.fallback('This site has no 3D data for ' + (map || 'this map') + '.');
      console.info('No maps3d/ data for "' + map + '": export it with tools/export/export_maps.py (README).');
    }
    // start the camera over the area the players used
    const b = M.bbox;
    if (b) this.cams.frame({ mins: [b.minX, b.minY, M.zRange[0]], maxs: [b.maxX, b.maxY, M.zRange[1]] });
    // deep link ?cam=x,y,z,yaw,pitch: a free camera there (yaw / pitch in degrees)
    const cam = (new URLSearchParams(location.search).get('cam') || '').split(',').map(Number);
    if (cam.length === 5 && cam.every(Number.isFinite)) {
      this.cams.place(...cam);
      if (this.modeSel) this.modeSel.value = 'free';
      this.camHint.textContent = MODE_HELP.free;
      fadeHint(this.camHint);
    }
    this.needsRender = true;
    this.R.invalidate();
  }

  fallback(text) {
    const g = groundPlane(this.M);
    this.scene.add(g.group);
    this.scene.background = new THREE.Color(0x4a4d55);       // (a dull sky: the players and the grid stand out)
    this.info.set(text + ' Showing a grid as the ground.', { warn: true });
  }

  /* ---------- options: the Camera and Display popovers of the rail (main.js: panels) ---------- */
  buildToolbar() {
    const SHORT = { orbit: 'Orbit', free: 'Free', follow: 'Follow', fp: '1st P.' };
    this.modeSel = C2.ui.segmented(MODES.map(([k, label]) => [k, SHORT[k] || label, label]), v => this.setMode(v));
    const playerSel = el('select', { onchange: e => { const v = e.target.value; if (v === '') { if (this.R.focus != null) this.R.setFocus(this.R.focus); } else if (Number(v) !== this.R.focus) this.R.setFocus(Number(v)); } });
    this.playerSel = playerSel;
    this.fillPlayerSelect();
    this.propsSel = el('select', { onchange: e => this.setPropsMode(e.target.value) },
      el('option', { value: 'high' }, 'Models'), el('option', { value: 'boxes' }, 'Boxes'), el('option', { value: 'off' }, 'Off'));
    this.propsRow = selectRow('Props', this.propsSel, 'Static models (misc_model props): the real models, see-through boxes of their bounds, or none');
    this.propsRow.hidden = true;
    this.playersSel = el('select', { onchange: e => this.setPlayersMode(e.target.value) },
      el('option', { value: 'simple' }, 'Simple'), el('option', { value: 'models' }, 'Models'));
    this.xraySel = el('select', { onchange: e => this.setXray(e.target.value) }, ...XRAY_MODES.map(([v, label]) => el('option', { value: v }, label)));
    this.fxSel = el('select', { onchange: e => this.setFxMode(e.target.value) },
      el('option', { value: 'game' }, 'Game'), el('option', { value: 'simple' }, 'Simple'));
    // sound: off until switched on (the browsers start audio only after a click); remembered
    this.soundWanted = stored(SOUND_KEY) === 'on';
    const vol = Number(stored(SOUND_KEY + '.volume'));
    this.soundVolume = stored(SOUND_KEY + '.volume') != null && vol >= 0 && vol <= 1 ? vol : 0.8;
    this.soundBtn = el('input', { type: 'checkbox', onchange: e => this.setSound(e.target.checked, true) });
    this.soundNote = el('span');
    this.soundVol = el('input', { type: 'range', class: 'range', min: '0', max: '1', step: '0.05', value: String(this.soundVolume), title: 'Volume',
      oninput: e => { this.soundVolume = Number(e.target.value); if (this.sounds) this.sounds.setVolume(this.soundVolume); store(SOUND_KEY + '.volume', String(this.soundVolume)); } });
    this.soundRows = el('div', { class: 'grp', hidden: true }, el('h4', null, 'Sound'),
      switchRow('Game sounds', this.soundBtn, { title: 'The game\'s sounds with the replay: shots, footsteps, impacts, explosions, the announcer (heard at the camera)', small: this.soundNote }),
      el('label', { class: 'sw' }, el('span', { class: 'sw-l' }, 'Volume'), this.soundVol));
    const arm = () => { if (this.soundWanted && this.sounds && this.visible && !this.sounds.enabled) this.setSound(true); };
    window.addEventListener('pointerdown', arm, { capture: true });
    this.offArm = () => window.removeEventListener('pointerdown', arm, { capture: true });
    this.killfeedBox = el('input', { type: 'checkbox', onchange: e => this.setKillfeed(e.target.checked, true) });
    this.killIconsBox = el('input', { type: 'checkbox', onchange: e => this.setKillIcons(e.target.checked, true) });
    this.shadowsBox = el('input', { type: 'checkbox', onchange: e => this.setShadows(e.target.checked, true) });
    this.panels = [
      { key: 'camera', title: 'Camera', hint: 'C cycles', icon: 'camera', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' }, this.modeSel,
          selectRow('Player', playerSel, 'Selected player (follow / first person); also click a player in the view or the team panel'),
          el('button', { class: 'tb wide', title: 'Back to the overview', onclick: () => this.resetView() }, icon('reset', 's'), 'Reset view'))) },
      { key: 'display', title: 'Display', hint: '3D only', icon: 'sliders', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' },
          selectRow('Players', this.playersSel, 'Player display: capsules, or the real character models (body, head and helmet from the demo, animated with the game\'s animations the demo sends)'),
          selectRow('X-Ray', this.xraySel, 'Living players behind walls and props as a silhouette in the team colour (key X); "Player + name" also shows every name, with a badge when the player is out of sight'),
          this.propsRow,
          selectRow('Effects', this.fxSel, 'Explosions, smoke grenades, bullet impacts and muzzle flashes: the game\'s own particle effects, or simple markers'),
          switchRow('Kill feed', this.killfeedBox, { title: 'The kills and bomb plants / defuses of the last ' + CFG.EXPORT.KILLFEED_MS / 1000 + ' s over the view, with the weapon icons' }),
          switchRow('Kill icons', this.killIconsBox, { title: 'The weapon icon over each death marker' }),
          switchRow('Shadows', this.shadowsBox, { title: 'Soft shadows of the players and corpses on the ground, along the sun (as the game\'s character shadows; the world\'s own shadows are in its lightmaps)' })),
        this.soundRows) }
    ];
  }
  fillPlayerSelect() {
    const d = this.M.d, sel = this.playerSel;
    sel.textContent = '';
    sel.append(el('option', { value: '' }, '— POV / followed —'));
    for (const t of d.teams) {
      const ps = d.players.filter(p => p.team === t.key && d.positions[p.client]);
      if (!ps.length) continue;
      const g = el('optgroup', { label: this.R.app.teamName(t.key) });
      for (const p of ps) g.append(el('option', { value: String(p.client) }, p.cleanName));
      sel.append(g);
    }
    this.syncPlayerSelect();
  }
  syncPlayerSelect() { this.playerSel.value = this.R.focus != null ? String(this.R.focus) : ''; this.needsRender = true; }

  setMode(mode) {
    this.cams.setMode(mode);
    this.modeSel.value = mode;
    this.R.invalidate();
    store(CAM_KEY, mode);
    this.camHint.textContent = MODE_HELP[mode];
    this.camHint.hidden = false;
    fadeHint(this.camHint);
    this.needsRender = true;
  }
  setKillfeed(on, user = false) {
    this.killfeed.visible = on;
    this.killfeedBox.checked = on;
    if (user) store(KILLFEED_KEY, on ? 'on' : 'off');
    this.killfeed.update(this.t || 0);
  }
  setShadows(on, user = false) {
    this.shadows.setEnabled(on);
    this.shadowsBox.checked = on;
    if (user) store(SHADOWS_KEY, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setKillIcons(on, user = false) {
    this.effects.killIcons = on;
    this.killIconsBox.checked = on;
    if (user) store(KILL_ICONS_KEY, on ? 'on' : 'off');
    this.R.invalidate();
  }
  /** sound on / off (user: from the button - remembered) */
  setSound(on, user = false) {
    if (user) { this.soundWanted = on; store(SOUND_KEY, on ? 'on' : 'off'); }
    if (!this.sounds) return;
    const ok = this.sounds.enable(on && this.visible);
    this.soundBtn.checked = ok;
    this.soundNote.textContent = '';
  }
  setPlayersMode(mode) {
    mode = mode === 'models' ? 'models' : 'simple';
    this.playersSel.value = mode;
    this.actors.setMode(mode);
    store(PLAYERS_KEY, mode);
    this.R.invalidate();
    this.needsRender = true;
  }
  /** X-Ray: 'off' | 'player' | 'names' (xray.js) */
  setXray(mode) {
    mode = XRAY_MODES.some(m => m[0] === mode) ? mode : 'off';
    this.xrayMode = mode;
    if (this.xraySel) this.xraySel.value = mode;
    sessionSet(XRAY_KEY, mode);
    this.R.invalidate();
    this.needsRender = true;
  }
  setFxMode(mode) {
    mode = mode === 'simple' ? 'simple' : 'game';
    this.fxSel.value = mode;
    store(FX_KEY, mode);
    const apply = ok => {
      const on = mode === 'game' && ok;
      this.fx.setEnabled(on);
      this.effects.realFx = on;              // no marker spheres for explosions / smoke
      this.actors.realFlash = on;            // no muzzle flash sphere
      if (!ok) this.fxSel.parentNode.title = 'The effects are not exported (tools/export/fx_export.py)';
      this.R.invalidate(); this.needsRender = true;
    };
    if (mode === 'game') this.fx.load().then(apply); else apply(true);
  }
  setPropsMode(mode) {
    if (!this.props) return;
    this.propsSel.value = this.props.setMode(mode);
    store(PROPS_KEY, mode);
    this.shadows.invalidate();                 // the props occlude (shadows.js)
    this.updateHint();
    this.needsRender = true;
  }
  updateHint() {
    const w = this.world;
    if (!w) return;
    const k = n => (n / 1000).toFixed(0) + 'k';
    const p = this.props;
    const propsText = !p ? 'no props exported' : p.mode === 'off' ? 'props off' : p.instanceCount + ' props (' + p.modelCount + ' models' +
      (p.fallbackModels.length ? ', ' + p.fallbackModels.length + ' as boxes' : '') + ')';
    this.info.set('Map: ' + this.mapName + ' (' + k(w.info.triangleCount) + ' world triangles, ' + propsText + '; loaded in ' +
      (w.worldMs / 1000).toFixed(1) + ' s). Extracted from the game files (' + (w.info.archive || 'iwd') + ').' +
      (this.mapName !== this.M.d.meta.map ? ' Using ' + this.mapName + ' for ' + this.M.d.meta.map + '.' : ''));
  }
  resetView() {
    const M = this.M, b = M.bbox;
    if (this.cams.mode !== 'orbit') this.setMode('orbit');
    if (b) this.cams.frame({ mins: [b.minX, b.minY, M.zRange[0]], maxs: [b.maxX, b.maxY, M.zRange[1]] });
  }
  capturesKeys(e) {
    if (!this.visible) return false;
    if (e.code === 'KeyC') { const i = MODES.findIndex(m => m[0] === this.cams.mode); this.setMode(MODES[(i + 1) % MODES.length][0]); return true; }
    if (e.code === 'KeyX') { const i = XRAY_MODES.findIndex(m => m[0] === this.xrayMode); this.setXray(XRAY_MODES[(i + 1) % XRAY_MODES.length][0]); return true; }
    return this.cams.captureKey(e);
  }

  /* ---------- show / hide / size ---------- */
  show() {
    this.visible = true; this.stage.hidden = false; this.resize(); this.needsRender = true; this.last = null; requestAnimationFrame(this.loop);
    if (this.sounds && this.soundWanted && this.sounds.ctx) this.setSound(true);
  }
  hide() { this.visible = false; this.stage.hidden = true; if (this.sounds && this.sounds.enabled) this.sounds.enable(false); }
  resize() {
    if (this.exporting) return;
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.w = r.width; this.h = r.height;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /* ---------- per playback frame ---------- */
  draw(t) {
    this.t = t;
    const R = this.R;
    this.actors.update(t, { shown: R.shownPlayers(), focus: R.focus, hover: R.hover, labels: R.opts.labels || this.xrayMode === 'names', lastKnown: R.opts.lastKnown });
    this.effects.update(t, R);
    // the destroyed bomb-site target after its bomb exploded, until the next round
    if (this.exploders) {
      const b = this.M.bombAt(t);
      if (this.exploders.set(b && b.state === 'exploded' ? b.site : null)) this.shadows.invalidate();
    }
    this.aimTurrets(t);
    this.killfeed.update(t);
    this.needsRender = true;
  }

  /** the mounted MGs' guns as the demo has them aimed at t (the last sample, interpolated to the next one when
   *  it is close; before the first sample: the first) */
  aimTurrets(t) {
    for (const a of this.turretAims || []) {
      const T = a.track;
      let lo = 0, hi = T.t.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (T.t[m] <= t) lo = m + 1; else hi = m; }
      const i = Math.max(0, lo - 1);
      let pitch = T.pitch[i], yaw = T.aimYaw[i];
      if (lo > 0 && i + 1 < T.t.length && T.t[i + 1] - T.t[i] <= 200) {
        const f = (t - T.t[i]) / (T.t[i + 1] - T.t[i]);
        pitch += (T.pitch[i + 1] - pitch) * f;
        yaw += ((((T.aimYaw[i + 1] - yaw) % 360) + 540) % 360 - 180) * f;
      }
      if (pitch !== a.pitch || yaw !== a.yaw) { a.pitch = pitch; a.yaw = yaw; a.prop.aim(pitch, yaw); }
    }
  }

  /** the player the follow / first-person camera uses: the selection, else the POV's followed player */
  cameraTarget() {
    const M = this.M, t = this.t;
    const cl = this.R.focus != null ? this.R.focus : M.followedAt(t);
    const s = cl != null ? M.sampleAt(cl, t) : null;
    if (!s || s.age > CFG.STALE_MS) return { cl, target: null };
    const pos = new THREE.Vector3(s.x, s.y, s.z);
    return { cl, target: { pos, eye: new THREE.Vector3(s.x, s.y, s.z + EYE[stanceOf(s)]), yaw: s.yaw, pitch: s.pitch } };
  }

  loop(now) {
    if (!this.visible) return;
    requestAnimationFrame(this.loop);
    if (this.exporting) { this.last = null; return; }
    const dt = this.last == null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.xrayMode === 'names' && this.xray.poll()) this.needsRender = true;     // (a name badge changed)
    this.renderFrame(dt, dt);
    if (this.sounds && this.sounds.enabled) this.sounds.update(this.t || 0, this.camera, this.R.pb);
  }

  /** move the camera by dt (s), then render if anything changed (force: always); shadowDt is unused
   *  here (cod4-demo3d's shadow fades - the same signature for exportVideo3d.js) */
  renderFrame(dt, shadowDt, force = false) {
    const mode = this.cams.mode;
    let hideClient = null;
    if (mode === 'follow' || mode === 'fp') {
      const { cl, target } = this.cameraTarget();
      if (this.cams.tick(dt, target)) this.needsRender = true;
      const name = cl != null ? this.M.name(cl) : null;
      const msg = !target ? (name ? name + ' is not visible at this time (dead or not sent by the server)' : 'Select a player to follow') : null;
      const text = msg || (mode === 'fp' ? 'First person: ' + name : 'Following ' + name + ' · drag to turn around them');
      if (this.camHint.textContent !== text) {
        this.camHint.textContent = text;
        if (msg) holdHint(this.camHint); else fadeHint(this.camHint);
      }
      if (mode === 'fp' && target) { hideClient = cl; this.actors.hide(cl); }
    } else if (this.cams.tick(dt, null)) this.needsRender = true;
    if (!this.needsRender && !force) return false;
    this.needsRender = false;
    this.camera.updateMatrixWorld();
    this.fx.update(this.t || 0, this.camera);
    if (this.shadows.enabled) {
      const occluders = [this.world && this.world.group, this.props && this.props.mode !== 'off' && this.props.group].filter(Boolean);
      this.shadows.update(this.renderer, this.scene, [this.actors.root], occluders, this.shadowCenter(), this.sun.position);
    }
    this.renderer.render(this.scene, this.camera);
    if (this.xrayMode !== 'off') this.xray.render(this.scene, this.camera, this.actors.xrayTargets(hideClient));
    this.actors.setXrayHidden(this.xrayMode === 'names' ? this.xray.hidden() : null);
    if (!this.exporting) {
      this.actors.projectLabels(this.camera, this.w, this.h, hideClient);
      this.effects.projectLabels(this.camera, this.w, this.h);
    }
    return { hideClient };
  }

  /** the point the shadow map is centred on: what the orbit / follow camera looks at, else 600 units ahead */
  shadowCenter() {
    const m = this.cams.mode;
    if (m === 'orbit' || m === 'follow') return this.cams.orbit.target;
    return this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(600).add(this.camera.position);
  }

  /** the sound system under the name the video export uses (exportVideo3d.js: view.sound) */
  get sound() { return this.sounds; }

  /* ---------- video export (exportVideo3d.js, loaded on first use) ---------- */
  exportVideo() {
    import('./exportVideo3d.js').then(m => m.openExport(this)).catch(err => { console.error(err); alert('The video export could not be loaded: ' + err.message); });
  }

  destroy() {
    this.visible = false;
    this.offFocus();
    this.actors.dispose();
    this.effects.dispose();
    this.fx.dispose();
    this.shadows.dispose();
    this.xray.dispose();
    this.killfeed.dispose();
    this.cams.dispose();
    if (this.sky) { this.sky.dispose(); this.sky = null; }
    if (this.sounds) { this.sounds.dispose(); this.sounds = null; }
    if (this.offArm) this.offArm();
    // (the module-level hook and shared textures would keep this view and its demo in memory)
    if (textureArrivals.onArrive === this.onArrive) textureArrivals.onArrive = null;
    releaseStandins();
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.stage.remove();
  }
}
