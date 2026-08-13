/**
 * audio-download.js — shared "download rendered audio" helper.
 *
 * Engine generate pages stream MP3 into an <audio> element (either via a
 * MediaSource, or as a single Blob). This helper collects the MP3 bytes and
 * renders a download link next to the player so users can save the rendered
 * audio — e.g. to clone one engine's voice design into another.
 *
 * Loaded as a plain (non-module) script in index.html. Exposes the global
 * `window.nspeechAudioDownload`. Page scripts (type="nui/page") run in the
 * same realm as the document, so they can call it directly.
 */
(function () {
  'use strict';

  /**
   * Accumulate streamed MP3 chunks, then produce an object URL for download.
   * Usage (MediaSource streaming pages):
   *   const collector = nspeechAudioDownload.createCollector();
   *   // in the read loop, next to sourceBuffer.appendBuffer(value):
   *   collector.push(value);
   *   // once mediaSource.endOfStream() runs:
   *   nspeechAudioDownload.attachDownload(audio, collector.buildURL(filename), filename);
   */
  function createCollector() {
    const chunks = [];
    let url = null;

    return {
      push(chunk) {
        if (chunk && chunk.length) chunks.push(chunk);
      },
      buildURL(filename = 'speech.mp3') {
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
        return url;
      },
      reset() {
        chunks.length = 0;
        if (url) {
          URL.revokeObjectURL(url);
          url = null;
        }
      },
    };
  }

  /**
   * Render (or refresh) a download link after `refEl` (the audio element).
   * Removes any previously attached download link in the same container.
   */
  function attachDownload(refEl, url, filename = 'speech.mp3') {
    const host = refEl && refEl.parentNode;
    if (!host) return null;

    const prev = host.querySelector('[data-nspeech-download]');
    if (prev) prev.remove();

    const a = document.createElement('a');
    a.dataset.nspeechDownload = '1';
    a.href = url;
    a.download = filename;
    a.textContent = '⬇ Download MP3';
    a.style.cssText =
      'display:inline-block;margin-top:var(--nui-space);' +
      'color:var(--color-highlight);cursor:pointer;text-decoration:underline;';

    refEl.insertAdjacentElement('afterend', a);
    return a;
  }

  /**
   * Convenience for batch pages that already hold a Blob (e.g. xAI):
   * wraps the Blob in an object URL and attaches a download link.
   */
  function attachBlob(blob, refEl, filename = 'speech.mp3') {
    const url = URL.createObjectURL(blob);
    attachDownload(refEl, url, filename);
    return url;
  }

  window.nspeechAudioDownload = {
    createCollector,
    attachDownload,
    attachBlob,
  };
})();
