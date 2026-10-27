/* Engine constants of CoD2 MP (1.0 - 1.3, CoD2x 1.4): the event names come from the `eventnames`
 * table of CoD2MP_s.exe (cgame CG_EntityEvent, debug output), the means of death from the same
 * binary and cod2-demoparser, the config string layout from CG_ConfigStringModified of the 1.3
 * client and the sample demos (see PLAN.md). */
C2.define('constants', function (C2) {
  'use strict';
  const SURFACES = ['default', 'bark', 'brick', 'carpet', 'cloth', 'concrete', 'dirt', 'flesh', 'foliage', 'glass',
    'grass', 'gravel', 'ice', 'metal', 'mud', 'paper', 'plaster', 'rock', 'sand', 'snow', 'water', 'wood', 'asphalt'];
  const EVENT_NAMES = ['none'];
  for (const kind of ['footstep_run', 'footstep_walk', 'footstep_prone', 'jump', 'landing', 'landing_pain']) {
    for (const s of SURFACES) EVENT_NAMES.push(kind + '_' + s);
  }
  EVENT_NAMES.push('foliage_sound', 'stance_force_stand', 'stance_force_crouch', 'stance_force_prone', 'step_view',
    'item_pickup', 'ammo_pickup', 'noammo', 'emptyclip', 'empty_offhand', 'reset_ads', 'reload', 'reload_from_empty',
    'reload_start', 'reload_end', 'raise_weapon', 'putaway_weapon', 'weapon_alt', 'pullback_weapon', 'fire_weapon',
    'fire_weaponb', 'fire_weapon_lastshot', 'rechamber_weapon', 'eject_brass', 'melee_swipe', 'fire_melee',
    'prep_offhand', 'use_offhand', 'switch_offhand', 'binocular_enter', 'binocular_exit', 'binocular_fire',
    'binocular_release', 'binocular_drop', 'melee_hit', 'melee_miss', 'fire_weapon_mg42', 'fire_quadbarrel_1',
    // the executable's debug names list small, large, shotgun, ap here, but the demos send the world
    // impacts of pistols / SMGs / shotguns as 182 and of rifles as 183 (shotgun_hit never seen)
    'fire_quadbarrel_2', 'bullet_tracer', 'sound_alias', 'sound_alias_as_master', 'shotgun_hit',
    'bullet_hit_small', 'bullet_hit_large', 'bullet_hit_ap', 'bullet_hit_client_small', 'bullet_hit_client_large',
    'grenade_bounce', 'grenade_explode', 'rocket_explode', 'rocket_explode_nomarks', 'custom_explode',
    'custom_explode_nomarks', 'bullet', 'play_fx', 'play_fx_on_tag', 'earthquake', 'grenade_suicide', 'obituary');
  const EV = {};
  EVENT_NAMES.forEach((n, i) => { EV[n.toUpperCase()] = i; });
  /* entity types; an event entity has eType = ET_EVENTS + event (obituary: 208) */
  const ET = { GENERAL: 0, PLAYER: 1, PLAYER_CORPSE: 2, ITEM: 3, MISSILE: 4, INVISIBLE: 5, SCRIPTMOVER: 6,
    FX: 7, LOOP_FX: 8, TURRET: 9, EVENTS: 10 };
  const MEANS_OF_DEATH = [
    'MOD_UNKNOWN', 'MOD_PISTOL_BULLET', 'MOD_RIFLE_BULLET', 'MOD_GRENADE', 'MOD_GRENADE_SPLASH',
    'MOD_PROJECTILE', 'MOD_PROJECTILE_SPLASH', 'MOD_MELEE', 'MOD_HEAD_SHOT', 'MOD_CRUSH',
    'MOD_TELEFRAG', 'MOD_FALLING', 'MOD_SUICIDE', 'MOD_TRIGGER_HURT', 'MOD_EXPLOSIVE', 'MOD_BAD'
  ];
  const TEAM = { FREE: 0, AXIS: 1, ALLIES: 2, SPECTATOR: 3 };
  const ENTITYNUM_WORLD = 1022, ENTITYNUM_NONE = 1023;
  /* entity flags (cod2-demoparser declarations, checked on the sample demos: firing is 0x40, the
   * demoparser's 0x20 is never set; dead players leave the snapshot and a corpse entity appears) */
  const EF = { CROUCH: 0x4, PRONE: 0x8, FIRING: 0x40, USETURRET: 0x300, MANTLE: 0x4000, DEAD: 0x20000, ADS: 0x40000, TALK: 0x200000 };
  /* player state pm_flags; FOLLOW = the recording client follows another player (its ps is a copy) */
  const PMF = { PRONE: 1, CROUCH: 2, MANTLE: 4, LADDER: 32, FOLLOW: 0x1000000 };
  /* player state pm_type: 0 / 1 alive (1 = on a turret), 4 free spectator, 6 dead */
  const PM = { NORMAL: 0, NORMAL_LINKED: 1, SPECTATOR: 4, DEAD: 6 };
  /* config string indexes (MP layout of 1.3, CG_ConfigStringModified) */
  const CS = {
    SERVERINFO: 0, SYSTEMINFO: 1, GAME_VERSION: 2, MUSIC: 3, SCORES1: 5, SCORES2: 6, WEAPONS: 7, ITEMS: 8,
    FOG: 12, LEVEL_START_TIME: 13, VOTE_TIME: 14, VOTE_STRING: 15, VOTE_YES: 16, VOTE_NO: 17,
    STATUS_ICONS: 22, DVAR_NAMES: 142, DVAR_VALUES: 238, MODELS: 334, SOUNDS: 590, EFFECTS: 846,
    EFFECT_TAGS: 910, SHELLSHOCKS: 1166, SCRIPT_MENUS: 1246, LOCALIZED: 1278, MATERIALS: 1566
  };
  const NUM_DVARS = 96;
  // the 162 unit vectors of DirToByte / ByteToDir (event parameters with a direction: impacts,
  // explosions), read from CoD2MP_s.exe: x y z per byte value
  const BYTE_DIRS = new Float32Array([
    -0.525731, 0, 0.850651, -0.442863, 0.238856, 0.864188, -0.295242, 0, 0.955423, -0.309017, 0.5, 0.809017, -0.16246, 0.262866, 0.951056, 0, 0, 1,
    0, 0.850651, 0.525731, -0.147621, 0.716567, 0.681718, 0.147621, 0.716567, 0.681718, 0, 0.525731, 0.850651, 0.309017, 0.5, 0.809017, 0.525731, 0, 0.850651,
    0.295242, 0, 0.955423, 0.442863, 0.238856, 0.864188, 0.16246, 0.262866, 0.951056, -0.681718, 0.147621, 0.716567, -0.809017, 0.309017, 0.5, -0.587785, 0.425325, 0.688191,
    -0.850651, 0.525731, 0, -0.864188, 0.442863, 0.238856, -0.716567, 0.681718, 0.147621, -0.688191, 0.587785, 0.425325, -0.5, 0.809017, 0.309017, -0.238856, 0.864188, 0.442863,
    -0.425325, 0.688191, 0.587785, -0.716567, 0.681718, -0.147621, -0.5, 0.809017, -0.309017, -0.525731, 0.850651, 0, 0, 0.850651, -0.525731, -0.238856, 0.864188, -0.442863,
    0, 0.955423, -0.295242, -0.262866, 0.951056, -0.16246, 0, 1, 0, 0, 0.955423, 0.295242, -0.262866, 0.951056, 0.16246, 0.238856, 0.864188, 0.442863,
    0.262866, 0.951056, 0.16246, 0.5, 0.809017, 0.309017, 0.238856, 0.864188, -0.442863, 0.262866, 0.951056, -0.16246, 0.5, 0.809017, -0.309017, 0.850651, 0.525731, 0,
    0.716567, 0.681718, 0.147621, 0.716567, 0.681718, -0.147621, 0.525731, 0.850651, 0, 0.425325, 0.688191, 0.587785, 0.864188, 0.442863, 0.238856, 0.688191, 0.587785, 0.425325,
    0.809017, 0.309017, 0.5, 0.681718, 0.147621, 0.716567, 0.587785, 0.425325, 0.688191, 0.955423, 0.295242, 0, 1, 0, 0, 0.951056, 0.16246, 0.262866,
    0.850651, -0.525731, 0, 0.955423, -0.295242, 0, 0.864188, -0.442863, 0.238856, 0.951056, -0.16246, 0.262866, 0.809017, -0.309017, 0.5, 0.681718, -0.147621, 0.716567,
    0.850651, 0, 0.525731, 0.864188, 0.442863, -0.238856, 0.809017, 0.309017, -0.5, 0.951056, 0.16246, -0.262866, 0.525731, 0, -0.850651, 0.681718, 0.147621, -0.716567,
    0.681718, -0.147621, -0.716567, 0.850651, 0, -0.525731, 0.809017, -0.309017, -0.5, 0.864188, -0.442863, -0.238856, 0.951056, -0.16246, -0.262866, 0.147621, 0.716567, -0.681718,
    0.309017, 0.5, -0.809017, 0.425325, 0.688191, -0.587785, 0.442863, 0.238856, -0.864188, 0.587785, 0.425325, -0.688191, 0.688191, 0.587785, -0.425325, -0.147621, 0.716567, -0.681718,
    -0.309017, 0.5, -0.809017, 0, 0.525731, -0.850651, -0.525731, 0, -0.850651, -0.442863, 0.238856, -0.864188, -0.295242, 0, -0.955423, -0.16246, 0.262866, -0.951056,
    0, 0, -1, 0.295242, 0, -0.955423, 0.16246, 0.262866, -0.951056, -0.442863, -0.238856, -0.864188, -0.309017, -0.5, -0.809017, -0.16246, -0.262866, -0.951056,
    0, -0.850651, -0.525731, -0.147621, -0.716567, -0.681718, 0.147621, -0.716567, -0.681718, 0, -0.525731, -0.850651, 0.309017, -0.5, -0.809017, 0.442863, -0.238856, -0.864188,
    0.16246, -0.262866, -0.951056, 0.238856, -0.864188, -0.442863, 0.5, -0.809017, -0.309017, 0.425325, -0.688191, -0.587785, 0.716567, -0.681718, -0.147621, 0.688191, -0.587785, -0.425325,
    0.587785, -0.425325, -0.688191, 0, -0.955423, -0.295242, 0, -1, 0, 0.262866, -0.951056, -0.16246, 0, -0.850651, 0.525731, 0, -0.955423, 0.295242,
    0.238856, -0.864188, 0.442863, 0.262866, -0.951056, 0.16246, 0.5, -0.809017, 0.309017, 0.716567, -0.681718, 0.147621, 0.525731, -0.850651, 0, -0.238856, -0.864188, -0.442863,
    -0.5, -0.809017, -0.309017, -0.262866, -0.951056, -0.16246, -0.850651, -0.525731, 0, -0.716567, -0.681718, -0.147621, -0.716567, -0.681718, 0.147621, -0.525731, -0.850651, 0,
    -0.5, -0.809017, 0.309017, -0.238856, -0.864188, 0.442863, -0.262866, -0.951056, 0.16246, -0.864188, -0.442863, 0.238856, -0.809017, -0.309017, 0.5, -0.688191, -0.587785, 0.425325,
    -0.681718, -0.147621, 0.716567, -0.442863, -0.238856, 0.864188, -0.587785, -0.425325, 0.688191, -0.309017, -0.5, 0.809017, -0.147621, -0.716567, 0.681718, -0.425325, -0.688191, 0.587785,
    -0.16246, -0.262866, 0.951056, 0.442863, -0.238856, 0.864188, 0.16246, -0.262866, 0.951056, 0.309017, -0.5, 0.809017, 0.147621, -0.716567, 0.681718, 0, -0.525731, 0.850651,
    0.425325, -0.688191, 0.587785, 0.587785, -0.425325, 0.688191, 0.688191, -0.587785, 0.425325, -0.955423, 0.295242, 0, -0.951056, 0.16246, 0.262866, -1, 0, 0,
    -0.850651, 0, 0.525731, -0.955423, -0.295242, 0, -0.951056, -0.16246, 0.262866, -0.864188, 0.442863, -0.238856, -0.951056, 0.16246, -0.262866, -0.809017, 0.309017, -0.5,
    -0.864188, -0.442863, -0.238856, -0.951056, -0.16246, -0.262866, -0.809017, -0.309017, -0.5, -0.681718, 0.147621, -0.716567, -0.681718, -0.147621, -0.716567, -0.850651, 0, -0.525731,
    -0.688191, 0.587785, -0.425325, -0.587785, 0.425325, -0.688191, -0.425325, 0.688191, -0.587785, -0.425325, -0.688191, -0.587785, -0.587785, -0.425325, -0.688191, -0.688191, -0.587785, -0.425325
  ]);
  C2.constants = { SURFACES, EVENT_NAMES, EV, ET, MEANS_OF_DEATH, TEAM, ENTITYNUM_WORLD, ENTITYNUM_NONE,
    EF, PMF, PM, CS, NUM_DVARS, BYTE_DIRS };
});
