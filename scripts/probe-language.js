/**
 * Probe: extra_body.language normalization — offline, no server, no network.
 *
 * JS side (server/cloud/language.js): run with any node.
 *   node scripts/probe-language.js js
 *
 * Python side (f5tts/chatterbox adapters): run under the engine's venv so the
 * module imports resolve (they pull torch/librosa at module level).
 *   venv/f5tts/env/Scripts/python.exe scripts/probe-language.py f5tts
 *   venv/chatterbox/env/Scripts/python.exe scripts/probe-language.py chatterbox
 *
 * Any failed expectation exits non-zero with the case name.
 */
'use strict';

async function probeJs() {
  const { normalizeLanguage, toLanguageBoost } = await import('../server/cloud/language.js');
  const { WorkerError } = await import('../server/engine/worker.js');

  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      failures += 1;
      console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    } else {
      console.log(`ok   ${name}`);
    }
  };
  const checkThrows = (name, fn, wantStatus) => {
    try {
      fn();
      failures += 1;
      console.error(`FAIL ${name}: expected a throw, got none`);
    } catch (err) {
      if (wantStatus != null) {
        const status = err instanceof WorkerError ? err.status : undefined;
        if (status !== wantStatus) {
          failures += 1;
          console.error(`FAIL ${name}: threw ${err.constructor.name} status=${status}, want WorkerError ${wantStatus}`);
          return;
        }
      }
      console.log(`ok   ${name} (${String(err.message).slice(0, 90)}...)`);
    }
  };

  // normalizeLanguage: unset forms → null
  check('normalize undefined', normalizeLanguage(undefined), null);
  check('normalize null', normalizeLanguage(null), null);
  check('normalize empty', normalizeLanguage(''), null);
  check('normalize whitespace', normalizeLanguage('   '), null);
  // auto forms
  check('normalize auto', normalizeLanguage('auto'), 'auto');
  check('normalize AUTO', normalizeLanguage('AUTO'), 'auto');
  check('normalize padded auto', normalizeLanguage(' auto '), 'auto');
  // codes — case preserved (xAI BCP-47 needs pt-BR, not pt-br)
  check('normalize de', normalizeLanguage('de'), 'de');
  check('normalize padded de', normalizeLanguage(' de '), 'de');
  check('normalize pt-BR', normalizeLanguage('pt-BR'), 'pt-BR');
  check('normalize 3-letter', normalizeLanguage('fil'), 'fil');
  // garbage → 400 WorkerError
  checkThrows('normalize number throws', () => normalizeLanguage(42), 400);
  checkThrows('normalize object throws', () => normalizeLanguage({}), 400);
  checkThrows('normalize junk throws', () => normalizeLanguage('not a language!'), 400);

  // toLanguageBoost: MiniMax official names
  check('boost unset', toLanguageBoost(undefined), null);
  check('boost auto', toLanguageBoost('auto'), 'auto');
  check('boost de', toLanguageBoost('de'), 'German');
  check('boost en', toLanguageBoost('en'), 'English');
  check('boost yue', toLanguageBoost('yue'), 'Chinese,Yue');
  check('boost tl alias', toLanguageBoost('tl'), 'Filipino');
  check('boost padded', toLanguageBoost(' de '), 'German');
  // unsupported for MiniMax → loud 400 (pt-BR exists on xAI, NOT on MiniMax boost)
  checkThrows('boost pt-BR throws', () => toLanguageBoost('pt-BR'), 400);
  checkThrows('boost xx throws', () => toLanguageBoost('xx'), 400);
  checkThrows('boost fr-CA throws', () => toLanguageBoost('fr-CA'), 400);

  const total = failures === 0 ? 'ALL JS LANGUAGE PROBES PASSED' : `${failures} FAILURES`;
  console.log(`\n${total}`);
  if (failures) process.exit(1);
}

async function main() {
  const mode = process.argv[2] || 'js';
  if (mode !== 'js') {
    console.error(`unknown mode: ${mode} — the python probes live in probe-language.py`);
    process.exit(2);
  }
  return probeJs();
}

main().catch(err => { console.error(err); process.exit(1); });
