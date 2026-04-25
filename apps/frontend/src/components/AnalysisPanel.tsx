import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { lichessAnalysisUrl, lichessEditorUrl } from "../lichess";

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
  const [pasteValue, setPasteValue] = useState("");

  const isValid = useMemo(() => {
    try {
      new Chess(fen);
      return true;
    } catch {
      return false;
    }
  }, [fen]);

  const openEditor = () => {
    window.open(lichessEditorUrl(fen), "_blank", "noopener,noreferrer");
    setPasteValue("");
    setEditorOpen(true);
  };

  const openAnalysis = () => {
    window.open(lichessAnalysisUrl(fen), "_blank", "noopener,noreferrer");
  };

  const applyPasted = () => {
    const trimmed = pasteValue.trim();
    if (!trimmed) return;
    try {
      new Chess(trimmed);
    } catch (err) {
      alert("That FEN doesn't look valid: " + (err as Error).message);
      return;
    }
    onFenChange(trimmed);
    onSaveCorrection?.(trimmed);
    setEditorOpen(false);
  };

  return (
    <>
      <h2>Position</h2>
      <div className="board-wrap">
        <Chessboard
          position={isValid ? fen : undefined}
          arePiecesDraggable={false}
          boardOrientation="white"
        />
      </div>

      <div className="fen-row">
        <input
          type="text"
          value={fen}
          onChange={(e) => onFenChange(e.target.value)}
          spellCheck={false}
        />
        <button
          onClick={() => navigator.clipboard.writeText(fen).catch(() => undefined)}
          title="Copy FEN"
        >
          Copy
        </button>
      </div>

      {note && (
        <div className={"note" + (warnLowConfidence ? " warning" : "")}>{note}</div>
      )}

      <div className="action-row">
        <button className="primary" onClick={openEditor}>
          Edit Board (Lichess)
        </button>
        <button onClick={openAnalysis}>Open in Lichess analysis</button>
      </div>

      {editorOpen && (
        <EditorReturnModal
          pasteValue={pasteValue}
          setPasteValue={setPasteValue}
          onApply={applyPasted}
          onCancel={() => setEditorOpen(false)}
        />
      )}
    </>
  );
}

function EditorReturnModal(props: {
  pasteValue: string;
  setPasteValue: (v: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { pasteValue, setPasteValue, onApply, onCancel } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Paste corrected FEN</h3>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13 }}>
          On Lichess, edit the position then copy the FEN from the share box and paste it
          below.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={pasteValue}
          onChange={(e) => setPasteValue(e.target.value)}
          placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        />
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onApply} disabled={!pasteValue.trim()}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
