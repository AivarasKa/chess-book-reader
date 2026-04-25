"""Integration with the vendored Chess_diagram_to_FEN library.

The library's import graph drags in training-time dependencies (notably
`cairosvg`, which needs Cairo native DLLs that are not available on Windows
out of the box). At inference we only need the model loaders and transforms,
so we stub `cairosvg` before adding the vendor directory to `sys.path`.
"""

from __future__ import annotations

import sys
import threading
import time
import types
from pathlib import Path
from typing import Optional

from PIL import Image


_VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "Chess_diagram_to_FEN"
_LIB_LOCK = threading.Lock()
_lib = None  # cached module reference after lazy import


def _install_inference_stubs() -> None:
    """Provide stand-in modules for training-only deps so imports succeed.

    We stub:
      * `cairosvg` - needs Cairo native DLLs that aren't available on Windows.
      * `src.fen_recognition.generate_chessboards` - resolves a CWD-relative
        path at import time and pulls in training-only deps. At inference
        we only need the symbol `BoardGenerator` to exist so unrelated
        `from ... import BoardGenerator` lines succeed.
    """
    if "cairosvg" not in sys.modules:
        cairosvg = types.ModuleType("cairosvg")

        def _svg2png(*_args, **_kwargs):
            raise RuntimeError(
                "cairosvg.svg2png is unavailable at inference (training-only dependency)."
            )

        cairosvg.svg2png = _svg2png
        sys.modules["cairosvg"] = cairosvg

    stub_name = "src.fen_recognition.generate_chessboards"
    if stub_name not in sys.modules:
        gc_stub = types.ModuleType(stub_name)

        class _StubBoardGenerator:
            def __init__(self, *_args, **_kwargs):
                raise RuntimeError(
                    "BoardGenerator is a training-only stub; not available at inference."
                )

        gc_stub.BoardGenerator = _StubBoardGenerator
        sys.modules[stub_name] = gc_stub


def _ensure_loaded():
    global _lib
    if _lib is not None:
        return _lib
    with _LIB_LOCK:
        if _lib is not None:
            return _lib
        if not _VENDOR_DIR.exists():
            raise RuntimeError(
                f"Chess_diagram_to_FEN vendor directory not found at {_VENDOR_DIR}"
            )
        _install_inference_stubs()
        if str(_VENDOR_DIR) not in sys.path:
            sys.path.insert(0, str(_VENDOR_DIR))
        import chess_diagram_to_fen as cdf

        _lib = cdf
        return _lib


def is_available() -> bool:
    try:
        _ensure_loaded()
        return True
    except Exception:
        return False


def predict_fen(crop: Image.Image) -> Optional[str]:
    """Run the full Chess_diagram_to_FEN pipeline on a cropped page region.

    Returns the FEN string on success, or `None` if no board could be detected.
    Any other failure raises.
    """
    cdf = _ensure_loaded()
    result = cdf.get_fen(
        img=crop,
        game="chess",
        auto_rotate_image=True,
        auto_rotate_board=True,
    )
    if result is None or result.fen is None:
        return None
    return result.fen


def warmup(game: str = "chess") -> float:
    """Eagerly load all model weights so first real detect is faster.

    Returns elapsed warmup time in seconds.
    """
    cdf = _ensure_loaded()
    t0 = time.perf_counter()
    models = cdf._get_models(game)
    models.existence.get()
    models.bbox.get()
    models.image_rotation.get()
    models.fen.get()
    models.orientation.get()
    return time.perf_counter() - t0
