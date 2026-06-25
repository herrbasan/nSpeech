/**
 * nLogger-compatible JSON Lines logger for Node.
 * Matches the Python logger format:
 *   {"ts":"ISO","level":"LEVEL","type":"Category","msg":"text","meta":{},"session":"id"}
 *
 * Output: stdout (INFO+) and rotating file (DEBUG+, 10MB × 5).
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SESSION_ID = randomUUID().slice(0, 8);
const MAX_BYTES = 10 * 1024 * 1024;
const BACKUP_COUNT = 5;

let _logDir = null;
let _logPath = null;
let _stream = null;
let _level = 'INFO';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function setLogDir(logDir) {
  _logDir = resolve(logDir);
  if (!existsSync(_logDir)) mkdirSync(_logDir, { recursive: true });
  _logPath = resolve(_logDir, 'nspeech.log');
  openStream();
}

function setLevel(level) {
  _level = (level || 'INFO').toUpperCase();
}

function openStream() {
  _stream = createWriteStream(_logPath, { flags: 'a' });
  _stream.on('error', (err) => {
    // File logging is best-effort; never crash the server over a log write.
    process.stderr.write(`[logger] file write error: ${err.message}\n`);
  });
}

/** Rotate the log file if it exceeds MAX_BYTES. */
function maybeRotate() {
  try {
    const stat = statSync(_logPath);
    if (stat.size < MAX_BYTES) return;
  } catch {
    return;
  }

  _stream.end();
  for (let i = BACKUP_COUNT - 1; i > 0; i--) {
    const from = `${_logPath}.${i}`;
    const to = `${_logPath}.${i + 1}`;
    try {
      if (existsSync(from)) {
        if (i + 1 > BACKUP_COUNT) continue;
        renameSync(from, to);
      }
    } catch { /* best-effort */ }
  }
  try {
    renameSync(_logPath, `${_logPath}.1`);
  } catch { /* best-effort */ }
  openStream();
}

function write(level, category, msg, meta = {}) {
  if (LEVELS[level] === undefined) level = 'INFO';
  if (LEVELS[level] < LEVELS[_level]) return;

  const entry = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    level,
    type: category,
    msg,
    meta,
    session: SESSION_ID,
  };

  const line = JSON.stringify(entry);

  // Console: stdout for INFO+, stderr for WARN+
  if (level === 'WARN' || level === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }

  // File: all levels
  if (_stream) {
    _stream.write(line + '\n');
    maybeRotate();
  }
}

export const logger = {
  setLogDir,
  setLevel,

  debug: (msg, meta, category = 'node') => write('DEBUG', category, msg, meta),
  info:  (msg, meta, category = 'node') => write('INFO',  category, msg, meta),
  warn:  (msg, meta, category = 'node') => write('WARN',  category, msg, meta),
  error: (msg, meta, category = 'node') => write('ERROR', category, msg, meta),

  /** Create a child logger with a fixed category. */
  child: (category) => ({
    debug: (msg, meta) => write('DEBUG', category, msg, meta),
    info:  (msg, meta) => write('INFO',  category, msg, meta),
    warn:  (msg, meta) => write('WARN',  category, msg, meta),
    error: (msg, meta) => write('ERROR', category, msg, meta),
  }),
};
