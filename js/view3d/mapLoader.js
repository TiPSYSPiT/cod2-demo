/* Loads the exported map (maps3d/<map>/, written by tools/export/export_maps.py) into three.js
 * objects: the textured, lightmapped world and the objectives. CoD world coordinates stay as they are
 * (+Z up); the camera's up vector is Z. Without exported data the 2D background becomes a ground
 * plane (or a grid). */
import * as THREE from 'three';
import { fetchJSON, fetchBinary, checkedView, dataUrl } from './data.js';
import { receiveCookie } from './shadows.js';
import { GRID_SUN, applySun, SPECULARITY_GLSL } from './lightGrid.js';

const C2 = window.C2;
const BASE = 'maps3d/';
export const LIGHTMAP_SCALE = 1.25;         // the old exports' lightmap (world.json without lightmapFormat 2) x this
let manifest = null;

/* The game's fog (lib/fogcalc.hlsl): the radial distance from the eye, not three's view depth; setExpFog
 * exp(-density x distance) (three's FogExp2 squares both), setCullFog linear from near to far (three's Fog a
 * smoothstep) - every material's fog chunks, as the game has one fog for the whole frame (view3d.js sets it
 * from world.json's fog) */
THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = length( mvPosition.xyz );');
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment
  .replace('float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );', 'float fogFactor = 1.0 - exp( - fogDensity * vFogDepth );')
  .replace('float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );', 'float fogFactor = clamp( ( vFogDepth - fogNear ) / max( fogFar - fogNear, 1.0 ), 0.0, 1.0 );');
/** world.json's fog -> a three.js fog with the game's formula, or null (the competitive maps set none) */
export function gameFog(fog) {
  if (!fog || !fog.color) return null;
  const c = new THREE.Color().setRGB(fog.color[0], fog.color[1], fog.color[2]);     // (gamma-space colours, as the game)
  if (fog.kind === 'exp' && fog.density > 0) return new THREE.FogExp2(c, fog.density);
  if (fog.kind === 'linear' && fog.far > fog.near) return new THREE.Fog(c, fog.near, fog.far);
  return null;
}

/* The textures' anisotropic filtering: the most the GPU has, at most 16 (view3d.js sets it before a map loads) */
let maxAnisotropy = 4;
export function setMaxAnisotropy(n) { maxAnisotropy = Math.max(1, Math.min(16, n || 1)); }
export function anisotropy() { return maxAnisotropy; }

/** maps3d/index.json (cached); { maps: {} } when there is none */
async function loadManifest() {
  if (manifest !== null) return manifest;
  try { manifest = await fetchJSON(BASE + 'index.json', { cache: 'no-cache' }); } catch (err) { console.warn('maps3d/index.json:', err.message); manifest = { maps: {} }; }
  return manifest;
}

/** raw map name of the demo -> the exported map to use (exact name, else the registry key) */
export async function resolveMap(raw) {
  const m = await loadManifest();
  const name = String(raw || '').toLowerCase();
  if (Object.hasOwn(m.maps, name)) return name;            // (own keys: "__proto__" is no map)
  const key = C2.maps && C2.maps.resolve(name);
  return key && Object.hasOwn(m.maps, key) ? key : null;
}

const ARRAYS = { float32: Float32Array, int8: Int8Array, uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array };
function view(buf, a, what = 'world.bin') { const T = ARRAYS[a.type]; return checkedView(T, buf, a.offset, a.length / T.BYTES_PER_ELEMENT, what); }

/** a texture: decoded off the main thread (createImageBitmap) - an <img> is decoded, flipped and converted on the
 *  main thread when three.js uploads it (2 s of a map's load, PLAN.md step 87). The decode does what the upload did
 *  for an image: flipped when the texture is (its flipY - set by the caller right after this returns), alpha
 *  premultiplied when the texture asks, no colour conversion (three.js converts only between other primaries than
 *  the working ones - none of ours); three.js leaves an ImageBitmap as it is. Where the browser lacks an option
 *  of createImageBitmap, the <img> as before. A texture that fails to load is drawn neutral grey (and warned about) */
