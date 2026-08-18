/**
 * generate-widget.js — shared generate/playback widget for engine pages.
 *
 * Owns the full playback UI so engine pages only declare their controls:
 *   - generation progress line: server job stage + percent (SSE) + TTFB
 *   - playback: nui-media-player (skinned transport: play/pause, seek,
 *     volume) driven by the SDK SpeechPlayer via MSE
 *   - download link for the rendered audio
 *
 * Usage (nui/page scripts can't import — the shell exposes this on window):
 *   const widget = nspeechMountGenerate(element, {
 *       filename: 'f5tts-speech.mp3',
 *       buildParams: () => ({ model, input, voice, speed, extraBody }),
 *   });
 *   element.hide = () => widget.stop();
 *
 * buildParams() returns NSpeechClient.speech() params; `clean` is supported
 * (applied client-side before send). The widget mounts after the element's
 * [data-generate-anchor] node (or appends to the first nui-card).
 */

import { SpeechPlayer, cleanMarkdown } from '/lib/nspeech-client/nspeech-client.js';

const CSS = `
.ns-gen { margin-top: var(--nui-space-double); display: none; }
.ns-gen.active { display: block; }
.ns-gen-genbar { position: relative; height: 4px; border-radius: 2px; background: var(--color-shade2); overflow: hidden; margin-bottom: var(--nui-space-half); transition: opacity 200ms; }
.ns-gen-genbar.idle { opacity: 0; }
.ns-gen-genfill { position: absolute; inset: 0 auto 0 0; width: 0%; background: var(--color-highlight); transition: width 200ms linear; }
.ns-gen-meta { display: flex; align-items: center; gap: var(--nui-space); margin-top: var(--nui-space-half); }
.ns-gen-status { color: var(--color-shade6); font-size: 0.85em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ns-gen-download { color: var(--color-highlight); text-decoration: underline; cursor: pointer; white-space: nowrap; font-size: 0.85em; }
.ns-gen nui-media-player { display: block; }
`;

let stylesInjected = false;
function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function mountGenerate(element, { filename = 'speech.mp3', buildParams }) {
    if (typeof buildParams !== 'function') throw new Error('mountGenerate: buildParams required');
    injectStyles();

    // ── DOM ─────────────────────────────────────────────────────────────
    // The media player wraps a persistent <audio>; SpeechPlayer plays through
    // it (external audio mode) so the component's own listeners stay attached.
    const root = document.createElement('div');
    root.className = 'ns-gen';
    root.innerHTML = `
        <div class="ns-gen-genbar idle"><div class="ns-gen-genfill"></div></div>
        <nui-media-player type="audio"><audio preload="auto"></audio></nui-media-player>
        <div class="ns-gen-meta">
            <span class="ns-gen-status"></span>
            <a class="ns-gen-download" style="display:none">⬇ Download</a>
        </div>`;
    const anchor = element.querySelector('[data-generate-anchor]');
    if (anchor) anchor.insertAdjacentElement('afterend', root);
    else (element.querySelector('nui-card') || element).appendChild(root);

    const genBar = root.querySelector('.ns-gen-genbar');
    const genFill = root.querySelector('.ns-gen-genfill');
    const statusEl = root.querySelector('.ns-gen-status');
    const downloadEl = root.querySelector('.ns-gen-download');
    const audioEl = root.querySelector('audio');

    // ── Player ──────────────────────────────────────────────────────────
    const player = new SpeechPlayer({ client: window.nspeech.client, audio: audioEl });
    let startTime = 0;
    let ttfbMs = null;
    let generating = false;
    let unsubProgress = null;

    function setStatus(text) { statusEl.textContent = text; }

    function setGenProgress(percent) {
        if (percent == null) {
            genBar.classList.add('idle');
            return;
        }
        genBar.classList.remove('idle');
        genFill.style.width = `${percent}%`;
    }

    // Server-side job progress (chunking runs). Uncorrelated feed — only
    // shown while THIS widget has a generation in flight, which matches the
    // dashboard's single-user reality.
    function onServerProgress({ stage, percent, chunk, totalChunks }) {
        if (!generating) return;
        if (stage === 'done' || stage === 'failed') return; // completion handled by download-complete
        const label = chunk ? `${stage} ${chunk}/${totalChunks}` : stage;
        setGenProgress(percent);
        setStatus(`Rendering — ${label} (${percent ?? 0}%)${ttfbMs != null ? '' : ' · waiting for first audio'}`);
    }

    player.on('state', ({ state }) => {
        if (state === 'idle') {
            generating = false;
            if (unsubProgress) { unsubProgress(); unsubProgress = null; }
        }
    });

    player.on('download-progress', ({ bytes }) => {
        if (ttfbMs == null && bytes > 0) {
            ttfbMs = performance.now() - startTime;
            if (!unsubProgress) {
                setStatus(`Streaming — ${fmtBytes(bytes)} · TTFB ${ttfbMs.toFixed(0)}ms`);
            }
        }
    });

    player.on('download-complete', ({ bytes }) => {
        generating = false;
        if (unsubProgress) { unsubProgress(); unsubProgress = null; }
        setGenProgress(null);
        const totalMs = performance.now() - startTime;
        const url = player.getAudioUrl();
        if (url) {
            downloadEl.href = url;
            downloadEl.download = filename;
            downloadEl.style.display = '';
        }
        setStatus(`Done — ${fmtBytes(bytes)} in ${(totalMs / 1000).toFixed(1)}s (TTFB ${(ttfbMs ?? totalMs).toFixed(0)}ms)`);
    });

    player.on('error', ({ error }) => {
        generating = false;
        if (unsubProgress) { unsubProgress(); unsubProgress = null; }
        setGenProgress(null);
        setStatus(`Error: ${error?.message || error}`);
    });

    // ── Public API ──────────────────────────────────────────────────────
    const widget = {
        player,

        /** Start generation. Reads params from buildParams(); sends via SDK. */
        generate() {
            const params = buildParams();
            if (!params || !params.input) return;
            if (params.clean) {
                params.input = cleanMarkdown(params.input);
                params.clean = false; // already applied — keep server out of it
            }
            downloadEl.style.display = 'none';
            if (downloadEl.href) { try { URL.revokeObjectURL(downloadEl.href); } catch (_) {} downloadEl.removeAttribute('href'); }
            root.classList.add('active');
            startTime = performance.now();
            ttfbMs = null;
            generating = true;
            setGenProgress(0);
            setStatus('Sending…');
            unsubProgress = window.nspeech.events.on('progress', onServerProgress);
            player.speak(params);
        },

        /** Stop generation/playback and reset the widget. */
        stop() {
            player.stop();
            generating = false;
            if (unsubProgress) { unsubProgress(); unsubProgress = null; }
            setGenProgress(null);
            setStatus('Stopped.');
        },

        /** Escape hatch for page-level validation messages (e.g. "select a voice"). */
        setStatus,
    };

    return widget;
}
