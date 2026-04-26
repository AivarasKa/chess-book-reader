import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Chess } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Color, Key } from "chessground/types";
import type { Config } from "chessground/config";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import { lichessAnalysisUrl, lichessEditorUrl } from "../../lichess";

type VariationNode = {
  id: string;
  parentId: string | null;
  uci: string;
  san: string;
  fen: string;
  children: string[];
};

type VariationTree = {
  rootFen: string;
  nodes: Record<string, VariationNode>;
  rootChildren: string[];
  currentNodeId: string | null;
};

type LocalHistoryItem = {
  id: string;
  title: string;
  tree: VariationTree;
};

type Props = {
  visible: boolean;
  detectedFen: string;
};

/** chess.js uses w/b; chessground uses white/black */
function cgTurn(turn: "w" | "b"): Color {
  return turn === "w" ? "white" : "black";
}

function createTree(rootFen: string): VariationTree {
  return {
    rootFen,
    nodes: {},
    rootChildren: [],
    currentNodeId: null,
  };
}

function cloneTree(tree: VariationTree): VariationTree {
  const nodes: Record<string, VariationNode> = {};
  for (const [id, node] of Object.entries(tree.nodes)) {
    nodes[id] = { ...node, children: [...node.children] };
  }
  return {
    rootFen: tree.rootFen,
    nodes,
    rootChildren: [...tree.rootChildren],
    currentNodeId: tree.currentNodeId,
  };
}

function getCurrentFen(tree: VariationTree): string {
  if (!tree.currentNodeId) return tree.rootFen;
  return tree.nodes[tree.currentNodeId]?.fen ?? tree.rootFen;
}

function getCurrentPathIds(tree: VariationTree): string[] {
  const path: string[] = [];
  let id = tree.currentNodeId;
  while (id) {
    const node = tree.nodes[id];
    if (!node) break;
    path.push(id);
    id = node.parentId;
  }
  path.reverse();
  return path;
}

function movePrefix(turn: "w" | "b", fullMove: number): string {
  return turn === "w" ? `${fullMove}.` : `${fullMove}...`;
}

type InlineMove = {
  id: string;
  prefix: string;
  san: string;
  alternatives: InlineLine[];
};

type InlineLine = {
  moves: InlineMove[];
};

type InlineRow = {
  moveNumber: number;
  white?: InlineMove;
  black?: InlineMove;
};

function buildInlineLineFrom(
  tree: VariationTree,
  startId: string,
  turn: "w" | "b",
  fullMove: number,
  preferredPathIds: Set<string>,
  maxPlies = 80,
): InlineLine {
  const moves: InlineMove[] = [];
  let id: string | undefined = startId;
  let t = turn;
  let fm = fullMove;
  let plies = 0;
  while (id && plies < maxPlies) {
    const node: VariationNode | undefined = tree.nodes[id];
    if (!node) break;
    const nextTurn: "w" | "b" = t === "w" ? "b" : "w";
    const nextFullMove = t === "b" ? fm + 1 : fm;
    const preferredChild: string | undefined = node.children.find((cid: string) =>
      preferredPathIds.has(cid),
    );
    const chosenChild: string | undefined = preferredChild ?? node.children[0];
    const alternatives = node.children
      .filter((cid: string) => cid !== chosenChild)
      .map((cid: string) =>
        buildInlineLineFrom(tree, cid, nextTurn, nextFullMove, preferredPathIds, maxPlies),
      );

    moves.push({
      id: node.id,
      prefix: movePrefix(t, fm),
      san: node.san,
      alternatives,
    });
    id = chosenChild;
    t = nextTurn;
    fm = nextFullMove;
    plies += 1;
  }
  return { moves };
}

function buildInlineRows(line: InlineLine, rootTurn: "w" | "b", rootFullMove: number): InlineRow[] {
  const out: InlineRow[] = [];
  let turn = rootTurn;
  let fullMove = rootFullMove;
  for (const mv of line.moves) {
    if (turn === "w") {
      out.push({ moveNumber: fullMove, white: mv });
    } else {
      const last = out[out.length - 1];
      if (last && !last.black) last.black = mv;
      else out.push({ moveNumber: fullMove, black: mv });
    }
    if (turn === "b") fullMove += 1;
    turn = turn === "w" ? "b" : "w";
  }
  return out;
}

