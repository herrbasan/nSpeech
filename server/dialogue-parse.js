/**
 * MD-Blocks → dialogue turns — the narration subset.
 *
 * SPEC OF RECORD: `herrbasan/md-blocks`, `md-blocks-spec.md` **v1.8
 * (2026-10-23, locked)**. This module implements the part of that grammar the
 * dialogue renderer needs, and only that part:
 *
 *   read  — `mb:block` open/close, the `preset` token (`narration[:<speaker>]`),
 *           the block attribute set (`name`, `audio`, `kind`, `repeat`, `icon`,
 *           `alt`, `focal`, `id`, `label`, `data:*`), the structural directives
 *           needed to know where a block begins and ends (`main`, `section`,
 *           `columns`/`col`, `var`), and `<!-- pause: <seconds> -->`.
 *   emit  — an ordered list of turns (speaker id + display name + verbatim
 *           Markdown body) with pause beats interleaved, in source order.
 *
 * Faithful where it touches: the §3 attribute grammar (value forms, the closed
 * bare-key set plus the open `data:` namespace, duplicate keys, raw `<`/`>`),
 * and the §7 errors that decide whether a turn list can be trusted — unknown
 * kind or attribute, a marker inside a block, nested/unclosed block, stray
 * column marker, `mb:/main`. §5.2 narration rules too: `name` only on
 * narration blocks, never empty, never conflicting for one speaker id.
 *
 * DELIBERATELY NOT VALIDATED (outside the subset, cannot change which text is
 * spoken): `var` payload pairing, `columns` weights arithmetic, duplicate
 * `id`s, media-class `kind` stamps, duplicate var names. A document is not
 * rejected for those here; the general parser (md-blocks#6) is where they live.
 *
 * Nothing is guessed. An empty narration body, a bare `narration` with no
 * speaker, a third `preset` segment, or a narration block carrying `audio=`
 * (a recording we would otherwise silently re-render and re-bill) all fail
 * loud with a line number.
 *
 * Zero dependencies, no Markdown renderer, no cross-repo import: the interim
 * extractor until the shared parser lands.
 */

/** §7: fail loud, with source range, stable code, message, expected form. */
export class DialogueParseError extends Error {
  constructor({ code, line = null, message, detail = null }) {
    super(message);
    this.name = 'DialogueParseError';
    this.code = code;
    this.line = line;
    this.detail = detail;
    this.status = 400;
    this.type = 'invalid_request_error';
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.line != null ? { line: this.line } : {}),
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}

// ── Grammar ─────────────────────────────────────────────────────────────────

/** §3 directive: an HTML comment, alone on its line, at column 0, lowercase. */
const MB_LINE = /^<!--[ \t]+mb:(\/?)([a-z][a-z0-9-]*)([\s\S]*?)-->[ \t]*$/;

/** A line that *looks* like a directive — used to make malformed ones loud. */
const MB_PREFIX = /^<!--[ \t]*mb:/;

/** `<!-- pause: 1.5 -->` — an ordinary comment to renderers (spec §3), a beat to us. */
const PAUSE_LINE = /^<!--[ \t]+pause:[ \t]*(\d+(?:\.\d+)?)[ \t]*-->[ \t]*$/i;
const PAUSE_PREFIX = /^<!--[ \t]*pause:/i;

/** §3 bare key `[a-z][a-z0-9_-]*`, optionally behind the open `data:` prefix. */
const KEY = /^[a-z][a-z0-9_-]*/;

/** §2/§4: the six directives. Anything else under `mb:` is an unknown kind. */
const KINDS = new Set(['main', 'section', 'block', 'columns', 'col', 'var']);

/** §3 common attributes (`section block columns col`) plus `main` (§4.5). */
const COMMON = ['id', 'label', 'preset'];

/** Closed bare-key set per kind — §4.2 (block assets), §4.4 (var), §4.6 (repeat). */
const KEYS_BY_KIND = {
  main: new Set(COMMON),
  section: new Set(COMMON),
  columns: new Set([...COMMON, 'weights']),
  col: new Set(COMMON),
  var: new Set(['name', 'value']),
  block: new Set([
    ...COMMON,
    'kind', 'audio', 'name', 'repeat', 'icon', 'alt', 'focal',
  ]),
};

const REPEAT_SLOTS = new Set(['header', 'footer']);

/** CommonMark thematic breaks (§2, root level → next section). */
const THEMATIC_BREAK = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/;

