/**
 * Probe: cleanMarkdown pause + heading rules (2026-10-03).
 *
 * 1. Spaced dashes (" — ", " – ", " - ", " -- ") → " ... "
 * 2. Hashless heading followed by a single newline + longer line → period
 *
 * Run: node scripts/probe-text-clean.js
 */
import { cleanMarkdown } from '../lib/nspeech-client/nspeech-client.js';

let failures = 0;

function check(name, input, expect) {
  const out = cleanMarkdown(input);
  const ok = out === expect;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log('  in:     ' + JSON.stringify(input));
    console.log('  expect: ' + JSON.stringify(expect));
    console.log('  got:    ' + JSON.stringify(out));
  }
}

// ── 1. Dashes → " ... " ─────────────────────────────────────────────────────
check('em-dash', 'One — two.', 'One ... two.');
check('en-dash (German Gedankenstrich)', 'Eins – zwei.', 'Eins ... zwei.');
check('spaced hyphen', 'One - two.', 'One ... two.');
check('double hyphen', 'One -- two.', 'One ... two.');
check('unspaced em-dash untouched', 'One—two.', 'One—two.');
check('unspaced hyphen untouched (acronym aside)', 'GPT-TTS rocks.', 'G P T T T S rocks.');
check('multiple dashes in one line', 'A — B – C - D.', 'A ... B ... C ... D.');
check('label colon merge lands as pause', 'A Rule: obey it.', 'A Rule ... obey it.');
check('clause colon (3+ words) still splits', 'The answer is simple: Yes.', 'The answer is simple.\n\nYes.');
check('line ending with dash keeps dash', 'thought —\n\nnext.', 'thought —\n\nnext.');

// ── 2. Hashless headings ────────────────────────────────────────────────────
check('heading + single newline + longer paragraph',
  'The Intellectual Corset\nWhy the 19th century feared fashion. More text follows here.',
  'The Intellectual Corset.\nWhy the 19th century feared fashion. More text follows here.');

check('heading already punctuated untouched',
  'A Question?\nThe answer follows here with more words.',
  'A Question?\nThe answer follows here with more words.');

check('equal-length wrapped prose untouched',
  'The quick brown fox jumps over the lazy dog near riverbanks today.\nAnd second lines of prose often continue the thought without any pause.',
  'The quick brown fox jumps over the lazy dog near riverbanks today.\nAnd second lines of prose often continue the thought without any pause.');

check('longer-then-shorter untouched',
  'First line of wrapped prose is quite long indeed, much longer.\nShort.',
  'First line of wrapped prose is quite long indeed, much longer.\nShort.');

check('short list item NOT punctuated',
  '- Item one\n- A much longer item two with plenty of text.',
  'Item one\nA much longer item two with plenty of text.');

check('numbered list NOT punctuated',
  '1. First\n2. Second point is considerably longer than the first one.',
  'First\nSecond point is considerably longer than the first one.');

check('blockquote NOT punctuated',
  '> A short quote\n> A much longer quote line follows right here.',
  'A short quote\nA much longer quote line follows right here.');

check('heading before blank line (standalone rule)',
  'Intro paragraph ends here.\n\nTitle Heading\n\nBody paragraph.',
  'Intro paragraph ends here.\n\nTitle Heading.\n\nBody paragraph.');

check('md heading still gets period + own paragraph',
  '## A Heading\nParagraph text follows immediately.',
  'A Heading.\n\nParagraph text follows immediately.');

check('terminal heading at EOF untouched',
  'A paragraph.\nA trailing heading',
  'A paragraph.\nA trailing heading');

check('heading + longer next; next stays candidate-free',
  'Title\nThis body line is longer than the title.\nAnd a final line.',
  'Title.\nThis body line is longer than the title.\nAnd a final line.');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
