/**
 * Markdown → speech-ready plain text.
 *
 * Two modes:
 *   extra_body.markdown: true   — regex-based, fast, deterministic
 *   extra_body.markdown: 'llm'  — regex clean, then LLM prosody pass via
 *                                 local gateway (Gemma 4): marks vocal
 *                                 stress (em-dash) and effect pauses (…).
 *                                 Fails loud if gateway is unreachable,
 *                                 errored, or returns a lossy rewrite.
 *
 * The regex path strips YAML frontmatter, images, code blocks, formatting.
 * Headers get a trailing period so duration estimators insert a pause.
 * Italic (*word*) already becomes "— word" mechanically; the LLM pass adds
 * what regex cannot: stress on UNMARKED words and pause placement.
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

  // Strikethrough — drop entirely: struck text is retracted, speaking it is wrong
  t = t.replace(/\s*~~[\s\S]*?~~\s*/g, ' ');

  // Emphasis (bold + italic) → strip silently. Tested 2026-08-18:
  // em-dash, quotes, and hyphen all break the flow more than they help;
  // the engine emphasizes better when left alone.
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // Colon handling, two branches by left side:
  //  - Label (line-initial, 1-2 words: "A Rule:", "Third:") → em-dash merge.
  //    F5 compresses short segments and ignores their terminal punctuation,
  //    but an em-dash breaks the flow reliably even after short labels.
  //  - Clause (3+ words: "The answer is simple:") → period + paragraph
  //    break + capitalize: a real sentence boundary with a full pause.
  // Only colon+space — times (12:30) have no following space.
  t = t.replace(/(^|\n)(\S+(?: \S+)?): (\p{L})/gmu, (_m, br, left, ch) => br + left + ' — ' + ch);
  t = t.replace(/: (\p{L})/gu, (_m, ch) => '.\n\n' + ch.toUpperCase());

  // Code blocks (drop — reads poorly as TTS), inline code (keep content)
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`(.+?)`/g, '$1');

  // Headers: strip '#' prefix (with or without following space — "#Title"
  // is common in pasted content), add trailing period if missing
  t = t.replace(/^(#{1,6})\s*(.+)$/gm, (_m, _hashes, title) => {
    const trimmed = title.trim();
    return /[.!?…]$/.test(trimmed) ? trimmed + '\n' : trimmed + '.\n';
  });

  // Standalone lines without terminal punctuation get a period — these are
  // headings/titles in sources that don't use '#' (plain-text articles,
  // pasted content). A line counts as standalone when bordered by blank
  // lines or text boundaries. Length cap: long lines are wrapped prose,
  // not headings — don't punctuate mid-thought.
  t = t.replace(/(?:^|\n\n)([^\n]{1,120})(?=\n\n|$)/g, (m, line) => {
    const trimmed = line.trim();
    if (!trimmed || /[.!?…:;,—–-]$/.test(trimmed)) return m;
    return m.slice(0, m.length - line.length) + trimmed + '.';
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

  // Acronyms → speakable form (engines pronounce "GLM" as a word otherwise)
  t = expandAcronyms(t);

  // Collapse 3+ consecutive newlines
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Acronyms spoken letter-by-letter need explicit spelling for TTS engines,
 * which otherwise attempt word pronunciation ("GLM" → "glum"). Also splits
 * letter+digit compounds: "GLM5" → "G L M five", "K3" → "K three".
 *
 * Deterministic — runs in the regex layer, BEFORE the LLM prosody pass,
 * so the prosody contract (verbatim) is unaffected.
 */
const PRONOUNCED_ACRONYMS = new Set([
  'NASA', 'CUDA', 'NATO', 'UNESCO', 'SCUBA', 'RADAR', 'LASER', 'OK',
]);

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function spellLetters(s) {
  return s.split('').join(' ');
}

function digitWord(d) {
  return DIGIT_WORDS[parseInt(d, 10)];
}

export function expandAcronyms(t) {
  // File extensions: "religion.md" → "religion dot m d". Without this,
  // engines read the dot as sentence end and "md" as the word "midi".
  // Run FIRST — the dot must not survive into other rules.
  t = t.replace(/\b([A-Za-z0-9_\-]+)\.(md|txt|json|js|ts|py|wav|mp3|pdf|html|css|yml|yaml|xml|png|jpg|jpeg|log|csv)\b/g,
    (_m, name, ext) => `${name} dot ${ext.split('').join(' ')}`);
  // Hyphen directly before an acronym run becomes a space ("F5-TTS" → "F5 TTS")
  t = t.replace(/([A-Za-z0-9])-(?=[A-Z]{2,}\b)/g, '$1 ');
  // Letter-run + trailing digits: GLM5, GPT4, RTX4090. Single digit → word,
  // multi-digit stays numeric (engines read "4090" acceptably).
  t = t.replace(/\b([A-Z]{2,})(\d+)\b/g, (_m, letters, digits) => {
    const spelled = spellLetters(letters);
    const num = digits.length === 1 ? digitWord(digits) : digits;
    return `${spelled} ${num}`;
  });
  // Single letter + single digit: K3, F5, B2
  t = t.replace(/\b([A-Z])(\d)\b/g, (_m, letter, d) => `${letter} ${digitWord(d)}`);
  // Plain letter runs: GLM, GPU, RLHF — unless pronounced as a word
  t = t.replace(/\b[A-Z]{2,}\b/g, (m) => (PRONOUNCED_ACRONYMS.has(m) ? m : spellLetters(m)));
  return t;
}

const PROSODY_PROMPT = `You are a prosody marker for text-to-speech. Your ONLY job is to insert two marks into the input text: — (em-dash) before vocally stressed words, and … (ellipsis) at effect pauses. You change nothing else.

Examples:

INPUT: The optimizer didn't fail because it was weak. It failed because the loss function rewarded the wrong thing.
OUTPUT: The optimizer didn't fail because it was — weak. It failed because the loss function rewarded the — wrong thing.

INPUT: What did the researchers find? Nothing. The effect had vanished entirely.
OUTPUT: What did the researchers find? … Nothing. The effect had vanished — entirely.

INPUT: Safety lies in the middle of the herd.
OUTPUT: Safety lies in the — middle of the herd.

Rules:
- Output ONLY the marked text. No commentary.
- Every input word must appear in the output, in order, verbatim. You insert marks; you never add, drop, or reword anything.
- Stressed word = the pivotal word of a claim, a contrast, a correction, an irony: what a narrator would lean on.
- Pause (…) = before a punchline, after a rhetorical question, at a dramatic turn.
- A few marks per paragraph. Not every sentence needs one. Clutter destroys the effect.
- Do not mark headings.

Input:`;

/**
 * Length-coverage invariant: LLM must not lose content.
 * Verbatim rewriting is the contract; if more than half the input words
 * vanish, this is a summary/truncation — refuse it rather than speak it.
 */
function assertCoverage(expect, actual) {
  // Word-frequency vector, punctuation-insensitive. Tolerant of the
  // inserted — / … marks but not of dropped sentences.
  const count = (s) => {
    const freq = new Map();
    for (const w of s.toLowerCase().split(/\s+/)) {
      const k = w.replace(/[—…]*$/g, '').replace(/[^\p{L}\p{N}']/g, '');
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
      `present in LLM output — gateway model summarized instead of marking. ` +
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
 * @throws on HTTP error, empty response, or coverage failure — fail loud.
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
 * @param {string} text — raw markdown
 * @returns {Promise<string>} plain text with prosody marks, suitable for TTS
 * @throws if gateway is unreachable, returns an error, loses content,
 *         or adds zero marks across the whole document (pass is dead weight)
 */
export async function cleanMarkdownLLM(text) {
  if (!config.gatewayApiKey) {
    throw new Error('GATEWAY_API_KEY not configured — cannot use LLM markdown cleaning');
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

  const baselineEm = (base.match(/—/g) ?? []).length;
  const baselineEl = (base.match(/…/g) ?? []).length;

  const markedSegments = [];
  for (const [i, seg] of segments.entries()) {
    const marked = await markSegment(seg);
    const coverage = assertCoverage(seg, marked);
    log.debug('prosody segment done', { segment: i + 1, of: segments.length, coverage: `${(coverage * 100).toFixed(1)}%` });
    markedSegments.push(marked);
  }

  const out = markedSegments.join('\n\n');

  const emAdded = (out.match(/—/g) ?? []).length - baselineEm;
  const elAdded = (out.match(/…/g) ?? []).length - baselineEl;
  if (emAdded + elAdded === 0) {
    throw new Error(
      `prosody pass FAILED: model returned text with zero added marks across ` +
      `${segments.length} segments — non-compliant, refusing pointless pass. ` +
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
