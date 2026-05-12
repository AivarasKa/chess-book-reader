import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Document, Page } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "../pdfWorker";

export type PageDoubleClick = {
  pageNumber: number;
  /** Click X in the *uploaded* image coordinate space (already downscaled). */
  clickXOnPage: number;
  /** Click Y in the *uploaded* image coordinate space (already downscaled). */
  clickYOnPage: number;
  createPageImage: () => Promise<Blob | null>;
  /** Width of the uploaded image (after downscale). */
  pageWidth: number;
  /** Height of the uploaded image (after downscale). */
  pageHeight: number;
  /** Factor mapping uploaded-image px → original canvas px (>= 1 when downscaled). */
  upscaleToOriginal: number;
};

const UPLOAD_MAX_DIMENSION = 1600;

/**
 * Pages on each side of a focus page that get a real `<Page>` (total ≈ 2×radius+1).
 * 4 → nine pages. Higher gives more buffer for fast scrolling at the cost of memory.
 */
const VIRTUAL_PAGE_RADIUS = 4;

/**
 * After the live `pageNumber` stops changing for this many ms, we update the
 * virtualization focus and (re)mount the surrounding `<Page>` components. This
 * stops the scrollbar drag from churning pdf.js render tasks — vital for scanned
 * image-only PDFs where each render is expensive and the worker can't preempt
 * an in-flight image decode.
 */
const VIRTUAL_FOCUS_DEBOUNCE_MS = 200;

/**
 * After the virtualization focus moves, render only the focus page for this long
 * before mounting the surrounding buffer pages. Makes the page the user is actually
 * looking at render first, instead of waiting for off-screen neighbours.
 */
const FOCUS_EXPAND_DELAY_MS = 350;

type Props = {
  file: File | null;
  pageNumber: number;
  scale: number;
  onPageCount: (count: number) => void;
  onPageChange: (page: number) => void;
  onPageDoubleClick: (info: PageDoubleClick) => void;
  detectionBox?: { x: number; y: number; w: number; h: number; pageNumber: number } | null;
};

function pageInVirtualWindow(
  p: number,
  focus: number,
  numPages: number,
  radius: number
): boolean {
  return p >= Math.max(1, focus - radius) && p <= Math.min(numPages, focus + radius);
}

