# Audits – CoD2 demo viewer

## Final full review – 2026-10-27 (after PLAN.md steps 1–54: functionality, memory, security, GitHub Pages)

Phase 1, review only: no project file changed except this report. Everything re-run from scratch; the new test
drivers live in the session's scratch folder, not in the project (headless Chrome / Edge over the DevTools
protocol, Firefox over WebDriver BiDi, a CSP test server, a case-sensitive GitHub Pages stand-in, a parser fuzzer).
Browsers: Chrome 156.0.8078.48, Edge 156.0.4314.42 and Firefox 158.0.1 (headless, software WebGL) and the desktop
app's Chromium (GPU) for performance and window sizes. Safari: not available.

### Result in short

**No critical or major issue. Ready for GitHub Pages.** Recommended before going live: the four small items R1–R4
(robustness of map names, `?demo=` restricted to the site, a tested Content-Security-Policy, the visitor-facing
"no map data" text) - about 1 h together. Everything else is cosmetic or information.

### 1. Functionality

- **Maps** (`map_audit.py --game`, all 32): geometry exported = BSP on every map (3,549,208 triangles),
  **39,117 / 39,117 model placements rendered**, MGs = the BSP's on every map, 0 missing textures / files,
  0 critical / major; only the known `$default` technique note (20 maps). `maps.json` identical to the last run.
  Spawn alignment (`check_alignment.py --spawns`, 32 maps): 100 % inside the top-down everywhere, 95.3–100 % on
  rendered 2D ground, 100 % inside the zPAM radar on all 16 radar maps, 87.5–100 % on a 3D triangle (mp_brecourt
  87.5 %: spawns in grass props, as before); identical to the last run. `leftovers.py`: no flash / stun leftovers.
