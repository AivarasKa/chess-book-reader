/** Helpers for handing off positions to Lichess. */

function lichessAnalysisPathFen(fen: string): string {
  // Lichess analysis URL format:
  // /analysis/<board_ranks>_<turn>_<castling>_<ep>_<halfmove>_<fullmove>
  // Keep board slashes, replace spaces between fields with underscores.
  return fen.trim().replaceAll(" ", "_");
}

export function lichessAnalysisUrl(fen: string): string {
  return `https://lichess.org/analysis/${lichessAnalysisPathFen(fen)}`;
}

export function lichessEmbedAnalysisUrl(fen: string): string {
  // Lichess embed expects query fen in "slash + underscore" style, e.g.
  // 4rk2/6b1/.../7K_w_-_-_0_1 (spaces become underscores, slashes stay).
  const embedFen = fen.trim().replaceAll(" ", "_");
  return `https://lichess.org/embed/analysis?fen=${embedFen}`;
}

export function lichessEditorUrl(fen: string): string {
  return `https://lichess.org/editor?fen=${encodeURIComponent(fen.trim())}`;
}
