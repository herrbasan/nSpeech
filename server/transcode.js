/**
 * PCM → compressed audio transcoding relay.
 *
 * Spawns ffmpeg as a child process, pipes raw PCM (s16le, 24kHz, mono)
 * into stdin, and yields compressed audio chunks (MP3, Opus, AAC) from
 * stdout. This is the bridge between the Python worker (which streams
 * raw PCM) and the browser (which needs a MediaSource-compatible format).
 *
 * Why not PyAV in the worker? libmp3lame is not compiled into any PyAV
 * wheel on Windows. nVideo's bundled ffmpeg has libmp3lame, libopus, aac.
 * Why not nVideo's native transcode()? It's file-to-file only. We need
 * streaming (pipe stdin → stdout) for low-latency chunked delivery.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger.child('transcode');

/** Format → ffmpeg encoder + output muxer.
 *
 * MP3: suppress ID3 tags (-id3v2_version 0 -write_id3v1 0) because
 * MediaSource Extensions reject ID3-tagged MP3 in some browsers.
 * Without tags, the stream starts directly with MP3 frame sync (0xFF). */
const FORMAT_ARGS = {
  mp3:  ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_id3v1', '0', '-f', 'mp3'],
  opus: ['-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg', '-ar', '48000'],
  aac:  ['-c:a', 'aac', '-b:a', '128k', '-f', 'adts'],
};

/**
 * Spawn an ffmpeg process that reads raw PCM from stdin and writes
 * compressed audio to stdout.
 *
 * @param {string} outputFormat — 'mp3', 'opus', or 'aac'
 * @param {object} opts — { sampleRate (default 24000), channels (default 1) }
 * @returns {{ process: ChildProcess, stdout: ReadableStream }}
 */
export function createTranscoder(outputFormat, opts = {}) {
  const sampleRate = opts.sampleRate ?? 24000;
  const channels = opts.channels ?? 1;

  const encoderArgs = FORMAT_ARGS[outputFormat];
  if (!encoderArgs) {
    throw new Error(`Unsupported transcode format: ${outputFormat}. Supported: ${Object.keys(FORMAT_ARGS)}`);
  }

  if (!existsSync(config.ffmpegPath)) {
    throw new Error(`ffmpeg not found at ${config.ffmpegPath}. Run nVideo setup (lib/nvideo/scripts/download-ffmpeg.js).`);
  }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels),
    '-i', 'pipe:0',
    ...encoderArgs,
    'pipe:1',
  ];

  log.info(`spawning ffmpeg: ${outputFormat} ${sampleRate}Hz ${channels}ch`);

  const proc = spawn(config.ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Collect stderr for error diagnostics — don't let it block.
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });

  proc.on('error', (err) => {
    log.error(`ffmpeg spawn error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      log.error(`ffmpeg exited code=${code}: ${stderrBuf.trim()}`);
    }
  });

  // Expose stderr for the caller to read on failure.
  proc._stderrBuf = () => stderrBuf;

  return proc;
}

/**
 * Pipe a PCM response body (from a worker fetch) through ffmpeg and
 * stream the compressed output to a raw HTTP response.
 *
 * Used by both /v1/audio/speech (JSON relay) and /v1/voices/preview
 * (multipart relay) — any path where the worker returns raw PCM and
 * the browser needs MP3/Opus/AAC for MediaSource playback.
 *
 * @param {Readable} pcmStream — Node Readable of raw PCM bytes (from Readable.fromWeb)
 * @param {object} rawResponse — the raw HTTP response (reply.raw after reply.hijack())
 * @param {string} outputFormat — 'mp3', 'opus', or 'aac'
 * @param {object} opts — { streamMode (for X-Stream-Mode header) }
 * @returns {void}
 */
export function pipePcmToClient(pcmStream, rawResponse, outputFormat, opts = {}) {
  const streamMode = opts.streamMode ?? 'native';

  let ff;
  try {
    ff = createTranscoder(outputFormat);
  } catch (err) {
    if (!rawResponse.destroyed) {
      rawResponse.writeHead(500, { 'Content-Type': 'application/json' });
      rawResponse.end(JSON.stringify({
        error: { message: `Transcoder unavailable: ${err.message}`, type: 'engine_error', code: 'transcode_failed' },
      }));
    }
    return;
  }

  // Worker stream error (socket close, GPU error after 200 headers) —
  // must NOT crash the Node server. Tear down ffmpeg cleanly.
  pcmStream.on('error', (err) => {
    log.warn(`worker stream error: ${err.message}`);
    if (!ff.killed) {
      ff.stdin.destroy();
      ff.kill();
    }
  });

  pcmStream.pipe(ff.stdin);

  ff.stdin.on('error', () => {
    if (!ff.killed) ff.kill();
  });

  rawResponse.writeHead(200, {
    'Content-Type': FORMAT_CONTENT_TYPES[outputFormat] ?? 'application/octet-stream',
    'X-Stream-Mode': streamMode,
    'Cache-Control': 'no-cache',
  });

  ff.stdout.on('data', (chunk) => {
    if (!rawResponse.destroyed) {
      rawResponse.write(chunk);
    }
  });

  ff.stdout.on('end', () => {
    if (!rawResponse.destroyed) {
      rawResponse.end();
    }
  });

  ff.stdout.on('error', () => {
    if (!rawResponse.destroyed) {
      rawResponse.end();
    }
  });
}

/** Format → Content-Type header (mirrors formats.js getContentType). */
const FORMAT_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
  pcm_f32: 'application/octet-stream',
};
