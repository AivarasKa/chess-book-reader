import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "../pdfWorker";

export type PageDoubleClick = {
  pageNumber: number;
  /** Click X in the *uploaded* image coordinate space (already downscaled). */
  clickXOnPage: number;
  /** Click Y in the *uploaded* image coordinate space (already downscaled). */
  clickYOnPage: number;
  pageImage: Blob;
  /** Width of the uploaded image (after downscale). */
  pageWidth: number;
  /** Height of the uploaded image (after downscale). */
  pageHeight: number;
  /** Factor mapping uploaded-image px → original canvas px (>= 1 when downscaled). */
  upscaleToOriginal: number;
};

const UPLOAD_MAX_DIMENSION = 1600;

type Props = {
  file: File | null;
  pageNumber: number;
  scale: number;
  onPageCount: (count: number) => void;
  onPageChange: (page: number) => void;
  onPageDoubleClick: (info: PageDoubleClick) => void;
  detectionBox?: { x: number; y: number; w: number; h: number; pageNumber: number } | null;
};

export function PdfViewer(props: Props) {
  const { file, pageNumber, scale, onPageCount, onPageChange, onPageDoubleClick, detectionBox } =
    props;

  const fileMemo = useMemo(() => (file ? { url: URL.createObjectURL(file) } : null), [file]);
  useEffect(() => {
    return () => {
      if (fileMemo?.url) URL.revokeObjectURL(fileMemo.url);
    };
  }, [fileMemo]);

  const [numPages, setNumPages] = useState(0);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const seenInitialPageRef = useRef(false);

  useEffect(() => {
    seenInitialPageRef.current = false;
    pageRefs.current = {};
    setNumPages(0);
  }, [fileMemo?.url]);

  const handleDocumentLoad = useCallback(
    ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
      onPageCount(numPages);
    },
    [onPageCount]
  );

  useEffect(() => {
    if (!numPages) return;
    const wrappers = Object.entries(pageRefs.current)
      .map(([k, el]) => ({ page: Number(k), el }))
      .filter((x): x is { page: number; el: HTMLDivElement } => !!x.el);
    if (!wrappers.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const p = Number((visible.target as HTMLElement).dataset.page || 0);
        if (p >= 1 && p !== pageNumber) onPageChange(p);
      },
      { threshold: [0.5, 0.75] }
    );
    wrappers.forEach((w) => observer.observe(w.el));
    return () => observer.disconnect();
  }, [numPages, onPageChange, pageNumber, scale]);

  useEffect(() => {
    if (!numPages) return;
    // Scroll to restored page once after load.
    if (seenInitialPageRef.current) return;
    const target = pageRefs.current[pageNumber];
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    seenInitialPageRef.current = true;
  }, [numPages, pageNumber]);

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
      <div className="pdf-scroll-stack">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
          <RenderedPage
            key={p}
            pageNumber={p}
            scale={scale}
            onPageDoubleClick={onPageDoubleClick}
            detectionBox={detectionBox && detectionBox.pageNumber === p ? detectionBox : null}
            setWrapperRef={(el) => {
              pageRefs.current[p] = el;
            }}
          />
        ))}
      </div>
    </Document>
  );
}

function RenderedPage(props: {
  pageNumber: number;
  scale: number;
  onPageDoubleClick: (info: PageDoubleClick) => void;
  detectionBox?: { x: number; y: number; w: number; h: number; pageNumber: number } | null;
  setWrapperRef: (el: HTMLDivElement | null) => void;
}) {
  const { pageNumber, scale, onPageDoubleClick, detectionBox, setWrapperRef } = props;
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

      let blob: Blob | null;
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
        blob = await new Promise<Blob | null>((resolve) =>
          off.toBlob((b) => resolve(b), "image/png")
        );
        pageWidth = tw;
        pageHeight = th;
        clickX = clickXFull * downscale;
        clickY = clickYFull * downscale;
        upscaleToOriginal = 1 / downscale;
      } else {
        blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png")
        );
      }
      if (!blob) return;

      onPageDoubleClick({
        pageNumber,
        clickXOnPage: clickX,
        clickYOnPage: clickY,
        pageImage: blob,
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
        setWrapperRef(el);
      }}
      className="pdf-page-wrapper"
      onDoubleClick={handleDoubleClick}
      data-page={pageNumber}
    >
      <Page
        pageNumber={pageNumber}
        scale={scale}
        renderAnnotationLayer={false}
        renderTextLayer={false}
        onRenderSuccess={handleRenderSuccess}
      />
      {detectionBox && renderedSize && canvasRef.current && (
        <DetectionBoxOverlay box={detectionBox} renderedSize={renderedSize} canvas={canvasRef.current} />
      )}
    </div>
  );
}

function DetectionBoxOverlay(props: {
  box: { x: number; y: number; w: number; h: number };
  renderedSize: { w: number; h: number };
  canvas: HTMLCanvasElement;
}) {
  const { box, canvas } = props;
  const rect = canvas.getBoundingClientRect();
  const wrapperRect = canvas.parentElement?.getBoundingClientRect();
  if (!wrapperRect) return null;
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  const left = (rect.left - wrapperRect.left) + box.x * scaleX;
  const top = (rect.top - wrapperRect.top) + box.y * scaleY;
  const width = box.w * scaleX;
  const height = box.h * scaleY;
  return (
    <div
      className="detection-overlay"
      style={{ left, top, width, height }}
    />
  );
}
