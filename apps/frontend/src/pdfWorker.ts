import { pdfjs } from "react-pdf";
// Vite-friendly way to load the pdf.js worker as a URL.
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
