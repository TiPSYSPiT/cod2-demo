/* The players' sprites over their heads, as the 1.3 client draws them (CG_PlayerSprites, CG_PlayerFloatSprite):
 * the script's head icon (the entity's iHeadIcon: config string 30 + n, e.g. headicon_american) for the viewer's team
 * (iHeadIconTeam 0 = every team), above it the talk balloon (headicontalkballoon) while a teammate talks (EF_TALK),
 * or the connection icon (headicondisconnected) - 21 units over the head bone (82 over the origin without a model),
 * each further sprite 16 units higher, at a constant size on the screen (cg_scriptIconSize / cg_voiceIconSize 0 ->
 * cg_headIconMinScreenRadius 0.015 of the screen height) and seen through walls. In first person the viewer is that
 * player's team (the head icon's team is its owner's team, so: teammates' icons, enemies' only when for every team);
 * in the other cameras a spectator, who sees them all. The images: maps3d/_hud (hud_export.py). */
import * as THREE from 'three';
import { fetchJSON } from './data.js';
import { loadTexture } from './mapLoader.js';

const SCREEN_RADIUS = 0.015;
const TALK = 64, LAG = 128;

export class PlayerSprites {
  constructor(scene, match) {
    this.M = match;
    this.root = new THREE.Group();
    this.root.renderOrder = 6;
    scene.add(this.root);
    this.enabled = true;
    this.items = new Map();          // client -> [sprite, sprite]
    this.mats = new Map();           // material name -> SpriteMaterial
    this.ready = fetchJSON('maps3d/_hud/hud.json').then(d => { this.materials = d.materials; return true; }).catch(() => false);
  }

  material(name) {
    if (!this.materials || !name) return null;
    if (!this.mats.has(name)) {
      const m = this.materials[name];
      let mat = null;
      if (m && m.image) {
        const tex = loadTexture('maps3d/' + m.image);
        tex.colorSpace = THREE.SRGBColorSpace;
        mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, fog: false, toneMapped: false });
      }
      this.mats.set(name, mat);
    }
    return this.mats.get(name);
  }

  sprites(cl) {
    let s = this.items.get(cl);
    if (!s) {
      s = [new THREE.Sprite(), new THREE.Sprite()];
      for (const x of s) { x.visible = false; x.renderOrder = 6; this.root.add(x); }
      this.items.set(cl, s);
    }
    return s;
  }

  /** the sprites at t: actors (actors.js items: cl -> {visible, sample, eye, char, modelShown}), fp = the client in
   *  first person (or null) */
  update(t, camera, actors, fp) {
    for (const s of this.items.values()) for (const x of s) x.visible = false;
    if (!this.enabled || !this.materials) return;
    const M = this.M, icons = M.d.headIcons || {};
    const viewerTeam = fp != null && M.player(fp) ? M.player(fp).team : null;      // (null: a spectator)
    // a constant size on the screen: the sprite's scale is in view-space units per unit of depth
    const scale = 2 * SCREEN_RADIUS * Math.tan(camera.fov * Math.PI / 360) * 2;
    const head = new THREE.Vector3();
    for (const it of actors.items.values()) {
      if (!it.visible || !it.sample || it.cl === fp || it.cl >= 64) continue;
      const v = it.sample.icon | 0, p = M.player(it.cl);
      const mate = viewerTeam == null || (p && p.team === viewerTeam);
      const list = [];
      const n = v & 15, team = (v >> 4) & 3;
      if (n && icons[n] && (viewerTeam == null || team === 0 || mate)) list.push(icons[n]);
      if (v & LAG) list.push('headicondisconnected');
      else if (mate && (v & TALK)) list.push('headicontalkballoon');
      if (!list.length) continue;
      // over the head bone, else over the origin
      const hb = it.modelShown && it.char && it.char.byName && it.char.byName.get('j_head');
      let base;
      if (hb) { hb.updateWorldMatrix(true, false); head.setFromMatrixPosition(hb.matrixWorld); base = head.z + 21; }
      else { head.set(it.sample.x, it.sample.y, it.sample.z); base = head.z + 82; }
      const sp = this.sprites(it.cl);
      list.forEach((name, k) => {
        const mat = this.material(name);
        if (!mat) return;
        const x = sp[k];
        x.material = mat;
        x.position.set(head.x, head.y, base + k * 16);
        x.scale.set(scale, scale, 1);
        x.visible = true;
      });
    }
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.mats.values()) if (m) { if (m.map) m.map.dispose(); m.dispose(); }
  }
}
