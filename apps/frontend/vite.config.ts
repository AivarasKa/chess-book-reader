import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["pdfjs-dist", "react-pdf"],
  },
  worker: {
    format: "es",
  },
});
