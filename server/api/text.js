/**
 * POST /v1/text/clean — speech-ready text cleaning as a standalone service.
 *
 * Request:  { text: string, mode?: 'regex' | 'llm' }   (default mode: 'regex')
 * Response: { text: string, chars_before: number, chars_after: number }
 *
 * Clients that need the exact text that will be spoken (e.g. for
 * text/audio alignment) call this first, then send the returned text to
 * /v1/audio/speech with extra_body.clean unset (no server-side cleaning).
 * Clients that don't need the text just pass extra_body.clean: true.
 */
import { logger } from '../logger.js';
import { cleanMarkdown, cleanMarkdownLLM } from '../markdown-clean.js';

const log = logger.child('text-clean');

export function registerTextRoutes(app) {
  app.post('/v1/text/clean', async (request, reply) => {
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};

    if (typeof body.text !== 'string' || body.text.length === 0) {
      return reply.code(400).send({
        error: {
          message: "Missing required field: 'text'",
          type: 'invalid_request_error',
          code: 'missing_text',
          param: 'text',
        },
      });
    }

    const mode = body.mode ?? 'regex';
    if (mode !== 'regex' && mode !== 'llm') {
      return reply.code(400).send({
        error: {
          message: `Invalid mode: ${JSON.stringify(mode)} — must be 'regex' or 'llm'`,
          type: 'invalid_request_error',
          code: 'invalid_mode',
          param: 'mode',
        },
      });
    }

    const before = body.text.length;
    const cleaned = mode === 'llm'
      ? await cleanMarkdownLLM(body.text)
      : cleanMarkdown(body.text);

    log.info('text cleaned', { mode, before, after: cleaned.length });

    return {
      text: cleaned,
      chars_before: before,
      chars_after: cleaned.length,
    };
  });
}
