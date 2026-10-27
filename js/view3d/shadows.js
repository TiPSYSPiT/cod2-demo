/* Character shadows, as CoD2 draws them: "shadow cookies" (gfx_d3d_mp_x86_s.dll: sc_enable, sc_length,
 * sc_blur, sc_fadeRange; techniques "shadowcookie caster" / "shadowcookie receiver"). The world's own
 * shadows are baked into the lightmaps; only the moving models - players (capsules or character models
 * with their weapons) and corpses - throw a soft shadow, projected along the sun onto the world and the
 * props below them.
 *
 * Here: two depth maps from the sun (orthographic, around the point the camera looks at):
 * - the casters (layer COOKIE_LAYER: every mesh of the actors except the markers, userData.noCookie),
 *   SIZE x SIZE over 2 x EXTENT units, every frame;
 * - the occluders (the world and the props, layer WORLD_LAYER; alpha-tested foliage keeps its holes,
 *   blended surfaces are left out), over a wider area, rendered again only when the view moves on.
 * A receiver (receiveCookie: the world's and the props' materials) is darkened where a caster lies
 * between it and the sun, up to LENGTH units behind the caster (the cookie's projection length), and
 * only if it is the first surface the sun reaches there - a player on a roof shades the roof, not the
 * street below. 3 x 3 blur, fading out towards the map's edge.
 * As the game (shadowcookie_receiver.hlsl: the dynamic shadow buffer x (1 - the cookie's coverage), read by
 * lightmap.hlsl / lightprobe.hlsl as a factor of the sun's visibility) the cover takes away the direct sun
 * only: the world's and the props' shaders define COOKIE_SUN_ONLY and use cookieCover() in their sun
 * terms (and so in the specular visibility); materials without a sun term take COOKIE_STRENGTH of their
 * whole light instead (cookieShade). */
import * as THREE from 'three';

export const COOKIE_LAYER = 7;
export const WORLD_LAYER = 8;
const SIZE = 2048;
const EXTENT = 1500;               // half the side of the casters' map, world units
const WORLD_SIZE = 2048;
const WORLD_EXTENT = 2000;         // half the side of the occluders' map
const WORLD_STEP = 400;            // the occluders' map moves in steps of this many units
const LENGTH = 420;                // how far behind a caster its shadow reaches (sc_length)
const STRENGTH = 0.5;              // the share of the light a full shadow takes away (materials without a sun term)
const NEAR = 10, FAR = 12000;
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

/** the uniforms every receiver shares (params x: on, y: one texel of the casters' map, z: LENGTH in depth
 *  units, w: STRENGTH; worldParams x: one texel of the occluders' map, y: the "same surface" tolerance) */
export const COOKIE = {
  map: { value: null },
  matrix: { value: new THREE.Matrix4() },
  params: { value: new THREE.Vector4(0, 1 / SIZE, LENGTH / (FAR - NEAR), STRENGTH) },
  worldMap: { value: null },
  worldMatrix: { value: new THREE.Matrix4() },
  worldParams: { value: new THREE.Vector4(1 / WORLD_SIZE, 12 / (FAR - NEAR), 0, 0) }
};

