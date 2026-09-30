/**
 * Speech-ready text cleaning — SERVER side (canonical path).
 *
 * The canonical regex cleaner lives in the SDK (lib/nspeech-client/nspeech-client.js)
 * and is re-exported here. Server-side cleaning runs when the request passes
 * extra_body.clean (legacy alias: extra_body.markdown):
 *   extra_body.clean: true   — regex-based, fast, deterministic
 *   extra_body.clean: 'llm'  — regex clean, then LLM date pass via local
 *                              gateway: every date is rewritten as fully
 *                              spoken words with correct grammar (de/en).
 *                              Replaced the prosody-mark pass 2026-09-24
 *                              (prosody was parked — worse than regex in
 *                              ear tests; dates need sentence context,
 *                              which is exactly what the model provides).
 * The standalone service endpoint lives in api/text.js (POST /v1/text/clean).
 */

import { config } from './config.js';
import { logger } from './logger.js';
import { cleanMarkdown as regexClean } from '../lib/nspeech-client/nspeech-client.js';

export { cleanMarkdown, expandAcronyms } from '../lib/nspeech-client/nspeech-client.js';

const log = logger.child('markdown-clean');

const SPELL_DATES_PROMPT = `You prepare text for text-to-speech. Your ONLY job: rewrite every date into fully spoken words, in the language of the text, using the grammatical form the sentence requires. Never use written abbreviations — "12ten", "12th", "3." are forbidden; write "zwölften", "twelfth", "dritten".

German examples:

INPUT: Wir treffen uns am 12. September.
OUTPUT: Wir treffen uns am zwölften September.

INPUT: Der 3. Oktober ist ein Feiertag. Am 24.12.2026 endet das Jahr.
OUTPUT: Der dritte Oktober ist ein Feiertag. Am vierundzwanzigsten Dezember zweitausendsechsundzwanzig endet das Jahr.

English examples:

INPUT: On September 12, 2026, the deal closes.
OUTPUT: On September twelfth, twenty twenty-six, the deal closes.

INPUT: We meet on 12 September.
OUTPUT: We meet on the twelfth of September.

Rules:
- Dates only. Every other word must appear in the output, in order, verbatim.
- Match the sentence's grammar: "der zwölfte September" (nominative) vs "am zwölften September" (dative).
- Never add commentary. Output ONLY the rewritten text.

Input:`;

/**
 * Length-coverage invariant: LLM must not lose content.
 * Word-frequency comparison, punctuation-insensitive. Rewritten words
 * ("12." → "zwölften") count as one lost token per date — tolerated;
 * dropped SENTENCES are not (coverage < 50% refuses the output).
 *
 * GOTCHA fixed 2026-09-24: this regex had been mojibake-corrupted and
 * lacked the /u flag, so \\p meant literal "p" — the check only ever
 * counted the letter p. Neutered guard, discovered by the first real use.
 */
function assertCoverage(expect, actual) {
  const count = (s) => {
    const freq = new Map();
    for (const w of s.toLowerCase().split(/\s+/)) {
      const k = w.replace(/[^\p{L}\p{N}']/gu, '');
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
  if (total === 0) throw new Error('date pass: input has no words — coverage check impossible');
  const ratio = matched / total;
  if (ratio < 0.5) {
    throw new Error(
      `date pass FAILED coverage: only ${(ratio * 100).toFixed(1)}% of input words ` +
      `present in LLM output — gateway model summarized instead of rewriting. ` +
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
 * One gateway call: spell the dates of one text segment. Returns the text.
 * @throws on HTTP error, empty response, or coverage failure — fail loud.
 */
async function spellSegment(segment) {
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
        { role: 'user', content: SPELL_DATES_PROMPT + '\n\n' + segment },
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
  const spelled = data.choices?.[0]?.message?.content?.trim();
  if (!spelled) {
    throw new Error('Gateway returned empty response for date pass');
  }
  return spelled;
}

/**
 * LLM-based date spelling via the local LLM Gateway.
 * Input is regex-cleaned first, split into ~1.5K segments, each passed
 * separately (compliance degrades on long inputs), then reassembled.
 * A segment without dates legitimately comes back unchanged — the
 * coverage check is the only refusal guard (a prosody-style "zero changes
 * = dead pass" check would be wrong here: most text has no dates).
 * @param {string} text — raw markdown
 * @returns {Promise<string>} plain text with dates fully spoken, suitable for TTS
 * @throws if gateway is unreachable, returns an error, or loses content
 */
export async function cleanMarkdownLLM(text) {
  if (!config.gatewayApiKey) {
    throw new Error('GATEWAY_API_KEY not configured — cannot use LLM markdown cleaning');
  }

  // Re-exported binding is not a local binding — call the real import.
  const base = regexClean(text);
  const paragraphs = base.split(/\n\n/).map(p => p.trim()).filter(Boolean);
  const segments = buildSegments(paragraphs);
  const start = performance.now();

  log.info('llm date pass start', {
    chars: base.length,
    segments: segments.length,
    model: config.gatewayModel,
  });

  const spelledSegments = [];
  for (const [i, seg] of segments.entries()) {
    const spelled = await spellSegment(seg);
    const coverage = assertCoverage(seg, spelled);
    log.debug('date segment done', { segment: i + 1, of: segments.length, changed: spelled !== seg, coverage: `${(coverage * 100).toFixed(1)}%` });
    spelledSegments.push(spelled);
  }

  const out = spelledSegments.join('\n\n');

  log.info('llm date pass done', {
    before: base.length,
    after: out.length,
    segmentsChanged: spelledSegments.filter((s, i) => s !== segments[i]).length,
    ms: Math.round(performance.now() - start),
  });

  return out;
}
