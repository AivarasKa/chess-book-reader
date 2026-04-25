/** Helpers for handing off positions to Lichess. */

const FEN_PATH_ENCODING_MAP: Record<string, string> = {
  "/": "_",
  " ": "_",
};

function lichessFenSegment(fen: string): string {
  return fen
    .trim()
    .split("")
    .map((c) => FEN_PATH_ENCODING_MAP[c] ?? c)
    .join("");
}

export function lichessAnalysisUrl(fen: string): string {
  return `https://lichess.org/analysis/${lichessFenSegment(fen)}`;
}

export function lichessEmbedAnalysisUrl(fen: string): string {
  // Lichess embed expects query fen in "slash + underscore" style, e.g.
  // 4rk2/6b1/.../7K_w_-_-_0_1 (spaces become underscores, slashes stay).
  const embedFen = fen.trim().replaceAll(" ", "_");
  return `https://lichess.org/embed/analysis?fen=${embedFen}`;
}

export function lichessEditorUrl(fen: string): string {
  return `https://lichess.org/editor/${lichessFenSegment(fen)}`;
}