function addOrFollowMove(tree: VariationTree, uci: string, san: string, fen: string): VariationTree {
  const parentId = tree.currentNodeId;
  const siblingIds = parentId ? tree.nodes[parentId]?.children ?? [] : tree.rootChildren;
  const existingId = siblingIds.find((id) => tree.nodes[id]?.uci === uci);
  if (existingId) {
    return { ...tree, currentNodeId: existingId };
  }

  const nodeId = `mv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const node: VariationNode = {
    id: nodeId,
    parentId,
    uci,
    san,
    fen,
    children: [],
  };
  const next = cloneTree(tree);
  next.nodes[nodeId] = node;
  if (parentId) {
    const parent = next.nodes[parentId];
    if (parent) parent.children = [...parent.children, nodeId];
  } else {
    next.rootChildren = [...next.rootChildren, nodeId];
  }
  next.currentNodeId = nodeId;
  return next;
}

function setCurrentFenInTree(tree: VariationTree, nextFen: string): VariationTree {
  if (!tree.currentNodeId) return { ...tree, rootFen: nextFen };
  const next = cloneTree(tree);
  const current = next.nodes[tree.currentNodeId];
  if (current) current.fen = nextFen;
  return next;
}

function normalizeFenPosition(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  const placement = parts[0] ?? "";
  const turn = parts[1] ?? "w";
  const castling = parts[2] ?? "-";
  const ep = parts[3] ?? "-";
  return `${placement} ${turn} ${castling} ${ep}`;
}

function pickVerboseMove(g: Chess, orig: Key, dest: Key) {
  const candidates = g.moves({ verbose: true }).filter((m) => m.from === orig && m.to === dest);
  if (!candidates.length) return null;
  const promotions = candidates.filter((m) => m.promotion);
  if (promotions.length) {
    const q = promotions.find((m) => m.promotion === "q");
    return q ?? promotions[0];
  }
  return candidates[0];
}

function boardConfigFromFen(fen: string, lastUci: string | null): Config {
  const g = new Chess(fen);
  const dests = new Map<Key, Key[]>();
  for (const mv of g.moves({ verbose: true })) {
    const from = mv.from as Key;
    const to = mv.to as Key;
    const list = dests.get(from);
    if (list) {
      if (!list.includes(to)) list.push(to);
    } else {
      dests.set(from, [to]);
    }
  }
  let lastMove: [Key, Key] | undefined;
  if (lastUci && lastUci.length >= 4) {
    lastMove = [lastUci.slice(0, 2) as Key, lastUci.slice(2, 4) as Key];
  }
  const check: Color | boolean | undefined = g.isCheck() ? cgTurn(g.turn()) : undefined;
  return {
    fen: g.fen(),
    orientation: "white" as Color,
    turnColor: cgTurn(g.turn()),
    check,
    lastMove,
    autoCastle: true,
    movable: {
      free: false,
      color: cgTurn(g.turn()),
      dests,
      showDests: false,
    },
    premovable: { enabled: false },
    drawable: { enabled: false },
    highlight: { lastMove: false, check: true },
  };
}

export function LocalHistoryMode(props: Props) {
  const { visible, detectedFen } = props;
  const [history, setHistory] = useState<LocalHistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tree, setTree] = useState<VariationTree>(() => createTree(detectedFen));
  const [nameDraft, setNameDraft] = useState("");
  const [boardRenderKey, setBoardRenderKey] = useState(0);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");

  const boardElRef = useRef<HTMLDivElement | null>(null);
  const groundRef = useRef<Api | null>(null);
  const treeRef = useRef(tree);
  const redoNodeRef = useRef<string | null>(null);
  treeRef.current = tree;
  const lastDetectedFenRef = useRef(detectedFen);
  const currentFen = useMemo(() => getCurrentFen(tree), [tree]);
  const fenRef = useRef(currentFen);
  const activeIdRef = useRef(activeId);
  fenRef.current = currentFen;
  activeIdRef.current = activeId;

  useEffect(() => {
    if (visible) setBoardRenderKey((k) => k + 1);
  }, [visible]);

  useEffect(() => {
    if (normalizeFenPosition(detectedFen) === normalizeFenPosition(lastDetectedFenRef.current)) return;
    lastDetectedFenRef.current = detectedFen;
    // Keep saved history items, but always make the live board follow new scans.
    setActiveId(null);
    setTree(createTree(detectedFen));
    redoNodeRef.current = null;
  }, [detectedFen]);

  const currentPathIds = useMemo(() => getCurrentPathIds(tree), [tree]);
  const currentPathSet = useMemo(() => new Set(currentPathIds), [currentPathIds]);
  const rootTurn: "w" | "b" = useMemo(() => {
    const parts = tree.rootFen.trim().split(/\s+/);
    return parts[1] === "b" ? "b" : "w";
  }, [tree.rootFen]);
  const rootFullMove = useMemo(() => {
    const parts = tree.rootFen.trim().split(/\s+/);
    return Math.max(1, parseInt(parts[5] ?? "1", 10) || 1);
  }, [tree.rootFen]);
  const rootPreferred = useMemo(
    () => tree.rootChildren.find((id) => currentPathSet.has(id)) ?? tree.rootChildren[0] ?? null,
    [tree.rootChildren, currentPathSet],
  );
  const principalLine = useMemo(
    () =>
      rootPreferred
        ? buildInlineLineFrom(tree, rootPreferred, rootTurn, rootFullMove, currentPathSet)
        : { moves: [] as InlineMove[] },
    [tree, rootPreferred, rootTurn, rootFullMove, currentPathSet],
  );
  const principalRows = useMemo(
    () => buildInlineRows(principalLine, rootTurn, rootFullMove),
    [principalLine, rootTurn, rootFullMove],
  );
  const rootAlternatives = useMemo(
    () =>
      tree.rootChildren
        .filter((id) => id !== rootPreferred)
        .map((id) => buildInlineLineFrom(tree, id, rootTurn, rootFullMove, currentPathSet)),
    [tree, rootPreferred, rootTurn, rootFullMove, currentPathSet],
  );
  const sortedHistory = useMemo(
    () =>
      [...history].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }),
      ),
    [history],
  );

  const syncActiveItemTree = (nextTree: VariationTree) => {
    if (!activeId) return;
    setHistory((prev) => prev.map((h) => (h.id === activeId ? { ...h, tree: nextTree } : h)));
  };

  const ensureActiveAutosave = (nextTree: VariationTree): string => {
    if (activeIdRef.current) return activeIdRef.current;
    const id = `history-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const title = `Autosaved ${history.length + 1}`;
    const item: LocalHistoryItem = { id, title, tree: nextTree };
    setHistory((prev) => [item, ...prev]);
    setActiveId(id);
    activeIdRef.current = id;
    return id;
  };

  const addToList = () => {
    const id = `history-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const title = nameDraft.trim() || `Puzzle ${history.length + 1}`;
    const rootFen = currentFen;
    const freshTree = createTree(rootFen);
    const item: LocalHistoryItem = {
      id,
      title,
      tree: freshTree,
    };
    setHistory((prev) => [item, ...prev]);
    setActiveId(id);
    setTree(freshTree);
    setNameDraft("");
  };

  const selectItem = (id: string) => {
    const item = history.find((h) => h.id === id);
    if (!item) return;
    setActiveId(id);
    setTree(cloneTree(item.tree));
  };

  const removeActive = () => {
    if (!activeId) return;
    const next = history.filter((h) => h.id !== activeId);
    setHistory(next);
    if (next.length) {
      const first = next[0];
      setActiveId(first.id);
      setTree(cloneTree(first.tree));
    } else {
      setActiveId(null);
      setTree(createTree(detectedFen));
    }
  };

  const jumpToNode = (id: string | null, keepRedo = false) => {
    if (!keepRedo) redoNodeRef.current = null;
    setTree((prev) => {
      const next = { ...prev, currentNodeId: id };
      syncActiveItemTree(next);
      return next;
    });
  };

  const openInLichess = () => {
    window.open(lichessAnalysisUrl(currentFen), "_blank", "noopener,noreferrer");
  };
  const openEditor = () => {
    window.open(lichessEditorUrl(currentFen), "_blank", "noopener,noreferrer");
  };
  const stepBackward = () => {
    setTree((prev) => {
      if (!prev.currentNodeId) return prev;
      redoNodeRef.current = prev.currentNodeId;
      const parentId = prev.nodes[prev.currentNodeId]?.parentId ?? null;
      const next = { ...prev, currentNodeId: parentId };
      syncActiveItemTree(next);
      return next;
    });
  };
  const stepForward = () => {
    setTree((prev) => {
      const redoId = redoNodeRef.current;
      let targetId: string | null = null;
      if (redoId) {
        if (!prev.currentNodeId && prev.rootChildren.includes(redoId)) {
          targetId = redoId;
          redoNodeRef.current = null;
        } else if (prev.currentNodeId && (prev.nodes[prev.currentNodeId]?.children ?? []).includes(redoId)) {
          targetId = redoId;
          redoNodeRef.current = null;
        }
      }
      if (!targetId) {
        if (!prev.currentNodeId) targetId = prev.rootChildren[0] ?? null;
        else targetId = prev.nodes[prev.currentNodeId]?.children[0] ?? null;
      }
      if (!targetId) return prev;
      const next = { ...prev, currentNodeId: targetId };
      syncActiveItemTree(next);
      return next;
    });
  };
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepBackward();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, stepBackward, stepForward]);
  const toggleOrientation = () => {
    setBoardOrientation((o) => (o === "white" ? "black" : "white"));
  };
  const toggleTurn = () => {
    const parts = currentFen.trim().split(/\s+/);
    if (parts.length < 6) return;
    parts[1] = parts[1] === "b" ? "w" : "b";
    const nextFen = parts.slice(0, 6).join(" ");
    setTree((prev) => {
      const next = setCurrentFenInTree(prev, nextFen);
      syncActiveItemTree(next);
      return next;
    });
    fenRef.current = nextFen;
  };

  useEffect(() => {
    if (!visible) return;
    const el = boardElRef.current;
    if (!el) return;

    const initialPath = getCurrentPathIds(treeRef.current);
    const initialLast =
      initialPath.length > 0 ? treeRef.current.nodes[initialPath[initialPath.length - 1]]?.uci ?? null : null;
    const base = boardConfigFromFen(fenRef.current, initialLast);
    base.orientation = boardOrientation;

    const api = Chessground(el, {
      ...base,
      movable: {
        ...base.movable,
        events: {
          after(orig, dest) {
            const fenBefore = fenRef.current;
            const prevPath = getCurrentPathIds(treeRef.current);
            const prevLast =
              prevPath.length > 0 ? treeRef.current.nodes[prevPath[prevPath.length - 1]]?.uci ?? null : null;
            const g = new Chess(fenBefore);
            const pick = pickVerboseMove(g, orig, dest);
            if (!pick) {
              api.set(boardConfigFromFen(fenBefore, prevLast));
              return;
            }
            const m = g.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
            if (!m) {
              api.set(boardConfigFromFen(fenBefore, prevLast));
              return;
            }
            const uci = `${m.from}${m.to}${m.promotion ?? ""}`;
            const newFen = g.fen();
            redoNodeRef.current = null;
            setTree((prev) => {
              const next = addOrFollowMove(prev, uci, m.san, newFen);
              const aid = ensureActiveAutosave(next);
              setHistory((hprev) => hprev.map((h) => (h.id === aid ? { ...h, tree: next } : h)));
              return next;
            });
            fenRef.current = newFen;
            const nextCfg = boardConfigFromFen(newFen, uci);
            nextCfg.orientation = boardOrientation;
            api.set(nextCfg);
          },
        },
      },
    });
    groundRef.current = api;

    return () => {
      api.destroy();
      groundRef.current = null;
      el.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init only on remount / visibility; handlers use refs
  }, [visible, boardRenderKey, boardOrientation]);

  useEffect(() => {
    const api = groundRef.current;
    if (!api || !visible) return;
    const path = getCurrentPathIds(tree);
    const lastUci = path.length > 0 ? tree.nodes[path[path.length - 1]]?.uci ?? null : null;
    const cfg = boardConfigFromFen(currentFen, lastUci);
    cfg.orientation = boardOrientation;
    api.set(cfg);
  }, [currentFen, tree, visible, boardOrientation]);

  const renderInlineLine = (line: InlineLine, depth = 0) => (
    <span className="local-variation-line" style={{ "--inline-depth": depth } as CSSProperties}>
      <span>(</span>
      {line.moves.map((mv) => (
        <span key={mv.id} className="local-variation-token">
          <button
            className={"local-variation-btn" + (tree.currentNodeId === mv.id ? " active" : "")}
            onClick={() => jumpToNode(mv.id)}
            type="button"
          >
            <span className="local-movelist-num">{mv.prefix}</span>
            <span className="local-movelist-san">{mv.san}</span>
          </button>
          {mv.alternatives.map((alt, i) => (
            <span key={`${mv.id}-alt-${i}`} className="local-inline-nest">
              {renderInlineLine(alt, depth + 1)}
            </span>
          ))}
        </span>
      ))}
      <span>)</span>
    </span>
  );

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
            {sortedHistory.map((h) => (
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

      <div className="embed-controls">
        <button onClick={toggleTurn}>Turn: {rootTurn === "b" ? "Black" : "White"}</button>
        <button onClick={toggleOrientation}>Flip board</button>
      </div>

      <div className="local-board-wrap">
        <div
          ref={boardElRef}
          key={boardRenderKey}
          data-testid="local-history-board"
          className="local-cg-root cg-wrap theme-react-chessboard"
        />
      </div>

      <div className="local-movelist" aria-label="Main line moves" data-testid="local-movelist">
        {principalRows.length === 0 ? (
          <span className="local-movelist-empty">
            No moves yet - play on the board, then click any move to jump.
          </span>
        ) : (
          <div className="local-score-table">
            {rootAlternatives.length > 0 && (
              <div className="local-root-variations">
                {rootAlternatives.map((line, i) => (
                  <span key={`root-alt-${i}`} className="local-inline-nest">
                    {renderInlineLine(line)}
                  </span>
                ))}
              </div>
            )}
            {principalRows.map((row) => (
              <div
                key={`row-${row.moveNumber}-${row.white?.id ?? ""}-${row.black?.id ?? ""}`}
                className="local-line-row"
              >
                <div className="local-line-number">{row.moveNumber}.</div>
                <div className="local-line-moves">
                  <div className="local-ply-wrap">
                    {row.white ? (
                      (() => {
                        const white = row.white;
                        return (
                          <>
                            <button
                              className={"local-move-btn" + (tree.currentNodeId === white.id ? " active" : "")}
                              onClick={() => jumpToNode(white.id)}
                              type="button"
                            >
                              <span className="local-movelist-san">{white.san}</span>
                            </button>
                            {white.alternatives.map((alt, i) => (
                              <span key={`${white.id}-alt-${i}`} className="local-inline-nest">
                                {renderInlineLine(alt)}
                              </span>
                            ))}
                          </>
                        );
                      })()
                    ) : (
                      <span className="local-move-placeholder">...</span>
                    )}
                  </div>
                  <div className="local-ply-wrap">
                    {row.black ? (
                      (() => {
                        const black = row.black;
                        return (
                          <>
                            <button
                              className={"local-move-btn" + (tree.currentNodeId === black.id ? " active" : "")}
                              onClick={() => jumpToNode(black.id)}
                              type="button"
                            >
                              <span className="local-movelist-san">{black.san}</span>
                            </button>
                            {black.alternatives.map((alt, i) => (
                              <span key={`${black.id}-alt-${i}`} className="local-inline-nest">
                                {renderInlineLine(alt)}
                              </span>
                            ))}
                          </>
                        );
                      })()
                    ) : (
                      <span className="local-move-placeholder"> </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="action-row action-row-bottom">
        <button className="primary" onClick={openEditor}>
          Edit Board (Lichess)
        </button>
        <button onClick={openInLichess}>Open in Lichess analysis</button>
      </div>
    </section>
  );
}