let grey = null;
let bitmaps = typeof createImageBitmap === 'function';
export function loadTexture(url) {
  const t = new THREE.Texture();
  t.userData.inflight = true; inflight++;
  const failed = () => {
    console.warn('texture not loaded - drawn neutral grey:', url);
    if (!grey) { grey = document.createElement('canvas'); grey.width = grey.height = 1; const g = grey.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 1, 1); }
    t.image = grey; t.needsUpdate = true;
    arrived(t);
  };
  const viaImage = () => new THREE.ImageLoader().load(dataUrl(url), img => { t.image = img; t.needsUpdate = true; arrived(t); }, undefined, failed);
  if (!bitmaps) { viaImage(); return t; }
  // (low priority, as an <img> had: after the world's and the models' data, which a slow line delivers first)
  fetch(dataUrl(url), { priority: 'low' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(blob => {
    const o = { premultiplyAlpha: t.premultiplyAlpha ? 'premultiply' : 'none', colorSpaceConversion: 'none' };
    if (t.flipY) o.imageOrientation = 'flipY';
    t.userData.src = url; t.userData.decode = o;           // (to decode it again after a lost WebGL context: reloadTextures)
    return createImageBitmap(blob, o).then(img => {
      t.image = img; t.flipY = false; t.premultiplyAlpha = false; t.needsUpdate = true;
      // (the decoded copy let go once the GPU has it - the browser keeps an <img>'s pixels as a cache it may drop,
      // an ImageBitmap's for good: 400 MB more over a map. Its size stays readable. Kept: the images read later -
      // userData.keepImage, the light maps the light probe samples. No texture is uploaded twice: each view
      // loads its own)
      t.onUpdate = () => {
        t.onUpdate = null;
        t.userData.uploaded = true;
        if (!t.userData.keepImage) dropImage(t);
      };
      // (on the GPU at once - the 3D view's renderer.initTexture: a texture not drawn yet, a far LOD's, would keep
      // its decoded copy until it is)
      if (textureArrivals.upload) textureArrivals.upload(t);
      arrived(t);
    }, err => { if (err instanceof TypeError) { bitmaps = false; viaImage(); } else failed(); });
  }).catch(failed);
  return t;
}

/** a texture's decoded image let go (an ImageBitmap closed, its size kept readable) once the GPU has it - now, or
 *  at its upload (loadTexture) */
export function dropImage(t) {
  t.userData.keepImage = false;
  const img = t.image;
  if (!t.userData.uploaded || !img || typeof img.close !== 'function') return;
  t.image = { width: img.width, height: img.height };
  img.close();
  if (t.userData.src) dropped.add(new WeakRef(t));
}

/* A lost WebGL context (a driver reset, the GPU process restarted, another GPU) takes every texture with it; three.js
 * uploads them again from their images once the context is back - a released image is gone, so those textures are
 * decoded again (the browser's cache has the files). Weak: a texture of a closed view goes as before. */
const dropped = new Set();
/** the released textures decoded and uploaded again (after webglcontextrestored) -> Promise */
export function reloadTextures() {
  const list = [];
  for (const ref of dropped) {
    const t = ref.deref();
    dropped.delete(ref);
    if (t && t.image && typeof t.image.close !== 'function' && !(t.image instanceof Element)) list.push(t);
  }
  return Promise.all(list.map(t => fetch(dataUrl(t.userData.src), { priority: 'low' }).then(r => r.blob())
    .then(blob => createImageBitmap(blob, t.userData.decode)).then(img => {
      t.image = img; t.userData.uploaded = false; t.needsUpdate = true;
      t.onUpdate = () => { t.onUpdate = null; t.userData.uploaded = true; dropImage(t); };
    }).catch(err => console.warn('texture not reloaded after the WebGL context came back:', t.userData.src, err))));
}

/* Until a texture has arrived three.js samples it black (whole lightmapped areas, every vehicle). The
 * materials therefore start on a shared 1 x 1 stand-in and switch to the texture when it is there (a
 * stand-in cannot simply grow into the real image: the GPU storage keeps its first size). */
const STANDINS = { grey: [128, 128, 124, 255], clear: [0, 0, 0, 0], light: [150, 150, 150, 255], flat: [128, 128, 128, 255], black: [0, 0, 0, 255], white: [255, 255, 255, 255] };
const standins = {};
function standin(kind) {
  if (!standins[kind]) {
    const t = new THREE.DataTexture(new Uint8Array(STANDINS[kind]), 1, 1);
    t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    standins[kind] = t;
  }
  return standins[kind];
}
/** the closed 3D view's renderer off the shared stand-ins: three.js hangs a dispose listener on every
 *  texture it uploads, and the listener holds the renderer (and with it the view and its demo) - a
 *  module-level texture never disposed keeps every closed view in memory. The next view uploads them anew. */
export function releaseStandins() {
  for (const t of Object.values(standins)) t.dispose();
}
/** called with each texture that arrives (the 3D view redraws) */
export const textureArrivals = { onArrive: null, upload: null };

/* The textures still on their way: what waits for them (texturesIn) - the sounds' preload and the HUD's images,
 * which would otherwise share the line with the map's textures (sound.js, hud.js; PLAN.md step 87) */
let inflight = 0, whenIn = [];
/** -> Promise, resolved once no texture is on its way any more (at the latest after maxMs) */
export function texturesIn(maxMs = 15000) {
  return new Promise(resolve => {
    if (!inflight) { resolve(); return; }
    whenIn.push(resolve);
    setTimeout(resolve, maxMs);
  });
}
function arrived(t) {
  if (t.userData.inflight) {
    t.userData.inflight = false;
    if (--inflight === 0 && whenIn.length) { const list = whenIn; whenIn = []; for (const f of list) f(); }
  }
  const list = t.userData.waiting;
  t.userData.waiting = null;
  if (list) for (const f of list) f();
  if (textureArrivals.onArrive) textureArrivals.onArrive(t);
}
/** mat[slot] = tex, through a stand-in while it loads: kind 'grey' (opaque colour map), 'clear'
 *  (alpha-tested / blended: nothing shows), 'light' (light map) */
export function setMap(mat, slot, tex, kind = 'grey') {
  if (!tex) return;
  if (tex.image) { mat[slot] = tex; return; }
  mat[slot] = standin(kind);
  (tex.userData.waiting = tex.userData.waiting || []).push(() => { mat[slot] = tex; mat.needsUpdate = true; });
}
/** a patched shader's own map as a uniform {value}, through a stand-in while it loads: kind 'flat' (normal
 *  map / detail map: no change), 'black' (specular map: no highlight) */
export function uniformMap(tex, kind) {
  const u = { value: tex };
  if (tex && !tex.image) {
    u.value = standin(kind);
    (tex.userData.waiting = tex.userData.waiting || []).push(() => { u.value = tex; });
  }
  return u;
}

/** the game's world shader (lightmap.hlsl): albedo x (lightmap + the sun's visibility x the sun x N.L).
 * Without a normal map the lightmap (lightmapFormat 2) holds the light the 4 coefficients give a flat
 * surface; with one (lightmapCoefs + the group's normalMap) the 4 coefficient images are weighted per
 * pixel by the normal map sample ($lightmapweights, lmWeights below) and N.L takes the bumped normal
 * (N + (2x - 1) T + (2y - 1) B, the BSP's tangent frame). The sun mask (sun<N>.webp) shows where the sun
 * reaches; the sun from the map's keys (lightGrid.js applySun). With a specular map (phong.hlsl) the sun's
 * highlight is added: the sun's colour (r_specularColorScale 1) x the map's colour x $specularity(the
 * power, N.H) x mix(0.3, 1, the sun's visibility); the power rides in the normal map's blue channel. */
const LM_WEIGHTS_GLSL = `
vec4 lmWeights( vec2 s ) {
  vec2 n = s * 2.0 - 1.0;
  float z2 = 1.0 - dot( n, n );
  if ( z2 < 0.0 ) { n = normalize( n ); z2 = 0.0; }
  float a = dot( n, n ) > 1e-8 ? atan( n.y, n.x ) * 0.477464829275686 - 0.75 : 0.0;
  if ( a < 0.0 ) a += 3.0; else if ( a > 3.0 ) a -= 3.0;
  float w1, w2, w3;
  if ( a >= 2.0 ) { w1 = a - 2.0; w2 = 0.0; w3 = 3.0 - a; }
  else if ( a >= 1.0 ) { w1 = 0.0; w2 = 2.0 - a; w3 = a - 1.0; }
  else { w1 = 1.0 - a; w2 = a; w3 = 0.0; }
  float up = clamp( 1.0 - acos( min( 1.0, sqrt( z2 ) ) ) / 0.9553166, 0.0, 1.0 );
  return vec4( up, vec3( w1, w2, w3 ) * ( 1.0 - up ) );
}
`;
function gameLightmap(mat, sunMask, coefs, normalMap, specMap) {
  const prev = mat.onBeforeCompile;
  const bumped = !!(coefs && normalMap);
  const specular = bumped && !!specMap;
  const uniforms = { uSunMask: { value: sunMask } };
  if (bumped) {
    uniforms.uNormalMap = uniformMap(normalMap, 'flat');
    coefs.forEach((t, k) => { uniforms['uLmc' + k] = { value: t }; });
  }
  if (specular) uniforms.uSpecMap = uniformMap(specMap, 'black');
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uSunColor = GRID_SUN.color;
    shader.uniforms.uSunDir = GRID_SUN.dir;
    const vHead = 'varying vec3 vLmN;' + (bumped ? '\nattribute vec3 cTangent;\nattribute vec3 cBinormal;\nvarying vec3 vLmT;\nvarying vec3 vLmB;' : '') +
      (specular ? '\nvarying vec3 vLmW;' : '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + vHead)
      .replace('#include <project_vertex>', '#include <project_vertex>\nvLmN = normal;' + (bumped ? '\nvLmT = cTangent;\nvLmB = cBinormal;' : '') +
        (specular ? '\nvLmW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;' : ''));
    const fHead = '#define COOKIE_SUN_ONLY\nvarying vec3 vLmN;\nuniform sampler2D uSunMask;\nuniform vec3 uSunColor;\nuniform vec3 uSunDir;' +
      (bumped ? '\nvarying vec3 vLmT;\nvarying vec3 vLmB;\nuniform sampler2D uNormalMap;\nuniform sampler2D uLmc0;\nuniform sampler2D uLmc1;\nuniform sampler2D uLmc2;\nuniform sampler2D uLmc3;' + LM_WEIGHTS_GLSL : '') +
      (specular ? '\nvarying vec3 vLmW;\nuniform sampler2D uSpecMap;' + SPECULARITY_GLSL : '');
    const light = bumped
      ? `vec3 nsp = texture2D( uNormalMap, vMapUv ).xyz;
vec2 ns = nsp.xy;
vec4 lw = lmWeights( ns );
vec3 lmLight = lw.x * texture2D( uLmc0, vLightMapUv ).rgb + lw.y * texture2D( uLmc1, vLightMapUv ).rgb
  + lw.z * texture2D( uLmc2, vLightMapUv ).rgb + lw.w * texture2D( uLmc3, vLightMapUv ).rgb;
vec3 lmN = normalize( vLmN + ( ns.x * 2.0 - 1.0 ) * vLmT + ( ns.y * 2.0 - 1.0 ) * vLmB );
`
      : 'vec3 lmLight = texture2D( lightMap, vLightMapUv ).rgb;\nvec3 lmN = normalize( vLmN );\n';
    const spec = specular
      ? `vec3 lmH = normalize( normalize( cameraPosition - vLmW ) + uSunDir );
vec3 lmSpec = uSunColor * texture2D( uSpecMap, vMapUv ).rgb * specularity( nsp.z, dot( lmH, lmN ) ) * mix( 0.3, 1.0, lmSun );
`
      : 'vec3 lmSpec = vec3( 0.0 );\n';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + fHead)
      .replace('#include <opaque_fragment>', light + 'float lmSun = texture2D( uSunMask, vLightMapUv ).r;\n' +
        '#ifdef COOKIE_RECEIVER\nlmSun *= 1.0 - cookieCover();\n#endif\n' + spec +
        'outgoingLight = diffuseColor.rgb * ( lmLight + lmSun * uSunColor * max( 0.0, dot( lmN, uSunDir ) ) ) + lmSpec;\n#include <opaque_fragment>');
  };
  // the program cache key: the previous patch's key (chained), or the previous onBeforeCompile's source
  const prevKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : (k => () => k)(prev ? prev.toString() : '');
  mat.customProgramCacheKey = () => 'lmap2' + (bumped ? 'n' : '') + (specular ? 's' : '') + '|' + prevKey();
  return mat;
}

