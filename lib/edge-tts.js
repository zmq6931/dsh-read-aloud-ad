// Edge TTS transport for dsh-read-aloud.
//
// Microsoft Edge's read-aloud endpoint speaks a small WebSocket protocol:
//   wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
// A connection is authenticated by a time-derived `Sec-MS-GEC` token (DRM v2)
// and carries one `speech.config` message followed by one `ssml` message. The
// server answers with binary frames (2-byte header length + header + MP3
// payload) and one text frame whose `Path:` is `turn.end`.
//
// This module implements the RFC 6455 client by hand over node:https so that
// every handshake header matches the Edge client; no npm dependency is used.

import crypto from 'node:crypto';
import https from 'node:https';
import { generateSecMsGecV2 } from './drm.js';

const HOST = 'speech.platform.bing.com';
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const BASE_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
};

/** X-Timestamp format used by the Edge protocol. */
function timestamp() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Build the SSML body for one request. */
function buildSsml({ text, voice, rate, pitch, volume }) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
    + `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>`
    + `${escapeXml(text)}</prosody></voice></speak>`;
}

/** Encode one client frame (always masked, as the RFC requires). */
function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = crypto.randomBytes(4);
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Minimal RFC 6455 connection: server frames arrive unmasked, ours go out masked. */
class Connection {
  constructor(socket, head) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onText = null;
    this.onBinary = null;
    this.onClose = null;
    this.onError = null;
    socket.setNoDelay(true);
    socket.on('data', chunk => this.feed(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', error => this.fail(error));
    if (head && head.length > 0) this.feed(head);
  }

  feed(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.closed || this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          this.fail(new Error('Edge TTS frame exceeds the size limit'));
          return;
        }
        length = Number(big);
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (maskKey !== null) {
        const copy = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) copy[index] = payload[index] ^ maskKey[index % 4];
        payload = copy;
      }
      this.dispatch(fin, opcode, payload);
    }
  }

  dispatch(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.finish();
      return;
    }
    if (opcode === 0x9) {
      this.write(frame(0x0a, payload));
      return;
    }
    if (opcode === 0x0a) return;
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) this.emitMessage(this.fragmentOpcode, Buffer.concat(this.fragments));
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      this.emitMessage(opcode, payload);
    }
  }

  emitMessage(opcode, payload) {
    try {
      if (opcode === 0x1 && this.onText) this.onText(payload.toString('utf8'));
      else if (opcode === 0x2 && this.onBinary) this.onBinary(payload);
    } catch (error) {
      this.fail(error);
    }
  }

  write(data) {
    if (this.closed) return;
    try {
      this.socket.write(data);
    } catch (error) {
      this.fail(error);
    }
  }

  send(text) {
    if (this.closed) throw new Error('Edge TTS connection is closed');
    this.write(frame(0x1, text));
  }

  close() {
    if (this.closed) return;
    this.write(frame(0x8, Buffer.alloc(0)));
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    if (this.onClose) this.onClose();
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    if (this.onError) this.onError(error);
  }
}

/** Open one authenticated Edge TTS websocket. */
function connect({ timeoutMs = 15000 } = {}) {
  const query = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    'Sec-MS-GEC': generateSecMsGecV2(),
    'Sec-MS-GEC-Version': `2-${CHROMIUM_FULL_VERSION}`,
    ConnectionId: randomHex(16),
  });
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request({
      host: HOST,
      path: `${PATH}?${query.toString()}`,
      method: 'GET',
      headers: {
        ...BASE_HEADERS,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error('handshake timed out'));
    }, timeoutMs);
    request.on('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      const expected = crypto.createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('handshake returned an invalid accept key'));
        return;
      }
      resolve(new Connection(socket, head));
    });
    request.on('response', (response) => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      response.resume();
      if (settled) return;
      settled = true;
      reject(new Error(`handshake rejected with HTTP ${status}`));
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end();
  });
}

/**
 * Synthesize one text chunk to MP3 bytes.
 * @param {object} options - text, voice, prosody, timeouts.
 * @returns {Promise<Buffer>} concatenated MP3 frames
 */
export async function synthesizeSpeech({
  text,
  voice = 'zh-CN-XiaoxiaoNeural',
  rate = '+0%',
  pitch = '+0Hz',
  volume = '+0%',
  timeoutMs = 30000,
  handshakeTimeoutMs = 15000,
}) {
  const connection = await connect({ timeoutMs: handshakeTimeoutMs });
  const chunks = [];
  let total = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => settle(new Error('synthesis timed out')), timeoutMs);
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.onText = null;
      connection.onBinary = null;
      connection.onClose = null;
      connection.close();
      if (error) reject(error);
      else if (total === 0) reject(new Error('server returned no audio'));
      else resolve(Buffer.concat(chunks));
    };
    connection.onClose = () => settle(total > 0 ? null : new Error('connection closed before audio'));
    connection.onError = error => settle(error);
    connection.onText = (message) => {
      if (message.includes('Path:turn.end')) settle(null);
      else if (message.includes('Path:error')) settle(new Error('server reported a synthesis error'));
    };
    connection.onBinary = (payload) => {
      if (payload.length < 2) return;
      const headerLength = payload.readUInt16BE(0);
      if (payload.length < 2 + headerLength) return;
      const header = payload.subarray(2, 2 + headerLength).toString('utf8');
      if (!header.includes('Path:audio')) return;
      const audio = payload.subarray(2 + headerLength);
      chunks.push(audio);
      total += audio.length;
    };
    try {
      connection.send(
        `X-Timestamp:${timestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        }),
      );
      connection.send(
        `X-RequestId:${randomHex(16)}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp()}\r\nPath:ssml\r\n\r\n`
        + buildSsml({ text, voice, rate, pitch, volume }),
      );
    } catch (error) {
      settle(error);
    }
  });
}

/**
 * Synthesize with one automatic retry, for transient network or handshake failures.
 * @param {object} options - forwarded to {@link synthesizeSpeech}.
 * @returns {Promise<Buffer>} MP3 bytes
 */
export async function synthesizeWithRetry(options) {
  try {
    return await synthesizeSpeech(options);
  } catch (firstError) {
    await new Promise(resolve => setTimeout(resolve, 350));
    try {
      return await synthesizeSpeech(options);
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      const cause = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`${message} (first attempt: ${cause})`);
    }
  }
}
