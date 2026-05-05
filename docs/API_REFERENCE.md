# nSpeech API Reference

nSpeech provides both HTTP REST and WebSocket APIs for text-to-speech generation, voice cloning, and management. It also offers a drop-in compatibility route for OpenAI's SDKs.

---

## 1. OpenAI Compatible Endpoint

A proxy endpoint that allows you to use standard `openai` SDKs seamlessly with nSpeech models.

### `POST /v1/audio/speech`
Generates audio from input text using OpenAI-compatible payload structures.

**Request Body (JSON):**
```json
{
  "model": "chatterbox",
  "input": "The quick brown fox jumps over the lazy dog.",
  "voice": "default",
  "response_format": "mp3",
  "speed": 1.0
}
```
*Field Mapping:*
* `model` maps to the nSpeech `engine` (e.g. `chatterbox`).
* `input` maps to the text to speak.
* `voice` maps to the `.wav` voice file name in memory.
* `response_format` maps to `output_format` (supports `mp3`, `wav`, `pcm`).
* `speed` is mapped to nSpeech's exaggeration setting inversely for demonstration.

**Response:**
Returns chunked audio data using `Transfer-Encoding: chunked`. Stream playback can begin instantly on the client side.

---

## 2. Standard REST API Endpoints

### `POST /tts`
Streaming synthesis endpoint. Generates spoken audio for the provided text.

**Request Body (JSON):**
```json
{
  "text": "Hello world",
  "voice_name": "default",
  "engine": "chatterbox",
  "exaggeration": 0.5,
  "output_format": "mp3",
  "transcode_bitrate": "128k",
  "transcode_sample_rate": 24000
}
```

**Response:**
Binary audio stream (Content-Type depends on `output_format`).

---

### `GET /voices`
Lists all available voice samples and their cached engine embeddings.

**Response (JSON):**
```json
{
  "voices": [
    {
      "name": "desktop",
      "source_file": "desktop.wav",
      "engines": [
        {
          "name": "chatterbox",
          "cached": true,
          "latency_tier": "standard"
        }
      ]
    }
  ]
}
```

---

### `POST /voices/clone`
Uploads a `.wav` file, clones the voice into the specified engine, and saves the tensor cache for instant loading later.

**Form Data:**
* `file`: (File) The reference `.wav` audio.
* `name`: (String) The ID/Name to save this voice as.
* `engine`: (String, Optional) The engine to clone against (defaults to environment config).
* `exaggeration`: (Float, Default: 0.5) Voice expression multiplier.

**Response:**
```json
{
  "status": "success",
  "message": "Voice 'my_voice' cloned and cached successfully.",
  "voice_name": "my_voice",
  "engine": "chatterbox",
  "generation_time_sec": 1.2
}
```

---

### `GET /health`
Returns server status and default configuration flags.

**Response (JSON):**
```json
{
  "status": "ok",
  "default_engine": "chatterbox"
}
```

---

## 3. WebSocket Streaming API

For ultra-low latency implementations, the WebSocket API allows the client to send a generation request and immediately receive raw binary audio frames as the backend produces them.

### `WS /ws/tts`

**Connection Flow:**
1. Client opens connection to `ws://host:port/ws/tts`.
2. Client sends a JSON payload describing the request.
3. Server streams pure **binary frames** containing the audio codec frames (e.g., MP3 chunks or PCM buffers).
4. Server sends a final JSON frame indicating completion: `{"is_final": true}`.

**Initial Request (Client -> Server, JSON):**
```json
{
  "text": "Here are today's headlines. First, the weather...",
  "voice_name": "default",
  "engine": "chatterbox",
  "output_format": "mp3",
  "exaggeration": 0.5,
  "transcode_bitrate": "128k",
  "transcode_sample_rate": 24000
}
```

**Response Stream (Server -> Client):**
1. `Binary Frame` (Audio Bytes)
2. `Binary Frame` (Audio Bytes)
3. `...`
4. `Text Frame` (JSON Completion Flag):
```json
{
  "is_final": true
}
```

## 4. UI Dashboard
A fully functional testing UI with WebSocket, MediaSource API, and REST integration is bundled natively.
* Viewable in browser at: `GET /`