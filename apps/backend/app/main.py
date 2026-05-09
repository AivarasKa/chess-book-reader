"""FastAPI entrypoint for the Chess Book Reader backend."""

from __future__ import annotations

import io
import time
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field

import logging

from . import cdf_integration, recognition, storage

log = logging.getLogger(__name__)


app = FastAPI(title="Chess Book Reader Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    t0 = time.perf_counter()
    response = await call_next(request)
    ms = (time.perf_counter() - t0) * 1000
    response.headers["X-Process-Time-Ms"] = f"{ms:.1f}"
    return response


@app.on_event("startup")
def _startup() -> None:
    storage.init_db()
    try:
        cdf_integration._ensure_loaded()
        warmup_s = cdf_integration.warmup("chess")
        log.info(
            "Chess_diagram_to_FEN library loaded and warmed up in %.2fs.", warmup_s
        )
    except Exception:
        log.exception("Chess_diagram_to_FEN failed to load (will fall back to manual edit)")


# ---------- Health ----------


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------- Books / sessions ----------


class BookOpen(BaseModel):
    fingerprint: str = Field(..., min_length=8, max_length=128)
    path: str
    title: Optional[str] = None


class BookProgress(BaseModel):
    fingerprint: str
    last_page: Optional[int] = None
    last_fen: Optional[str] = None


class DiagramCacheLookup(BaseModel):
    click_x: float
    click_y: float
    book_fingerprint: str = Field(..., min_length=8, max_length=128)
    page: int = Field(..., ge=1)
    page_width: float = Field(..., gt=0)
    page_height: float = Field(..., gt=0)


class DiagramResetRegion(BaseModel):
    book_fingerprint: str = Field(..., min_length=8, max_length=128)
    page: int = Field(..., ge=1)
    region_x: float = Field(..., ge=0)
    region_y: float = Field(..., ge=0)
    region_w: float = Field(..., gt=0)
    region_h: float = Field(..., gt=0)
    page_width: Optional[float] = Field(None, gt=0)
    page_height: Optional[float] = Field(None, gt=0)


@app.post("/api/books/open")
def open_book(payload: BookOpen) -> dict[str, Any]:
    book = storage.upsert_book(payload.fingerprint, payload.path, payload.title)
    return {"book": book}


class BookPrecacheComplete(BaseModel):
    fingerprint: str = Field(..., min_length=8, max_length=128)


@app.post("/api/books/precache-complete")
def book_precache_complete(payload: BookPrecacheComplete) -> dict[str, Any]:
    storage.mark_precache_complete(payload.fingerprint)
    book = storage.get_book(payload.fingerprint)
    if not book:
        raise HTTPException(404, "Unknown book fingerprint")
    return {"book": book}


@app.post("/api/books/progress")
def book_progress(payload: BookProgress) -> dict[str, Any]:
    if payload.last_page is None and payload.last_fen is None:
        raise HTTPException(400, "Provide at least one of last_page or last_fen")
    storage.update_book_progress(payload.fingerprint, payload.last_page, payload.last_fen)
    book = storage.get_book(payload.fingerprint)
    return {"book": book}


@app.get("/api/books/recent")
def recent_books(limit: int = 20) -> dict[str, Any]:
    return {"books": storage.list_recent_books(limit)}


@app.get("/api/session/last")
def last_session() -> dict[str, Any]:
    fp = storage.get_session("last_book_fingerprint")
    if not fp:
        return {"book": None}
    return {"book": storage.get_book(fp)}


# ---------- Diagram detection ----------

def _lookup_cached_detection(
    click_x: float,
    click_y: float,
    book_fingerprint: Optional[str],
    page: Optional[int],
    page_width: Optional[float],
    page_height: Optional[float],
) -> dict[str, Any] | None:
    cached = None
    if book_fingerprint and page is not None:
        cached = storage.find_correction(book_fingerprint, page, (click_x, click_y))
    if cached is not None:
        return {
            "fen": cached["fen"],
            "confidence": 1.0,
            "bounds": {
                "x": cached["region_x"],
                "y": cached["region_y"],
                "w": cached["region_w"],
                "h": cached["region_h"],
            },
            "warped_png_b64": None,
            "from_cache": True,
            "note": "Loaded a previously corrected position for this region.",
        }

    normalized_cached = None
    if (
        book_fingerprint
        and page is not None
        and page_width is not None
        and page_height is not None
        and page_width > 0
        and page_height > 0
    ):
        px_n = click_x / page_width
        py_n = click_y / page_height
        normalized_cached = storage.find_diagram_cache(book_fingerprint, page, (px_n, py_n))
    if normalized_cached is not None and page_width and page_height:
        return {
            "fen": normalized_cached["fen"],
            "confidence": float(normalized_cached.get("confidence") or 0.8),
            "bounds": {
                "x": normalized_cached["region_x_n"] * page_width,
                "y": normalized_cached["region_y_n"] * page_height,
                "w": normalized_cached["region_w_n"] * page_width,
                "h": normalized_cached["region_h_n"] * page_height,
            },
            "warped_png_b64": None,
            "from_cache": True,
            "note": "Loaded from normalized diagram cache.",
        }
    return None


@app.post("/api/diagram/cache-lookup")
def diagram_cache_lookup(payload: DiagramCacheLookup) -> dict[str, Any]:
    t0 = time.perf_counter()
    cached = _lookup_cached_detection(
        payload.click_x,
        payload.click_y,
        payload.book_fingerprint,
        payload.page,
        payload.page_width,
        payload.page_height,
    )
    source = "miss"
    if cached is not None:
        source = (
            "correction_cache"
            if (cached.get("note") or "").startswith("Loaded a previously corrected")
            else "diagram_cache"
        )
    log.info(
        "diagram/cache-lookup page=%s source=%s %.1fms",
        payload.page,
        source,
        (time.perf_counter() - t0) * 1000,
    )
    return {"hit": cached is not None, "result": cached}


@app.post("/api/diagram/detect")
async def detect_diagram(
    page_image: UploadFile = File(...),
    click_x: float = Form(...),
    click_y: float = Form(...),
    book_fingerprint: Optional[str] = Form(None),
    page: Optional[int] = Form(None),
    page_width: Optional[float] = Form(None),
    page_height: Optional[float] = Form(None),
) -> dict[str, Any]:
    t0 = time.perf_counter()
    raw = await page_image.read()
    if not raw:
        raise HTTPException(400, "Empty page_image")
    cached = _lookup_cached_detection(
        click_x, click_y, book_fingerprint, page, page_width, page_height
    )
    if cached is not None:
        source = (
            "correction_cache"
            if (cached.get("note") or "").startswith("Loaded a previously corrected")
            else "diagram_cache"
        )
        log.info(
            "diagram/detect page=%s source=%s %.1fms",
            page,
            source,
            (time.perf_counter() - t0) * 1000,
        )
        return cached

    detected = recognition.detect_board_at_point(
        raw, click_x, click_y, include_preview=False
    )

    fen = detected.fen
    confidence = detected.confidence
    note = detected.note

    # Persist successful auto-detections so subsequent clicks on the same
    # diagram region can be served from cache across app restarts.
    if book_fingerprint and page is not None and confidence > 0:
        try:
            if page_width and page_height and page_width > 0 and page_height > 0:
                region_n = (
                    detected.bounds[0] / page_width,
                    detected.bounds[1] / page_height,
                    detected.bounds[2] / page_width,
                    detected.bounds[3] / page_height,
                )
                storage.add_diagram_cache(
                    book_fingerprint,
                    page,
                    region_n,
                    fen,
                    confidence=confidence,
                )
            else:
                storage.add_correction(
                    book_fingerprint,
                    page,
                    detected.bounds,
                    fen,
                )
        except Exception:
            log.exception("Failed to persist auto-detection cache entry")

    log.info(
        "diagram/detect page=%s source=model %.1fms",
        page,
        (time.perf_counter() - t0) * 1000,
    )
    return {
        "fen": fen,
        "confidence": confidence,
        "bounds": {
            "x": detected.bounds[0],
            "y": detected.bounds[1],
            "w": detected.bounds[2],
            "h": detected.bounds[3],
        },
        "warped_png_b64": detected.warped_png_b64,
        "from_cache": False,
        "note": note,
    }


@app.post("/api/cache/clear")
def clear_cache() -> dict[str, str]:
    storage.clear_all_caches()
    return {"status": "ok"}


@app.post("/api/diagram/reset-region")
def reset_diagram_region(payload: DiagramResetRegion) -> dict[str, Any]:
    cx = payload.region_x + payload.region_w / 2.0
    cy = payload.region_y + payload.region_h / 2.0
    removed_corrections = storage.clear_correction_at_point(
        payload.book_fingerprint, payload.page, (cx, cy)
    )

    removed_diagram_cache = 0
    if (
        payload.page_width
        and payload.page_height
        and payload.page_width > 0
        and payload.page_height > 0
    ):
        removed_diagram_cache = storage.clear_diagram_cache_at_point(
            payload.book_fingerprint,
            payload.page,
            (cx / payload.page_width, cy / payload.page_height),
        )

    return {
        "status": "ok",
        "removed_corrections": removed_corrections,
        "removed_diagram_cache": removed_diagram_cache,
    }


@app.post("/api/diagram/precache-page")
async def precache_page(
    page_image: UploadFile = File(...),
    book_fingerprint: str = Form(...),
    page: int = Form(...),
) -> dict[str, Any]:
    raw = await page_image.read()
    if not raw:
        raise HTTPException(400, "Empty page_image")
    if page < 1:
        raise HTTPException(400, "page must be >= 1")

    try:
        img = Image.open(io.BytesIO(raw))
        img_w, img_h = float(img.width), float(img.height)
    except Exception:
        raise HTTPException(400, "Invalid page_image")

    boards = recognition.detect_boards_on_page(raw)
    added = 0
    for b in boards:
        try:
            if img_w <= 0 or img_h <= 0:
                continue
            cx_n = (b.bounds[0] + b.bounds[2] / 2) / img_w
            cy_n = (b.bounds[1] + b.bounds[3] / 2) / img_h
            existing = storage.find_diagram_cache(book_fingerprint, page, (cx_n, cy_n))
            if existing is not None:
                continue
            region_n = (
                b.bounds[0] / img_w,
                b.bounds[1] / img_h,
                b.bounds[2] / img_w,
                b.bounds[3] / img_h,
            )
            storage.add_diagram_cache(
                book_fingerprint,
                page,
                region_n,
                b.fen,
                confidence=b.confidence,
            )
            added += 1
        except Exception:
            log.exception("Failed to add pre-cache correction")
    return {"status": "ok", "added": added}


# ---------- Corrections ----------


class CorrectionPayload(BaseModel):
    book_fingerprint: str
    page: int
    region_x: float
    region_y: float
    region_w: float
    region_h: float
    fen: str


@app.post("/api/corrections")
def add_correction(payload: CorrectionPayload) -> dict[str, str]:
    storage.add_correction(
        payload.book_fingerprint,
        payload.page,
        (payload.region_x, payload.region_y, payload.region_w, payload.region_h),
        payload.fen,
    )
    return {"status": "ok"}
