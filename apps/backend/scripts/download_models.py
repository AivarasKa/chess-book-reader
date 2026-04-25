"""Download Chess_diagram_to_FEN pre-trained model weights.

Skips if the chess models already exist in the vendor directory.
"""

from __future__ import annotations

import sys
import urllib.request
import zipfile
from pathlib import Path

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "Chess_diagram_to_FEN"
MODELS_DIR = VENDOR_DIR / "models"
URL = "https://github.com/tsoj/Chess_diagram_to_FEN/releases/download/1.0/models.zip"


def already_have_models() -> bool:
    chess_dir = MODELS_DIR / "chess"
    if not chess_dir.exists():
        return False
    return any(p.suffix == ".pth" for p in chess_dir.iterdir())


def main() -> int:
    if not VENDOR_DIR.exists():
        print(
            f"Vendor directory not found: {VENDOR_DIR}\n"
            "Clone Chess_diagram_to_FEN into apps/backend/vendor/ first.",
            file=sys.stderr,
        )
        return 1

    if already_have_models():
        print("Models already present, skipping download.")
        return 0

    tmp_zip = VENDOR_DIR / "_models.zip"
    print(f"Downloading model weights from {URL} ...")
    urllib.request.urlretrieve(URL, tmp_zip)
    print(f"Extracting to {VENDOR_DIR} ...")
    with zipfile.ZipFile(tmp_zip) as zf:
        zf.extractall(VENDOR_DIR)
    tmp_zip.unlink(missing_ok=True)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
