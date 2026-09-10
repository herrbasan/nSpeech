/**
 * dashboard.js — shared SDK instances for the nSpeech dashboard.
 *
 * Creates window.nspeech = { client, events, cleanMarkdown } once, for all pages:
 *   client — NSpeechClient (REST, relative baseUrl = same origin)
 *   events — EventStream on /v1/admin/events, types tts/engine/worker,
 *            auto-connects, auto-reconnects. Progress events carry
 *            { stage, chunk, totalChunks, percent } for long-form runs.
 *   cleanMarkdown — SDK regex cleaner
 * Also preloads the generate widget: window.nspeechMountGenerate.
 * (nui/page scripts are not ES modules — they can't import, so the shell
 * exposes everything they need on window.)
 */
import { NSpeechClient, EventStream, cleanMarkdown } from '/lib/nspeech-client/nspeech-client.js';
import { mountGenerate } from '/web/js/generate-widget.js';
import '/lib/nui_wc2/NUI/lib/modules/nui-media-player.js';

const client = new NSpeechClient({ baseUrl: '' });
const events = new EventStream({ baseUrl: '', types: ['tts', 'engine', 'worker'] });
events.connect();

window.nspeech = { client, events, cleanMarkdown };
window.nspeechMountGenerate = mountGenerate;

// ── Shared cloud model-selector loader (cached) ─────────────────────────────
// Cloud generate pages call nspeechLoadModels(selectEl, engine) instead of
// hard-coding provider model names. It pulls the engine's addressable models
// from GET /v1/models (via client.listModels) and fills the <select> with
// { value: public slug, label: display name }; the provider's default is
// pre-selected unless the page already restored a saved model.
//
// The model list is cached (in-memory + localStorage, 15-min TTL) so
// navigating between pages renders the dropdown instantly instead of
// waiting on the endpoint. A cached list missing the new `engine` field
// (pre-upgrade server shape) is discarded so a stale cache can't mask a
// server restart.
const MODELS_CACHE_KEY = 'nspeech.models';
const MODELS_TTL_MS = 15 * 60 * 1000;
let _modelList = null;
let _modelListAt = 0;

function _readCachedModels() {
    try {
        const raw = localStorage.getItem(MODELS_CACHE_KEY);
        if (!raw) return null;
        const { at, data } = JSON.parse(raw);
        if (!Array.isArray(data) || (Date.now() - at) > MODELS_TTL_MS) return null;
        // Requires the new shape (an `engine` field). Old-shape data is stale.
        if (!data.some(m => m.engine !== undefined)) return null;
        return data;
    } catch { return null; }
}

async function _getModelList() {
    if (_modelList && (Date.now() - _modelListAt) < MODELS_TTL_MS) return _modelList;

    const cached = _readCachedModels();
    if (cached) {
        _modelList = cached;
        _modelListAt = Date.now();
        return _modelList;
    }

    const res = await client.listModels();
    const list = (res && res.data) || [];
    _modelList = list;
    _modelListAt = Date.now();
    try { localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ at: _modelListAt, data: list })); } catch { /* private mode — ignore */ }
    return list;
}

window.nspeechLoadModels = async (selectEl, engine) => {
    try {
        const models = (await _getModelList()).filter(m => m.engine === engine && m.id !== 'nspeech');
        if (!models.length) return;
        const data = models.map(m => ({ value: m.id, label: m.label || m.id, default: !!m.default }));
        // Preserve an already-selected model (restored from saved settings).
        const current = selectEl.value;
        const wrapper = selectEl.closest('nui-select');
        if (wrapper && typeof wrapper.setItems === 'function') {
            wrapper.setItems(data);
        } else {
            selectEl.innerHTML = data.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
        }
        const dflt = data.find(o => o.default) || data[0];
        if (current && data.some(o => o.value === current)) selectEl.value = current;
        else if (dflt) selectEl.value = dflt.value;
    } catch { /* leave the page's hard-coded placeholder */ }
};