/** the detail map (shade.hlsl TexturedDiffuse): colour map + the detail map tiled detailScale times - 0.5 */
export function detailMap(mat, tex, scale) {
  const prev = mat.onBeforeCompile;
  const uniforms = { uDetailMap: uniformMap(tex, 'flat'), uDetailScale: { value: new THREE.Vector2(...(scale || [1, 1])) } };
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetailMap;\nuniform vec2 uDetailScale;')
      .replace('#include <map_fragment>', `#ifdef USE_MAP
vec4 sampledDiffuseColor = texture2D( map, vMapUv );
sampledDiffuseColor.rgb += texture2D( uDetailMap, vMapUv * uDetailScale ).rgb - 0.5;
diffuseColor *= sampledDiffuseColor;
#endif`);
  };
  const prevKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : (k => () => k)(prev ? prev.toString() : '');
  mat.customProgramCacheKey = () => 'detail|' + prevKey();
  return mat;
}

/** the material's polygon offset (its polygon offset level, cod2/material.py), as the game sets it: depth bias
 *  level x r_polygonOffsetBias (-1) / 65536, slope bias level x r_polygonOffsetScale (-1) - on a 24-bit depth
 *  buffer glPolygonOffset(-level, -256 x level), as the Mac client converts it. Level 0 on a blended layer: the
 *  small offset of before (it lies exactly on the surface below; two shader programs may round its depth
 *  differently) -> material options */
