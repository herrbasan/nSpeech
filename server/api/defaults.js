/**
 * Server-side generation defaults API.
 *
 *   GET    /v1/defaults            → all engine defaults
 *   GET    /v1/defaults/:engine    → one engine's defaults (404 if none)
 *   PUT    /v1/defaults/:engine    → save { voice?, speed?, extra_body? }
 *   DELETE /v1/defaults/:engine    → clear
 *
 * The speech relay merges these into requests that omit the field.
 *
 * `:engine` is normalised through `engineNameFor`, the same function the relay
 * uses to look the entry up. Without it a client could only ever save under the
 * exact canonical name: the dashboard's cloud pages sent their model slug
 * (`minimax_speech_2_8_turbo`), the relay looked up `minimax`, and every saved
 * cloud dial-in was silently inert — the 2026-09-10 bug, still live until
 * 2026-10-24.
 */
import * as defaults from '../defaults.js';
import { engineNameFor } from '../engine/manager.js';

/** Canonical engine name for any accepted selector (slug, alias, "nspeech", bare name). */
export function engineKey(param) {
  const key = engineNameFor(param);
  if (!key) {
    throw Object.assign(new Error(`cannot resolve engine from ${JSON.stringify(param)}`),
      { status: 400, type: 'invalid_request_error', code: 'unknown_engine' });
  }
  return key;
}

export function registerDefaultsRoutes(app) {
  app.get('/v1/defaults', async () => defaults.get());

  app.get('/v1/defaults/:engine', async (req, reply) => {
    const key = engineKey(req.params.engine);
    const d = defaults.get(key);
    if (!d) return reply.code(404).send({ error: { message: `No defaults saved for '${key}'`, type: 'invalid_request_error' } });
    return { engine: key, ...d };
  });

  app.put('/v1/defaults/:engine', async (req, reply) => {
    try {
      const key = engineKey(req.params.engine);
      const d = defaults.set(key, req.body);
      return { engine: key, ...d };
    } catch (err) {
      return reply.code(err.status || 400).send({ error: { message: err.message, type: 'invalid_request_error', code: err.code } });
    }
  });

  app.delete('/v1/defaults/:engine', async (req) => {
    const key = engineKey(req.params.engine);
    return { engine: key, removed: defaults.remove(key) };
  });
}
