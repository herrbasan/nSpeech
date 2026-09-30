/**
 * Emotion A/B for MiniMax — is emotion real or seed noise?
 *
 * MiniMax has no seed parameter (checked: official T2A reference, our doc),
 * so single renders can't separate effect from sampling variance. This renders
 * the SAME sentence twice per emotion; listen for the pattern across both.
 *
 *   node scripts/test-emotion-ab.js
 *
 * Output: logs/emotion-ab/<emotion>-<take>.mp3
 */
'use strict';

import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = 'http://127.0.0.1:2233';
const MODEL = 'minimax';
const VOICE = 'Melon_DE';
const TEXT = 'Ich habe heute noch drei Termine, aber am zwölften September bin ich frei.';
const TAKES = 2;

// MiniMax's documented enum: happy, sad, angry, fearful, disgusted, surprised,
// calm, fluent, whisper (plus auto = omit). LIVE 2026-09-24: speech-2.8 models
// REJECT 'whisper' (base_resp 2013 "speech 2.8 don't support whisper") and
// 'disgusted' is rarely distinguishable by ear — both skipped.
const LIST = ['', 'happy', 'sad', 'angry', 'fearful', 'surprised', 'calm', 'fluent'];

await mkdir('logs/emotion-ab', { recursive: true });

for (const emotion of LIST) {
  for (let take = 1; take <= TAKES; take++) {
    const eb = { batch: true };
    if (emotion) eb.emotion = emotion;
    const res = await fetch(`${BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: TEXT, voice: VOICE, response_format: 'mp3', extra_body: eb }),
    });
    if (!res.ok) {
      console.error(`FAIL ${emotion || 'auto'} #${take}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    const label = emotion || 'auto';
    const file = `logs/emotion-ab/${label}-${take}.mp3`;
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    console.log(`ok   ${file}`);
  }
}
console.log(`\nDone — compare takes within one emotion, then across emotions.`);