export function polygonOffset(opts, level, blended = false) {
  if (level > 0) return Object.assign(opts, { polygonOffset: true, polygonOffsetFactor: -level, polygonOffsetUnits: -256 * level });
  if (blended) return Object.assign(opts, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  return opts;
}
/** a group's polygon offset level (data exported before the level was: the decals by name) */
const offsetLevel = g => (g.polygonOffset != null ? g.polygonOffset : g.decal ? 1 : 0);
/** a group's sort key, the game's draw order (cod2/material.py; older data: opaque 3, decals 9, blended 27) */
const sortKey = g => (g.sort != null ? g.sort : g.blend || g.vertexAlpha ? 27 : g.decal ? 9 : 3);

/** a multiply decal (techniques effect_multiply*, blend Zero x SrcColor: mul.hlsl): the framebuffer x
 *  mix(1, colour map x vertex colour, vertex alpha) - white leaves the surface below as it is, the grime
 *  darkens it; unlit, no depth writes, no fog, no shadow cookie (the surface below has it). Without vertex
 *  colours (opts.vertexColors false: the props) the colour map alone; level: its polygon offset level */
/** a material's copy with its userData copied shallow: three.js's Material.copy copies userData through JSON - a
 *  texture in it (the normal / specular maps' uniforms, characters.js) would be encoded as an image (slow) and come
 *  back as plain data, not a texture */
export function cloneMaterial(m) {
  const ud = m.userData;
  m.userData = {};
  const c = m.clone();
  m.userData = ud;
  c.userData = Object.assign({}, ud);
  return c;
}

export function multiplyMaterial(tex, opts = {}, level = 1) {
  const mat = new THREE.MeshBasicMaterial(polygonOffset(Object.assign({ vertexColors: true }, opts, {
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    // the canvas' alpha stays as the surface below left it: with the colour's factors the decal multiplied it down
    // too, and where the canvas is read as an image (the video export, a screenshot) the colour un-premultiplied by
    // that alpha burned out to white (the dirt decals on mp_burgundy_fix's streets)
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
  }), level, true));
  setMap(mat, 'map', tex, 'white');          // (white while it loads: no change to the surface below)
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
      '#ifdef USE_COLOR_ALPHA\noutgoingLight = mix( vec3( 1.0 ), diffuseColor.rgb, vColor.a );\n#endif\n#include <opaque_fragment>')
      // in the fog the decal fades to white - it multiplies the fogged surface below (the game corrects that in a
      // second pass, lib/multiply_fog.hlsl; this matches it unfogged and fully fogged)
      .replace('#include <fog_fragment>', THREE.ShaderChunk.fog_fragment.replace('fogColor', 'vec3( 1.0 )'));
  };
  mat.customProgramCacheKey = () => 'multiply';
  mat.userData.multiply = true;
  return mat;
}

