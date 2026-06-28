/**
 * Config loader — merges config.json (service config) with .env (secrets).
 * Missing required values fail fast at startup.
 *
 * nLogger-compatible: this module logs nothing itself; the caller logs load results.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

/** Parse a .env file into a plain object. Zero dependency. */
function parseEnv(path) {
  const text = (() => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  })();
  if (text === null) return {};

  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Read and parse config.json. Fails fast if missing or invalid. */
function loadConfigJson(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text);
}

// ── Load sources ────────────────────────────────────────────────────────────

// Process env wins over .env file wins over config.json.
const envFile = parseEnv(resolve(PROJECT_ROOT, '.env'));
const configJson = loadConfigJson(resolve(PROJECT_ROOT, 'config.json'));

// Apply .env values to process.env so they propagate to spawned children
// (engine workers). Without this, NSPEECH_STT_URL and similar .env-only
// settings never reach the Python workers. process.env takes precedence
// (already-set values are NOT overwritten).
for (const [key, value] of Object.entries(envFile)) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

/** Pick the first defined value from the given sources. */
function pick(key, ...sources) {
  for (const src of sources) {
    if (src && src[key] !== undefined && src[key] !== '') return src[key];
  }
  return undefined;
}

// ── Resolved config ─────────────────────────────────────────────────────────

export const config = {
  projectRoot: PROJECT_ROOT,

  host: pick('NSPEECH_HOST', process.env, envFile) ?? configJson.host ?? '127.0.0.1',
  port: parseInt(pick('NSPEECH_PORT', process.env, envFile) ?? configJson.port ?? 8000, 10),

  defaultEngine: configJson.default_engine ?? 'kokoro',
  currentEngine: configJson.default_engine ?? 'kokoro',

  nvoiceUrl: configJson.nvoice_url ?? null,
  voiceDir: configJson.voice_dir ?? 'venv/{engine}/voices',
  modelDir: configJson.model_dir ?? 'venv/{engine}/models',

  logLevel: (pick('NSPEECH_LOG_LEVEL', process.env, envFile) ?? configJson.log_level ?? 'INFO').toUpperCase(),
  logDir: pick('NSPEECH_LOG_DIR', process.env, envFile) ?? 'logs',

  // Secrets from .env only (never committed in config.json)
  openaiApiKey: envFile.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
  elevenlabsApiKey: envFile.ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? null,

  // Static dirs
  webDir: resolve(PROJECT_ROOT, 'web'),
  libDir: resolve(PROJECT_ROOT, 'lib'),

  // nVideo / FFmpeg — for PCM→MP3 transcoding in the relay layer.
  // The ffmpeg binary ships with the nVideo submodule.
  ffmpegPath: resolve(PROJECT_ROOT, 'lib', 'nvideo', 'deps', 'win', 'bin', 'ffmpeg.exe'),
};

// ── Validate required paths ─────────────────────────────────────────────────

import { existsSync } from 'node:fs';

if (!existsSync(config.webDir)) {
  throw new Error(`web directory not found: ${config.webDir}`);
}
