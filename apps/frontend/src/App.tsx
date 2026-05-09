import { useCallback, useEffect, useRef, useState } from "react";
import {
  Book,
  clearCache,
  detectDiagram,
  getLastSession,
  markPrecacheComplete,
  openBook,
  precachePage,
  resetDiagramRegion,
  saveCorrection,
  updateBookProgress,
} from "./api";
import { fingerprintFile } from "./fingerprint";
import { PdfViewer, PageDoubleClick } from "./components/PdfViewer";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { pdfjs } from "react-pdf";

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PRECACHE_UPLOAD_MAX_DIMENSION = 1600;
const PROGRESS_SAVE_DEBOUNCE_MS = 3000;

type DetectionState = {
  pageNumber: number;
  bounds: { x: number; y: number; w: number; h: number };
  fen: string;
  note: string | null;
  confidence: number;
  fromCache: boolean;
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.4);
  const [fen, setFen] = useState(STARTING_FEN);
  const [detection, setDetection] = useState<DetectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [missingFile, setMissingFile] = useState<Book | null>(null);
  const [sidePaneWidth, setSidePaneWidth] = useState(500);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [enableLocalHistory, setEnableLocalHistory] = useState(false);
  const [bookmarkA, setBookmarkA] = useState<number | null>(null);
  const [bookmarkB, setBookmarkB] = useState<number | null>(null);
  const [activeBookmarkSlot, setActiveBookmarkSlot] = useState<"A" | "B" | null>(null);
  const [indexing, setIndexing] = useState<{
    running: boolean;
    current: number;
    total: number;
    added: number;
  }>({ running: false, current: 0, total: 0, added: 0 });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pendingProgressPageRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const last = await getLastSession();
        if (last) {
          setMissingFile(last);
          setPageNumber(last.last_page);
          if (last.last_fen) setFen(last.last_fen);
        }
      } catch (err) {
        console.warn("No prior session", err);
      }
    })();
  }, []);

  const registerBook = useCallback(
    async (picked: File): Promise<Book | null> => {
      let fp: string;
      try {
        fp = await fingerprintFile(picked);
      } catch (err) {
        console.error("Fingerprint failed", err);
        return null;
      }
      try {
        const opened = await openBook({
          fingerprint: fp,
          path: picked.name,
          title: picked.name,
        });
        setBook(opened);
        return opened;
      } catch (err) {
        console.error("openBook failed", err);
        return null;
      }
    },
    []
  );

  const onFilePicked = useCallback(
    async (picked: File) => {
      setFile(picked);
      setDetection(null);
      setBook(null);
      try {
        const opened = await registerBook(picked);
        if (opened) {
          if (missingFile && missingFile.fingerprint === opened.fingerprint) {
            setPageNumber(opened.last_page);
            if (opened.last_fen) setFen(opened.last_fen);
          } else {
            setPageNumber(opened.last_page || 1);
            if (opened.last_fen) setFen(opened.last_fen);
          }
          setBookmarkA(null);
          setBookmarkB(null);
          setActiveBookmarkSlot(null);
          setMissingFile(null);
          // Pre-cache once per book (persisted); reopening the same PDF skips this.
          if (!opened.precache_complete) {
            setIndexing({ running: true, current: 0, total: 0, added: 0 });
            let finishedAllPages = false;
            try {
              const data = await picked.arrayBuffer();
              const loadingTask = pdfjs.getDocument({ data });
              const pdf = await loadingTask.promise;
              let addedTotal = 0;
              setIndexing((s) => ({ ...s, total: pdf.numPages }));
              for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                if (!ctx) continue;
                canvas.width = Math.round(viewport.width);
                canvas.height = Math.round(viewport.height);
                await page.render({ canvasContext: ctx, viewport }).promise;

                // Match click-time upload behavior so cached regions align with
                // future click coordinates.
                const longest = Math.max(canvas.width, canvas.height);
                const downscale = Math.min(1, PRECACHE_UPLOAD_MAX_DIMENSION / longest);
                const tw = Math.max(1, Math.round(canvas.width * downscale));
                const th = Math.max(1, Math.round(canvas.height * downscale));

                let blob: Blob | null = null;
                if (downscale < 1) {
                  const off = document.createElement("canvas");
                  off.width = tw;
                  off.height = th;
                  const offCtx = off.getContext("2d");
                  if (!offCtx) continue;
                  offCtx.drawImage(canvas, 0, 0, tw, th);
                  blob = await new Promise<Blob | null>((resolve) =>
                    off.toBlob((b) => resolve(b), "image/png")
                  );
                } else {
                  blob = await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob((b) => resolve(b), "image/png")
                  );
                }

                if (blob !== null) {
                  const out = await precachePage({
                    pageBlob: blob,
                    bookFingerprint: opened.fingerprint,
                    page: p,
                  });
                  addedTotal += out.added;
                }
                setIndexing({ running: true, current: p, total: pdf.numPages, added: addedTotal });
              }
              finishedAllPages = true;
            } catch (err) {
              console.warn("Book pre-cache failed", err);
            } finally {
              setIndexing((s) => ({ ...s, running: false }));
            }
            if (finishedAllPages) {
              markPrecacheComplete({ fingerprint: opened.fingerprint })
                .then((b) => setBook(b))
                .catch((err) => console.warn("markPrecacheComplete failed", err));
            }
          }
        } else {
          console.warn(
            "Book registration failed; detection will still work but progress won't persist."
          );
        }
      } catch (err) {
        console.error("onFilePicked unexpected error", err);
        alert("Could not open file: " + (err as Error).message);
      }
    },
    [missingFile, registerBook, scale]
  );

  const flushPendingPageProgress = useCallback(() => {
    if (!book || pendingProgressPageRef.current === null) return;
    const page = pendingProgressPageRef.current;
    pendingProgressPageRef.current = null;
    updateBookProgress({ fingerprint: book.fingerprint, last_page: page }).catch((err) =>
      console.warn("Failed to persist page", err)
    );
  }, [book]);

  const schedulePageProgressSave = useCallback(
    (page: number) => {
      if (!book) return;
      pendingProgressPageRef.current = page;
      if (progressSaveTimerRef.current !== null) return;
      progressSaveTimerRef.current = setTimeout(() => {
        progressSaveTimerRef.current = null;
        flushPendingPageProgress();
      }, PROGRESS_SAVE_DEBOUNCE_MS);
    },
    [book, flushPendingPageProgress]
  );

  useEffect(() => {
    return () => {
      if (progressSaveTimerRef.current !== null) {
        clearTimeout(progressSaveTimerRef.current);
        progressSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (progressSaveTimerRef.current !== null) {
      clearTimeout(progressSaveTimerRef.current);
      progressSaveTimerRef.current = null;
    }
    pendingProgressPageRef.current = null;
  }, [book?.fingerprint]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!menuRef.current || !target) return;
      if (!menuRef.current.contains(target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const onPageChange = useCallback(
    (next: number) => {
      const clamped = Math.max(1, Math.min(pageCount || next, next));
      setPageNumber(clamped);
      setDetection(null);
      schedulePageProgressSave(clamped);
    },
    [pageCount, schedulePageProgressSave]
  );

  const jumpToBookmark = useCallback(
    (slot: "A" | "B") => {
      const target = slot === "A" ? bookmarkA : bookmarkB;
      if (target === null) return;
      onPageChange(target);
      setActiveBookmarkSlot(slot);
    },
    [bookmarkA, bookmarkB, onPageChange]
  );
  const setBookmark = useCallback((slot: "A" | "B") => {
    if (slot === "A") setBookmarkA(pageNumber);
    else setBookmarkB(pageNumber);
    setActiveBookmarkSlot(slot);
  }, [pageNumber]);
  const jumpOtherBookmark = useCallback(() => {
    if (bookmarkA === null || bookmarkB === null) return;
    let next: "A" | "B";
    if (activeBookmarkSlot) next = activeBookmarkSlot === "A" ? "B" : "A";
    else if (pageNumber === bookmarkA && pageNumber !== bookmarkB) next = "B";
    else if (pageNumber === bookmarkB && pageNumber !== bookmarkA) next = "A";
    else next = "A";
    jumpToBookmark(next);
  }, [activeBookmarkSlot, bookmarkA, bookmarkB, jumpToBookmark, pageNumber]);

  const handleDoubleClick = useCallback(
    async (info: PageDoubleClick) => {
      console.log("[App] handleDoubleClick start", {
        page: info.pageNumber,
        bookSet: !!book,
        fileSet: !!file,
      });
      if (!file) {
        setDetectionError("Open a PDF first.");
        return;
      }
      setBusy(true);
      setDetectionError(null);
      try {
        let activeBook = book;
        if (!activeBook) {
          console.log("[App] book missing, calling registerBook…");
          activeBook = await registerBook(file);
          console.log("[App] registerBook returned", { ok: !!activeBook });
        }
        console.log("[App] calling detectDiagram…");
        const result = await detectDiagram({
          createPageBlob: info.createPageImage,
          clickX: info.clickXOnPage,
          clickY: info.clickYOnPage,
          pageWidth: info.pageWidth,
          pageHeight: info.pageHeight,
          bookFingerprint: activeBook?.fingerprint,
          page: info.pageNumber,
        });
        console.log("[App] detectDiagram resolved", {
          fen: result.fen,
          confidence: result.confidence,
          from_cache: result.from_cache,
        });
        // Backend bounds are in the (possibly downscaled) uploaded-image
        // coordinate space. Map them back to the original canvas pixels so
        // the on-page overlay lands in the right place.
        const k = info.upscaleToOriginal;
        const bounds = {
          x: result.bounds.x * k,
          y: result.bounds.y * k,
          w: result.bounds.w * k,
          h: result.bounds.h * k,
        };
        setFen(result.fen);
        setDetection({
          pageNumber: info.pageNumber,
          bounds,
          fen: result.fen,
          note: result.note,
          confidence: result.confidence,
          fromCache: result.from_cache,
        });
        if (activeBook) {
          updateBookProgress({
            fingerprint: activeBook.fingerprint,
            last_fen: result.fen,
          }).catch(() => undefined);
        }
      } catch (err) {
        console.error("[App] detection failed", err);
        setDetectionError("Detection failed: " + (err as Error).message);
      } finally {
        console.log("[App] handleDoubleClick finally — busy=false");
        setBusy(false);
      }
    },
    [book, file, registerBook]
  );

  const onFenChange = useCallback(
    (next: string) => {
      setFen(next);
      if (book) {
        updateBookProgress({ fingerprint: book.fingerprint, last_fen: next }).catch(
          () => undefined
        );
      }
    },
    [book]
  );

  const onSaveCorrection = useCallback(
    async (correctedFen: string) => {
      if (!book || !detection) return;
      try {
        await saveCorrection({
          book_fingerprint: book.fingerprint,
          page: detection.pageNumber,
          region_x: detection.bounds.x,
          region_y: detection.bounds.y,
          region_w: detection.bounds.w,
          region_h: detection.bounds.h,
          fen: correctedFen,
        });
      } catch (err) {
        console.warn("Could not save correction", err);
      }
    },
    [book, detection]
  );

  const onResetDiagram = useCallback(async () => {
    if (!book || !detection) return;
    await resetDiagramRegion({
      book_fingerprint: book.fingerprint,
      page: detection.pageNumber,
      region_x: detection.bounds.x,
      region_y: detection.bounds.y,
      region_w: detection.bounds.w,
      region_h: detection.bounds.h,
    });
    setDetectionError("Diagram-specific cache cleared. Double-click the diagram again to re-detect.");
    setDetection(null);
  }, [book, detection]);

  const triggerFileDialog = () => fileInputRef.current?.click();
  const handleClearCache = useCallback(async () => {
    if (clearingCache) return;
    const ok = window.confirm(
      "Clear all detection cache and manual corrections? This also forces re-index on next book open."
    );
    if (!ok) return;
    setClearingCache(true);
    setMenuOpen(false);
    try {
      await clearCache();
      // Clearing cache should also close the currently open book/session view.
      setFile(null);
      setBook(null);
      setPageCount(0);
      setPageNumber(1);
      setDetection(null);
      setDetectionError("Cache cleared.");
    } catch (err) {
      setDetectionError("Failed to clear cache: " + (err as Error).message);
    } finally {
      setClearingCache(false);
    }
  }, [clearingCache]);
  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const min = 320;
    const max = Math.min(900, window.innerWidth - 320);
    const onMove = (ev: MouseEvent) => {
      const next = window.innerWidth - ev.clientX;
      const clamped = Math.max(min, Math.min(max, next));
      setSidePaneWidth(clamped);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">Chess Book Reader</span>
        <button onClick={triggerFileDialog}>Open PDF...</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFilePicked(f);
            e.target.value = "";
          }}
        />
        <span className="file-name">{file?.name ?? "(no file)"}</span>
        <span className="spacer" />
        {file && (
          <div className="page-controls">
            <div className="page-bookmark-controls">
              <button onClick={() => setBookmark("A")} title="Set bookmark A to current page">
                A:{bookmarkA ?? "-"}
              </button>
              <button
                onClick={jumpOtherBookmark}
                disabled={bookmarkA === null || bookmarkB === null}
                title="Jump between bookmarks A and B"
              >
                ⇄
              </button>
              <button onClick={() => setBookmark("B")} title="Set bookmark B to current page">
                B:{bookmarkB ?? "-"}
              </button>
            </div>
            <span className="page-indicator">
              Page {pageNumber} / {pageCount || "?"}
            </span>
            <span style={{ width: 12 }} />
            <button
              onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
            >
              -
            </button>
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              {Math.round(scale * 100)}%
            </span>
            <button onClick={() => setScale((s) => Math.min(3, s + 0.2))}>+</button>
          </div>
        )}
        <div className="topbar-menu" ref={menuRef}>
          <button
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Open menu"
            onClick={() => setMenuOpen((v) => !v)}
            title="Menu"
          >
            ☰
          </button>
          {menuOpen && (
            <div className="menu-dropdown" role="menu">
              <div className="menu-section-title">Experimental features</div>
              <label className="menu-checkbox">
                <input
                  type="checkbox"
                  data-testid="experimental-local-history"
                  checked={enableLocalHistory}
                  onChange={(e) => setEnableLocalHistory(e.target.checked)}
                />
                Local history board
              </label>
              <div className="menu-divider" />
              <button role="menuitem" onClick={handleClearCache} disabled={clearingCache}>
                {clearingCache ? "Clearing cache..." : "Clear cache"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        className="workspace"
        style={{
          gridTemplateColumns: `minmax(320px, 1fr) 8px ${sidePaneWidth}px`,
        }}
      >
        <div className="pdf-pane">
          {indexing.running && (
            <div className="indexing-overlay" aria-live="polite" role="status">
              <div className="indexing-overlay-title">Indexing book diagrams</div>
              <div className="indexing-overlay-meta">
                {indexing.current}/{indexing.total || "?"} pages, cached {indexing.added} diagrams
              </div>
              <div
                className="indexing-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  indexing.total > 0 ? Math.round((indexing.current / indexing.total) * 100) : 0
                }
              >
                <div
                  className="indexing-progress-fill"
                  style={{
                    width:
                      indexing.total > 0
                        ? `${Math.max(0, Math.min(100, (indexing.current / indexing.total) * 100))}%`
                        : "0%",
                  }}
                />
              </div>
            </div>
          )}
          <PdfViewer
            file={file}
            pageNumber={pageNumber}
            scale={scale}
            onPageCount={setPageCount}
            onPageChange={onPageChange}
            onPageDoubleClick={handleDoubleClick}
            detectionBox={
              detection
                ? { ...detection.bounds, pageNumber: detection.pageNumber }
                : null
            }
          />
        </div>
        <div
          className="pane-resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize side panel"
          tabIndex={0}
        />
        <div className="side-pane">
          {busy && <div className="note">Detecting...</div>}
          {!busy && detectionError && (
            <div className="note warning">{detectionError}</div>
          )}

          <AnalysisPanel
            fen={fen}
            note={detection?.note ?? null}
            warnLowConfidence={!!detection && detection.confidence < 0.5 && !detection.fromCache}
            onFenChange={onFenChange}
            onSaveCorrection={onSaveCorrection}
            onResetDiagram={onResetDiagram}
            enableLocalHistory={enableLocalHistory}
          />
        </div>
      </div>
    </div>
  );
}
