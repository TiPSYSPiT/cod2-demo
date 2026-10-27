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

/** a texture that fails to load is drawn neutral grey (and warned about) */
let grey = null;
export function loadTexture(url, loader = new THREE.TextureLoader()) {
  const t = loader.load(dataUrl(url), tex => arrived(tex), undefined, () => {
    console.warn('texture not loaded - drawn neutral grey:', url);
    if (!grey) { grey = document.createElement('canvas'); grey.width = grey.height = 1; const g = grey.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 1, 1); }
    t.image = grey; t.needsUpdate = true;
    arrived(t);
  });
  return t;
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
export const textureArrivals = { onArrive: null };
function arrived(t) {
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

/** a multiply decal (techniques effect_multiply*, blend Zero x SrcColor: mul.hlsl): the framebuffer x
 *  mix(1, colour map x vertex colour, vertex alpha) - white leaves the surface below as it is, the grime
 *  darkens it; unlit, no depth writes, no fog, no shadow cookie (the surface below has it). Without vertex
 *  colours (opts.vertexColors false: the props) the colour map alone */
export function multiplyMaterial(tex, opts = {}) {
  const mat = new THREE.MeshBasicMaterial(Object.assign({ vertexColors: true }, opts, {
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4
  }));
  setMap(mat, 'map', tex, 'white');          // (white while it loads: no change to the surface below)
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
      '#ifdef USE_COLOR_ALPHA\noutgoingLight = mix( vec3( 1.0 ), diffuseColor.rgb, vColor.a );\n#endif\n#include <opaque_fragment>');
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
  const mat = new THREE.MeshBasicMaterial({ side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
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
    const mat = multiplyMaterial(tex, { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
    mat.name = g.material;
    mat.userData.group = g;
    return mat;
  }
  const opts = { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide };
  if (!tex) opts.color = new THREE.Color('#8a8a84');
  const lm = g.lightmap >= 0 ? lightmaps[g.lightmap] : null;
  if (lm) opts.lightMapIntensity = LIGHTMAP_SCALE * Math.PI;
  else opts.vertexColors = true;
  if (g.alphaTest && g.textureAlpha) opts.alphaTest = 0.5;
  if (g.blend) {
    opts.transparent = true; opts.depthWrite = false;
    if (g.blend === 'add') opts.blending = THREE.AdditiveBlending;
  }
  if (g.decal || g.blend) { opts.polygonOffset = true; opts.polygonOffsetFactor = -1; opts.polygonOffsetUnits = -4; }
  // lightmapped surfaces are drawn as the game does: albedo x baked light, no scene lights on top
  const mat = lm ? new THREE.MeshBasicMaterial(opts) : new THREE.MeshLambertMaterial(opts);
  mat.name = g.material;
  mat.userData.group = g;                    // (the ?debug surface picker, debugPick.js)
  setMap(mat, 'map', tex, opts.alphaTest || g.blend || g.vertexAlpha ? 'clear' : 'grey');
  setMap(mat, 'lightMap', lm, 'light');
  // the vertex alpha blends the terrain layers (materials *_blend): colour map alpha x vertex alpha
  if (g.vertexAlpha) vertexAlphaBlend(mat);
  if (detail && tex) detailMap(mat, detail, g.detailScale);
  if (lm && sunMasks) gameLightmap(mat, sunMasks[g.lightmap], normalMap && coefs ? coefs[g.lightmap] : null, normalMap, specMap);
  return receiveCookie(mat);                 // the players' shadows (shadows.js)
}

/** the blended terrain layers: alpha = colour map alpha x vertex alpha */
function vertexAlphaBlend(mat) {
  mat.transparent = true;
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 color;\nvarying float vVa;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvVa = color.a;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vVa;')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vVa;\n#include <opaque_fragment>');
  };
  mat.needsUpdate = true;
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

  const loader = new THREE.TextureLoader();
  const texCache = new Map();
  const texture = (file, repeat) => {
    if (!file) return null;
    if (texCache.has(file)) return texCache.get(file);
    const t = loadTexture(BASE + file, loader);
    t.flipY = false;                                        // D3D texture coordinates: v = 0 at the top
    t.colorSpace = THREE.NoColorSpace;                      // gamma-space math, like the game
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
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
    if (t) t.channel = 1;                                   // sampled with the lightmap coordinates (uv1)
    return t;
  });
  // the game's lightmaps (lightmapFormat 2): the light + the sun's visibility (a black stand-in until it arrives)
  const sunMasks = info.lightmapFormat === 2 && info.sunMasks ? info.sunMasks.map(f => (f ? texture(mapName + '/' + f, false) : null)) : null;
  if (sunMasks) applySun(info.sun);
  // the lightmaps' 4 coefficients (for the normal-mapped surfaces; needs the tangent frame)
  const coefs = sunMasks && info.lightmapCoefs && L.tangent ? info.lightmapCoefs.map(list => list.map(f => {
    const t = texture(mapName + '/' + f, false);
    t.channel = 1;
    return t;
  })) : null;
  const materials = [];
  for (const g of info.groups) {
    if (g.sky) continue;                                    // the sky is drawn by sky.js
    geo.addGroup(g.start, g.count, materials.length);
    const normalMap = coefs && g.normalMap ? texture(g.normalMap, true) : null;
    const m = makeMaterial(g, texture(g.texture, true), lightmaps, sunMasks, coefs, normalMap,
      normalMap && g.specularMap ? texture(g.specularMap, true) : null, texture(g.detailMap, true), g.water && envTexture(g.water.envMap));
    m.userData.order = g.blend || g.vertexAlpha ? 3 : g.decal ? 2 : g.alphaTest ? 1 : 0;
    materials.push(m);
  }
  const mesh = new THREE.Mesh(geo, materials);
  mesh.name = 'world';
  mesh.matrixAutoUpdate = false;
  // groups sorted so transparent ones draw last (three sorts objects, not groups)
  geo.groups.sort((a, b) => materials[a.materialIndex].userData.order - materials[b.materialIndex].userData.order);
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
