import { useEffect, useState } from "react";
import { LichessAnalysisMode } from "./analysis/LichessAnalysisMode";
import { LocalHistoryMode } from "./analysis/LocalHistoryMode";

type Props = {
  fen: string;
  note?: string | null;
  warnLowConfidence?: boolean;
  onFenChange: (fen: string) => void;
  onSaveCorrection?: (fen: string) => void;
  enableLocalHistory?: boolean;
};

export function AnalysisPanel(props: Props) {
  const { fen, note, warnLowConfidence, onFenChange, onSaveCorrection, enableLocalHistory } = props;
  const [mode, setMode] = useState<"lichess" | "local">("lichess");
  const localEnabled = !!enableLocalHistory;

  useEffect(() => {
    if (!localEnabled && mode === "local") setMode("lichess");
  }, [localEnabled, mode]);

  return (
    <div className="analysis-panel">
      <h2>Position</h2>
      {localEnabled && (
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
      )}

      <LichessAnalysisMode
        visible={!localEnabled || mode === "lichess"}
        fen={fen}
        note={note}
        warnLowConfidence={warnLowConfidence}
        onFenChange={onFenChange}
        onSaveCorrection={onSaveCorrection}
      />
      {localEnabled && (
        <LocalHistoryMode
          visible={mode === "local"}
          detectedFen={fen}
        />
      )}
    </div>
  );
}
