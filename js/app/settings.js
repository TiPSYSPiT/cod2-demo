/* The version of the remembered settings: a version step drops the keys whose meaning or default changed, once
 * per storage, so that the new defaults apply; every other remembered setting stays.
 *   2: Kill icons removed (cod2demo3d.killIcons); the 2D dropped weapons, the low health, damage direction, stance
 *      and hints HUD parts default to off (trails were never remembered: their new default needs nothing)
 *   3: the zPAM match info HUD part and the shell casings default to off
 *   4: the view lines and the player rings (new switches, off by default; their keys never held anything before) */
const VERSION_KEY = 'cod2demo.settingsVersion';
const STEPS = [
  { version: 2,
    local: ['cod2demo3d.killIcons'],
    session: ['cod2demo.layer.items', 'cod2demo3d.hud.lowHealth', 'cod2demo3d.hud.damage', 'cod2demo3d.hud.stance', 'cod2demo3d.hud.hints'] },
  { version: 3,
    local: [],
    session: ['cod2demo3d.hud.matchinfo', 'cod2demo3d.casings'] },
  { version: 4,
    local: [],
    session: ['cod2demo3d.viewLines', 'cod2demo3d.rings'] }
];
export const SETTINGS_VERSION = STEPS[STEPS.length - 1].version;

/** bring localStorage and sessionStorage to the current version (before anything reads them) */
export function migrateSettings() {
  for (const [kind, name] of [['local', 'localStorage'], ['session', 'sessionStorage']]) {
    try {
      const store = window[name];
      const v = Number(store.getItem(VERSION_KEY)) || 1;
      if (v >= SETTINGS_VERSION) continue;
      for (const step of STEPS) if (step.version > v) for (const key of step[kind]) store.removeItem(key);
      store.setItem(VERSION_KEY, String(SETTINGS_VERSION));
    } catch (err) { /* storage blocked: nothing remembered */ }
  }
}