function fail(code, line, message, detail) {
  throw new DialogueParseError({ code, line, message, detail });
}

// ── §3 attribute values ─────────────────────────────────────────────────────

/**
 * Read one attribute value starting at `start`.
 * @returns {{ value: *, next: number }}
 */
function readValue(text, start, line, key) {
  const raw = text;
  if (start >= raw.length) fail('md_blocks_syntax', line, `attribute \`${key}\` has no value`);

  const c = raw[start];

  if (c === '"') {
    let i = start + 1;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i] === '"') break;
      i++;
    }
    if (i >= raw.length) fail('md_blocks_syntax', line, `attribute \`${key}\`: unterminated quoted value`);
    const literal = raw.slice(start, i + 1);
    assertNoAngle(literal, line, key);
    let value;
    try { value = JSON.parse(literal); }
    catch (err) { fail('md_blocks_syntax', line, `attribute \`${key}\`: malformed JSON string (${err.message})`); }
    return { value, next: i + 1 };
  }

  if (c === '[' || c === '{') {
    let depth = 0;
    let inString = false;
    let i = start;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    if (depth !== 0) fail('md_blocks_syntax', line, `attribute \`${key}\`: unterminated JSON value`);
    const literal = raw.slice(start, i);
    assertNoAngle(literal, line, key);
    let value;
    // §3: a value starting with " [ or { must be valid JSON — malformed
    // structured data is never reinterpreted as a string.
    try { value = JSON.parse(literal); }
    catch (err) { fail('md_blocks_syntax', line, `attribute \`${key}\`: malformed JSON (${err.message})`, literal); }
    return { value, next: i };
  }

  let i = start;
  while (i < raw.length && !/\s/.test(raw[i])) i++;
  const token = raw.slice(start, i);
  if (!token) fail('md_blocks_syntax', line, `attribute \`${key}\` has no value`);
  assertNoAngle(token, line, key);
  if (token === 'null') return { value: null, next: i };
  if (token === 'true' || token === 'false') return { value: token === 'true', next: i };
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return { value: Number(token), next: i };
  return { value: token, next: i };
}

/** §3: raw `<` or `>` in a value is an error — a value can never escape the comment. */
function assertNoAngle(text, line, key) {
  if (/[<>]/.test(text)) {
    fail('md_blocks_syntax', line,
      `attribute \`${key}\`: raw \`<\` or \`>\` in a value (spec §3) — use the JSON escapes \\u003c / \\u003e inside a quoted string`);
  }
}

/**
 * Parse a directive's attribute region against §3 and the kind's closed key set.
 * @returns {Object<string, *>}
 */
export function parseAttributes(text, line, kind) {
  const allowed = KEYS_BY_KIND[kind];
  if (!allowed) throw new Error(`parseAttributes: unknown kind ${kind}`);
  const attrs = {};
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    const km = KEY.exec(text.slice(i));
    if (!km) {
      fail('md_blocks_syntax', line,
        `malformed attribute name near ${JSON.stringify(text.slice(i, i + 16))}`,
        'expected key=value, key="quoted", or key=<JSON>');
    }
    let key = km[0];
    i += key.length;

    if (text[i] === ':') {
      i++;
      const nm = KEY.exec(text.slice(i));
      if (!nm) fail('md_blocks_syntax', line, `attribute \`${key}:\` has an empty property name (spec §7)`);
      if (key !== 'data') {
        fail('md_blocks_syntax', line,
          `unknown attribute namespace \`${key}:\` — only \`data:\` is open (spec §3)`,
          'future prefixes are claimed by the spec, never by documents');
      }
      key = `data:${nm[0]}`;
      i += nm[0].length;
    }

    if (text[i] !== '=') {
      fail('md_blocks_syntax', line, `attribute \`${key}\` has no value`, 'expected `=`');
    }
    i++;

    const { value, next } = readValue(text, i, line, key);
    i = next;

    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      fail('md_blocks_syntax', line, `duplicate attribute \`${key}\` (spec §3)`);
    }
    attrs[key] = value;
  }

  for (const key of Object.keys(attrs)) {
    // The `data:` namespace is open by design: parsed, preserved, never interpreted.
    if (key.startsWith('data:')) continue;
    if (!allowed.has(key)) {
      fail('md_blocks_syntax', line,
        `unknown attribute \`${key}\` on \`mb:${kind}\``,
        `allowed: ${[...allowed].join(', ')} — custom keys live under the open \`data:\` namespace (spec §3)`);
    }
  }
  return attrs;
}

