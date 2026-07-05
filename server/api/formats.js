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
