/* The surface picker of the 3D view, only with ?debug in the URL: a click (not a drag) on the world or a
 * prop logs what was hit - material, technique, surface flags / contents, textures, lightmap, vertex
 * colours, the face's side towards the camera - to the console and into a small overlay (window.lastPick
 * keeps the last one). */
import * as THREE from 'three';

const hex = v => (v == null ? '-' : '0x' + (v >>> 0).toString(16));

/** what the hit is: world surface or prop -> plain object */
function describe(hit, camera) {
  const o = hit.object, geo = o.geometry;
  const mat = Array.isArray(o.material) ? o.material[hit.face.materialIndex] : o.material;
  const out = { object: o.name, material: mat && mat.name, point: hit.point.toArray().map(v => Math.round(v)), distance: Math.round(hit.distance) };
  const n = hit.face.normal.clone().transformDirection(o.matrixWorld);
  const view = hit.point.clone().sub(camera.position).normalize();
  out.facing = n.dot(view) < 0 ? 'front' : 'back';
  out.normal = n.toArray().map(v => +v.toFixed(2));
  const g = mat && mat.userData.group;
  if (g) {
    Object.assign(out, {
      kind: 'world', technique: g.technique, surface: hex(g.surface), contents: hex(g.contents), texture: g.texture || '(none)',
      textureAlpha: g.textureAlpha, lightmap: g.lightmap, normalMap: g.normalMap || null, specularMap: g.specularMap || null,
      detailMap: g.detailMap || null, alphaTest: g.alphaTest, blend: g.blend, vertexAlpha: g.vertexAlpha, decal: g.decal,
      doubleSided: g.doubleSided, brushModel: g.brushModel, triangles: g.count / 3
    });
    const col = geo.getAttribute('color');
    if (col) out.vertexColors = [hit.face.a, hit.face.b, hit.face.c].map(i => [col.getX(i), col.getY(i), col.getZ(i), col.getW(i)].map(v => Math.round(v * 255)));
    const uv1 = geo.getAttribute('uv1');
    if (uv1) out.lightmapUv = [hit.face.a, hit.face.b, hit.face.c].map(i => [+uv1.getX(i).toFixed(4), +uv1.getY(i).toFixed(4)]);
  } else if (o.isInstancedMesh) {
    Object.assign(out, { kind: 'prop', instance: hit.instanceId, placement: o.userData.list && o.userData.list[hit.instanceId] && o.userData.list[hit.instanceId].name });
  }
  if (mat) {
    out.mapLoaded = !!(mat.map && mat.map.image && mat.map.image.width > 1);
    out.programKey = mat.customProgramCacheKey && mat.customProgramCacheKey().slice(0, 80);
    out.transparent = mat.transparent; out.side = mat.side; out.depthWrite = mat.depthWrite;
  }
  return out;
}

export function attachDebugPick(view) {
  const el = view.renderer.domElement;
  const box = document.createElement('pre');
  box.style.cssText = 'position:absolute;left:72px;bottom:110px;z-index:30;max-width:520px;max-height:50%;overflow:auto;margin:0;padding:8px 10px;' +
    'font:11px/1.35 ui-monospace,monospace;color:#e8e8e8;background:rgba(10,12,16,.85);border-radius:6px;pointer-events:auto;white-space:pre-wrap';
  box.textContent = 'debug: click a surface';
  view.stage.appendChild(box);
  let down = null;
  el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const r = el.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), view.camera);
    const targets = [];
    if (view.world) targets.push(view.world.mesh);
    if (view.props && view.props.models.visible) targets.push(...view.props.models.children);
    const hits = ray.intersectObjects(targets, false);
    if (!hits.length) { box.textContent = 'debug: nothing hit'; return; }
    const info = hits.slice(0, 3).map(h => describe(h, view.camera));
    window.lastPick = info;
    console.log('[debug pick]', info);
    box.textContent = info.map((x, i) => (i ? '\n--- behind it:\n' : '') + JSON.stringify(x, null, 1)).join('');
  });
}
