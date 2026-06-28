/**
 * nSpeech Node logger — adapter over the canonical nLogger submodule
 * (lib/nlogger). nLogger is the shared logging library across the stack;
 * this wrapper adapts its API to the call shape used throughout server/.
 *
 * Preserved surface (no call-site changes needed):
 *   logger.setLogDir(dir)        — create the singleton, pointing at dir
 *   logger.setLevel(level)       — DEBUG/INFO/WARN/ERROR threshold
 *   logger.child(category)       — { info, warn, error, debug }(msg, meta)
 *   logger.info/warn/error/debug(msg, meta, category)
 *
 * nLogger writes:
 *   - logs/main-0.log (rolling JSONL, machine-parseable)
 *   - logs/<timestamp>-<session>.log (human-readable per-session)
 *
 * The Python worker writes nLogger-format JSONL too; aligning its target
 * file with main-0.log unifies engine and server logs in one stream.
 */
import { createLogger, getLogger } from '../lib/nlogger/src/logger.js';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

let _level = 'INFO';
let _created = false;

function ensure(dir) {
  if (!_created) {
    createLogger({
      logsDir: dir,
      sessionPrefix: 'nspeech',
    });
    _created = true;
  }
  return getLogger();
}

function atLeast(level) {
  return (LEVELS[level] ?? LEVELS.INFO) >= (LEVELS[_level] ?? LEVELS.INFO);
}

function makeChild(category) {
  return {
    debug: (msg, meta = {}) => {
      if (!atLeast('DEBUG')) return;
      ensure().debug(msg, meta || {}, category);
    },
    info: (msg, meta = {}) => {
      if (!atLeast('INFO')) return;
      ensure().info(msg, meta || {}, category);
    },
    warn: (msg, meta = {}) => {
      if (!atLeast('WARN')) return;
      ensure().warn(msg, meta || {}, category);
    },
    // nSpeech child.error is (msg, meta); nLogger.error is (msg, error, meta, type).
    error: (msg, meta = {}) => {
      if (!atLeast('ERROR')) return;
      ensure().error(msg, null, meta || {}, category);
    },
  };
}

export const logger = {
  setLogDir(dir) {
    ensure(dir);
  },

  setLevel(level) {
    _level = (level || 'INFO').toUpperCase();
    // nLogger gates debug() on DEBUG/NODE_ENV; honor a DEBUG threshold by
    // enabling that env flag so debug entries are emitted.
    if (_level === 'DEBUG') process.env.DEBUG = '1';
  },

  child(category) {
    return makeChild(category);
  },

  debug: (msg, meta = {}, category = 'node') => {
    if (!atLeast('DEBUG')) return;
    ensure().debug(msg, meta || {}, category);
  },
  info: (msg, meta = {}, category = 'node') => {
    if (!atLeast('INFO')) return;
    ensure().info(msg, meta || {}, category);
  },
  warn: (msg, meta = {}, category = 'node') => {
    if (!atLeast('WARN')) return;
    ensure().warn(msg, meta || {}, category);
  },
  error: (msg, meta = {}, category = 'node') => {
    if (!atLeast('ERROR')) return;
    ensure().error(msg, null, meta || {}, category);
  },
};
