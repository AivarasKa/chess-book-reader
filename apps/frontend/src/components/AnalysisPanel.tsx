import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  lichessAnalysisUrl,
  lichessEmbedAnalysisUrl,
} from "../lichess";

type Props = {
  fen: string;
  note?: string | null;
  warnLowConfidence?: boolean;
  onFenChange: (fen: string) => void;
  onSaveCorrection?: (fen: string) => void;
};

export function AnalysisPanel(props: Props) {
  const { fen, note, warnLowConfidence, onFenChange, onSaveCorrection } = props;
  const [editorOpen, setEditorOpen] = useState(false);
  const [embeddedFen, setEmbeddedFen] = useState(fen);
  const [embedOrientation, setEmbedOrientation] = useState<"white" | "black">("white");

  const isValid = useMemo(() => {
    try {
      new Chess(fen);
      return true;
    } catch {
      return false;
    }
  }, [fen]);

  useEffect(() => {
    if (isValid) setEmbeddedFen(fen);
  }, [fen, isValid]);

  const openEditor = () => setEditorOpen(true);

  const openAnalysis = () => {
    window.open(lichessAnalysisUrl(fen), "_blank", "noopener,noreferrer");
  };

  const toggleTurn = () => {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 6) return;
    parts[1] = parts[1] === "b" ? "w" : "b";
    onFenChange(parts.slice(0, 6).join(" "));
  };

  const toggleOrientation = () => {
    setEmbedOrientation((o) => (o === "white" ? "black" : "white"));
  };
  const visibleNote =
    note && note.startsWith("Recognized via Chess_diagram_to_FEN model.") ? null : note;

  return (
    <div className="analysis-panel">
      <h2>Position</h2>
      <div className="embed-controls">
        <button onClick={toggleTurn}>
          Turn: {fen.split(/\s+/)[1] === "b" ? "Black" : "White"}
        </button>
        <button onClick={toggleOrientation}>Flip board</button>
      </div>
      <div className="lichess-embed-wrap">
        <iframe
          key={`${embeddedFen}-${embedOrientation}`}
          title="Lichess embedded analysis"
          src={lichessEmbedAnalysisUrl(embeddedFen, embedOrientation)}
          referrerPolicy="no-referrer"
        />
      </div>

      {visibleNote && (
        <div className={"note" + (warnLowConfidence ? " warning" : "")}>{visibleNote}</div>
      )}

      <div className="action-row action-row-bottom">
        <button className="primary" onClick={openEditor}>
          Edit Board (Lichess)
        </button>
        <button onClick={openAnalysis}>Open in Lichess analysis</button>
      </div>

      {editorOpen && (
        <EditorOverlay
          initialFen={fen}
          onApply={(nextFen, save) => {
            onFenChange(nextFen);
            if (save) onSaveCorrection?.(nextFen);
            setEditorOpen(false);
          }}
          onCancel={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

type Piece = "p" | "n" | "b" | "r" | "q" | "k" | "P" | "N" | "B" | "R" | "Q" | "K";
type Cell = Piece | null;
type Board = Cell[][];
type BoardPosition = Record<string, string>;

const BLACK_PIECES: Piece[] = ["k", "q", "r", "b", "n", "p"];
const WHITE_PIECES: Piece[] = ["K", "Q", "R", "B", "N", "P"];
const PIECE_ICON_SRC: Record<Piece, string> = {
  k: "https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg",
  q: "https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg",
  r: "https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg",
  b: "https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg",
  n: "https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg",
  p: "https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg",
  K: "https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg",
  Q: "https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg",
  R: "https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg",
  B: "https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg",
  N: "https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg",
  P: "https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg",
};

function parseFenToEditorState(fen: string): {
  board: Board;
  sideToMove: "w" | "b";
  castling: string;
} {
  const parts = fen.trim().split(/\s+/);
  const placement = parts[0] ?? "8/8/8/8/8/8/8/8";
  const sideToMove: "w" | "b" = parts[1] === "b" ? "b" : "w";
  const castling = parts[2] ?? "-";

  const rows = placement.split("/");
  const board: Board = Array.from({ length: 8 }, () => Array<Cell>(8).fill(null));
  for (let r = 0; r < 8; r++) {
    const row = rows[r] ?? "8";
    let c = 0;
    for (const ch of row) {
      const n = Number(ch);
      if (!Number.isNaN(n) && n >= 1 && n <= 8) {
        c += n;
        continue;
      }
      if (c < 8 && /[pnbrqkPNBRQK]/.test(ch)) {
        board[r][c] = ch as Piece;
        c += 1;
      }
    }
  }

  return { board, sideToMove, castling };
}

function boardToPlacement(board: Board): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let row = "";
    let empties = 0;
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) {
        empties += 1;
      } else {
        if (empties > 0) row += String(empties);
        empties = 0;
        row += piece;
      }
    }
    if (empties > 0) row += String(empties);
    rows.push(row || "8");
  }
  return rows.join("/");
}

function boardToPositionMap(board: Board): BoardPosition {
  const out: BoardPosition = {};
  const files = "abcdefgh";
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const square = `${files[c]}${8 - r}`;
      const color = piece === piece.toUpperCase() ? "w" : "b";
      out[square] = `${color}${piece.toUpperCase()}`;
    }
  }
  return out;
}

