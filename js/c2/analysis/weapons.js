/* Readable weapon names of CoD2. The weapon list itself comes from config string 7 of the demo
 * (weapon index i = entry i - 1); this table only turns the internal names into labels. The kill
 * icons are the game's own (weapon files: killIcon; the means of death: killiconmelee, ...), exported
 * by tools/export into assets/killfeed and registered by assets/killfeed/icons.js. */
C2.define('weapons', function (C2) {
  'use strict';
  const BASE = {
    // American
    greasegun: 'Grease Gun', m1carbine: 'M1A1 Carbine', m1garand: 'M1 Garand', springfield: 'Springfield',
    thompson: 'Thompson', bar: 'BAR', bar_buffed: 'BAR', colt: 'Colt .45', frag_grenade_american: 'MK2 Frag Grenade',
    smoke_grenade_american: 'Smoke Grenade', '30cal_stand': '.30 cal MG', '30cal_prone': '.30 cal MG',
    // British
    enfield: 'Lee-Enfield', enfield_scope: 'Scoped Lee-Enfield', sten: 'Sten', bren: 'Bren LMG', webley: 'Webley',
    frag_grenade_british: 'Mills Bomb', smoke_grenade_british: 'Smoke Grenade',
    // Russian
    mosin_nagant: 'Mosin-Nagant', mosin_nagant_sniper: 'Scoped Mosin-Nagant', pps42: 'PPS-42', ppsh: 'PPSh-41',
    svt40: 'SVT-40', tt30: 'Tokarev TT-30', frag_grenade_russian: 'RGD-33', smoke_grenade_russian: 'Smoke Grenade',
    // German
    kar98k: 'Kar98k', kar98k_sniper: 'Scoped Kar98k', mp40: 'MP40', mp44: 'MP44', g43: 'Gewehr 43', luger: 'Luger',
    frag_grenade_german: 'Stielhandgranate', smoke_grenade_german: 'Smoke Grenade', mg42_bipod_stand: 'MG42',
    mg42_bipod_duck: 'MG42', mg42_bipod_prone: 'MG42', fg42: 'FG42',
    // shared
    shotgun: 'Trench Gun', binoculars: 'Binoculars', defaultweapon: 'Default Weapon', none: 'None'
  };
  const MOD = {
    MOD_UNKNOWN: 'Unknown', MOD_PISTOL_BULLET: 'Pistol', MOD_RIFLE_BULLET: 'Rifle',
    MOD_GRENADE: 'Grenade', MOD_GRENADE_SPLASH: 'Grenade Splash', MOD_PROJECTILE: 'Projectile',
    MOD_PROJECTILE_SPLASH: 'Projectile Splash', MOD_MELEE: 'Bash', MOD_HEAD_SHOT: 'Headshot',
    MOD_CRUSH: 'Crushed', MOD_TELEFRAG: 'Telefrag', MOD_FALLING: 'Falling', MOD_SUICIDE: 'Suicide',
    MOD_TRIGGER_HURT: 'Trigger', MOD_EXPLOSIVE: 'Explosive', MOD_BAD: 'Unknown'
  };

  /** 'kar98k_sniper_mp' -> 'Scoped Kar98k', 'MOD_FALLING' -> 'Falling' */
  function label(name) {
    if (!name) return '';
    if (MOD[name]) return MOD[name];
    const base = String(name).toLowerCase().replace(/_mp$/, '');
    if (BASE[base]) return BASE[base];
    if (/^c_smoke_grenade/.test(base)) return 'Smoke Grenade';
    return base.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /** grenade kind of a weapon name, or null */
  function grenadeKind(name) {
    const n = String(name || '').toLowerCase();
    // zPAM 4.09 / CoD2x: c_smoke_grenade_<nation>_mp (its smoke variant)
    if (/^(c_)?smoke_grenade/.test(n)) return 'smoke';
    if (n.startsWith('frag_grenade')) return 'frag';
    return null;
  }

  /** internal weapon name without case and "_mp" */
  const plainName = name => String(name || '').toLowerCase().replace(/_mp$/, '');
  /** frag grenade kill weapon ("nade"): frag_grenade_<nation>_mp */
  function isFragNade(name) { return /^frag_grenade_/.test(plainName(name)); }
  const obituaryWeapon = kill => (kill && kill.weapon != null && !kill.weaponHeuristic ? kill.weaponName : null);
  /** killed by the bomb explosion: means of death MOD_EXPLOSIVE (the bomb's radius damage) */
  function isBombKill(kill) { return !!kill && kill.mod === 'MOD_EXPLOSIVE'; }
  /** THE rule for a frag grenade kill ("nade"): the weapon named by the obituary is a frag grenade */
  function isFragGrenadeKill(kill) { return isFragNade(obituaryWeapon(kill)); }

  /* ---- killfeed icons (assets/killfeed, registered by assets/killfeed/icons.js) ----
   * ICONS[file] = {size: [w, h], box: [x, y, w, h] of the visible content}; WEAPON_ICON[base weapon] =
   * file; MOD_ICON[means of death] = file. All icons point left -> right (killer -> victim). */
  const ICON_DIR = 'assets/killfeed/';
  const ICONS = {};
  const WEAPON_ICON = {};
  const MOD_ICON = {};

  /** 'kar98k_sniper_mp' -> 'kar98k_sniper' */
  function baseWeapon(name) { return plainName(name); }
  const iconOf = (file, title, heuristic) => file && ICONS[file] ? Object.assign({ file, src: ICON_DIR + file, title, heuristic: !!heuristic }, ICONS[file]) : null;
  /** icon of an internal weapon name or a means of death (MOD_FALLING, MOD_MELEE ...; null if none) */
  function weaponIcon(name) {
    if (MOD_ICON[name]) return iconOf(MOD_ICON[name], MOD[name] || name);
    return iconOf(WEAPON_ICON[baseWeapon(name)], label(name));
  }

  /**
   * Killfeed icons of a kill - THE mapping for all tabs:
   * {weapon: icon | null, headshot: icon | null, text: label shown when there is no weapon icon}.
   * As in the game (CG_Obituary): a means of death without a weapon (bash, headshot, falling,
   * suicide, crush) shows its own icon; a headshot additionally gets the weapon the killer held
   * (marked heuristic) when it is known.
   */
  function killIcons(k) {
    const out = { weapon: null, headshot: null, text: killText(k) };
    if (k.headshot) out.headshot = iconOf(MOD_ICON.MOD_HEAD_SHOT, 'Headshot');
    if (k.falling) out.weapon = iconOf(MOD_ICON.MOD_FALLING, 'Falling');
    else if (k.weaponName && k.weaponName !== 'none') {
      const ic = WEAPON_ICON[baseWeapon(k.weaponName)];
      out.weapon = iconOf(ic, label(k.weaponName) + (k.weaponHeuristic ? ' (weapon the killer held - the obituary of a headshot names none)' : ''), k.weaponHeuristic);
    } else if (k.mod && MOD_ICON[k.mod] && k.mod !== 'MOD_HEAD_SHOT') out.weapon = iconOf(MOD_ICON[k.mod], MOD[k.mod] || k.mod);
    if (!out.weapon && k.suicide) out.weapon = iconOf(MOD_ICON.MOD_SUICIDE, 'Suicide');
    if (!out.weapon && !out.headshot && MOD_ICON.MOD_UNKNOWN) out.weapon = iconOf(MOD_ICON.MOD_UNKNOWN, k.weaponLabel || 'Died');
    return out;
  }
  /** THE weapon of a kill for weapon lists: internal weapon name, a means of death standing for a
   * weapon (bash MOD_MELEE, falling ...), or null = unknown. Never MOD_HEAD_SHOT. */
  function killWeapon(k) {
    if (k.weaponName && k.weaponName !== 'none') return k.weaponName;
    if (k.mod && k.mod !== 'MOD_HEAD_SHOT') return k.mod;
    return null;
  }

  /** killfeed text of a kill (shown when there is no weapon icon) */
  function killText(k) {
    const lab = k.weaponLabel || '';
    if (k.suicide) return k.mod === 'MOD_SUICIDE' ? MOD.MOD_SUICIDE : 'Suicide (' + lab + ')';
    if (k.world) return k.falling ? MOD.MOD_FALLING : 'World / trigger (' + lab + ')';
    if (k.entityAttacker) return 'World entity (' + lab + ')';
    return lab;
  }

  C2.weapons = { label, grenadeKind, isFragNade, isFragGrenadeKill, isBombKill, killWeapon, MOD_LABELS: MOD,
    ICONS, ICON_DIR, WEAPON_ICON, MOD_ICON, baseWeapon, weaponIcon, killIcons, killText };
});
