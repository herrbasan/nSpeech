/**
 * Markdown → speech-ready plain text (regex path, deterministic).
 *
 * Shared module: imported by server/markdown-clean.js (Node, speech
 * pipeline) and directly by dashboard pages (browser, preview display).
 * NO imports — must stay dependency-free so the browser can load it.
 *
 * The regex path strips YAML frontmatter, images, code blocks, formatting.
 * Headers get a trailing period so duration estimators insert a pause.
 * Emphasis becomes "quoted" form. Label colons become em-dashes, clause
 * colons become sentence splits (F5 short-segment compression workaround).
 */

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
