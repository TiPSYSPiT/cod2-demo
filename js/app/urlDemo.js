/* Opening a demo from a link (PLAN.md step 91): ?demoUrl=<the https URL of a .dm_1, URL-encoded> (or #demoUrl=...),
 * with the optional name, t, round, player, view and speed (README "Open a demo by link"). This module checks the link,
 * downloads the file (size limit, timeout, no cookies, no referrer) and builds the share link; main.js opens the bytes
 * as a dropped file. Everything here that reaches the page is text: the URL, the file name and the server's answers
 * are never inserted as HTML. The downloaded bytes are untrusted: the same parser (worker, hardened) as a dropped file. */

export const LINK = {
  MAX_BYTES: 100 * 1024 * 1024,       // the largest demo a link may load (a full zPAM match: 5 - 20 MB)
  TIMEOUT_MS: 30000,                  // to the server's answer, and again between two pieces of the file
  NAME_MAX: 120,                      // the file name shown (characters)
  /* The hosts a link may load a demo from. null: every https host (the server still has to allow it with its CORS
   * header). Otherwise a list: 'demos.example.org' (that host only) or '.example.org' (the domain and every sub
   * domain), e.g. ['.github.io', 'raw.githubusercontent.com']. With a list, narrow the CSP's connect-src in
   * index.html to the same hosts (README "Open a demo by link"). */
  ALLOWED_HOSTS: null
};

/** a failure the viewer explains: kind 'url' | 'cors' | 'http' | 'network' | 'timeout' | 'size' | 'empty' | 'notdemo' | 'cancel' */
export class LinkError extends Error {
  constructor(kind, title, message) { super(message); this.kind = kind; this.title = title; }
}

/** the link's parameters: the query string, then the hash (#demoUrl=...&t=...) for what the query does not have */
export function linkParams(loc = location) {
  const q = new URLSearchParams(loc.search);
  const h = new URLSearchParams((loc.hash || '').replace(/^#/, ''));
  for (const [k, v] of h) if (!q.has(k)) q.set(k, v);
  return q;
}

export function hostAllowed(host) {
  const list = LINK.ALLOWED_HOSTS;
  if (!list) return true;
  host = host.toLowerCase();
  return list.some(a => (a = String(a).toLowerCase()).startsWith('.') ? host === a.slice(1) || host.endsWith(a) : host === a);
}

/** the demoUrl parameter -> a URL, or a LinkError: only https:, a host name, no user / password in it */
export function checkUrl(raw) {
  const title = 'Invalid demo link:';
  if (raw == null || !String(raw).trim()) throw new LinkError('url', title, 'demoUrl is empty - it must be the https:// address of a .dm_1 file.');
  let url;
  try { url = new URL(String(raw).trim()); } catch (err) { throw new LinkError('url', title, 'demoUrl is not a valid address. It must be a full https:// URL, URL-encoded in the link.'); }
  if (url.protocol !== 'https:') throw new LinkError('url', title, 'Only https:// links can be opened (this one is ' + url.protocol.replace(/:$/, '') + ':).');
  if (!url.hostname) throw new LinkError('url', title, 'demoUrl has no host name.');
  if (url.username || url.password) throw new LinkError('url', title, 'demoUrl must not contain a user name or password.');
  if (!hostAllowed(url.hostname)) throw new LinkError('url', title, 'This viewer opens linked demos only from ' + LINK.ALLOWED_HOSTS.join(', ') + ' - not from ' + url.hostname + '.');
  return url;
}

/** a file name for display and for the exports: no control characters or path separators, at most NAME_MAX long */
export function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/[\\/]/g, '_').trim();
  if (s.length > LINK.NAME_MAX) {
    const ext = /\.dm_1$/i.test(s) ? s.slice(-5) : '';
    s = s.slice(0, LINK.NAME_MAX - ext.length - 1) + '…' + ext;
  }
  return s;
}

/** the last part of the URL's path, decoded ('' when there is none) */
export function nameFromUrl(url) {
  const last = url.pathname.split('/').pop() || '';
  try { return cleanName(decodeURIComponent(last)); } catch (err) { return cleanName(last); }
}

/** Content-Disposition's filename* (RFC 5987) or filename - readable only when the server exposes the header */
export function nameFromDisposition(h) {
  if (!h) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
  if (star) { try { return cleanName(decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))); } catch (err) { /* the plain one */ } }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(h);
  return plain ? cleanName(plain[2] != null ? plain[2].replace(/\\(.)/g, '$1') : plain[1].trim()) : '';
}

