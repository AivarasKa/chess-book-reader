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
  const normalizedFen = fen.trim();
  return `https://lichess.org/embed/analysis?fen=${encodeURIComponent(normalizedFen)}`;
}

export function lichessEditorUrl(fen: string): string {
  return `https://lichess.org/editor/${lichessFenSegment(fen)}`;
}
