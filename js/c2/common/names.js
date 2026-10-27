/* Display names of maps and game types. The maps come from the map registry
 * (assets/maps/maps.js, C2.maps) - there is no second map list here. */
C2.define('names', function (C2) {
  'use strict';
  const GAMETYPES = {
    sd: 'Search & Destroy', tdm: 'Team Deathmatch', dm: 'Deathmatch', ctf: 'Capture the Flag',
    hq: 'Headquarters', htf: 'Hold the Flag', re: 'Retrieval', strat: 'Strat (practice)'
  };

  /** 'mp_toujane_x' -> key 'mp_toujane' (see C2.maps.resolve: exact name, alias, longest prefix) */
  function mapKey(raw) {
    return C2.maps ? C2.maps.resolve(raw) : null;
  }

  /** display name from the map registry; unknown maps: "mp_some_map" -> "Some Map" */
  function mapDisplay(raw) {
    const k = mapKey(raw);
    if (k) return C2.maps.MAPS[k].display;
    return String(raw || '').replace(/^mp_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function gametypeDisplay(raw) {
    return GAMETYPES[String(raw || '').toLowerCase()] || String(raw || '');
  }

  C2.names = { mapKey, mapDisplay, gametypeDisplay, GAMETYPES };
});
