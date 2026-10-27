/* App shell: file loading (worker), the app facade the shared UI modules expect, the 2D/3D
 * toggle, the rail of view options with its popovers, the drawer, the match-details overlay and
 * keyboard shortcuts. One Replay (shared state) per demo. */
import { Match } from './match.js';
import { Replay } from './replay.js';
import { View2D } from '../view2d/view2d.js';
import { InfoHint } from './infoHint.js';
import '../c2/ui/killfeed.js';           // C2.killfeed: the kill feed of the 3D view and of both video exports

const C2 = window.C2;
const { el, clear, coloured, teamClass, icon } = C2.ui;
const $ = id => document.getElementById(id);
const VIEW_KEY = 'cod2demo3d.view';
const DRAWER_KEY = 'cod2demo3d.drawer';      // 'open' / 'closed' and '.teams' / '.feed' ('closed': section folded)

const state = { data: null, fileInfo: null, worker: null, loadId: 0, replay: null, view: '2d', rendered: new Set(), detailsTab: 'scoreboard' };
try { const v = localStorage.getItem(VIEW_KEY); if (v === '2d' || v === '3d') state.view = v; } catch (err) { /* storage blocked */ }

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---- app facade (used by the UI modules: scoreboard, rounds, chat, events, popups) ---- */
const app = {
  get data() { return state.data; },
  playerNode(cl, opts = {}) {
    const d = state.data;
    if (cl == null) return C2.ui.na('unknown player');
    if (cl === 1022) return el('span', { class: 'player dim', title: 'the world (map, falling, trigger)' }, 'World');
    if (cl >= 64) return el('span', { class: 'player dim', title: 'a non-player entity (e.g. an exploding car)' }, 'Entity ' + cl);
    const p = d.players.find(x => x.client === cl);
    if (!p) return el('span', { class: 'player dim' }, 'Client ' + cl);
    const node = coloured(p.name, 'player ' + teamClass(opts.team || p.team));
    if (opts.plain) node.querySelectorAll('span').forEach(s => { s.className = ''; });
    return node;
  },
  playerLabel(cl) {
    if (cl === 1022) return 'World';
    const p = state.data.players.find(x => x.client === cl);
    return p ? p.cleanName : (cl >= 64 ? 'Entity ' + cl : 'Client ' + cl);
  },
  team(key) { return state.data.teams.find(t => t.key === key); },
  teamName(key) {
    if (key === 'spectator') return 'Spectators';
    const t = app.team(key);
    return t ? t.name : key;
  },
  get fileBase() { return ((state.fileInfo && state.fileInfo.name) || 'demo').replace(/\.dm_1$/i, ''); },
  download(fileName, text, type = 'application/json') {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: fileName });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },
  teamColor(key) {
    if (key !== 'A' && key !== 'B') return cssVar('--spec');
    return cssVar(key === state.blueTeam ? '--team-blue' : '--team-red');
  },
  get blueTeam() { return state.blueTeam; },
  /** from the details tabs: close the overlay and jump to 2 s before t */
  gotoMap(t, roundIndex) {
    showDetails(false);
    if (state.replay) state.replay.gotoEvent(Math.max(0, t - 2000), roundIndex);
  }
};
C2.app = app;

/** the POV's team is blue, the other red (spectator POV: the team shown first) */
function applyTeamColors(data) {
  const pov = data.players.find(p => p.isPov);
  const shown = data.teams.filter(t => data.players.some(p => p.team === t.key));
  const blue = pov && (pov.team === 'A' || pov.team === 'B') ? pov.team : ((shown[0] || data.teams[0] || {}).key || 'B');
  state.blueTeam = blue;
  const root = document.documentElement.style;
  for (const key of ['A', 'B']) {
    const c = key === blue ? 'blue' : 'red', k = key.toLowerCase();
    root.setProperty('--team-' + k, 'var(--team-' + c + ')');
  }
}

