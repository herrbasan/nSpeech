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
