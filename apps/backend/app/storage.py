"""SQLite-backed storage for session state and per-page corrections.

Schema is intentionally tiny for the MVP. All tables are created on first run.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


_LOCK = threading.Lock()


def _data_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    path = Path(base) / "chess_book_reader"
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    return _data_dir() / "state.sqlite3"


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _LOCK, connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fingerprint TEXT NOT NULL UNIQUE,
                path TEXT NOT NULL,
                title TEXT,
                last_page INTEGER NOT NULL DEFAULT 1,
                last_fen TEXT,
                opened_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS session (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_fingerprint TEXT NOT NULL,
                page INTEGER NOT NULL,
                region_x REAL NOT NULL,
                region_y REAL NOT NULL,
                region_w REAL NOT NULL,
                region_h REAL NOT NULL,
                fen TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_corrections_lookup
                ON corrections (book_fingerprint, page);
            """
        )


def upsert_book(fingerprint: str, path: str, title: str | None) -> dict[str, Any]:
    with _LOCK, connect() as conn:
        conn.execute(
            """
            INSERT INTO books (fingerprint, path, title)
            VALUES (?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                path = excluded.path,
                title = COALESCE(excluded.title, books.title),
                updated_at = datetime('now')
            """,
            (fingerprint, path, title),
        )
        row = conn.execute(
            "SELECT * FROM books WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        set_session("last_book_fingerprint", fingerprint)
        return dict(row)


def update_book_progress(
    fingerprint: str, last_page: int | None, last_fen: str | None
) -> None:
    with _LOCK, connect() as conn:
        if last_page is not None:
            conn.execute(
                "UPDATE books SET last_page = ?, updated_at = datetime('now') WHERE fingerprint = ?",
                (last_page, fingerprint),
            )
        if last_fen is not None:
            conn.execute(
                "UPDATE books SET last_fen = ?, updated_at = datetime('now') WHERE fingerprint = ?",
                (last_fen, fingerprint),
            )


def list_recent_books(limit: int = 20) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM books ORDER BY updated_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_book(fingerprint: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM books WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        return dict(row) if row else None


def get_session(key: str) -> str | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT value FROM session WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else None


def set_session(key: str, value: str) -> None:
    with _LOCK, connect() as conn:
        conn.execute(
            """
            INSERT INTO session (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )


def get_session_json(key: str) -> Any | None:
    raw = get_session(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def set_session_json(key: str, value: Any) -> None:
    set_session(key, json.dumps(value))


def add_correction(
    book_fingerprint: str,
    page: int,
    region: tuple[float, float, float, float],
    fen: str,
) -> None:
    x, y, w, h = region
    with _LOCK, connect() as conn:
        conn.execute(
            """
            INSERT INTO corrections
                (book_fingerprint, page, region_x, region_y, region_w, region_h, fen)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (book_fingerprint, page, x, y, w, h, fen),
        )


def find_correction(
    book_fingerprint: str,
    page: int,
    point: tuple[float, float],
) -> dict[str, Any] | None:
    """Return the most recent correction whose region contains the point."""
    px, py = point
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM corrections
            WHERE book_fingerprint = ? AND page = ?
            ORDER BY created_at DESC
            """,
            (book_fingerprint, page),
        ).fetchall()
    for r in rows:
        if (
            r["region_x"] <= px <= r["region_x"] + r["region_w"]
            and r["region_y"] <= py <= r["region_y"] + r["region_h"]
        ):
            return dict(r)
    return None
