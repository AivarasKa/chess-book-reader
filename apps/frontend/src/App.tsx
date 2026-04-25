import { useCallback, useEffect, useRef, useState } from "react";
import {
  Book,
  detectDiagram,
  getLastSession,
  markPrecacheComplete,
  openBook,
  precachePage,
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
  const [sidePaneWidth, setSidePaneWidth] = useState(420);
  const [indexing, setIndexing] = useState<{
    running: boolean;
    current: number;
    total: number;
    added: number;
  }>({ running: false, current: 0, total: 0, added: 0 });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  const onPageChange = useCallback(
    (next: number) => {
      const clamped = Math.max(1, Math.min(pageCount || next, next));
      setPageNumber(clamped);
      setDetection(null);
      schedulePageProgressSave(clamped);
    },
    [pageCount, schedulePageProgressSave]
  );

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

  const triggerFileDialog = () => fileInputRef.current?.click();
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
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              Page {pageNumber} / {pageCount || "?"}
            </span>
            <span style={{ width: 12 }} />
            <button onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>-</button>
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              {Math.round(scale * 100)}%
            </span>
            <button onClick={() => setScale((s) => Math.min(3, s + 0.2))}>+</button>
          </div>
        )}
      </div>

      <div
        className="workspace"
        style={{
          gridTemplateColumns: `minmax(320px, 1fr) 8px ${sidePaneWidth}px`,
        }}
      >
        <div className="pdf-pane">
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
          {indexing.running && (
            <div className="note">
              Indexing book diagrams: {indexing.current}/{indexing.total || "?"} pages, cached{" "}
              {indexing.added} diagrams.
            </div>
          )}
          {!file && missingFile && (
            <div className="note warning">
              Last session was <strong>{missingFile.title || missingFile.path}</strong>.
              The browser cannot reopen local files automatically - use Open PDF... to
              re-locate it.
            </div>
          )}
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
          />
        </div>
      </div>
    </div>
  );
}
