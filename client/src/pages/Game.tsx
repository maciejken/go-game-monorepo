import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { applyDeadStones, getGroup, getKomi, scoreBoard, type Color, type Point } from 'shared';
import { useAuth } from '../hooks/useAuth';
import { useGame } from '../hooks/useGame';
import { useGameHistory } from '../hooks/useGameHistory';
import type { Captures, HistoryEntry, MyColor } from '../services/api';
import { computeLiveClock, formatClock } from '../utils/clock';

// Go board columns skip the letter "I" to avoid confusion with the numeral 1
const COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST';

// Standard hoshi (star point) markers, as 0-indexed [x, y] coordinates
const HOSHI_POINTS: Record<number, [number, number][]> = {
  9: [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]],
  13: [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]],
  19: [
    [3, 3], [3, 9], [3, 15],
    [9, 3], [9, 9], [9, 15],
    [15, 3], [15, 9], [15, 15],
  ],
};

function getHoshiPoints(size: number): [number, number][] {
  return HOSHI_POINTS[size] ?? [];
}

function colorLabel(color: string | null): string {
  return color === 'black' ? 'Black' : color === 'white' ? 'White' : '';
}

function describeEntry(entry: HistoryEntry, size: number): string {
  switch (entry.eventType) {
    case 'START':
      return 'Start of game';
    case 'HANDICAP':
      return 'Handicap stones placed';
    case 'PASS':
      return `${colorLabel(entry.color)} passed`;
    case 'RESIGN':
      return `${colorLabel(entry.color)} resigned`;
    case 'MOVE': {
      if (!entry.point) {
        return `${colorLabel(entry.color)} played`;
      }
      const label = `${COLUMN_LABELS[entry.point.x]}${size - entry.point.y}`;
      const captureNote = entry.capturedPoints.length > 0 ? ` (captured ${entry.capturedPoints.length})` : '';
      return `${colorLabel(entry.color)} played ${label}${captureNote}`;
    }
    default:
      return '';
  }
}

// Cumulative captures as of `upToMoveNumber`, derived from the history log
// (which is densely indexed by moveNumber) for use in review mode.
function sumCaptures(entries: HistoryEntry[], upToMoveNumber: number): Captures {
  const captures: Captures = { black: 0, white: 0 };
  for (const entry of entries) {
    if (entry.moveNumber > upToMoveNumber || entry.eventType !== 'MOVE' || entry.capturedPoints.length === 0) {
      continue;
    }
    if (entry.color === 'black') {
      captures.black += entry.capturedPoints.length;
    } else if (entry.color === 'white') {
      captures.white += entry.capturedPoints.length;
    }
  }
  return captures;
}