/* ---- loading ---- */
async function load(file) {
  $('error').hidden = true;
  clear($('warnings'));
  closePop();
  $('viewer').hidden = true;
  for (const id of ['export-btn', 'details-btn', 'view-toggle']) $(id).hidden = true;
  document.body.classList.remove('loaded');
  if (state.replay) { state.replay.destroy(); state.replay = null; }
  $('dropzone').hidden = true;
  $('progress').hidden = false;
  $('progress-label').textContent = 'Reading ' + file.name + ' …';
  setProgress(0);
  $('file-name').textContent = file.name;
  if (!/\.dm_1$/i.test(file.name)) console.warn('File does not end in .dm_1 - trying anyway.');
  state.fileInfo = { name: file.name, size: file.size, lastModified: file.lastModified };
  const loadId = ++state.loadId;
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (err) { return fail('The file could not be read: ' + err.message); }
  $('progress-label').textContent = 'Parsing ' + file.name + ' (' + (file.size / 1e6).toFixed(1) + ' MB) …';
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  const worker = C2.createParserWorker();
  if (!worker) return parseMainThread(buffer, loadId);
  state.worker = worker;
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'progress') setProgress(m.value);
    else if (m.type === 'done') { worker.terminate(); state.worker = null; finish(m.data, loadId); }
    else if (m.type === 'error') { worker.terminate(); state.worker = null; failDemo(m.message, m.invalid, m.stack); }
  };
  worker.onerror = e => {
    e.preventDefault();
    worker.terminate();
    state.worker = null;
    console.warn('Worker failed, parsing on the main thread instead.', e.message);
    parseMainThread(buffer, loadId);
  };
  worker.postMessage({ buffer, fileInfo: state.fileInfo }, [buffer]);
}

function parseMainThread(buffer, loadId) {
  $('progress-label').textContent += ' (main thread - the page may freeze briefly)';
  setTimeout(() => {
    let data;
    try { data = C2.analyzeDemo(new Uint8Array(buffer), state.fileInfo, setProgress); }
    catch (err) { return failDemo(err.message, err instanceof C2.demo.DemoError, err.stack); }
    finish(data, loadId);
  }, 30);
}

function finish(data, loadId) {
  if (loadId !== state.loadId) return;
  if (!data.positions || !Object.keys(data.positions).length) {
    return fail('The demo was read, but it contains no player positions - nothing to replay. ' +
      'The demo may be damaged or recorded with an unsupported protocol (' + (data.meta.protocolLabel || 'unknown') + ').');
  }
  show(data);
}

/** the parser's error: invalid - not a (readable) CoD2 demo, a matter of the file (a warning in the
 *  console); otherwise a failure of the analysis (the stack as an error) */
function failDemo(message, invalid, stack) {
  if (invalid) console.warn('Not loaded: ' + message);
  fail(message, invalid ? null : stack, invalid ? 'Unsupported or invalid demo:' : 'The demo could not be analysed:');
}

function fail(message, stack, title = 'Error:') {
  if (stack) console.error(stack);
  $('progress').hidden = true;
  $('dropzone').hidden = false;
  const box = $('error');
  clear(box).append(el('strong', null, title + ' '), message);
  box.hidden = false;
}

function setProgress(v) { $('progress-fill').style.width = Math.round(v * 100) + '%'; }

/* ---- showing a demo ---- */
function show(data) {
  state.data = data;
  applyTeamColors(data);
  $('progress').hidden = true;
  $('dropzone').hidden = false;
  document.body.classList.add('loaded');
  // the warnings as toasts under the score pill, each one dismissible
  const warn = $('warnings');
  for (const w of data.warnings) {
    const toast = el('div', { class: 'toast banner-warn' }, el('span', null, w));
    toast.append(el('button', { class: 'ib x-btn', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => toast.remove() }, icon('x', 's')));
    warn.append(toast);
  }
  state.info = el('div', { class: 'ov-info' });
  C2.tabs.overview.render($('overview'), app, state.info);
  $('viewer').hidden = false;
  for (const id of ['export-btn', 'details-btn', 'view-toggle']) $(id).hidden = false;
  state.rendered.clear();
  for (const id of ['tab-scoreboard', 'tab-rounds', 'tab-chat', 'tab-events']) clear($(id));
  showDetails(false);

  const match = new Match(data, app);
  const replay = new Replay(match, app, { viewport: $('viewport'), controls: $('controls'), teams: $('teams'), feed: $('feed'), head: $('drawer-head') });
  $('drawer-head').append(el('button', { class: 'ib', title: 'Hide the panel', 'aria-label': 'Hide panel', onclick: () => setDrawer(false) }, icon('panel')));
  state.replay = replay;
  window.cod2 = { replay, match, data };            // debugging handle
  replay.addView(new View2D(replay, $('viewport')));
  // deep link: ?view=2d|3d&t=<match time in seconds>&focus=<player name>
  const q = new URLSearchParams(location.search);
  if (q.get('t') != null) replay.seek(Number(q.get('t')) * 1000);
  if (q.get('focus')) { const p = data.players.find(x => x.cleanName.toLowerCase().includes(q.get('focus').toLowerCase())); if (p) replay.setFocus(p.client); }
  setView(q.get('view') === '3d' || q.get('view') === '2d' ? q.get('view') : state.view);
}