const VERT_HEAD = 'varying vec3 vCookieW;\n';
const VERT_BODY = `
{
  vec4 cw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    cw = instanceMatrix * cw;
  #endif
  vCookieW = (modelMatrix * cw).xyz;
}`;
const FRAG_HEAD = `#define COOKIE_RECEIVER
varying vec3 vCookieW;
uniform sampler2D uCookieMap;
uniform mat4 uCookieMatrix;
uniform vec4 uCookieParams;
uniform sampler2D uCookieWorldMap;
uniform mat4 uCookieWorldMatrix;
uniform vec4 uCookieWorldParams;
float cookieCover() {
  if (uCookieParams.x < 0.5) return 0.0;
  vec4 p = uCookieMatrix * vec4(vCookieW, 1.0);
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 0.0;
  // only the first surface the sun reaches (the occluders' map: the nearest of 4 texels, so edges hold)
  vec4 q = uCookieWorldMatrix * vec4(vCookieW, 1.0);
  if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
    vec2 o = vec2(uCookieWorldParams.x * 0.5);
    float w = max(max(textureLod(uCookieWorldMap, q.xy + o, 0.0).r, textureLod(uCookieWorldMap, q.xy - o, 0.0).r),
                  max(textureLod(uCookieWorldMap, q.xy + vec2(o.x, -o.y), 0.0).r, textureLod(uCookieWorldMap, q.xy + vec2(-o.x, o.y), 0.0).r));
    if (q.z > w + uCookieWorldParams.y) return 0.0;
  }
  float s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float d = textureLod(uCookieMap, p.xy + vec2(float(i), float(j)) * uCookieParams.y * 1.5, 0.0).r;
    float dz = p.z - d;
    s += step(0.0002, dz) * (1.0 - smoothstep(uCookieParams.z * 0.5, uCookieParams.z, dz));
  }
  vec2 e = abs(p.xy - 0.5) * 2.0;
  return (s / 9.0) * (1.0 - smoothstep(0.75, 1.0, max(e.x, e.y)));
}
float cookieShade() { return 1.0 - uCookieParams.w * cookieCover(); }
`;
/** the receivers' whole-light shadow (left out by the shaders that define COOKIE_SUN_ONLY) */
export const COOKIE_LINE = '#ifndef COOKIE_SUN_ONLY\noutgoingLight *= cookieShade();\n#endif\n';

/** make a material receive the character shadows (keeps an onBeforeCompile it already has) */
export function receiveCookie(mat) {
  if (mat.userData.cookie || mat.blending === THREE.AdditiveBlending) return mat;
  mat.userData.cookie = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uCookieMap = COOKIE.map;
    shader.uniforms.uCookieMatrix = COOKIE.matrix;
    shader.uniforms.uCookieParams = COOKIE.params;
    shader.uniforms.uCookieWorldMap = COOKIE.worldMap;
    shader.uniforms.uCookieWorldMatrix = COOKIE.worldMatrix;
    shader.uniforms.uCookieWorldParams = COOKIE.worldParams;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <project_vertex>', '#include <project_vertex>' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <opaque_fragment>', COOKIE_LINE + '#include <opaque_fragment>');
  };
  // the program cache tells the variants apart by this key (the wrapper's source is the same for all)
  // the program cache key: the previous patch's key (chained), or the previous onBeforeCompile's source
  const prevKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : (k => () => k)(prev ? prev.toString() : '');
  mat.customProgramCacheKey = () => 'cookie|' + prevKey();
  mat.needsUpdate = true;
  return mat;
}

function depthTarget(size) {
  const t = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
  t.depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
  t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
  return t;
}

/** depth materials per source material for the occluders: alpha-tested ones keep their holes, blended
 *  ones occlude nothing (glass, decals, the blended terrain layers lie on surfaces that do) */
class DepthMaterials {
  constructor() { this.map = new WeakMap(); this.none = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }); }
  get(m) {
    if (!m.visible) return this.none;          // (a draw group the game type or an explosion removed)
    let d = this.map.get(m);
    if (d) return d;
    if (m.transparent || m.blending !== THREE.NormalBlending || m.depthWrite === false) d = this.none;
    else {
      d = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
      if (m.alphaTest && m.map) { d.map = m.map; d.alphaTest = m.alphaTest; }
    }
    this.map.set(m, d);
    return d;
  }
  dispose() { this.none.dispose(); }
}

