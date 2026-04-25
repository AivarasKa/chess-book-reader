import { useCallback, useEffect, useRef, useState } from "react";
import {
  Book,
  detectDiagram,
  getLastSession,
  openBook,
  saveCorrection,
  updateBookProgress,
} from "./api";
import { fingerprintFile } from "./fingerprint";
import { PdfViewer, PageDoubleClick } from "./components/PdfViewer";
import { AnalysisPanel } from "./components/AnalysisPanel";

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    [missingFile, registerBook]
  );

  const onPageChange = useCallback(
    (next: number) => {
      const clamped = Math.max(1, Math.min(pageCount || next, next));
      setPageNumber(clamped);
      setDetection(null);
      if (book) {
        updateBookProgress({ fingerprint: book.fingerprint, last_page: clamped }).catch(
          (err) => console.warn("Failed to persist page", err)
        );
      }
    },
    [book, pageCount]
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
          pageBlob: info.pageImage,
          clickX: info.clickXOnPage,
          clickY: info.clickYOnPage,
          bookFingerprint: activeBook?.fingerprint,
          page: info.pageNumber,
        });
        console.log("[App] detectDiagram resolved", {
          fen: result.fen,
          confidence: result.confidence,
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
            <button onClick={() => onPageChange(pageNumber - 1)} disabled={pageNumber <= 1}>
              Prev
            </button>
            <input
              type="number"
              value={pageNumber}
              min={1}
              max={pageCount || undefined}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) onPageChange(n);
              }}
              style={{ width: 70 }}
            />
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              / {pageCount || "?"}
            </span>
            <button
              onClick={() => onPageChange(pageNumber + 1)}
              disabled={pageCount > 0 && pageNumber >= pageCount}
            >
              Next
            </button>
            <span style={{ width: 12 }} />
            <button onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>-</button>
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              {Math.round(scale * 100)}%
            </span>
            <button onClick={() => setScale((s) => Math.min(3, s + 0.2))}>+</button>
          </div>
        )}
      </div>

      <div className="workspace">
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
        <div className="side-pane">
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
            note={detection?.note ?? "Double-click a diagram in the PDF to detect a position."}
            warnLowConfidence={!!detection && detection.confidence < 0.5 && !detection.fromCache}
            onFenChange={onFenChange}
            onSaveCorrection={onSaveCorrection}
          />
        </div>
      </div>
    </div>
  );
}
