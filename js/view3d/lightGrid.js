/* The map's light grid: how CoD2 lights its models (players, their weapons, corpses), from the 1.3
 * client (RB_GetLightingAtPoint, Image_GetLightGridWeightsForVector, lightprobe.hlsl):
 *
 * - points every 32 x 32 x 64 units (x / y / z), world + 131072; stored (lightgrid.bin, tools/export) in
 *   4 x 4 x 4 blocks: uint32 key = (x >> 2) << 21 | (y >> 2) << 10 | (z >> 2), sorted; uint8 sub = the
 *   point in its block ((x & 3) << 6 | (y & 3) << 4 | (z & 3) << 2) | bit 0 "in sunlight"; uint8 the
 *   corners (bit i = corner i of the cell below) that need a visibility trace; uint16 colour index;
 * - a model at p takes the 8 points around p + (0, 0, 4), trilinear, the missing ones left out and the rest
 *   renormalised (a point below the floor is not stored); a point whose bit is set only if the segment from
 *   p + (0, 0, 4) to it (ending 0.01 units short) passes no solid brush or terrain (collision.js); none at
 *   all: the nearest point;
 * - a colour: 24 bytes / 255 = 8 coefficients for red, green, blue: the light from 8 directions, the
 *   corners of a cube turned (AXIS) so that corner 7 points up and 0 down, the other six 19.5 degrees
 *   above / below the horizon. A surface with world normal n gets sum(coef_i * w_i(n)): the normal in the
 *   cube's frame, projected on the cube, smoothstep per axis, the corner's weight the product of the
 *   three (as the game's $lightgridweights0 / 1 cube maps);
 * - plus the sun: suncolor (normalised) x (sunlight - ambient) x (1 - diffuseFraction) x max(0, n.L),
 *   times the share of the 8 points in sunlight (the rest of the sun, diffuseFraction, is in the grid).
 * Pixel = albedo x (grid + sun), as the game's model shader. */
import * as THREE from 'three';
import { fetchBinary } from './data.js';
import { Collision } from './collision.js';
import { COOKIE_LINE } from './shadows.js';

const OFF = 131072;

/** the cube's axes (rows), from the 1.3 client's data next to the weight code */
export const AXIS = [[0, 0.8165, 0.5774], [-0.7071, -0.4082, 0.5774], [0.7071, -0.4082, 0.5774]];

/** what every lit model shares: the sun's colour (the direct part) and its direction (towards the sun) */
export const GRID_SUN = { color: { value: new THREE.Vector3() }, dir: { value: new THREE.Vector3(0, 0, 1) } };

/** the sun's direct light (R_InterpretSunLightParseParamsIntoLights of the 1.3 client): suncolor normalised x
 *  (sunlight - ambient) x (1 - diffuseFraction) -> {color: Vector3, dir: Vector3 towards the sun} */
