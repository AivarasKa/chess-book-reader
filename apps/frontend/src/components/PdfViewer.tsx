import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "../pdfWorker";

export type PageDoubleClick = {
  pageNumber: number;
  clickXOnPage: number;
  clickYOnPage: number;
  pageImage: Blob;
  pageWidth: number;
  pageHeight: number;
};

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
  const {
    file,
    pageNumber,
    scale,
    onPageCount,
    onPageChange,
    onPageDoubleClick,
    detectionBox,
  } = props;

  const fileMemo = useMemo(() => (file ? { url: URL.createObjectURL(file) } : null), [file]);
  useEffect(() => {
    return () => {
      if (fileMemo?.url) URL.revokeObjectURL(fileMemo.url);
    };
  }, [fileMemo]);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderedSize, setRenderedSize] = useState<{ w: number; h: number } | null>(null);

  const handleDocumentLoad = useCallback(
    ({ numPages }: { numPages: number }) => {
      onPageCount(numPages);
    },
    [onPageCount]
  );

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
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const xInDisplay = e.clientX - rect.left;
      const yInDisplay = e.clientY - rect.top;
      // Convert from displayed CSS pixels to pdf.js canvas pixels (= rendered page-space pixels)
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clickXOnPage = xInDisplay * scaleX;
      const clickYOnPage = yInDisplay * scaleY;

      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png")
      );
      if (!blob) return;

      onPageDoubleClick({
        pageNumber,
        clickXOnPage,
        clickYOnPage,
        pageImage: blob,
        pageWidth: canvas.width,
        pageHeight: canvas.height,
      });
    },
    [onPageDoubleClick, pageNumber]
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
      <div
        ref={wrapperRef}
        className="pdf-page-wrapper"
        onDoubleClick={handleDoubleClick}
      >
        <Page
          pageNumber={pageNumber}
          scale={scale}
          renderAnnotationLayer={false}
          renderTextLayer={false}
          onRenderSuccess={handleRenderSuccess}
        />
        {detectionBox &&
          detectionBox.pageNumber === pageNumber &&
          renderedSize &&
          canvasRef.current && (
            <DetectionBoxOverlay
              box={detectionBox}
              renderedSize={renderedSize}
              canvas={canvasRef.current}
            />
          )}
      </div>
      <PageNavSync pageNumber={pageNumber} onPageChange={onPageChange} />
    </Document>
  );
}

function PageNavSync(_: { pageNumber: number; onPageChange: (n: number) => void }) {
  return null;
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
