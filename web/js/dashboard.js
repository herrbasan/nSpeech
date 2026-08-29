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
