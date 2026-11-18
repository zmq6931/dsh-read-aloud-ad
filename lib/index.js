// dsh-read-aloud-ad — host half.
//
// A small HTTP bridge from the browser half to Microsoft Edge's read-aloud
// speech service, which voices Mandarin with `zh-CN-XiaoxiaoNeural` (晓晓).
// No API key is needed; the browser never talks to the service itself, so the
// page's CSP/origin policy stays untouched and the audio is fetched from the
// local loopback origin.
//
// Routes (fenced to loopback / trusted hosts, same-origin only):
//   GET  /read-aloud/status      -> voice, engine, and limits
//   POST /read-aloud/synthesize  { text } -> { ok, audioBase64, bytes, cached }
//   POST /read-aloud/client-hello { ... } -> presence diagnostics
//   GET  /read-aloud/debug       -> presence + cache diagnostics
//
// Optional config: $DSH_HOME/read-aloud.json
//   { "voice": "zh-CN-XiaoxiaoNeural", "maxChars": 8000 }

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { synthesizeWithRetry } from './edge-tts.js';

export const name = 'dsh-read-aloud-ad';

/** The browser route prefix owned by this plugin. */
const API_PREFIX = '/read-aloud';
/** Default voice: Mandarin Xiaoxiao. */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** Default accepted text length per request. */
const DEFAULT_MAX_CHARS = 8000;
/** One request may need a handshake, a synthesis, and one retry. */
const SYNTHESIS_TIMEOUT_MS = 45_000;
/** Maximum request body (UTF-8 JSON with one text field). */
const MAX_BODY_BYTES = 256 * 1024;
/** Cached MP3 payloads kept for replays of the same text. */
const CACHE_MAX_ENTRIES = 32;
/** Cached MP3 payload bytes kept in memory. */
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
/** Simultaneous upstream syntheses. */
const MAX_INFLIGHT = 3;

export const inject = ['webServer'];

function configPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'read-aloud.json');
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveVoice(config) {
  return typeof config.voice === 'string' && /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/.test(config.voice)
    ? config.voice
    : DEFAULT_VOICE;
}

function resolveMaxChars(config) {
  return Number.isInteger(config.maxChars) && config.maxChars >= 200 && config.maxChars <= 40_000
    ? config.maxChars
    : DEFAULT_MAX_CHARS;
}

/** Presence diagnostics: proves the browser half actually executed. */
const diagnostics = {
  clientHelloCount: 0,
  lastClientHelloAt: null,
  lastClientInfo: null,
  synthesisCount: 0,
  lastSynthesisAt: null,
  lastError: null,
};

// ── trust fence ─────────────────────────────────────────────────────────────
// Loopback is always allowed; extra authorities may come from trustedHosts.

function parseAuthority(authority) {
  if (typeof authority !== 'string' || authority === '' || /[\s\\/@?#]/.test(authority)) return undefined;
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

function isTrustedRequest(req, trustedHosts) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function buildTrustedHosts(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (parseAuthority(entry) === undefined) {
      console.warn('[dsh-read-aloud-ad] ignoring invalid trustedHosts entry:', JSON.stringify(String(entry)));
      continue;
    }
    out.push(entry);
  }
  return out;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function writeJson(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    body = '{"ok":false,"error":{"code":"internal","message":"internal error"}}';
    status = 500;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function errorBody(code, message) {
  return { ok: false, error: { code, message } };
}

/** Read and JSON.parse a request body with a hard size cap. */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        req.removeAllListeners('data');
        req.resume();
        finish({ tooLarge: true });
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(parsed !== null && typeof parsed === 'object' ? parsed : { invalid: true });
      } catch {
        finish({ invalid: true });
      }
    });
    req.on('error', () => finish({ invalid: true }));
    req.on('aborted', () => finish({ invalid: true }));
  });
}

// ── synthesis cache ─────────────────────────────────────────────────────────

const cache = new Map();
let cacheBytes = 0;
const inflight = new Map();
let active = 0;
const waiting = [];

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(key, audio) {
  if (cache.has(key)) return;
  cache.set(key, audio);
  cacheBytes += audio.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= dropped === undefined ? 0 : dropped.length;
  }
}

async function acquireSlot() {
  if (active < MAX_INFLIGHT) {
    active += 1;
    return;
  }
  await new Promise((resolve) => { waiting.push(resolve); });
  active += 1;
}

