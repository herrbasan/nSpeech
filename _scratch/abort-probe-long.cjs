// Long-input abort probe: forces chunking so there ARE between-segment
// disconnect check points. Abort after the first segment. Check logs after.
// Run: node _scratch/abort-probe-long.cjs
const BASE = 'http://localhost:2233';
const para = 'This is a long generation test paragraph with enough content to span multiple segments for testing the disconnect handling. ';
const input = para.repeat(160); // ~160*92 ≈ 14700 chars — should chunk for most engines

(async () => {
  const ac = new AbortController();
  const started = Date.now();
  const req = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ac.signal,
    body: JSON.stringify({ model: 'nspeech', input, voice: 'BAS_DE', response_format: 'mp3', speed: 1.0 }),
  });
  console.log('[probe] status', req.status, '| inputLen', input.length);
  const reader = req.body.getReader();
  let bytes = 0, chunks = 0;
  try {
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) { bytes += value.byteLength; chunks++; }
      if (Date.now() - started > 3500) { console.log('[probe] aborting at', Date.now()-started, 'ms | bytes', bytes, '| chunks', chunks); ac.abort(); break; }
    }
  } catch (e) { console.log('[probe] reader error:', e.name, e.message); }
  await new Promise(r => setTimeout(r, 5000));
  console.log('[probe] done');
})();
