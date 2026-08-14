import { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useGame } from '../hooks/useGame';
import { useGameHistory } from '../hooks/useGameHistory';
import type { Captures, HistoryEntry } from '../services/api';

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
    error,
    play,
    pass,
    resign,
    clearError,
  } = useGame(gameId);
  const { history, error: historyError, load: loadHistory } = useGameHistory(gameId);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const wasReviewing = useRef(false);

  const moveParam = searchParams.get('move');
  const isReviewing = moveParam !== null;

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
  const finished = status !== 'in_progress';

  const latestMoveNumber = history ? history.length - 1 : null;
  const requestedMove = moveParam !== null ? Number(moveParam) : null;
  const reviewMoveNumber =
    requestedMove !== null && latestMoveNumber !== null
      ? Math.min(Math.max(requestedMove, 0), latestMoveNumber)
      : requestedMove;
  const reviewEntry = history && reviewMoveNumber !== null ? history[reviewMoveNumber] : null;

  const displayedBoard = isReviewing && reviewEntry ? reviewEntry.board : liveBoard;
  const displayedCaptures =
    isReviewing && history && reviewMoveNumber !== null ? sumCaptures(history, reviewMoveNumber) : captures;
  const canInteract = !isReviewing && !finished;
  const navDisabled = latestMoveNumber === null || reviewMoveNumber === null;

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

  return (
    <div className="go-board-wrap">
      {handicap > 0 && <p>Handicap: {handicap}</p>}
      <div className="go-board-frame" style={{ '--size': size } as React.CSSProperties}>
        <div className="go-board-toolbar">
          <button type="button" className="back-toggle" onClick={() => navigate(-1)}>
            Back to games
          </button>
          <button type="button" className="review-toggle" onClick={isReviewing ? exitReview : enterReview}>
            {isReviewing ? 'Live' : 'Review'}
          </button>
        </div>
        {title && <h2 className="game-title">{title}</h2>}
        <div className="go-coords go-coords--top">
          {Array.from({ length: size }, (_, x) => (
            <span key={x}>{COLUMN_LABELS[x]}</span>
          ))}
        </div>
        <div className="go-coords go-coords--left">
          {Array.from({ length: size }, (_, y) => (
            <span key={y}>{size - y}</span>
          ))}
        </div>
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
                  onClick={() => play(x, y)}
                  disabled={stone !== null || !canInteract}
                  aria-label={`Point ${COLUMN_LABELS[x]}${size - y}`}
                >
                  {stone && (
                    <span
                      className={`go-stone go-stone--${stone}${
                        reviewEntry?.point?.x === x && reviewEntry?.point?.y === y ? ' go-stone--last' : ''
                      }`}
                    />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p>
        Captures - B: {displayedCaptures.black}, W: {displayedCaptures.white}
      </p>
      {!isReviewing && finished && <p>{result}</p>}
      {!finished && !isReviewing && <p>Current turn: {currentColor}</p>}
      {!finished && !isReviewing && (
        <div className="go-actions">
          <button type="button" onClick={pass}>
            Pass
          </button>
          <button type="button" onClick={resign}>
            Resign
          </button>
        </div>
      )}
      {!isReviewing && error && <p className="error">{error}</p>}
      {isReviewing && (
        <p>
          {reviewEntry ? describeEntry(reviewEntry, size) : 'Loading history...'}
          {!navDisabled && <> — move {reviewMoveNumber} of {latestMoveNumber}</>}
        </p>
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
      {isReviewing && historyError && <p className="error">{historyError}</p>}
    </div>
  );
}

export default Game;