/** 't': seconds ('83', '83.5') or [h:]mm:ss ('1:23', '1:02:03') -> ms; null when missing or not a time */
export function parseTime(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (/^\d+(\.\d+)?s?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m || Number(m[3]) >= 60) return null;
  return Math.round(((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000);
}

const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

/** Download the demo: fetch without cookies or referrer, at most MAX_BYTES, TIMEOUT_MS to the answer and between the
 *  pieces of the body; onProgress(received, total or 0). signal: the caller's cancel. -> { bytes, name, type }
 *  Throws a LinkError (a cancel: kind 'cancel'). */
export async function download(url, { onProgress = () => {}, signal } = {}) {
  const host = url.hostname;
  const ctrl = new AbortController();
  let timedOut = false, timer = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, LINK.TIMEOUT_MS); };
  const onCancel = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onCancel); }
  const stopped = () => {
    if (signal && signal.aborted) return new LinkError('cancel', 'Cancelled:', 'The download was cancelled.');
    if (timedOut) return new LinkError('timeout', 'Download timed out:', 'No data from ' + host + ' for ' + LINK.TIMEOUT_MS / 1000 + ' s. The server may be slow or down - try again later.');
    return null;
  };
  arm();
  try {
    let res;
    try {
      res = await fetch(url.href, { credentials: 'omit', mode: 'cors', redirect: 'follow', referrerPolicy: 'no-referrer', signal: ctrl.signal });
    } catch (err) {
      throw stopped() || await whyFailed(url);
    }
    // (a redirect: the address the file came from must pass the same rules)
    if (res.url) {
      let final = null;
      try { final = new URL(res.url); } catch (err) { /* keep the first */ }
      if (final && (final.protocol !== 'https:' || !hostAllowed(final.hostname))) {
        ctrl.abort();
        throw new LinkError('url', 'Invalid demo link:', 'The link redirected to ' + final.protocol + '//' + final.hostname + ', which is not allowed (https only' + (LINK.ALLOWED_HOSTS ? ', hosts: ' + LINK.ALLOWED_HOSTS.join(', ') : '') + ').');
      }
    }
    if (!res.ok) {
      ctrl.abort();
      const s = res.status, what = s === 404 || s === 410 ? 'the file is not at this address (moved or deleted?).'
        : s === 401 || s === 403 ? 'access denied. The file may need a login - this viewer never sends cookies or passwords.'
          : s === 429 ? 'too many requests - try again later.' : s >= 500 ? 'a server error - try again later.' : 'the file could not be downloaded.';
      throw new LinkError('http', 'Download failed:', 'The server answered ' + s + (res.statusText ? ' ' + res.statusText : '') + ': ' + what);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const encoded = !!res.headers.get('content-encoding');        // (then the length is the compressed size)
    if (total > LINK.MAX_BYTES && !encoded) { ctrl.abort(); throw tooLarge(total); }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const name = nameFromDisposition(res.headers.get('content-disposition')) || nameFromUrl(url);
    const parts = [];
    let got = 0;
    onProgress(0, total);
    try {
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          got += value.byteLength;
          if (got > LINK.MAX_BYTES) { ctrl.abort(); reader.cancel().catch(() => {}); throw tooLarge(total > got ? total : 0); }
          parts.push(value);
          onProgress(got, total);
        }
      } else {
        const b = new Uint8Array(await res.arrayBuffer());
        if (b.byteLength > LINK.MAX_BYTES) throw tooLarge(b.byteLength);
        parts.push(b); got = b.byteLength;
      }
    } catch (err) {
      if (err instanceof LinkError) throw err;
      throw stopped() || new LinkError('network', 'Download failed:', 'The connection to ' + host + ' broke off after ' + mb(got) + '. Try again.');
    }
    if (!got) throw new LinkError('empty', 'Empty file:', 'The link returned an empty file (0 bytes) - not a demo.');
    const bytes = new Uint8Array(got);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
    // (a web page instead of the file: a download page, a login, an error page served with 200)
    if (/^text\/html|xhtml/.test(type) && /^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^﻿/, ''))) {
      throw new LinkError('notdemo', 'Not a demo:', 'The link returned a web page (' + type.split(';')[0] + '), not a .dm_1 demo - perhaps a download page or a login. Link the file itself.');
    }
    return { bytes, name, type };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCancel);
  }
}

function tooLarge(size) {
  return new LinkError('size', 'Demo too large:', (size ? 'The file is ' + mb(size) + '; the limit for a linked demo is ' + mb(LINK.MAX_BYTES)
    : 'The file is larger than ' + mb(LINK.MAX_BYTES) + ', the limit for a linked demo') + '. Download it and open it with "Open demo".');
}

/** fetch failed without an answer the page may read: the network, or the server's CORS rules (a page cannot tell them
 *  apart). A second request without CORS (its answer opaque, its body cancelled) tells: it gets an answer -> CORS. */
async function whyFailed(url) {
  const host = url.hostname;
  const cors = new LinkError('cors', 'Blocked by CORS:', 'The server ' + host + ' answered, but does not allow this page to read the file. ' +
    'The server hosting the demo must send the header "Access-Control-Allow-Origin: ' + location.origin + '" (or "*") with it.');
  const net = new LinkError('network', 'Download failed:', 'Could not reach ' + host + ' - check the link and your internet connection (or the site\'s HTTPS certificate is not valid).');
  if (navigator.onLine === false) return net;
  const probe = new AbortController();
  const t = setTimeout(() => probe.abort(), 10000);
  try {
    await fetch(url.href, { mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: probe.signal });
    return cors;
  } catch (err) {
    return net;
  } finally {
    clearTimeout(t);
    probe.abort();          // (the opaque answer's body is not wanted)
  }
}

/** the share link: this page with demoUrl (and name) of the link, the clock time in seconds, the round, the player,
 *  the view and the speed - each only when it says something */
export function shareUrl(o) {
  const q = new URLSearchParams();
  q.set('demoUrl', o.demoUrl);
  if (o.name) q.set('name', o.name);
  if (o.round) q.set('round', o.round);
  if (o.t != null && o.t >= 1000) q.set('t', String(Math.floor(o.t / 1000)));
  if (o.player) q.set('player', o.player);
  if (o.view) q.set('view', o.view);
  if (o.speed && o.speed !== 1) q.set('speed', String(o.speed));
  return location.origin + location.pathname + '?' + q.toString();
}
