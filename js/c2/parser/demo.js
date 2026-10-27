/* Demo container reader for CoD2 (.dm_1): records, server messages, gamestate, snapshots.
 * DOM-free; results go to a visitor object with optional callbacks:
 *
 *   onGamestate({offset, messageSeq, commandSeq, configstrings: Map, baselines: Map, clientNum, checksumFeed})
 *   onConfigstring({index, value, serverTime})            (svc_configstring outside a gamestate)
 *   onServerCommand({seq, text, serverTime, messageSeq})
 *   onSnapshot(snap)   snap = {messageNum, serverTime, snapFlags, deltaNum, ps, entities: [Int32Array], clients: [Int32Array]}
 *   onIssue({offset, messageSeq, text})
 *
 * A record is `int32 sequence, int32 length, bytes[length]`; sequence or length -1 ends the demo.
 * A message is `int32 reliableAcknowledge` + Huffman-compressed svc_* operations (see PLAN.md). */
C2.define('demo', function (C2) {
  'use strict';
  const { Msg } = C2.msg;
  const D = C2.delta;

  const SVC_NOP = 0, SVC_GAMESTATE = 1, SVC_CONFIGSTRING = 2, SVC_BASELINE = 3,
    SVC_SERVERCOMMAND = 4, SVC_DOWNLOAD = 5, SVC_SNAPSHOT = 6, SVC_EOF = 7;
  const MAX_MSGLEN = 0x20000, MAX_CONFIGSTRINGS = 2048;
  const PACKET_BACKUP = 32, PACKET_MASK = PACKET_BACKUP - 1;
  const ENTITYNUM_NONE = 1023;

  class DemoError extends Error {}

  /**
   * Parse a whole demo.
   * @param {Uint8Array} bytes
   * @param {object} visitor callbacks (see top of file)
   * @param {function} [onProgress] receives a fraction 0..1
   * @returns {object} summary: cleanEnd, truncated, stats
   */
  function parseDemo(bytes, visitor, onProgress) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const size = bytes.length;
    if (size < 12) throw new DemoError('The file is too small to be a CoD2 demo.');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const firstLen = dv.getInt32(4, true);
    if (firstLen < 4 || firstLen > MAX_MSGLEN) {
      // a CoD4 demo (also .dm_1): every record starts with a type byte - CoD4X with a protocol record
      // (type 2, the protocol, then -1), 1.7 with a message (type 0, sequence, length)
      const len4 = dv.getInt32(5, true);
      if (bytes[0] === 2 && len4 === -1) throw new DemoError('This is a Call of Duty 4 demo (CoD4X, protocol ' + dv.getUint32(1, true) + '). This viewer reads Call of Duty 2 demos only.');
      if (bytes[0] === 0 && len4 >= 4 && len4 <= MAX_MSGLEN) throw new DemoError('This looks like a Call of Duty 4 demo. This viewer reads Call of Duty 2 demos only.');
      throw new DemoError('This is not a CoD2 demo (.dm_1): the first record has an invalid length (' + firstLen + ').');
    }
    const stats = { messages: 0, snapshots: 0, snapshotsDropped: 0, serverCommands: 0, serverCommandsRepeated: 0,
      gamestates: 0, configstrings: 0, issues: 0, entityStates: 0, overflows: 0 };
    const cl = {
      snapshots: new Array(PACKET_BACKUP).fill(null),
      baselines: new Map(),
      commandSeq: 0,
      lastSnap: null,
      gamestateSeen: false
    };
    let cleanEnd = false, truncated = false;
    let p = 0, nextProgress = 0;
    const issue = (offset, messageSeq, text) => {
      stats.issues++;
      if (visitor.onIssue) visitor.onIssue({ offset, messageSeq, text });
    };

    while (p < size) {
      if (p + 8 > size) { truncated = true; break; }
      const start = p;
      const seq = dv.getInt32(p, true), length = dv.getInt32(p + 4, true);
      p += 8;
      if (seq === -1 || length === -1) { cleanEnd = true; break; }
      if (length < 4 || length > MAX_MSGLEN) { issue(start, seq, 'invalid message length ' + length + ' - reading stopped'); truncated = true; break; }
      if (p + length > size) { truncated = true; break; }
      stats.messages++;
      try { readMessage(start, seq, p, length); }
      catch (err) {
        if (!(err instanceof D.DeltaError)) throw err;
        issue(start, seq, 'message ' + seq + ': ' + err.message + ' - the rest of the message is skipped');
      }
      p += length;
      if (onProgress && p >= nextProgress) { onProgress(p / size); nextProgress = p + size / 50; }
    }
    if (onProgress) onProgress(1);
    return { cleanEnd, truncated, stats };

    function readMessage(offset, messageSeq, bodyStart, length) {
      // reliableAcknowledge (uncompressed), then the compressed operations
      const body = C2.huffman.decompress(bytes, bodyStart + 4, length - 4, MAX_MSGLEN);
      const msg = new Msg(body);
      for (;;) {
        if (msg.readcount > msg.cursize) { issue(offset, messageSeq, 'read past the end of the message'); return; }
        if (msg.readcount >= msg.cursize) return;
        const cmd = msg.readByte();
        if (cmd === SVC_EOF) return;
        switch (cmd) {
          case SVC_NOP: break;
          case SVC_SERVERCOMMAND: readServerCommand(msg, messageSeq); break;
          case SVC_GAMESTATE: readGamestate(msg, offset, messageSeq); break;
          case SVC_SNAPSHOT: readSnapshot(msg, offset, messageSeq); break;
          case SVC_CONFIGSTRING: {
            const index = msg.readShort(), value = msg.readString();
            stats.configstrings++;
            if (visitor.onConfigstring) visitor.onConfigstring({ index, value, serverTime: cl.lastSnap ? cl.lastSnap.serverTime : null });
            break;
          }
          case SVC_DOWNLOAD:
            issue(offset, messageSeq, 'svc_download in a demo - rest of the message skipped');
            return;
          default:
            issue(offset, messageSeq, 'illegible server message ' + cmd + ' at byte ' + (msg.readcount - 1) + ' - rest skipped');
            return;
        }
        if (msg.overflowed) { stats.overflows++; issue(offset, messageSeq, 'message overflow after svc ' + cmd); return; }
      }
    }

    function readServerCommand(msg, messageSeq) {
      const seq = msg.readLong();
      const text = msg.readString();
      if (cl.commandSeq >= seq) { stats.serverCommandsRepeated++; return; }
      cl.commandSeq = seq;
      stats.serverCommands++;
      if (visitor.onServerCommand) visitor.onServerCommand({ seq, text, serverTime: cl.lastSnap ? cl.lastSnap.serverTime : null, messageSeq });
    }

    function readGamestate(msg, offset, messageSeq) {
      cl.commandSeq = msg.readLong();
      const configstrings = new Map();
      cl.baselines = new Map();
      for (;;) {
        const cmd = msg.readByte();
        if (cmd === SVC_EOF) break;
        if (cmd === SVC_CONFIGSTRING) {
          const i = msg.readShort();
          if (i < 0 || i >= MAX_CONFIGSTRINGS) throw new DemoError('configstring index ' + i + ' out of range');
          configstrings.set(i, msg.readString());
        } else if (cmd === SVC_BASELINE) {
          const num = msg.readBits(10);
          const es = D.readDeltaEntity(msg, null, num);
          if (es) cl.baselines.set(num, es);
        } else {
          throw new DemoError('bad command byte ' + cmd + ' in the gamestate');
        }
        if (msg.overflowed) throw new DemoError('gamestate overflow');
      }
      const clientNum = msg.readLong();
      const checksumFeed = msg.readLong();
      // a new gamestate: no snapshot before it can be a delta source any more
      cl.snapshots.fill(null);
      cl.gamestateSeen = true;
      stats.gamestates++;
      if (visitor.onGamestate) visitor.onGamestate({ offset, messageSeq, commandSeq: cl.commandSeq, configstrings, baselines: cl.baselines, clientNum, checksumFeed });
    }

    function readSnapshot(msg, offset, messageNum) {
      const serverTime = msg.readLong();
      const deltaByte = msg.readByte();
      const deltaNum = deltaByte ? messageNum - deltaByte : -1;
      const snapFlags = msg.readByte();
      let old = null, valid = false;
      if (deltaNum <= 0) valid = true;
      else {
        old = cl.snapshots[deltaNum & PACKET_MASK];
        if (old && old.messageNum === deltaNum) valid = true;
        else old = null;
      }
      const ps = D.readDeltaPlayerstate(msg, old ? old.ps : null);
      // packet entities
      const entities = [];
      const oldEnts = old ? old.entities : [];
      let oi = 0;
      let oldnum = oi < oldEnts.length ? oldEnts[oi][0] : 99999;
      for (;;) {
        const newnum = msg.readBits(10);
        if (newnum === ENTITYNUM_NONE || msg.overflowed) break;
        while (oldnum < newnum) {
          entities.push(oldEnts[oi]);
          oi++; oldnum = oi < oldEnts.length ? oldEnts[oi][0] : 99999;
        }
        if (oldnum === newnum) {
          const es = D.readDeltaEntity(msg, oldEnts[oi], newnum);
          if (es) entities.push(es);
          oi++; oldnum = oi < oldEnts.length ? oldEnts[oi][0] : 99999;
        } else {
          const es = D.readDeltaEntity(msg, cl.baselines.get(newnum) || null, newnum);
          if (es) entities.push(es);
        }
      }
      while (oldnum !== 99999) {
        entities.push(oldEnts[oi]);
        oi++; oldnum = oi < oldEnts.length ? oldEnts[oi][0] : 99999;
      }
      // packet clients (delta base: the previous frame, else the zero state)
      const clients = [];
      const oldCl = old ? old.clients : [];
      let ci = 0;
      let oldc = ci < oldCl.length ? oldCl[ci][0] : 99999;
      while (!msg.overflowed && msg.readBit()) {
        const newnum = msg.readBits(6);
        while (oldc < newnum) {
          clients.push(oldCl[ci]);
          ci++; oldc = ci < oldCl.length ? oldCl[ci][0] : 99999;
        }
        if (oldc === newnum) {
          const cs = D.readDeltaClient(msg, oldCl[ci], newnum);
          if (cs) clients.push(cs);
          ci++; oldc = ci < oldCl.length ? oldCl[ci][0] : 99999;
        } else {
          const cs = D.readDeltaClient(msg, null, newnum);
          if (cs) clients.push(cs);
        }
      }
      while (oldc !== 99999) {
        clients.push(oldCl[ci]);
        ci++; oldc = ci < oldCl.length ? oldCl[ci][0] : 99999;
      }
      if (msg.overflowed) valid = false;
      if (!valid) { stats.snapshotsDropped++; return; }
      const snap = { messageNum, serverTime, snapFlags, deltaNum, ps, entities, clients };
      cl.snapshots[messageNum & PACKET_MASK] = snap;
      cl.lastSnap = snap;
      stats.snapshots++;
      stats.entityStates += entities.length;
      if (visitor.onSnapshot) visitor.onSnapshot(snap);
    }
  }

  C2.demo = { parseDemo, DemoError, ENTITYNUM_NONE };
});
