from __future__ import annotations

from app import recognition, storage


FP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _open_book(client):
    res = client.post(
        "/api/books/open",
        json={"fingerprint": FP, "path": "book.pdf", "title": "Book"},
    )
    assert res.status_code == 200


def test_cache_lookup_hit_and_miss(client):
    _open_book(client)
    storage.add_diagram_cache(FP, 3, (0.10, 0.10, 0.30, 0.30), "8/8/8/8/8/8/8/8 w - - 0 1", 0.9)

    hit = client.post(
        "/api/diagram/cache-lookup",
        json={
            "book_fingerprint": FP,
            "page": 3,
            "click_x": 50,
            "click_y": 50,
            "page_width": 200,
            "page_height": 200,
        },
    )
    assert hit.status_code == 200
    body = hit.json()
    assert body["hit"] is True
    assert body["result"]["from_cache"] is True

    miss = client.post(
        "/api/diagram/cache-lookup",
        json={
            "book_fingerprint": FP,
            "page": 3,
            "click_x": 190,
            "click_y": 190,
            "page_width": 200,
            "page_height": 200,
        },
    )
    assert miss.status_code == 200
    assert miss.json()["hit"] is False


def test_detect_returns_cache_without_model_call(client, png_bytes, monkeypatch):
    _open_book(client)
    storage.add_diagram_cache(FP, 1, (0.0, 0.0, 1.0, 1.0), "8/8/8/8/8/8/8/8 w - - 0 1", 0.9)

    def _boom(*_args, **_kwargs):
        raise AssertionError("model path should not run on cache hit")

    monkeypatch.setattr(recognition, "detect_board_at_point", _boom)

    res = client.post(
        "/api/diagram/detect",
        data={
            "click_x": "10",
            "click_y": "10",
            "book_fingerprint": FP,
            "page": "1",
            "page_width": "32",
            "page_height": "32",
        },
        files={"page_image": ("page.png", png_bytes, "image/png")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["from_cache"] is True


def test_detect_miss_uses_model_and_persists_cache(client, png_bytes, monkeypatch):
    _open_book(client)

    monkeypatch.setattr(
        recognition,
        "detect_board_at_point",
        lambda *_args, **_kwargs: recognition.DetectedBoard(
            fen="8/8/8/8/8/8/8/8 w - - 0 1",
            confidence=0.8,
            bounds=(8.0, 8.0, 16.0, 16.0),
            warped_png_b64=None,
            note="mocked",
        ),
    )

    res = client.post(
        "/api/diagram/detect",
        data={
            "click_x": "10",
            "click_y": "10",
            "book_fingerprint": FP,
            "page": "2",
            "page_width": "32",
            "page_height": "32",
        },
        files={"page_image": ("page.png", png_bytes, "image/png")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["from_cache"] is False
    assert body["fen"] == "8/8/8/8/8/8/8/8 w - - 0 1"

    lookup = client.post(
        "/api/diagram/cache-lookup",
        json={
            "book_fingerprint": FP,
            "page": 2,
            "click_x": 10,
            "click_y": 10,
            "page_width": 32,
            "page_height": 32,
        },
    )
    assert lookup.status_code == 200
    assert lookup.json()["hit"] is True


def test_cache_clear_resets_precache_complete_and_entries(client):
    _open_book(client)
    client.post("/api/books/precache-complete", json={"fingerprint": FP})
    storage.add_diagram_cache(FP, 1, (0.0, 0.0, 1.0, 1.0), "8/8/8/8/8/8/8/8 w - - 0 1", 0.5)
    storage.add_correction(FP, 1, (0, 0, 10, 10), "8/8/8/8/8/8/8/8 w - - 0 1")

    res = client.post("/api/cache/clear")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"

    book = storage.get_book(FP)
    assert book is not None
    assert int(book["precache_complete"]) == 0

    miss = client.post(
        "/api/diagram/cache-lookup",
        json={
            "book_fingerprint": FP,
            "page": 1,
            "click_x": 5,
            "click_y": 5,
            "page_width": 10,
            "page_height": 10,
        },
    )
    assert miss.status_code == 200
    assert miss.json()["hit"] is False


def test_books_progress_updates_page_and_fen(client):
    _open_book(client)

    res = client.post(
        "/api/books/progress",
        json={"fingerprint": FP, "last_page": 42, "last_fen": "8/8/8/8/8/8/8/8 b - - 0 1"},
    )
    assert res.status_code == 200
    book = res.json()["book"]
    assert book["last_page"] == 42
    assert book["last_fen"] == "8/8/8/8/8/8/8/8 b - - 0 1"
