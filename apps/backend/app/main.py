"""FastAPI entrypoint for the Chess Book Reader backend."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
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


@app.on_event("startup")
def _startup() -> None:
    storage.init_db()
    try:
        cdf_integration._ensure_loaded()
        log.info("Chess_diagram_to_FEN library loaded.")
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


@app.post("/api/books/open")
def open_book(payload: BookOpen) -> dict[str, Any]:
    book = storage.upsert_book(payload.fingerprint, payload.path, payload.title)
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


@app.post("/api/diagram/detect")
async def detect_diagram(
    page_image: UploadFile = File(...),
    click_x: float = Form(...),
    click_y: float = Form(...),
    book_fingerprint: Optional[str] = Form(None),
    page: Optional[int] = Form(None),
) -> dict[str, Any]:
    raw = await page_image.read()
    if not raw:
        raise HTTPException(400, "Empty page_image")

    cached = None
    if book_fingerprint and page is not None:
        cached = storage.find_correction(book_fingerprint, page, (click_x, click_y))

    detected = recognition.detect_board_at_point(raw, click_x, click_y)

    fen = cached["fen"] if cached else detected.fen
    confidence = 1.0 if cached else detected.confidence
    note = (
        "Loaded a previously corrected position for this region."
        if cached
        else detected.note
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
        "from_cache": cached is not None,
        "note": note,
    }


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
