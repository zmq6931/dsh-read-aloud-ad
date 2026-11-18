/**
 * drm.mjs -- dependency-free ES module port of edge-tts `drm.py` (v2 DRM).
 *
 * Produces the Microsoft Edge TTS `Sec-MS-GEC` v2 token, format
 * "<16 uppercase hex>-<64 uppercase hex>", exactly as the Python reference
 * `generate_sec_ms_gec_v2()` does.
 *
 * Everything is mirrored 1:1 from the Python source; the comments name the
 * Python function/behaviour being ported. All 32-bit words are kept in
 * unsigned 32-bit form with `>>> 0`, every 32-bit multiply uses Math.imul
 * (never a float product), and 64-bit length packing uses writeBigUInt64BE.
 * The Python `x * 0x100000001` fake-64-bit ROTR trick is rewritten as an
 * ordinary 32-bit `rotr()` (the low 32 bits are identical).
 */

import { Buffer } from "node:buffer";

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const WIN_EPOCH = 11644473600;
export const S_TO_NS = 1e9;

/** Exact 32-bit multiply (Math.imul), as an unsigned word. */
const mul32 = (a, b) => Math.imul(a, b) >>> 0;

/** Rotate a 32-bit value right (used where Python writes `>> n` on x*(2^32+1)). */
const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;

/** _rol16(): rotate a 32-bit value left by 16 bits. */
const rol16 = (value) => ((value << 16) | (value >>> 16)) >>> 0;

/** _sigma0(): SHA-256 small sigma zero = ROTR7 ^ ROTR18 ^ SHR3. */
const sigma0 = (value) => (rotr(value, 7) ^ rotr(value, 18) ^ (value >>> 3)) >>> 0;

/** _sigma1(): SHA-256 small sigma one = ROTR17 ^ ROTR19 ^ SHR10. */
const sigma1 = (value) => (rotr(value, 17) ^ rotr(value, 19) ^ (value >>> 10)) >>> 0;

// FIPS 180-4 initial hash values.
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

// Precomputed midstate for the 57-byte token prefix (the tick digits).
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];

// Precomputed message-schedule words 0..13 for the same prefix.
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

/** _words_le4_even(): split into little-endian u32 words, zero-padded to an even count. */
function wordsLe4Even(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = pad === 0 ? data : Buffer.concat([data, Buffer.alloc(pad)]);
  if (padded.length === 0) return [];
  const words = [];
  for (let offset = 0; offset < padded.length; offset += 4) words.push(padded.readUInt32LE(offset));
  if (words.length % 2 === 1) words.push(0);
  return words;
}

/**
 * _sha256_rounds(): run SHA-256 rounds, optionally resuming inside the first
 * block (firstRound = 14 for the precomputed midstate path).
 *
 * The Python version unrolls rounds in groups of eight and renames the working
 * registers instead of moving them; that is only a speed trick, so the plain
 * rotating assignment is used here. The `* 0x100000001` / `>> n` pairs are the
 * same rotation applied to a duplicated 32-bit word, so `rotr()` is exact.
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let index = firstRound; index < 64; index++) {
    const bigSigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const choose = (g ^ (e & (f ^ g))) >>> 0;
    const t1 = (h + bigSigma1 + choose + constants[index] + words[index]) >>> 0;
    const bigSigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const majority = ((a & b) | (c & (a | b))) >>> 0;
    const t2 = (bigSigma0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

/** _expand_sha256_schedule(): expand message-schedule words to 64 entries. */
function expandSha256Schedule(words, firstWord = 16) {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2];
    const y = words[index - 15];
    words.push(
      (sigma1(x) + words[index - 7] + sigma0(y) + words[index - 16]) >>> 0,
    );
  }
}

/** _sha256_init(): precomputed initial state for the first seven token bytes. */
function sha256Init(prefix) {
  const words = new Array(14).fill(0);
  words.push(prefix.readUIntBE(0, 3)); // int.from_bytes(data[:3], "big")
  words.push(prefix.readUIntBE(3, 4)); // int.from_bytes(data[3:7], "big")
  for (let index = 16; index <= 29; index++) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value +=
        index === 16
          ? (sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT)
          : sigma1(words[index - 2]);
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      value +=
        index === 29
          ? (sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT)
          : sigma0(words[index - 15]);
    }
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
      0,
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

