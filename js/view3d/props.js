/* The map's static models (misc_model entities of the BSP: crates, sandbags, trees, vehicles):
 * maps3d/<map>/props.json + props.bin, written by tools/export/export_maps.py. Each model's LOD 0
 * geometry once, drawn as one InstancedMesh per surface over all its placements (3 x 4 matrices from
 * the entity's origin, angles and modelscale).
 * Light, as the game (R_LoadWorld of the 1.3 client): the map's light grid at the centre of the
 * placement's bounds, or - a model flagged for it (xmodel flags bit 0) with the compiler's ground light
 * on the entity (gndLt) - that light from every direction, its alpha the sun's visibility; then the
 * entity's directLightScale / indirectLightScale (applyGrid, lightGrid.js). Until the grid is loaded, and
 * on maps without one: the ground light tints the instance and the scene lights shade it (the "ambient"
 * techniques, which the game does not shade by their normals, unlit). The detail maps tint every surface
 * that has one; with the grid, surfaces with a normal map are lit per pixel (+ the specular highlight).
 * The game type's filter drops the placements it deletes; the bomb sites' exploder placements are switched
 * by the explosion (gameObjects.js, exploderParts). The mounted MGs' guns (the groups of part "aim") turn
 * about the model's aimPivot by the turret's aim in the demo (turrets, view3d.js).
 * Modes: models, see-through boxes of the model bounds, off. */
import * as THREE from 'three';
import { fetchJSON, fetchBinary, checkedView } from './data.js';
import { loadTexture, setMap, uniformMap, detailMap, multiplyMaterial } from './mapLoader.js';
import { receiveCookie } from './shadows.js';
import { propGridMaterial } from './lightGrid.js';
import { gameObjectFilter } from './gameObjects.js';

// gndLt (0..1) -> instance colour: stored 2x overbright like the light maps; the lit materials divide it
// by the ~0.75 the scene lights add on average (the tint already is the light at the model)
const LIGHT_GAIN = 2, LIT_GAIN = 2.6;
const DEG = Math.PI / 180;

export class Props {
  /** dir: maps3d/<map>/, opts {gametype} -> Props | null when the map has no exported props */
  static async load(dir, opts = {}) {
    let info = null;
    try { info = await fetchJSON(dir + 'props.json'); } catch (err) { return null; }
    if (!info || !info.instances || !info.instances.length) return null;
    const buf = info.byteLength ? await fetchBinary(dir + info.file, { expected: info.byteLength }) : new ArrayBuffer(0);
    return new Props(info, buf, opts);
  }

