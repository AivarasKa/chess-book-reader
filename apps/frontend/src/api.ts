export type Book = {
  id: number;
  fingerprint: string;
  path: string;
  title: string | null;
  last_page: number;
  last_fen: string | null;
  opened_at: string;
  updated_at: string;
};

export type DetectionResult = {
  fen: string;
  confidence: number;
  bounds: { x: number; y: number; w: number; h: number };
  warped_png_b64: string | null;
  from_cache: boolean;
  note: string | null;
};

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
  const res = await fetch("/api/books/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const { book } = await json<{ book: Book }>(res);
  return book;
}

export async function updateBookProgress(input: {
  fingerprint: string;
  last_page?: number;
  last_fen?: string;
}): Promise<Book> {
  const res = await fetch("/api/books/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const { book } = await json<{ book: Book }>(res);
  return book;
}

export async function listRecentBooks(): Promise<Book[]> {
  const res = await fetch("/api/books/recent");
  const { books } = await json<{ books: Book[] }>(res);
  return books;
}

export async function getLastSession(): Promise<Book | null> {
  const res = await fetch("/api/session/last");
  const { book } = await json<{ book: Book | null }>(res);
  return book;
}

export async function detectDiagram(input: {
  pageBlob: Blob;
  clickX: number;
  clickY: number;
  bookFingerprint?: string;
  page?: number;
}): Promise<DetectionResult> {
  const fd = new FormData();
  fd.append("page_image", input.pageBlob, "page.png");
  fd.append("click_x", String(input.clickX));
  fd.append("click_y", String(input.clickY));
  if (input.bookFingerprint) fd.append("book_fingerprint", input.bookFingerprint);
  if (input.page != null) fd.append("page", String(input.page));
  const res = await fetch("/api/diagram/detect", { method: "POST", body: fd });
  return json<DetectionResult>(res);
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
  const res = await fetch("/api/corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await json<{ status: string }>(res);
}