/** _sha256_digest(): SHA-256 of the token data using the precomputed midstate. */
function sha256Digest(data) {
  if (data.length < 7) throw new RangeError("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  // Python: b"\x00" * ((55 - length) % 64); Python modulo is always >= 0.
  const zeroCount = (((55 - length) % 64) + 64) % 64;
  const lengthBytes = Buffer.alloc(8);
  lengthBytes.writeBigUInt64BE(BigInt(length * 8)); // struct.pack(">Q", length * 8)
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(zeroCount), lengthBytes]);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(offset + i * 4)); // struct.unpack(">16I")
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const digest = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) digest.writeUInt32BE(state[i], i * 4); // struct.pack(">8I", *state)
  return digest;
}

/** _cs64_digest(): CS64 mixing of the token data keyed by the SHA-256 digest. */
function cs64Digest(data, digest) {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0; // struct.unpack_from("<II", digest)
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];

  const terms = [];
  const offsets = [];
  for (let index = 0; index < CS64_COEFFICIENTS.length; index++) {
    const [coefficient, offset] = CS64_COEFFICIENTS[index];
    terms.push(mul32(coefficient, factors[index % 2]));
    offsets.push(offset);
  }
  const words = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]));
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const even = index % 2 === 0;
    let term = mul32(word, even ? keyA : keyB);
    let offset = mul32(rol16(word), even ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term = (term + mul32(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];
    let t = rol16((offsets[index] + x) >>> 0);
    let q = mul32(t, 0x76f50f34);
    swapAcc = (swapAcc + ((mul32(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[index + 1] + y) >>> 0);
    q = mul32(t, 0x1881ce3c);
    swapLast = (mul32(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul32(state, keyA) + x) >>> 0;
    state = mul32(rol16(state), 0xcf98b111);
    state = mul32(rol16(state), 0x87085b9f);
    state = mul32(rol16(state), 0x12ceb96d);
    state = mul32(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;
    t = (mul32(state, keyB) + y) >>> 0;
    t = mul32(rol16(t), 0xa27416f5);
    t = mul32(rol16(t), 0xd38396ff);
    state = mul32(rol16(mul32(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

/** _token_hash(): "<cs64 hex>-<sha256 hex>", uppercase. */
function tokenHash(data) {
  const digest = sha256Digest(data);
  const [low, high] = cs64Digest(data, digest);
  const cs64Bytes = Buffer.alloc(8);
  cs64Bytes.writeUInt32LE(low, 0); // struct.pack("<II", *_cs64_digest(...))
  cs64Bytes.writeUInt32LE(high, 4);
  return [cs64Bytes.toString("hex").toUpperCase(), digest.toString("hex").toUpperCase()];
}

/**
 * Python's float `%`: fmod result adjusted into the divisor's sign, exactly what
 * CPython's float_rem does. For the (positive) timestamps used here this is the
 * plain JS `%`, but the adjustment keeps negative inputs faithful.
 */
function pyFloatMod(value, divisor) {
  let remainder = value % divisor;
  if (remainder !== 0 && remainder < 0 !== divisor < 0) remainder += divisor;
  return remainder;
}

/**
 * generate_sec_ms_gec_v2(): the v2 Sec-MS-GEC token.
 *
 * @param {number} [unixTimestamp] seconds since the Unix epoch (may be fractional);
 *   omitted -> Date.now() / 1000.
 * @returns {string} "<16 uppercase hex>-<64 uppercase hex>"
 */
export function generateSecMsGecV2(unixTimestamp) {
  // Python: `if unix_timestamp is None: ticks = DRM.get_unix_timestamp()`.
  let ticks = unixTimestamp === undefined || unixTimestamp === null
    ? Date.now() / 1000
    : Number(unixTimestamp);
  ticks += WIN_EPOCH;
  ticks -= pyFloatMod(ticks, 300);
  ticks *= S_TO_NS / 100; // == 1e7 exactly; same IEEE-754 double op as Python

  // f"{ticks:.0f}": the value here is integral (a multiple of 300 scaled by 1e7 and
  // rounded to the nearest double), so it can never be an exact .5 tie; BigInt()
  // renders the exact value of the double, never a float approximation of it.
  const tickDigits = BigInt(Math.round(ticks)).toString();
  const data = Buffer.from(tickDigits + TRUSTED_CLIENT_TOKEN, "ascii");
  const [cs64, sha256] = tokenHash(data);
  return `${cs64}-${sha256}`;
}

export default generateSecMsGecV2;
