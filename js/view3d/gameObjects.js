/* What the game type and the bomb explosions change on the map (export_maps.py tags the props and the
 * world's draw groups with it):
 * - gameobject: the entity's script_gameobjectname. The game type's script (maps/mp/gametypes/<type>.gsc ->
 *   _gameobjects.gsc, the same in stock CoD2 and zPAM) deletes such an entity at the map's start unless the
 *   type allows that name (the mounted MGs, the HQ / CTF / bomb-site props of the other modes). dm and tdm
 *   filter only on maps with S&D spawns (every MP map with tagged entities); an unknown type keeps all.
 * - exploder {site, show}: S&D - when the bomb at that site explodes, the game's exploder() shows the
 *   destroyed version (show) and deletes the intact one; the map restart of the next round undoes it.
 * - scripted: what the map's own script does with an entity by its targetname - zPAM's map pack (maps/mp/_preload.gsc
 *   of zpam_maps_v7.iwd, run by its *_fix / _mjr / _tls / ... maps): "aimTrainer" (trainer_target, trainer_activator:
 *   the aim trainer's targets and its "Map supports Training" sign) deleted unless zPAM's aim trainer set itself up
 *   (_aim_trainer.gsc, zPAM 4.09), which deletes them in turn unless the server is in ready-up - the map restarts
 *   into each ready-up (the warm-up before the match, the half-time) -; "poster" (poster_small, poster_big) deleted
 *   unless zPAM's scr_posters is on (default off; the demos do not carry it). */
const ALLOWED = {
  dm: ['dm'], tdm: ['sd', 'bombzone'], sd: ['sd', 'bombzone', 'blocker'], strat: ['sd', 'bombzone'],
  ctf: ['ctf'], hq: ['tdm'], htf: ['tdm'], re: ['re', 'retrieval']
};

/** g_gametype -> (script_gameobjectname | undefined) -> kept by the game */
export function gameObjectFilter(gametype) {
  const allowed = ALLOWED[String(gametype || '').toLowerCase()];
  return name => !name || !allowed || allowed.includes(name);
}

/** the scripted parts' rule (above) for a demo: meta (DemoData.meta: zpamVersion, dvars) -> {visible(script,
 *  phase) -> bool, ever(script) -> bool}. An unknown script name is kept. */
export function scriptedRule(meta = {}) {
  const v = parseFloat(meta.zpamVersion), trainer = v >= 4.09;
  const posters = String((meta.dvars || {}).scr_posters || '0') === '1';
  const READY = new Set(['warmup', 'halftime']);
  return {
    visible: (script, phase) => script === 'poster' ? posters : script === 'aimTrainer' ? trainer && READY.has(phase) : true,
    ever: script => script === 'poster' ? posters : script === 'aimTrainer' ? trainer : true
  };
}

/** the world groups a map script shows or deletes by the game's phase (ready-up or not): add(script, apply), then
 *  set(phase) at each frame -> true when something changed */
export class ScriptedParts {
  constructor(meta) { this.rule = scriptedRule(meta); this.parts = []; this.phase = undefined; }
  add(script, apply) {
    const p = { script, apply };
    this.parts.push(p);
    apply(this.rule.visible(script, this.phase));
  }
  set(phase) {
    if (phase === this.phase) return false;
    const prev = this.phase;
    this.phase = phase;
    let changed = false;
    for (const p of this.parts) {
      const v = this.rule.visible(p.script, phase);
      if (v !== this.rule.visible(p.script, prev)) { p.apply(v); changed = true; }
    }
    return changed;
  }
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