- **Demos** (`demo_audit.mjs`, all 14 - S&D and DM; no TDM / CTF / HQ demo exists): identical to the last run field
  by field (players, teams, kills, assists, weapons, grenades, scores = the server's, rounds / halves, bomb events,
  MG tracks, clean ends); parse ≤ 2.2 s (in a worker). The one "[major]" line is the audit's known position-jump
  heuristic on the 46-round Carentan match (zPAM's halftime teleports).
- **UI** (`ui_audit.js`, 118 steps: every rail option, drawer, eye / stats, details tabs, playback, seek, speeds,
  range, marks, export dialogs, keys): 0 failures, errors, warnings, failed requests - in the app's Chromium, in
  Chrome 156, Edge 156 and Firefox 158, and once with hostile names (section 3).
- **Video export**: 3D MP4 (1 s, 31 frames, sound) and 2D GIF (2 s) in Chrome (AAC), Edge (AAC) and Firefox
  (**Opus**: Firefox has no AAC encoder - README says so); 2D MP4 of a whole round and 3D 3 s earlier today.
- **X-Ray** (`xray_audit.js`, toujane, 10:00): 11 / 12 checks pass; "players in sight unchanged" flags 3 of 20
  views: one is B9 (the sight line through the own head, 33 px, a known limit), two (118 / 183 px) a player half
  behind a thin wooden post - the audit's rays miss the post, the tinted strip lies right at its edge (R7).
- **Settings**: view, camera, players, shadows, kill feed, drawer survive a reload; X-Ray for the session.
- **Window sizes** (app's Chromium, 2D and 3D): 1366 × 768, 1920 × 1080, 2560 × 1440, 1100 × 700 - no scroll bar,
  bar inside; 1024 × 700 and 375 × 812 - stacked, bar inside, no horizontal scroll.
- **Console**: no error or warning in any run, except the expected ones in R1's hostile test.

### 2. Memory and performance

- **Long session** (headless Chrome, DevTools heap after forced GC; 7 demos on 7 maps one after another, each
  2D + 3D, 5 view toggles, 120 random seeks, playback; a 3D MP4 + 2D GIF export after the third): heap 33.6 →
  33.8 → 34.0 → 35.5 → 31.1 → 33.4 → 46.1 (the 46-round Carentan match) → 34.6 MB - **stable**; only the
  current demo alive (`WeakRef`s of every earlier demo, replay and 3D view collected); window / document
  listeners constant at 11 / 2; always 3 canvases; WebGL resources per map (geometries 113–161, textures
  400–597), not growing. Final heap snapshot: 1 View3D, 1 View2D, 1 Replay, 1 Match, 1 WebGLRenderer.
- **Disposal** (code): window listeners removed (`MapRenderer.dispose`, `Cameras.dispose`, `View3D.destroy`,
  dialogs), the render loop stops with the view, workers terminated (parser after each demo, GIF encoder),
  every object URL revoked (downloads after 1–4 s, worker blobs after 10 s), `VideoEncoder` / `AudioEncoder`
  closed in `finally`, the AudioContext closed with the sound system.
- **Performance** (app's Chromium with GPU, 1920 × 1032, map overview; one frame forced and synchronised):
  median 4.5–9.8 ms, P95 ≤ 17.1 ms on the biggest maps (Crossroads 628k triangles / 685 draw calls, Breakout,
  Leningrad MJR, Brécourt 8,592 props, Rhine, Carentan) - 60 fps; load of the map data 0.3–0.7 s from the local
  disk (on the web the download dominates: ~15–25 MB per map + 17 MB characters); main thread blocked at most
  0.25–0.41 s once while the 3D view builds. Live fps not measured: the app reported the pane hidden (throttled).

### 3. Security

- **Untrusted demo text**: no `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` /
  `new Function` anywhere; every DOM text goes through `el()` / `append()` (`textContent`, text nodes,
  `setAttribute`); colour codes parsed into text spans; canvas text via `fillText`. **Test**: names, team names,
  clan tags, server name and chat replaced by `<img src=x onerror=…>`, `<svg onload=…>`, `<script>`, `"><iframe>`
  (injected into the parser's config strings / server commands and the analysis result), then the full UI audit,
  every details tab, 3D labels with X-Ray names: **nothing executed, no element created**, the text shown literally
  everywhere. Hostile map names (`../../index`, HTML, 5,000 characters, empty) fall back cleanly - except R1.
  Download file names: only letters, digits and "-" (`exportName.js`).
- **Malformed files** (parser fuzzer, 87 cases, each in its own worker with a 30 s limit: cuts at 0.1–99.9 %,
  10–200,000 random bytes changed, random 8 KB blocks, record lengths huge / negative / zero, 0xFF / zeroed message
  bodies, 4× concatenated demos, empty, 12 bytes, 64 MB of zeros / 0xFF, 32 MB random, 32 MB valid framing with
  random bodies, maximum-length records): **0 hangs, 0 crashes, 0 unexpected exceptions** - 56 load with
  warnings, 31 are rejected with a clear message; slowest 1.06 s, heap ≤ 143 MB. Bounds: record ≤ 128 KB, Huffman
  output capped, reads past the end set an overflow flag; the stored issue list is capped at 50 (the raw list
  in the collector is not - 60,000 entries for a file of zeroed messages, harmless).
- **Parsing / prototype pollution**: no `JSON.parse` of untrusted data except the settings (try / catch, every
  value validated); no object built from untrusted keys; lookups by map name read `__proto__` (R1, read only).
- **URL parameters**: `?debug` (surface picker, a console line), `?shadows`, `?sound`, `?fx`, `?cam` (numbers),
  `?t`, `?focus`, `?view` - harmless; **`?demo=<url>` fetches any URL** that allows CORS (R2).
- **Third-party resources**: none. three.js r170 in `vendor/` (pinned, byte-identical to the npm release), fonts
  self-hosted; the CDN lines in index.html are a comment. SRI: not needed (all same-origin).
- **CSP** (R3): none yet. Tested policy, **0 violations in Chrome 156 and Firefox 158** with 2 demos, 2D / 3D,
  X-Ray, sound, the UI audit and both exports (served as a header by a test server; the same as a `<meta>`):
  `default-src 'self'; script-src 'self' 'sha256-Mne3CI18ZSns61UE2acmcxBJb8wPiixDKJMLGynStww='; worker-src 'self'
  blob:; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:;
  object-src 'none'; base-uri 'self'; form-action 'none'` (the hash is the inline import map's - it must change
  with the import map; `blob:` workers: the parser and the GIF encoder; `frame-ancestors` cannot be set by a meta
  tag and GitHub Pages sends no headers - no clickjacking protection possible, low risk: the page has no
  account or action to hijack). It also blocks `eval` and limits `?demo=` to the site.
- **Links**: the one external link (GitHub) has `target="_blank" rel="noopener noreferrer"`.
- **Repo hygiene**: no secrets, tokens, user names, e-mail addresses, localhost URLs (but the local-server docs in
  `tools/serve.py` / README) or local paths in served files or data; one local path in a tool: R5. `.gitignore`:
  `demos/`, `.claude/`, `__pycache__`, `*.pyc`, `tools/export/_work/`, `tools/audit/out/`.
- **localStorage**: only display settings (`cod2demo3d.*`, `cod2demo.heatmap`; X-Ray in sessionStorage), each read
  in try / catch and checked against its allowed values / ranges.

### 4. GitHub Pages readiness

- `site_audit.py`: manifest = the 3,520 data files (size and hash), 0 broken references, 0 case mismatches
  (95 code, 26,306 data, 135 registry / icon references), `.nojekyll` present (folders starting with `_`), only
  the kept `?debug` `console.log`. **Pages stand-in** (served only under `/cod2-demo/`, exact case, everything else
  404): Edge 156 ran the whole scenario with 0 failed requests and no 404.
- Size: **575.2 MB in 3,638 files**; largest `maps3d/mp_rhine/world.bin` 13.9 MB, nothing over 50 MB (GitHub's
  warning) or 100 MB (its limit); under Pages' 1 GB site limit. Pages' soft bandwidth limit (100 GB / month)
  allows roughly 2,500–4,000 visits that open the 3D view (R9).
- Head: title "CoD2 Demo Viewer", description, viewport, favicon, `lang="en"`; README (features, credits with
  CoD2x / zPAM 3 links, licence and game-data note), LICENSE (GPL-3.0) present. The page itself shows no licence
  or disclaimer (R6); no Open Graph tags (R8).

### 5. Findings

| # | Category | Finding | How to reproduce | Affected | Severity | Proposed fix | Effort |
|---|---|---|---|---|---|---|---|
| R1 | bug | A demo whose map name is `__proto__` or `constructor` passes the map lookup (inherited object properties): the 3D view requests `maps3d/__proto__/world.json` (404), logs 2 console errors and says "could not be loaded" instead of the grid fallback; the display name is "undefined" | a demo with such a `mapname` (crafted; tested by injecting it) | all browsers, crafted demos only | minor | `Object.hasOwn` in `resolveMap` (`js/view3d/mapLoader.js:26`) and in `assets/maps/maps.js` (`resolve` lines 56–57, `backgrounds` line 70) | ¼ h |
| R2 | security | `?demo=<url>` fetches any URL that allows CORS: a link to the site can load an arbitrary (e.g. huge or offensive-named) file from elsewhere under the site's name | `index.html?demo=https://…/x.dm_1` | all | minor | allow only a relative path on the site (or drop the parameter; R3 enforces it too) | ¼ h |
| R3 | security | No Content-Security-Policy | – | all | minor (hardening) | the tested policy above as `<meta http-equiv="Content-Security-Policy">` in index.html; README note: update the hash when the import map changes | ¼ h |
| R4 | bug (UX) | For a map without data the 3D view tells visitors "run tools/export/export_maps.py (see README)" - developer advice on the live site | a demo on a custom map | all | cosmetic | "No 3D data for this map on this site - shown on a grid" (keep the hint in the console) | ¼ h |
| R5 | deployment | `tools/audit/map_audit.py` defaults `--game` to a local path (`C:/Claude/cod2`) | read the file | repo | cosmetic | no default (required argument), like the export scripts | 5 min |
| R6 | deployment | The page shows no licence, credits or Activision disclaimer (only README / LICENSE in the repo) | open the site | visitors | cosmetic | a short "About" group in the Match info popover: GPL-3.0, link to the source, "not affiliated with Activision" | ½ h |
| R7 | bug? | X-Ray tints a strip of a player standing half behind a thin post although the audit sees no cover (118–183 px) - correct or a few pixels too wide at the cover's edge, not decided | toujane 10:00, client 3 (xray_audit) | 3D, X-Ray | cosmetic | investigate only if wanted; else a known limit with B9 | 1 h |
| R8 | deployment | No Open Graph / Twitter meta tags: a shared link shows no preview | share the URL | – | cosmetic | `og:title`, `og:description`, `og:image` (a 1200 × 630 screenshot) | ½ h |
| R9 | info | Bandwidth: a 3D visit downloads ~35–45 MB (map + characters, sounds when switched on); Pages' soft limit 100 GB / month | – | – | info | none now; watch the traffic (or move `maps3d/` to a CDN later) | – |
| R10 | info | Not covered: Safari (not available), live fps in a visible window (the app throttled the pane), TDM / CTF / HQ demos (none exist) | – | – | info | a manual pass in Safari and a real window after the deploy | – |
| R11 | info | README says "Tested with Chrome / Edge" - now also Firefox 158 | – | – | cosmetic | update in phase 2 | – |

Known limits, unchanged: B9 (X-Ray along the own sight line), headshot weapons ≈, assists only in zPAM demos,
`$default` surfaces dark, debug hooks kept (`window.cod2`, `__exportNoDownload`, `?debug`).

### 6. Recommendation

Nothing blocks going live. **Fix before going live: R1, R2, R3, R4** (~1 h, all small and safe); R5 with them
(5 min). Optional: R6 and R8 (presentation), R7 (investigation). After the deploy: `py tools/check_deploy.py check
--url https://tipsyspit.github.io/cod2-demo/` and a manual Safari pass (R10).

### 7. Fixes and re-test (approved by the user: R1–R5 – PLAN.md step 55)

| # | Status | Fix | Re-test |
|---|---|---|---|
| R1 | ☑ fixed | Own keys only (`Object.hasOwn`) in `assets/maps/maps.js` (`resolve`, `backgrounds`) and `resolveMap` (`js/view3d/mapLoader.js`) | map names `__proto__`, `constructor`, `toString`, `hasOwnProperty`, `../../index`: grid fallback, no request, no console error (one info line); `mp_toujane` / `mp_toujane_x` still resolve; demo audit of the 14 demos identical |
| R2 | ☑ fixed | `?demo=` resolved against the page and accepted only on the page's origin (`js/app/main.js`); else "?demo= opens only a demo file on this site (a path such as demos/my.dm_1)." | relative, root-relative and same-origin URLs load; `https://…`, `//host/…`, `data:`, `javascript:` rejected; missing / malformed paths: "Could not load …: HTTP 404" |
| R3 | ☑ fixed | The tested policy as `<meta http-equiv="Content-Security-Policy">` at the top of `index.html` (comment: the hash belongs to the import map); README deploy step 5 says how to update it | Chrome 156 and Firefox 158 against the plain server (the meta tag only): 0 violations, 0 console errors / warnings, UI audit 118 / 118, 3D MP4 + 2D GIF export; the app's Chromium: demos, 2D / 3D, all 32 maps |
| R4 | ☑ fixed | Visitors read "This site has no 3D data for <map>. Showing a grid as the ground."; the export hint went to `console.info` (`js/view3d/view3d.js`) | shown for every unknown map name above |
| R5 | ☑ fixed | `--game` is required in `tools/audit/map_audit.py` (as in the export scripts); the usage line shows the README's example path | without `--game`: the argparse error; no local path left in the repo |

Also re-checked: `site_audit.py` unchanged (0 broken references, the `?debug` `console.log`). A stale console entry
"Shader Error … Too many attributes (cBinormal)" (prop materials, from an earlier session) was checked on this GPU
(NVIDIA T400, 16 vertex attributes - the usual limit): all 32 maps in 3D, **0 shader errors** - the props already
drop the instance colour to stay within 16 (`props.js`); not a current issue.

### 8. Phase 2 – cleanup (approved by the user item by item – PLAN.md step 56)

Searched from scratch: no caches, temp files, backups or one-off scripts (every file in `tools/` is used or
documented; `tools/audit/demo_detail.mjs` now in README); **no unused assets or data** (all 2,296 shared
textures referenced, every file of a map folder loaded by a 3D session - `radar.webp` when chosen in 2D; the
licence texts are the only files no code names); every CSS class (290) and icon (24) used; no commented-out code.
Removed: 7 CSS custom properties never read and one main.js line (above). Corrected: two outdated comments
(view3d.js sound, text.js "Promod's"). Kept (the user's decisions): debug hooks, small unused helpers, the
`shadowDt` parameter, publishing from the branch (tools/, notes, LICENSE served too: about 0.45 MB).

Final quick test: Chrome 156 and Firefox 158 with the CSP meta tag - 2 demos, 2D / 3D, X-Ray "Player + name",
sound, playback, `ui_audit.js` 118 / 118, 3D MP4 (31 frames, AAC / Opus) and 2D GIF: 0 CSP violations, 0 console
errors or warnings, 0 failed requests (a first Chrome run logged 4 refused connections to the local test server,
not seen by the page and not reproduced with the URLs recorded); the app's Chromium (GPU): X-Ray off / player /
names, team colours A red / B blue, no console message; `site_audit.py`: 0 broken references, only the kept
`?debug` `console.log`.

---

## Final check before going live – 2026-10-27 (GitHub Pages, after PLAN.md steps 1–51)

Phase 1, test only: no viewer code or data changed. New in `tools/audit/`: `site_audit.py` (GitHub Pages
readiness: manifest, references with exact case, `.nojekyll`, sizes, leftovers, page head). Everything below was
re-run from scratch; browser tests ran in the desktop app's Chromium 152 (Edge uses the same engine; Firefox and
Safari were not available).

### Result in short

**Ready for GitHub Pages, with two issues to fix first:** a memory leak when several demos are opened one after
another in the same tab (B1), and the fonts loaded from Google's servers (B2, a GDPR risk for a site run from
Germany). Everything else is minor or cosmetic.

### 1. Assets and data (all 32 MP maps)

- `tools/audit/map_audit.py`: geometry = BSP on all maps (3,549,208 triangles), **39,117 / 39,117 model
  placements render** (188 MGs, 80 skinned, 0 without geometry), 0 surfaces without a colour map, 0 referenced
  files missing, 0 models outside their bounds, exploders = the BSP's groups on every site; only the known
  `default` technique on 20 maps (no action).
- Spawn alignment (`check_alignment.py`): identical to audits 1–3; the 32 top-downs pixel-identical to the
  images before steps 41–51.
- `tools/audit/site_audit.py`: `maps3d/manifest.json` matches all 3,520 data files (size and hash: the 3D view
  rejects a mismatch); **0 broken references, 0 case mismatches** in 94 code references (index.html, import map,
  imports, CSS, path literals), 26,306 data references (every file named in the maps' JSON) and 135 registry /
  kill icon references; files and folders starting with `_` (`maps3d/_textures`, `_fx`, `_sound`, `_characters`,
  generated textures) – `.nojekyll` is present; no local absolute paths, no localhost URLs, no `debugger`.
- Size of the site (index.html, favicon, js, css, vendor, assets, maps3d): **575 MB in 3,632 files**, largest
  file 13.9 MB (`maps3d/mp_rhine/world.bin`), none over 50 MB; `demos/` (85 MB) is excluded by `.gitignore`.
  `.gitattributes` keeps text LF (the manifest hashes) and binaries untouched, no Git LFS (Pages would serve the
  pointers). After the deploy: `py tools/check_deploy.py check --url https://tipsyspit.github.io/cod2-demo/`.
- Icons, favicon, header logo (inline SVG) present; kill icons for every weapon incl. all four frag grenades;
  zPAM radar images on **16** maps (the README says 10, audits 1–3 said 15 – both wrong).

| Map | Stock | Geometry (BSP = exported) | Models rendered / placed | MGs | Skinned | In S&D | Missing textures | 2D top-down / radar | Spawns on 2D / 3D floor | Entities |
|---|---|---|---|---|---|---|---|---|---|---|
| mp_breakout | yes | OK 167936 | 987 / 987 | 0 / 0 | 4 | 987 | 0 | yes / - | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_breakout_tls | zPAM | OK 139309 | 546 / 546 | 1 / 1 | 2 | 546 | 0 | yes / yes | 97.2 % / 100.0 % | 106 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_brecourt | yes | OK 45237 | 8592 / 8592 | 12 / 12 | 22 | 8568 | 0 | yes / - | 98.4 % / 87.5 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_burgundy | yes | OK 56232 | 1548 / 1548 | 7 / 7 | 0 | 1542 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_burgundy_fix | zPAM | OK 56739 | 1543 / 1543 | 7 / 7 | 0 | 1537 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_carentan | yes | OK 118352 | 1546 / 1546 | 10 / 10 | 0 | 1539 | 0 | yes / yes | 96.1 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_carentan_bal | zPAM | OK 119529 | 1551 / 1551 | 10 / 10 | 0 | 1544 | 0 | yes / - | 100.0 % / 99.2 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_carentan_fix | zPAM | OK 118496 | 1551 / 1551 | 10 / 10 | 0 | 1544 | 0 | yes / yes | 95.3 % / 99.2 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_chelm_fix | zPAM | OK 103158 | 995 / 995 | 1 / 1 | 2 | 995 | 0 | yes / - | 100.0 % / 100.0 % | 104 spawns, 2 zones; exploders B 1 / 1 |
| mp_crossroads | zPAM | OK 188736 | 2970 / 2970 | 7 / 7 | 2 | 2964 | 0 | yes / - | 100.0 % / 100.0 % | 129 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_dawnville | yes | OK 98475 | 620 / 620 | 7 / 7 | 4 | 614 | 0 | yes / yes | 96.9 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_dawnville_fix | zPAM | OK 100864 | 621 / 621 | 7 / 7 | 4 | 615 | 0 | yes / yes | 95.3 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_dawnville_sun | zPAM | OK 98641 | 671 / 671 | 7 / 7 | 4 | 665 | 0 | yes / - | 99.2 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_decoy | yes | OK 26959 | 390 / 390 | 7 / 7 | 7 | 380 | 0 | yes / - | 97.2 % / 100.0 % | 106 spawns, 2 zones; exploders A 1 / 1, B 1 / 18 |
| mp_downtown | yes | OK 141868 | 279 / 279 | 6 / 6 | 1 | 265 | 0 | yes / - | 99.2 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_farmhouse | yes | OK 70093 | 2352 / 2352 | 8 / 8 | 0 | 2336 | 0 | yes / - | 98.4 % / 100.0 % | 128 spawns, 2 zones; exploders A 0 / 15, B 1 / 4 |
| mp_harbor | yes | OK 163534 | 617 / 617 | 0 / 0 | 0 | 617 | 0 | yes / - | 99.3 % / 98.6 % | 144 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_leningrad | yes | OK 134629 | 660 / 660 | 1 / 1 | 0 | 660 | 0 | yes / - | 100.0 % / 100.0 % | 133 spawns, 2 zones; exploders A 1 / 1, B 0 / 11 |
| mp_leningrad_mjr | zPAM | OK 167180 | 652 / 652 | 1 / 1 | 0 | 652 | 0 | yes / yes | 100.0 % / 100.0 % | 132 spawns, 2 zones; exploders A 1 / 1, B 0 / 11 |
| mp_leningrad_tls | zPAM | OK 143728 | 655 / 655 | 1 / 1 | 0 | 655 | 0 | yes / - | 100.0 % / 100.0 % | 133 spawns, 2 zones; exploders A 1 / 1, B 0 / 11 |
| mp_matmata | yes | OK 119500 | 700 / 700 | 11 / 11 | 2 | 691 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_matmata_fix | zPAM | OK 119654 | 724 / 724 | 11 / 11 | 2 | 715 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_railyard | yes | OK 132299 | 446 / 446 | 8 / 8 | 0 | 440 | 0 | yes / - | 100.0 % / 98.4 % | 125 spawns, 2 zones; exploders A 0 / 11, B 1 / 1 |
| mp_railyard_mjr | zPAM | OK 145042 | 422 / 422 | 8 / 8 | 0 | 416 | 0 | yes / yes | 100.0 % / 100.0 % | 83 spawns, 2 zones; exploders A 0 / 21, B 1 / 1 |
| mp_rhine | yes | OK 192415 | 1420 / 1420 | 0 / 0 | 0 | 1420 | 0 | yes / - | 97.4 % / 96.5 % | 114 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_toujane | yes | OK 62570 | 379 / 379 | 10 / 10 | 6 | 364 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones |
| mp_toujane_fix | zPAM | OK 63517 | 379 / 379 | 10 / 10 | 6 | 364 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones |
| mp_trainstation | yes | OK 116696 | 1508 / 1508 | 10 / 10 | 4 | 1500 | 0 | yes / yes | 98.4 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_trainstation_bhg | zPAM | OK 113326 | 1280 / 1280 | 0 / 0 | 2 | 1280 | 0 | yes / - | 97.5 % / 98.3 % | 118 spawns, 2 zones; exploders A 1 / 1 |
| mp_trainstation_fix | zPAM | OK 116838 | 1508 / 1508 | 10 / 10 | 4 | 1500 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_vallente_fix | zPAM | OK 107160 | 1005 / 1005 | 0 / 0 | 2 | 1005 | 0 | yes / yes | 99.1 % / 100.0 % | 112 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| wawa_3daim | zPAM | OK 496 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | yes / - | 100.0 % / 100.0 % | 26 spawns, 0 zones |

### 2. Demo parsing (14 demos) and broken files

- `tools/audit/demo_audit.mjs`: identical to the run after step 51, field by field – players, teams, kills,
  weapons / means of death, headshots (≈, data limit), assists (zPAM: exact in 7 matches, ≈ in 2, none in 2 + the
  stock demos), grenades (2,584, all frag / smoke, four nations), scores = the server's in every S&D match,
  rounds / halves, bomb events and explosions, MG tracks (22 / 22 matched), clean demo ends, no samples in flight.
- Broken input (the viewer's parser in Node, and the page's "Open demo"): a demo cut at 1 %, 20 %, 30 %, 70 % loads
  up to the cut with the warning "The demo is truncated …"; random bytes, an empty file, 4 bytes, `favicon.ico`,
  `index.html` and a CoD4 demo stop at once with "Unsupported or invalid demo: This is not a CoD2 demo (.dm_1) …"
  (or "… too small …"); a valid demo loads normally afterwards.

### 3. 2D, 3D and UI

- `ui_audit.js` (toujane_fix, 3D and 2D): 118 steps – every rail popover option, drawer, player eye / stats, details
  tabs, playback, seek, speeds, range, export marks, export dialog, keys – 0 failures, errors, warnings, failed
  requests; no stored setting changed except the remembered last view.
- `xray_audit.js`: every check passes (modes, key X, session storage, players in sight unchanged, silhouettes only
  behind cover and in the team colour, badges, no dead / stale / switched-off / first-person targets).
- Video export, MP4 (in memory): 2D 15 s / 450 frames 5.8 MB; 3D 1.5 s with X-Ray "Player + name" and AAC sound.
  GIF export checked in audit 3.
- Frame time: toujane_fix at 2560 × 1392: 3.1 ms; mp_brecourt 2.9–7.4 ms at 1920 × 1032 (audit 3).
- Flashbang leftovers (`leftovers.py`): none.
- GitHub link: https://github.com/TiPSYSPiT/cod2-demo (new tab, `noopener`). Title "CoD2 Demo 3D", meta
  description, viewport, favicon, `lang="en"` present.

### 4. Robustness

- Console: no error or warning in any normal run; an invalid file additionally logs its error with a stack trace
  (B5).
- **Memory (B1):** 8 demos opened one after another in one tab (4 maps, each time 3D then 2D): the JS heap grows
  from 186 to 773 MB (≈ +85 MB per demo) and never falls; `WeakRef`s to each demo's data, replay, match and 3D view
  stay alive after 30 s of heavy allocation – every earlier demo is kept. The WebGL renderer is replaced cleanly
  (4 canvases throughout), labels do not pile up.

### 5. Window sizes and browsers

- 1280 × 720, 1366 × 768, 1920 × 1080, 2560 × 1440 (3D and 2D): no overflow, no scroll bar. Below 1099 px the
  layout stacks (view, player bar, drawer below each other; page scrolls) – 375 px (phone) works; at 1024 × 700 the
  bottom row of the player bar (range, speed, *Export video*) is 35 px below the window (B4).
- Browsers: Chromium 152 only. Edge: same engine. **Firefox / Safari not tested** – the features used are supported
  by current versions (WebGL2 incl. occlusion queries and stencil, WebCodecs `VideoEncoder` with the MediaRecorder
  fallback, CSS `color-mix`, canvas `roundRect`, Workers); a manual pass is advised (B8).

### 6. Issues

| # | Issue | How to reproduce | Affected | Severity | Proposed fix | Effort |
|---|---|---|---|---|---|---|
| B1 | **Memory leak: every opened demo stays in memory** (≈ 85 MB each) | open several demos one after another in the same tab (Open demo / drag & drop) | all browsers, every demo; a long session can run out of memory | major | `MapRenderer` (`js/c2/ui/map/renderer.js:123, 129`) adds `mousemove` / `mouseup` on `window` per demo and `Cameras` (`js/view3d/cameras.js:99–100`) `keyup` / `blur` – never removed: keep the handlers and remove them in `View2D.destroy` / `Cameras.dispose`; re-test with the WeakRef check | ½ h |
| B2 | **Fonts from Google's servers** (Inter, JetBrains Mono via fonts.googleapis.com) | open the page: requests to fonts.googleapis.com / fonts.gstatic.com | every visitor | major (legal) | self-host the two fonts (OFL licence) as woff2 in `assets/fonts/` with `@font-face`; drop the Google links – the visitor's IP then goes to no third party (LG München I, 2022) | 1 h |
| B3 | README out of date | read README "Features" | – | minor | add X-Ray, assists (zPAM), MGs aimed from the demo, destroyed bomb-site targets, colour-coded names; radar maps 16 (not 10); planned for phase 2 anyway | ½ h |
| B4 | Player bar partly below the window at ~1000–1099 px width and ≤ 735 px height | window 1024 × 700 | stacked layout | minor | in the stacked layout size the view so that the player bar fits (e.g. `min(…, 100vh - bar)`) | ½ h |
| B5 | Error text for invalid files: "Error: Unsupported or invalid demo: …" (two prefixes), the stack also logged as a console error; a CoD4 demo gets the generic message | open a non-demo / a CoD4 `.dm_1` | – | cosmetic | one prefix; log as a warning; recognise a CoD4 demo ("this is a CoD4 demo") | ½ h |
| B6 | Page title "CoD2 Demo 3D" for a 2D + 3D viewer | browser tab | – | cosmetic | e.g. "CoD2 Demo Viewer" (title, header, README) – only if wanted | ¼ h |
| B7 | Debug / test hooks in the shipped code: `window.cod2` (debugging handle), `window.__exportNoDownload` / `__exportProbe` (test hooks), `?debug` surface picker with a `console.log` | – | inactive unless used on purpose | cosmetic | keep (they cost nothing and the audit scripts use them) or remove in phase 2 | – |
| B8 | Firefox / Safari not tested | – | – | info | a manual pass after the deploy (load a demo, 2D / 3D, X-Ray, an export) | – |

Known limits, unchanged (no action): headshot weapons ≈ (the demos carry none), assists only in zPAM demos,
`$default` surfaces dark (as in the game), no TDM / CTF / HQ / stock S&D test demos.

### 7. Recommendation

Fix **B1** and **B2** before going live; B3 with the phase 2 README update; B4 and B5 are quick and worth doing;
B6–B8 optional.

### 8. Fixes and re-test (approved by the user: B1, B2, B4, B5, B6 – PLAN.md step 52)

| # | Status | Fix | Re-test |
|---|---|---|---|
| B1 | ☑ fixed | Four retainers, not two: the 2D map's `mousemove` / `mouseup` and the 3D camera's `keyup` / `blur` on `window` (now removed in `MapRenderer.dispose` / `Cameras.dispose`); the 3D view's `textureArrivals.onArrive` (a module-level hook, now cleared in `View3D.destroy`); the shared 1 × 1 stand-in textures of `mapLoader.js` – three.js hangs a `dispose` listener on every texture it uploads, and that listener holds the renderer, so a module-level texture kept every closed 3D view with its demo (`releaseStandins()` in `View3D.destroy`). Found with heap snapshots (headless Chrome, retainer paths) | 6 demos one after another, each in 3D and 2D: the 5 earlier demos' data, replay, match, 2D and 3D views are collected (`WeakRef`), heap 112 MB after GC (before: 773 MB after 8 and growing); heap snapshot: no closed `View3D` left |
| B2 | ☑ fixed | Inter and JetBrains Mono self-hosted: `assets/fonts/` (4 woff2, latin + latin-ext, variable weights, 176 KB; OFL texts `Inter-OFL.txt`, `JetBrainsMono-OFL.txt`), `@font-face` in `css/styles.css`; the Google links removed from `index.html` | 0 requests to other hosts; both fonts loaded from `assets/fonts` (`document.fonts`) |
| B4 | ☑ fixed | Stacked layout (< 1100 px): the view's height `--stack-view-h` = max(300 px, min(68vh, 92vw, 100vh − 270 px)) | player bar inside the window at 1099 × 735, 1024 × 700 (bottom 689), 900 × 620, 768 × 1024, 375 × 812; no horizontal scroll; 1366 × 768 (desktop layout) unchanged |
| B5 | ☑ fixed | One prefix ("Unsupported or invalid demo:" / "The demo could not be analysed:" instead of "Error: …"); an invalid file logs one `console.warn` without a stack (a failure of the analysis still logs its stack as an error); a CoD4X demo (type byte 2, protocol, −1) gets "This is a Call of Duty 4 demo (CoD4X, protocol 21). This viewer reads Call of Duty 2 demos only." (a stock CoD4 1.7 header is recognised only when the CoD2 length check already fails – no 1.7 demo to test with) | CoD4X header, random bytes, 4 bytes, a demo cut at 30 % (loads with the truncation warning), then a valid demo: all as expected |
| B6 | ☑ done | "CoD2 Demo Viewer": page title, header, README, PLAN.md, the CSS header comment (the storage keys `cod2demo3d.*` kept: visitors keep their settings) | – |
| B3, B7, B8 | phase 2 / open | README update in phase 2; debug hooks: decided in the phase 2 cleanup; Firefox / Safari: manual pass after the deploy | – |

Re-test of the affected areas (Chromium 152): `ui_audit.js` on nesq…tj – 118 steps, 0 failures / errors /
warnings / failed requests (this time in the stacked layout, the pane was 602 px wide); 4 demos loaded in 2D and
3D; no console errors. `xray_audit.js`: 11 of 12 checks pass; "players in sight unchanged above the feet" failed
twice, at two replay times the earlier runs did not use (the audit takes the current time) – no regression (the
X-Ray code is unchanged), each traced on screen:
- 29:56, a player against a wall with the rifle raised: the barrel and forearm reach into the wall – those pixels
  are behind the wall, the silhouette there is right; the audit's rays aim at the body only (an audit limit).
- 10:00, camera at eye height: the selected player's sight line (the red line from the eye) runs through the
  own head, and X-Ray tints the head along it (32 px, the limit is 30) – **B9**, new, cosmetic: the sight line
  counts as cover for its own player. Left as a known limit (the user's decision, 2026-10-27).

---

## Audit 3 – 2026-10-27 (after PLAN.md steps 46–48: MGs aimed from the demo, model bounds, flashbangs removed, X-Ray)

Read-only for the viewer: no viewer code or exported data was changed. Changed / added in `tools/audit/` only,
plus a temporary second server entry in `.claude/launch.json` for the subpath test (removed again):

| Script | Run / change in this audit |
|---|---|
| `tools/audit/map_audit.py` | re-run on all 32 maps (unchanged since audit 2) |
| `tools/validate/check_alignment.py --spawns` | re-run on all 32 maps – output identical to audit 2 |
| `tools/audit/demo_audit.mjs` | re-run on all 14 demos; **new**: the turrets' aim tracks matched to the map's MG placements, samples of players on an MG |
| `tools/audit/leftovers.py` | **new**: flash / flashbang / concussion / stun in code, styles, pages, assets, the effect table (muzzle flashes excluded) |
| `tools/audit/xray_audit.js` | **new** (browser): X-Ray modes, key X, session storage, per player and camera angle the frame with X-Ray against the frame without it (pixel diff), team-colour tint, badges, targets (dead / stale / switched off / first person), frame time |
| `tools/audit/ui_audit.js` | re-run on two matches; **fixed**: it restored only the first checked radio of a popover, so the heatmap panel's *Team* / *Side* stayed on the last option clicked (stored in localStorage; reset to the defaults in this browser) – now every radio group is restored, checked: no stored setting changes |
| ad hoc (scratch) | 14-demo load sweep 3D + 2D, subpath load, frame timing on mp_brecourt, top-down pixel comparison with the images from before steps 41–47, video export with X-Ray (in memory, no file saved) |

### Summary

- **Previous issues:** #9 (MGs follow their user) and #10 (model bounds) fixed and confirmed; #4 stays a data
  limit, #5 not needed, #7 / #8 unchanged. No issue is open apart from those.
- **Flashbangs:** no leftover anywhere (0 hits outside muzzle-flash contexts); the effect table and the demos
  have frag and smoke grenades only, all four nations, and both draw in 2D / 3D.
- **X-Ray:** every check passes – modes, key X, session storage, players in sight unchanged above the feet,
  silhouettes only behind cover and in the team colour, badges only for players out of sight, no dead / stale /
  switched-off / first-person targets, in the video export, +0.1 to +0.9 ms per frame. One cosmetic finding:
  feet that reach into the ground get the X-Ray tint (new issue 11).
- **No regressions:** geometry, models, exploders, alignment, the 32 top-downs (pixel-identical to before the
  changes), all 14 demos' parse results (identical to audit 2 field by field), UI (118 steps × 2 demos, 0
  failures), no console errors or warnings, no failed requests, subpath works.

### Status of the previous issues

| # | Issue | Status | Evidence (this audit) |
|---|---|---|---|
| 1 | Skinned static models | fixed (audit 2) | map audit: fallback 0 on all maps, 80 skinned placements |
| 2 | Mounted MGs | fixed (audit 2) | map audit: 188 / 188 exported, MGs = BSP on every map |
| 3 | Bomb-site targets | fixed (audit 2) | map audit: exploder parts = the BSP's groups on every site; demo audit: 4 explosions, all at sites with a destroyed model; visual: burgundy B destroyed at 1209.5 s |
| 4 | Headshot weapons | data limit (≈) | demo audit: 285 headshots, all with a weapon (held) |
| 5 | CTF / HQ objectives | not needed (user) | – |
| 6 | Halftime glides | fixed (audit 2) | demo audit: 0 samples in flight |
| 7 | `$default` surfaces | no action | 20 maps with the `default` technique |
| 8 | Test coverage | unchanged | – |
| 9 | MGs don't turn with their user | **fixed** (step 46) | demo audit: 22 of 22 turret tracks in the 14 demos matched to an MG placement (1–3 per demo, up to 1,803 aim samples); players on an MG flagged (up to 1,377 samples); map audit: no MG "above the floor" any more |
| 10 | Model bounds off | **fixed** (step 47) | map audit: 0 models with geometry outside their bounds |

### Flashbang removal (step 48)

- `tools/audit/leftovers.py`: 0 hits for flash / flashbang / concussion / stun outside muzzle-flash contexts in
  `js/`, `css/`, `index.html`, `assets/` (incl. file names) and `tools/`; every remaining "flash" (18 lines) is the
  muzzle flash (`tag_flash`, `fx.js` flashes, `realFlash`). No flash icon in `assets/killfeed/`, no flash entry
  in `maps3d/_fx/effects.json` (grenade weapons: smoke_grenade_* and c_smoke_grenade_* of all four nations).
- UI: the Layers popover's *Grenades* group lists *Smoke* and *Frag*; the stats popup row is "Frags / smokes"; the
  heatmap's "Grenade landings" counts frags.
- Grenades: the 14 demos' 2,584 grenades are all frag (four nations) or smoke (zPAM's c_ variants of four nations,
  stock american / german); 2D check on matmata_fix at 3:54: 7 frags (arcs, landing circles) and 2 smoke clouds
  drawn on the top-down.

### X-Ray (step 48) – `tools/audit/xray_audit.js` on nesq…tj (toujane_fix), timing also on burgundy_fix

| Check | Result |
|---|---|
| Display select Off / Player / Player + name, sessionStorage | OK (and kept after a reload, step 48) |
| Key X cycles Off → Player → Player + name → Off | OK |
| Players in sight (no solid surface on 15 rays to the body): no change above the feet | OK – 15 views, at most 29 px (edge pixels) |
| Feet inside the ground | **tinted** – 4 of 15 views in sight, up to 157 px (issue 11) |
| Players behind cover get the silhouette | OK – 6 views, at least 2,380 px |
| Silhouette in the team colour | OK – 6 of 6 |
| Badge only for players out of sight | OK – none in sight, none without a silhouette; 6 of 6 hidden views with a badge |
| No dead, stale (last known), switched-off targets | OK – 24 times across the match |
| Eye toggle in the player list removes the player | OK |
| First person leaves out the camera's own player | OK |
| Video export (GIF, 1 s, in memory) | silhouettes come from the same frame; the badge drawn in every frame (32 badges / 16 frames, two hidden players) |
| Frame time (forced frames, 587 × 554) | 3 players: off 3.1–3.7 ms, X-Ray +0.1–0.5 ms; 8 players: off 2.4–2.9 ms, X-Ray +0.6–0.9 ms |

The ray test of the script counts only solid surfaces and samples fixed heights: a helmet above a wall is "hidden"
for it and in sight for the view (no badge, correct) – these views count as partial / are excluded.

### 1. Per map

Unchanged against audit 2 in every count (geometry, placements, MGs, exploders, alignment). Models: placements
rendered / placed. MGs: exported / in the BSP. In S&D: placements left after the game type's filter. Exploders:
parts a site's explosion shows / deletes (BSP = exported).

| Map | Stock | Geometry (BSP = exported) | Models rendered / placed | MGs | Skinned | In S&D | Missing textures | 2D top-down / radar | Spawns on 2D / 3D floor | Entities |
|---|---|---|---|---|---|---|---|---|---|---|
| mp_breakout | yes | OK 167936 | 987 / 987 | 0 / 0 | 4 | 987 | 0 | yes / - | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_breakout_tls | zPAM | OK 139309 | 546 / 546 | 1 / 1 | 2 | 546 | 0 | yes / yes | 97.2 % / 100.0 % | 106 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_brecourt | yes | OK 45237 | 8592 / 8592 | 12 / 12 | 22 | 8568 | 0 | yes / - | 98.4 % / 87.5 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_burgundy | yes | OK 56232 | 1548 / 1548 | 7 / 7 | 0 | 1542 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_burgundy_fix | zPAM | OK 56739 | 1543 / 1543 | 7 / 7 | 0 | 1537 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_carentan | yes | OK 118352 | 1546 / 1546 | 10 / 10 | 0 | 1539 | 0 | yes / yes | 96.1 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_carentan_bal | zPAM | OK 119529 | 1551 / 1551 | 10 / 10 | 0 | 1544 | 0 | yes / - | 100.0 % / 99.2 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_carentan_fix | zPAM | OK 118496 | 1551 / 1551 | 10 / 10 | 0 | 1544 | 0 | yes / yes | 95.3 % / 99.2 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_chelm_fix | zPAM | OK 103158 | 995 / 995 | 1 / 1 | 2 | 995 | 0 | yes / - | 100.0 % / 100.0 % | 104 spawns, 2 zones; exploders B 1 / 1 |
| mp_crossroads | zPAM | OK 188736 | 2970 / 2970 | 7 / 7 | 2 | 2964 | 0 | yes / - | 100.0 % / 100.0 % | 129 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_dawnville | yes | OK 98475 | 620 / 620 | 7 / 7 | 4 | 614 | 0 | yes / yes | 96.9 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_dawnville_fix | zPAM | OK 100864 | 621 / 621 | 7 / 7 | 4 | 615 | 0 | yes / yes | 95.3 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_dawnville_sun | zPAM | OK 98641 | 671 / 671 | 7 / 7 | 4 | 665 | 0 | yes / - | 99.2 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_decoy | yes | OK 26959 | 390 / 390 | 7 / 7 | 7 | 380 | 0 | yes / - | 97.2 % / 100.0 % | 106 spawns, 2 zones; exploders A 1 / 1, B 1 / 18 |
| mp_downtown | yes | OK 141868 | 279 / 279 | 6 / 6 | 1 | 265 | 0 | yes / - | 99.2 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_farmhouse | yes | OK 70093 | 2352 / 2352 | 8 / 8 | 0 | 2336 | 0 | yes / - | 98.4 % / 100.0 % | 128 spawns, 2 zones; exploders A 0 / 15, B 1 / 4 |
| mp_harbor | yes | OK 163534 | 617 / 617 | 0 / 0 | 0 | 617 | 0 | yes / - | 99.3 % / 98.6 % | 144 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_leningrad | yes | OK 134629 | 660 / 660 | 1 / 1 | 0 | 660 | 0 | yes / - | 100.0 % / 100.0 % | 133 spawns, 2 zones; exploders A 1 / 1, B 0 / 11 |
| mp_leningrad_mjr | zPAM | OK 167180 | 652 / 652 | 1 / 1 | 0 | 652 | 0 | yes / yes | 100.0 % / 100.0 % | 132 spawns, 2 zones; exploders A 1 / 1, B 0 / 11 |
| mp_leningrad_tls | zPAM | OK 143728 | 655 / 655 | 1 / 1 | 0 | 655 | 0 | yes / - | 100.0 % / 100.0 % | 133 spawns, 2 zones; exploders A 1 / 1, B 0 / 11 |
| mp_matmata | yes | OK 119500 | 700 / 700 | 11 / 11 | 2 | 691 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_matmata_fix | zPAM | OK 119654 | 724 / 724 | 11 / 11 | 2 | 715 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_railyard | yes | OK 132299 | 446 / 446 | 8 / 8 | 0 | 440 | 0 | yes / - | 100.0 % / 98.4 % | 125 spawns, 2 zones; exploders A 0 / 11, B 1 / 1 |
| mp_railyard_mjr | zPAM | OK 145042 | 422 / 422 | 8 / 8 | 0 | 416 | 0 | yes / yes | 100.0 % / 100.0 % | 83 spawns, 2 zones; exploders A 0 / 21, B 1 / 1 |
| mp_rhine | yes | OK 192415 | 1420 / 1420 | 0 / 0 | 0 | 1420 | 0 | yes / - | 97.4 % / 96.5 % | 114 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_toujane | yes | OK 62570 | 379 / 379 | 10 / 10 | 6 | 364 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones |
| mp_toujane_fix | zPAM | OK 63517 | 379 / 379 | 10 / 10 | 6 | 364 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones |
| mp_trainstation | yes | OK 116696 | 1508 / 1508 | 10 / 10 | 4 | 1500 | 0 | yes / yes | 98.4 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_trainstation_bhg | zPAM | OK 113326 | 1280 / 1280 | 0 / 0 | 2 | 1280 | 0 | yes / - | 97.5 % / 98.3 % | 118 spawns, 2 zones; exploders A 1 / 1 |
| mp_trainstation_fix | zPAM | OK 116838 | 1508 / 1508 | 10 / 10 | 4 | 1500 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| mp_vallente_fix | zPAM | OK 107160 | 1005 / 1005 | 0 / 0 | 2 | 1005 | 0 | yes / yes | 99.1 % / 100.0 % | 112 spawns, 2 zones; exploders A 1 / 1, B 1 / 1 |
| wawa_3daim | zPAM | OK 496 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | yes / - | 100.0 % / 100.0 % | 26 spawns, 0 zones |

32 / 32 maps, 3,549,208 triangles, 39,117 / 39,117 placements, 0 surfaces without a colour map, 0 referenced files
missing, 0 models outside their bounds, 0 new placements without support; the 32 top-downs pixel-identical to the
images before steps 41–47.

### 2. Per demo

Every field of `tools/audit/out/demos.json` identical to the run after step 47 (kills, rounds, scores, deaths,
bomb events, headshot sources, explosions, jumps); new turret fields:

| Demo | Mode / map | MG tracks (matched) | Aim samples | Player samples on an MG |
|---|---|---|---|---|
| 2crazY_…_bg_1 | sd / mp_burgundy_fix | 1 (1) | 130 | 70 |
| Ayae_…_rai | sd / mp_railyard_mjr | 2 (2) | 386 | 149 |
| Bl4diii_…_car | sd / mp_carentan_fix | 3 (3) | 1,803 | 1,377 |
| demo0000 | dm / mp_burgundy | 2 (2) | 2 | 0 |
| demo0003 | dm / mp_toujane | 3 (3) | 3 | 0 |
| demo_match_burgundy | sd / mp_burgundy_fix | 1 (1) | 912 | 1,123 |
| demo_ZPAM334_roundStart | sd / mp_toujane | 1 (1) | 8 | 0 |
| demo_ZPAM334_start | sd / mp_toujane | 1 (1) | 6 | 0 |
| gotys_…_val | sd / mp_vallente_fix | 0 (no MGs on the map) | 0 | 0 |
| LamineYamal1_…_mat_1 | sd / mp_matmata_fix | 2 (2) | 486 | 186 |
| nesq_…_tj | sd / mp_toujane_fix | 1 (1) | 752 | 980 |
| siki_…_bre | sd / mp_breakout_tls | 1 (1) | 195 | 426 |
| syncHZ_…_tra | sd / mp_trainstation_fix | 2 (2) | 566 | 860 |
| vorelback_…_dw | sd / mp_dawnville_fix | 1 (1) | 191 | 90 |

Unchanged known findings: headshot weapons ≈ (data), deaths vs. the scoreboard (zPAM halftime kills), "jumps" =
one-step halftime teleports and ready-up grenade jumps (the demo audit rates Bl4diii…car's 122 as "major" only by
its count rule).

### 3. Rendering, playback and UI

- Load sweep: all 14 demos in 3D, then 2D – no failed request, no console error or warning, every demo's MGs
  matched (0–3), exploder parts as in audit 2.
- UI (`ui_audit.js`): 118 steps each on toujane_fix and burgundy_fix (3D and 2D, incl. the X-Ray select), 0 failed
  steps, errors, warnings, failed requests.
- Subpath (`/cod2-demo/`, carentan_fix): 183 requests, 0 failed, none outside the subpath, X-Ray on / off, no
  console messages.
- Performance, mp_brecourt at 1920 × 1032 (forced frames, `gl.finish()`): 2.9–7.4 ms per frame without X-Ray,
  3.5–7.2 ms with it. The main pass draws 229–232 calls / ~540k triangles with the 10 player models in view – 121 /
  450k without them (audit 2: 124 / 458k; its frames had no player models in view).
- Visual: burgundy B destroyed flak 88 (1209.5 s), toujane X-Ray views (full and partial cover), matmata 2D
  grenades, the Display popover.
- Console: the only warnings in the whole session were 4 WebGL "query type does not match target" messages – caused
  by this audit's own probe (it swapped the query constant at run time), not by the viewer; none in any normal run.

### 4. New issues and regressions

No regressions.

| # | Issue | Affected | Likely cause | Severity | Proposed fix | Effort |
|---|---|---|---|---|---|---|
| 11 | **X-Ray tints feet that reach into the ground**: a player in plain sight gets a small team-coloured patch at the boots | X-Ray on, players on slopes / uneven terrain (4 of 15 test views in sight, up to 157 px at 50° field of view) | the boots are a few units below the terrain surface, so they fail the depth test like a body part behind a wall | cosmetic | let the visibility pass count surfaces within a few units in front of the player as in sight (push its vertices ~6 units towards the camera), so ground contact and thin decals no longer count as cover | ~1 h |
| – | Audit tooling: `ui_audit.js` left the heatmap panel's *Team* / *Side* changed | – | only the first checked radio of a popover was restored | – | fixed in this audit (every radio group restored; the stored heatmap setting reset to its defaults) | done |

Info (no action proposed): X-Ray costs about 0.1 ms per shown player (two extra draws per player); with 10
players in view about +1 ms.

#### Status (after audit 3)

| # | Status |
|---|---|
| 11 | fixed – PLAN.md step 49: the lowest 4 units above the player's origin get no silhouette; `xray_audit.js`: feet tinted in 0 of 15 views in sight (before 4, up to 157 px), every other check unchanged |

### 5. Proposed order

1. **#11 X-Ray feet** (cosmetic, small).
2. No action: #4 (data limit), #5 (not needed), #7, #8.

---

## Audit 2 – 2026-10-27 (after the fixes, PLAN.md steps 41–45)

Read-only: no viewer code or exported data was changed. The audit scripts were re-run from scratch and extended
(the only edits, all in `tools/audit/`); a temporary second server entry in `.claude/launch.json` was used for the
subpath test and removed again.

| Script | Run / change in this audit |
|---|---|
| `tools/audit/map_audit.py` | re-run on all 32 maps; **new** `placement_checks`: mounted MGs vs. BSP, placements kept per game type, bomb-site exploder parts vs. the BSP's exploder groups, each model's vertex bounds vs. its declared bounds (a wrong bind pose), new placements without a floor or a prop below them |
| `tools/validate/check_alignment.py --spawns` | re-run on all 32 maps → `tools/audit/out/alignment.txt` |
| `tools/audit/demo_audit.mjs` | re-run on all 14 demos; **new**: samples in flight (glides), headshot weapon sources, bomb explosions vs. the map's destroyed models; suicides / falls no longer counted as "unknown weapon" |
| `tools/audit/ui_audit.js` | re-run in 3D and 2D on two matches; **fixed** its visibility test (fixed-position dialogs have no `offsetParent`, so the export dialog was reported as "no dialog") |
| ad hoc (scratch) | 14-demo load sweep 3D + 2D, subpath load, frame timing on mp_brecourt, top-down pixel comparison with the images from before the fixes, turret entities in the demos |

### Summary

- **All five fixed issues hold up** under the new checks (1, 2, 3, 6 fixed; 4 fixed as far as the demo data
  allows). #5 (CTF / HQ) is not needed (the user's decision); #7 / #8 unchanged.
- **No regressions found.** The 32 top-down images are pixel-identical to those before the fixes; geometry, spawns,
  alignment (2D and 3D), textures and every demo's kills / rounds / scores / deaths are unchanged; no console
  error or warning, no failed request (also under the `/cod2-demo/` subpath).
- **Map data complete:** 32 / 32 maps, 3,549,208 triangles = BSP; **39,117 of 39,117 model placements render**
  (none without geometry; first audit: 38,823 of 38,881 + 188 MGs missing) – incl. 188 / 188 mounted MGs and 80
  skinned-model placements; 0 surfaces without a colour map, 0 referenced files missing; in S&D 38,920
  placements remain after the game type's filter.
- **New issues:** one minor (mounted MGs don't turn with the player using them), one cosmetic (two ivy models'
  geometry outside their declared bounds, existed before). Details below.

### Status of the previous issues

| # | Issue (audit 1) | Status | Evidence (this audit) |
|---|---|---|---|
| 1 | Skinned static models not rendered (58 placements, 18 maps) | **fixed** | map audit: fallback 0 on all maps, 80 skinned placements; vertex bounds inside the declared bounds for every skinned model; visual: brecourt's wrecked flak 88 under its camouflage net (legs, carriage on the ground), toujane's 88 in the DM demo, burgundy's flak 88s |
| 2 | Mounted MGs missing (188 entities, 26 maps) | **fixed** | map audit: MGs exported = BSP on all 32 maps (188); in S&D only the sd / untagged copies remain (e.g. burgundy_fix 1,543 placements → 1,537); visual: carentan's MG42 on its sandbags, burgundy's window MG42 |
| 3 | Bomb-site targets never destroyed | **fixed** | map audit: on every site the exported destroyed / deleted parts match the BSP's exploder group (sites with only deletions: farmhouse A, leningrad ×3 B, railyard ×2 A; nothing to swap: toujane ×2, chelm A, trainstation_bhg B – as in the game); demo audit: all 4 explosions in the demos (burgundy_fix B, vallente_fix A ×2, trainstation_fix B) are at sites with a destroyed model; visual (step 43 check): burgundy B intact → destroyed at 1204.8 s → intact in the next round |
| 4 | Headshot weapons approximate | **fixed as far as the data allows** | demo audit: 285 headshots, all with a weapon (source "held", ≈); the bullet-hit events now give the shooter (clientNum) but carry weapon 0 in every demo – the exact weapon is not in the data. LamineYamal…mat_1's headshot without a weapon (old field mapping) is gone |
| 5 | CTF flags / HQ radios not shown | **not needed** (the user's decision) | – |
| 6 | Halftime glides | **fixed** | demo audit: 0 samples in flight in all 14 demos; the remaining "jumps" are one-step teleports (zPAM's moves, now instant) and vertical pops of ~140 units during ready-up (z rises ~1,000 u/s afterwards – grenade jumps, data as recorded) |
| 7 | `$default` surfaces dark | no action (the game draws them the same) | 20 maps still have the unclassified `default` technique (2–209 triangles) |
| 8 | Test coverage (no TDM / CTF / HQ / stock S&D demo) | unchanged | – |

### 1. Per map

Models: placements rendered / placed (audit 1 in brackets). MGs: exported / in the BSP. In S&D: placements left
after the game type's filter. Exploders per site: parts the explosion shows / deletes in the BSP (all exported).
Spawns on 2D / 3D floor: share of all spawn points on rendered top-down pixels / with a world floor 0–96 units below
(identical to audit 1).

| Map | Stock | Geometry (BSP = exported) | Models rendered / placed | MGs | Skinned | In S&D | Missing textures | 2D top-down / radar | Spawns on 2D / 3D floor | Entities; exploders per site |
|---|---|---|---|---|---|---|---|---|---|---|
| mp_breakout | yes | OK 167936 | 987 / 987 (983 / 985) | 0 / 0 | 4 | 987 | 0 | yes / - | 100.0 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_breakout_tls | zPAM | OK 139309 | 546 / 546 (542 / 543) | 1 / 1 | 2 | 546 | 0 | yes / yes | 97.2 % / 100.0 % | 106 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_brecourt | yes | OK 45237 | 8592 / 8592 (8558 / 8578) | 12 / 12 | 22 | 8568 | 0 | yes / - | 98.4 % / 87.5 %¹ | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_burgundy | yes | OK 56232 | 1548 / 1548 (1539 / 1539) | 7 / 7 | 0 | 1542 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_burgundy_fix | zPAM | OK 56739 | 1543 / 1543 (1534 / 1534) | 7 / 7 | 0 | 1537 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_carentan | yes | OK 118352 | 1546 / 1546 (1534 / 1534) | 10 / 10 | 0 | 1539 | 0 | yes / yes | 96.1 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_carentan_bal | zPAM | OK 119529 | 1551 / 1551 (1539 / 1539) | 10 / 10 | 0 | 1544 | 0 | yes / - | 100.0 % / 99.2 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_carentan_fix | zPAM | OK 118496 | 1551 / 1551 (1539 / 1539) | 10 / 10 | 0 | 1544 | 0 | yes / yes | 95.3 % / 99.2 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_chelm_fix | zPAM | OK 103158 | 995 / 995 (992 / 993) | 1 / 1 | 2 | 995 | 0 | yes / - | 100.0 % / 100.0 % | 104 spawns, 2 zones; A – (effect only), B 1 / 1 |
| mp_crossroads | zPAM | OK 188736 | 2970 / 2970 (2960 / 2961) | 7 / 7 | 2 | 2964 | 0 | yes / - | 100.0 % / 100.0 % | 129 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_dawnville | yes | OK 98475 | 620 / 620 (609 / 611) | 7 / 7 | 4 | 614 | 0 | yes / yes | 96.9 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_dawnville_fix | zPAM | OK 100864 | 621 / 621 (610 / 612) | 7 / 7 | 4 | 615 | 0 | yes / yes | 95.3 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_dawnville_sun | zPAM | OK 98641 | 671 / 671 (660 / 662) | 7 / 7 | 4 | 665 | 0 | yes / - | 99.2 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_decoy | yes | OK 26959 | 390 / 390 (376 / 382) | 7 / 7 | 7 | 380 | 0 | yes / - | 97.2 % / 100.0 % | 106 spawns, 2 zones; A 1 / 1, B 1 / 18 |
| mp_downtown | yes | OK 141868 | 279 / 279 (270 / 271) | 6 / 6 | 1 | 265 | 0 | yes / - | 99.2 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_farmhouse | yes | OK 70093 | 2352 / 2352 (2344 / 2344) | 8 / 8 | 0 | 2336 | 0 | yes / - | 98.4 % / 100.0 % | 128 spawns, 2 zones; A 0 / 15², B 1 / 4 |
| mp_harbor | yes | OK 163534 | 617 / 617 (615 / 615) | 0 / 0 | 0 | 617 | 0 | yes / - | 99.3 % / 98.6 % | 144 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_leningrad | yes | OK 134629 | 660 / 660 (658 / 658) | 1 / 1 | 0 | 660 | 0 | yes / - | 100.0 % / 100.0 % | 133 spawns, 2 zones; A 1 / 1, B 0 / 11 |
| mp_leningrad_mjr | zPAM | OK 167180 | 652 / 652 (650 / 650) | 1 / 1 | 0 | 652 | 0 | yes / yes | 100.0 % / 100.0 % | 132 spawns, 2 zones; A 1 / 1, B 0 / 11 |
| mp_leningrad_tls | zPAM | OK 143728 | 655 / 655 (653 / 653) | 1 / 1 | 0 | 655 | 0 | yes / - | 100.0 % / 100.0 % | 133 spawns, 2 zones; A 1 / 1, B 0 / 11 |
| mp_matmata | yes | OK 119500 | 700 / 700 (686 / 687) | 11 / 11 | 2 | 691 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_matmata_fix | zPAM | OK 119654 | 724 / 724 (710 / 711) | 11 / 11 | 2 | 715 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_railyard | yes | OK 132299 | 446 / 446 (437 / 437) | 8 / 8 | 0 | 440 | 0 | yes / - | 100.0 % / 98.4 % | 125 spawns, 2 zones; A 0 / 11, B 1 / 1 |
| mp_railyard_mjr | zPAM | OK 145042 | 422 / 422 (413 / 413) | 8 / 8 | 0 | 416 | 0 | yes / yes | 100.0 % / 100.0 % | 83 spawns, 2 zones; A 0 / 21, B 1 / 1 |
| mp_rhine | yes | OK 192415 | 1420 / 1420 (1418 / 1418) | 0 / 0 | 0 | 1420 | 0 | yes / - | 97.4 % / 96.5 % | 114 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_toujane | yes | OK 62570 | 379 / 379 (363 / 369) | 10 / 10 | 6 | 364 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; no zone target (no swap, as in the game) |
| mp_toujane_fix | zPAM | OK 63517 | 379 / 379 (363 / 369) | 10 / 10 | 6 | 364 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; no zone target (no swap, as in the game) |
| mp_trainstation | yes | OK 116696 | 1508 / 1508 (1494 / 1496) | 10 / 10 | 4 | 1500 | 0 | yes / yes | 98.4 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_trainstation_bhg | zPAM | OK 113326 | 1280 / 1280 (1278 / 1279) | 0 / 0 | 2 | 1280 | 0 | yes / - | 97.5 % / 98.3 % | 118 spawns, 2 zones; A 1 / 1, B no zone target |
| mp_trainstation_fix | zPAM | OK 116838 | 1508 / 1508 (1494 / 1496) | 10 / 10 | 4 | 1500 | 0 | yes / yes | 100.0 % / 100.0 % | 128 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| mp_vallente_fix | zPAM | OK 107160 | 1005 / 1005 (1002 / 1003) | 0 / 0 | 2 | 1005 | 0 | yes / yes | 99.1 % / 100.0 % | 112 spawns, 2 zones; A 1 / 1, B 1 / 1 |
| wawa_3daim | zPAM | OK 496 | 0 / 0 (0 / 0) | 0 / 0 | 0 | 0 | 0 | yes / - | 100.0 % / 100.0 % | 26 spawns, 0 zones (aim map) |

¹ mp_brecourt's S&D defender spawns 106–133 units above the terrain, as in audit 1 (the map's design).
² farmhouse A's 6 deleted brush models have no drawn surfaces (collision only); its 9 script models are tagged.

Not placed (by design, unchanged): `script_model xmodel/fx` (effect origins), CTF flags (`trigger_radius`), the
exploder models of zones without a target (toujane ×2: a destroyed Panzer II and armoured car the game never
shows), single-player leftovers in some zPAM maps. Special surfaces unchanged: water (harbor), multiply decals,
additive surfaces, sky on all maps.

Floor check of the new placements: the remaining flags are false positives on inspection – MGs whose bipod rests
on sandbag props just outside the check's tolerance (carentan ×3 at 1718 1824, visually checked: on the sandbags;
toujane ×2 / downtown: dm / tdm / hq copies, not shown in S&D). Vehicles sunk a few units into the terrain (decoy,
vallente, crossroads, breakout_tls) are fine (the game places them the same).

### 2. Per demo

| Demo | Version / mod | Mode / map | Players | Rounds | Kills | Score (server) | Clean end | Headshots (weapon) | In flight | Explosions → destroyed model | Findings |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2crazY_…_bg_1 | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_burgundy_fix | 10 | 15 | 104 | 2:13 (2:13) | yes | 17 (held ≈) | 0 | – | 4 teleports |
| Ayae_…_rai | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_railyard_mjr | 10 | 21 | 149 | 8:13 (8:13) | yes | 26 (held ≈) | 0 | – | 7 teleports / pops |
| Bl4diii_…_car | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_carentan_fix | 10 | 46 | 336 | 25:21 (25:21) | yes | 49 (held ≈) | 0 | – | 122 teleports (overtime halftimes); halftime kills off the scoreboard |
| demo0000 | CoD2 1.0 / stock | dm / mp_burgundy | 1 | 0 | 0 | – | yes | – | 0 | – | – |
| demo0003 | CoD2 1.3 / stock | dm / mp_toujane | 1 | 0 | 0 | – | yes | – | 0 | – | – |
| demo_match_burgundy | CoD2x 1.4.3.1 / zPAM 3.34 | sd / mp_burgundy_fix | 10 | 24 | 171 | 11:13 (11:13) | yes | 29 (held ≈) | 0 | B → yes | 9 teleports |
| demo_ZPAM334_roundStart | CoD2 1.3 / zPAM 3.34 β | sd / mp_toujane | 1 | 2 | 1 | – | yes | – | 0 | – | 1 suicide |
| demo_ZPAM334_start | CoD2 1.3 / zPAM 3.34 β | sd / mp_toujane | 1 | 1 | 2 | – | yes | – | 0 | – | 2 suicides; 2 pops |
| gotys_…_val | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_vallente_fix | 10 | 29 | 245 | 13:16 (13:16) | yes | 39 (held ≈) | 0 | A, A → yes | 10 teleports; halftime kills off the scoreboard |
| LamineYamal1_…_mat_1 | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_matmata_fix | 10 | 22 | 165 | 9:13 (9:13) | yes | 30 (held ≈) | 0 | – | 2 pops; the headshot without a weapon of audit 1 is gone |
| nesq_…_tj | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_toujane_fix | 10 | 24 | 176 | 13:11 (13:11) | yes | 31 (held ≈) | 0 | – | 8 teleports / pops |
| siki_…_bre | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_breakout_tls | 10 | 19 | 144 | 13:6 (13:6) | yes | 28 (held ≈) | 0 | – | 1 pop |
| syncHZ_…_tra | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_trainstation_fix | 10 | 17 | 131 | 4:13 (4:13) | yes | 19 (held ≈) | 0 | B → yes | 9 teleports / pops; 1 halftime kill off the scoreboard |
| vorelback_…_dw | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_dawnville_fix | 10 | 19 | 139 | 13:6 (13:6) | yes | 17 (held ≈) | 0 | – | 3 teleports |

Checked and in order (as in audit 1, all unchanged): parse errors (none), damaged messages / dropped snapshots
(none), players and teams, every S&D score = the server's, no round overlaps, every finished round with a winner
and a reason, kill participants, deaths vs. the scoreboard (differences only from kills during zPAM's halftime /
overtime ready-up, which the scoreboard leaves out), bomb plants / defuses with planter and bomb position, clean
demo ends, timeline markers. "Teleports" = one-step moves of zPAM's halftime / overtime (instant now); "pops" =
~140-unit vertical jumps during ready-up followed by a fast climb (grenade jumps; data as recorded).

### 3. Rendering, playback and UI

- Load sweep: all 14 demos in 3D, then 2D – no failed request, no console error or warning, no 3D fallback; the
  game type's filter and exploder parts active (e.g. railyard_mjr: 20 exploder parts, DM demos: 0).
- UI (`tools/audit/ui_audit.js`): 117 steps each on the Toujane (zPAM 4.09) and the Burgundy (zPAM 3.34) match,
  3D and 2D – rail popovers (every checkbox, radio, select option, range), drawer sections, player eye / stats,
  details tabs, play / pause, back / forward, seek, speeds, replay range, export marks, video export dialog
  (opened and closed, not started), keyboard – 0 failed steps, 0 errors, 0 warnings, 0 failed requests.
- Subpath (`http://localhost:8791/cod2-demo/index.html`, as on GitHub Pages): 174 requests, 0 failed, 0 absolute
  paths, no console messages; 3D (props, exploders, light grid) and 2D load.
- Performance, mp_brecourt (the heaviest map, 8,568 placements in S&D) at 1920 × 1032, forced frames with
  `gl.finish()`: 2.7–4.3 ms per frame, 124–125 draw calls, ~458k triangles. Props draw LOD 0 and are not culled
  (each instanced mesh spans the map), so every view draws nearly all triangles – fine at these timings.
- Visual checks in this audit: brecourt's wrecked flak 88 (skinned) under its net, carentan's MG42 on sandbags,
  toujane from the default orbit camera (lightmaps, roofs, palms, sky – no black surfaces, holes or z-fighting).
  The bomb-site swap was checked visually when it was fixed (burgundy B, step 43); in this audit by the data checks
  above.
- 2D: the 32 top-down images are pixel-identical to those from before the fixes; spawn alignment identical to
  audit 1 (table).

### 4. New issues and regressions

No regressions.

| # | Issue | Affected | Likely cause | Severity | Proposed fix | Effort |
|---|---|---|---|---|---|---|
| 9 | **Mounted MGs don't turn with their user**: the gun stays at its map angle while a player fires it | the matches checked (carentan_fix, burgundy_fix, toujane_fix: 900–1,100 player samples "using a turret" each, ~30 s); 26 maps have MGs | the props are static; the demos carry the turret entities (eType 9) but their yaw never changes – the aim is the user's view angles (EF_USETURRET on the player) | minor | while a player has EF_USETURRET, turn the nearest MG instance (within ~64 units) to the player's yaw / pitch (per-instance matrix, like the exploder swap); keep the MG flag in the position samples | 2–3 h |
| 10 | Two ivy models' geometry lies 75–99 units outside their declared bounds (`prop_ivyedgehorizontal01/02`) | carentan, carentan_bal, carentan_fix | the xmodel's stored bounds (rigid models, not the bind pose; present before the fixes) – the light grid is sampled at the centre of the declared bounds, the "boxes" display shows the wrong box | cosmetic | export the vertex bounds as mins / maxs (re-export of the 3 maps) | ½–1 h |
| – | Audit tooling: `ui_audit.js` reported the export dialog as missing | – | `offsetParent` is null for fixed-position elements | – | fixed in this audit (`getClientRects`) | done |

Known and unchanged: headshot weapons are the held weapon (≈) – the demos do not carry it; deaths differ from the
scoreboard by zPAM's halftime kills (data as recorded); `$default` surfaces dark (as in the game).

#### Status (after audit 2)

| # | Status |
|---|---|
| 9 | fixed – PLAN.md step 46: the guns take the turret entities' aim from the demo (angles2), about the gun bone's pivot. Found on the way: the MGs' guns were drawn 13 units low (rigid surfaces were not placed by their bone) – also fixed, together with mp_crossroads' Stuka propeller; the "MG above the floor" flags of this audit came from that, not from the sandbags |
| 10 | fixed – step 47: the two ivy models declare zero bounds; props.json now uses their geometry's bounds |

### 5. Proposed order

1. **#9 mounted MGs follow their user** (the only visible gap left in the S&D matches).
2. **#10 ivy bounds** (cosmetic, together with any other re-export).
3. No action: #4 (data limit), #5 (not needed), #7, #8.

---

## Audit 1 – 2026-10-27 (before the fixes)

Read-only audit: no code or data was changed (a temporary second dev-server entry in `.claude/launch.json` was
added for the subpath test and removed again). The audit scripts are kept in `tools/audit/`:

| Script | What it does |
|---|---|
| `tools/audit/map_audit.py` | every MP BSP in the game files vs. `maps3d/`: triangles, draw groups, textures, model entities vs. placements, special surfaces, spawns / objectives, 2D registry and rectangles → `tools/audit/out/maps.json` |
| `tools/validate/check_alignment.py --spawns …` (existing) | every map's spawns on the top-down image / zPAM radar and on a 3D floor → `tools/audit/out/alignment.txt` |
| `tools/audit/load_c2.mjs` | loads the viewer's own parser + analysis (the DOM-free scripts of `index.html`) into Node |
| `tools/audit/demo_audit.mjs` | parses every demo in `demos/` with them and checks the result → `tools/audit/out/demos.json` |
| `tools/audit/demo_detail.mjs` | the records behind a finding (kill fields, deaths by phase, samples around position jumps) |
| `tools/audit/ui_audit.js` | in the browser: clicks through every control of the 3D and 2D view and collects exceptions, console errors / warnings and failed requests |

### Summary

- **Map data is complete for 32 of 32 MP maps** (15 stock, 17 zPAM map pack): every BSP triangle is exported (tool
  surfaces are already removed by the map compiler), no material lacks its colour map, no referenced file is
  missing, every map has its sky, top-down image, 2D registry entry, all spawns of all game types and both bomb
  zones; zPAM radar images for the 15 maps that have one. Alpha textures were audited in step 40 (338 checked).
- **Models: 38,823 of 38,881 placements render.** Missing: **58 placements of 6 skinned models** (flak 88 family,
  Flakvierling, Panzer II winter) on 18 maps, plus **188 mounted MGs** (`misc_turret`, `misc_mg42`) on 26 maps that
  are not exported at all.
- **Demos: all 14 parse** (CoD2 1.0 / 1.3, CoD2x 1.4.3.1 / 1.4.6.8, stock DM, zPAM 3.34 and 4.09 S&D), clean ends,
  no damaged messages or dropped snapshots, every S&D score equals the server's score, deaths equal the
  scoreboard. Headshot weapons are an approximation (the bullet-hit events used for them carry no attacker).
- **Rendering / UI:** no console errors or warnings, no 404s, works under a subpath (`/cod2-demo/`), 107 UI steps
  without an error, ~8 ms per frame at 1080p on the heaviest map (mp_brecourt, 8,578 props). Gaps: bomb-site
  targets are never swapped for their destroyed versions; CTF flags / HQ radios are not shown.
- **Not covered by test data:** TDM, CTF and HQ demos and a stock S&D demo (parked) do not exist here. The
  reference parser's logs (`cod2-demoparser/demos/*.log`) only cover the first messages (the gamestate), so the
  cross-check is limited to server info / config strings (they agree).

### 1. Per map

Geometry: triangles of the BSP (drawn + sky) = exported. Models: placements rendered / placed (misc_model and the
map's own script_models). "No geometry": placements whose model is not exported (skinned models, issue 1).
"Turrets": mounted MG entities that are not placed at all (issue 2). Spawns on 2D / 3D floor: share of all
spawn points on rendered top-down pixels / with a world floor 0–96 units below.

| Map | Stock | Geometry (BSP = exported) | Models rendered / placed | Not placed | Missing textures | Sky | 2D top-down / radar | Spawns on 2D / 3D floor | Entities |
|---|---|---|---|---|---|---|---|---|---|
| mp_breakout | yes | OK 167936 tris | 983 / 985 | **2 no geometry** | 0 | yes | yes / - | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_breakout_tls | zPAM | OK 139309 tris | 542 / 543 | **1 no geometry**, 1 turret | 0 | yes | yes / yes | 97.2% / 100.0% | 106 spawns, 2 bomb zones |
| mp_brecourt | yes | OK 45237 tris | 8558 / 8578 | **20 no geometry**, 12 turrets | 0 | yes | yes / - | 98.4% / 87.5%¹ | 128 spawns, 2 bomb zones |
| mp_burgundy | yes | OK 56232 tris | 1539 / 1539 | 7 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_burgundy_fix | zPAM | OK 56739 tris | 1534 / 1534 | 7 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_carentan | yes | OK 118352 tris | 1534 / 1534 | 10 turrets | 0 | yes | yes / yes | 96.1% / 100.0% | 128 spawns, 2 bomb zones |
| mp_carentan_bal | zPAM | OK 119529 tris | 1539 / 1539 | 10 turrets | 0 | yes | yes / - | 100.0% / 99.2% | 128 spawns, 2 bomb zones |
| mp_carentan_fix | zPAM | OK 118496 tris | 1539 / 1539 | 10 turrets | 0 | yes | yes / yes | 95.3% / 99.2% | 128 spawns, 2 bomb zones |
| mp_chelm_fix | zPAM | OK 103158 tris | 992 / 993 | **1 no geometry**, 1 turret | 0 | yes | yes / - | 100.0% / 100.0% | 104 spawns, 2 bomb zones |
| mp_crossroads | zPAM | OK 188736 tris | 2960 / 2961 | **1 no geometry**, 7 turrets | 0 | yes | yes / - | 100.0% / 100.0% | 129 spawns, 2 bomb zones |
| mp_dawnville | yes | OK 98475 tris | 609 / 611 | **2 no geometry**, 7 turrets | 0 | yes | yes / yes | 96.9% / 100.0% | 128 spawns, 2 bomb zones |
| mp_dawnville_fix | zPAM | OK 100864 tris | 610 / 612 | **2 no geometry**, 7 turrets | 0 | yes | yes / yes | 95.3% / 100.0% | 128 spawns, 2 bomb zones |
| mp_dawnville_sun | zPAM | OK 98641 tris | 660 / 662 | **2 no geometry**, 7 turrets | 0 | yes | yes / - | 99.2% / 100.0% | 128 spawns, 2 bomb zones |
| mp_decoy | yes | OK 26959 tris | 376 / 382 | **6 no geometry**, 7 turrets | 0 | yes | yes / - | 97.2% / 100.0% | 106 spawns, 2 bomb zones |
| mp_downtown | yes | OK 141868 tris | 270 / 271 | **1 no geometry**, 6 turrets | 0 | yes | yes / - | 99.2% / 100.0% | 128 spawns, 2 bomb zones |
| mp_farmhouse | yes | OK 70093 tris | 2344 / 2344 | 8 turrets | 0 | yes | yes / - | 98.4% / 100.0% | 128 spawns, 2 bomb zones |
| mp_harbor | yes | OK 163534 tris | 615 / 615 | - | 0 | yes | yes / - | 99.3% / 98.6% | 144 spawns, 2 bomb zones |
| mp_leningrad | yes | OK 134629 tris | 658 / 658 | 1 turret | 0 | yes | yes / - | 100.0% / 100.0% | 133 spawns, 2 bomb zones |
| mp_leningrad_mjr | zPAM | OK 167180 tris | 650 / 650 | 1 turret | 0 | yes | yes / yes | 100.0% / 100.0% | 132 spawns, 2 bomb zones |
| mp_leningrad_tls | zPAM | OK 143728 tris | 653 / 653 | 1 turret | 0 | yes | yes / - | 100.0% / 100.0% | 133 spawns, 2 bomb zones |
| mp_matmata | yes | OK 119500 tris | 686 / 687 | **1 no geometry**, 11 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_matmata_fix | zPAM | OK 119654 tris | 710 / 711 | **1 no geometry**, 11 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_railyard | yes | OK 132299 tris | 437 / 437 | 8 turrets | 0 | yes | yes / - | 100.0% / 98.4% | 125 spawns, 2 bomb zones |
| mp_railyard_mjr | zPAM | OK 145042 tris | 413 / 413 | 8 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 83 spawns, 2 bomb zones |
| mp_rhine | yes | OK 192415 tris | 1418 / 1418 | - | 0 | yes | yes / - | 97.4% / 96.5% | 114 spawns, 2 bomb zones |
| mp_toujane | yes | OK 62570 tris | 363 / 369 | **6 no geometry**, 10 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_toujane_fix | zPAM | OK 63517 tris | 363 / 369 | **6 no geometry**, 10 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_trainstation | yes | OK 116696 tris | 1494 / 1496 | **2 no geometry**, 10 turrets | 0 | yes | yes / yes | 98.4% / 100.0% | 128 spawns, 2 bomb zones |
| mp_trainstation_bhg | zPAM | OK 113326 tris | 1278 / 1279 | **1 no geometry** | 0 | yes | yes / - | 97.5% / 98.3% | 118 spawns, 2 bomb zones |
| mp_trainstation_fix | zPAM | OK 116838 tris | 1494 / 1496 | **2 no geometry**, 10 turrets | 0 | yes | yes / yes | 100.0% / 100.0% | 128 spawns, 2 bomb zones |
| mp_vallente_fix | zPAM | OK 107160 tris | 1002 / 1003 | **1 no geometry** | 0 | yes | yes / yes | 99.1% / 100.0% | 112 spawns, 2 bomb zones |
| wawa_3daim | zPAM | OK 496 tris | 0 / 0 | - | 0 | yes | yes / - | 100.0% / 100.0% | 26 spawns, 0 bomb zones (aim map) |

¹ mp_brecourt: 16 S&D defender spawns sit at z = 88, 106–133 units above the terrain (they drop on spawn – the
map's design, not a hole). The other misses of a few % are spawns on props / roofs over the top-down's
background or slightly above a floor; nothing points to missing geometry.

Not placed by design (in every map): `script_model` exploders (the destroyed versions, see issue 3),
`script_model xmodel/fx` (effect origins), `trigger_radius` CTF flags (issue 5), single-player `actor_*` and
`weapon_*` pickups left in some zPAM maps (the MP game removes them), and a stray `model` key on mp_matmata's
worldspawn.

Special surfaces: water on mp_harbor (step 39), multiply decals on 31 maps (steps 38, 40), additive surfaces,
sky on all maps; glass is ordinary blended material. `$default` surfaces (2–209 triangles on 21 maps) use the
game's dark default image – the game draws them the same way (`textured_simple`).

### 2. Per demo

| Demo | Version / mod | Mode / map | Players | Rounds | Kills | Score (server) | Clean end | Findings |
|---|---|---|---|---|---|---|---|---|
| 2crazY_…_bg_1 | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_burgundy_fix | 10 | 15 | 104 | 2:13 (2:13) | yes | 17 headshot weapons ≈; 8 jumps |
| Ayae_…_rai | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_railyard_mjr | 10 | 21 | 149 | 8:13 (8:13) | yes | 26 headshot weapons ≈; 15 jumps |
| Bl4diii_…_car | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_carentan_fix | 10 | 46 | 336 | 25:21 (25:21) | yes | 49 headshot weapons ≈; 234 jumps (overtime halftimes); halftime kills off the scoreboard |
| demo0000 | CoD2 1.0 / stock | dm / mp_burgundy | 1 | 0 | 0 | – | yes | – |
| demo0003 | CoD2 1.3 / stock | dm / mp_toujane | 1 | 0 | 0 | – | yes | – |
| demo_match_burgundy | CoD2x 1.4.3.1 / zPAM 3.34 | sd / mp_burgundy_fix | 10 | 24 | 171 | 11:13 (11:13) | yes | 29 headshot weapons ≈; 16 jumps |
| demo_ZPAM334_roundStart | CoD2 1.3 / zPAM 3.34 β | sd / mp_toujane | 1 | 2 | 1 | – | yes | 1 suicide (no weapon – correct) |
| demo_ZPAM334_start | CoD2 1.3 / zPAM 3.34 β | sd / mp_toujane | 1 | 1 | 2 | – | yes | 2 suicides; 3 jumps |
| gotys_…_val | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_vallente_fix | 10 | 29 | 245 | 13:16 (13:16) | yes | 39 headshot weapons ≈; 18 jumps; halftime kills off the scoreboard |
| LamineYamal1_…_mat_1 | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_matmata_fix | 10 | 22 | 165 | 9:13 (9:13) | yes | 29 headshot weapons ≈; 2 jumps |
| nesq_…_tj | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_toujane_fix | 10 | 24 | 176 | 13:11 (13:11) | yes | 31 headshot weapons ≈; 14 jumps |
| siki_…_bre | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_breakout_tls | 10 | 19 | 144 | 13:6 (13:6) | yes | 28 headshot weapons ≈; 1 jump |
| syncHZ_…_tra | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_trainstation_fix | 10 | 17 | 131 | 4:13 (4:13) | yes | 19 headshot weapons ≈; 17 jumps; 1 halftime kill off the scoreboard |
| vorelback_…_dw | CoD2x 1.4.6.8 / zPAM 4.09 | sd / mp_dawnville_fix | 10 | 19 | 139 | 13:6 (13:6) | yes | 17 headshot weapons ≈; 5 jumps |

Checked and in order: parse errors (none), damaged messages / dropped snapshots (none), players and teams (every
active player has a team), scores and rounds (every S&D match equals the server's final score; no round
overlaps; every finished round has a winner and a reason), kills (attacker / victim are players; weapons known
except headshots ≈ and bashes, whose weapon is the knife-holder's gun, and suicides, which have none), deaths
(the viewer's per-player deaths equal the scoreboard; the obituaries additionally contain kills made during
zPAM's halftime / overtime ready-up, which the scoreboard leaves out), bomb plants / defuses (counted as events;
planter and bomb position exact, step 27/28), demo ends (all clean), timeline markers (kills, plants, defuses,
halftimes).
"Jumps" (living players moving > 120 units + 0.6 u/ms between two samples outside a round start): on inspection
all are halftime / overtime moves back to the spawns (the server moves players in 3–4 snapshots at ~16,000 u/s)
or respawns during ready-up – the data as recorded (issue 6).

### 3. Rendering, playback and UI

- Console: no errors or warnings on all 14 demos in 3D and 2D (release checks of steps 36–40 and this audit).
- Requests: no failed request; under a subpath (`http://…/cod2-demo/index.html`, as on GitHub Pages) 220
  requests, 0 failed, no console messages. No absolute paths in the code.
- UI (`tools/audit/ui_audit.js`, Toujane match): 107 steps in 3D and 2D – rail popovers (Layers, Camera, Display,
  Match info: every checkbox, radio, select option, range), drawer sections, player eye / stats popup, details
  dialog tabs, play / pause, back / forward 5 s, seek, speed 0.5–4×, replay range, export-range marks, video
  export dialog (opened, not started), keyboard (Space, arrows, V) – no exception, error or warning.
- Performance (1920 × 1080, 8 player positions): mp_toujane_fix 8.1 ms, mp_brecourt 7.9 ms per frame
  (108 draw calls, 432k triangles); props always draw their LOD 0 (no LOD popping; fine at these timings).
- Visual checks during steps 38–40 on toujane, carentan, burgundy, dawnville, matmata, brecourt, harbor: no
  black surfaces, holes or z-fighting found; alpha cut-outs as in the game's images.
- 2D: spawns of every map lie on the rendered top-down and inside the zPAM radar rectangle (table above);
  player positions were validated against both in earlier steps (README "Validation").

### 4. Issues

| # | Issue | Affected | Likely cause | Severity | Proposed fix | Effort |
|---|---|---|---|---|---|---|
| 1 | **Skinned static models not rendered**: flak 88 (+ destroyed, +nm variants), Flakvierling, Panzer II winter – 58 placements; on Toujane the six wrecked 88s near the sites are missing | 18 maps (table) | `export_maps.Exporter.model()` reads surfaces with `xmodel.parse_surfs`, which rejects weighted vertices ("weighted vertices are not supported"); the character exporter already has `parse_skinned_surfs` | major | use `parse_skinned_surfs` for these models and pose them in the bind pose (xmodelparts); re-export props.json/bin of 18 maps | ½–1 day |
| 2 | **Mounted MGs missing**: `misc_turret` / `misc_mg42` (weapon_mg42, weapon_30cal on their mounts) | 188 entities, 26 maps | `prop_entities()` only takes misc_model and script_model | minor (visible objects) | export them as props (origin / angles / the weapon's world model; some are skinned → after #1) | 2–3 h |
| 3 | **Bomb-site targets never destroyed**: after a bomb explodes the intact tank / car / gun stays (the game swaps in the exploder model) | all S&D maps with exploder targets | exploder `script_model`s are not exported; no runtime swap | minor | export the exploder models (hidden), swap at the explosion time of each site (bomb events) | ½ day |
| 4 | **Headshot weapons are approximate** (≈): every headshot's weapon is the attacker's held weapon; the exact path (the last bullet hit on the victim) never matches | all demos (17–49 kills each) | the `EV_BULLET_HIT_CLIENT_*` events arrive rarely (34 in a 33-min match) and always with attacker 0 / weapon 0 – field mapping or delivery | minor | check the entity fields of these events against CoD2x; fix the mapping or drop the dead path (the UI already marks ≈) | 2–4 h |
| 5 | **CTF flags / HQ radios not shown** | CTF flags on all 32 maps (`trigger_radius allied_flag/axis_flag`), HQ radio entities on 3 maps (stock radios come from the gametype scripts) | only S&D bomb zones are exported as objectives | minor (no CTF/HQ demos here) | export flag / radio positions; markers in 2D and 3D | ½–1 day |
| 6 | **Players glide across the map at halftime / overtime** (zPAM moving them to the spawns over 3–4 snapshots) | zPAM demos, 1–234 samples each | data as recorded; the view interpolates between the samples | cosmetic | treat steps > ~2,000 u/s as teleports (no interpolation / trail) | 1–2 h |
| 7 | `$default` surfaces drawn with the dark default image | 21 maps, 2–209 tris | the map uses the engine's default material – the game draws it the same | cosmetic | none (optionally hide) | – |
| 8 | Test coverage: no TDM / CTF / HQ demo, no stock S&D demo; reference logs only cover the gamestate | parsing of other modes unverified | – | info | add demos when available | – |

#### Status (after the audit)

| # | Status |
|---|---|
| 1 | fixed – PLAN.md step 41 (bind-pose export of skinned models; toujane's wrecked 88s turned out to be dm / tdm / hq copies, which the S&D game deletes – they show in DM, not in S&D) |
| 2 | fixed – step 42 (mounted MGs exported; the game type's `script_gameobjectname` filter applied to all tagged props and brush models) |
| 3 | fixed – step 43 (exploder groups swapped while the site's bomb has exploded, until the round ends) |
| 4 | fixed as far as the data allows – step 44 (shooter read from `clientNum`; the hit events carry weapon 0, so headshot weapons stay the held weapon ≈) |
| 5 | not needed (the user's decision, 2026-10-27) |
| 6 | fixed – step 45 (samples in flight hold the start position: one teleport) |

### 5. Proposed order

1. **#1 skinned static models** (largest visible gap; also unblocks #2's skinned mounts).
2. **#2 mounted MGs** (same exporter path, re-export together with #1).
3. **#3 destroyed bomb-site targets** (S&D, the viewer's main mode).
4. **#4 headshot weapons** (accuracy of the kill feed / stats).
5. **#6 halftime glides** (small, cosmetic).
6. ~~#5 CTF / HQ objectives~~ – not needed (the user's decision).
7. #7 / #8: no action.