/* ---- 2D / 3D toggle (the 3D module and three.js load on first use) ---- */
let view3dModule = null;
/** where the import map loads 'three' from (vendor/three, or a CDN if the page was changed to one) */
function threeSource() {
  try { return JSON.parse(document.querySelector('script[type=importmap]').textContent).imports.three; } catch (err) { return 'three'; }
}
/** the 3D view's start, in three steps that fail for different reasons: the libraries (three.js and
 *  its addon), the view's own modules, and creating the view. Only the first is a network / file
 *  matter; the others name the real error. The full error goes to the console. -> error text or null */
async function load3d(R) {
  if (!view3dModule) {
    try {
      await Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]);
    } catch (err) {
      console.error('three.js could not be loaded from ' + threeSource() + ':', err);
      return 'The 3D view needs three.js, which could not be loaded from ' + threeSource() + ' (' + err.message + '). ' +
        (/^https?:/.test(threeSource()) ? 'Check the network connection to the CDN.' : 'Check that the vendor/ folder is served with the page.');
    }
    try {
      view3dModule = await import('../view3d/view3d.js');
    } catch (err) {
      console.error('3D view modules:', err);
      return 'The 3D view failed to load its code: ' + err.message;
    }
  }
  if (state.replay !== R) return null;
  try {
    R.addView(new view3dModule.View3D(R, $('viewport')));
  } catch (err) {
    console.error('3D view:', err);
    for (const s of $('viewport').querySelectorAll('.view3d')) s.remove();   // what the failed start left
    return 'The 3D view failed to start: ' + err.message;
  }
  return null;
}
async function setView(key) {
  const R = state.replay;
  if (!R) return;
  $('view-error').hidden = true;
  if (key === '3d' && !R.views['3d']) {
    const error = await load3d(R);
    if (state.replay !== R) return;
    if (error) {
      showViewError(error.replace(/([^.])$/, '$1.') + ' Details are in the browser console; the 2D view is shown instead.');
      key = '2d';
    }
  }
  state.view = key;
  try { localStorage.setItem(VIEW_KEY, key); } catch (err) { /* not stored */ }
  for (const b of $('view-toggle').querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === key);
  document.body.dataset.view = key;
  R.setView(key);
  renderRail();
}

function showViewError(text) {
  const box = $('view-error');
  box.textContent = text;
  box.hidden = false;
}

/* ---- the rail: the view options as icon buttons, each with a popover (one open at a time) ----
 * panels: {key, title, hint, icon, node} - the Layers panel of the replay (both views) and the active
 * view's own (2D: the heatmap, which brings its own button and popover: custom; 3D: Camera, Display);
 * the info popover (match facts, map details, shortcuts) at the end. */
const rail = { open: null, pops: [] };
function renderRail() {
  const R = state.replay, box = $('rail');
  closePop();
  clear(box);
  for (const p of rail.pops) p.remove();
  rail.pops = [];
  rail.custom = null;
  const panels = [R.layersPanel, ...((R.view && R.view.panels) || [])];
  for (const p of panels) addRailItem(p);
  box.append(el('hr'));
  addRailItem({ key: 'info', title: 'Match info', hint: 'and shortcuts', icon: 'info', node: el('div', { class: 'pop-body' }), fill: fillInfo });
  R.exportBtn.hidden = !(R.view && R.view.exportVideo);
}

