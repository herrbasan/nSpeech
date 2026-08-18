/**
 * Markdown → speech-ready plain text — SERVER side (legacy path).
 *
 * The canonical regex cleaner lives in the SDK (lib/nspeech-client/nspeech-client.js)
 * and is re-exported here. Clients should clean before sending; this module backs
 * the legacy extra_body.markdown request field for non-migrated clients:
 *   extra_body.markdown: true   — regex-based, fast, deterministic
 *   extra_body.markdown: 'llm'  — regex clean, then LLM prosody pass via local
 *                                 gateway. PARKED 2026-08-18 (consistently worse
 *                                 than regex in ear tests). Kept, fails loud.
 */

import { config } from './config.js';
import { logger } from './logger.js';

export { cleanMarkdown, expandAcronyms } from '../lib/nspeech-client/nspeech-client.js';

const log = logger.child('markdown-clean');

const PROSODY_PROMPT = `You are a prosody marker for text-to-speech. Your ONLY job is to insert two marks into the input text: ÔÇö (em-dash) before vocally stressed words, and ÔÇª (ellipsis) at effect pauses. You change nothing else.

Examples:

INPUT: The optimizer didn't fail because it was weak. It failed because the loss function rewarded the wrong thing.
OUTPUT: The optimizer didn't fail because it was ÔÇö weak. It failed because the loss function rewarded the ÔÇö wrong thing.

INPUT: What did the researchers find? Nothing. The effect had vanished entirely.
OUTPUT: What did the researchers find? ÔÇª Nothing. The effect had vanished ÔÇö entirely.

INPUT: Safety lies in the middle of the herd.
OUTPUT: Safety lies in the ÔÇö middle of the herd.

Rules:
- Output ONLY the marked text. No commentary.
- Every input word must appear in the output, in order, verbatim. You insert marks; you never add, drop, or reword anything.
- Stressed word = the pivotal word of a claim, a contrast, a correction, an irony: what a narrator would lean on.
- Pause (ÔÇª) = before a punchline, after a rhetorical question, at a dramatic turn.
- A few marks per paragraph. Not every sentence needs one. Clutter destroys the effect.
- Do not mark headings.

Input:`;

/**
 * Length-coverage invariant: LLM must not lose content.
 * Verbatim rewriting is the contract; if more than half the input words
 * vanish, this is a summary/truncation ÔÇö refuse it rather than speak it.
 */
function assertCoverage(expect, actual) {
  // Word-frequency vector, punctuation-insensitive. Tolerant of the
  // inserted ÔÇö / ÔÇª marks but not of dropped sentences.
  const count = (s) => {
    const freq = new Map();
    for (const w of s.toLowerCase().split(/\s+/)) {
      const k = w.replace(/[ÔÇöÔÇª]*$/g, '').replace(/[^\p{L}\p{N}']/g, '');
      if (!k) continue;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    return freq;
  };
  const need = count(expect);
  const have = count(actual);
  let matched = 0;
  let total = 0;
  for (const [word, n] of need) {
    total += n;
    matched += Math.min(n, have.get(word) ?? 0);
  }
  if (total === 0) throw new Error('prosody pass: empty input to coverage check');
  const ratio = matched / total;
  if (ratio < 0.5) {
    throw new Error(
      `prosody pass FAILED coverage: only ${(ratio * 100).toFixed(1)}% of input words ` +
      `present in LLM output ÔÇö gateway model summarized instead of marking. ` +
      `Refusing lossy text.`
    );
  }
  return ratio;
}

/**
 * Group cleaned paragraphs into segments of ~SEGMENT_TARGET chars.
 * Prosody marking is paragraph-local; short segments keep the model
 * compliant (long inputs degenerate into verbatim copy).
 */
const SEGMENT_TARGET = 1500;

function buildSegments(paragraphs) {
  const segments = [];
  let current = [];
  let len = 0;
  for (const para of paragraphs) {
    if (len > 0 && len + para.length > SEGMENT_TARGET) {
      segments.push(current);
      current = [];
      len = 0;
    }
    current.push(para);
    len += para.length;
  }
  if (current.length) segments.push(current);
  return segments.map(paras => paras.join('\n\n'));
}

/**
 * One gateway call: mark one text segment. Returns marked text.
 * @throws on HTTP error, empty response, or coverage failure ÔÇö fail loud.
 */
async function markSegment(segment) {
  const url = `${config.gatewayUrl}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${config.gatewayApiKey}`,
    },
    body: JSON.stringify({
      model: config.gatewayModel,
      messages: [
        { role: 'user', content: PROSODY_PROMPT + '\n\n' + segment },
      ],
      temperature: 0.2,
      max_tokens: Math.max(2048, Math.ceil(segment.length * 1.5)),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gateway error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const marked = data.choices?.[0]?.message?.content?.trim();
  if (!marked) {
    throw new Error('Gateway returned empty response for prosody pass');
  }
  return marked;
}

/**
 * LLM-based prosody marking via the local LLM Gateway.
 * Input is regex-cleaned first, split into ~1.5K segments, each marked
 * separately (compliance degrades on long inputs), then reassembled.
 * @param {string} text ÔÇö raw markdown
 * @returns {Promise<string>} plain text with prosody marks, suitable for TTS
 * @throws if gateway is unreachable, returns an error, loses content,
 *         or adds zero marks across the whole document (pass is dead weight)
 */
export async function cleanMarkdownLLM(text) {
  if (!config.gatewayApiKey) {
    throw new Error('GATEWAY_API_KEY not configured ÔÇö cannot use LLM markdown cleaning');
  }

  const base = cleanMarkdown(text);
  const paragraphs = base.split(/\n\n/).map(p => p.trim()).filter(Boolean);
  const segments = buildSegments(paragraphs);
  const start = performance.now();

  log.info('llm prosody pass start', {
    chars: base.length,
    segments: segments.length,
    model: config.gatewayModel,
  });

  const baselineEm = (base.match(/ÔÇö/g) ?? []).length;
  const baselineEl = (base.match(/ÔÇª/g) ?? []).length;

  const markedSegments = [];
  for (const [i, seg] of segments.entries()) {
    const marked = await markSegment(seg);
    const coverage = assertCoverage(seg, marked);
    log.debug('prosody segment done', { segment: i + 1, of: segments.length, coverage: `${(coverage * 100).toFixed(1)}%` });
    markedSegments.push(marked);
  }

  const out = markedSegments.join('\n\n');

  const emAdded = (out.match(/ÔÇö/g) ?? []).length - baselineEm;
  const elAdded = (out.match(/ÔÇª/g) ?? []).length - baselineEl;
  if (emAdded + elAdded === 0) {
    throw new Error(
      `prosody pass FAILED: model returned text with zero added marks across ` +
      `${segments.length} segments ÔÇö non-compliant, refusing pointless pass. ` +
      `(model: ${config.gatewayModel})`
    );
  }

  log.info('llm prosody pass done', {
    before: base.length,
    after: out.length,
    marksAdded: { emDash: emAdded, ellipsis: elAdded },
    ms: Math.round(performance.now() - start),
  });

  return out;
}
