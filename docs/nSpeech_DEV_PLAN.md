# nSpeech Development Plan

*Reference: [nSpeech_SPEC.md](nSpeech_SPEC.md)*

## Phase 1: Core Architecture & Interfaces (Ref: Spec "Core Conventions")
- **1. Define BaseTTSAdapter interface (`src/nspeech/tts.py`)**: 
  - Define the strict contract (`generate`, `clone`, `load_voice`) that all engines will follow.
  - Establish raw PCM (24kHz mono float32) output normalization.

## Phase 2: Server Scaffold & REST Endpoints (Ref: Spec Section 7.1 HTTP REST)
- **2. Implement FastAPI server core (`src/nspeech/server.py`)**: 
  - Boot up the framework.
  - Apply the fail-fast config loader and graceful startup checks.
- **3. Implement HTTP & OpenAI compatible endpoints**:
  - `POST /tts`
  - `POST /v1/audio/speech` (OpenAI proxy)
  - `POST /voices/clone`

## Phase 3: Real-Time Streaming & Engine Integration (Ref: Spec Section 7.2 WebSocket)
- **4. Implement WebSocket streaming endpoint**: 
  - Define `/ws/tts` to handle base64 real-time audio chunk streaming.
- **5. Implement Chatterbox engine adapter**: 
  - Build `src/nspeech/engines/chatterbox.py` adhering to our new adapter contract.
  - Implement sentence-level chunking logic driven purely by the adapter.

## Phase 4: Discovery & Validation
- **6. Implement dynamic voice listing logic** *(Ref: Spec `GET /voices`)*: 
  - Hook up `GET /voices` to scan `NSPEECH_VOICE_DIR`.
  - Report raw `.wav` clones and engine-specific `.pt` caches and latency tiers.
- **7. Create benchmarking and testing scripts**:
  - Validate model outputs and measure chunk TTFB (Time to First Byte) latency criteria.