/** the water (technique water, water.hlsl): a ripple height field (three octaves of noise, lacunarity 3.7,
 *  scale 0.6 - the game reads them from a code image, here value noise of 128 cells per texture unit), its
 *  normal reflects the eye into the cube map (z mirrored up); colour = mix(waterColor x N.z, the cube's
 *  colour, the cube's alpha) + the sun x max(0, R.L)^64; opaque, unlit, no lightmap */
function waterMaterial(g, env) {
  const w = g.water;
  const mat = new THREE.MeshBasicMaterial({ side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide, forceSinglePass: true });
  const uniforms = {
    uEnv: uniformMap(env, 'black'), uEnvSize: { value: w.envSize || 128 }, uHasEnv: { value: env ? 1 : 0 },
    uWaterColor: { value: new THREE.Vector3(...w.color) }
  };
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uSunColor = GRID_SUN.color;
    shader.uniforms.uSunDir = GRID_SUN.dir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterW;\nvarying vec2 vWaterUv;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWaterW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWaterUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWaterW;
varying vec2 vWaterUv;
uniform sampler2D uEnv;
uniform float uEnvSize;
uniform float uHasEnv;
uniform vec3 uWaterColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
float wHash( vec2 p ) { return fract( sin( dot( mod( p, 128.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float wNoise( vec2 uv ) {
  vec2 p = uv * 128.0, i = floor( p ), f = p - i;
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0 ) ), u.x ), u.y );
}
// the octaves fade out where their cells get smaller than a pixel (fw: cells of the first per pixel) -
// the game's noise image has mipmaps; procedural noise would sparkle
float wTurb( vec2 uv, float fw ) {
  return wNoise( uv ) * clamp( 2.0 - 2.0 * fw, 0.0, 1.0 ) + 0.6 * wNoise( uv * 3.7 ) * clamp( 2.0 - 7.4 * fw, 0.0, 1.0 )
    + 0.36 * wNoise( uv * 13.69 ) * clamp( 2.0 - 27.38 * fw, 0.0, 1.0 );
}
vec4 wCube( vec3 c ) {      // the cube strip, as sky.js (D3D faces +X -X +Y -Y +Z -Z)
  vec3 a = abs( c ); float ma, sc, tc, f;
  if ( a.x >= a.y && a.x >= a.z ) { ma = a.x; if ( c.x > 0.0 ) { f = 0.0; sc = -c.z; tc = -c.y; } else { f = 1.0; sc = c.z; tc = -c.y; } }
  else if ( a.y >= a.z ) { ma = a.y; if ( c.y > 0.0 ) { f = 2.0; sc = c.x; tc = c.z; } else { f = 3.0; sc = c.x; tc = -c.z; } }
  else { ma = a.z; if ( c.z > 0.0 ) { f = 4.0; sc = c.x; tc = -c.y; } else { f = 5.0; sc = -c.x; tc = -c.y; } }
  float m = 0.5 / uEnvSize;
  vec2 uv = clamp( vec2( sc, tc ) / ma * 0.5 + 0.5, m, 1.0 - m );
  return textureLod( uEnv, vec2( ( f + uv.x ) / 6.0, uv.y ), 0.0 );
}`)
      .replace('#include <opaque_fragment>', `{
  vec3 eyeDir = normalize( vWaterW - cameraPosition );
  vec2 tc = vWaterUv;
  float err = 0.5 - wNoise( tc * 0.5 );            // one parallax step, as the game
  tc += err * eyeDir.xy * ( 1.5 / 64.0 );
  float fw = max( length( dFdx( vWaterUv ) ), length( dFdy( vWaterUv ) ) ) * 128.0;
  float h00 = wTurb( tc, fw ), h10 = wTurb( tc + vec2( 0.5 / 128.0, 0.0 ), fw ), h01 = wTurb( tc + vec2( 0.0, 0.5 / 128.0 ), fw );
  vec3 n = normalize( vec3( h10 - h00, h01 - h00, 1.0 ) );
  vec3 r = reflect( eyeDir, n );
  float spec = pow( max( 0.0, dot( r, uSunDir ) ), 64.0 );
  r.z = abs( r.z );
  vec4 env = uHasEnv > 0.5 ? wCube( r ) : vec4( 0.0 );
  outgoingLight = mix( uWaterColor * n.z, env.rgb, env.a ) + spec * uSunColor;
}
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'water';
  mat.name = g.material;
  mat.userData.group = g;
  return mat;
}

/** material of one draw group (world.json groups) */
function makeMaterial(g, tex, lightmaps, sunMasks, coefs, normalMap, specMap, detail, env) {
  if (g.water) return waterMaterial(g, env);      // (no shadow cookie: water.hlsl has no dynamic shadow)
  if (g.blend === 'multiply') {
    const mat = multiplyMaterial(tex, { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide, forceSinglePass: true }, offsetLevel(g));
    mat.name = g.material;
    mat.userData.group = g;
    return mat;
  }
  // (forceSinglePass: a blended double-sided surface in one pass, as the game draws it with culling off - three.js's
  // default draws it twice, back faces then front faces, and marks the material for a new program before each)
  const opts = { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide, forceSinglePass: true };
  if (!tex) opts.color = new THREE.Color('#8a8a84');
  const lm = g.lightmap >= 0 ? lightmaps[g.lightmap] : null;
  if (lm) opts.lightMapIntensity = LIGHTMAP_SCALE * Math.PI;
  // the vertex colour multiplies the colour map on every surface (lib/shade.hlsl ColoredTexturedDiffuse: the
  // lightmapped ones' tint and their alpha - the blended layers fade by it -, the others' baked light)
  opts.vertexColors = true;
  if (g.alphaTest && g.textureAlpha) {
    opts.alphaTest = 0.5;
    opts.alphaToCoverage = true;               // (soft cut-out edges with the canvas' multisampling: fences, leaves)
  }
  if (g.blend) {
    opts.transparent = true; opts.depthWrite = false;
    if (g.blend === 'add') opts.blending = THREE.AdditiveBlending;
  }
  // the decals (alpha-tested ones too: rubble, posters, rugs) lie on the surfaces below - without the offset they
  // fight them for the depth, flickering with every small move of the camera
  polygonOffset(opts, offsetLevel(g), !!(g.blend || g.vertexAlpha));
  // lightmapped surfaces are drawn as the game does: albedo x baked light, no scene lights on top
  const mat = lm ? new THREE.MeshBasicMaterial(opts) : new THREE.MeshLambertMaterial(opts);
  mat.name = g.material;
  mat.userData.group = g;                    // (the ?debug surface picker, debugPick.js)
  setMap(mat, 'map', tex, opts.alphaTest || g.blend || g.vertexAlpha ? 'clear' : 'grey');
  setMap(mat, 'lightMap', lm, 'light');
  // the blended layers: colour map alpha x vertex alpha (the vertex colours' alpha, above)
  if (g.vertexAlpha) mat.transparent = true;
  if (detail && tex) detailMap(mat, detail, g.detailScale);
  if (lm && sunMasks) gameLightmap(mat, sunMasks[g.lightmap], normalMap && coefs ? coefs[g.lightmap] : null, normalMap, specMap);
  return receiveCookie(mat);                 // the players' shadows (shadows.js)
}

/* The world is one mesh with a group per material: three.js culls it as a whole, so every group was drawn from
 * anywhere on the map. Per render (each camera: the view, the shadows' sun) only the groups whose bounding sphere
 * meets the camera's frustum stay in the geometry's list - the same groups in the same order, so the draw order
 * (decals, blended layers) does not change; the full list is back after the render (ray casts, compiles). */
/** the bounding sphere of each of the geometry's groups (from its indexed vertices) */
function groupSpheres(geo) {
  const pos = geo.attributes.position.array, idx = geo.index.array, box = new THREE.Box3(), v = new THREE.Vector3();
  return geo.groups.map(g => {
    box.makeEmpty();
    for (let i = g.start, e = g.start + g.count; i < e; i++) { const k = idx[i] * 3; box.expandByPoint(v.set(pos[k], pos[k + 1], pos[k + 2])); }
    return box.getBoundingSphere(new THREE.Sphere());
  });
}
/** the world mesh culled group by group while `scene` renders (scene.onBeforeRender / onAfterRender) */
export function cullWorldGroups(scene, mesh) {
  const geo = mesh.geometry, all = geo.groups, spheres = groupSpheres(geo);
  const frustum = new THREE.Frustum(), m = new THREE.Matrix4(), s = new THREE.Sphere(), shown = [];
  scene.onBeforeRender = (renderer, sc, camera) => {
    m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    shown.length = 0;
    for (let i = 0; i < all.length; i++) if (frustum.intersectsSphere(s.copy(spheres[i]).applyMatrix4(mesh.matrixWorld))) shown.push(all[i]);
    geo.groups = shown;
  };
  scene.onAfterRender = () => { geo.groups = all; };
}

/** the world mesh + objectives of an exported map -> {group, info, mesh, sites, entities} */
export async function loadWorld(mapName, { onProgress } = {}) {
  const t0 = performance.now();
  const dir = BASE + mapName + '/';
  const info = await fetchJSON(dir + 'world.json');
  const expected = Math.max(...Object.values(info.layout).map(a => a.offset + a.length));
  const buf = await fetchBinary(dir + info.file, { expected, onProgress });
  const L = info.layout;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(view(buf, L.position), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(view(buf, L.uv), 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(view(buf, L.uv2), 2, true));
  geo.setAttribute('color', new THREE.BufferAttribute(view(buf, L.color), 4, true));
  geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(view(buf, L.normal), 4), 3, 0, true));
  // the BSP's tangent frame (normal-mapped lightmapped surfaces, gameLightmap)
  if (L.tangent && L.binormal) {
    geo.setAttribute('cTangent', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(view(buf, L.tangent), 4), 3, 0, true));
    geo.setAttribute('cBinormal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(view(buf, L.binormal), 4), 3, 0, true));
  }
  geo.setIndex(new THREE.BufferAttribute(view(buf, L.index), 1));
  geo.computeBoundingSphere();

  const texCache = new Map();
  const texture = (file, repeat) => {
    if (!file) return null;
    if (texCache.has(file)) return texCache.get(file);
    const t = loadTexture(BASE + file);
    t.flipY = false;                                        // D3D texture coordinates: v = 0 at the top
    t.colorSpace = THREE.NoColorSpace;                      // gamma-space math, like the game
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAnisotropy; }
    texCache.set(file, t);
    return t;
  };
  // the water's reflection cubes (a strip of six faces, read in the shader: no mipmaps, clamped)
  const envTexture = file => {
    const t = texture(file, false);
    if (t) { t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter; }
    return t;
  };
  const lightmaps = (info.lightmaps || []).map(f => {
    const t = f ? texture(mapName + '/' + f, false) : null;
    if (t) { t.channel = 1; t.userData.keepImage = true; }   // sampled with the lightmap coordinates (uv1); read by the light probe
    return t;
  });
  // the game's lightmaps (lightmapFormat 2): the light + the sun's visibility (a black stand-in until it arrives)
  const sunMasks = info.lightmapFormat === 2 && info.sunMasks ? info.sunMasks.map(f => { const t = f ? texture(mapName + '/' + f, false) : null; if (t) t.userData.keepImage = true; return t; }) : null;
  if (sunMasks) applySun(info.sun);
  // the lightmaps' 4 coefficients (for the normal-mapped surfaces; needs the tangent frame)
  const coefs = sunMasks && info.lightmapCoefs && L.tangent ? info.lightmapCoefs.map(list => list.map(f => {
    const t = texture(mapName + '/' + f, false);
    t.channel = 1;
    return t;
  })) : null;
  const materials = [];
  // in the game's draw order (the sort key: opaque, then the decal layers from the bottom up, then the blended):
  // three draws a mesh's opaque groups by material id and its transparent ones in the groups' order - so the
  // materials are made and the groups added in that order
  const order = info.groups.map((g, i) => [sortKey(g), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, gi] of order) {
    const g = info.groups[gi];
    if (g.sky) continue;                                    // the sky is drawn by sky.js
    geo.addGroup(g.start, g.count, materials.length);
    const normalMap = coefs && g.normalMap ? texture(g.normalMap, true) : null;
    const m = makeMaterial(g, texture(g.texture, true), lightmaps, sunMasks, coefs, normalMap,
      normalMap && g.specularMap ? texture(g.specularMap, true) : null, texture(g.detailMap, true), g.water && envTexture(g.water.envMap));
    materials.push(m);
  }
  const mesh = new THREE.Mesh(geo, materials);
  mesh.name = 'world';
  mesh.matrixAutoUpdate = false;
  const group = new THREE.Group();
  group.add(mesh);
  const out = { group, info, mesh, lightmaps, sunMasks, lightScale: sunMasks ? 1 : LIGHTMAP_SCALE, sites: [], entities: null };
  out.worldMs = performance.now() - t0;
  try {
    const ej = await fetchJSON(dir + 'entities.json');
    out.entities = ej;
    out.sites = siteLabels(ej);
  } catch (err) { out.sites = []; }
  return out;
}

/* ---------- objectives: S&D bomb sites (labels A / B) ---------- */
function siteLabels(ej) {
  const zones = (ej.objectives || []).filter(e => e.targetname === 'bombzone' && e.origin);
  // CoD2's bomb zones carry script_label "A" / "B" on some maps; else by order
  return zones.map((e, i) => ({ label: String(e.label || String.fromCharCode(65 + i)).replace(/^_/, '').toUpperCase(), origin: e.origin }));
}

/** fallback without exported geometry: a grid plane under the players */
export function groundPlane(match) {
  const R = match.rect, z = match.zRange[0] - 2;
  const group = new THREE.Group();
  const w = R.maxX - R.minX, h = R.maxY - R.minY;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), receiveCookie(new THREE.MeshBasicMaterial({ color: 0x3a434e })));
  plane.position.set((R.minX + R.maxX) / 2, (R.minY + R.maxY) / 2, z);
  group.add(plane);
  const grid = new THREE.GridHelper(Math.max(w, h), Math.round(Math.max(w, h) / 256), 0x7d8b9b, 0x58636f);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(plane.position.x, plane.position.y, z + 0.5);
  grid.material.transparent = true; grid.material.opacity = 0.7;
  group.add(grid);
  return { group, plane };
}
