/* What the game type and the bomb explosions change on the map (export_maps.py tags the props and the
 * world's draw groups with it):
 * - gameobject: the entity's script_gameobjectname. The game type's script (maps/mp/gametypes/<type>.gsc ->
 *   _gameobjects.gsc, the same in stock CoD2 and zPAM) deletes such an entity at the map's start unless the
 *   type allows that name (the mounted MGs, the HQ / CTF / bomb-site props of the other modes). dm and tdm
 *   filter only on maps with S&D spawns (every MP map with tagged entities); an unknown type keeps all.
 * - exploder {site, show}: S&D - when the bomb at that site explodes, the game's exploder() shows the
 *   destroyed version (show) and deletes the intact one; the map restart of the next round undoes it. */
const ALLOWED = {
  dm: ['dm'], tdm: ['sd', 'bombzone'], sd: ['sd', 'bombzone', 'blocker'], strat: ['sd', 'bombzone'],
  ctf: ['ctf'], hq: ['tdm'], htf: ['tdm'], re: ['re', 'retrieval']
};

/** g_gametype -> (script_gameobjectname | undefined) -> kept by the game */
export function gameObjectFilter(gametype) {
  const allowed = ALLOWED[String(gametype || '').toLowerCase()];
  return name => !name || !allowed || allowed.includes(name);
}

/** a bomb site's label as the viewer writes it ('_a' -> 'A', mapLoader.js siteLabels) */
export const siteKey = s => String(s || '').replace(/^_/, '').toUpperCase();

/** the exploder parts of the world and the props, switched by the site whose bomb exploded */
export class Exploders {
  constructor() { this.parts = []; this.site = null; }
  /** show: the destroyed version (hidden until the explosion); apply(visible) */
  add(site, show, apply) {
    const p = { site: siteKey(site), show: !!show, apply };
    this.parts.push(p);
    apply(this.visible(p, this.site));
  }
  visible(p, site) { return p.site === site ? p.show : !p.show; }
  /** the site whose bomb exploded ('' / null: none) -> true when something changed */
  set(site) {
    site = site ? siteKey(site) : null;
    if (site === this.site) return false;
    const prev = this.site;
    this.site = site;
    let changed = false;
    for (const p of this.parts) {
      const v = this.visible(p, site);
      if (v !== this.visible(p, prev)) { p.apply(v); changed = true; }
    }
    return changed;
  }
}