function squareToRowCol(square: string): { r: number; c: number } | null {
  if (!/^[a-h][1-8]$/.test(square)) return null;
  const files = "abcdefgh";
  const c = files.indexOf(square[0]);
  const rank = Number(square[1]);
  const r = 8 - rank;
  if (c < 0 || r < 0 || r > 7) return null;
  return { r, c };
}

function EditorOverlay(props: {
  initialFen: string;
  onApply: (fen: string, save: boolean) => void;
  onCancel: () => void;
}) {
  const { initialFen, onApply, onCancel } = props;
  const parsed = useMemo(() => parseFenToEditorState(initialFen), [initialFen]);
  const [board, setBoard] = useState<Board>(parsed.board);
  const [selectedPiece, setSelectedPiece] = useState<Cell>("P");
  const [sideToMove, setSideToMove] = useState<"w" | "b">(parsed.sideToMove);
  const [castling, setCastling] = useState(parsed.castling === "-" ? "" : parsed.castling);
  const editorPosition = useMemo(() => boardToPositionMap(board), [board]);

  const apply = (save: boolean) => {
    const placement = boardToPlacement(board);
    const castlingPart = castling.trim() || "-";
    const nextFen = `${placement} ${sideToMove} ${castlingPart} - 0 1`;
    try {
      new Chess(nextFen);
    } catch (err) {
      alert("Edited position is not a valid FEN: " + (err as Error).message);
      return;
    }
    onApply(nextFen, save);
  };

  const placePiece = (r: number, c: number) => {
    setBoard((prev) => {
      const next = prev.map((row) => [...row]);
      next[r][c] = selectedPiece;
      return next;
    });
  };

  const onBoardSquareClick = (square: string) => {
    const rc = squareToRowCol(square);
    if (!rc) return;
    placePiece(rc.r, rc.c);
  };

  const hasCastle = (flag: "K" | "Q" | "k" | "q") => castling.includes(flag);
  const toggleCastle = (flag: "K" | "Q" | "k" | "q", checked: boolean) => {
    const allowed: Array<"K" | "Q" | "k" | "q"> = ["K", "Q", "k", "q"];
    const set = new Set(
      castling.split("").filter((c): c is "K" | "Q" | "k" | "q" => /[KQkq]/.test(c))
    );
    if (checked) set.add(flag);
    else set.delete(flag);
    setCastling(allowed.filter((f) => set.has(f)).join(""));
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal editor-modal">
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <button className="primary" onClick={() => apply(false)}>
            Apply
          </button>
          <button className="primary" onClick={() => apply(true)}>
            Save & Apply
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>

        <div className="editor-controls">
          <label>
            <input
              type="checkbox"
              checked={sideToMove === "w"}
              onChange={(e) => setSideToMove(e.target.checked ? "w" : "b")}
            />
            White's turn
          </label>
        </div>

        <div className="piece-row">
          {BLACK_PIECES.map((p) => (
            <button
              key={p}
              className={selectedPiece === p ? "active-piece" : ""}
              onClick={() => setSelectedPiece(p)}
              title={p}
              type="button"
            >
              <img src={PIECE_ICON_SRC[p]} alt={p} className="piece-icon" />
            </button>
          ))}
          <button
            className={selectedPiece === null ? "active-piece" : ""}
            onClick={() => setSelectedPiece(null)}
            type="button"
            title="Erase piece"
          >
            Erase
          </button>
          <label className="castle-toggle">
            <input
              type="checkbox"
              checked={hasCastle("k")}
              onChange={(e) => toggleCastle("k", e.target.checked)}
            />
            O-O
          </label>
          <label className="castle-toggle">
            <input
              type="checkbox"
              checked={hasCastle("q")}
              onChange={(e) => toggleCastle("q", e.target.checked)}
            />
            O-O-O
          </label>
        </div>

        <div className="editor-board-wrap">
          <Chessboard
            id="editor-board"
            position={editorPosition}
            boardOrientation="white"
            arePiecesDraggable={false}
            onSquareClick={onBoardSquareClick}
            customDarkSquareStyle={{ backgroundColor: "#b58863" }}
            customLightSquareStyle={{ backgroundColor: "#f0d9b5" }}
          />
        </div>

        <div className="piece-row">
          {WHITE_PIECES.map((p) => (
            <button
              key={p}
              className={selectedPiece === p ? "active-piece" : ""}
              onClick={() => setSelectedPiece(p)}
              title={p}
              type="button"
            >
              <img src={PIECE_ICON_SRC[p]} alt={p} className="piece-icon" />
            </button>
          ))}
          <button
            className={selectedPiece === null ? "active-piece" : ""}
            onClick={() => setSelectedPiece(null)}
            type="button"
            title="Erase piece"
          >
            Erase
          </button>
          <label className="castle-toggle">
            <input
              type="checkbox"
              checked={hasCastle("K")}
              onChange={(e) => toggleCastle("K", e.target.checked)}
            />
            O-O
          </label>
          <label className="castle-toggle">
            <input
              type="checkbox"
              checked={hasCastle("Q")}
              onChange={(e) => toggleCastle("Q", e.target.checked)}
            />
            O-O-O
          </label>
        </div>
      </div>
    </div>
  );
}