const SHOW_COORDS_KEY = 'go-show-coordinates';
const SHOW_UNDO_KEY = 'go-show-undo';

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function parsePointKey(key: string): Point {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

// Local games (myColor 'both') and AI games undo immediately, since
// there's nobody else to ask; remote games negotiate — the label reflects
// whichever side of that negotiation the viewer is on.
function describeUndoAction(
  myColor: MyColor,
  pendingUndoBy: Color | null,
  scoring: boolean,
  isAiOpponent: boolean,
): string {
  if (myColor === 'both' || isAiOpponent) {
    return scoring ? 'Resume' : 'Undo';
  }
  if (pendingUndoBy === null) {
    return 'Request Undo';
  }
  if (pendingUndoBy === myColor) {
    return 'Cancel Undo Request';
  }
  return 'Confirm Undo';
}

// Same immediate-vs-negotiate split as describeUndoAction, for reopening a
// scoring-finished game to re-mark dead stones.
function describeReopenAction(myColor: MyColor, pendingReopenBy: Color | null, isAiOpponent: boolean): string {
  if (myColor === 'both' || isAiOpponent) {
    return 'Reopen scoring';
  }
  if (pendingReopenBy === null) {
    return 'Request reopen scoring';
  }
  if (pendingReopenBy === myColor) {
    return 'Cancel reopen scoring request';
  }
  return 'Confirm reopen scoring';
}

function Game() {
  const { id: gameId } = useParams<{ id: string }>();

  if (!gameId) {
    return <p>Game not found.</p>;
  }

  return <GameView gameId={gameId} />;
}

interface GameViewProps {
  gameId: string;
}

function GameView({ gameId }: GameViewProps) {
  const {
    board: liveBoard,
    currentColor,
    status,
    result,
    handicap,
    title,
    captures,
    blackUsername,
    whiteUsername,
    myColor,
    pendingUndoBy,
    endReason,
    pendingReopenBy,
    isAiOpponent,
    mainTimeSeconds,
    byoyomiSeconds,
    byoyomiPeriods,
    blackTimeRemainingMs,
    whiteTimeRemainingMs,
    blackPeriodsLeft,
    whitePeriodsLeft,
    turnStartedAt,
    lastMove,
    error,
    play,
    pass,
    resign,
    undo,
    finalizeScoring,
    reopenScoring,
    clearError,
  } = useGame(gameId);
  const { history, error: historyError, load: loadHistory } = useGameHistory(gameId);
  const { user, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const wasReviewing = useRef(false);
  const [showCoords, setShowCoords] = useState(() => localStorage.getItem(SHOW_COORDS_KEY) !== 'false');
  const [showUndo, setShowUndo] = useState(() => localStorage.getItem(SHOW_UNDO_KEY) !== 'false');
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [turnMenuOpen, setTurnMenuOpen] = useState(false);
  const [pendingDead, setPendingDead] = useState<Set<string>>(new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const turnMenuRef = useRef<HTMLDivElement>(null);

  const moveParam = searchParams.get('move');
  const isReviewing = moveParam !== null;
  const isTimed = mainTimeSeconds !== null;

  // Ticks the displayed clocks once a second — a preview only, the server
  // remains authoritative and resolves an actual timeout lazily on its own.
  useEffect(() => {
    if (!isTimed || status !== 'in_progress' || isReviewing) {
      return;
    }
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTimed, status, isReviewing]);

  // Close the header dropdown on any click outside it.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Close the turn-actions balloon on any click outside it.
  useEffect(() => {
    if (!turnMenuOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (turnMenuRef.current && !turnMenuRef.current.contains(e.target as Node)) {
        setTurnMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [turnMenuOpen]);

  // Close the settings modal on Escape.
  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [settingsOpen]);

  // Fetch history fresh each time review is entered (including landing
  // directly on a bookmarked ?move= URL), so it can't go stale between
  // separate review sessions.
  useEffect(() => {
    if (isReviewing && !wasReviewing.current) {
      loadHistory().catch(() => {});
    }
    wasReviewing.current = isReviewing;
  }, [isReviewing, loadHistory]);


  if (!liveBoard) {
    return <p>Loading game...</p>;
  }

  const size = liveBoard.length;
  const scoring = status === 'scoring';
  const finished = status === 'finished';

  const latestMoveNumber = history ? history.length - 1 : null;
  const requestedMove = moveParam !== null ? Number(moveParam) : null;
  const reviewMoveNumber =
    requestedMove !== null && latestMoveNumber !== null
      ? Math.min(Math.max(requestedMove, 0), latestMoveNumber)
      : requestedMove;
  const reviewEntry = history && reviewMoveNumber !== null ? history[reviewMoveNumber] : null;

  const displayedBoard = isReviewing && reviewEntry ? reviewEntry.board : liveBoard;
  const highlightedPoint = isReviewing ? (reviewEntry?.point ?? null) : lastMove;
  const displayedCaptures =
    isReviewing && history && reviewMoveNumber !== null ? sumCaptures(history, reviewMoveNumber) : captures;
  const isParticipant = myColor !== null;
  const isMyTurn = myColor === 'both' || myColor === currentColor;
  const canInteract = !isReviewing && status === 'in_progress' && isMyTurn;
  const canToggleDead = !isReviewing && scoring && isParticipant;
  const navDisabled = latestMoveNumber === null || reviewMoveNumber === null;

  // Live preview of the final result as dead stones are marked, computed
  // client-side with the same shared scoring logic the server uses at
  // finalize time — so what's previewed here is exactly what gets confirmed.
  let provisionalResult: string | null = null;
  if (scoring && !isReviewing) {
    const deadPointsArray = Array.from(pendingDead, parsePointKey);
    const { board: effectiveBoard, captures: adjustedCaptures } = applyDeadStones(liveBoard, captures, deadPointsArray);
    const score = scoreBoard(effectiveBoard, adjustedCaptures, getKomi(handicap));
    const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
    provisionalResult = `${winnerLabel} wins by ${score.margin.toFixed(1)} (B: ${score.black}, W: ${score.white})`;
  }

  const blackClock = isTimed
    ? computeLiveClock(
        !isReviewing && status === 'in_progress' && currentColor === 'black',
        blackTimeRemainingMs ?? 0,
        blackPeriodsLeft ?? 0,
        byoyomiSeconds ?? 0,
        turnStartedAt,
        nowMs,
      )
    : null;
  const whiteClock = isTimed
    ? computeLiveClock(
        !isReviewing && status === 'in_progress' && currentColor === 'white',
        whiteTimeRemainingMs ?? 0,
        whitePeriodsLeft ?? 0,
        byoyomiSeconds ?? 0,
        turnStartedAt,
        nowMs,
      )
    : null;

  const clockLabel = (clock: NonNullable<typeof blackClock>) => {
    if (!clock.inByoyomi) {
      return formatClock(clock.mainMs);
    }
    const showPeriods = byoyomiPeriods !== null && byoyomiPeriods > 1;
    return `${formatClock(clock.periodMs)}${showPeriods ? ` (${clock.periodsLeft} left)` : ''}`;
  };

  const goToMove = (n: number) => {
    setSearchParams({ move: String(n) }, { replace: true });
  };

  const enterReview = () => {
    clearError();
    // Mark review as already "entered" so the effect below doesn't also
    // fire a second fetch once isReviewing flips true as a result of this.
    wasReviewing.current = true;
    loadHistory()
      .then((moves) => setSearchParams({ move: String(moves.length - 1) }, { replace: true }))
      .catch(() => {});
  };

  const exitReview = () => {
    searchParams.delete('move');
    setSearchParams(searchParams, { replace: true });
  };

  // Marking any stone in a group toggles the whole group together, since a
  // group lives or dies as a unit — clicking a second stone in an
  // already-marked group un-marks the whole group rather than adding to it.
  const toggleDeadGroup = (x: number, y: number) => {
    const group = getGroup(liveBoard, { x, y });
    if (group.length === 0) {
      return;
    }
    const keys = group.map(pointKey);
    const alreadyDead = keys.some((key) => pendingDead.has(key));
    setPendingDead((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (alreadyDead) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  };

  const resume = () => {
    setPendingDead(new Set());
    undo();
  };

  const finalize = () => {
    finalizeScoring(Array.from(pendingDead, parsePointKey))
      .then(() => setPendingDead(new Set()))
      .catch(() => {});
  };

  const toggleCoords = () => {
    setShowCoords((prev) => {
      const next = !prev;
      localStorage.setItem(SHOW_COORDS_KEY, String(next));
      return next;
    });
  };

  const toggleUndo = () => {
    setShowUndo((prev) => {
      const next = !prev;
      localStorage.setItem(SHOW_UNDO_KEY, String(next));
      return next;
    });
  };

  return (
    <>
      <header className="go-header">
        <button type="button" className="back-toggle" onClick={() => navigate(-1)}>
          Back
        </button>
        {title ? <h2 className="game-title">{title}</h2> : <span />}
        <div className="go-menu" ref={menuRef}>
          <button type="button" className="go-menu-toggle" onClick={() => setMenuOpen((open) => !open)}>
            Menu ▾
          </button>
          {menuOpen && (
            <div className="go-menu-dropdown">
              <button
                type="button"
                onClick={() => {
                  (isReviewing ? exitReview : enterReview)();
                  setMenuOpen(false);
                }}
              >
                {isReviewing ? 'Live' : 'Review'}
              </button>
              {finished && endReason === 'scoring' && isParticipant && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    reopenScoring();
                  }}
                >
                  {describeReopenAction(myColor, pendingReopenBy, isAiOpponent)}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                Settings
              </button>
              {user ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    // Permissions (myColor, etc.) were fetched under the old
                    // session and won't update in place — leave the game
                    // view instead of showing stale, now-wrong controls.
                    logout().then(() => navigate('/'));
                  }}
                >
                  Log out ({user.username})
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate('/login', { state: { from: `${location.pathname}${location.search}` } });
                  }}
                >
                  Log in
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="go-board-wrap">
        {handicap > 0 && <p>Handicap: {handicap}</p>}
        {myColor !== 'both' && (blackUsername || whiteUsername) && (
          <p>
            Black: {blackUsername ?? '—'} · White: {whiteUsername ?? '—'}
          </p>
        )}
        <div
          className={`go-board-frame${showCoords ? '' : ' go-board-frame--no-coords'}`}
          style={{ '--size': size } as React.CSSProperties}
        >
          {showCoords && (
            <div className="go-coords go-coords--top">
              {Array.from({ length: size }, (_, x) => (
                <span key={x}>{COLUMN_LABELS[x]}</span>
              ))}
            </div>
          )}
          {showCoords && (
            <div className="go-coords go-coords--left">
              {Array.from({ length: size }, (_, y) => (
                <span key={y}>{size - y}</span>
              ))}
            </div>
          )}
          <div className="go-board">
            <div className="go-board-lines">
              {getHoshiPoints(size).map(([gx, gy]) => (
                <span
                  key={`${gx}-${gy}`}
                  className="go-hoshi"
                  style={{ left: `${(gx / (size - 1)) * 100}%`, top: `${(gy / (size - 1)) * 100}%` }}
                />
              ))}
            </div>
            {displayedBoard.map((row, y) => (
              <div className="go-row" key={y}>
                {row.map((stone, x) => (
                  <button
                    key={x}
                    type="button"
                    className="go-point"
                    onClick={() => (canToggleDead ? toggleDeadGroup(x, y) : play(x, y))}
                    disabled={canToggleDead ? stone === null : stone !== null || !canInteract}
                    aria-label={`Point ${COLUMN_LABELS[x]}${size - y}`}
                  >
                    {stone && (
                      <span
                        className={`go-stone go-stone--${stone}${
                          highlightedPoint?.x === x && highlightedPoint?.y === y ? ' go-stone--last' : ''
                        }${pendingDead.has(pointKey({ x, y })) ? ' go-stone--dead' : ''}`}
                      />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {!isReviewing && finished && <p>{result}</p>}
        {!isReviewing && scoring && (
          <p>
            Marking dead stones — click a stone to toggle its group.
            {provisionalResult && <> Estimated: {provisionalResult}</>}
          </p>
        )}
        {!isReviewing && isParticipant && pendingUndoBy && myColor !== 'both' && (
          <p>
            {pendingUndoBy === myColor
              ? 'Waiting for the other player to confirm your undo request.'
              : `${colorLabel(pendingUndoBy)} requested to undo the last move.`}
          </p>
        )}
        {!isReviewing && isParticipant && pendingReopenBy && myColor !== 'both' && (
          <p>
            {pendingReopenBy === myColor
              ? 'Waiting for the other player to confirm reopening scoring.'
              : `${colorLabel(pendingReopenBy)} requested to reopen scoring.`}
          </p>
        )}
        {!isReviewing && status === 'in_progress' && isParticipant && !isMyTurn && !pendingUndoBy && (
          <p>Waiting for {(currentColor === 'black' ? blackUsername : whiteUsername) ?? colorLabel(currentColor)} to move.</p>
        )}
        {!isReviewing && !isParticipant && status !== 'finished' && (
          <p>You're viewing as a spectator — log in as a player in this game to make moves.</p>
        )}
        {!isReviewing && error && <p className="error">{error}</p>}
        {isReviewing && (
          <p>
            {reviewEntry ? describeEntry(reviewEntry, size) : 'Loading history...'}
            {!navDisabled && <> — move {reviewMoveNumber} of {latestMoveNumber}</>}
          </p>
        )}
      </div>
      <footer className="go-footer">
        <div className="footer-row">
          <span className="capture-label">
            B: <span className="capture-count capture-count--white">{displayedCaptures.black}</span>
            {!isReviewing && blackClock && (
              <span className={`go-clock${currentColor === 'black' && status === 'in_progress' ? ' go-clock--active' : ''}`}>
                {clockLabel(blackClock)}
              </span>
            )}
          </span>
          <div className="footer-buttons">
            {status === 'in_progress' && !isReviewing && isParticipant && (
              <div className="go-turn-menu" ref={turnMenuRef} style={{ '--cell': '24px' } as React.CSSProperties}>
                <button
                  type="button"
                  className="go-turn-toggle"
                  aria-label="Game actions"
                  onClick={() => setTurnMenuOpen((open) => !open)}
                >
                  <span className={`go-stone go-stone--${currentColor}`} />
                </button>
                {turnMenuOpen && (
                  <div className="go-turn-balloon">
                    {showUndo && (
                      <button
                        type="button"
                        onClick={() => {
                          setTurnMenuOpen(false);
                          undo();
                        }}
                      >
                        {describeUndoAction(myColor, pendingUndoBy, false, isAiOpponent)}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setTurnMenuOpen(false);
                        pass();
                      }}
                      disabled={!isMyTurn}
                    >
                      Pass
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTurnMenuOpen(false);
                        resign();
                      }}
                    >
                      Resign
                    </button>
                  </div>
                )}
              </div>
            )}
            {scoring && !isReviewing && isParticipant && (
              <div className="go-actions">
                <button type="button" onClick={resume}>
                  {describeUndoAction(myColor, pendingUndoBy, true, isAiOpponent)}
                </button>
                <button type="button" onClick={finalize}>
                  Finalize scoring
                </button>
              </div>
            )}
            {isReviewing && (
              <div className="review-controls">
                <button type="button" onClick={() => goToMove(0)} disabled={navDisabled || reviewMoveNumber === 0}>
                  ⏮ First
                </button>
                <button
                  type="button"
                  onClick={() => goToMove((reviewMoveNumber ?? 0) - 1)}
                  disabled={navDisabled || reviewMoveNumber === 0}
                >
                  ◀ Prev
                </button>
                <button
                  type="button"
                  onClick={() => goToMove((reviewMoveNumber ?? 0) + 1)}
                  disabled={navDisabled || reviewMoveNumber === latestMoveNumber}
                >
                  Next ▶
                </button>
                <button
                  type="button"
                  onClick={() => goToMove(latestMoveNumber ?? 0)}
                  disabled={navDisabled || reviewMoveNumber === latestMoveNumber}
                >
                  Last ⏭
                </button>
              </div>
            )}
          </div>
          <span className="capture-label">
            {!isReviewing && whiteClock && (
              <span className={`go-clock${currentColor === 'white' && status === 'in_progress' ? ' go-clock--active' : ''}`}>
                {clockLabel(whiteClock)}
              </span>
            )}
            W: <span className="capture-count capture-count--black">{displayedCaptures.white}</span>
          </span>
        </div>
        {isReviewing && historyError && <p className="error">{historyError}</p>}
      </footer>
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Settings</h3>
            <label className="modal-checkbox-row">
              <input type="checkbox" checked={showCoords} onChange={toggleCoords} />
              Show coordinates
            </label>
            <label className="modal-checkbox-row">
              <input type="checkbox" checked={showUndo} onChange={toggleUndo} />
              Show Undo button
            </label>
            <button type="button" className="modal-action" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default Game;
