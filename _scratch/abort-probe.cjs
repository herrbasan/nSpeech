// Direct nSpeech abort probe — POST stream, then abort. No auth, no chat proxy.
// Run: node _scratch/abort-probe.cjs
const BASE = 'http://localhost:2233';
// Long text so generation runs long enough to abort mid-stream.
const input = ('This is a long generation test sentence. '.repeat(60)).trim();

(async () => {
  const ac = new AbortController();
  const started = Date.now();
  const req = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: ac.signal,
    body: JSON.stringify({ model: 'nspeech', input, voice: 'BAS_DE', response_format: 'mp3', speed: 1.0 }),
  });
  console.log('[probe] status', req.status, 'content-type', req.headers.get('content-type'));
  const reader = req.body.getReader();
  let bytes = 0;
  try {
    let first = true, done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        bytes += value.byteLength;
        if (first) { console.log('[probe] first chunk at', Date.now() - started, 'ms'); first = false; }
        if (Date.now() - started > 2500) {
          console.log('[probe] aborting after', Date.now() - started, 'ms,', bytes, 'bytes');
          ac.abort();
          break;
        }
      }
    }
  } catch (e) {
    console.log('[probe] reader error:', e.name, e.message);
  }
  console.log('[probe] total bytes before abort', bytes);
  // Give the worker a moment to notice the disconnect, then we inspect logs.
  await new Promise(r => setTimeout(r, 4000));
  console.log('[probe] done');
})();
