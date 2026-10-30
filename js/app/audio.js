/* The page's one AudioContext and the sound settings, shared by the loader (main.js) and the 3D view's sounds
 * (view3d.js, sound.js). The browsers start audio only after a user interaction: primeAudio() runs in the handler
 * of the interaction that loads a demo (file picker, drop) and creates / resumes the context there, so the sounds
 * play from the start without a second click. A demo opened without one (index.html?demo=...) leaves it
 * suspended: the 3D view then shows a "click to enable sound" hint. */

// (a new key with the new defaults: the choices kept under 'cod2demo3d.sound' before are not carried over)
export const SOUND_KEY = 'cod2demo3d.sound2';     // 'on' / 'off' (default on) and '.volume' (0 - 1, default 0.2)
export const DEFAULT_VOLUME = 0.2;

const stored = key => { try { return localStorage.getItem(key); } catch (err) { return null; } };
let ctx = null;

/** sound wanted: on unless the user switched it off (?sound=off: no sounds at all) */
export function soundWanted() {
  return stored(SOUND_KEY) !== 'off' && new URLSearchParams(location.search).get('sound') !== 'off';
}

/** the volume the user set, else the default */
export function soundVolume() {
  const s = stored(SOUND_KEY + '.volume'), v = Number(s);
  return s != null && s !== '' && v >= 0 && v <= 1 ? v : DEFAULT_VOLUME;
}

/** the shared context (created on first use; null without Web Audio) */
export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (err) { console.warn('no audio:', err); return null; }
  }
  return ctx;
}

/** a context may start now: one is running, or the page has had an interaction (without one the browsers refuse
 *  it and log a warning) */
export function audioAllowed() {
  if (ctx && ctx.state === 'running') return true;
  const ua = navigator.userActivation;
  return ua ? ua.hasBeenActive : !!ctx;
}

/** in a user interaction's handler: create / resume the context while the browser allows it (only if sound is
 *  wanted - a viewer who switched it off gets no running context) */
export function primeAudio() {
  if (!soundWanted() || !audioAllowed()) return;
  const c = audioContext();
  if (c && c.state !== 'running') c.resume().catch(() => {});
}