export function sunLight(sun = {}) {
  const c = sun.color || [1, 1, 1], m = Math.max(c[0], c[1], c[2]) || 1;
  const amb = sun.ambient || 0, k = Math.max(0, (sun.light != null ? sun.light : 1) - amb) * (1 - (sun.diffuseFraction != null ? sun.diffuseFraction : 0.5));
  const color = new THREE.Vector3(c[0] / m * k, c[1] / m * k, c[2] / m * k);
  const dir = new THREE.Vector3(0, 0, 1);
  if (sun.direction) {
    const [p, y] = sun.direction.map(a => a * Math.PI / 180);
    dir.set(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
  }
  return { color, dir };
}

/** the map's sun into the shared uniforms (the world's, the props' and the players' shaders) */
export function applySun(sun) {
  const s = sunLight(sun);
  GRID_SUN.color.value.copy(s.color);
  GRID_SUN.dir.value.copy(s.dir);
  return s;
}

export class LightGrid {
  /** dir: maps3d/<map>/, info: world.json (lightGrid, sun) -> LightGrid or null */
  static async load(dir, info) {
    const g = info.lightGrid;
    if (!g) return null;
    const [buf, coll] = await Promise.all([
      fetchBinary(dir + g.file, { expected: g.points * 8 + g.colors * 24 }),
      Collision.load(dir, info.collision).catch(err => { console.warn('light grid collision:', err.message); return null; }),
    ]);
    return new LightGrid(buf, g, info.sun || {}, coll);
  }

  constructor(buf, g, sun, collision = null) {
    const n = g.points, dv = new DataView(buf, 0, n * 8);
    this.n = n;
    this.keys = new Uint32Array(n); this.sub = new Uint8Array(n); this.vis = new Uint8Array(n); this.col = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      this.keys[i] = dv.getUint32(i * 8, true);
      this.sub[i] = dv.getUint8(i * 8 + 4);
      this.vis[i] = dv.getUint8(i * 8 + 5);
      this.col[i] = dv.getUint16(i * 8 + 6, true);
    }
    this.collision = collision;      // without it (older exports) every traced corner counts
    this.colors = new Uint8Array(buf, n * 8, g.colors * 24);
    // the sun's direct part
    const s = sunLight(sun);
    this.sunColor = s.color;
    this.sunDir = s.dir;
  }

  /** the shared uniforms: this map's sun */
  apply() { GRID_SUN.color.value.copy(this.sunColor); GRID_SUN.dir.value.copy(this.sunDir); }

  /** index of the point (cx, cy, cz) or -1 (orBefore: the entry the search ended before, as the game's fallback) */
  find(cx, cy, cz, orBefore = false) {
    const key = ((cz >> 2) | ((cx << 19) & 0xFFE00000) | ((cy << 8) & 0xFFFFFC00)) >>> 0;
    const s = ((cz & 3) << 2) | ((cx & 3) << 6) | ((cy & 3) << 4);
    let lo = 0, hi = this.n - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      let d = this.keys[m] - key;
      if (d === 0) {
        const ds = this.sub[m] - s;
        if (ds >= 0 && ds < 2) return m;
        d = ds;
      }
      if (d >= 0) hi = m - 1; else lo = m + 1;
    }
    return orBefore ? hi : -1;
  }

  /** the light at a model's origin (x, y, z) -> {coef: Float32Array(24), sun: 0..1} or null (no point near) */
  sample(x, y, z, out = { coef: new Float32Array(24), sun: 0 }) {
    const pz = z + 4;
    const fx = (x + OFF) / 32, fy = (y + OFF) / 32, fz = (pz + OFF) / 64;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const c = out.coef;
    c.fill(0);
    let total = 0, sun = 0;
    for (let i = 0; i < 8; i++) {
      const bx = i & 1, by = (i >> 1) & 1, bz = (i >> 2) & 1;
      const m = this.find(ix + bx, iy + by, iz + bz);
      if (m < 0) continue;
      const w = (bx ? tx : 1 - tx) * (by ? ty : 1 - ty) * (bz ? tz : 1 - tz);
      if (w <= 0) continue;
      if (this.collision && (this.vis[m] >> i) & 1 && this.hidden(x, y, pz, ix + bx, iy + by, iz + bz)) continue;
      this.add(c, this.col[m], w);
      total += w;
      if (this.sub[m] & 1) sun += w;
    }
    if (total >= 0.98) { out.sun = sun; return out; }
    if (total > 0) {
      for (let k = 0; k < 24; k++) c[k] /= total;
      out.sun = sun / total;
      return out;
    }
    // no point around (or all hidden): the nearest one, else the entry before it in the sorted list
    const m = this.find(ix + (tx > 0.5), iy + (ty > 0.5), iz + (tz > 0.5), true);
    if (m < 0) return null;
    this.add(c, this.col[m], 1);
    out.sun = this.sub[m] & 1;
    return out;
  }

  /** is grid point (cx, cy, cz) hidden from (x, y, z)? the trace ends 0.01 units short of the point */
  hidden(x, y, z, cx, cy, cz) {
    const gx = cx * 32 - OFF, gy = cy * 32 - OFF, gz = cz * 64 - OFF;
    const dx = x - gx, dy = y - gy, dz = z - gz, l = Math.hypot(dx, dy, dz) || 1;
    return this.collision.blocked(x, y, z, gx + dx / l * 0.01, gy + dy / l * 0.01, gz + dz / l * 0.01);
  }

  add(c, ci, w) {
    const o = ci * 24, s = w / 255;
    for (let k = 0; k < 24; k++) c[k] += this.colors[o + k] * s;
  }
}

