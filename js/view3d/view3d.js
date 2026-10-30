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
import { Tracers } from './tracers.js';
import { PlayerSprites } from './sprites.js';
import { WorldItems } from './items.js';
import { MapMarks } from './mapMarks.js';
import { ModelBatches } from './modelBatch.js';
import { frameOf } from './actors.js';
import { CharacterLibrary } from './characters.js';
import { InfoHint, fadeHint, holdHint } from '../app/infoHint.js';
import { CookieShadows } from './shadows.js';
import { LightGrid } from './lightGrid.js';
import { gameObjectFilter, Exploders } from './gameObjects.js';
import { XRay, XRAY_MODES } from './xray.js';
import { ViewModel, FP_FOV } from './viewmodel.js';
import { Hud, HUD_PARTS } from './hud.js';

const C2 = window.C2;
const { el, icon, switchRow, selectRow } = C2.ui;
const CFG = C2.mapConfig;
const CAM_KEY = 'cod2demo3d.camera';
const PROPS_KEY = 'cod2demo3d.props';
const KILLFEED_KEY = 'cod2demo3d.killfeed';      // 'on' / 'off' (default on)
const KILL_ICONS_KEY = 'cod2demo3d.killIcons';    // 'on' / 'off' (default off)
const HEAD_ICONS_KEY = 'cod2demo3d.headIcons';    // 'on' / 'off' (default on): the game's head icons and talk balloons (session)
const TRACERS_KEY = 'cod2demo3d.tracers';         // 'on' / 'off' (default off): the bullet tracers (session)
const ENEMY_NAMES_KEY = 'cod2demo3d.enemyNames';  // 'on' / 'off' (default off): the names over enemies (session)
const ITEMS_KEY = 'cod2demo3d.items';             // 'on' / 'off' (default on): grenades in flight, dropped weapons (session)
const CASINGS_KEY = 'cod2demo3d.casings';         // 'on' / 'off' (default on): the shell casings (session)
const SHAKE_KEY = 'cod2demo3d.shake';             // 'on' / 'off' (default on): the camera shake in first person (session)
const FX_KEY = 'cod2demo3d.fx';                  // 'game' / 'simple'
const PLAYERS_KEY = 'cod2demo3d.players';        // 'simple' / 'models'
const SOUND_KEY = 'cod2demo3d.sound';            // 'on' / 'off' (default off) and '.volume'
const SHADOWS_KEY = 'cod2demo3d.shadows';        // 'on' / 'off' (default on)
const VIEWMODEL_KEY = 'cod2demo3d.viewmodel';    // 'on' / 'off' (default on): the first-person weapon
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
// the game's HUD in first person (hud.js): per part 'on' / 'off', remembered for the browser session
const HUD_KEY = 'cod2demo3d.hud.';
const HUD_TITLES = {
  compass: "The game's compass: turning with the view, the teammates, the objectives (bomb sites), enemies only while they fire",
  score: 'The team score as the server shows it (stock game or zPAM), updated live',
  killfeed: "The game's kill messages above the compass (killer, weapon icon, victim in the team colours) and \"You killed\" / \"Killed by\"",
  ammo: 'Clip and reserve ammo, red when low, and the weapon name after a switch (recording player only)',
  grenades: 'Frag and smoke grenades with their icons and counts (recording player only)',
  server: "The rest the server shows: zPAM's players left and info texts, timers, the game messages (recording player)",
  lowHealth: 'The red screen edges when the health is low, pulsing after a hit (recording player only)',
  health: "The health bar, for 2 s after a hit (the game's cg_drawHealth - off in the game; recording player only)",
  damage: 'Where the damage came from (arrows around the centre, 2 s) and the short red flash of a hit (recording player only)',
  stance: "The stance icon after a stance change and \"Prone Blocked\" (recording player only; zPAM's HUD has no stance icon)",
  hints: 'The use hints (plant / defuse the bomb, pick up a weapon) and the mantle hint, with the default keys (recording player only)',
  scoreboard: "The game's scoreboard while Tab is held and at the intermission (the last scores the server sent); zPAM's own scoreboard while the recording player had it open",
  matchinfo: "zPAM's match info at the top (teams, round, match time) as the recording player had it"
};

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
    // the bullet tracers (tracers.js), with the game effects
    this.tracers = new Tracers(scene, this.M);
    // the effects' model particles (shell casings, the burnt smoke grenade, debris) and the grenades in flight /
    // dropped weapons (items.js): the game's models, from the character library
    this.fx.modelBatches = new ModelBatches(scene, this.characters);
    this.items = new WorldItems(scene, this.M, this.characters);
    this.fx.brassOf = (cl, ts, t) => {
      // just fired: the gun as drawn now (the first-person view model, else the world model); later (a seek) as held then
      if (t - ts <= 120) {
        const m = cl === this.fpClient && this.viewmodel.shown ? this.viewmodel.brass(this.camera) : null;
        if (m) return frameOf(m);
        const b = this.actors.brass(cl);
        if (b) return b;
      }
      return this.actors.brassAt(cl, ts);
    };
    // the players' head icons and talk balloons (sprites.js)
    this.sprites = new PlayerSprites(scene, this.M);
    // the first-person weapon (viewmodel.js), its crosshair and scope
    this.viewmodel = new ViewModel();
    this.viewmodel.setMatch(this.M, k => (this.characters.animsInfo ? this.characters.animsInfo.table[k] || '' : null));
    this.viewmodel.onLoaded = () => { this.needsRender = true; };
    this.viewmodel.crosshair = true;              // (always in first person)
    // the game's HUD (hud.js): a canvas over the view, drawn after each first-person frame
    this.hud = new Hud();
    this.hud.setMatch(this.M);
    this.hudCanvas = el('canvas', { class: 'hud-layer' });
    this.stage.append(this.hudCanvas);
    this.hudInsets = null; this.hudInsetsAt = 0;
    // the game's scoreboard while Tab is held (first person: the game's +scores)
    this.onScoresKey = e => {
      if (e.code !== 'Tab' || !this.visible || this.cams.mode !== 'fp' || (e.target && e.target.closest && e.target.closest('input, textarea, select'))) return;
      e.preventDefault();
      const on = e.type === 'keydown';
      if (!!this.hud.showScores !== on) { this.hud.showScores = on; this.needsRender = true; }
    };
    this.offScoresKey = () => { this.hud.showScores = false; this.needsRender = true; };
    window.addEventListener('keydown', this.onScoresKey);
    window.addEventListener('keyup', this.onScoresKey);
    window.addEventListener('blur', this.offScoresKey);
    this.fx.muzzleOf = (cl, ts, t) => {
      // the first-person player's shot: the view flash at the view model's muzzle
      if (cl === this.fpClient && this.viewmodel.shown) {
        const mz = this.viewmodel.muzzle(this.camera), st = this.viewmodel.state;
        return mz ? Object.assign(mz, { weapon: st.weapon, flash: st.entry.strings.viewFlashEffect || null, view: true }) : null;
      }
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
    this.setHeadIcons(sessionGet(HEAD_ICONS_KEY) !== 'off');
    this.setTracers(sessionGet(TRACERS_KEY) === 'on');
    this.setEnemyNames(sessionGet(ENEMY_NAMES_KEY) === 'on');
    this.setItems(sessionGet(ITEMS_KEY) !== 'off');
    this.setCasings(sessionGet(CASINGS_KEY) !== 'off');
    this.setShake(sessionGet(SHAKE_KEY) !== 'off');
    let mode = 'orbit';
    const m0 = stored(CAM_KEY);
    if (MODES.some(m => m[0] === m0)) mode = m0;
    this.setMode(mode);
    this.setPlayersMode(stored(PLAYERS_KEY) === 'simple' ? 'simple' : 'models');
    this.setFxMode(stored(FX_KEY) === 'simple' ? 'simple' : 'game');
    this.setShadows(new URLSearchParams(location.search).get('shadows') !== 'off' && stored(SHADOWS_KEY) !== 'off');
    this.setViewModel(stored(VIEWMODEL_KEY) !== 'off');
    for (const [k, , def] of HUD_PARTS) { const v = sessionGet(HUD_KEY + k); this.setHudPart(k, v == null ? def : v === 'on'); }
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
        // the intermission camera and hurt triggers (Layers panel)
        if (this.mapMarks) this.mapMarks.dispose();
        this.mapMarks = new MapMarks(this.scene, w.entities);
        try { this.fx.probe = this.actors.probe = new LightProbe(w, w.lightScale); } catch (err) { console.warn('light probe:', err); }
        // the models' light: the map's light grid (lightGrid.js), when exported
        LightGrid.load('maps3d/' + name + '/', w.info).then(g => {
          if (!g || this.world !== w) return;
          g.apply();
          this.actors.grid = g;
          this.viewmodel.setGrid(g);
          this.fx.modelBatches.setGrid(g);
          this.items.setGrid(g);
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
    this.headIconsBox = el('input', { type: 'checkbox', onchange: e => this.setHeadIcons(e.target.checked, true) });
    this.tracersBox = el('input', { type: 'checkbox', onchange: e => this.setTracers(e.target.checked, true) });
    this.enemyNamesBox = el('input', { type: 'checkbox', onchange: e => this.setEnemyNames(e.target.checked, true) });
    this.itemsBox = el('input', { type: 'checkbox', onchange: e => this.setItems(e.target.checked, true) });
    this.casingsBox = el('input', { type: 'checkbox', onchange: e => this.setCasings(e.target.checked, true) });
    this.shakeBox = el('input', { type: 'checkbox', onchange: e => this.setShake(e.target.checked, true) });
    this.shadowsBox = el('input', { type: 'checkbox', onchange: e => this.setShadows(e.target.checked, true) });
    this.viewmodelBox = el('input', { type: 'checkbox', onchange: e => this.setViewModel(e.target.checked, true) });
    this.hudBoxes = {};
    for (const [k] of HUD_PARTS) this.hudBoxes[k] = el('input', { type: 'checkbox', onchange: e => this.setHudPart(k, e.target.checked, true) });
    this.panels = [
      { key: 'camera', title: 'Camera', hint: 'C cycles', icon: 'camera', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' }, this.modeSel,
          selectRow('Player', playerSel, 'Selected player (follow / first person); also click a player in the view or the team panel'),
          el('button', { class: 'tb wide', title: 'Back to the overview', onclick: () => this.resetView() }, icon('reset', 's'), 'Reset view')),
        el('div', { class: 'grp' }, el('h4', null, 'First person'),
          switchRow('Camera shake', this.shakeBox, { title: "The game's camera shake: near an earthquake of the scripts (the bomb's explosion) and on a mounted MG42 while it fires" }),
          switchRow('Weapon', this.viewmodelBox, { title: "The weapon in the player's hands, with the game's own view animations; aiming down the sights zooms as in the game (exact for the recording player, approximated for the others). The game's crosshair is always shown" })),
        el('div', { class: 'grp' }, el('h4', null, 'First person HUD'),
          ...HUD_PARTS.map(([k, label]) => switchRow(label, this.hudBoxes[k], { title: HUD_TITLES[k] })))) },
      { key: 'display', title: 'Display', hint: '3D only', icon: 'sliders', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' },
          selectRow('Players', this.playersSel, 'Player display: capsules, or the real character models (body, head and helmet from the demo, animated with the game\'s animations the demo sends)'),
          selectRow('X-Ray', this.xraySel, 'Living players behind walls and props as a silhouette in the team colour (key X); "Player + name" also shows every name, with a badge when the player is out of sight'),
          this.propsRow,
          selectRow('Effects', this.fxSel, 'Explosions, smoke grenades, bullet impacts and muzzle flashes: the game\'s own particle effects, or simple markers'),
          switchRow('Kill feed', this.killfeedBox, { title: 'The kills and bomb plants / defuses of the last ' + CFG.EXPORT.KILLFEED_MS / 1000 + ' s over the view, with the weapon icons' }),
          switchRow('Kill icons', this.killIconsBox, { title: 'The weapon icon over each death marker' }),
          switchRow('Bullet tracers', this.tracersBox, { title: "The game's bullet tracers as the server set them (cg_tracer*: zPAM gives every bullet one, 1000 units long at 20000 units/s; else 40 %, 160 units at 4500 units/s): a short streak flying from the muzzle, gone at the impact" }),
          switchRow('Enemy names', this.enemyNamesBox, { title: "The names over the enemies of the player you watch (first person) or select - the game never shows them (only a teammate's name under the crosshair); teammates' names follow Layers, Names. X-Ray Player + name shows every name" }),
          switchRow('Grenades and dropped weapons', this.itemsBox, { title: "The grenades in flight (their own model, spinning as the demo has it) and the weapons on the ground (a dying player drops his gun and a grenade), where the demo's entities have them" }),
          switchRow('Shell casings', this.casingsBox, { title: "The cases each shot ejects (bolt-action rifles and the shotgun: when the bolt is worked), the game's shell eject effect at the gun's ejection port; as in the game only near the camera (rifles 100 units, pistols 250)" }),
          switchRow('Head icons', this.headIconsBox, { title: "The game's icons over the players' heads: the team icon the server gives them, the talk balloon while a teammate talks (voice chat), the connection-problem icon. In first person as that player sees them (teammates only), in the other cameras all" }),
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
  setViewModel(on, user = false) {
    this.viewmodel.enabled = on;
    this.viewmodelBox.checked = on;
    if (user) store(VIEWMODEL_KEY, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setHudPart(k, on, user = false) {
    this.hud.parts[k] = on;
    this.hudBoxes[k].checked = on;
    if (user) sessionSet(HUD_KEY + k, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setShadows(on, user = false) {
    this.shadows.setEnabled(on);
    this.shadowsBox.checked = on;
    if (user) store(SHADOWS_KEY, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setHeadIcons(on, user = false) {
    this.sprites.enabled = on;
    this.headIconsBox.checked = on;
    if (user) sessionSet(HEAD_ICONS_KEY, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setItems(on, user = false) {
    this.items.setEnabled(on);
    this.itemsBox.checked = on;
    if (on) this.characters.load().then(() => this.R.invalidate());
    if (user) { sessionSet(ITEMS_KEY, on ? 'on' : 'off'); this.R.invalidate(); }
  }
  setShake(on, user = false) {
    this.shakeOn = on;
    this.shakeBox.checked = on;
    if (user) sessionSet(SHAKE_KEY, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setCasings(on, user = false) {
    this.fx.casings = on;
    this.casingsBox.checked = on;
    if (on) this.characters.load().then(() => { this.needsRender = true; });
    if (user) sessionSet(CASINGS_KEY, on ? 'on' : 'off');
    this.needsRender = true;
  }
  setEnemyNames(on, user = false) {
    this.enemyNames = on;
    this.enemyNamesBox.checked = on;
    if (user) { sessionSet(ENEMY_NAMES_KEY, on ? 'on' : 'off'); this.R.invalidate(); }
  }
  setTracers(on, user = false) {
    this.tracersOn = on;
    this.tracers.enabled = on;
    this.tracersBox.checked = on;
    if (user) sessionSet(TRACERS_KEY, on ? 'on' : 'off');
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
    // the enemies (no names unless Enemy names): of the player in first person, else of the selected one, else of the
    // player the demo's view follows; X-Ray's "Player + name" names everyone
    const ref = this.cams.mode === 'fp' && this.fpClient != null ? this.fpClient : R.focus != null ? R.focus : this.M.followedAt(t);
    this.actors.update(t, { shown: R.shownPlayers(), focus: R.focus, hover: R.hover, labels: R.opts.labels || this.xrayMode === 'names', lastKnown: R.opts.lastKnown,
      enemyOf: this.enemyNames || this.xrayMode === 'names' ? null : ref });
    this.effects.modelGrenades = this.items.update(t);
    this.effects.update(t, R);
    // the destroyed bomb-site target after its bomb exploded, until the next round
    if (this.exploders) {
      const b = this.M.bombAt(t);
      if (this.exploders.set(b && b.state === 'exploded' ? b.site : null)) this.shadows.invalidate();
    }
    this.aimTurrets(t);
    if (this.mapMarks) this.mapMarks.set(R.opts.mapCams, R.opts.hurt);
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
    const pos = new THREE.Vector3(s.x, s.y, s.z), eye = new THREE.Vector3(s.x, s.y, s.z + EYE[stanceOf(s)]);
    // first person as CG_CalcViewValues: the recording player's view height (viewHeightCurrent: the engine moves
    // it over a stance change; the others: their stance's), the view bob (up, and sideways along the view's
    // right), the lean (AddLeanToPosition: along the right vector of (0, yaw, 16 f), 20 f units, f =
    // GetLeanFraction), and the eye at least 8 units over the feet
    const va = this.cams.mode === 'fp' && this.viewmodel.anim;
    if (va) {
      eye.z = s.z + this.eyeHeight(va, cl, t, s);
      const b = va.viewBob(cl, t, s), y = s.yaw * Math.PI / 180;
      eye.x += Math.sin(y) * b.right; eye.y -= Math.cos(y) * b.right; eye.z += b.up;
      const f = (s.lean || 0) * (2 - Math.abs(s.lean || 0));
      if (f) {
        const r = 16 * f * Math.PI / 180, d = 20 * f;
        eye.x += Math.cos(r) * Math.sin(y) * d; eye.y -= Math.cos(r) * Math.cos(y) * d; eye.z -= Math.sin(r) * d;
      }
      // the recording player's landing dip and stair steps
      const dip = va.landDip(cl, t);
      if (dip != null) eye.z += dip;
      eye.z += this.stepSmoothing(va, cl, t);
      eye.z = Math.max(eye.z, s.z + 8);
      // the view's own motion (the refdef angles): the recorder's scope sway, the camera shake
      const out = { pos, eye, yaw: s.yaw, pitch: s.pitch, roll: 0 };
      const sw = va.viewSway(cl, t, n => this.viewmodel.entry(n));
      if (sw) { out.pitch += sw[0]; out.yaw += sw[1]; }
      const dk = va.damageKick(cl, t, n => this.viewmodel.entry(n));
      if (dk) { out.pitch += dk[0]; out.roll += dk[1]; }
      const sh = this.shakeOn ? this.shakeAt(t, eye) : null;
      if (sh) { out.pitch += sh[0]; out.yaw += sh[1]; out.roll += sh[2]; }
      return { cl, target: out };
    }
    return { cl, target: { pos, eye, yaw: s.yaw, pitch: s.pitch } };
  }

  loop(now) {
    if (!this.visible) return;
    requestAnimationFrame(this.loop);
    if (this.exporting) { this.last = null; return; }
    const dt = this.last == null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.xrayMode === 'names' && this.xray.poll()) this.needsRender = true;     // (a name badge changed)
    this.renderFrame(dt, dt);
    if (this.sounds && this.sounds.enabled) this.sounds.update(this.t || 0, this.camera, this.R.pb, this.fpClient);
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
      this.fpClient = mode === 'fp' && target ? cl : null;
    } else { this.fpClient = null; if (this.cams.tick(dt, null)) this.needsRender = true; }
    if (!this.needsRender && !force) return false;
    this.needsRender = false;
    // the first-person weapon at this time (before the effects: its muzzle flash) and the sights' zoom
    const fpSample = this.fpClient != null ? this.M.sampleAt(this.fpClient, this.t || 0) : null;
    this.viewmodel.update(this.fpClient != null ? this.fpClient : -1, this.t || 0, fpSample);
    if (mode === 'fp') {
      const fov = fpSample ? this.viewmodel.fov(FP_FOV) : FP_FOV;
      if (Math.abs(this.camera.fov - fov) > 1e-4) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
      // a player without a player state: is a teammate under the crosshair (the recorder's comes from the demo)
      const st = this.viewmodel.state;
      if (st && st.entry && !st.recorder) st.friend = this.teammateInSight(this.fpClient, st.entry.params.enemyCrosshairRange || 0);
    }
    this.camera.updateMatrixWorld();
    this.fx.update(this.t || 0, this.camera);
    this.tracers.update(this.t || 0, this.camera, cl => this.actors.muzzle(cl), this.fpClient);
    this.sprites.update(this.t || 0, this.camera, this.actors, this.fpClient);
    if (this.shadows.enabled) {
      const occluders = [this.world && this.world.group, this.props && this.props.mode !== 'off' && this.props.group].filter(Boolean);
      this.shadows.update(this.renderer, this.scene, [this.actors.root], occluders, this.shadowCenter(), this.sun.position);
    }
    this.renderer.render(this.scene, this.camera);
    if (this.xrayMode !== 'off') this.xray.render(this.scene, this.camera, this.actors.xrayTargets(hideClient));
    this.actors.setXrayHidden(this.xrayMode === 'names' ? this.xray.hidden() : null);
    if (this.fpClient != null) this.viewmodel.render(this.renderer, this.camera, FP_FOV, [this.hemi, this.sun], this.fx.viewRoot);
    if (!this.exporting) {
      this.actors.projectLabels(this.camera, this.w, this.h, hideClient);
      this.effects.projectLabels(this.camera, this.w, this.h);
      this.drawHud(fpSample);
    }
    return { hideClient, fpSample };
  }

  /** the camera shake at t for a view at eye (CG_StartShakeCamera / CG_ShakeCamera): the scripts' earthquakes (the
   *  bomb: scale 0.2, 2 s, radius 1200) and every shot of a mounted MG42 (0.05, 100 ms, radius 100 around the gun).
   *  Each fades as (1 - age / duration) x scale, its strength 1 - distance / radius (outside the radius negative); the
   *  strongest one turns pitch / yaw / roll by sin(T x 8 pi / 15 pi / 12 pi + phase) x 18 / 16 / 10 x its fade x
   *  min(1, strength), T = time / 600 ms; the game draws the phase anew while nothing shakes (here: from the start of
   *  the shaking, so a seek gives the same) -> [pitch, yaw, roll] (degrees) or null */
  shakeAt(t, eye) {
    let S = this.shakes;
    if (!S) {
      const d = this.M.d;
      S = (d.earthquakes || []).map(r => ({ t0: r[0], scale: r[1], dur: r[2], radius: r[3], pos: [r[4], r[5], r[6]] }))
        .concat((d.mgFire || []).map(r => ({ t0: r[0], scale: 0.05, dur: 100, radius: 100, pos: [r[1], r[2], r[3]] })));
      S.sort((a, b) => a.t0 - b.t0);
      S.maxDur = S.reduce((m, s) => Math.max(m, s.dur), 0);
      this.shakes = S;
    }
    if (!S.length) return null;
    let lo = 0, hi = S.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].t0 < t - S.maxDur) lo = m + 1; else hi = m; }
    let best = 0, fade = 0, first = -1;
    for (let i = lo; i < S.length && S[i].t0 <= t; i++) {
      const s = S[i], age = t - s.t0;
      if (age >= s.dur) continue;
      if (first < 0) first = i;
      const f = (1 - age / s.dur) * s.scale;
      if (f <= 0) continue;
      const v3 = 1 - Math.hypot(s.pos[0] - eye.x, s.pos[1] - eye.y, s.pos[2] - eye.z) / s.radius, v4 = v3 < 0 ? v3 / f : v3 * f;
      if (v4 > best) { best = v4; fade = f; }
    }
    if (best <= 0) return null;
    // the start of the shaking: back over the shakes that still ran when the next one began
    let start = S[first].t0;
    for (let j = first - 1, n = 0; j >= 0 && n < 500; j--, n++) { if (S[j].t0 + S[j].dur >= start) start = Math.min(start, S[j].t0); else break; }
    const ph = (((Math.imul(start | 0, 0x9E3779B1) >>> 0) / 4294967296) * 2 - 1) * Math.PI;
    const T = t / 600, k = fade * Math.min(1, best);
    return [Math.sin(8 * Math.PI * T + ph) * 18 * k, Math.sin(15 * Math.PI * T + ph) * 16 * k, Math.sin(12 * Math.PI * T + ph) * 10 * k];
  }

  /** the eye's height over the feet: the recording player's viewHeightCurrent at t (between two snapshots
   *  interpolated); the others' moves to the new stance's height as the game moves it (PM_GetViewHeightLerpTime:
   *  200 ms to standing and down to crouched, 400 ms to prone and up from prone; linear) */
  eyeHeight(va, cl, t, s) {
    const ri = va.recorderRow(cl, t), W = this.M.d.psWeapon;
    if (ri >= 0 && W && W.vh) { const vh = this.M.psLerp(ri, 'vh', t); if (vh > 0) return vh; }
    const P = this.M.d.positions[cl], i = s.i, PF = C2.collect.PF;
    const h = k => (P.flags[k] & PF.PRONE ? EYE.prone : P.flags[k] & PF.CROUCH ? EYE.crouch : EYE.stand);
    // the last stance change within 400 ms
    for (let k = i; k > 0 && t - P.t[k] < 400; k--) {
      const a = h(k - 1), b = h(k);
      if (a === b) continue;
      const dur = b === EYE.prone || a === EYE.prone ? 400 : 200;
      return a + (b - a) * Math.min(1, Math.max(0, (t - P.t[k]) / dur));
    }
    return h(i);
  }
  /** the recording player's stair steps spread over 100 ms (CG_EntityEvent EV_STEP_VIEW + CG_CalcViewValues: the eye
   *  keeps its height and follows the step within 100 ms - as the game does when played live; its demo playback
   *  does not). Between the two snapshots of a step the interpolated position already rises: that rise is held back
   *  too -> units added to the eye height */
  stepSmoothing(va, cl, t) {
    const S = va.viewEventsOf(cl).step;
    if (!S.t.length) return 0;
    let off = 0, lo = 0, hi = S.t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S.t[m] <= t) lo = m + 1; else hi = m; }
    const k = lo - 1;
    if (k >= 0 && t - S.t[k] < 100) off -= S.change[k] * (100 - (t - S.t[k])) / 100;
    if (lo < S.t.length) {
      const W = this.M.d.psWeapon, r = this.M.psRow(cl, S.t[lo]);
      const tp = r > 0 && W.client[r - 1] === cl ? W.t[r - 1] : S.t[lo] - 50;
      if (t > tp && S.t[lo] > tp) off -= S.raw[lo] * (t - tp) / (S.t[lo] - tp);
    }
    return off;
  }

  /** whether the game's HUD is drawn: first person, a part switched on */
  hudShown() { return this.fpClient != null && HUD_PARTS.some(([k]) => this.hud.parts[k]); }
  /** the game's HUD over the first-person view (hud.js), clear of the viewer's own controls; the viewer's kill feed
   *  gives way to the game's */
  drawHud(fpSample) {
    const cv = this.hudCanvas, on = this.hudShown() && !!fpSample;
    this.killfeed.box.style.visibility = on && this.hud.parts.killfeed ? 'hidden' : '';
    if (on && !this.hud.data) this.hud.load().then(ok => { if (ok) this.needsRender = true; });
    if (!on || !this.hud.data) { if (cv.width) { cv.width = 0; cv.height = 0; } return; }
    const dpr = this.renderer.getPixelRatio(), w = Math.round(this.w * dpr), h = Math.round(this.h * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; this.hudInsets = null; }
    const now = performance.now();
    if (!this.hudInsets || now - this.hudInsetsAt > 500) { this.hudInsets = this.uiInsets(dpr); this.hudInsetsAt = now; }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    this.hud.draw(g, w, h, this.t || 0, this.fpClient, { x: fpSample.x, y: fpSample.y, yaw: fpSample.yaw, pitch: fpSample.pitch,
      ads: this.viewmodel.zoomFrac() > 0.01 || this.viewmodel.overlayFrac() > 0 }, this.hudInsets);
  }
  /** the viewer's controls over the 3D canvas (rail, score, drawer, the playback bar) as the HUD's safe area: per
   *  control the canvas edge it hugs, inset past it (device pixels) */
  uiInsets(dpr) {
    const c = this.renderer.domElement.getBoundingClientRect(), ins = { l: 0, t: 0, r: 0, b: 0 }, gap = 8;
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

  /** a living teammate of client cl on the first-person camera's view axis within `range` units, not behind the
   *  world (the light grid's collision) - the approximation of the server's flag for the other players; each
   *  player an upright capsule of his stance's height */
  teammateInSight(cl, range) {
    const me = this.M.player(cl);
    if (!range || !me || (me.team !== 'A' && me.team !== 'B')) return false;
    const e = this.camera.position, d = this.camera.getWorldDirection(new THREE.Vector3());
    let best = null;
    for (const it of this.actors.items.values()) {
      if (it.cl === cl || !it.visible || !it.sample || it.sample.age > CFG.STALE_MS) continue;
      const p = this.M.player(it.cl);
      if (!p || p.team !== me.team) continue;
      const h = it.sample.prone ? 20 : it.sample.crouch ? 50 : 70;
      // the closest approach of the view ray to the capsule's axis (a vertical segment), sampled along its height
      for (let z = 6; z <= h; z += 8) {
        const vx = it.pos.x - e.x, vy = it.pos.y - e.y, vz = it.pos.z + z - e.z, along = vx * d.x + vy * d.y + vz * d.z;
        if (along <= 0 || along > range || (best && along >= best.along)) continue;
        if (Math.hypot(vx - d.x * along, vy - d.y * along, vz - d.z * along) < 14) { best = { along, x: e.x + d.x * along, y: e.y + d.y * along, z: e.z + d.z * along }; break; }
      }
    }
    const col = this.actors.grid && this.actors.grid.collision;
    return !!best && !(col && col.blocked(e.x, e.y, e.z, best.x, best.y, best.z));
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
    this.viewmodel.dispose();
    this.effects.dispose();
    this.fx.dispose();
    this.tracers.dispose();
    this.sprites.dispose();
    this.items.dispose();
    if (this.mapMarks) this.mapMarks.dispose();
    this.fx.modelBatches.dispose();
    this.shadows.dispose();
    this.xray.dispose();
    this.killfeed.dispose();
    this.cams.dispose();
    if (this.sky) { this.sky.dispose(); this.sky = null; }
    if (this.sounds) { this.sounds.dispose(); this.sounds = null; }
    if (this.offArm) this.offArm();
    window.removeEventListener('keydown', this.onScoresKey);
    window.removeEventListener('keyup', this.onScoresKey);
    window.removeEventListener('blur', this.offScoresKey);
    // (the module-level hook and shared textures would keep this view and its demo in memory)
    if (textureArrivals.onArrive === this.onArrive) textureArrivals.onArrive = null;
    releaseStandins();
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.stage.remove();
  }
}
