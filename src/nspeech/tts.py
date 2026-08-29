"""
TTS Engine Manager and Adapter Protocol

Enforces structural typing for TTS engine adapters and manages lazy loading / routing.
No base classes are used per project maxims. Adapters are duck-typed to `TTSAdapterProtocol`.
"""
import importlib
import time
from typing import Protocol, Tuple, Generator, Dict, Any

import torch
from nspeech import config

class TTSAdapterProtocol(Protocol):
    """
    Structural contract for all nSpeech TTS engines.
    Adapters must be placed in `src/nspeech/engines/<engine_name>.py`.
    """
    
    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        """
        Takes raw text, performs sentence-level chunking internally, and yields Audio chunks.
        Must return normalized Audio: PCM 24kHz mono float32.
        
        Yields:
            (pcm_tensor, is_final): 
                - pcm_tensor: The chunk audio.
                - is_final: Boolean indicating if this is the last chunk.
        """
        ...

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Compute an engine-specific embedding/caching artifact from a reference `.wav` file.
        Must save to `voices/<voice_name>.<engine_name>.pt`.
        
        Returns:
            Dictionary containing clone metadata (clone_time_ms, cache_file, etc.)
        """
        ...

    def load_voice(self, voice_name: str) -> None:
        """
        Load a cached voice embedding for subsequent generate() calls.
        Fails fast if the file `voices/<voice_name>.<engine_name>.pt` doesn't exist.
        """
        ...

    def list_voices(self) -> list:
        """
        Return a list of voice dicts for this engine.
        Each dict: {"voice_id": str, "name": str, "category": "builtin"|"cloned"|"blended"}
        """
        ...

    def is_loaded(self) -> bool:
        """
        Return True if the engine's model weights are resident in memory.
        Used by /health to distinguish 'warming' from 'ready'.
        """
        ...

    def unload(self) -> None:
        """
        Release model weights and free VRAM/RAM. Called before killing a worker
        or when evicting an idle engine. After this, the adapter is unusable.
        """
        ...


# Simple LRU-style cache for active engines
_engine_cache: Dict[str, TTSAdapterProtocol] = {}
_engine_last_used: Dict[str, float] = {}

def get_engine(engine_name: str = None) -> TTSAdapterProtocol:
    """
    Lazy load an engine by name (falling back to config.NSPEECH_ENGINE).
    """
    if engine_name is None:
        engine_name = config.NSPEECH_ENGINE
        
    if engine_name in _engine_cache:
        _engine_last_used[engine_name] = time.time()
        return _engine_cache[engine_name]

    # Chatterbox: only turbo remains; it shares the chatterbox adapter module
    # with a model_type argument.
    CHATTERBOX_MODELS = {
        "chatterbox-turbo": "turbo",
    }
    # F5 family — f5tts-german shares the f5tts adapter module; the German
    # checkpoint is selected via NSPEECH_F5_MODEL/NSPEECH_F5_CKPT env (set
    # per-engine in registry.json).
    F5_MODULE_ALIAS = {"f5tts-german": "f5tts"}
    # Explicit adapter class names for engines whose .title() doesn't match.
    ADAPTER_CLASSES = {
        "f5tts": "F5TtsAdapter",
        "f5tts-german": "F5TtsAdapter",
        "vibevoice": "VibevoiceAdapter",
    }
    if engine_name in CHATTERBOX_MODELS:
        module = importlib.import_module("nspeech.engines.chatterbox")
        adapter_class = module.ChatterboxAdapter
        print(f"Loading engine {engine_name} into memory (model={CHATTERBOX_MODELS[engine_name]})...")
        adapter_instance = adapter_class(model_type=CHATTERBOX_MODELS[engine_name])
    else:
        # Lazy dynamic import from src/nspeech/engines/ (family aliases resolve
        # to the shared module, e.g. f5tts-german → nspeech.engines.f5tts)
        module_name = F5_MODULE_ALIAS.get(engine_name, engine_name)
        try:
            module = importlib.import_module(f"nspeech.engines.{module_name}")
        except ModuleNotFoundError as e:
            raise ValueError(f"TTS Engine '{engine_name}' not found. Make sure src/nspeech/engines/{module_name}.py exists.") from e

        if engine_name in ADAPTER_CLASSES:
            class_name = ADAPTER_CLASSES[engine_name]
            if not hasattr(module, class_name):
                raise TypeError(f"Module {engine_name}.py must contain class {class_name}.")
            adapter_class = getattr(module, class_name)
        else:
            # Convention: EngineName title cased + Adapter
            class_name = engine_name.title() + "Adapter"
            if hasattr(module, class_name):
                adapter_class = getattr(module, class_name)
            else:
                # Fallback: scan for any class ending in 'Adapter'
                adapters = [v for k, v in module.__dict__.items() if isinstance(v, type) and k.endswith("Adapter")]
                if not adapters:
                    raise TypeError(f"Module {engine_name}.py must contain a class implementing TTSAdapterProtocol.")
                adapter_class = adapters[0]

        print(f"Loading engine {engine_name} into memory...")
        adapter_instance = adapter_class()
    
    _engine_cache[engine_name] = adapter_instance
    _engine_last_used[engine_name] = time.time()
    
    return adapter_instance


def mark_engine_used(engine_name: str = None):
    """Update the last_used timestamp to keep the engine resident."""
    if engine_name is None:
        engine_name = config.NSPEECH_ENGINE
    if engine_name in _engine_last_used:
        _engine_last_used[engine_name] = time.time()


def evict_idle_engines():
    """
    Checks all cached engines and clears VRAM if they've exceeded the idle timeout.
    Usually called by a background worker loop in the API.
    """
    timeout = config.NSPEECH_MODEL_IDLE_TIMEOUT_SEC
    if timeout <= 0:
        return
        
    current_time = time.time()
    evicted = []
    
    # Needs to list(keys()) to mutate dict during iteration
    for eng_name, last_used in list(_engine_last_used.items()):
        if current_time - last_used > timeout:
            evicted.append(eng_name)
            
    for eng_name in evicted:
        print(f"[{eng_name}] Idle timeout exceeded (> {timeout}s). Evicting from VRAM...")
        # Free references
        del _engine_cache[eng_name]
        del _engine_last_used[eng_name]
        
    if evicted:
        # Force Python GC to reclaim the adapter classes
        import gc
        gc.collect()
        # Force PyTorch CUDA allocator to actually return blocks to the OS
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            print(f"[Memory] VRAM cleared. Cuda memory allocated: {torch.cuda.memory_allocated() / 1024 / 1024:.1f}MB")
