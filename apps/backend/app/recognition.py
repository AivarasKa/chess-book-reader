"""Diagram detection and position recognition.

The MVP pipeline:

1. Receive a rendered PDF page bitmap (PNG/JPEG bytes) plus a click point.
2. Find the chessboard square nearest the click using contour analysis.
3. Warp the located board to a square crop.
4. (Stub for now) Return a placeholder FEN with low confidence so the UI flows
   straight into the Edit Board path. Real piece classification is the next
   iteration.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np
from PIL import Image


STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1"


@dataclass
class DetectedBoard:
    fen: str
    confidence: float
    bounds: tuple[float, float, float, float]  # x, y, w, h in source-image pixels
    warped_png_b64: Optional[str] = None
    note: Optional[str] = None


def _decode_image(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def _encode_png_b64(bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _candidate_quads(gray: np.ndarray) -> list[np.ndarray]:
    """Return polygon contours that look board-like (large, near-square, 4 corners)."""
    h, w = gray.shape
    img_area = float(h * w)

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    quads: list[np.ndarray] = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < img_area * 0.01 or area > img_area * 0.95:
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


def _order_quad(pts: np.ndarray) -> np.ndarray:
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).ravel()
    return np.array(
        [
            pts[np.argmin(s)],     # top-left
            pts[np.argmin(diff)],  # top-right
            pts[np.argmax(s)],     # bottom-right
            pts[np.argmax(diff)],  # bottom-left
        ],
        dtype=np.float32,
    )


def _warp_board(bgr: np.ndarray, quad: np.ndarray, size: int = 512) -> np.ndarray:
    src = _order_quad(quad.astype(np.float32))
    dst = np.array(
        [[0, 0], [size - 1, 0], [size - 1, size - 1], [0, size - 1]],
        dtype=np.float32,
    )
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(bgr, M, (size, size))


def detect_board_at_point(
    page_image: bytes,
    click_x: float,
    click_y: float,
) -> DetectedBoard:
    """Detect the chessboard nearest the click and return a recognition stub."""
    bgr = _decode_image(page_image)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    quads = _candidate_quads(gray)

    chosen: Optional[np.ndarray] = None
    bounds: tuple[float, float, float, float] = (0.0, 0.0, float(w), float(h))

    if quads:
        best = None
        best_dist = float("inf")
        for q in quads:
            x, y, bw, bh = cv2.boundingRect(q)
            cx, cy = x + bw / 2, y + bh / 2
            dist = (cx - click_x) ** 2 + (cy - click_y) ** 2
            if dist < best_dist:
                best_dist = dist
                best = q
                bounds = (float(x), float(y), float(bw), float(bh))
        chosen = best

    warped_b64 = None
    note = None
    if chosen is not None:
        warped = _warp_board(bgr, chosen)
        warped_b64 = _encode_png_b64(warped)
        note = "Board located. Piece recognition is a stub - use Edit Board to set the position."
    else:
        note = "No clear board detected near the click. Use Edit Board to set the position manually."

    return DetectedBoard(
        fen=STARTING_FEN,
        confidence=0.0,
        bounds=bounds,
        warped_png_b64=warped_b64,
        note=note,
    )