export class CookieShadows {
  constructor() {
    this.target = depthTarget(SIZE);
    this.worldTarget = depthTarget(WORLD_SIZE);
    this.camera = new THREE.OrthographicCamera(-EXTENT, EXTENT, EXTENT, -EXTENT, NEAR, FAR);
    this.camera.layers.set(COOKIE_LAYER);
    this.worldCamera = new THREE.OrthographicCamera(-WORLD_EXTENT, WORLD_EXTENT, WORLD_EXTENT, -WORLD_EXTENT, NEAR, FAR);
    this.worldCamera.layers.set(WORLD_LAYER);
    this.depth = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    this.worldDepth = new DepthMaterials();
    this.worldKey = null;          // where the occluders' map was rendered last
    this.enabled = true;
    COOKIE.map.value = this.target.depthTexture;
    COOKIE.worldMap.value = this.worldTarget.depthTexture;
  }

  setEnabled(on) { this.enabled = on; COOKIE.params.value.x = on ? 1 : 0; }
  /** the world or the props changed (props mode, a map loaded): the occluders' map again */
  invalidate() { this.worldKey = null; }

  /** a camera looking along -toSun at center, the centre snapped to whole steps of the light's view */
  place(cam, center, dir, step) {
    cam.up.set(0, 0, 1);
    if (Math.abs(dir.z) > 0.99) cam.up.set(1, 0, 0);
    cam.position.copy(dir).multiplyScalar(6000);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const local = center.clone().applyMatrix4(cam.matrixWorldInverse);
    local.x = Math.round(local.x / step) * step; local.y = Math.round(local.y / step) * step;
    const snapped = local.clone().applyMatrix4(cam.matrixWorld);
    cam.position.copy(snapped).addScaledVector(dir, 6000);
    cam.lookAt(snapped);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return local.x + ',' + local.y;
  }

  /** render one map: the meshes on the camera's layer, with depth materials */
  pass(renderer, scene, cam, target, swap) {
    const keep = { target: renderer.getRenderTarget(), override: scene.overrideMaterial, background: scene.background, fog: scene.fog };
    const swapped = [];
    if (swap) {
      scene.traverse(o => {
        if (!o.isMesh || !o.layers.test(cam.layers)) return;
        swapped.push([o, o.material]);
        o.material = Array.isArray(o.material) ? o.material.map(m => swap.get(m)) : swap.get(o.material);
      });
    } else scene.overrideMaterial = this.depth;
    scene.background = null; scene.fog = null;
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(keep.target);
    for (const [o, m] of swapped) o.material = m;
    scene.overrideMaterial = keep.override; scene.background = keep.background; scene.fog = keep.fog;
  }

  /** casters: the meshes under actorRoots; occluders: the meshes under worldRoots; toSun: unit vector
   *  towards the sun; center: the point the shadows are wanted around */
  update(renderer, scene, actorRoots, worldRoots, center, toSun) {
    if (!this.enabled) { COOKIE.params.value.x = 0; return; }
    const dir = toSun.clone().normalize();
    // the occluders' map, when the view moved to another step (or the sun / the world changed)
    const key = this.place(this.worldCamera, center, dir, WORLD_STEP) + '|' + dir.toArray().join(',');
    if (key !== this.worldKey) {
      for (const root of worldRoots) root.traverse(o => { if (o.isMesh) o.layers.enable(WORLD_LAYER); });
      this.pass(renderer, scene, this.worldCamera, this.worldTarget, this.worldDepth);
      COOKIE.worldMatrix.value.copy(BIAS).multiply(this.worldCamera.projectionMatrix).multiply(this.worldCamera.matrixWorldInverse);
      this.worldKey = key;
    }
    // the casters' map, every frame (snapped to whole texels, so the shadows do not crawl)
    for (const root of actorRoots) root.traverse(o => { if (o.isMesh && !o.userData.noCookie) o.layers.enable(COOKIE_LAYER); });
    this.place(this.camera, center, dir, 2 * EXTENT / SIZE);
    this.pass(renderer, scene, this.camera, this.target, null);
    COOKIE.matrix.value.copy(BIAS).multiply(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);
    COOKIE.params.value.x = 1;
  }

  dispose() {
    this.target.dispose(); this.worldTarget.dispose(); this.depth.dispose(); this.worldDepth.dispose();
    COOKIE.params.value.x = 0; COOKIE.map.value = null; COOKIE.worldMap.value = null;
  }
}
