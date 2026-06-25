/**
 * Response format → Content-Type mapping.
 *
 * `pcm` is always OpenAI-compatible (24kHz 16-bit LE mono).
 * `pcm_f32` is nSpeech native (24kHz float32 mono).
 */
const FORMAT_CONTENT_TYPES = {
  mp3:    'audio/mpeg',
  opus:   'audio/opus',
  aac:    'audio/aac',
  flac:   'audio/flac',
  wav:    'audio/wav',
  pcm:    'audio/pcm',
  pcm_f32:'application/octet-stream',
};

/**
 * Get the Content-Type for a response_format.
 * Falls back to application/octet-stream for unknown formats.
 */
export function getContentType(format) {
  return FORMAT_CONTENT_TYPES[format] ?? 'application/octet-stream';
}

/**
 * Normalize a response_format value.
 * Defaults to 'mp3' (OpenAI default).
 */
export function normalizeFormat(format) {
  if (!format || typeof format !== 'string') return 'mp3';
  const lower = format.toLowerCase();
  return FORMAT_CONTENT_TYPES[lower] ? lower : 'mp3';
}

/**
 * Resolve an engine name from an OpenAI model string.
 *
 * Model strings can be:
 *   - Plain engine name: "kokoro", "cosyvoice", "dots"
 *   - Versioned: "cosyvoice_0.5b", "dots_mf"
 *   - Cloud: "openai_tts_1", "elevenlabs_turbo_v2_5"
 *
 * The engine name is the part before the first underscore,
 * unless it matches a known engine directly.
 */
const KNOWN_ENGINES = ['kokoro', 'cosyvoice', 'chatterbox', 'dots'];

export function resolveEngine(model) {
  if (!model) return null;

  // Direct match
  if (KNOWN_ENGINES.includes(model)) return model;

  // Try prefix before first underscore
  const prefix = model.split('_')[0];
  if (KNOWN_ENGINES.includes(prefix)) return prefix;

  // Cloud models (openai_*, elevenlabs_*, etc.) — handled in Phase 8
  if (model.startsWith('openai_') || model.startsWith('elevenlabs_')) {
    return null;  // Cloud adapter territory
  }

  return null;
}
