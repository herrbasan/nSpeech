/**
 * Engine registry — loads registry.json and resolves venv paths.
 *
 * Each entry maps an engine name to its venv Python, worker module, and GPU flag.
 * Paths are relative to the project root and resolved to absolute at load time.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

const REGISTRY_PATH = resolve(__dirname, 'registry.json');

/** Load and resolve the registry. Fails fast if the file is missing or invalid. */
function loadRegistry() {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const resolved = {};

  for (const [name, entry] of Object.entries(raw)) {
    resolved[name] = {
      ...entry,
      venv_python: resolve(PROJECT_ROOT, entry.venv_python),
      worker_module: entry.worker_module,
      gpu: entry.gpu ?? false,
    };
  }

  return resolved;
}

export const registry = loadRegistry();

/**
 * Get a registry entry, or null if the engine is not registered.
 * @param {string} name
 * @returns {object|null}
 */
export function getEntry(name) {
  return registry[name] ?? null;
}

/**
 * List all registered engine names.
 * @returns {string[]}
 */
export function listEngines() {
  return Object.keys(registry);
}

/**
 * Check if a venv Python exists for the given engine.
 * @param {string} name
 * @returns {boolean}
 */
export function venvExists(name) {
  const entry = getEntry(name);
  if (!entry) return false;
  return existsSync(entry.venv_python);
}

export { PROJECT_ROOT };
