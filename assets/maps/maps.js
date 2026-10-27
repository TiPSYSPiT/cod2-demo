/* Map registry: display names of the CoD2 multiplayer maps and the raw names that stand for them.
 *
 * - key      = raw map name of the demo (config string 0, "mapname"), e.g. mp_toujane
 * - display  = display name (overview, export file names)
 * - stock    = one of Infinity Ward's 15 maps (the zPAM map pack versions are their own entries:
 *              their geometry differs)
 *
 * The 2D backgrounds (top-down render, zPAM radar) and their world rectangles are written by the map
 * export into assets/maps/backgrounds.js (C2.maps.BACKGROUNDS). JavaScript instead of JSON because
 * fetch() is blocked on file://. Registered with C2.define, so the analysis in the worker has the
 * display names as well.
 */
C2.define('maps', function (C2) {
  'use strict';
  const MAPS = {
    mp_breakout: { display: 'Villers-Bocage', stock: true },
    mp_brecourt: { display: 'Brecourt', stock: true },
    mp_burgundy: { display: 'Burgundy', stock: true },
    mp_carentan: { display: 'Carentan', stock: true },
    mp_dawnville: { display: 'St. Mere Eglise', stock: true },
    mp_decoy: { display: 'El Alamein', stock: true },
    mp_downtown: { display: 'Moscow', stock: true },
    mp_farmhouse: { display: 'Beltot', stock: true },
    mp_harbor: { display: 'Rostov', stock: true },
    mp_leningrad: { display: 'Leningrad', stock: true },
    mp_matmata: { display: 'Matmata', stock: true },
    mp_railyard: { display: 'Stalingrad', stock: true },
    mp_rhine: { display: 'Wallendar', stock: true },
    mp_toujane: { display: 'Toujane', stock: true },
    mp_trainstation: { display: 'Caen', stock: true },
    // zPAM map pack (zpam_maps_v7.iwd): fixed / rebalanced versions and community maps
    mp_breakout_tls: { display: 'Villers-Bocage (TLS)' },
    mp_burgundy_fix: { display: 'Burgundy (fix)' },
    mp_carentan_bal: { display: 'Carentan (balanced)' },
    mp_carentan_fix: { display: 'Carentan (fix)' },
    mp_chelm_fix: { display: 'Chelm (fix)' },
    mp_crossroads: { display: 'Crossroads' },
    mp_dawnville_fix: { display: 'St. Mere Eglise (fix)' },
    mp_dawnville_sun: { display: 'St. Mere Eglise (sun)' },
    mp_leningrad_mjr: { display: 'Leningrad (MJR)' },
    mp_leningrad_tls: { display: 'Leningrad (TLS)' },
    mp_matmata_fix: { display: 'Matmata (fix)' },
    mp_railyard_mjr: { display: 'Stalingrad (MJR)' },
    mp_toujane_fix: { display: 'Toujane (fix)' },
    mp_trainstation_bhg: { display: 'Caen (BHG)' },
    mp_trainstation_fix: { display: 'Caen (fix)' },
    mp_vallente_fix: { display: 'Vallente (fix)' },
    wawa_3daim: { display: '3D Aim (wawa)' }
  };
  // other raw names of a map (none known yet)
  const ALIASES = {};

  // (own keys only: a demo's map name "__proto__" or "constructor" is no map)
  const has = (o, k) => Object.hasOwn(o, k);
  /** raw map name -> registry key: exact name, alias, then the longest known prefix ("mp_toujane_x") */
  function resolve(raw) {
    const name = String(raw || '').toLowerCase();
    if (has(MAPS, name)) return name;
    if (has(ALIASES, name)) return ALIASES[name];
    let best = null;
    for (const k of Object.keys(MAPS)) if (name.startsWith(k + '_') && (!best || k.length > best.length)) best = k;
    return best;
  }
  /** registry entry of a raw map name, or null */
  function entry(raw) { const k = resolve(raw); return k ? Object.assign({ key: k }, MAPS[k]) : null; }

  const BACKGROUNDS = {};
  /** the 2D backgrounds of a raw map name: {key, topdown, radar} (each {image, rect: [minX, minY, maxX,
   *  maxY], rotation}) - the map's own export, else the registry key's; null when none is exported */
  function backgrounds(raw) {
    const name = String(raw || '').toLowerCase();
    const k = has(BACKGROUNDS, name) ? name : resolve(name);
    return k && has(BACKGROUNDS, k) ? Object.assign({ key: k }, BACKGROUNDS[k]) : null;
  }

  C2.maps = { MAPS, ALIASES, resolve, entry, BACKGROUNDS, backgrounds, IMAGE_DIR: 'maps3d/' };
});