/* $specularity (Image_BuildSpecularityMap of the renderer, r_cosinePowerMapShift 0): an 8-bit table of 32
 * columns (the power) x 256 rows (N.H), cell = round(255 pow(row / 255, e)) with e = log 0.1 / log cos(a):
 * column c < 31 falls to a tenth at a = (180 - 175 c / 30) / 4 degrees (45 .. 1.25), column 31 has e = 30.
 * Sampled bilinear, as the game's texture. (The world's and the props' specular, phong.hlsl.) */
export const SPECULARITY_GLSL = `
float specExp( float c ) {
  if ( c > 30.5 ) return 30.0;
  return log( 0.1 ) / log( cos( ( 180.0 - 175.0 * min( c / 30.0, 1.0 ) ) * 0.004363323129985824 ) );
}
float specCell( float e, float row ) { return floor( pow( row / 255.0, e ) * 255.0 + 0.5 ) / 255.0; }
float specularity( float power, float ndh ) {
  float c = clamp( power * 32.0 - 0.5, 0.0, 31.0 ), c0 = floor( c ), c1 = min( c0 + 1.0, 31.0 );
  float r = clamp( ndh * 256.0 - 0.5, 0.0, 255.0 ), r0 = floor( r ), r1 = min( r0 + 1.0, 255.0 );
  float e0 = specExp( c0 ), e1 = specExp( c1 );
  return mix( mix( specCell( e0, r0 ), specCell( e0, r1 ), r - r0 ), mix( specCell( e1, r0 ), specCell( e1, r1 ), r - r0 ), c - c0 );
}
`;

/* ---------- the model shader: three.js' lighting replaced by the game's (lightprobe.hlsl) ---------- */
const VERT_HEAD = 'varying vec3 vGridN;\n';
const VERT_BODY = '\nvGridN = normalize( mat3( modelMatrix ) * objectNormal );';
const FRAG_HEAD = `varying vec3 vGridN;
uniform vec4 uGrid[6];
uniform float uGridSun;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
vec3 gridLight( vec3 n ) {
  vec3 u = n * mat3( ${AXIS.map(r => 'vec3(' + r.map(v => v.toFixed(4)).join(', ') + ')').join(', ')} );
  u /= max( max( abs( u.x ), abs( u.y ) ), abs( u.z ) );
  vec3 s = smoothstep( 0.0, 1.0, u * 0.5 + 0.5 );
  vec4 xy = vec4( ( 1.0 - s.x ) * ( 1.0 - s.y ), s.x * ( 1.0 - s.y ), ( 1.0 - s.x ) * s.y, s.x * s.y );
  vec4 w0 = xy * ( 1.0 - s.z ), w1 = xy * s.z;
  vec3 probe = vec3( dot( w0, uGrid[0] ) + dot( w1, uGrid[1] ), dot( w0, uGrid[2] ) + dot( w1, uGrid[3] ), dot( w0, uGrid[4] ) + dot( w1, uGrid[5] ) );
  return probe + uGridSun * uSunColor * max( 0.0, dot( n, uSunDir ) );
}
`;

/* the static models (props.js): the light per placement as instance attributes (gridC0..5 = R0 R1 G0 G1
   B0 B1, gridSun), evaluated per vertex; the "ambient" techniques (foliage) take the light from above */
