/* Delta decoding of CoD2 entity, player and client states (MSG_ReadDeltaStruct / MSG_ReadDeltaField /
 * MSG_ReadDeltaPlayerstate of the 1.3 client, see PLAN.md).
 *
 * States are Int32Arrays in network field order: slot 0 = the entity / client number, slot i + 1 =
 * field i of the table (C2.tables). Floats are kept as their 32-bit pattern (C2.msg.u2f reads them).
 * A decoded state is never changed afterwards, so unchanged states are shared between snapshots. */
C2.define('delta', function (C2) {
  'use strict';
  const { f2u } = C2.msg;
  const T = C2.tables;
  const ANGLE = 360 / 65536;

  /** field name -> slot in the state array */
  const slots = fields => { const o = {}; fields.forEach(([name], i) => { o[name] = i + 1; }); return o; };
  const ES = slots(T.ENTITY_FIELDS);
  const CS = slots(T.CLIENT_FIELDS);
  /** player state: field name -> index in ps.f (no number slot) */
  const PS = {}; T.PLAYER_FIELDS.forEach(([name], i) => { PS[name] = i; });
  const HE = {}; T.HUDELEM_FIELDS.forEach(([name], i) => { HE[name] = i; });
  const ENTITY_BITS = T.ENTITY_FIELDS.map(f => f[1]);
  const CLIENT_BITS = T.CLIENT_FIELDS.map(f => f[1]);
  const PLAYER_BITS = T.PLAYER_FIELDS.map(f => f[1]);
  const HUD_BITS = T.HUDELEM_FIELDS.map(f => f[1]);
  const OBJ_BITS = T.OBJECTIVE_FIELDS.map(f => f[1]);
  const NE = ENTITY_BITS.length, NC = CLIENT_BITS.length, NP = PLAYER_BITS.length;
  const NH = HUD_BITS.length, NO = OBJ_BITS.length;
  const MAX_HUDELEMS = 31, MAX_OBJECTIVES = 16, OBJ_STRIDE = 1 + NO;   // state + fields

  const ZERO_ENTITY = new Int32Array(NE + 1);
  const ZERO_CLIENT = new Int32Array(NC + 1);

  class DeltaError extends Error {}

  /** a changed field with the zero bit (entities, clients, hud elements, objectives) */
  function readFieldZ(msg, bits) {
    if (bits === 0 || bits === -99) {
      if (!msg.readBit()) return 0;
      if (msg.readBit()) return msg.readInt() | 0;                     // full 32-bit float
      if (bits === 0) return f2u(msg.readBits(5) + 32 * msg.readByte() - 4096);
      return f2u(msg.readBits(2) + 4 * msg.readByte() - 512);
    }
    if (!msg.readBit()) return 0;
    if (bits === -100) return f2u(Math.fround(msg.readShort() * ANGLE));
    return readInt(msg, bits);
  }

  /** |bits| bits: the remainder bits first, then whole bytes (MSG_ReadDeltaField); negative = signed */
  function readInt(msg, bits) {
    const n = bits === -98 ? 32 : Math.abs(bits);
    const rest = n & 7;
    let v = rest ? msg.readBits(rest) : 0;
    for (let i = rest; i < n; i += 8) v |= msg.readByte() << i;
    if (bits < 0 && bits !== -98 && n < 32 && ((v >> (n - 1)) & 1)) v |= -1 << n;
    return v | 0;
  }

  /**
   * MSG_ReadDeltaStruct: -> null (removed) or the new state (may be `from` itself when unchanged).
   * @param {Int32Array} from  previous state (or the zero state / baseline)
   */
  function readDeltaStruct(msg, from, number, bitsTable) {
    if (msg.readBit()) return null;                                   // remove
    const n = bitsTable.length;
    if (!msg.readBit()) {                                             // no change
      if (from[0] === number) return from;
      const c = Int32Array.from(from); c[0] = number; return c;
    }
    const lc = msg.readByte();
    if (lc > n) throw new DeltaError('invalid field count ' + lc + ' (max ' + n + ') for #' + number);
    const to = new Int32Array(n + 1);
    to[0] = number;
    for (let i = 0; i < lc; i++) to[i + 1] = msg.readBit() ? readFieldZ(msg, bitsTable[i]) : from[i + 1];
    for (let i = lc; i < n; i++) to[i + 1] = from[i + 1];
    return to;
  }

  const readDeltaEntity = (msg, from, number) => readDeltaStruct(msg, from || ZERO_ENTITY, number, ENTITY_BITS);
  const readDeltaClient = (msg, from, number) => readDeltaStruct(msg, from || ZERO_CLIENT, number, CLIENT_BITS);

  /** an empty player state */
  function zeroPlayerState() {
    return { f: new Int32Array(NP), stats: new Int32Array(6), ammo: new Int32Array(128), clip: new Int32Array(128),
      objectives: new Int32Array(MAX_OBJECTIVES * OBJ_STRIDE),
      hudArchival: new Int32Array(MAX_HUDELEMS * NH), hudCurrent: new Int32Array(MAX_HUDELEMS * NH) };
  }
  const ZERO_PS = zeroPlayerState();

  /** HUD elements (MSG_ReadDeltaHudElems): `inuse` elements with their own field count */
  function readHudElems(msg, from) {
    const to = Int32Array.from(from);
    const inuse = msg.readBits(5);
    for (let i = 0; i < inuse; i++) {
      const lc = msg.readBits(5);
      const o = i * NH;
      for (let j = 0; j <= lc; j++) to[o + j] = msg.readBit() ? readFieldZ(msg, HUD_BITS[j]) : from[o + j];
    }
    // the elements after the last one in use are freed
    for (let i = inuse; i < MAX_HUDELEMS && to[i * NH + HE.type]; i++) to.fill(0, i * NH, (i + 1) * NH);
    return to;
  }

  /**
   * MSG_ReadDeltaPlayerstate -> new player state. Parts that did not change are shared with `from`.
   */
  function readDeltaPlayerstate(msg, from) {
    from = from || ZERO_PS;
    const to = { f: Int32Array.from(from.f), stats: from.stats, ammo: from.ammo, clip: from.clip,
      objectives: from.objectives, hudArchival: from.hudArchival, hudCurrent: from.hudCurrent };
    const lc = msg.readByte();
    if (lc > NP) throw new DeltaError('invalid player state field count ' + lc);
    const f = to.f;
    for (let i = 0; i < lc; i++) {
      if (!msg.readBit()) continue;
      const bits = PLAYER_BITS[i];
      if (bits === -100) f[i] = msg.readBit() ? f2u(Math.fround(msg.readShort() * ANGLE)) : 0;
      else if (bits === 0) f[i] = msg.readBit() ? msg.readInt() | 0 : f2u(msg.readBits(5) + 32 * msg.readByte() - 4096);
      else f[i] = readInt(msg, bits);
    }
    // stats
    if (msg.readBit()) {
      const s = to.stats = Int32Array.from(from.stats);
      const mask = msg.readBits(6);
      if (mask & 1) s[0] = msg.readShort();           // health
      if (mask & 2) s[1] = msg.readShort();           // dead yaw
      if (mask & 4) s[2] = msg.readShort();           // max health
      if (mask & 8) s[3] = msg.readBits(6);           // ident client num
      if (mask & 16) s[4] = msg.readShort();          // ident client health
      if (mask & 32) s[5] = msg.readByte();           // spawn count
    }
    // ammo
    if (msg.readBit()) {
      const a = to.ammo = Int32Array.from(from.ammo);
      for (let i = 0; i < 4; i++) {
        if (!msg.readBit()) continue;
        const bits = msg.readShort();
        for (let j = 0; j < 16; j++) if ((bits >> j) & 1) a[j + 16 * i] = msg.readShort();
      }
    }
    // ammo in the clip (no common bit)
    for (let i = 0; i < 4; i++) {
      if (!msg.readBit()) continue;
      if (to.clip === from.clip) to.clip = Int32Array.from(from.clip);
      const bits = msg.readShort();
      for (let j = 0; j < 16; j++) if ((bits >> j) & 1) to.clip[j + 16 * i] = msg.readShort();
    }
    // objectives
    if (msg.readBit()) {
      const o = to.objectives = Int32Array.from(from.objectives);
      for (let i = 0; i < MAX_OBJECTIVES; i++) {
        const b = i * OBJ_STRIDE;
        o[b] = msg.readBits(3);
        if (msg.readBit()) for (let k = 0; k < NO; k++) o[b + 1 + k] = msg.readBit() ? readFieldZ(msg, OBJ_BITS[k]) : from.objectives[b + 1 + k];
      }
    }
    // HUD elements
    if (msg.readBit()) {
      to.hudArchival = readHudElems(msg, from.hudArchival);
      to.hudCurrent = readHudElems(msg, from.hudCurrent);
    }
    return to;
  }

  C2.delta = { ES, CS, PS, HE, NH, OBJ_STRIDE, MAX_OBJECTIVES, MAX_HUDELEMS, ZERO_ENTITY, ZERO_CLIENT,
    DeltaError, readDeltaEntity, readDeltaClient, readDeltaPlayerstate, zeroPlayerState };
});