// ── Startup warm-up ─────────────────────────────────────────────────────────
// Pre-fetch the model list and cloud voice lists in the background so pages
// render from cache immediately instead of waiting on the endpoint. Cloud
// adapters run in Node (no worker to spawn), so warming their voices is safe;
// local engine voices warm on their own page load (listing them is what
// starts/uses that worker).
async function warmUpCaches() {
    try { await _getModelList(); } catch { /* ignore */ }
    try {
        const { engines } = await client.listEngines();
        for (const e of (engines || [])) {
            if (e.type === 'cloud') client.listVoices(e.name).catch(() => {});
        }
    } catch { /* ignore */ }
}
warmUpCaches();

// ── Manual refresh (header button) ──────────────────────────────────────────
// Clears the model + voice caches and reloads the dashboard so the current
// page re-fetches fresh data from the endpoints. It also rebuilds the
// server-side voice cache — a client-side clear alone would just re-read the
// same server snapshot. Call this from a "Refresh" control.
window.nspeechRefreshData = async () => {
    localStorage.removeItem(MODELS_CACHE_KEY);
    _modelList = null;
    _modelListAt = 0;
    try { await client.refreshCache(); } catch { client.clearVoiceCache(); }
    window.location.reload();
};

// ── Per-engine generation settings persistence ─────────────────────────────
// Pages call nspeechSettings.init(element, engineKey) once in init(). It
// restores saved defaults into the page's controls, injects "Save as
// Default"/"Reset" buttons at [data-generate-anchor], and keeps the state
// in localStorage under `nspeech.settings.<engineKey>`.
//
// Persisted: range/number/checkbox inputs and non-dynamic selects (by id).
// Excluded: textareas (per-generation content), text/file inputs, and any
// control whose id contains "voice" (options load async — restore is racy).
window.nspeechSettings = (() => {
    const isPersistable = (el) => {
        if (!el.id || /voice/i.test(el.id)) return false;
        if (el.tagName === 'TEXTAREA') return false;
        if (el.tagName === 'INPUT') {
            return ['range', 'number', 'checkbox'].includes(el.type);
        }
        if (el.tagName === 'SELECT') return true;
        return false;
    };

    const snapshot = (element) => {
        const state = {};
        element.querySelectorAll('input[id], select[id], textarea[id]').forEach((el) => {
            if (!isPersistable(el)) return;
            state[el.id] = el.type === 'checkbox' ? el.checked : el.value;
        });
        return state;
    };

    const apply = (element, state) => {
        if (!state) return;
        for (const [id, val] of Object.entries(state)) {
            const el = element.querySelector('#' + id);
            if (!el) continue;
            if (el.type === 'checkbox') el.checked = !!val;
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    };

    function init(element, engineKey) {
        const storeKey = `nspeech.settings.${engineKey}`;
        // Capture the page's HTML defaults BEFORE restoring, so Reset works.
        const defaults = snapshot(element);

        try {
            const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
            apply(element, saved);
        } catch { /* corrupt entry — ignore, defaults stand */ }

        const anchor = element.querySelector('[data-generate-anchor]');
        if (!anchor) return;

        const saveBtn = document.createElement('nui-button');
        saveBtn.innerHTML = '<button type="button">Save as Default</button>';
        saveBtn.addEventListener('nui-click', () => {
            localStorage.setItem(storeKey, JSON.stringify(snapshot(element)));
            // Also push to the server (generate-widget listens, derives params
            // from the page's buildParams, PUTs /v1/defaults/<engine>).
            element.dispatchEvent(new CustomEvent('nspeech-save-defaults', { detail: { button: saveBtn } }));
            saveBtn.querySelector('button').textContent = 'Saved ✓';
            setTimeout(() => saveBtn.querySelector('button').textContent = 'Save as Default', 1500);
        });

        const resetBtn = document.createElement('nui-button');
        resetBtn.innerHTML = '<button type="button">Reset</button>';
        resetBtn.addEventListener('nui-click', () => {
            localStorage.removeItem(storeKey);
            apply(element, defaults);
            // Clear the server-side defaults too — Reset means factory state.
            fetch('/v1/defaults/' + encodeURIComponent(engineKey), { method: 'DELETE' }).catch(() => {});
        });

        anchor.append(saveBtn, resetBtn);
    }

    return { init };
})();
