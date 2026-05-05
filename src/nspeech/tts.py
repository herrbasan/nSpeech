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


# Simple LRU-style cache for active engines
_engine_cache: Dict[str, TTSAdapterProtocol] = {}
_engine_last_used: Dict[str, float] = {}

def get_engine(engine_name: str = None) -> TTSAdapterProtocol:
    """
    Lazy load an engine by name (falling back to config.NSPEECH_ENGINE).
    Evicts idle engines if necessary (LRU logic).
    """
    if engine_name is None:
        engine_name = config.NSPEECH_ENGINE
        
    # Note: Proper LRU eviction based on memory or timeout params can go here.
    if engine_name in _engine_cache:
        _engine_last_used[engine_name] = time.time()
        return _engine_cache[engine_name]

    # Lazy dynamic import from src/nspeech/engines/
    try:
        module = importlib.import_module(f"nspeech.engines.{engine_name}")
    except ModuleNotFoundError as e:
        raise ValueError(f"TTS Engine '{engine_name}' not found. Make sure src/nspeech/engines/{engine_name}.py exists.") from e

    # Find the adapter class (convention: EngineName title cased + Adapter)
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
