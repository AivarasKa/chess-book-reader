"""Diagram detection and position recognition.

Pipeline:
  1. Decode the rendered PDF page bitmap.
  2. Use OpenCV to find a board-like region nearest the user's click.
     This preserves user intent when a page contains multiple diagrams.
  3. Pass the cropped region to the vendored Chess_diagram_to_FEN model
     (`app.cdf_integration.predict_fen`). The library does its own board
     localization, rotation correction, perspective warp, and piece
     classification, returning a full FEN.
  4. If the click-targeted crop yields no board, fall back to the whole page.
"""

from __future__ import annotations

import base64
import io
import logging
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np
from PIL import Image

from . import cdf_integration


log = logging.getLogger(__name__)


STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


@dataclass
class DetectedBoard:
    fen: str
    confidence: float
    bounds: tuple[float, float, float, float]  # x, y, w, h in source-image pixels
    warped_png_b64: Optional[str] = None
    note: Optional[str] = None


def _infer_castling_from_placement(placement: str) -> str:
    """Naive castling inference from current piece locations only."""
    rows = placement.split("/")
    if len(rows) != 8:
        return "-"

    def piece_at(square: str) -> str:
        file_idx = ord(square[0]) - ord("a")
        rank = int(square[1])
        row = rows[8 - rank]
        col = 0
        for ch in row:
            if ch.isdigit():
                col += int(ch)
            else:
                if col == file_idx:
                    return ch
                col += 1
        return ""

    rights: list[str] = []
    if piece_at("e1") == "K":
        if piece_at("h1") == "R":
            rights.append("K")
        if piece_at("a1") == "R":
            rights.append("Q")
    if piece_at("e8") == "k":
        if piece_at("h8") == "r":
            rights.append("k")
        if piece_at("a8") == "r":
            rights.append("q")
    return "".join(rights) or "-"


def _apply_naive_castling_override(fen: str) -> str:
    """Replace castling field using naive king/rook-on-start-squares rule."""
    parts = fen.strip().split()
    if len(parts) < 6:
        return fen
    placement, side, _castling, ep, half, full = parts[:6]
    castling = _infer_castling_from_placement(placement)
    return f"{placement} {side} {castling} {ep} {half} {full}"


