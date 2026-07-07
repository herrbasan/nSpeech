/**
 * Server event bus — lightweight pub/sub for dashboard monitoring.
 *
 * Components (manager, worker, routes) emit events via emit().
 * The /v1/admin/events SSE endpoint subscribes clients to all events.
 *
 * Events are also kept in a ring buffer (last 200) so new clients
 * immediately see recent history on connect.
 */
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 200;

const bus = new EventEmitter();
bus.setMaxListeners(50); // allow multiple dashboard tabs

/** Ring buffer of recent events for replay on connect. */
const history = [];

/**
 * Emit a dashboard event.
 * @param {string} type — event category: 'engine', 'worker', 'request', 'error', 'system'
 * @param {string} message — human-readable description
 * @param {object} [meta] — structured data
 */
export function emit(type, message, meta = {}) {
  const event = {
    ts: new Date().toISOString(),
    type,
    message,
    ...meta,
  };

  history.push(event);
  if (history.length > MAX_BUFFER) history.shift();

  bus.emit('event', event);
}

/**
 * Subscribe to all events. Returns an unsubscribe function.
 * @param {(event: object) => void} listener
 * @returns {() => void}
 */
export function subscribe(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/**
 * Get recent event history (for replay on connect).
 * @returns {object[]}
 */
export function getHistory() {
  return [...history];
}
