import { useState } from "react";
import { LichessAnalysisMode } from "./analysis/LichessAnalysisMode";
import { LocalHistoryMode } from "./analysis/LocalHistoryMode";

type Props = {
  fen: string;
  note?: string | null;
  warnLowConfidence?: boolean;
  onFenChange: (fen: string) => void;
  onSaveCorrection?: (fen: string) => void;
};

export function AnalysisPanel(props: Props) {
  const { fen, note, warnLowConfidence, onFenChange, onSaveCorrection } = props;
  const [mode, setMode] = useState<"lichess" | "local">("lichess");

  return (
    <div className="analysis-panel">
      <h2>Position</h2>
      <div className="analysis-mode-selector" role="tablist" aria-label="Analysis mode">
        <button
          className={mode === "lichess" ? "primary" : ""}
          onClick={() => setMode("lichess")}
          role="tab"
          aria-selected={mode === "lichess"}
          data-testid="mode-lichess"
        >
          Lichess
        </button>
        <button
          className={mode === "local" ? "primary" : ""}
          onClick={() => setMode("local")}
          role="tab"
          aria-selected={mode === "local"}
          data-testid="mode-local"
        >
          Local history
        </button>
      </div>

      <LichessAnalysisMode
        visible={mode === "lichess"}
        fen={fen}
        note={note}
        warnLowConfidence={warnLowConfidence}
        onFenChange={onFenChange}
        onSaveCorrection={onSaveCorrection}
      />
      <LocalHistoryMode
        visible={mode === "local"}
        detectedFen={fen}
        onSaveCorrection={onSaveCorrection}
      />
    </div>
  );
}