def _decode_image_bgr(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def _encode_png_b64(bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _candidate_quads(gray: np.ndarray) -> list[np.ndarray]:
    """Polygon contours that look board-like (large, near-square, 4 corners)."""
    h, w = gray.shape
    img_area = float(h * w)

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    quads: list[np.ndarray] = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < img_area * 0.005 or area > img_area * 0.95:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 4:
            continue
        x, y, bw, bh = cv2.boundingRect(approx)
        if bw == 0 or bh == 0:
            continue
        ratio = bw / bh
        if ratio < 0.7 or ratio > 1.4:
            continue
        rect_area = bw * bh
        if area / rect_area < 0.7:
            continue
        quads.append(approx.reshape(-1, 2))
    return quads


def _crop_around_click(
    bgr: np.ndarray,
    click_x: float,
    click_y: float,
    pad_ratio: float = 0.12,
    fallback_radius: int = 600,
) -> tuple[Image.Image, tuple[float, float, float, float]]:
    """Crop a region likely containing the diagram nearest the click.

    Returns the cropped PIL image and the bounds (x, y, w, h) in source pixels.
    """
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    quads = _candidate_quads(gray)

    bounds: tuple[float, float, float, float]
    if quads:
        best = None
        best_dist = float("inf")
        for q in quads:
            x, y, bw, bh = cv2.boundingRect(q)
            cx, cy = x + bw / 2, y + bh / 2
            dist = (cx - click_x) ** 2 + (cy - click_y) ** 2
            if dist < best_dist:
                best_dist = dist
                best = (x, y, bw, bh)
        assert best is not None
        x, y, bw, bh = best
        pad_x = int(bw * pad_ratio)
        pad_y = int(bh * pad_ratio)
        x0 = max(0, x - pad_x)
        y0 = max(0, y - pad_y)
        x1 = min(w, x + bw + pad_x)
        y1 = min(h, y + bh + pad_y)
        bounds = (float(x), float(y), float(bw), float(bh))
    else:
        x0 = max(0, int(click_x) - fallback_radius)
        y0 = max(0, int(click_y) - fallback_radius)
        x1 = min(w, int(click_x) + fallback_radius)
        y1 = min(h, int(click_y) + fallback_radius)
        bounds = (float(x0), float(y0), float(x1 - x0), float(y1 - y0))

    crop = bgr[y0:y1, x0:x1]
    pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
    return pil, bounds


def detect_boards_on_page(
    page_image: bytes,
    *,
    max_candidates: int = 6,
    pad_ratio: float = 0.12,
) -> list[DetectedBoard]:
    """Detect multiple board candidates on a page and recognize each one.

    Used for book-level pre-caching on upload.
    """
    bgr = _decode_image_bgr(page_image)
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    quads = _candidate_quads(gray)
    if not quads:
        return []

    rects: list[tuple[int, int, int, int, int]] = []
    for q in quads:
        x, y, bw, bh = cv2.boundingRect(q)
        rects.append((bw * bh, x, y, bw, bh))
    rects.sort(reverse=True)

    out: list[DetectedBoard] = []
    seen: list[tuple[int, int, int, int]] = []
    for _area, x, y, bw, bh in rects:
        if len(out) >= max_candidates:
            break

        # Skip near-duplicates by simple center/size proximity.
        dup = False
        cx, cy = x + bw / 2, y + bh / 2
        for sx, sy, sw, sh in seen:
            scx, scy = sx + sw / 2, sy + sh / 2
            if abs(cx - scx) < 20 and abs(cy - scy) < 20 and abs(bw - sw) < 20 and abs(bh - sh) < 20:
                dup = True
                break
        if dup:
            continue

        pad_x = int(bw * pad_ratio)
        pad_y = int(bh * pad_ratio)
        x0 = max(0, x - pad_x)
        y0 = max(0, y - pad_y)
        x1 = min(w, x + bw + pad_x)
        y1 = min(h, y + bh + pad_y)
        crop = bgr[y0:y1, x0:x1]
        pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))

        try:
            fen = cdf_integration.predict_fen(pil) if cdf_integration.is_available() else None
        except Exception:
            log.exception("predict_fen failed in detect_boards_on_page")
            fen = None
        if fen is None:
            continue

        fen = _apply_naive_castling_override(fen)
        out.append(
            DetectedBoard(
                fen=fen,
                confidence=0.8,
                bounds=(float(x), float(y), float(bw), float(bh)),
                warped_png_b64=None,
                note="Pre-cached via page scan.",
            )
        )
        seen.append((x, y, bw, bh))

    return out


def detect_board_at_point(
    page_image: bytes,
    click_x: float,
    click_y: float,
    include_preview: bool = False,
) -> DetectedBoard:
    """Detect the chessboard nearest the click and return a recognized FEN."""
    bgr = _decode_image_bgr(page_image)
    h, w = bgr.shape[:2]

    pil_crop, bounds = _crop_around_click(bgr, click_x, click_y)
    warped_b64 = None
    if include_preview:
        warped_b64 = _encode_png_b64(cv2.cvtColor(np.array(pil_crop), cv2.COLOR_RGB2BGR))

    fen: Optional[str] = None
    note: Optional[str] = None
    confidence = 0.0

    if cdf_integration.is_available():
        try:
            fen = cdf_integration.predict_fen(pil_crop)
        except Exception as exc:
            log.exception("predict_fen failed on click-targeted crop")
            note = f"Recognition error on cropped region: {exc}"

        if fen is None:
            try:
                full_pil = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                fen = cdf_integration.predict_fen(full_pil)
                if fen is not None:
                    bounds = (0.0, 0.0, float(w), float(h))
                    note = (
                        "Click-targeted crop had no detectable board; "
                        "recognized the most prominent board on the page instead."
                    )
            except Exception as exc:
                log.exception("predict_fen failed on full page fallback")
                note = f"Recognition error on full page: {exc}"

        if fen is not None:
            fen = _apply_naive_castling_override(fen)
            confidence = 0.8
            if note is None:
                note = (
                    "Recognized via Chess_diagram_to_FEN model. "
                    "Castling rights inferred naively from piece starting squares."
                )
        else:
            note = (
                note
                or "No chess board detected near the click. "
                "Use Edit Board to set the position manually."
            )
    else:
        note = (
            "Recognition library failed to load. "
            "Use Edit Board to set the position manually."
        )

    return DetectedBoard(
        fen=fen or STARTING_FEN,
        confidence=confidence,
        bounds=bounds,
        warped_png_b64=warped_b64,
        note=note,
    )
