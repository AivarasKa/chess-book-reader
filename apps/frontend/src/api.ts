export type Book = {
  id: number;
  fingerprint: string;
  path: string;
  title: string | null;
  last_page: number;
  last_fen: string | null;
  opened_at: string;
  updated_at: string;
  /** 1 after a full book precache pass; reopen skips re-indexing until cache clear. */
  precache_complete?: number;
};

export type DetectionResult = {
  fen: string;
  confidence: number;
  bounds: { x: number; y: number; w: number; h: number };
  warped_png_b64: string | null;
  from_cache: boolean;
  note: string | null;
};
type CacheLookupResponse = { hit: boolean; result: DetectionResult | null };
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || "";
const apiUrl = (path: string) => `${API_BASE}${path}`;

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
};

export async function openBook(input: {
  fingerprint: string;
  path: string;
  title?: string | null;
}): Promise<Book> {
  const res = await fetch(apiUrl("/api/books/open"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const { book } = await json<{ book: Book }>(res);
  return book;
}

export async function markPrecacheComplete(input: { fingerprint: string }): Promise<Book> {
  const res = await fetch(apiUrl("/api/books/precache-complete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint: input.fingerprint }),
  });
  const { book } = await json<{ book: Book }>(res);
  return book;
}

export async function updateBookProgress(input: {
  fingerprint: string;
  last_page?: number;
  last_fen?: string;
}): Promise<Book> {
  const res = await fetch(apiUrl("/api/books/progress"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const { book } = await json<{ book: Book }>(res);
  return book;
}

export async function listRecentBooks(): Promise<Book[]> {
  const res = await fetch(apiUrl("/api/books/recent"));
  const { books } = await json<{ books: Book[] }>(res);
  return books;
}

export async function getLastSession(): Promise<Book | null> {
  const res = await fetch(apiUrl("/api/session/last"));
  const { book } = await json<{ book: Book | null }>(res);
  return book;
}

export async function detectDiagram(input: {
  pageBlob?: Blob;
  createPageBlob?: () => Promise<Blob | null>;
  clickX: number;
  clickY: number;
  pageWidth?: number;
  pageHeight?: number;
  bookFingerprint?: string;
  page?: number;
  timeoutMs?: number;
}): Promise<DetectionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Detection request timed out")),
    input.timeoutMs ?? 60_000
  );
  try {
    const canLookupCache =
      !!input.bookFingerprint &&
      input.page != null &&
      input.pageWidth != null &&
      input.pageHeight != null &&
      input.pageWidth > 0 &&
      input.pageHeight > 0;

    if (canLookupCache) {
      const tLookup = performance.now();
      const lookupRes = await fetch(apiUrl("/api/diagram/cache-lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          click_x: input.clickX,
          click_y: input.clickY,
          page_width: input.pageWidth,
          page_height: input.pageHeight,
          book_fingerprint: input.bookFingerprint,
          page: input.page,
        }),
      });
      const lookupElapsed = performance.now() - tLookup;
      const lookup = await json<CacheLookupResponse>(lookupRes);
      console.log(
        `[api] detectDiagram cache-lookup ← ${lookupRes.status} in ${lookupElapsed.toFixed(0)} ms (hit=${lookup.hit})`
      );
      if (lookup.hit && lookup.result) {
        return lookup.result;
      }
    }

    const blob = input.pageBlob ?? (await input.createPageBlob?.());
    if (!blob) throw new Error("Could not capture page image for detection.");

    const fd = new FormData();
    fd.append("page_image", blob, "page.png");
    fd.append("click_x", String(input.clickX));
    fd.append("click_y", String(input.clickY));
    if (input.pageWidth != null) fd.append("page_width", String(input.pageWidth));
    if (input.pageHeight != null) fd.append("page_height", String(input.pageHeight));
    if (input.bookFingerprint) fd.append("book_fingerprint", input.bookFingerprint);
    if (input.page != null) fd.append("page", String(input.page));

    console.log(
      `[api] detectDiagram → POST /api/diagram/detect (blob ${(blob.size / 1024).toFixed(0)} KB)`
    );
    const t0 = performance.now();
    const res = await fetch(apiUrl("/api/diagram/detect"), {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    const elapsed = performance.now() - t0;
    const body = await json<DetectionResult>(res);
    console.log(
      `[api] detectDiagram ← ${res.status} in ${elapsed.toFixed(0)} ms (from_cache=${body.from_cache})`
    );
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveCorrection(input: {
  book_fingerprint: string;
  page: number;
  region_x: number;
  region_y: number;
  region_w: number;
  region_h: number;
  fen: string;
}): Promise<void> {
  const res = await fetch(apiUrl("/api/corrections"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await json<{ status: string }>(res);
}

export async function precachePage(input: {
  pageBlob: Blob;
  bookFingerprint: string;
  page: number;
}): Promise<{ added: number }> {
  const fd = new FormData();
  fd.append("page_image", input.pageBlob, "page.png");
  fd.append("book_fingerprint", input.bookFingerprint);
  fd.append("page", String(input.page));
  const res = await fetch(apiUrl("/api/diagram/precache-page"), {
    method: "POST",
    body: fd,
  });
  return json<{ status: string; added: number }>(res);
}

export async function clearCache(): Promise<void> {
  const res = await fetch(apiUrl("/api/cache/clear"), { method: "POST" });
  await json<{ status: string }>(res);
}

export async function resetDiagramRegion(input: {
  book_fingerprint: string;
  page: number;
  region_x: number;
  region_y: number;
  region_w: number;
  region_h: number;
  page_width?: number;
  page_height?: number;
}): Promise<{ removed_corrections: number; removed_diagram_cache: number }> {
  const res = await fetch(apiUrl("/api/diagram/reset-region"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return json<{ status: string; removed_corrections: number; removed_diagram_cache: number }>(res);
}
