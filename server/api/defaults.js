/**
 * Server-side generation defaults API.
 *
 *   GET    /v1/defaults            → all engine defaults
 *   GET    /v1/defaults/:engine    → one engine's defaults (404 if none)
 *   PUT    /v1/defaults/:engine    → save { voice?, speed?, extra_body? }
 *   DELETE /v1/defaults/:engine    → clear
 *
 * The speech relay merges these into requests that omit the field.
 */
import * as defaults from '../defaults.js';

export function registerDefaultsRoutes(app) {
  app.get('/v1/defaults', async () => defaults.get());

  app.get('/v1/defaults/:engine', async (req, reply) => {
    const d = defaults.get(req.params.engine);
    if (!d) return reply.code(404).send({ error: { message: `No defaults saved for '${req.params.engine}'`, type: 'invalid_request_error' } });
    return { engine: req.params.engine, ...d };
  });

  app.put('/v1/defaults/:engine', async (req, reply) => {
    try {
      const d = defaults.set(req.params.engine, req.body);
      return { engine: req.params.engine, ...d };
    } catch (err) {
      return reply.code(400).send({ error: { message: err.message, type: 'invalid_request_error' } });
    }
  });

  app.delete('/v1/defaults/:engine', async (req) => {
    return { engine: req.params.engine, removed: defaults.remove(req.params.engine) };
  });
}