function releaseSlot() {
  active -= 1;
  const next = waiting.shift();
  if (next !== undefined) next();
}

/** Synthesize one text, sharing concurrent identical requests and caching the result. */
async function synthesizeText(text, voice) {
  const key = createHash('sha256').update(`${voice}\u0000${text}`).digest('hex');
  const cached = cacheGet(key);
  if (cached !== undefined) return { audio: cached, cached: true };
  const pending = inflight.get(key);
  if (pending !== undefined) return { audio: await pending, cached: false };
  const task = (async () => {
    await acquireSlot();
    try {
      return await synthesizeWithRetry({
        text,
        voice,
        timeoutMs: SYNTHESIS_TIMEOUT_MS,
      });
    } finally {
      releaseSlot();
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  const audio = await task;
  cachePut(key, audio);
  return { audio, cached: false };
}

// ── routing ─────────────────────────────────────────────────────────────────

function routeOf(req) {
  let pathname = API_PREFIX;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    /* keep the prefix */
  }
  if (pathname === API_PREFIX) return '/';
  if (!pathname.startsWith(`${API_PREFIX}/`)) return undefined;
  return pathname.slice(API_PREFIX.length);
}

async function handleApi(req, res, ctx, trustedHosts) {
  if (!isTrustedRequest(req, trustedHosts)) {
    writeJson(res, 403, errorBody('forbidden', 'forbidden'));
    return;
  }
  const route = routeOf(req);
  if (route === undefined) {
    writeJson(res, 404, errorBody('not-found', 'not found'));
    return;
  }
  const config = readConfig();
  const voice = resolveVoice(config);
  const maxChars = resolveMaxChars(config);

  if (route === '/status' && req.method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      voice,
      engine: 'edge-tts',
      maxChars,
      cacheEntries: cache.size,
    });
    return;
  }

  if (route === '/client-hello' && req.method === 'POST') {
    const body = await readJsonBody(req, 16 * 1024);
    diagnostics.clientHelloCount += 1;
    diagnostics.lastClientHelloAt = new Date().toISOString();
    diagnostics.lastClientInfo = body && !body.invalid && !body.tooLarge ? body : null;
    writeJson(res, 200, { ok: true });
    return;
  }

  if (route === '/debug' && req.method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      ...diagnostics,
      cacheEntries: cache.size,
      cacheBytes,
      configPath: configPath(),
    });
    return;
  }

  if (route === '/synthesize' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.tooLarge) {
      writeJson(res, 413, errorBody('payload-too-large', 'text is too large'));
      return;
    }
    if (body.invalid || typeof body.text !== 'string') {
      writeJson(res, 400, errorBody('invalid-request', 'missing text'));
      return;
    }
    const text = body.text.replace(/\s+/g, ' ').trim();
    if (text.length === 0) {
      writeJson(res, 400, errorBody('empty-text', 'text is empty'));
      return;
    }
    if (text.length > maxChars) {
      writeJson(res, 413, errorBody('text-too-long', `text exceeds ${maxChars} characters`));
      return;
    }
    try {
      const started = Date.now();
      const { audio, cached } = await synthesizeText(text, voice);
      diagnostics.synthesisCount += 1;
      diagnostics.lastSynthesisAt = new Date().toISOString();
      writeJson(res, 200, {
        ok: true,
        audioBase64: audio.toString('base64'),
        bytes: audio.length,
        mime: 'audio/mpeg',
        cached,
        ms: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.lastError = { at: new Date().toISOString(), message };
      console.warn('[dsh-read-aloud-ad] synthesis failed:', message);
      writeJson(res, 502, errorBody('synthesis-failed', 'speech synthesis failed'));
    }
    return;
  }

  writeJson(res, 404, errorBody('not-found', 'not found'));
}

/** Host loader entry: mount the fenced bridge. */
export function apply(ctx) {
  const startup = typeof ctx.get === 'function' ? ctx.get('webStartup') : undefined;
  const trustedHosts = buildTrustedHosts(startup ? startup.trustedHosts : undefined);

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        await handleApi(req, res, ctx, trustedHosts);
      } catch (error) {
        console.error('[dsh-read-aloud-ad] request failed:', error && error.stack ? error.stack : error);
        if (!res.headersSent) writeJson(res, 500, errorBody('internal', 'internal error'));
        else res.end();
      }
    },
  }), 'dsh-read-aloud-ad: routes');
}