const PROP_VERT_HEAD = `attribute vec4 gridC0, gridC1, gridC2, gridC3, gridC4, gridC5;
attribute float gridSun;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec3 vGridLight;
varying vec3 vGridSunLight;
`;
const PROP_VERT_BODY = `
{
  #ifdef GRID_UNLIT
    vec3 gn = vec3( 0.0, 0.0, 1.0 );
    float ndl = max( 0.0, uSunDir.z );
  #else
    vec3 gn = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
    float ndl = max( 0.0, dot( gn, uSunDir ) );
  #endif
  vec3 u = gn * mat3( ${AXIS.map(r => 'vec3(' + r.map(v => v.toFixed(4)).join(', ') + ')').join(', ')} );
  u /= max( max( abs( u.x ), abs( u.y ) ), abs( u.z ) );
  vec3 s = smoothstep( 0.0, 1.0, u * 0.5 + 0.5 );
  vec4 xy = vec4( ( 1.0 - s.x ) * ( 1.0 - s.y ), s.x * ( 1.0 - s.y ), ( 1.0 - s.x ) * s.y, s.x * s.y );
  vec4 w0 = xy * ( 1.0 - s.z ), w1 = xy * s.z;
  vGridLight = vec3( dot( w0, gridC0 ) + dot( w1, gridC1 ), dot( w0, gridC2 ) + dot( w1, gridC3 ), dot( w0, gridC4 ) + dot( w1, gridC5 ) );
  vGridSunLight = gridSun * uSunColor * ndl;            // (apart: the shadow cookies take the sun only)
}`;

/* the normal-mapped props, per pixel as lightprobe.hlsl: the placement's grid light (instance attributes,
   passed on) weighted for the bumped normal N + (2x - 1) T + (2y - 1) B, the sun x N.L, and with a specular
   map the sun's highlight (the power in the normal map's blue channel, as the world's) */
const BUMP_VERT_HEAD = `attribute vec4 gridC0, gridC1, gridC2, gridC3, gridC4, gridC5;
attribute float gridSun;
attribute vec4 cTangent;
varying vec4 vGC0, vGC1, vGC2, vGC3, vGC4, vGC5;
varying float vGSun;
varying vec3 vGridN, vGridT, vGridB, vGridW;
`;
const BUMP_VERT_BODY = `
{
  mat3 gm = mat3( modelMatrix ) * mat3( instanceMatrix );
  vGridN = gm * objectNormal; vGridT = gm * cTangent.xyz; vGridB = gm * ( cross( objectNormal, cTangent.xyz ) * sign( cTangent.w ) );
  vGridW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  vGC0 = gridC0; vGC1 = gridC1; vGC2 = gridC2; vGC3 = gridC3; vGC4 = gridC4; vGC5 = gridC5; vGSun = gridSun;
}`;
const BUMP_FRAG_HEAD = `varying vec4 vGC0, vGC1, vGC2, vGC3, vGC4, vGC5;
varying float vGSun;
varying vec3 vGridN, vGridT, vGridB, vGridW;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform sampler2D uNormalMap;
#ifdef GRID_SPECULAR
uniform sampler2D uSpecMap;
${SPECULARITY_GLSL}
#endif
`;
const BUMP_FRAG_BODY = `float gSun = vGSun;
#ifdef COOKIE_RECEIVER
  gSun *= 1.0 - cookieCover();
#endif
vec3 nsp = texture2D( uNormalMap, vMapUv ).xyz;
vec3 gn = normalize( vGridN + ( nsp.x * 2.0 - 1.0 ) * vGridT + ( nsp.y * 2.0 - 1.0 ) * vGridB );
vec3 gu = gn * mat3( ${AXIS.map(r => 'vec3(' + r.map(v => v.toFixed(4)).join(', ') + ')').join(', ')} );
gu /= max( max( abs( gu.x ), abs( gu.y ) ), abs( gu.z ) );
vec3 gs = smoothstep( 0.0, 1.0, gu * 0.5 + 0.5 );
vec4 gxy = vec4( ( 1.0 - gs.x ) * ( 1.0 - gs.y ), gs.x * ( 1.0 - gs.y ), ( 1.0 - gs.x ) * gs.y, gs.x * gs.y );
vec4 gw0 = gxy * ( 1.0 - gs.z ), gw1 = gxy * gs.z;
vec3 gridLight = vec3( dot( gw0, vGC0 ) + dot( gw1, vGC1 ), dot( gw0, vGC2 ) + dot( gw1, vGC3 ), dot( gw0, vGC4 ) + dot( gw1, vGC5 ) )
  + gSun * uSunColor * max( 0.0, dot( gn, uSunDir ) );
vec3 gridSpec = vec3( 0.0 );
#ifdef GRID_SPECULAR
  vec3 gh = normalize( normalize( cameraPosition - vGridW ) + uSunDir );
  gridSpec = uSunColor * texture2D( uSpecMap, vMapUv ).rgb * specularity( nsp.z, dot( gh, gn ) ) * mix( 0.3, 1.0, clamp( gSun, 0.0, 1.0 ) );
#endif
outgoingLight = diffuseColor.rgb * gridLight + gridSpec;
`;