function addRailItem(p) {
  const box = $('rail');
  if (p.custom) {                                      // (its own button and popover: heatPanel.js)
    box.append(p.custom.button);
    rail.custom = p.custom;
    return;
  }
  const pop = el('div', { class: 'pop glass pop-' + p.key, role: 'dialog', 'aria-label': p.title, hidden: true },
    el('h4', null, p.title, p.hint ? el('span', null, p.hint) : null));
  // the Layers popover: the active view's extra groups (2D: the map background)
  const R = state.replay;
  pop.append(p.node);
  if (p.key === 'layers' && R.view && R.view.layerExtras) pop.append(R.view.layerExtras);
  const btn = el('button', { class: 'ib', title: p.title, 'aria-label': p.title, 'aria-expanded': 'false', onclick: () => (rail.open && rail.open.btn === btn ? closePop() : openPop(btn, pop, p)) }, icon(p.icon));
  box.append(btn);
  $('viewport').append(pop);
  rail.pops.push(pop);
}

function openPop(btn, pop, p) {
  closePop();
  if (rail.custom && rail.custom.close) rail.custom.close();
  if (p.fill) p.fill(p.node);
  pop.hidden = false;
  btn.classList.add('on');
  btn.setAttribute('aria-expanded', 'true');
  rail.open = { btn, pop, p };
}
function closePop() {
  const o = rail.open;
  if (!o) return;
  o.pop.hidden = true;
  o.btn.classList.remove('on');
  o.btn.setAttribute('aria-expanded', 'false');
  rail.open = null;
}
// a click outside the open popover (and its button) or Escape closes it
document.addEventListener('mousedown', e => { const o = rail.open; if (o && !o.pop.contains(e.target) && !o.btn.contains(e.target)) closePop(); }, true);
// the info popover follows the map details while open (loading progress, warnings)
InfoHint.onChange = () => { const o = rail.open; if (o && o.p.key === 'info') fillInfo(o.p.node); };

/** the info popover: the match facts (overview.js), the active view's map details, the shortcuts */
function fillInfo(node) {
  const R = state.replay, v = R && R.view;
  const keys = [['Space', 'Play / pause'], ['← / →', '5 s back / forward'], ['V', 'Switch 2D / 3D'], ['I / O', 'Export range start / end'], ['Esc', 'Close a dialog']];
  if (v && v.key === '2d') keys.push(['Q / E', 'Rotate the map'], ['Wheel / drag', 'Zoom / pan, double-click: reset']);
  if (v && v.key === '3d') keys.push(['C', 'Cycle the camera'], ['X', 'X-Ray: off / player / player + name'], ['W A S D, R / F', 'Free camera: move, up / down']);
  const text = v && v.info ? v.info.text : '';
  node.replaceChildren(state.info,
    text ? el('div', { class: 'grp' }, el('h4', null, v.key === '2d' ? 'Map image' : 'Map data'), el('p', { class: 'info-text' + (v.info.warn ? ' warn' : '') }, text)) : '',
    el('div', { class: 'grp' }, el('h4', null, 'Shortcuts'),
      el('dl', { class: 'keys' }, keys.map(([k, what]) => [el('dt', null, el('kbd', null, k)), el('dd', null, what)]))));
}

/* ---- the drawer (teams, kill feed): hidden / shown, its sections folded; remembered ---- */
function setDrawer(open) {
  $('viewport').classList.toggle('drawer-off', !open);
  $('drawer').hidden = !open;
  $('drawer-open').hidden = open;
  try { localStorage.setItem(DRAWER_KEY, open ? 'open' : 'closed'); } catch (err) { /* not stored */ }
}
function setSection(sec, open) {
  sec.classList.toggle('closed', !open);
  sec.querySelector('.sec-h').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem(DRAWER_KEY + '.' + sec.id.replace('sec-', ''), open ? 'open' : 'closed'); } catch (err) { /* not stored */ }
}

