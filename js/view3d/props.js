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
 * LODs, as the game (XModelGetLodForDist, R_SetLodOrigin): per placement the first LOD whose distance is 0 or
 * beyond the eye's distance to its origin x tan(fov / 2) / tan(40 deg) (cg_fov 80: x 1), none - not drawn - past
 * the last one (bushes vanish at 1200 - 2000 units); the models with such distances keep every placement's state
 * (matrix, shown, colour, grid light) and pack each LOD's instances anew when a placement changes its LOD (update,
 * every frame). The mounted MGs keep LOD 0.
 * Modes: models, see-through boxes of the model bounds, off. */
import * as THREE from 'three';
import { fetchJSON, fetchBinary, checkedView } from './data.js';
import { loadTexture, setMap, uniformMap, detailMap, multiplyMaterial, polygonOffset, anisotropy } from './mapLoader.js';
import { receiveCookie } from './shadows.js';
import { propGridMaterial } from './lightGrid.js';
import { gameObjectFilter, scriptedRule, precachedRule } from './gameObjects.js';

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
    const keep = gameObjectFilter(opts.gametype), scripted = scriptedRule(opts.meta), ran = precachedRule(opts.meta);
    // an exploder a level script links (ifModel) on a server that did not run the script: no exploder - the wreck
    // stays hidden for good, the intact model is an ordinary placement
    const linked = inst => !!inst.exploder && ran(inst.exploder.ifModel);
    // (a scripted placement - none of the maps has one - is kept when its script shows it at some phase; a model a
    // level script spawns when the demo's server ran that script)
    const instances = info.instances.filter(inst => keep(inst.gameobject) && (!inst.scripted || scripted.ever(inst.scripted))
      && ran(inst.ifModel) && !(inst.exploder && inst.exploder.show && !linked(inst)));
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
        t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy();
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
    this.lodModels = [];              // the models switched by distance: {list, dists, levels: [[mesh]], level, shown, mats, col, grid}
    this.lodDirty = true;
    info.models.forEach((m, mi) => {
      const list = byModel.get(mi) || [];
      if (!list.length) return;
      const meshes = [], aimMeshes = [];
      const dists = m.lodDistances || [];
      // switched by distance: a distance on any LOD (all its LODs exported) and not a mounted MG
      const lodded = !m.aimPivot && dists.some(d => d > 0) && (m.lods ? m.lods.length : 0) === dists.length - 1;
      // one LOD's surfaces as instanced meshes over all placements -> [mesh]
      const buildLevel = (G, groups, lv) => {
      const levelMeshes = [];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(checkedView(Float32Array, buf, G.position.offset, G.position.length / 4, 'props.bin'), 3));
      geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(checkedView(Int8Array, buf, G.normal.offset, G.normal.length, 'props.bin'), 4), 3, 0, true));
      geo.setAttribute('uv', new THREE.BufferAttribute(checkedView(Float32Array, buf, G.uv.offset, G.uv.length / 4, 'props.bin'), 2));
      // the tangent of the normal-mapped surfaces (int8 x 4: xyz, w = the binormal's sign: B = w cross(N, T))
      if (G.tangent) geo.setAttribute('cTangent', new THREE.BufferAttribute(checkedView(Int8Array, buf, G.tangent.offset, G.tangent.length, 'props.bin'), 4, true));
      const index = checkedView(Uint32Array, buf, G.index.offset, G.index.length / 4, 'props.bin');
      for (const g of groups) {
        const sub = geo.clone();
        sub.setIndex(new THREE.BufferAttribute(index.subarray(g.start, g.start + g.count), 1));
        const opts = { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide, forceSinglePass: true };      // (forceSinglePass: mapLoader.js)
        const tex = texture(g.texture);
        // the multiply decals (crate stencils, grime): the framebuffer x the colour map, unlit (mapLoader.js)
        if (g.blend === 'multiply' && tex) {
          const mat = multiplyMaterial(tex, { side: opts.side, vertexColors: false }, g.polygonOffset != null ? g.polygonOffset : 1);
          mat.name = g.material;
          const mesh = new THREE.InstancedMesh(sub, mat, list.length);
          list.forEach((inst, i) => mesh.setMatrixAt(i, matrixOf(inst.matrix)));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.name = m.name + ':' + g.material;
          mesh.userData = { multiply: true, lv };
          this.models.add(mesh);
          levelMeshes.push(mesh);
          if (!lv) {
            meshes.push(mesh);
            if (g.part === 'aim') aimMeshes.push(mesh);
            this.triangles += g.count / 3 * list.length;
          }
          continue;
        }
        if (!tex) opts.color = new THREE.Color(0x8a8a84);
        if (g.alphaTest || (g.blend && g.textureAlpha)) opts.alphaTest = 0.5;
        if (g.alphaTest) opts.alphaToCoverage = true;      // (soft cut-out edges with multisampling: leaves, fences)
        // the model's decal surfaces (the material's polygon offset level, mapLoader.js)
        if (g.polygonOffset) polygonOffset(opts, g.polygonOffset);
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
        mesh.userData = { list, model: m, unlit, bump, lv };
        this.models.add(mesh);
        levelMeshes.push(mesh);
        if (!lv) {
          meshes.push(mesh);
          if (g.part === 'aim') aimMeshes.push(mesh);
          this.triangles += g.count / 3 * list.length;
        }
      }
      return levelMeshes;
      };
      const levels = [buildLevel(m.geometry, m.groups, 0)];
      let L = null;
      if (lodded) {
        // (a model of one LOD with a distance: switched off beyond it - no coarser levels)
        const coarser = m.lods || [];
        for (let k = 0; k < coarser.length; k++) levels.push(buildLevel(coarser[k].geometry, coarser[k].groups, k + 1));
        const n = list.length, col = new Float32Array(n * 3);
        list.forEach((inst, i) => {
          const gain = LIT_GAIN;          // (the instance colour until the grid lights them: as the meshes have it)
          if (inst.light) for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.min(2, inst.light[c] * gain); else col.fill(1, i * 3, i * 3 + 3);
        });
        L = { list, dists, levels, level: new Int8Array(n), shown: new Uint8Array(n).fill(1),
          mats: list.map(inst => matrixOf(inst.matrix).clone()), col, unlitCol: list.map(inst => inst.light ? inst.light.map(c => Math.min(2, c * LIGHT_GAIN)) : [1, 1, 1]),
          grid: null, gridLevels: [], dirty: true };
        for (const lvMeshes of levels) for (const mesh of lvMeshes) mesh.userData.L = L;
        this.lodModels.push(L);
        this.pack(L);                    // (every placement at LOD 0 until the first update)
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
        if (!linked(inst)) return;
        this.exploderParts.push({ site: inst.exploder.site, show: inst.exploder.show, apply: visible => {
          const M = visible ? matrixOf(inst.matrix) : hidden;
          if (L) {
            L.shown[i] = visible ? 1 : 0; L.dirty = true; this.lodDirty = true;
            box.setMatrixAt(i, M); box.instanceMatrix.needsUpdate = true;
            return;
          }
          for (const mesh of meshes) { mesh.setMatrixAt(i, M); mesh.instanceMatrix.needsUpdate = true; }
        } });
      });
      // the mounted MGs: the gun turned about the pivot (the game's tag_aim_animated) - pitch about the stand's y
      // axis (positive: down, as the view angles), then yaw about its z axis. tag(name, pitch, yaw, out): a bone of
      // the model (tags: tag_aim - carrying tag_player, the user's eye -, tag_flash on tag_aim_animated - the
      // muzzle) in the world with the gun so turned (CG_UpdateTurretBones turns tag_aim and tag_aim_animated alike)
      if (m.aimPivot && aimMeshes.length) list.forEach((inst, i) => {
        if (!inst.turret) return;
        const p = m.aimPivot, base = matrixOf(inst.matrix).clone();
        const toPivot = new THREE.Matrix4().makeTranslation(p[0], p[1], p[2]), fromPivot = new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]);
        const R = new THREE.Matrix4(), Ry = new THREE.Matrix4(), out = new THREE.Matrix4();
        const turn = (pivot, pitch, yaw, m4) => {
          R.makeRotationZ(yaw * DEG).multiply(Ry.makeRotationY(pitch * DEG));
          return m4.copy(base).multiply(new THREE.Matrix4().makeTranslation(pivot[0], pivot[1], pivot[2])).multiply(R)
            .multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
        };
        const tags = m.tags || {}, tm = new THREE.Matrix4();
        this.turrets.push({ origin: [inst.matrix[3], inst.matrix[7], inst.matrix[11]], model: m.name, tags, aim: (pitch, yaw) => {
          R.makeRotationZ(yaw * DEG).multiply(Ry.makeRotationY(pitch * DEG));
          out.copy(base).multiply(toPivot).multiply(R).multiply(fromPivot);
          for (const mesh of aimMeshes) { mesh.setMatrixAt(i, out); mesh.instanceMatrix.needsUpdate = true; }
        }, tag: (name, pitch, yaw, v) => {
          const b = tags[name];
          if (!b) return null;
          turn(name === 'tag_flash' ? p : tags.tag_aim || p, pitch, yaw, tm);
          return v.set(b[0], b[1], b[2]).applyMatrix4(tm);
        }, forward: (pitch, yaw, v) => {
          turn(p, pitch, yaw, tm);
          return v.set(1, 0, 0).transformDirection(tm);
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
      const { list, model, unlit, bump, L, lv } = mesh.userData;
      if (!list) continue;
      let A = attrs(model, list);
      if (L) {
        // a LOD model: the master light per placement, each level its packed copy (filled by pack)
        L.grid = A;
        if (!L.gridLevels[lv]) L.gridLevels[lv] = { C: A.C.map(a => new THREE.InstancedBufferAttribute(new Float32Array(a.array.length), 4)), S: new THREE.InstancedBufferAttribute(new Float32Array(A.S.array.length), 1) };
        A = L.gridLevels[lv];
        L.col.fill(1);
        L.dirty = true; this.lodDirty = true;
      }
      A.C.forEach((a, k) => mesh.geometry.setAttribute('gridC' + k, a));
      mesh.geometry.setAttribute('gridSun', A.S);
      for (let i = 0; i < list.length; i++) mesh.setColorAt(i, white);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // (white now: the normal-mapped ones drop it - 16 vertex attributes at most, the grid takes 7)
      if (bump) mesh.instanceColor = null;
      propGridMaterial(mesh.material, unlit, bump);
    }
    for (const L of this.lodModels) this.pack(L);
  }

  /** a LOD model's placements into its levels' instanced meshes: each level the placements at that LOD, their
   *  matrices, colours and grid light packed from the first slot on */
  pack(L) {
    L.dirty = false;
    const n = L.list.length;
    for (let lv = 0; lv < L.levels.length; lv++) {
      const idx = [];
      for (let i = 0; i < n; i++) if (L.level[i] === lv && L.shown[i]) idx.push(i);
      const G = L.grid && L.gridLevels[lv];
      if (G) {
        idx.forEach((i, k) => {
          for (let c = 0; c < 6; c++) { const src = L.grid.C[c].array, dst = G.C[c].array; for (let j = 0; j < 4; j++) dst[k * 4 + j] = src[i * 4 + j]; }
          G.S.array[k] = L.grid.S.array[i];
        });
        G.C.forEach(a => { a.needsUpdate = true; }); G.S.needsUpdate = true;
      }
      for (const mesh of L.levels[lv]) {
        idx.forEach((i, k) => mesh.setMatrixAt(k, L.mats[i]));
        if (mesh.instanceColor) {
          const unlit = mesh.userData.unlit && !L.grid, a = mesh.instanceColor.array;
          idx.forEach((i, k) => { for (let c = 0; c < 3; c++) a[k * 3 + c] = unlit ? L.unlitCol[i][c] : L.col[i * 3 + c]; });
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.count = idx.length;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** the LOD of every switched placement for the camera (each frame; repacks a model whose LODs changed) */
  update(camera) {
    if (!this.lodModels.length || this.mode !== 'high') return;
    const p = camera.position;
    // the game's lod scale: tan(fov_x / 2) / tan(40 deg) - the view's fov as the 4:3 horizontal fov cg_fov is
    const scale = Math.tan(Math.atan(Math.tan(camera.fov * DEG / 2) * 4 / 3)) / Math.tan(40 * DEG);
    const last = this.lastLod;
    if (!this.lodDirty && last && Math.abs(last.x - p.x) + Math.abs(last.y - p.y) + Math.abs(last.z - p.z) < 8 && Math.abs(last.scale - scale) < 1e-3) return;
    this.lastLod = { x: p.x, y: p.y, z: p.z, scale };
    this.lodDirty = false;
    for (const L of this.lodModels) {
      let changed = L.dirty;
      const D = L.dists, top = L.levels.length - 1;
      for (let i = 0; i < L.list.length; i++) {
        const e = L.mats[i].elements;
        const d = Math.hypot(e[12] - p.x, e[13] - p.y, e[14] - p.z) * scale;
        let lv = -1;
        for (let k = 0; k < D.length; k++) if (D[k] === 0 || D[k] > d) { lv = Math.min(k, top); break; }
        if (lv !== L.level[i]) { L.level[i] = lv; changed = true; }
      }
      if (changed) this.pack(L);
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
