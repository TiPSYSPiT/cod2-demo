/* The things on the move or on the ground that the game draws as models: the grenades in flight (the weapon
 * file's projectileModel, eType 4) and the dropped weapons (eType 3 items: the weapon's world model; a dying
 * player drops his gun and a grenade). Both where the demo's entities have them: their trajectories (position and
 * angles, BG_EvaluateTrajectory - a grenade spins with its apos, an item settles), while the entity is in the
 * snapshots (an item out of the recorder's view keeps its place until it shows up again or is gone).
 * And the planted S&D bomb as the game spawns it (sd.gsc): xmodel/mp_tntbomb at the plant, with its glow
 * xmodel/mp_tntbomb_obj while it ticks - the glow goes at the defuse, both at the explosion (DemoData.bombTrack:
 * the bomb model's own position and angles when the recorder saw it, else level at the estimated position).
 * Drawn with modelBatch.js (pooled instances, lit by the light grid); the glow with the game's own "objective"
 * technique (materials/shaders/objective_base.hlsl + statemaps/objective.sm: additive SrcAlpha / One, depth test
 * less-equal, no depth write, back faces culled, no fog). */
import * as THREE from 'three';
import { evalTrajectory, trajectoryAt } from '../app/match.js';
import { ModelBatches, entityMatrix } from './modelBatch.js';

const BOMB_MODEL = 'xmodel/mp_tntbomb', BOMB_GLOW_MODEL = 'xmodel/mp_tntbomb_obj';

// objective_base.hlsl: a colour between minColor and maxColor by a wave over the surface's facing and the game time
// (gameTime.z, seconds), times the colour map's luminance + 0.5; alpha = the map's alpha. Three.js' view space looks
// down -z, the game's (D3D) down +z: the game's -n.z is n.z here.
const GLOW_VS = `
varying vec2 vUv;
varying vec3 vNormalView;
void main() {
  vUv = uv;
  vNormalView = normalMatrix * normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const GLOW_FS = `
uniform sampler2D uMap;
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalView;
void main() {
  const vec4 minColor = vec4(0.25, 0.15, 0.0, 1.0);
  const vec4 maxColor = vec4(1.0, 1.0, 0.5, 1.0);
  vec4 tex = texture2D(uMap, vUv);
  float luminance = dot(vec3(0.333), tex.rgb);
  float facing = normalize(vNormalView).z;
  float lerpAlpha = 0.5 - sin((facing * 0.5 + uTime) * 3.14159 * 2.0) * 0.5;
  vec4 c = mix(minColor, maxColor, lerpAlpha) * (luminance + 0.5);
  gl_FragColor = vec4(c.rgb, tex.a);
}`;

export class WorldItems {
  constructor(scene, match, library) {
    this.M = match;
    this.lib = library;
    this.scene = scene;
    this.batches = new ModelBatches(scene, library);
    this.enabled = true;
    this.m = new THREE.Matrix4();
    this.p = new Array(6);
    const d = match.d;
    // the items by appearance (each with its light cache)
    this.items = (d.items || []).filter(r => r.segments.length).map(r => ({ r, start: r.t0, end: r.t1, cache: {} }));
    // the grenades from their launch (or first sight) to the explosion / their last sight
    this.grenades = (d.grenades || []).filter(g => g.segments.length).map(g => ({
      g, start: Math.max(g.segments[0][0], g.launch != null ? g.launch : g.first),
      end: g.detonation ? g.detonation.t : g.last + 50, cache: {}
    }));
    this.maxItem = this.items.reduce((m, it) => Math.max(m, it.end - it.start), 0);
    this.bombCache = {};
    this.glow = undefined;          // the glow mesh (null: its model is not exported)
    this.bombDrawn = false;         // (effects.js draws its box marker only when the model is not)
  }

  /** the bomb's glow: the glow model's geometry with the objective technique (made once, when the models are there) */
  glowMesh() {
    if (this.glow !== undefined) return this.glow;
    const L = this.lib, tpl = L.template(BOMB_GLOW_MODEL);
    this.glow = null;
    if (!tpl) return null;
    const geo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) geo.setAttribute(k, tpl.geometry.attributes[k]);
    geo.setIndex(tpl.geometry.index);
    geo.boundingSphere = tpl.geometry.boundingSphere;
    const g = L.modelsInfo.models[BOMB_GLOW_MODEL].groups[0];
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: L.texture(g && g.texture) }, uTime: { value: 0 } },
      vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
      transparent: true, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth, side: THREE.FrontSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
      // (the bomb under it is an instanced copy: its depth can differ in the last bits - a small offset keeps the glow on it)
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'bomb glow';
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    this.scene.add(mesh);
    this.glow = mesh;
    return mesh;
  }

  /** the planted bomb's models at t -> true when drawn */
  addBomb(t) {
    const e = this.M.bombAt(t);
    if (!e || e.x == null || (e.state !== 'planted' && e.state !== 'defused')) return false;
    const m = this.m, a = e.angles || [0, 0, 0];
    const z = e.z != null ? e.z : this.M.zRange[0];
    entityMatrix(m, e.x, e.y, z, a[0], a[1], a[2]);
    if (!this.batches.add(BOMB_MODEL, m, e.x, e.y, z + 4, this.bombCache)) return false;
    const glow = e.state === 'planted' ? this.glowMesh() : null;
    if (glow) {
      glow.matrix.copy(m);
      glow.matrixWorldNeedsUpdate = true;
      glow.material.uniforms.uTime.value = (t / 1000) % 1;      // (the wave's period: 1 s of demo time)
      glow.visible = true;
    }
    return true;
  }

  setGrid(grid) { this.batches.setGrid(grid); }

  /** the models at demo time t -> the grenades drawn (their keys: effects.js leaves out its markers for them) */
  update(t) {
    const B = this.batches, L = this.lib, drawn = new Set();
    B.begin();
    if (this.glow) this.glow.visible = false;
    if (this.enabled && L && L.modelsInfo) {
      const P = this.p, m = this.m;
      const proj = L.modelsInfo.projectiles || {};
      for (const it of this.grenades) {
        if (t < it.start || t >= it.end) continue;
        const model = proj[String(it.g.weapon || '').toLowerCase()];
        if (!model) continue;
        evalTrajectory(trajectoryAt(it.g.segments, t), t, P);
        if (B.add(model, entityMatrix(m, P[0], P[1], P[2], P[3], P[4], P[5]), P[0], P[1], P[2], it.cache)) drawn.add(it.g);
      }
      for (const it of this.items) {
        if (t < it.start || t > it.end) continue;
        const model = L.weaponModel(it.r.weapon);
        if (!model) continue;
        evalTrajectory(trajectoryAt(it.r.segments, t), t, P);
        B.add(model, entityMatrix(m, P[0], P[1], P[2], P[3], P[4], P[5]), P[0], P[1], P[2] + 4, it.cache);
      }
      this.bombDrawn = this.addBomb(t);
    } else this.bombDrawn = false;
    B.end();
    return drawn;
  }

  setEnabled(on) { this.enabled = on; }

  dispose() {
    this.batches.dispose();
    if (this.glow) { this.scene.remove(this.glow); this.glow.geometry.dispose(); this.glow.material.dispose(); }
  }
}