/* ---- match details overlay (scoreboard, rounds, chat, events) ---- */
function showDetails(open) {
  $('details').hidden = !open;
  $('details-btn').classList.toggle('active', open);
  if (open) showTab(state.detailsTab);
}
function showTab(key) {
  state.detailsTab = key;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === key);
  for (const p of document.querySelectorAll('.details .tab-panel')) p.classList.toggle('active', p.id === 'tab-' + key);
  if (!state.data || state.rendered.has(key)) return;
  const panel = $('tab-' + key);
  clear(panel);
  try { C2.tabs[key].render(panel, app); }
  catch (err) { console.error(err); panel.append(el('div', { class: 'banner banner-error' }, 'This tab could not be rendered: ' + err.message)); }
  state.rendered.add(key);
}

/* ---- export ---- */
function exportJson() {
  const d = state.data;
  if (!d) return;
  const out = Object.assign({}, d, { positions: '(omitted)' });
  app.download(app.fileBase + '.json', JSON.stringify(out, null, 1));
}

/* ---- wiring ---- */
function init() {
  // the icons of the static markup
  $('details-btn').append(icon('chart'));
  $('export-btn').append(icon('json'));
  $('open-icon').replaceWith(icon('folder', 's'));
  $('drop-icon').append(icon('upload'));
  $('details-close').append(icon('x'));
  $('drawer-open').append(icon('panel'));
  $('drawer-open').addEventListener('click', () => setDrawer(true));
  const stored = key => { try { return localStorage.getItem(key); } catch (err) { return null; } };
  setDrawer(stored(DRAWER_KEY) !== 'closed');
  for (const sec of document.querySelectorAll('.drawer .sec')) {
    sec.querySelector('.sec-h').append(icon('chev', 's'));
    sec.querySelector('.sec-h').addEventListener('click', () => setSection(sec, sec.classList.contains('closed')));
    if (stored(DRAWER_KEY + '.' + sec.id.replace('sec-', '')) === 'closed') setSection(sec, false);
  }
  const onFiles = files => { if (files && files[0]) load(files[0]); };
  $('file-input').addEventListener('change', e => { onFiles(e.target.files); e.target.value = ''; });
  $('file-input-2').addEventListener('change', e => { onFiles(e.target.files); e.target.value = ''; });
  $('export-btn').addEventListener('click', exportJson);
  $('details-btn').addEventListener('click', () => showDetails($('details').hidden));
  $('details-close').addEventListener('click', () => showDetails(false));
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  for (const b of $('view-toggle').querySelectorAll('button')) b.addEventListener('click', () => setView(b.dataset.view));
  let depth = 0;
  const isFile = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (!isFile(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', e => { if (isFile(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!isFile(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', e => {
    if (!isFile(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    onFiles(e.dataTransfer.files);
  });
  window.addEventListener('keydown', e => {
    const R = state.replay;
    if (!R) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' && document.activeElement.type !== 'checkbox' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Escape' && rail.open) { closePop(); return; }
    if (e.code === 'Escape' && !$('details').hidden) { showDetails(false); return; }
    if (!$('details').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (R.view && R.view.capturesKeys && R.view.capturesKeys(e)) return;
    if (e.code === 'Space') { e.preventDefault(); R.pb.toggle(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); R.pb.seek(R.pb.t - C2.mapConfig.SEEK_STEP_MS, -1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); R.pb.seek(R.pb.t + C2.mapConfig.SEEK_STEP_MS, 1); }
    else if (e.code === 'KeyV') { e.preventDefault(); setView(state.view === '2d' ? '3d' : '2d'); }
    else if (e.code === 'KeyI') { e.preventDefault(); R.setMark('a'); }
    else if (e.code === 'KeyO') { e.preventDefault(); R.setMark('b'); }
  });
  // optional: index.html?demo=<path of a .dm_1 file on this site> (served over http). Only the site's own
  // files: a link must not open someone else's file under the site's name (the CSP's connect-src agrees)
  const demoUrl = new URLSearchParams(location.search).get('demo');
  if (demoUrl) {
    let url = null;
    try { url = new URL(demoUrl, location.href); } catch (err) { /* not a URL */ }
    if (!url || url.origin !== location.origin) fail('?demo= opens only a demo file on this site (a path such as demos/my.dm_1).');
    else {
      fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(b => load(new File([b], decodeURIComponent(url.pathname.split('/').pop()) || 'demo.dm_1', { lastModified: Date.now() })))
        .catch(err => fail('Could not load ' + demoUrl + ': ' + err.message));
    }
  }
}
init();
