import { useEffect, useState } from "react";
import { Chess, Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { lichessAnalysisUrl } from "../../lichess";

type LocalHistoryItem = {
  id: string;
  title: string;
  initialFen: string;
  moves: string[];
};

type Props = {
  visible: boolean;
  detectedFen: string;
  onSaveCorrection?: (fen: string) => void;
};

function replayFen(initialFen: string, moves: string[]): string {
  try {
    const g = new Chess(initialFen);
    for (const uci of moves) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const ok = g.move({ from, to, promotion });
      if (!ok) break;
    }
    return g.fen();
  } catch {
    return initialFen;
  }
}

export function LocalHistoryMode(props: Props) {
  const { visible, detectedFen, onSaveCorrection } = props;
  const [history, setHistory] = useState<LocalHistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workingInitialFen, setWorkingInitialFen] = useState(detectedFen);
  const [workingMoves, setWorkingMoves] = useState<string[]>([]);
  const [currentFen, setCurrentFen] = useState(detectedFen);
  const [nameDraft, setNameDraft] = useState("");
  const [boardRenderKey, setBoardRenderKey] = useState(0);

  useEffect(() => {
    if (visible) setBoardRenderKey((k) => k + 1);
  }, [visible]);
  const activeItem = history.find((h) => h.id === activeId) ?? null;

  const syncActiveItemMoves = (nextMoves: string[]) => {
    if (!activeId) return;
    setHistory((prev) => prev.map((h) => (h.id === activeId ? { ...h, moves: nextMoves } : h)));
  };

  const onPieceDrop = (from: Square, to: Square) => {
    const promotion = /[27]$/.test(to) ? "q" : undefined;
    const g = new Chess(currentFen);
    const move = g.move({ from, to, promotion });
    if (!move) return false;
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    const nextMoves = [...workingMoves, uci];
    setWorkingMoves(nextMoves);
    syncActiveItemMoves(nextMoves);
    setCurrentFen(g.fen());
    return true;
  };

  const resetLine = () => {
    setWorkingMoves([]);
    syncActiveItemMoves([]);
    setCurrentFen(workingInitialFen);
  };

  const undoMove = () => {
    if (!workingMoves.length) return;
    const nextMoves = workingMoves.slice(0, -1);
    setWorkingMoves(nextMoves);
    syncActiveItemMoves(nextMoves);
    setCurrentFen(replayFen(workingInitialFen, nextMoves));
  };

  const addToList = () => {
    const id = `history-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const title = nameDraft.trim() || `Puzzle ${history.length + 1}`;
    const item: LocalHistoryItem = {
      id,
      title,
      initialFen: currentFen,
      moves: [],
    };
    setHistory((prev) => [item, ...prev]);
    setActiveId(id);
    setWorkingInitialFen(currentFen);
    setWorkingMoves([]);
    setCurrentFen(currentFen);
    setNameDraft("");
  };

  const selectItem = (id: string) => {
    const item = history.find((h) => h.id === id);
    if (!item) return;
    setActiveId(id);
    setWorkingInitialFen(item.initialFen);
    setWorkingMoves(item.moves);
    setCurrentFen(replayFen(item.initialFen, item.moves));
  };

  const removeActive = () => {
    if (!activeId) return;
    const next = history.filter((h) => h.id !== activeId);
    setHistory(next);
    if (next.length) {
      const first = next[0];
      setActiveId(first.id);
      setWorkingInitialFen(first.initialFen);
      setWorkingMoves(first.moves);
      setCurrentFen(replayFen(first.initialFen, first.moves));
    } else {
      setActiveId(null);
      setWorkingInitialFen(detectedFen);
      setWorkingMoves([]);
      setCurrentFen(detectedFen);
    }
  };

  const loadDetected = () => {
    setActiveId(null);
    setWorkingInitialFen(detectedFen);
    setWorkingMoves([]);
    setCurrentFen(detectedFen);
  };

  const openInLichess = () => {
    window.open(lichessAnalysisUrl(currentFen), "_blank", "noopener,noreferrer");
  };

  return (
    <section className="analysis-mode local-mode" style={{ display: visible ? "flex" : "none" }}>
      <div className="local-history-toolbar">
        <input
          data-testid="history-name-input"
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          placeholder="Optional puzzle name"
        />
        <button className="primary" onClick={addToList} data-testid="history-add">
          Add to list
        </button>
      </div>

      {history.length > 0 && (
        <div className="local-history-toolbar">
          <select
            data-testid="history-select"
            value={activeId ?? ""}
            onChange={(e) => selectItem(e.target.value)}
            className="history-select"
          >
            <option value="" disabled>
              Select saved puzzle
            </option>
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title}
              </option>
            ))}
          </select>
          <button onClick={removeActive} disabled={!activeId} data-testid="history-remove">
            Remove
          </button>
        </div>
      )}

      <div className="local-board-wrap">
        <Chessboard
          key={boardRenderKey}
          id="local-history-board"
          position={currentFen}
          arePiecesDraggable
          onPieceDrop={onPieceDrop}
          customDarkSquareStyle={{ backgroundColor: "#b58863" }}
          customLightSquareStyle={{ backgroundColor: "#f0d9b5" }}
        />
      </div>

      <div className="note">
        {activeItem
          ? `Active: ${activeItem.title} (${workingMoves.length} moves)`
          : `Unsaved line (${workingMoves.length} moves)`}
      </div>

      <div className="action-row action-row-bottom">
        <button onClick={undoMove} disabled={!workingMoves.length}>
          Undo move
        </button>
        <button onClick={resetLine} disabled={!workingMoves.length}>
          Reset line
        </button>
        <button onClick={loadDetected}>Load detected position</button>
        <button onClick={openInLichess}>Open in Lichess analysis</button>
        <button className="primary" onClick={() => onSaveCorrection?.(currentFen)}>
          Save as correction
        </button>
      </div>
    </section>
  );
}