/**
 * Classify a `preset` token (§5.1).
 * @returns {{ family: string, modifier: string|null, variant: string|null }}
 */
function parsePreset(value, line) {
  if (typeof value !== 'string' || value === '') {
    fail('md_blocks_syntax', line, '`preset` must be a non-empty token', 'form: family[:modifier[:variant]]');
  }
  const parts = value.split(':');
  if (parts.length > 3) {
    fail('md_blocks_syntax', line, `\`preset=${value}\`: more than three segments`, 'form: family[:modifier[:variant]]');
  }
  const [family, modifier = null, variant = null] = parts;
  if (family !== family.toLowerCase() || /\s/.test(family)) {
    fail('md_blocks_syntax', line, `\`preset=${value}\`: family must be a lowercase token`);
  }
  return { family, modifier, variant };
}

// ── Extract ─────────────────────────────────────────────────────────────────

/**
 * Extract dialogue turns from an MD-Blocks document.
 *
 * @param {string} markdown — full document source
 * @param {{ file?: string }} [opts]
 * @returns {{
 *   items: Array<{type:'turn', index:number, speaker:string, name:string|null, markdown:string, line:number, endLine:number}
 *               | {type:'beat', seconds:number, line:number}>,
 *   speakers: Array<{id:string, name:string|null, turns:number}>,
 * }}
 */
