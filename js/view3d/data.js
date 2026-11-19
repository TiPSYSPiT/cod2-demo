/* Fetching the exported data (maps3d/): every JSON and binary file of the 3D view goes through here.
 *  - Cache-busting: maps3d/manifest.json (tools/check_deploy.py manifest) has size and hash of every
 *    file; the URL gets ?v=<hash>, so a JSON header and its binary are always the same version (a
 *    browser or CDN cache never mixes an old one with a new one). Without a manifest: plain URLs.
 *  - Checks: HTTP status, an HTML page (a 404 page served as data) or a Git LFS pointer instead of the
 *    data, the received length against the manifest's / the header's, the views into a buffer
 *    (offset, length, alignment). A failure throws a DataError with a precise message and logs URL,
 *    status, type, size and SHA-256 to the console.
 *  - Binaries are read as a stream into chunks: Content-Length is the size on the wire, and GitHub
 *    Pages gzips (Content-Encoding) - a buffer sized from it cut world.bin short ("Invalid typed array
 *    length"). The progress uses the expected size from the manifest or the caller.
 *  - The binaries are stored gzipped (world.bin.gz ...) and unpacked here (fetchBinary): the JSON headers and the
 *    callers keep the plain names. */

const BASE = 'maps3d/';
let manifest = null, manifestLoading = null;

export class DataError extends Error {}

/** maps3d/manifest.json, once (revalidated: no-cache) -> manifest or null */
export function loadDataManifest() {
  if (!manifestLoading) {
    manifestLoading = fetch(BASE + 'manifest.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null)).then(m => (manifest = m && m.files ? m : null))
      .catch(() => null);
  }
  return manifestLoading;
}

/** the manifest's entry [size, hash] of a maps3d URL (or null) */
function entryOf(url) {
  if (!manifest || !url.startsWith(BASE)) return null;
  return manifest.files[url.slice(BASE.length).split('?')[0]] || null;
}

/** a maps3d URL with its version (?v=hash), for fetches and texture loaders */
export function dataUrl(url) {
  url = norm(url);
  const e = entryOf(url);
  return e ? url + (url.includes('?') ? '&' : '?') + 'v=' + e[1] : url;
}

const name = url => url.split('?')[0];
/** '..' and '.' segments resolved (a map version's props.json names another version's props.bin: "../<map>/props.bin",
 *  tools/export/datafile.py share_tree) - the manifest's keys are plain paths */
const norm = url => {
  const i = url.indexOf('?'), path = i < 0 ? url : url.slice(0, i), out = [];
  for (const s of path.split('/')) { if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop(); else if (s !== '.') out.push(s); }
  return out.join('/') + (i < 0 ? '' : url.slice(i));
};
const isText = url => /\.(json|md|txt)$/i.test(name(url));

/** what came instead of the data: 'an HTML page' / 'a Git LFS pointer' / null */
function sniff(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64)).trimStart();
  if (head.startsWith('version https://git-lfs')) return 'a Git LFS pointer';
  if (/^<(!doctype|html|head|body)/i.test(head)) return 'an HTML page';
  return null;
}

async function sha256(bytes) {
  try {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) { return 'n/a'; }
}

/** log a failed file (URL, status, type, size, hash) and throw the message */
async function fail(url, r, bytes, message) {
  console.error('data file failed:', message, { url, status: r && r.status, type: r && r.headers.get('content-type'),
    encoding: r && r.headers.get('content-encoding'), size: bytes ? bytes.byteLength : null, sha256: bytes ? await sha256(bytes) : null });
  throw new DataError(message);
}

/* Files fetched ahead (prefetch): while the demo is still parsed, the map's files are already on their way; the
 * loader that asks for one first takes over that response (once). Unclaimed ones are dropped after a while (the
 * user went to the 2D view). */
const ahead = new Map();
const AHEAD_MS = 120000;
/** start fetching a maps3d file now; the next fetchData of the same URL gets this response. json: also read a
 *  copy of it (to find the files it names) -> Promise<object or null> */
export function prefetch(url, { json = false } = {}) {
  return loadDataManifest().then(() => {
    const u = dataUrl(storedUrl(url));            // (a binary: its .gz - what fetchBinary asks for)
    if (ahead.has(u)) return null;
    const p = fetch(u);
    // (the copy is made before anyone can take the response and read its body)
    const info = json ? p.then(r => (r.ok ? r.clone().json() : null)).catch(() => null) : null;
    ahead.set(u, p);
    p.catch(() => null);
    setTimeout(() => { if (ahead.get(u) === p) { ahead.delete(u); p.then(r => r.body && r.body.cancel()).catch(() => null); } }, AHEAD_MS);
    return info;
  });
}

