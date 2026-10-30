# CoD2 Demo Viewer

A single-page replay viewer for **Call of Duty 2** demos (`.dm_1`): CoD2 1.0 – 1.3 and CoD2x 1.4,
stock servers and zPAM. Drop a demo on the page and watch the match top-down in **2D** or in the
**real map in 3D**; toggle between the two at any time - the time, the selected player and the filters
stay as they are. Modeled on cod4-demo3d, a Call of Duty 4 demo viewer (same layout, controls and panels).
Source: [github.com/TiPSYSPiT/cod2-demo](https://github.com/TiPSYSPiT/cod2-demo) (also linked in the
top bar).

The demo is parsed in your browser (a Web Worker). Nothing is uploaded, and the page loads nothing from
other servers: three.js r170 comes with the project in `vendor/`, the fonts (Inter, JetBrains Mono, SIL Open
Font License) in `assets/fonts/`. The site is plain HTML, CSS and JavaScript with no build step and runs on
GitHub Pages. The game data (3D maps, textures, 2D backgrounds, sounds, player models and animations,
particle effects) is extracted once from your own game files with Python scripts (below) and committed
with the site (the whole site without the sample demos: ~580 MB in ~4,000 files, the largest 14 MB).

## Features

| Part | What it does |
|---|---|
| Top bar | **2D / 3D** toggle (key `V`), **Match details** (chart icon: scoreboard, round by round, chat, events), **Export JSON** (file icon), **GitHub** (the source), **Open demo** |
| Score pill | Over the view: the score at the playback time, the round and its time, map and mode; after a plant the **bomb timer** (the server's own countdown clock; also next to the bomb in 2D) |
| Rail (left) | Icon buttons with popovers: **Layers** (names, trails 5 s, kill lines, the recording player's hits from zPAM's damage log, last known position, dropped weapons, grenade types, the map's intermission camera and hurt triggers; in 2D the map background), **Heatmap** (2D), **Camera** and **Display** (3D: players, X-Ray, props, effects, kill feed, kill icons, bullet tracers, enemy names, head icons, grenades and dropped weapons, shell casings, shadows, sound and volume), **Match info** (final score on request, map, mode, ruleset, server, POV, length, record date, protocol, the map data details; the **rules** - friendly fire, kill cam, limits, the bomb timer, antilag, zPAM's weapon limits -; zPAM's **match info** - teams, round, half, match time, timeouts; keyboard shortcuts) |
| Drawer (right) | Round and status; per team the faction's icon, the side, score and alive bars, per player the weapon in hand (kill icon) and K / D up to now. Click a player to select them (highlighted in 2D and 3D, followed by the 3D cameras); the eye shows / hides a player, the chart icon opens the player's stats. Below it the kill feed & bomb: the game's own kill icons and bomb plants / defuses, the entry at the playback time highlighted, click one to jump to 2 s before it. Sections fold, the drawer hides (both remembered) |
| Fullscreen | The button at the top right (or `F`; in the free-fly camera `F` stays "down"): only the view (2D or 3D) with its HUD fills the screen - top bar, score pill, rail, panel and player bar hidden; moving the mouse brings the player bar up for 2.5 s; `Esc` or the button returns |
| Player bar (bottom) | ⏪ / ⏩ 5 s (`←` / `→`), play / pause (`Space`), the time, the timeline (rounds as segments underlined in the winner's colour, kills as ticks - one team above, the other below -, bomb plants / defuses, halftimes), range (whole match or one round), 0.5–4× speed, export range `[ ]` (`I` / `O`), **Export video** |
| Match details | **Weapons** (every weapon of the demo with the weapon file's numbers - damage and falloff in metres, hit-location multipliers, hits to kill, RPM, clip, reload, ADS, speed - and how it was used: kills, HS %, average kill distance, users; in zPAM demos the damage model checked against zPAM's damage log), Scoreboard (score, K / A / D, K/D, HS %, TK, nade kills / deaths, opening duels won–lost, trade kills, rounds with 3+ kills, clutches won / played, in zPAM 3 demos zPAM's own score and damage count, plants / defuses per player, halves; names in their colour codes), round-by-round table with win reasons and round times from the round clock (after zPAM's strat time), per round the first blood, 3K+ rounds, the clutches (1vX) and the trades, and in zPAM demos zPAM's **round report** of the recording player (his hits with damage and hit location, how he was killed) and zPAM's **damage log** (every rifle / scoped / shotgun / grenade hit he made: victim, damage, the victim's health before it, hit location, weapon, distance; also in his stats and as hit markers on the 2D map), chat, events (joins, team changes, ready-up, halftime, timeouts, bomb; optional: weapon and ammo pickups, out of grenades); the player stats show the ping over time |

**2D** – stock CoD2 has no minimap image, so the 2D view offers (Layers popover, *Background*):
- **Render**: a top-down render of the map's BSP (textures, lightmaps, props, wall outlines),
  aligned to world coordinates by construction;
- **zPAM radar**: zPAM 4.09's hand-made radar image for the 16 maps that have one, placed with its
  `.radar` calibration (the CoD2x `cg_hudRadar*` formula);
- **Grid**.

It shows players with team colours, names and view cones, trails, kill lines, death crosses, grenade
flights and smoke / explosion circles, the bomb sites (A / B) and the planted bomb, the **dropped weapons** (the
game's weapon icon, turned the way the weapon lies) and, as Layers *Map*, the map's intermission camera and its
hurt triggers (the kill planes under the map, water, with their damage). Wheel zooms,
dragging pans, double-click resets, `Q` / `E` (or the map tools bottom right) rotate in 90° steps. The **heatmap** button offers
positions, kills, deaths, grenade landings, smokes and shots, filtered by team, side and player.

**3D** – the map geometry from the `.d3dbsp` (textures, lit as the game's world shader lights it: the baked
lightmaps plus the sun where the map's sun mask lets it through, so buildings throw their shadows and walls
facing the sun are bright, with the materials' normal maps, detail maps and the sun's specular
highlights; alpha-tested foliage, blended
terrain layers, the sky cube), the map's static models (misc_model props: crates, sandbags, trees,
vehicles, and the bomb-site objects; lit as the game lights them - from the light grid at their centre,
or the compiler's ground light for the models made for it - with their normal, specular and detail maps), the **players** (Display popover, *Players*: *Models* = the game's own
character models - body, head and helmet or hat (on the head's `j_helmet` bone, as the game attaches it) from the demo's client state, the weapon in hand in their
right hand - animated with the legs / torso animations the demo sends (crossfaded; runs, walks and
crawls advance by the distance the player covers, so the feet keep step), turned like in the game (the
legs follow diagonal movement while the upper body and head aim with the view's yaw and pitch, lean
rolls and shifts the upper body, prone players tilt with the slope), lit as the game lights its models -
from the map's light grid (the baked light from 8 directions at their position, plus the sun where it
reaches them), with a team-coloured ring at the feet, and the corpses playing their death animation; *Simple* = capsules,
standing / crouched / prone), an aim line using their real pitch, **X-Ray** (Display popover or key `X`:
*Player* = living players behind walls and props as a silhouette in the team colour, *Player + name* = also
every name, with a badge for a player out of sight; remembered for the browser session), the mounted
**MGs** turning with their user's aim (the user's own weapon hidden meanwhile), the S&D bomb-site targets
swapped for their destroyed model when the bomb explodes, the game's own **particle effects**
(Display popover, *Effects*: *Game* = grenade explosions by the surface hit, smoke grenades, bullet impacts by
bullet type and surface, scripted effects, the map's ambient smoke, dust and fires when the server ran
them (stock servers; zPAM's rules switch them off), every shot's muzzle flash at the weapon's muzzle and the game's
**bullet tracers** (Display: *Bullet tracers*, off by default; as the server set them - zPAM gives every bullet one,
1000 units long at 20000 units/s: a streak flying from the muzzle, gone at the impact within a few frames), smoke
and dust lit by the map's baked light under them, debris landing on the floor and bouncing; *Simple* = marker
clouds and flash spheres), the effects' **models** - the **shell casings** each shot ejects at the gun's ejection port
(bolt-action rifles and the shotgun: when the bolt is worked; as in the game only near the camera), the burnt smoke
grenade, debris -, the **grenades in flight** (the game's grenade model, spinning as the demo has it) and the
**dropped weapons** on the ground (Display: *Grenades and dropped weapons*, *Shell casings*; the effects' dynamic
lights are not drawn - their falloff is made in the game's renderer, not known), the game's **head icons** over the players (the team icon the server gives them, the talk
balloon while a teammate talks in the voice chat, also as a speaker in the panel; in first person only what that player
sees), the players' and corpses' **shadows** (Display popover: *Shadows*; soft shadows
along the map's sun, as the game's character shadows - the world's own shadows are in its lightmaps;
`?shadows=off`), kill lines, death crosses, grenade arcs, the bomb and the site labels, a
kill feed overlay and the game's **sounds** (Display popover: *Game sounds*, off until switched
on), chosen as the game's client chooses them: each weapon's shots (and the M1 Garand's last-shot ping),
reloads, bolt / pump actions, the weapon switch, the grenade's pin pull and throw, melee by weapon and its hit,
empty clicks; footsteps, jumps and landings by surface with the gear rattle, foliage, fall damage; bullet
impacts on the world and on players, near-miss whizzes at the camera, grenade bounces and explosions, smoke;
the looping sounds of entities (the planted bomb's ticking, a firing MG42 / .30 cal, map fires); the server's
sound-alias events (bomb plant / defuse / explosion, quick-chat voices, zPAM's switch and drop sounds), weapon and
ammo pickups, and the recording player's local sounds (announcer, hit marker; in his first person his breath while
he holds it on a scope - breathing in, the heartbeat, breathing out or gasping after 4.5 s - with the other sounds
turned down as the game does). The player watched in first person hears
his own sounds as the game plays them for the local player (the `_plr` variants, at the ear). zPAM demos use
zPAM's alias changes (its silenced stock switch sound). One alias variant by probability (the variants of the
map by the engine's loadspec rule), its volume / pitch ranges, the distance falloff along the alias's curve (the game's
`.vfcurve` files) and stereo panning at
the camera; pausing or seeking cuts the sounds, the pitch follows the speed up to 2×, faster is silent. Cameras
(Camera popover, `C` cycles):

| Camera | Controls |
|---|---|
| Orbit | Left drag rotates, right drag pans, wheel zooms. Click a player to select them |
| Free fly | Drag to look, `W A S D` to move, `R` / `F` for up / down, `Shift` for fast, wheel sets the speed |
| Follow player | Travels with the selected player (or the POV's followed player). Drag to turn around them |
| First person | The selected player's eyes with their view angles, the **weapon in their hands**, the game's **crosshair** and the game's **HUD** (Camera popover: *Weapon*, *First person HUD*), the game's **camera shake** (near the bomb's explosion, on a firing MG42; Camera popover) and the flinch when hit; hold `Tab` for the game's **scoreboard** |

**First-person weapon**: the game's own view models - the gun of the weapon file in the hands the server
gave the player (American, British, Russian, German sleeves) - animated with the weapon's own view animations
as the demo drives them: idle, fire / last shot, rechamber, reload (also empty, and the start / loop / end of
the bolt-action and shotgun reloads), raise / put away (quick for a grenade throw), melee, the grenade's pin and
throw, aiming down the sights. The gun kick, the sway when turning and the bob (the gun's and the camera's) use
the game's own formulas with the weapon file's numbers (the kick's random part is fixed per shot, so seeking shows
the same); the idle sway and the stance and movement offsets follow the weapon file's numbers; the recording player's
scope sways as the game sways the view while aiming (calm while he holds his breath, faster after a long hold).
In third person a player's gun goes to the left hand during grenade throws and rifle reloads, as the animations'
notetracks tell the game. Aiming down the sights zooms as the game does (the weapon's ADS fov), the sniper rifles show
their scope overlay; the view flash at the muzzle on every shot. The crosshair is the game's: the weapon's
reticle images at the spread of the moment (stance, movement, shots), shrinking and fading while the sights come
up, hidden during reloads, switches and on a mounted MG, green while it is on a teammate (as in CoD2, which has no
red crosshair over enemies). **Exact for the recording player** (the demo's player
state: the animation the game plays, the weapon state, the ADS fraction, the spread, the hands model); **the other
players are approximated** from their weapon events (shots, reloads, switches, melee, the offhand throw), their
legs animation (aiming) and their movement. All of it is part of the video export.

**First-person HUD**: the game's own HUD, built from the game files (the HUD menu files, the fonts, the images,
the English strings) and drawn as the 1.3 client draws it: on the game's 640 × 480 screen scaled by the height
and anchored to the edges (wide screens keep it at the corners), clear of the viewer's own controls. Parts
(Camera popover, remembered for the browser session): **Compass** (the compass face turning with the view, the
teammates as arrows, the objectives such as the bomb sites and the bomb carrier, enemies only as a ping where
they fire; CoD2's compass has no map image), **Team score** (the server's score display - the stock game's and
zPAM's, shown and hidden when the server does it: zPAM shows it at strat time), **Kill feed** (the game's kill
messages above the compass - killer, weapon or headshot / melee / fall / suicide icon, victim, in the team
colours, 5 s and fading - and "You killed" / "Killed by" in the centre), **Ammo** (clip and reserve, red when
low, the weapon name after a switch), **Grenades** (frag and smoke counts with the faction's icons) and **Server
HUD** (off by default: everything else the server shows - zPAM's players left, sniper / shotgun info and
round texts, the clocks, the game messages), **Low health** (the red screen edges pulsing after a hit), **Health
bar** (off: the game hides it, cg_drawHealth 0), **Damage direction** (the arrows to where a hit came from and the
short red flash), **Stance** (the stance icon after a change, "Prone Blocked"; stock HUD only, as in the game),
**Hints** (plant / defuse the bomb, pick up or swap a weapon, mantle - with the game's default keys),
**Scoreboard** (the game's scoreboard while `Tab` is held and at the intermission, from the scores the server sent;
zPAM's own scoreboard while the recording player had it open) and **zPAM match info** (as the recording player
had it). zPAM demos use zPAM's HUD layout (smaller ammo counter, grenades side by side), the others the stock
game's. Exact for the recording player (the demo's player state); with
another player in first person the compass, the kill feed and the team score. Part of the video export.

**Video export** (2D and 3D): MP4 (H.264 via WebCodecs) or GIF of a round, a kill or the `[ ]` range, with
overlays (names, kill feed, score); rendered offline frame by frame. The 3D MP4 carries the game's sounds as
heard at the camera of each frame (rendered offline, AAC - Opus where AAC is missing); where the browser
cannot encode H.264 the WebM fallback records the live sound; GIFs are silent.

**Names over the players** (3D): Layers *Names* shows them; the enemies' names only with Display *Enemy names*
(off by default - the game never shows an enemy's name: only a teammate's under the crosshair); enemies are those of
the player in first person, else of the selected player, else of the player the demo follows. X-Ray *Player + name*
names everyone.

**Player names**: the colour codes (`^1`, also CoD2x / zPAM's runs like `^^00`) are removed on the 2D and 3D
maps, in the kill feed and the panels; the scoreboard shows each name in its colours.

**Assists** (scoreboard column *A*): CoD2 sends none, but zPAM puts its own count in its scoreboard
(`ui_scoreboard_*`); the viewer takes the final values from there - `≈` where only part of the match is in
it, the column is left out for demos without (stock servers).

**Narrow windows and touch screens**: below 1100 px the page becomes one column (the view with the rail
and the score pill, the player bar right under it - sized so that it fits in the window -, then the drawer)
and scrolls; the match details fill the screen. On a
touch screen one finger pans the 2D map and two fingers pinch-zoom it; the 3D orbit camera turns with one
finger and zooms / pans with two; the timeline seeks by touch.

Deep links: `index.html?demo=demos/my.dm_1&view=3d&t=300&focus=name` loads a demo served from the same
site (`?demo=` takes only a path on the site, no other website), opens the 3D view at 5:00 and selects the first player whose name contains "name";
`&cam=x,y,z,yaw,pitch` opens the free camera there; `&sound=off` leaves the sounds out.

## What a demo contains (and does not)

A client demo is the recording player's network view. Other players only exist while the server sends
them, so positions have gaps: stale players are hidden, or drawn hollow with "last known position".
CoD2's obituary names the means of death instead of the weapon for headshots and bashes: the weapon
then comes from the killer's bullet hit on the victim (exact) or the weapon in the killer's hands (≈). The bomb
messages (`MP_EXPLOSIVESPLANTED` / `DEFUSED`) name nobody, but the game holds the planter / defuser at the
site without a weapon for the plant / defuse time - that player is named (exact; only when they were not in
the POV's snapshots: the player of the side who stood still at the site, ≈). The planted bomb is drawn at
its own model's position (else where the game puts it, 11 units in front of the planter) and labelled
with the nearest site. Values marked `≈` are heuristics
(hover for how they were derived).

**Damaged files and unknown maps**: a truncated demo (an interrupted recording) is shown up to the cut,
with a warning; a file that is not a CoD2 demo is rejected with a message (a CoD4 / CoD4X demo is named as
such). A demo on a map without
exported data (a custom map) plays on a grid fitted to the players' positions, in 2D and 3D (players,
effects and sounds work; the effects then have no map light and land on a flat ground).

**zPAM**: rounds come from the fast restarts (`n`) and zPAM's `_match_round` (`Round 7 / 24`, `Ready-up`,
`Timeout`; zPAM 4.09 does not send it - its rounds come from the score changes), the win and its reason
from the team scores (`G` / `H`) and the game messages, halftimes from the side swap of the scores and
zPAM's half-time messages (the overtime starts without a swap: "Half-time Overtime Ready-Up Mode"),
timeouts from "Timeout Ready-Up Mode"; a round interrupted by a timeout is shown as such and not counted. Stock S&D
uses the score changes only; other game types have no rounds.

## Run it locally

ES modules do not work from `file://`, so serve the folder:

```bash
py tools/serve.py
```

Open <http://127.0.0.1:8765/> and drop a `.dm_1` file on the page (or use **Open demo**).
`tools/serve.py` is `python -m http.server` without browser caching (plain `py -m http.server 8765`
works too, but may keep old files after an update: reload with `Ctrl+F5`). Tested with Chrome 156, Edge 156 and Firefox 159 (Safari not yet); any
browser with WebGL 2 and ES modules should work.

## Regenerate the map data (Python)

Needs **Python 3.10+** and **Pillow with WebP** (`pip install pillow`), nothing else. The game folder is
the CoD2 install with `main/` (stock `iw_*.iwd`, localized `localized_*_iw*.iwd`, and for the zPAM map
pack and radar images `zpam_maps_v7.iwd` / `zpam409.iwd`).

```bash
py tools/export/export_maps.py --game "C:/Games/Call of Duty 2"
```

```bash
py tools/export/export_maps.py --game "C:/Games/Call of Duty 2" --map mp_toujane --map mp_carentan
```

```bash
py tools/export/sound_export.py --game "C:/Games/Call of Duty 2"
```

```bash
py tools/export/characters_export.py --game "C:/Games/Call of Duty 2"
```

```bash
py tools/export/fx_export.py --game "C:/Games/Call of Duty 2"
```

```bash
py tools/export/viewmodels_export.py --game "C:/Games/Call of Duty 2"
```

```bash
py tools/export/hud_export.py --game "C:/Games/Call of Duty 2"
```

| Option (export_maps.py) | Meaning |
|---|---|
| `--game DIR` | the install folder (with `main/`) |
| `--map NAME` | only this map (repeatable); default: every `maps/mp/*.d3dbsp` in the archives |
| `--out DIR` | output folder (default `maps3d/`) |
| `--tex-size N` | largest texture edge (default 512) |
| `--topdown-size N` | edge of the top-down image (default 2048) |
| `--force` | re-encode textures already in `maps3d/_textures` |
| `--no-icons` | skip the kill icons |
| `--icons-only` | only the kill icons (`assets/killfeed/`: each weapon's `killIcon`, mirrored where the weapon file sets `flipKillIcon` - as the game's kill feed shows it) |
| `--grid-only` | only add the light grid (`lightgrid.bin`), its collision (`collision.bin`), the sun keys and the props' lighting keys to maps already exported |
| `--entities-only` | only add the hurt triggers (`trigger_hurt`: boxes and damage) to the `entities.json` of maps already exported |

Per map it writes into `maps3d/<map>/`: `world.bin/json` (BSP triangle soups: positions, normals, vertex
colours, UVs, lightmap UVs, indices; one draw group per material + lightmap with its blend / alpha test),
`lightmap<N>.webp` (the baked light: each texel's 4 coefficients weighted as the game does for a
surface without normal map), `lmc<N>_<k>.webp` (the 4 coefficients, weighted per pixel by the normal maps)
and `sun<N>.webp` (the sun's visibility, 1024 × 1024), `lightgrid.bin` (the models' light grid: the BSP's grid points and colours as
stored), `collision.bin` (the world's solid brushes and terrain triangles: the grid's visibility traces),
`sky.webp` (the six cube faces), `props.bin/json` (each misc_model's LOD 0 from its
XModel with its flags and, for normal-mapped models, the tangents; placements as 3 × 4 matrices with the compiler's ground light and the entity's
light scales), `entities.json` (spawns, bomb
sites, props), `topdown.webp` and `radar.webp`; shared textures in `maps3d/_textures/` (colour and
detail maps; normal maps with the specular power in blue, `<normal>+<specular>.webp`; the specular
maps' colour), the index
`maps3d/index.json`, the 2D registry `assets/maps/backgrounds.js` and the kill icons in `assets/killfeed/`.
All 32 maps (15 stock + 17 zPAM map pack) take about 8 minutes and ~470 MB (+ ~51 MB shared textures).
`sound_export.py` writes
`maps3d/_sound/` (746 aliases + zPAM's 3 redefinitions, ~28 MB, 22 kHz mono WAV, the volume falloff curves and
hold_breath.shock's channel volumes; no map ambience / music). `characters_export.py` writes
`maps3d/_characters/` (116 body / head / helmet models skinned to their skeletons, the 35 weapons' world models,
the 7 grenade / rocket projectile models and the 58 models of the effects' model elements - shell casings, the
burnt smoke grenade, debris -, ~9.9 MB, and the 280 animations of the multiplayer anim tree by the index the demo
sends, with their gun-hand notetracks, ~6 MB; textures into
`maps3d/_textures/`). Without it the 3D view falls back to capsules. `fx_export.py` writes
`maps3d/_fx/effects.json` (all 380 effects of `fx/` with their curves, the impact tables, the weapons'
flash / explosion / shell eject effects and which are bolt-action, 102 effect materials; ~2.3 MB, textures into `maps3d/_textures/`); without it
the 3D view draws the marker clouds. `viewmodels_export.py` writes `maps3d/_characters/viewmodels.json + .bin`
(the 44 weapons' gun models and the 9 hands models, ~3.4 MB, with each weapon file's view animation names, its
numbers for the motion, the ADS and the crosshair, the reticle and scope overlay images) and `vanims.json + .bin`
(the 309 view animations, ~2.1 MB); without it first person shows no weapon. `hud_export.py` writes
`maps3d/_hud/` (`hud.json`: both HUD menu layouts - stock and zPAM - as parsed from `ui_mp/hud.menu`, zPAM's
scoreboard menu, the six fonts' glyph tables, the English text of 1746 localized strings, the weapon files' HUD
fields and combat numbers, the default key binds, the game type and map names; and 205 HUD images as PNG -
hints, stance, damage direction, scoreboard flags and status icons included; ~2.8 MB); without it first person shows no HUD. Display names of new maps go into
`assets/maps/maps.js`.

`tools/gen_tables.py` regenerates `js/c2/parser/tables.js` (the Huffman code table built from the
engine's `msg_hData` and the net field tables).

## Validation

```bash
py tools/validate/check_alignment.py --spawns mp_toujane mp_carentan mp_burgundy mp_dawnville mp_matmata
```

checks a map's spawn points (or a demo's positions: `positions.json` dumped from `window.cod2.data` in the
browser console - `{map, pts: [[client, x, y, z, flags]]}`) against the export: inside the top-down image
and on rendered geometry, inside the zPAM radar rectangle, and standing on a triangle of the 3D world.
Results (2026-10-26), 14 demos and the spawn points of all 32 maps:

| Demo (map) | Samples | Inside top-down | On rendered 2D | Inside radar | On a 3D triangle |
|---|---|---|---|---|---|
| zPAM 3.34 match (mp_burgundy_fix) | 33,622 | 100 % | 99.9 % | 100 % | 99.5 % |
| zPAM 4.09 match (mp_burgundy_fix) | 21,589 | 100 % | 99.9 % | 100 % | 98.4 % |
| zPAM 4.09 match (mp_carentan_fix) | 85,724 | 100 % | 94.2 % | 100 % | 98.0 % |
| zPAM 4.09 match (mp_dawnville_fix) | 30,204 | 100 % | 99.9 % | 100 % | 99.6 % |
| zPAM 4.09 match (mp_matmata_fix) | 26,463 | 100 % | 100 % | 100 % | 97.3 % |
| zPAM 4.09 match (mp_toujane_fix) | 36,949 | 100 % | 100 % | 100 % | 97.5 % |
| zPAM 4.09 match (mp_railyard_mjr) | 34,939 | 100 % | 99.7 % | 100 % | 97.8 % |
| zPAM 4.09 match (mp_breakout_tls) | 31,322 | 100 % | 98.7 % | 100 % | 98.5 % |
| zPAM 4.09 match (mp_trainstation_fix) | 33,070 | 100 % | 99.8 % | 100 % | 98.1 % |
| zPAM 4.09 match (mp_vallente_fix) | 50,606 | 100 % | 100 % | 100 % | 99.3 % |

The 3D misses are players on props or in the air (jumps, ladders). The 2D check is colour-based and
counts very dark ground as empty (Carentan's shaded streets). The spawn points of all 32 maps: 100 %
inside the top-down, 98–100 % on a world triangle (mp_brecourt 87.5 %: spawns in grass props).

All 14 sample demos parse without a warning: one zPAM 3.34 match on mp_burgundy_fix (CoD2x 1.4.3.1),
nine zPAM 4.09 matches (CoD2x 1.4.6.8, incl. a 46-round overtime match on Carentan and a 29-round one on
Vallente), short zPAM 3.34 clips (1.3) and stock 1.0 / 1.3 DM clips. Every match ends on the score the
server sent (e.g. Burgundy 13:11 with halftime after round 12 and a timeout-interrupted round; Carentan
25:21 in 2 + 8 halves - zPAM's overtime halves of 3 rounds; Vallente 13:16).

## Audits

`tools/audit/` checks the whole project before a release (read-only; reports in `tools/audit/out/`,
git-ignored):

| Script | Checks |
|---|---|
| `py tools/audit/site_audit.py` | GitHub Pages readiness: manifest against the files, every reference with its exact case, `.nojekyll`, sizes, leftovers (local paths, `console.log`), the page head |
| `py tools/audit/map_audit.py --game DIR` | every map of the game files against its export: geometry, model placements, textures, bounds, entities |
| `node tools/audit/demo_audit.mjs` | every demo in `demos/`: players, teams, kills, scores, rounds, bomb events, MG tracks |
| `py tools/audit/leftovers.py` | flash / stun grenades (CoD4 template, not in CoD2) left in the code, styles or exported data |
| `node tools/audit/demo_detail.mjs <demo> [client]` | the details behind a demo-audit finding: kill records, deaths against the scoreboard by phase, the positions around a jump |
| `ui_audit.js`, `xray_audit.js` | pasted into the DevTools console on a loaded demo (the console is not bound by the page's CSP - `eval` from the page is): every control of both views, the X-Ray rules |

## Deploy to GitHub Pages

1. Run `py tools/audit/site_audit.py` (0 problems expected but the `?debug` picker's `console.log`).
   Create a repository and push the project (`maps3d/` included - it is the site's data; the `demos/`
   folder is git-ignored). Binary files are marked in `.gitattributes`; no Git LFS (Pages would serve
   the pointer files).
2. Repository **Settings → Pages**: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. The site is at `https://<user>.github.io/<repository>/`. `.nojekyll` makes Pages serve every file as is.
4. `maps3d/manifest.json` lists size and hash of every data file; the 3D view loads each with `?v=<hash>`,
   so a browser or CDN cache never mixes an old JSON header with a new binary. The exporters rewrite it
   at the end; after copying or editing files under `maps3d/` by hand, run
   `py tools/check_deploy.py manifest`.
5. `index.html` sets a Content-Security-Policy (`<meta http-equiv>`: only the site's own files, `blob:` for the
   parser and GIF workers). Its `sha256-…` is the hash of the inline import map: after changing the import map
   (e.g. to the CDN, which then also needs its host in `script-src`), compute the new hash
   (`base64(sha256(<the text between the import map's script tags>))`) or the page stops loading three.js.
6. After a push, compare the live site with the local folder (missing files, other sizes or contents,
   a 404 page or a Git LFS pointer served instead of the data; exit code 1 on a mismatch):

```bash
py tools/check_deploy.py check --url https://<user>.github.io/<repository>/
```

## Project layout

```
LICENSE                           GPL-3.0 (the code; the game data: see "Credits and licence")
index.html, css/                  page and styles (from cod4-demo3d)
js/c2/parser/                     CoD2 netcode: Huffman, bit reader, delta states, demo records
js/c2/analysis/                   collector + DemoData (players, teams, kills, rounds, grenades, sounds)
js/c2/common/, js/c2/ui/          constants, server commands, text; tables, 2D renderer, heatmap, export
js/app/                           app shell, match model, shared replay state
js/view2d/, js/view3d/            the two views (3D: map loader, props, actors, characters, effects, particle
                                  effects + light probe, sky, sound)
assets/maps/                      map registry and 2D backgrounds (generated), assets/killfeed: icons,
                                  assets/fonts: the self-hosted fonts with their licences
vendor/three/                     three.js r170 (build + OrbitControls, MIT licence)
maps3d/                           exported map data (generated)
tools/export/                     Python export (iwd, iwi, materials, bsp, xmodel, xanim, top-down, sounds,
                                  characters, effects, view models, HUD)
tools/validate/                   alignment check;   tools/serve.py: local server
tools/audit/                      release audits (site, maps, demos, UI, X-Ray)
tools/check_deploy.py             data manifest + check of the deployed site
```

See [PLAN.md](PLAN.md) for the format notes, decisions and what is still open.

## Credits and licence

The code is GPL-3.0 (see `LICENSE`). Projects it builds on or was checked against:

- **cod4-demo3d** (GPL-3.0): the app shell, the match and replay model, the structure of the 2D and 3D views,
  the panels and the video export are ported from it.
- **cod2-demoparser**: the CoD2 demo format - records, the Huffman table, the net field tables.
- **[CoD2x](https://github.com/callofduty2x/CoD2x)** by callofduty2x: its decompiled CoD2 1.3 client
  (`src/other`) is the reference the demo format, the net field tables, the events and the scoreboard command
  were checked against and the light-grid lighting of the models was taken from; also CoD2x 1.4's protocol,
  its radar formula (`cg_hudRadar*`) and how it draws colour codes in names.
- **[zPAM 3](https://github.com/eyza-cod2/zpam3)** by eyza-cod2: the competitive match logic of zPAM 3.34 /
  4.09 - rounds, halftimes, overtime, timeouts and scores from its server info and messages, its own assist
  count and the scoreboard values it sends (`sd.gsc`, `_menu_scoreboard.gsc`).

three.js is MIT (`vendor/three/LICENSE`); the fonts Inter and JetBrains Mono are under the SIL Open Font
License 1.1 (`assets/fonts/*-OFL.txt`).

**Game data**: the 3D maps, textures, top-down images, sounds, player and weapon models, animations, effects
and kill icons (`maps3d/`, `assets/killfeed/`) are extracted from Call of Duty 2's game files; the maps of the
zPAM map pack and the radar images from the zPAM files. They are not covered by the GPL - they belong to their
owners (Activision, the authors of the custom maps and of zPAM) and are included only so that the viewer can
show the maps. Call of Duty is a trademark of Activision; this project is not affiliated with Activision or
Infinity Ward.
