/* Static Huffman decoding of CoD2 network messages (MSG_ReadBitsCompress).
 * The code table (257 codes incl. the NYT node, max. 11 bits, LSB first) is generated from the
 * engine's frequency table msg_hData by tools/gen_tables.py. */
C2.define('huffman', function (C2) {
  'use strict';
  let lut = null;
  let lutBits = 0;
  let scratch = null;                    // the decoded bytes of the message being read (decompress)

  function init() {
    const codes = C2.tables.HUFFMAN_CODES;
    let maxLen = 0;
    for (const [, len] of codes) maxLen = Math.max(maxLen, len);
    const size = 1 << maxLen;
    lut = new Uint16Array(size);          // (symbol << 5) | length
    for (let sym = 0; sym < codes.length; sym++) {
      const [code, len] = codes[sym];
      // the NYT node decodes to 256, which the engine stores as the byte 0
      const packed = ((sym & 255) << 5) | len;
      for (let i = code; i < size; i += 1 << len) lut[i] = packed;
    }
    lutBits = maxLen;
  }

  /**
   * Decode `length` bytes of `data` (Uint8Array) starting at `start`.
   * Returns a Uint8Array view of the decoded bytes. Mirrors MSG_ReadBitsCompress:
   * stops when the input bits run out or `maxOut` bytes were produced.
   * The view is of one buffer used for every message: it holds until the next call (the reader is done with a
   * message before it decodes the next one - a buffer per message was 60,000 short-lived arrays per demo).
   */
  function decompress(data, start, length, maxOut) {
    if (!lut) init();
    const size = Math.min(maxOut, length * 8 + 16);
    if (!scratch || scratch.length < size) scratch = new Uint8Array(Math.max(size, 16384));
    const out = scratch.subarray(0, size);
    const mask = (1 << lutBits) - 1;
    const end = start + length;
    const totalBits = length * 8;
    let acc = 0, have = 0, used = 0, pos = start, n = 0;
    const cap = out.length;
    while (used < totalBits && n < cap) {
      while (have < lutBits && pos < end) {
        acc |= data[pos++] << have;
        have += 8;
      }
      const packed = lut[acc & mask];
      const bits = packed & 31;
      if (used + bits > totalBits) break;   // trailing padding
      acc >>>= bits;
      have -= bits;
      used += bits;
      out[n++] = packed >> 5;
    }
    return out.subarray(0, n);
  }

  C2.huffman = { decompress };
});