  constructor(info, buf, opts = {}) {
    this.info = info;
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.models = new THREE.Group();
    this.boxes = new THREE.Group();
    this.group.add(this.models, this.boxes);
    this.mode = 'high';
    const keep = gameObjectFilter(opts.gametype);
    const instances = info.instances.filter(inst => keep(inst.gameobject));
    this.instanceCount = instances.length;
    this.exploderParts = [];          // [{site, show, apply(visible)}] (gameObjects.js)
    this.turrets = [];                // [{origin, aim(pitch, yaw)}]: the mounted MGs' guns (degrees, relative to the stand)
    this.modelCount = info.models.length;
    this.fallbackModels = info.fallback || [];
    const texCache = new Map();
    const texture = file => {
      if (!file) return null;
      if (!texCache.has(file)) {
        const t = loadTexture('maps3d/' + file);
        t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
        texCache.set(file, t);
      }
      return texCache.get(file);
    };
    // placements per model
    const byModel = new Map();
    for (const inst of instances) {
      if (!byModel.has(inst.model)) byModel.set(inst.model, []);
      byModel.get(inst.model).push(inst);
    }
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    const matrixOf = a => m4.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], 0, 0, 0, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this.triangles = 0;
    info.models.forEach((m, mi) => {
      const list = byModel.get(mi) || [];
      if (!list.length) return;
      const G = m.geometry;
      const meshes = [], aimMeshes = [];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(checkedView(Float32Array, buf, G.position.offset, G.position.length / 4, 'props.bin'), 3));
      geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(checkedView(Int8Array, buf, G.normal.offset, G.normal.length, 'props.bin'), 4), 3, 0, true));
      geo.setAttribute('uv', new THREE.BufferAttribute(checkedView(Float32Array, buf, G.uv.offset, G.uv.length / 4, 'props.bin'), 2));
      // the tangent of the normal-mapped surfaces (int8 x 4: xyz, w = the binormal's sign: B = w cross(N, T))
      if (G.tangent) geo.setAttribute('cTangent', new THREE.BufferAttribute(checkedView(Int8Array, buf, G.tangent.offset, G.tangent.length, 'props.bin'), 4, true));
      const index = checkedView(Uint32Array, buf, G.index.offset, G.index.length / 4, 'props.bin');
      for (const g of m.groups) {
        const sub = geo.clone();
        sub.setIndex(new THREE.BufferAttribute(index.subarray(g.start, g.start + g.count), 1));
        const opts = { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide };
        const tex = texture(g.texture);
        // the multiply decals (crate stencils, grime): the framebuffer x the colour map, unlit (mapLoader.js)
        if (g.blend === 'multiply' && tex) {
          const mat = multiplyMaterial(tex, { side: opts.side, vertexColors: false });
          mat.name = g.material;
          const mesh = new THREE.InstancedMesh(sub, mat, list.length);
          list.forEach((inst, i) => mesh.setMatrixAt(i, matrixOf(inst.matrix)));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.name = m.name + ':' + g.material;
          mesh.userData = { multiply: true };
          this.models.add(mesh);
          meshes.push(mesh);
          if (g.part === 'aim') aimMeshes.push(mesh);
          this.triangles += g.count / 3 * list.length;
          continue;
        }
        if (!tex) opts.color = new THREE.Color(0x8a8a84);
        if (g.alphaTest || (g.blend && g.textureAlpha)) opts.alphaTest = 0.5;
        // "ambient_*" techniques (grass, foliage cards) take no light from their normals in the game, only
        // the ground light: unlit here, or the double-sided blades turn black on their back faces
        const unlit = /^ambient/.test(g.technique || '');
        const mat = unlit ? new THREE.MeshBasicMaterial(opts) : new THREE.MeshLambertMaterial(opts);
        const gain = unlit ? LIGHT_GAIN : LIT_GAIN;
        setMap(mat, 'map', tex, opts.alphaTest ? 'clear' : 'grey');
        mat.name = g.material;
        if (tex && g.detailMap) detailMap(mat, texture(g.detailMap), g.detailScale);
        receiveCookie(mat);                  // the players' shadows (shadows.js)
        // the normal / specular maps, used once the grid lights the props (applyGrid)
        const bump = tex && g.normalMap && G.tangent && !unlit          // (sampled with the colour map's vMapUv)
          ? { normalMap: uniformMap(texture(g.normalMap), 'flat'), specMap: g.specularMap ? uniformMap(texture(g.specularMap), 'black') : null }
          : null;
        const mesh = new THREE.InstancedMesh(sub, mat, list.length);
        list.forEach((inst, i) => {
          mesh.setMatrixAt(i, matrixOf(inst.matrix));
          if (inst.light) col.setRGB(...inst.light.map(c => Math.min(2, c * gain))); else col.setRGB(1, 1, 1);
          mesh.setColorAt(i, col);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.name = m.name + ':' + g.material;
        mesh.userData = { list, model: m, unlit, bump };
        this.models.add(mesh);
        meshes.push(mesh);
        if (g.part === 'aim') aimMeshes.push(mesh);
        this.triangles += g.count / 3 * list.length;
      }
      // the see-through box of the model bounds per placement
      const size = new THREE.Vector3().fromArray(m.maxs).sub(new THREE.Vector3().fromArray(m.mins));
      const center = new THREE.Vector3().fromArray(m.mins).addScaledVector(size, 0.5);
      const boxGeo = new THREE.BoxGeometry(Math.max(size.x, 1), Math.max(size.y, 1), Math.max(size.z, 1));
      boxGeo.translate(center.x, center.y, center.z);
      const box = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0xffc070, wireframe: true, transparent: true, opacity: 0.6 }), list.length);
      list.forEach((inst, i) => box.setMatrixAt(i, matrixOf(inst.matrix)));
      box.computeBoundingSphere();
      this.boxes.add(box);
      meshes.push(box);
      // the exploder placements: a zero-scale matrix while the game has the entity hidden or deleted
      list.forEach((inst, i) => {
        if (!inst.exploder) return;
        this.exploderParts.push({ site: inst.exploder.site, show: inst.exploder.show, apply: visible => {
          const M = visible ? matrixOf(inst.matrix) : hidden;
          for (const mesh of meshes) { mesh.setMatrixAt(i, M); mesh.instanceMatrix.needsUpdate = true; }
        } });
      });
      // the mounted MGs: the gun turned about the pivot (the game's tag_aim_animated) - pitch about the stand's y
      // axis (positive: down, as the view angles), then yaw about its z axis
      if (m.aimPivot && aimMeshes.length) list.forEach((inst, i) => {
        if (!inst.turret) return;
        const p = m.aimPivot, base = matrixOf(inst.matrix).clone();
        const toPivot = new THREE.Matrix4().makeTranslation(p[0], p[1], p[2]), fromPivot = new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]);
        const R = new THREE.Matrix4(), Ry = new THREE.Matrix4(), out = new THREE.Matrix4();
        this.turrets.push({ origin: [inst.matrix[3], inst.matrix[7], inst.matrix[11]], aim: (pitch, yaw) => {
          R.makeRotationZ(yaw * DEG).multiply(Ry.makeRotationY(pitch * DEG));
          out.copy(base).multiply(toPivot).multiply(R).multiply(fromPivot);
          for (const mesh of aimMeshes) { mesh.setMatrixAt(i, out); mesh.instanceMatrix.needsUpdate = true; }
        } });
      });
    });
    this.setMode('high');
  }

  /** light every placement from the map's light grid (lightGrid.js) or its ground light, as the game */
  applyGrid(grid) {
    if (!grid || this.gridApplied) return;
    this.gridApplied = true;
    const perModel = new Map(), v = new THREE.Vector3(), m4 = new THREE.Matrix4(), s = { coef: new Float32Array(24), sun: 0 };
    const attrs = (model, list) => {
      if (perModel.has(model)) return perModel.get(model);
      const n = list.length, C = Array.from({ length: 6 }, () => new Float32Array(n * 4)), S = new Float32Array(n);
      list.forEach((inst, i) => {
        const gl = inst.groundLight;
        let coef, sun;
        if (gl && model.flags & 1) {
          coef = s.coef;
          for (let k = 0; k < 24; k++) coef[k] = gl[k >> 3];
          sun = gl[3];
        } else {
          const a = inst.matrix;
          m4.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], 0, 0, 0, 1);
          v.set((model.mins[0] + model.maxs[0]) / 2, (model.mins[1] + model.maxs[1]) / 2, (model.mins[2] + model.maxs[2]) / 2).applyMatrix4(m4);
          const r = grid.sample(v.x, v.y, v.z - 4, s);       // (sample looks 4 units above the point)
          if (r) { coef = r.coef; sun = r.sun; }
          else if (gl) { coef = s.coef; for (let k = 0; k < 24; k++) coef[k] = gl[k >> 3]; sun = gl[3]; }
          else { coef = s.coef.fill(0.5); sun = 1; }
        }
        const ind = inst.indirectLightScale != null ? inst.indirectLightScale : 1;
        for (let k = 0; k < 24; k++) C[k >> 2][i * 4 + (k & 3)] = coef[k] * ind;
        S[i] = sun * (inst.directLightScale != null ? inst.directLightScale : 1);
      });
      const out = { C: C.map(a => new THREE.InstancedBufferAttribute(a, 4)), S: new THREE.InstancedBufferAttribute(S, 1) };
      perModel.set(model, out);
      return out;
    };
    const white = new THREE.Color(1, 1, 1);
    for (const mesh of this.models.children) {
      const { list, model, unlit, bump } = mesh.userData;
      if (!list) continue;
      const A = attrs(model, list);
      A.C.forEach((a, k) => mesh.geometry.setAttribute('gridC' + k, a));
      mesh.geometry.setAttribute('gridSun', A.S);
      for (let i = 0; i < list.length; i++) mesh.setColorAt(i, white);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // (white now: the normal-mapped ones drop it - 16 vertex attributes at most, the grid takes 7)
      if (bump) mesh.instanceColor = null;
      propGridMaterial(mesh.material, unlit, bump);
    }
  }

  /** 'high' (models) | 'boxes' | 'off' -> the mode set */
  setMode(mode) {
    if (!['high', 'boxes', 'off'].includes(mode)) mode = 'high';
    this.mode = mode;
    this.models.visible = mode === 'high';
    this.boxes.visible = mode === 'boxes';
    return mode;
  }
}
