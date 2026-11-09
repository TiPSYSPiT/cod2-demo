# Third-party libraries (vendor/)

The page loads its only external library from here, through the import map in `index.html`.
No build step, no npm: the files are the package's own files, unchanged.

| Library | Version | Files | Source | Licence |
|---|---|---|---|---|
| three.js | 0.187.0 (r187) | `three/build/three.module.js`, `three/build/three.core.js`, `three/examples/jsm/controls/OrbitControls.js` | npm package `three@0.187.0` (`https://registry.npmjs.org/three/-/three-0.187.0.tgz`, SHA-512 checked against the registry's `dist.integrity`) | MIT, `three/LICENSE` |

SHA-256 of the files (identical to `https://cdn.jsdelivr.net/npm/three@0.187.0/...`, checked 2026-11-09):

```
104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341  three/build/three.module.js
613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578  three/build/three.core.js
e7fca2fe9e7670a828af9b28084669a5909445b7f36f1f26cee9bf8f2961c32c  three/examples/jsm/controls/OrbitControls.js
```

Before: 0.170.0 (r170) until 2026-11-09 (PLAN.md step 86).

The folders follow the npm package, so an addon's own `import ... from 'three'` resolves through
the same import map entry: `'three'` and `'three/addons/'` always come from the same copy and
version. Since r171 `three.module.js` imports `./three.core.js` (the part shared with the WebGPU build): both
files belong together. The only addon used
is `OrbitControls` (`js/view3d/cameras.js`); the MP4 writer and the GIF encoder are this
project's own code (`js/c4/ui/map/mp4mux.js`, `gifenc.js`), the fonts are the system's.

## Why local, not the CDN

An import map is fixed once the first module loads, and the addons import the bare `'three'`, so
the page can't switch from a CDN to a local copy at run time without a bootstrap script that
probes the CDN first (a delay on every start, and a second source to keep in step). The local copy
works offline (`py -m http.server`), on GitHub Pages and with the CDN blocked, and always loads
exactly one three.js. The CDN stays a documented alternative: the two URLs are in a comment above
the import map in `index.html` - replace both entries together, never only one.

## Updating

1. Read the new version's integrity from `https://registry.npmjs.org/three/<version>` (`dist.integrity`),
   download `dist.tarball` and check its SHA-512 against it.
2. Copy `package/build/three.module.js` and the files it imports itself, if any (`grep -n "from '" `
   on it: newer releases split it into more files, e.g. `three.core.js`), every addon the code imports (`grep -rn "three/addons" js`) with its folder below
   `package/examples/jsm/`, and `package/LICENSE` into `vendor/three/`.
3. Change the version here and in the CDN comment in `index.html` (the import map itself keeps its paths, so the
   CSP hash in `index.html` stays valid), then compare the look and run the checks: `py tools/serve.py 8778 --three
   <the old package folder>` serves the old version beside the new one with the same site; suite `looks` against
   each (`--base http://localhost:8778/ --tag a`, then the default server `--tag b`) and `node
   tools/audit/looks_compare.mjs a b` (per map and view the pixels that changed, difference images); then the
   browser suites (README "Checks").