export function parseDialogue(markdown, opts = {}) {
  const file = opts.file ?? '<source>';
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    fail('dialogue_no_source', null, `${file}: empty source — expected an MD-Blocks document`);
  }

  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const at = (line) => `${file}:${line}`;

  // §2 frontmatter: a `---` line as line 1, closed by the next `---` line.
  let i = 0;
  if (lines[0] === '---') {
    let j = 1;
    while (j < lines.length && lines[j] !== '---') j++;
    if (j >= lines.length) fail('md_blocks_syntax', 1, `${at(1)}: frontmatter opened at line 1 is never closed`);
    i = j + 1;
  }

  const items = [];
  /** @type {Map<string, { name: string|null, line: number, turns: number }>} */
  const speakers = new Map();

  let fence = null;            // { char, len } — fenced code, never scanned
  let block = null;            // { line, speaker, name, narration, body: string[] }
  let columns = null;          // { line, cols: number }
  let section = 1;
  let sectionDirectives = 0;
  let prevLine = null;         // previous physical line, for the setext-H2 trap
  let turnCount = 0;

  const pushTurn = (b, endLine) => {
    turnCount += 1;
    const markdownBody = b.body.join('\n');
    const entry = speakers.get(b.speaker) ?? { name: null, line: b.line, turns: 0 };
    if (b.name != null) {
      if (entry.name != null && entry.name !== b.name) {
        fail('dialogue_speaker_conflict', b.line,
          `${at(b.line)}: speaker \`${b.speaker}\` is named ${JSON.stringify(entry.name)} at line ${entry.line} and ${JSON.stringify(b.name)} here`,
          'one id, one display name (spec §5.2) — redundant data that can disagree is an error, not a first-wins rule');
      }
      entry.name = b.name;
    }
    entry.turns += 1;
    speakers.set(b.speaker, entry);
    items.push({
      type: 'turn',
      index: turnCount,
      speaker: b.speaker,
      name: b.name,
      markdown: markdownBody,
      line: b.line,
      endLine,
    });
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const prev = prevLine;
    prevLine = line;

    // ── Fenced code: content, never structure (§2) ──
    if (fence) {
      const f = fenceAt(line);
      if (f && f.char === fence.char && f.len >= fence.len) fence = null;
      if (block) block.body.push(line);
      continue;
    }
    const opening = fenceAt(line);
    if (opening) {
      fence = opening;
      if (block) block.body.push(line);
      continue;
    }

    // ── Directives ──
    if (line.startsWith('<!--')) {
      const m = MB_LINE.exec(line);
      if (!m) {
        if (MB_PREFIX.test(line)) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: malformed \`mb:\` directive`,
            'form: `<!-- mb:kind key=value -->` or `<!-- mb:/kind -->`, alone on a line at column 0, lowercase');
        }
        if (PAUSE_PREFIX.test(line)) {
          if (block) {
            fail('dialogue_beat_in_turn', lineNo,
              `${at(lineNo)}: pause beat inside a narration block (opened at line ${block.line})`,
              'a beat is a gap between turns — close the turn first');
          }
          const bm = PAUSE_LINE.exec(line);
          if (!bm) {
            fail('md_blocks_syntax', lineNo,
              `${at(lineNo)}: malformed pause beat`,
              'form: `<!-- pause: 1.5 -->` — a positive number of seconds');
          }
          const seconds = Number(bm[1]);
          if (!(seconds > 0)) {
            fail('md_blocks_syntax', lineNo, `${at(lineNo)}: pause beat must be longer than 0s`);
          }
          items.push({ type: 'beat', seconds, line: lineNo });
          continue;
        }
        // Any other HTML comment is ordinary: preserved, ignored, never a directive.
        if (block) block.body.push(line);
        continue;
      }

      const closing = m[1] === '/';
      const kind = m[2];
      const attrText = m[3] ?? '';

      if (!KINDS.has(kind)) {
        fail('md_blocks_syntax', lineNo,
          `${at(lineNo)}: unknown \`mb:\` kind \`${closing ? '/' : ''}${kind}\``,
          `known: ${[...KINDS].join(', ')}`);
      }

      // ── block ──
      if (kind === 'block') {
        if (closing) {
          if (!block) fail('md_blocks_syntax', lineNo, `${at(lineNo)}: \`mb:/block\` without an opening \`mb:block\``);
          if (block.narration) pushTurn(block, lineNo);
          block = null;
          continue;
        }
        if (block) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: nested \`mb:block\` — the block opened at line ${block.line} is still open (spec §4.2)`);
        }
        const attrs = parseAttributes(attrText, lineNo, 'block');

        if (attrs.repeat !== undefined && !REPEAT_SLOTS.has(attrs.repeat)) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: \`repeat=${JSON.stringify(attrs.repeat)}\` — only header or footer (spec §4.6)`);
        }

        let preset = null;
        if (attrs.preset !== undefined) preset = parsePreset(attrs.preset, lineNo);

        const isNarration = preset?.family === 'narration';

        if (attrs.name !== undefined) {
          if (!isNarration) {
            fail('md_blocks_syntax', lineNo,
              `${at(lineNo)}: \`name\` on a block without \`preset=narration…\` (spec §7)`);
          }
          if (typeof attrs.name !== 'string' || attrs.name === '') {
            fail('md_blocks_syntax', lineNo, `${at(lineNo)}: \`name\` must be a non-empty string (spec §7)`);
          }
        }

        if (attrs.audio !== undefined && !isNarration) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: \`audio\` on a block without \`preset=narration\` (spec §7)`);
        }

        if (!isNarration) {
          block = { line: lineNo, narration: false, body: [] };
          continue;
        }

        // §5.2 multi-speaker: the modifier slot is the speaker identifier.
        if (preset.variant != null) {
          fail('dialogue_preset_invalid', lineNo,
            `${at(lineNo)}: \`preset=${attrs.preset}\` — the narration preset takes a speaker, not a third segment`,
            'form: preset=narration[:<speaker-id>]');
        }
        if (!preset.modifier) {
          fail('dialogue_no_speaker', lineNo,
            `${at(lineNo)}: narration block has no speaker`,
            'dialogue mode needs identity per turn — write preset=narration:<speaker-id> (plain single-voice posts belong on /v1/audio/speech)');
        }
        if (/[:<>\s]/.test(preset.modifier)) {
          fail('dialogue_preset_invalid', lineNo,
            `${at(lineNo)}: speaker id ${JSON.stringify(preset.modifier)} is not a safe token`,
            'lowercase slug — letters, digits, dot, underscore, hyphen');
        }
        if (attrs.audio !== undefined) {
          fail('dialogue_audio_recorded', lineNo,
            `${at(lineNo)}: narration block carries \`audio=${JSON.stringify(attrs.audio)}\``,
            'a pre-recorded delivery exists for this turn; dialogue mode does not mix recordings into a render (it would re-bill text the author already paid for)');
        }

        block = {
          line: lineNo,
          narration: true,
          speaker: preset.modifier,
          name: attrs.name ?? null,
          body: [],
        };
        continue;
      }

      // ── everything else: never legal inside a block (§4.2) ──
      if (block) {
        fail('md_blocks_syntax', lineNo,
          `${at(lineNo)}: \`mb:${closing ? '/' : ''}${kind}\` inside the block opened at line ${block.line}`,
          'a block holds Markdown only');
      }

      if (kind === 'main') {
        if (closing) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: \`mb:/main\` is not a closing form`,
            'a main ends where the next `mb:main` begins, or at the end of the document (spec §4.5)');
        }
        parseAttributes(attrText, lineNo, 'main');
        continue;
      }

      if (closing && kind !== 'columns' && kind !== 'col') {
        fail('md_blocks_syntax', lineNo, `${at(lineNo)}: \`mb:/${kind}\` is not a closing form`);
      }

      if (kind === 'section') {
        if (columns) {
          fail('md_blocks_syntax', lineNo, `${at(lineNo)}: \`mb:section\` inside \`mb:columns\` (spec §4.3)`);
        }
        parseAttributes(attrText, lineNo, 'section');
        sectionDirectives += 1;
        if (sectionDirectives > 1) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: second \`mb:section\` in section ${section} (spec §4.1)`,
            'one annotation per section');
        }
        continue;
      }

      if (kind === 'var') {
        if (columns) {
          fail('md_blocks_syntax', lineNo, `${at(lineNo)}: \`mb:var\` inside \`mb:columns\` (spec §4.3)`);
        }
        parseAttributes(attrText, lineNo, 'var');
        continue;
      }

      if (kind === 'columns') {
        if (closing) {
          if (!columns) fail('md_blocks_syntax', lineNo, `${at(lineNo)}: \`mb:/columns\` without an opening \`mb:columns\``);
          if (columns.cols < 2) {
            fail('md_blocks_syntax', columns.line,
              `${at(columns.line)}: \`mb:columns\` with ${columns.cols} column marker(s)`,
              'a columns block needs at least 2 `mb:col` markers (spec §4.3)');
          }
          columns = null;
          continue;
        }
        if (columns) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: nested \`mb:columns\` — the one opened at line ${columns.line} is still open`);
        }
        parseAttributes(attrText, lineNo, 'columns');
        columns = { line: lineNo, cols: 0 };
        continue;
      }

      if (kind === 'col') {
        if (!columns) {
          fail('md_blocks_syntax', lineNo,
            `${at(lineNo)}: \`mb:${closing ? '/col' : 'col'}\` outside \`mb:columns\` (spec §4.3)`);
        }
        if (!closing) {
          parseAttributes(attrText, lineNo, 'col');
          columns.cols += 1;
        }
        continue;
      }
    }

    // ── Root-level section break (§2), with the setext-H2 trap ──
    if (!block && !columns && THEMATIC_BREAK.test(line)) {
      const isSetext = /^-{3,}$/.test(line.trim())
        && prev != null && prev.trim() !== ''
        && !prev.startsWith('<!--')
        && !/^#{1,6}\s/.test(prev.trim());
      if (!isSetext) {
        section += 1;
        sectionDirectives = 0;
        continue;
      }
    }

    if (block) block.body.push(line);
  }

  if (fence) fail('md_blocks_syntax', lines.length, `${at(lines.length)}: fenced code is never closed`);
  if (block) {
    fail('md_blocks_syntax', block.line,
      `${at(block.line)}: \`mb:block\` is never closed`,
      'an unclosed block hides every turn after it');
  }
  if (columns) {
    fail('md_blocks_syntax', columns.line, `${at(columns.line)}: \`mb:columns\` is never closed`);
  }

  if (turnCount === 0) {
    fail('dialogue_no_turns', null,
      `${file}: no narration blocks found`,
      'dialogue mode reads `<!-- mb:block preset=narration:<speaker> -->` turns — a post without them is not a dialogue');
  }

  for (const item of items) {
    if (item.type !== 'turn') continue;
    // A block that carries no `name` adopts its speaker's name from any block
    // that does — the display name belongs to the identity, not to one turn.
    if (item.name == null) item.name = speakers.get(item.speaker)?.name ?? null;
    if (item.markdown.trim() === '') {
      fail('dialogue_empty_turn', item.line,
        `${at(item.line)}: narration block for \`${item.speaker}\` is empty`);
    }
  }

  return {
    items,
    speakers: [...speakers].map(([id, s]) => ({ id, name: s.name, turns: s.turns })),
  };
}

/** Fenced-code opener/closer per §2 (``` or ~~~, ≥3, info string allowed). */
function fenceAt(line) {
  const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { char: m[1][0], len: m[1].length };
}
