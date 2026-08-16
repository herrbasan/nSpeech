/**
 * Markdown → speech-ready plain text.
 *
 * Two modes:
 *   extra_body.markdown: true   — regex-based, fast, deterministic
 *   extra_body.markdown: 'llm'  — LLM pass via local gateway (Gemma 4),
 *                                 handles emphasis, metadata, restructuring.
 *                                 Fails loud if gateway is unreachable.
 *
 * The regex path strips YAML frontmatter, images, code blocks, formatting.
 * Headers get a trailing period so duration estimators insert a pause.
 */

import { config } from './config.js';
import { logger } from './logger.js';

const log = logger.child('markdown-clean');

/**
 * Regex-based markdown cleanup. Fast, deterministic, no external calls.
 * @param {string} text — raw markdown
 * @returns {string} plain text suitable for TTS
 */
export function cleanMarkdown(text) {
  let t = text;

  // YAML frontmatter
  t = t.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

  // Images (drop entirely), links (keep link text)
  t = t.replace(/!\[.*?\]\(.+?\)/g, '');
  t = t.replace(/\[(.+?)\]\(.+?\)/g, '$1');

  // Bare URLs — drop (reading "aich-tee-tee-pee" is never right)
  t = t.replace(/https?:\/\/\S+/g, '');

  // Bold — strip markers (structural emphasis, not vocal stress)
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');

  // Italic — vocal stress. Convert to em-dash prefix for prosodic pause.
  // "the answer is *you*" → "the answer is — you"
  t = t.replace(/\*(.+?)\*/g, '— $1');
  t = t.replace(/(?<!\w)_(.+?)_(?!\w)/g, '— $1');

  // Code blocks (drop — reads poorly as TTS), inline code (keep content)
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`(.+?)`/g, '$1');

  // Headers: strip '#' prefix, add trailing period if missing
  t = t.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _hashes, title) => {
    const trimmed = title.trim();
    return /[.!?…]$/.test(trimmed) ? trimmed + '\n' : trimmed + '.\n';
  });

  // Horizontal rules → paragraph break
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, '\n');

  // Blockquotes: strip '>' prefix
  t = t.replace(/^\s*>\s?/gm, '');

  // Unordered/ordered list markers → plain line
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');

  // HTML comments and tags
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // Normalize dashes: -- → —
  t = t.replace(/--/g, '—');

  // Collapse 3+ consecutive newlines
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

const LLM_CLEAN_PROMPT = `You are a text preprocessor for text-to-speech. Rewrite the input for spoken delivery.

Rules:
- Output ONLY the rewritten text. No commentary, no preamble.
- Strip all markdown formatting (headers, bold, italic, links, images, code blocks).
- Strip YAML frontmatter, metadata, bylines, dates, tags — anything a listener wouldn't want read aloud.
- Strip URLs, footnote markers, HTML tags.
- Headers become plain sentences with a period.
- Italic/emphasized words (*word*) carry vocal stress — render them with an em-dash: "the answer is — you".
- Bold text (**word**) is structural — just remove the markers.
- Lists become flowing sentences or separate lines without markers.
- Code blocks: drop entirely (they read poorly as speech).
- Write numbers and abbreviations as spoken words where natural ("2026" → "twenty twenty-six" for years, "AI" stays as-is).
- Use em-dashes (—) for natural pauses, ellipses (…) for longer ones.
- Preserve the author's voice and sentence structure. Do not summarize, shorten, or editorialize.
- Keep paragraph breaks (double newline).

Input:`;

/**
 * LLM-based markdown cleanup via the local LLM Gateway.
 * @param {string} text — raw markdown
 * @returns {Promise<string>} plain text suitable for TTS
 * @throws if gateway is unreachable or returns an error
 */
export async function cleanMarkdownLLM(text) {
  if (!config.gatewayApiKey) {
    throw new Error('GATEWAY_API_KEY not configured — cannot use LLM markdown cleaning');
  }

  const url = `${config.gatewayUrl}/v1/chat/completions`;
  const start = performance.now();

  log.info('llm markdown clean start', { chars: text.length, model: config.gatewayModel });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${config.gatewayApiKey}`,
    },
    body: JSON.stringify({
      model: config.gatewayModel,
      messages: [
        { role: 'user', content: LLM_CLEAN_PROMPT + '\n\n' + text },
      ],
      temperature: 0.2,
      max_tokens: Math.max(4096, Math.ceil(text.length * 1.2)),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gateway error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const cleaned = data.choices?.[0]?.message?.content?.trim();
  if (!cleaned) {
    throw new Error('Gateway returned empty response for markdown cleaning');
  }

  log.info('llm markdown clean done', {
    before: text.length,
    after: cleaned.length,
    ms: Math.round(performance.now() - start),
  });

  return cleaned;
}