/** light an instanced prop material from its instances' grid attributes (keeps an onBeforeCompile: the
 *  shadow cookies multiply the result); bump {normalMap, specMap} (uniforms {value}): per pixel with the
 *  normal map (the geometry needs cTangent: xyz + the binormal's sign) */
export function propGridMaterial(mat, unlit, bump = null) {
  const prev = mat.onBeforeCompile;
  const bumped = !unlit && !!(bump && bump.normalMap);
  const specular = bumped && !!bump.specMap;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uSunColor = GRID_SUN.color;
    shader.uniforms.uSunDir = GRID_SUN.dir;
    if (bumped) {
      shader.uniforms.uNormalMap = bump.normalMap;
      if (specular) shader.uniforms.uSpecMap = bump.specMap;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + (unlit ? '#define GRID_UNLIT\n' : '') + (bumped ? BUMP_VERT_HEAD : PROP_VERT_HEAD))
      .replace('#include <project_vertex>', '#include <project_vertex>' + (bumped ? BUMP_VERT_BODY : PROP_VERT_BODY));
    const set = bumped ? BUMP_FRAG_BODY : `float gSun = 1.0;
#ifdef COOKIE_RECEIVER
  gSun = 1.0 - cookieCover();
#endif
outgoingLight = diffuseColor.rgb * ( vGridLight + vGridSunLight * gSun );
`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n#define COOKIE_SUN_ONLY\n' +
      (bumped ? (specular ? '#define GRID_SPECULAR\n' : '') + BUMP_FRAG_HEAD : 'varying vec3 vGridLight;\nvarying vec3 vGridSunLight;\n'));
    shader.fragmentShader = shader.fragmentShader.includes(COOKIE_LINE)
      ? shader.fragmentShader.replace(COOKIE_LINE, set + COOKIE_LINE)
      : shader.fragmentShader.replace('#include <opaque_fragment>', set + '#include <opaque_fragment>');
  };
  // the program cache key: the previous patch's key (chained), or the previous onBeforeCompile's source
  const prevKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : (k => () => k)(prev ? prev.toString() : '');
  mat.customProgramCacheKey = () => 'propgrid|' + (unlit ? 1 : 0) + (bumped ? 'n' : '') + (specular ? 's' : '') + '|' + prevKey();
  mat.color.setRGB(1, 1, 1);
  mat.needsUpdate = true;
  return mat;
}

/** per-model uniforms (one set per character, shared by its materials) */
export function gridUniforms() {
  return { grid: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, sun: { value: 0 } };
}

/** fill the uniforms from a sample */
export function setGridUniforms(u, s) {
  const c = s.coef;
  for (let i = 0; i < 6; i++) u.grid.value[i].set(c[i * 4], c[i * 4 + 1], c[i * 4 + 2], c[i * 4 + 3]);
  u.sun.value = s.sun;
}

/** light a (Lambert) material from the grid: albedo x (grid + sun); its colour and emissive are left out */
export function gridMaterial(mat, u) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uGrid = u.grid;
    shader.uniforms.uGridSun = u.sun;
    shader.uniforms.uSunColor = GRID_SUN.color;
    shader.uniforms.uSunDir = GRID_SUN.dir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <opaque_fragment>', 'outgoingLight = diffuseColor.rgb * gridLight( normalize( vGridN ) );\n#include <opaque_fragment>');
  };
  // the program cache key: the previous patch's key (chained), or the previous onBeforeCompile's source
  const prevKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : (k => () => k)(prev ? prev.toString() : '');
  mat.customProgramCacheKey = () => 'grid|' + prevKey();
  mat.color.setRGB(1, 1, 1);
  mat.needsUpdate = true;
  return mat;
}