/** fetch a maps3d file (versioned URL, status checked) -> Response */
export async function fetchData(url, opts) {
  url = norm(url);
  await loadDataManifest();
  let r;
  const u = dataUrl(url), held = !opts && ahead.get(u);
  if (held) ahead.delete(u);
  // (a download the browser cancelled - the page left mid-load: AbortError - goes on as it is, not logged)
  try { r = await (held || fetch(u, opts)); } catch (err) { if (err && err.name === 'AbortError') throw err; return fail(url, null, null, name(url) + ': ' + err.message); }
  if (!r.ok) return fail(url, r, null, name(url) + ': HTTP ' + r.status + (r.status === 404 ? ' (not found - not deployed?)' : ''));
  return r;
}

/** a JSON file -> object (an HTML page or an LFS pointer named as such) */
export async function fetchJSON(url, opts) {
  const r = await fetchData(url, opts);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const what = sniff(bytes);
  if (what) return fail(url, r, bytes, name(url) + ': received ' + what + ' (' + bytes.byteLength + ' bytes) instead of JSON');
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch (err) { return fail(url, r, bytes, name(url) + ': not valid JSON (' + bytes.byteLength + ' bytes: ' + err.message + ')'); }
}

/* The binaries are stored gzipped (<file>.gz, tools/export/datafile.py: 38 % of the space and the download - GitHub
 * Pages does not compress binaries on the way; PLAN.md step 96, as cod4-demo) - also the textures as the game's DXT data
 * (<name>.dds.gz: tools/export/texfile.py). Their JSON headers name the plain file;
 * the manifest lists the .gz. */
const PACKED = '.gz';
/** the URL a binary is fetched from: its .gz when the manifest lists that and not the plain file; without a manifest
 *  the .gz as well (what the export writes; fetchBinary falls back to the plain file) */
function storedUrl(url) {
  url = norm(url);
  if (!url.startsWith(BASE) || !/\.(bin|dds)$/i.test(name(url))) return url;
  if (!manifest) return url + PACKED;
  const key = url.slice(BASE.length).split('?')[0];
  return !manifest.files[key] && manifest.files[key + PACKED] ? url + PACKED : url;
}
/** gzip data -> the unpacked bytes (the browser's own inflate, off the main thread) */
async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack gzip data (no DecompressionStream)');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** a binary file -> ArrayBuffer. Its length as stored is checked against the manifest's size, the data's length (after
 *  unpacking a .gz) against `expected` (the caller's, from a header); onProgress(0..1) while it streams */
export async function fetchBinary(url, { expected = 0, onProgress = null } = {}) {
  url = norm(url);
  await loadDataManifest();
  let src = storedUrl(url), r;
  try { r = await fetchData(src); }
  catch (err) {
    // (no manifest and no .gz: the plain file of an older export)
    if (manifest || src === url || !/HTTP 404/.test(err.message)) throw err;
    src = url;
    r = await fetchData(src);
  }
  const packed = src !== url;
  const e = entryOf(src);
  const want = e && !isText(src) ? e[0] : packed ? 0 : expected;
  let bytes;
  if (r.body && onProgress) {
    const reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (want) onProgress(Math.min(1, got / want));
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
  } else bytes = new Uint8Array(await r.arrayBuffer());
  const what = sniff(bytes);
  if (what && (!want || bytes.byteLength !== want)) return fail(src, r, bytes, name(src) + ': received ' + what + ' (' + bytes.byteLength + ' bytes) instead of the data');
  const wrong = (n, size) => name(src) + ': expected ' + size.toLocaleString('en') + ' bytes, received ' + n.toLocaleString('en') +
    (n < size ? ' (cut short or an old version)' : ' (another version)');
  // (the gzip header 1f 8b: a server that unpacked the .gz on the way - Content-Encoding - sends the data itself, which
  // is checked against `expected` alone)
  const gz = packed && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (want && bytes.byteLength !== want && (gz || !packed)) return fail(src, r, bytes, wrong(bytes.byteLength, want));
  if (gz) {
    const stored = bytes;
    try { bytes = await gunzip(stored); }
    catch (err) { return fail(src, r, stored, name(src) + ': does not unpack (' + err.message + ')'); }
  }
  if (expected && bytes.byteLength !== expected) return fail(src, r, bytes, wrong(bytes.byteLength, expected) + (packed ? ' after unpacking' : ''));
  return bytes.buffer;
}

/** a typed array view into a fetched buffer, checked: offset aligned, inside the buffer */
export function checkedView(T, buf, offset, count, what) {
  const end = offset + count * T.BYTES_PER_ELEMENT;
  if (offset % T.BYTES_PER_ELEMENT || end > buf.byteLength || offset < 0 || count < 0) {
    throw new DataError(what + ': ' + T.name + ' view of ' + count + ' elements at byte ' + offset +
      (offset % T.BYTES_PER_ELEMENT ? ' is not aligned' : ' needs ' + end.toLocaleString('en') + ' bytes, the file has ' + buf.byteLength.toLocaleString('en')));
  }
  return new T(buf, offset, count);
}