export function PdfViewer(props: Props) {
  const { file, pageNumber, scale, onPageCount, onPageChange, onPageDoubleClick, detectionBox } =
    props;

  const fileMemo = useMemo(() => (file ? { url: URL.createObjectURL(file) } : null), [file]);
  useEffect(() => {
    return () => {
      if (fileMemo?.url) URL.revokeObjectURL(fileMemo.url);
    };
  }, [fileMemo]);

  const fileUrlRef = useRef<string | null>(null);
  useEffect(() => {
    fileUrlRef.current = fileMemo?.url ?? null;
  }, [fileMemo?.url]);

  const [numPages, setNumPages] = useState(0);
  const [pageBaseDims, setPageBaseDims] = useState<{ w: number; h: number }[] | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  /** Fraction along the scrollable range (0–1); kept in sync on scroll so zoom/pane layout can restore position. */
  const scrollRatioRef = useRef(0);
  /** Previous `scale` for detecting zoom-only layout changes (see scroll restore layout effect). */
  const prevScaleForScrollRef = useRef<number | null>(null);
  /** When scroll observation updates the page, avoid scrollIntoView — it fights the user's scroll position. */
  const skipScrollIntoViewForPageRef = useRef<number | null>(null);
  /** Latest pageNumber visible to the intersection observer callback (avoids effect churn during fast scroll). */
  const pageNumberRef = useRef(pageNumber);
  useEffect(() => {
    pageNumberRef.current = pageNumber;
  }, [pageNumber]);

  /**
   * Focus page used to decide which pages get a real `<Page>` (vs. a cheap placeholder).
   * Updated on a trailing-edge debounce after `pageNumber` stops changing, so a fast
   * scrollbar drag does not cause repeated mount/unmount of `<Page>` components.
   */
  const [virtualFocusPage, setVirtualFocusPage] = useState(pageNumber);
  useEffect(() => {
    if (virtualFocusPage === pageNumber) return;
    const t = setTimeout(() => setVirtualFocusPage(pageNumber), VIRTUAL_FOCUS_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [pageNumber, virtualFocusPage]);

  /**
   * Two-stage rendering: when the focus *jumps* far enough that the new buffer
   * would have no overlap with the old one (e.g., after a fast scrollbar drag),
   * first mount only the focus page so pdf.js renders it before anything else,
   * then expand to the full virtualization radius. Without this, the focus page
   * renders last in the worker queue on big jumps and the user stares at a white
   * center page while the off-screen buffer renders first.
   *
   * For *near* focus moves (slow page-by-page scrolling) we skip the collapse
   * entirely — the previously-rendered buffer pages remain mounted, no flicker.
   */
  const [focusPhaseExpanded, setFocusPhaseExpanded] = useState(true);
  const prevVirtualFocusRef = useRef(virtualFocusPage);
  useEffect(() => {
    const prevFocus = prevVirtualFocusRef.current;
    prevVirtualFocusRef.current = virtualFocusPage;
    if (prevFocus === virtualFocusPage) return;

    const jumpDistance = Math.abs(virtualFocusPage - prevFocus);
    // Old buffer was prevFocus ± VIRTUAL_PAGE_RADIUS. New buffer is virtualFocusPage ± radius.
    // They overlap when jumpDistance <= 2 * VIRTUAL_PAGE_RADIUS. If they do, keep the
    // buffer expanded so already-rendered pages stay mounted.
    if (jumpDistance <= 2 * VIRTUAL_PAGE_RADIUS) {
      setFocusPhaseExpanded(true);
      return;
    }

    setFocusPhaseExpanded(false);
    const t = setTimeout(() => setFocusPhaseExpanded(true), FOCUS_EXPAND_DELAY_MS);
    return () => clearTimeout(t);
  }, [virtualFocusPage]);

  const getPdfScrollPane = useCallback((): HTMLElement | null => {
    for (let p = 1; p <= numPages; p++) {
      const el = pageRefs.current[p];
      if (el) {
        const pane = el.closest(".pdf-pane");
        if (pane instanceof HTMLElement) return pane;
      }
    }
    return null;
  }, [numPages]);

  const syncScrollRatioFromPane = useCallback((pane: HTMLElement) => {
    const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
    scrollRatioRef.current = max > 0 ? pane.scrollTop / max : 0;
  }, []);

  useEffect(() => {
    pageRefs.current = {};
    skipScrollIntoViewForPageRef.current = null;
    prevScaleForScrollRef.current = null;
    scrollRatioRef.current = 0;
    setNumPages(0);
    setPageBaseDims(null);
    // Realign the virtualization focus to the current target page when a new
    // file is loaded — otherwise the next book briefly tries to mount pages
    // around the previous book's focus before the debounce catches up.
    setVirtualFocusPage(pageNumberRef.current);
  }, [fileMemo?.url]);

  const handleDocumentLoad = useCallback(
    (pdf: PDFDocumentProxy) => {
      onPageCount(pdf.numPages);
      const startedUrl = fileUrlRef.current;
      void (async () => {
        try {
          const dims = await Promise.all(
            Array.from({ length: pdf.numPages }, (_, idx) =>
              pdf.getPage(idx + 1).then((page) => {
                const vp = page.getViewport({ scale: 1 });
                return { w: vp.width, h: vp.height };
              })
            )
          );
          if (fileUrlRef.current !== startedUrl) return;
          setPageBaseDims(dims);
          setNumPages(pdf.numPages);
        } catch (e) {
          console.error("PDF page dimensions failed", e);
        }
      })();
    },
    [onPageCount]
  );

  const shouldRenderPdfPage = useCallback(
    (p: number) => {
      if (!numPages) return false;
      const radius = focusPhaseExpanded ? VIRTUAL_PAGE_RADIUS : 0;
      if (pageInVirtualWindow(p, virtualFocusPage, numPages, radius)) return true;
      const det = detectionBox?.pageNumber;
      if (det != null && pageInVirtualWindow(p, det, numPages, VIRTUAL_PAGE_RADIUS)) return true;
      return false;
    },
    [numPages, virtualFocusPage, focusPhaseExpanded, detectionBox?.pageNumber]
  );

  useEffect(() => {
    if (!numPages) return;
    const wrappers = Object.entries(pageRefs.current)
      .map(([k, el]) => ({ page: Number(k), el }))
      .filter((x): x is { page: number; el: HTMLDivElement } => !!x.el);
    if (!wrappers.length) return;

    // Measure intersection inside the PDF scrollport, not the viewport — avoids
    // spurious "current page" flips when only the side pane width changes.
    const scrollRoot =
      (wrappers[0].el.closest(".pdf-pane") as HTMLElement | null) ?? null;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const p = Number((visible.target as HTMLElement).dataset.page || 0);
        // Compare against the ref instead of a closed-over pageNumber so we don't
        // have to recreate the observer on every scroll-induced page change — that
        // churn drops scroll events and amplifies pdf.js render queuing on
        // image-heavy/scanned PDFs.
        if (p >= 1 && p !== pageNumberRef.current) {
          skipScrollIntoViewForPageRef.current = p;
          onPageChange(p);
        }
      },
      {
        ...(scrollRoot ? { root: scrollRoot } : {}),
        threshold: [0.5, 0.75],
      }
    );
    wrappers.forEach((w) => observer.observe(w.el));
    return () => observer.disconnect();
  }, [numPages, onPageChange, scale, pageBaseDims]);

  useEffect(() => {
    if (!numPages) return;
    if (skipScrollIntoViewForPageRef.current === pageNumber) {
      skipScrollIntoViewForPageRef.current = null;
      return;
    }
    skipScrollIntoViewForPageRef.current = null;
    const target = pageRefs.current[pageNumber];
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    const pane = target.closest(".pdf-pane");
    if (pane instanceof HTMLElement) {
      requestAnimationFrame(() => syncScrollRatioFromPane(pane));
    }
  }, [numPages, pageNumber, syncScrollRatioFromPane]);

  const layoutReady = pageBaseDims && pageBaseDims.length === numPages && numPages > 0;

  useEffect(() => {
    if (!layoutReady || !numPages) return;
    const pane = getPdfScrollPane();
    if (!pane) return;
    const onScroll = () => syncScrollRatioFromPane(pane);
    pane.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => pane.removeEventListener("scroll", onScroll);
  }, [layoutReady, numPages, getPdfScrollPane, syncScrollRatioFromPane]);

  /** Keep the same *relative* position when zoom changes (pixel scrollTop is wrong once slot heights change). */
  useLayoutEffect(() => {
    if (!layoutReady || !numPages) return;
    const pane = getPdfScrollPane();
    if (!pane) return;

    const prev = prevScaleForScrollRef.current;
    if (prev === null) {
      prevScaleForScrollRef.current = scale;
      syncScrollRatioFromPane(pane);
      return;
    }

    if (prev === scale) {
      const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
      if (max > 0) {
        pane.scrollTop = scrollRatioRef.current * max;
      }
      syncScrollRatioFromPane(pane);
      return;
    }

    prevScaleForScrollRef.current = scale;
    const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
    if (max <= 0) return;
    const r = scrollRatioRef.current;
    pane.scrollTop = r * max;
    syncScrollRatioFromPane(pane);
  }, [scale, numPages, layoutReady, getPdfScrollPane, syncScrollRatioFromPane]);

  const pageList = useMemo(
    () => (numPages ? Array.from({ length: numPages }, (_, i) => i + 1) : []),
    [numPages]
  );

  if (!file || !fileMemo) {
    return (
      <div className="empty">
        <p>No PDF loaded.</p>
        <p>Use the Open file button in the top bar to choose a chess book PDF.</p>
      </div>
    );
  }

  return (
    <Document
      file={fileMemo}
      onLoadSuccess={handleDocumentLoad}
      onLoadError={(err) => console.error("PDF load error", err)}
    >
      {!layoutReady ? (
        <div className="empty">
          <p>Preparing pages…</p>
        </div>
      ) : (
        <div className="pdf-scroll-stack">
          {pageList.map((p) => {
            const dim = pageBaseDims![p - 1];
            const w = dim.w * scale;
            const h = dim.h * scale;
            const shouldRender = shouldRenderPdfPage(p);
            return (
              <div
                key={p}
                ref={(el) => {
                  pageRefs.current[p] = el;
                }}
                data-page={p}
                className="pdf-page-slot"
                style={{
                  minHeight: h,
                  width: "100%",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "flex-start",
                }}
              >
                {shouldRender ? (
                  <RenderedPage
                    pageNumber={p}
                    scale={scale}
                    onPageDoubleClick={onPageDoubleClick}
                    detectionBox={detectionBox && detectionBox.pageNumber === p ? detectionBox : null}
                  />
                ) : (
                  <div
                    className="pdf-page-placeholder"
                    style={{ width: w, height: h, flexShrink: 0 }}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Document>
  );
}

function RenderedPage(props: {
  pageNumber: number;
  scale: number;
  onPageDoubleClick: (info: PageDoubleClick) => void;
  detectionBox?: { x: number; y: number; w: number; h: number; pageNumber: number } | null;
}) {
  const { pageNumber, scale, onPageDoubleClick, detectionBox } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderedSize, setRenderedSize] = useState<{ w: number; h: number } | null>(null);

  const handleRenderSuccess = useCallback(() => {
    const canvas = wrapperRef.current?.querySelector("canvas");
    if (canvas instanceof HTMLCanvasElement) {
      canvasRef.current = canvas;
      setRenderedSize({ w: canvas.clientWidth, h: canvas.clientHeight });
    }
  }, []);

  const handleDoubleClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        console.warn("[PdfViewer] double-click ignored: canvas not ready");
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const xInDisplay = e.clientX - rect.left;
      const yInDisplay = e.clientY - rect.top;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clickXFull = xInDisplay * scaleX;
      const clickYFull = yInDisplay * scaleY;

      const longest = Math.max(canvas.width, canvas.height);
      const downscale = Math.min(1, UPLOAD_MAX_DIMENSION / longest);
      const tw = Math.max(1, Math.round(canvas.width * downscale));
      const th = Math.max(1, Math.round(canvas.height * downscale));

      let pageWidth = canvas.width;
      let pageHeight = canvas.height;
      let clickX = clickXFull;
      let clickY = clickYFull;
      let upscaleToOriginal = 1;

      if (downscale < 1) {
        const off = document.createElement("canvas");
        off.width = tw;
        off.height = th;
        const ctx = off.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(canvas, 0, 0, tw, th);
        pageWidth = tw;
        pageHeight = th;
        clickX = clickXFull * downscale;
        clickY = clickYFull * downscale;
        upscaleToOriginal = 1 / downscale;
      }

      onPageDoubleClick({
        pageNumber,
        clickXOnPage: clickX,
        clickYOnPage: clickY,
        createPageImage: async () => {
          if (downscale < 1) {
            const off = document.createElement("canvas");
            off.width = tw;
            off.height = th;
            const ctx = off.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(canvas, 0, 0, tw, th);
            return new Promise<Blob | null>((resolve) => off.toBlob((b) => resolve(b), "image/png"));
          }
          return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
        },
        pageWidth,
        pageHeight,
        upscaleToOriginal,
      });
    },
    [onPageDoubleClick, pageNumber]
  );

  return (
    <div
      ref={(el) => {
        wrapperRef.current = el;
      }}
      className="pdf-page-wrapper"
      onDoubleClick={handleDoubleClick}
    >
      <Page
        pageNumber={pageNumber}
        scale={scale}
        renderAnnotationLayer={false}
        renderTextLayer={false}
        onRenderSuccess={handleRenderSuccess}
        onRenderError={(err) =>
          console.error("[PdfViewer] page render failed", { pageNumber, err })
        }
        onLoadError={(err) =>
          console.error("[PdfViewer] page load failed", { pageNumber, err })
        }
      />
      {detectionBox && renderedSize && canvasRef.current && (
        <DetectionBoxOverlay box={detectionBox} canvas={canvasRef.current} />
      )}
    </div>
  );
}

function DetectionBoxOverlay(props: {
  box: { x: number; y: number; w: number; h: number };
  canvas: HTMLCanvasElement;
}) {
  const { box, canvas } = props;
  const rect = canvas.getBoundingClientRect();
  const wrapperRect = canvas.parentElement?.getBoundingClientRect();
  if (!wrapperRect) return null;
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  const left = rect.left - wrapperRect.left + box.x * scaleX;
  const top = rect.top - wrapperRect.top + box.y * scaleY;
  const width = box.w * scaleX;
  const height = box.h * scaleY;
  return (
    <div
      className="detection-overlay"
      style={{ left, top, width, height }}
    />
  );
}
