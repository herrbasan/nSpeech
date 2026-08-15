## Test Report: Server-Side Batch Stitching

**Setup:** ElevenLabs / Melon 3 (`tLz0KTPteAXd06XSE8k3`) / `eleven_v3`, `extra_body: { batch: true }`, MP3 output, from RAUM client.

### Results

| Test | Input | Result |
|---|---|---|
| Single chunk | ~20 chars | OK, 4.0 s, 26 KB |
| Two chunks | 6000 chars | OK, **200.5 s**, 7642 KB |

The 2-chunk response is a valid MP3 of expected size. Client-side chunking is now removed from RAUM — we send full text in one request, exactly the API we wanted.

### Issues

1. **200 s for 2 chunks ≈ 2× the naive client loop** (old approach: 2 streaming requests + 5 s sleep ≈ 90–120 s). Per-chunk cost roughly doubled. Suspects:
   - Batch path uses the *non-streaming* ElevenLabs endpoint — possibly slower per chunk than streaming; TTFC is irrelevant in batch mode so streaming endpoint may be the better choice for chunk generation
   - Alignment serialized after all generation — pipelining (align joint N while generating chunk N+1) would hide align cost
   - Overlap re-render adds ~10–15% text per joint, doesn't fully explain 2×

2. **No progress visibility.** `/v1/admin/events` shows only worker lifecycle. A 4-chunk job is a black box for minutes — we aborted a real job after ~5 min that was probably fine (STT worker showed `inFlight: 1`). Needs events like `chunk_generated {n, total, ms}`, `joint_aligned {n, ms}`, `stitch_complete {ms}`. Also verify abort cleanup — `inFlight` stayed 1 after client disconnect.

3. **Seam quality unverified** — haven't listened to a joint yet. Will report after audio review.

### Priority suggestions

1. Per-request progress events
2. Profile the 200 s (generation vs align vs transcode) — free after (1)
3. Pipeline align with generation
4. Streaming endpoint for chunk generation if profile points there
5. Abort cleanup verification

