import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { applyDeadStones, findSekiPartnerStones, getGroup, scoreBoard, type Color, type Point } from 'shared';
import { useAuth } from '../hooks/useAuth';
import { useDialog } from '../hooks/useDialog';
import { useGame } from '../hooks/useGame';
import { useGameHistory } from '../hooks/useGameHistory';
import {
  addGameTag,
  deleteGame,
  removeGameTag,
  sgfExportUrl,
  starGame,
  unstarGame,
  updateGameTitle,
  validateMoveRequest,
  type Captures,
  type HistoryEntry,
  type MyColor,
} from '../services/api';
import { computeLiveClock, formatClock, timeControlLabel } from '../utils/clock';

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

function describeEntry(entry: Pick<HistoryEntry, 'eventType' | 'color' | 'point' | 'capturedPoints'>, size: number): string {
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
const CONFIRM_MOVES_KEY = 'go-confirm-moves';

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

// A player's name shown in the header/status text, linked to their profile.
function PlayerLink({ username, userId }: { username: string | null; userId: string | null }) {
  if (!username || !userId) {
    return <>{username ?? '—'}</>;
  }
  return <Link to={`/profile/${userId}`}>{username}</Link>;
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
    komi,
    title,
    setTitle,
    tags,
    setTags,
    starred,
    setStarred,
    captures,
    blackUsername,
    whiteUsername,
    blackUserId,
    whiteUserId,
    myColor,
    pendingUndoBy,
    endReason,
    pendingReopenBy,
    isAiOpponent,
    gnugoLevel,
    aiCurrentLevel,
    timeControl,
    mainTimeSeconds,
    byoyomiSeconds,
    byoyomiPeriods,
    blackTimeRemainingMs,
    whiteTimeRemainingMs,
    blackPeriodsLeft,
    whitePeriodsLeft,
    turnStartedAt,
    lastMove,
    lastEvent,
    canUndo,
    shortResult,
    resultBreakdown,
    notFound,
    error,
    play,
    pass,
    resign,
    endGame,
    undo,
    finalizeScoring,
    reopenScoring,
    clearError,
  } = useGame(gameId);
  const { history, error: historyError, load: loadHistory, clearError: clearHistoryError } = useGameHistory(gameId);
  const { user, logout } = useAuth();
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const wasReviewing = useRef(false);
  const [showCoords, setShowCoords] = useState(() => localStorage.getItem(SHOW_COORDS_KEY) !== 'false');
  const [showUndo, setShowUndo] = useState(() => localStorage.getItem(SHOW_UNDO_KEY) !== 'false');
  const [confirmMoves, setConfirmMoves] = useState(() => localStorage.getItem(CONFIRM_MOVES_KEY) === 'true');
  const [pendingMove, setPendingMove] = useState<Point | null>(null);
  const [invalidMoveError, setInvalidMoveError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [turnMenuOpen, setTurnMenuOpen] = useState(false);
  const [resultBalloonOpen, setResultBalloonOpen] = useState(false);
  const [pendingDead, setPendingDead] = useState<Set<string>>(new Set());
  // A group marked seki stays on the board (it's alive) but scores nothing
  // for either side — a separate declaration from marking it dead, since
  // that would otherwise remove it and credit prisoners, which is wrong
  // for a group that isn't actually captured. See scoreBoard's
  // declaredSekiPoints in shared.
  const [pendingSeki, setPendingSeki] = useState<Set<string>>(new Set());
  const [markMode, setMarkMode] = useState<'dead' | 'seki'>('dead');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const turnMenuRef = useRef<HTMLDivElement>(null);
  const resultBalloonRef = useRef<HTMLDivElement>(null);
  const moveChainRef = useRef<HTMLOListElement>(null);
  // Click-and-drag horizontal scrolling for the review move chain (touch
  // already scrolls natively) — tracked via a ref rather than state so
  // dragging doesn't trigger a re-render on every pointer move.
  const chainDrag = useRef({ dragging: false, moved: false, startX: 0, startScrollLeft: 0 });

  // Declared up here (rather than alongside the board-interaction handlers
  // further down) so the "game not found" early return below can use them
  // too, for a working Settings modal even without a loaded game.
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

  const toggleConfirmMoves = () => {
    setConfirmMoves((prev) => {
      const next = !prev;
      localStorage.setItem(CONFIRM_MOVES_KEY, String(next));
      return next;
    });
    setPendingMove(null);
  };

  // React Router sets location.key to 'default' only on the page's very
  // first load in this tab — i.e. there's no in-app history to go back to
  // (a direct link, a fresh tab). Falls back to the games list instead of
  // navigate(-1), which would otherwise leave the app or do nothing.
  const goBack = () => {
    if (location.key === 'default') {
      navigate('/');
    } else {
      navigate(-1);
    }
  };

  const userMenuItems = (
    <>
      {user && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            navigate(`/profile/${user.id}`);
          }}
        >
          View profile
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
      {/* Open to anyone: a spectator can't edit the title or tags (the
          modal shows them read-only, as does the server) but can still
          favourite the game from here. */}
      {user && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            setTagsOpen(true);
          }}
        >
          Title &amp; tags
        </button>
      )}
      {user ? (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            // Permissions (myColor, etc.) were fetched under the old
            // session and won't update in place — leave the game view
            // instead of showing stale, now-wrong controls.
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
    </>
  );

  const tagsModal = tagsOpen && (
    <div className="modal-overlay" onClick={() => setTagsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Title &amp; tags</h3>
        <TitleTagsEditor
          gameId={gameId}
          title={title}
          tags={tags}
          starred={starred}
          canEdit={myColor !== null}
          onTitleChange={setTitle}
          onTagsChange={setTags}
          onStarredChange={setStarred}
        />
        <button type="button" className="modal-action" onClick={() => setTagsOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );

  const settingsModal = settingsOpen && (
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
        <label className="modal-checkbox-row">
          <input type="checkbox" checked={confirmMoves} onChange={toggleConfirmMoves} />
          Confirm moves before playing them
        </label>
        <button type="button" className="modal-action" onClick={() => setSettingsOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );

  // Always on for a finished game — no more manual Review/Live toggle. A
  // ?move= param still selects which position within that history is shown
  // (bookmarkable, same as before), it just no longer controls whether
  // review mode itself is active.
  const isReviewing = status === 'finished';
  const moveParam = searchParams.get('move');
  const isTimed = mainTimeSeconds !== null;

  // Ticks the displayed clocks once a second — a preview only, the server
  // remains authoritative and resolves an actual timeout lazily on its own.
  // (status !== 'in_progress' already rules out isReviewing being true.)
  useEffect(() => {
    if (!isTimed || status !== 'in_progress') {
      return;
    }
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTimed, status]);

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

  // Close the result balloon on any click outside it.
  useEffect(() => {
    if (!resultBalloonOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (resultBalloonRef.current && !resultBalloonRef.current.contains(e.target as Node)) {
        setResultBalloonOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [resultBalloonOpen]);

  // Auto-dismiss the error toast after 5s — it can also be closed early.
  useEffect(() => {
    if (!error && !historyError && !invalidMoveError) {
      return;
    }
    const timeout = setTimeout(() => {
      clearError();
      clearHistoryError();
      setInvalidMoveError(null);
    }, 5000);
    return () => clearTimeout(timeout);
  }, [error, historyError, invalidMoveError, clearError, clearHistoryError]);

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

  // Fetch history fresh each time a game is found finished (including
  // landing directly on an already-finished game's URL), so it can't go
  // stale between visits.
  useEffect(() => {
    if (isReviewing && !wasReviewing.current) {
      loadHistory().catch(() => {});
    }
    wasReviewing.current = isReviewing;
  }, [isReviewing, loadHistory]);

  // Defaults to the last move once history loads, unless a ?move= is
  // already present (a bookmarked/shared link to a specific position) —
  // mirrors the old manual "Review" button's own jump-to-last behavior,
  // just triggered by the game being finished instead of a click.
  useEffect(() => {
    if (isReviewing && history && searchParams.get('move') === null) {
      setSearchParams({ move: String(history.length - 1) }, { replace: true });
    }
  }, [isReviewing, history, searchParams, setSearchParams]);

  // Keeps the currently-selected stone in view in the move chain — on
  // footer-button navigation, on clicking a stone directly, and on first
  // entering review (which jumps straight to the last move).
  useEffect(() => {
    if (!isReviewing) {
      return;
    }
    const current = moveChainRef.current?.querySelector<HTMLElement>('.go-move-chain-stone--current');
    current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [isReviewing, moveParam, history]);

  // A pending (unconfirmed) move marker only makes sense for the turn it
  // was placed on — clear it once that turn ends, one way or another (our
  // own confirmed move, the opponent's move arriving live, or entering
  // review), so it can't linger and mislead about whose turn it is.
  useEffect(() => {
    setPendingMove(null);
  }, [currentColor, isReviewing]);

  if (notFound) {
    return (
      <>
        <header className="go-header">
          <button type="button" className="back-toggle" onClick={goBack}>
            Back
          </button>
          <span />
          <div className="go-menu" ref={menuRef}>
            <button type="button" className="go-menu-toggle" onClick={() => setMenuOpen((open) => !open)}>
              Menu ▾
            </button>
            {menuOpen && <div className="go-menu-dropdown">{userMenuItems}</div>}
          </div>
        </header>
        <div className="go-board-wrap">
          <div className="go-empty-state">Game not found.</div>
        </div>
        {settingsModal}
        {tagsModal}
      </>
    );
  }

  if (!liveBoard) {
    return <p>Loading game...</p>;
  }

  const size = liveBoard.length;
  // Narrates live play for screen readers — the visible board already shows
  // this via the last-move marker and clocks, so it's announced but not
  // displayed. Review mode (always on once finished) gets its own
  // move-by-move list instead, so there's nothing left to narrate once the
  // game is over — this only ever fires for in-progress/scoring events.
  const liveAnnouncement = !isReviewing && lastEvent ? describeEntry(lastEvent, size) : '';
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
  // status === 'in_progress' already rules out isReviewing being true.
  const canInteract = status === 'in_progress' && isMyTurn;
  // Gates marking groups at all, regardless of which mode (dead vs seki).
  // scoring (status === 'scoring') already rules out isReviewing being true.
  const canMarkGroups = scoring && isParticipant;
  const navDisabled = latestMoveNumber === null || reviewMoveNumber === null;
  // Local games and AI games undo immediately (no negotiation) — same split
  // describeUndoAction uses to pick a label.
  const isImmediateUndo = myColor === 'both' || isAiOpponent;
  // Reformats the server's own "(B: x, W: y)" breakdown suffix into
  // "(winner to loser)", e.g. "White wins by 34.5 (64.5 to 30)".
  const resultSummary = (() => {
    if (!resultBreakdown) {
      return result;
    }
    const { black, white } = resultBreakdown;
    const winnerScore = black > white ? black : white;
    const loserScore = black > white ? white : black;
    const base = result?.replace(/\s*\(B: [\d.]+, W: [\d.]+\)\s*$/, '');
    return `${base} (${winnerScore} to ${loserScore})`;
  })();
  // Same "size · players · level · handicap · komi · time" shape as a
  // games-list card, minus what's already shown elsewhere in this view:
  // board size (implied by the board itself), the short result (its own
  // button), and player names when the header is already showing them
  // (it only falls back to the title there when one is set).
  const balloonSummaryParts: string[] = [];
  if (title) {
    balloonSummaryParts.push(
      myColor === 'both' ? `${blackUsername ?? '—'} (local)` : `${blackUsername ?? '—'} vs ${whiteUsername ?? '—'}`,
    );
  }
  if (isAiOpponent && gnugoLevel !== null) {
    balloonSummaryParts.push(`level ${gnugoLevel}`);
  }
  if (handicap > 0) {
    balloonSummaryParts.push(`handicap ${handicap}`);
  }
  balloonSummaryParts.push(komi === 0 ? 'no komi' : `komi ${komi}`);
  if (timeControl !== null) {
    balloonSummaryParts.push(timeControlLabel(timeControl));
  }
  const balloonSummary = balloonSummaryParts.join(' · ');
  // shortResult's leading letter names the winner regardless of how the
  // game ended (scored, resigned, or timed out) — reused here so the star
  // doesn't need its own separate parsing of `result`.

  // Live preview of the final result as dead/seki groups are marked,
  // computed client-side with the same shared scoring logic the server
  // uses at finalize time — so what's previewed here is exactly what gets
  // confirmed.
  let provisionalResult: string | null = null;
  // Which empty points to mark with a black/white territory square — kept
  // as key sets for O(1) lookup per board point below.
  let blackTerritoryKeys = new Set<string>();
  let whiteTerritoryKeys = new Set<string>();
  if (scoring) {
    const deadPointsArray = Array.from(pendingDead, parsePointKey);
    const sekiPointsArray = Array.from(pendingSeki, parsePointKey);
    const { board: effectiveBoard, captures: adjustedCaptures } = applyDeadStones(liveBoard, captures, deadPointsArray);
    const score = scoreBoard(effectiveBoard, adjustedCaptures, komi, sekiPointsArray);
    const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
    const marginLabel = Number.isInteger(score.margin) ? String(score.margin) : score.margin.toFixed(1);
    provisionalResult = `${winnerLabel} wins by ${marginLabel}`;
    blackTerritoryKeys = new Set(score.blackTerritoryPoints.map(pointKey));
    whiteTerritoryKeys = new Set(score.whiteTerritoryPoints.map(pointKey));
  }
  // While actively in Seki mode (not just whenever a seki mark exists), dim
  // the rest of the board instead of ringing the marked group itself —
  // switching to Dead mode hides this so the semi-transparent dead-stone
  // styling isn't competing with it for attention.
  const sekiActive = markMode === 'seki' && pendingSeki.size > 0;

  const blackClock = isTimed
    ? computeLiveClock(
        status === 'in_progress' && currentColor === 'black',
        blackTimeRemainingMs ?? 0,
        blackPeriodsLeft ?? 0,
        byoyomiSeconds ?? 0,
        turnStartedAt,
        nowMs,
      )
    : null;
  const whiteClock = isTimed
    ? computeLiveClock(
        status === 'in_progress' && currentColor === 'white',
        whiteTimeRemainingMs ?? 0,
        whitePeriodsLeft ?? 0,
        byoyomiSeconds ?? 0,
        turnStartedAt,
        nowMs,
      )
    : null;

  const clockLabel = (clock: NonNullable<typeof blackClock>) => {
    return clock.inByoyomi ? formatClock(clock.periodMs) : formatClock(clock.mainMs);
  };

  // Byoyomi periods left, as a bottom-anchored column of dots instead of
  // "(N left)" text — narrow footer space is at a premium, especially on
  // small screens. The column's height is fixed to the game's starting
  // period count (so it never grows past the turn-marker stone's
  // diameter), and dots disappear from the top as periods are used, so the
  // last remaining one always stays anchored at the bottom.
  const periodDots = (clock: NonNullable<typeof blackClock>) => {
    if (!clock.inByoyomi || byoyomiPeriods === null || byoyomiPeriods <= 1) {
      return null;
    }
    return (
      <span className="byoyomi-dots" style={{ '--byoyomi-total': byoyomiPeriods } as React.CSSProperties}>
        {Array.from({ length: clock.periodsLeft }, (_, i) => (
          <span key={i} className="byoyomi-dot" />
        ))}
      </span>
    );
  };

  const goToMove = (n: number) => {
    setSearchParams({ move: String(n) }, { replace: true });
  };

  const handleChainMouseDown = (e: React.MouseEvent<HTMLOListElement>) => {
    const el = e.currentTarget;
    chainDrag.current = { dragging: true, moved: false, startX: e.pageX, startScrollLeft: el.scrollLeft };
    el.style.cursor = 'grabbing';
  };

  const handleChainMouseMove = (e: React.MouseEvent<HTMLOListElement>) => {
    const drag = chainDrag.current;
    if (!drag.dragging) {
      return;
    }
    const delta = e.pageX - drag.startX;
    if (Math.abs(delta) > 3) {
      drag.moved = true;
    }
    e.currentTarget.scrollLeft = drag.startScrollLeft - delta;
  };

  const stopChainDrag = (e: React.MouseEvent<HTMLOListElement>) => {
    chainDrag.current.dragging = false;
    e.currentTarget.style.cursor = 'grab';
  };

  const handleStoneClick = (moveNumber: number) => {
    // A drag that ended on a stone shouldn't also count as clicking it.
    if (chainDrag.current.moved) {
      chainDrag.current.moved = false;
      return;
    }
    goToMove(moveNumber);
  };


  // Toggles every stone of a group in `set` together, since a group lives
  // or dies (or is in seki) as a unit — clicking a second stone in an
  // already-marked group un-marks the whole group rather than adding to
  // it. A group can't be marked both dead and seki at once (that's a
  // contradiction — dead means captured, seki means alive but neutral) —
  // marking it in one clears it from the other.
  const toggleGroupMembership = (
    keys: string[],
    set: Set<string>,
    setSet: (updater: (prev: Set<string>) => Set<string>) => void,
    otherSet: Set<string>,
    setOtherSet: (updater: (prev: Set<string>) => Set<string>) => void,
  ) => {
    const alreadyMarked = keys.some((key) => set.has(key));
    setSet((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (alreadyMarked) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
    if (!alreadyMarked && keys.some((key) => otherSet.has(key))) {
      setOtherSet((prev) => {
        const next = new Set(prev);
        for (const key of keys) {
          next.delete(key);
        }
        return next;
      });
    }
  };

  const toggleMarkedGroup = (x: number, y: number) => {
    const group = getGroup(liveBoard, { x, y });
    if (group.length === 0) {
      return;
    }
    if (markMode === 'dead') {
      const keys = group.map(pointKey);
      toggleGroupMembership(keys, pendingDead, setPendingDead, pendingSeki, setPendingSeki);
      return;
    }
    // Marking one side of a seki also marks the opposite-color group it
    // shares its vital liberty with — a seki is never just one group, and
    // requiring a second click on the other side is a natural spot to forget.
    const partnerStones = findSekiPartnerStones(liveBoard, { x, y });
    const keys = [...new Set([...group, ...partnerStones].map(pointKey))];
    toggleGroupMembership(keys, pendingSeki, setPendingSeki, pendingDead, setPendingDead);
  };

  const resume = () => {
    setPendingDead(new Set());
    setPendingSeki(new Set());
    undo();
  };

  const finalize = () => {
    finalizeScoring(Array.from(pendingDead, parsePointKey), Array.from(pendingSeki, parsePointKey))
      .then(() => {
        setPendingDead(new Set());
        setPendingSeki(new Set());
      })
      .catch(() => {});
  };

  const handleEndGame = () => {
    confirmDialog('End this game now? It will finish with no result.', 'End game').then((confirmed) => {
      if (confirmed) {
        endGame();
      }
    });
  };

  const handleDeleteGame = () => {
    confirmDialog('Delete this game and all its moves? This cannot be undone.', 'Delete').then((confirmed) => {
      if (!confirmed) {
        return;
      }
      deleteGame(gameId)
        .then(() => navigate('/'))
        .catch((err: Error) => alertDialog(err.message));
    });
  };

  // With "confirm moves" on: a first click on a valid point just marks it
  // (like marking a dead group during scoring); clicking that same marked
  // point again is what actually sends the move. Clicking a different
  // valid point just moves the mark there instead. An invalid point never
  // gets marked — it surfaces as an error instead. Validity is checked
  // against the server (rather than replicated client-side) so checks that
  // need the full position history — superko — are just as reliable as
  // occupied/turn/suicide, instead of only surfacing on the confirm step.
  const handlePointClick = (x: number, y: number) => {
    if (canMarkGroups) {
      toggleMarkedGroup(x, y);
      return;
    }
    if (!confirmMoves) {
      play(x, y);
      return;
    }
    if (pendingMove && pendingMove.x === x && pendingMove.y === y) {
      setPendingMove(null);
      play(x, y);
      return;
    }
    validateMoveRequest(gameId, x, y, currentColor)
      .then((result) => {
        if (result.valid) {
          setPendingMove({ x, y });
        } else {
          setInvalidMoveError(result.error ?? 'Invalid move');
        }
      })
      .catch((err: Error) => setInvalidMoveError(err.message));
  };

  return (
    <>
      <header className="go-header">
        <button type="button" className="back-toggle" onClick={goBack}>
          Back
        </button>
        {myColor === 'both' ? (
          <h2 className="game-title">
            {title || (
              <>
                <PlayerLink username={blackUsername} userId={blackUserId} /> (local)
              </>
            )}
          </h2>
        ) : (
          <h2 className="game-title">
            <PlayerLink username={blackUsername} userId={blackUserId} /> vs{' '}
            <PlayerLink username={whiteUsername} userId={whiteUserId} />
          </h2>
        )}
        <div className="go-menu" ref={menuRef}>
          <button type="button" className="go-menu-toggle" onClick={() => setMenuOpen((open) => !open)}>
            Menu ▾
          </button>
          {menuOpen && (
            <div className="go-menu-dropdown">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  window.location.href = sgfExportUrl(gameId);
                }}
              >
                Export SGF
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
              {myColor === 'both' && !finished && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    handleEndGame();
                  }}
                >
                  End game
                </button>
              )}
              {isParticipant && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    handleDeleteGame();
                  }}
                >
                  Delete game
                </button>
              )}
              <hr className="go-menu-divider" />
              {userMenuItems}
            </div>
          )}
        </div>
      </header>
      <div className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </div>
      <div className="go-board-wrap">
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
          <div className={`go-board${sekiActive ? ' go-board--dimmed' : ''}`}>
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
                    onClick={() => handlePointClick(x, y)}
                    disabled={canMarkGroups ? stone === null : stone !== null || !canInteract}
                    aria-label={`Point ${COLUMN_LABELS[x]}${size - y}`}
                  >
                    {stone && (
                      <span
                        className={`go-stone go-stone--${stone}${
                          highlightedPoint?.x === x && highlightedPoint?.y === y ? ' go-stone--last' : ''
                        }${markMode === 'dead' && pendingDead.has(pointKey({ x, y })) ? ' go-stone--dead' : ''}`}
                      />
                    )}
                    {!stone && pendingMove?.x === x && pendingMove?.y === y && (
                      <span className={`go-stone go-stone--${currentColor} go-stone--pending`} />
                    )}
                    {(!stone || pendingDead.has(pointKey({ x, y }))) &&
                      scoring &&
                      (blackTerritoryKeys.has(pointKey({ x, y })) || whiteTerritoryKeys.has(pointKey({ x, y }))) && (
                        <span
                          className={`go-territory-marker go-territory-marker--${
                            blackTerritoryKeys.has(pointKey({ x, y })) ? 'black' : 'white'
                          }`}
                        />
                      )}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {sekiActive && (
            // .go-board--dimmed's blur/contrast filter also blurs its
            // descendants with no way to opt a child out, so the marked-seki
            // stones are re-drawn crisp here, in an unblurred sibling layer
            // stacked on top at the same board coordinates.
            <div className="go-board-seki-highlight">
              {Array.from(pendingSeki, parsePointKey).map(({ x, y }) => (
                <span
                  key={`${x}-${y}`}
                  className={`go-stone go-stone--${displayedBoard[y][x]}`}
                  style={{ left: `calc(var(--pad) + var(--cell) / 2 + ${x} * var(--cell))`, top: `calc(var(--pad) + var(--cell) / 2 + ${y} * var(--cell))` }}
                />
              ))}
            </div>
          )}
        </div>
        {canMarkGroups && (
          <div className="go-mark-mode" role="group" aria-label="Marking mode">
            <span className={`go-mark-mode-thumb go-mark-mode-thumb--${markMode}`} aria-hidden="true" />
            <button
              type="button"
              className={markMode === 'dead' ? 'go-mark-mode-active' : ''}
              aria-pressed={markMode === 'dead'}
              onClick={() => setMarkMode('dead')}
            >
              Dead
            </button>
            <button
              type="button"
              className={markMode === 'seki' ? 'go-mark-mode-active' : ''}
              aria-pressed={markMode === 'seki'}
              onClick={() => setMarkMode('seki')}
            >
              Seki
            </button>
          </div>
        )}
        {status === 'in_progress' && lastEvent?.eventType === 'PASS' && (
          <p>{colorLabel(lastEvent.color)} passed.</p>
        )}
        {scoring && (
          <p>
            {markMode === 'dead'
              ? 'Marking dead stones — click a stone to toggle its group.'
              : 'Marking seki groups — click a stone to toggle its group. Stays on the board; scores nothing for either side.'}
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
        {status === 'in_progress' && isParticipant && !isMyTurn && !pendingUndoBy && (
          <p>
            Waiting for{' '}
            {(currentColor === 'black' ? blackUsername : whiteUsername) ? (
              <PlayerLink
                username={currentColor === 'black' ? blackUsername : whiteUsername}
                userId={currentColor === 'black' ? blackUserId : whiteUserId}
              />
            ) : (
              colorLabel(currentColor)
            )}{' '}
            to move.
          </p>
        )}
        {!isParticipant && status !== 'finished' && (
          <p>You're viewing as a spectator — log in as a player in this game to make moves.</p>
        )}
        {isReviewing && (
          <p>
            {reviewEntry ? describeEntry(reviewEntry, size) : 'Loading history...'}
            {!navDisabled && <> — move {reviewMoveNumber} of {latestMoveNumber}</>}
          </p>
        )}
        {isReviewing && history && (
          <ol
            ref={moveChainRef}
            className="go-move-chain"
            aria-label="Move history"
            onMouseDown={handleChainMouseDown}
            onMouseMove={handleChainMouseMove}
            onMouseUp={stopChainDrag}
            onMouseLeave={stopChainDrag}
          >
            {history.map((entry) => (
              <li key={entry.moveNumber}>
                <button
                  type="button"
                  className={`go-move-chain-stone go-move-chain-stone--${entry.color ?? 'neutral'}${
                    entry.moveNumber === reviewMoveNumber ? ' go-move-chain-stone--current' : ''
                  }`}
                  aria-current={entry.moveNumber === reviewMoveNumber ? 'step' : undefined}
                  aria-label={`${entry.moveNumber}: ${describeEntry(entry, size)}`}
                  onClick={() => handleStoneClick(entry.moveNumber)}
                >
                  {entry.moveNumber}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      <footer className="go-footer">
        <div className="footer-row">
          <span className="capture-label">
            <span className="capture-count capture-count--white" aria-label={`Black's prisoners: ${displayedCaptures.black}`}>
              {displayedCaptures.black}
            </span>
            {!isReviewing && blackClock && (
              <span className={`go-clock${currentColor === 'black' && status === 'in_progress' ? ' go-clock--active' : ''}`}>
                {clockLabel(blackClock)}
                {periodDots(blackClock)}
              </span>
            )}
          </span>
          <div className="footer-buttons">
            {status === 'in_progress' && (
              <div className="go-turn-menu" ref={turnMenuRef} style={{ '--cell': '24px' } as React.CSSProperties}>
                <button
                  type="button"
                  className="go-turn-toggle"
                  aria-label="Game actions"
                  disabled={!isParticipant}
                  onClick={() => setTurnMenuOpen((open) => !open)}
                >
                  <span className={`go-stone go-stone--${currentColor}`}>
                    {isAiOpponent && !isMyTurn && aiCurrentLevel !== null && (
                      <span className={`go-stone-level${aiCurrentLevel === 10 ? ' go-stone-level--ten' : ''}`}>
                        {aiCurrentLevel === 10 ? 'X' : aiCurrentLevel}
                      </span>
                    )}
                  </span>
                </button>
                {isParticipant && turnMenuOpen && (
                  <div className="go-turn-balloon">
                    {showUndo && (isImmediateUndo || canUndo) && (
                      <button
                        type="button"
                        disabled={isImmediateUndo && !canUndo}
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
            {scoring && isParticipant && (
              <div className="go-actions">
                {(() => {
                  const resumeLabel = describeUndoAction(myColor, pendingUndoBy, true, isAiOpponent);
                  return resumeLabel === 'Resume' ? (
                    <button type="button" className="icon-action-button" aria-label="Resume" onClick={resume}>
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path
                          fill="currentColor"
                          d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                        />
                      </svg>
                    </button>
                  ) : (
                    <button type="button" onClick={resume}>
                      {resumeLabel}
                    </button>
                  );
                })()}
                <button type="button" className="icon-action-button" aria-label="Finalize scoring" onClick={finalize}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                </button>
              </div>
            )}
            {finished && (
              // Flanking First/Last buttons around the result (or "No
              // result") button, rather than a separate 4-button nav row —
              // Prev/Next happen by tapping a stone directly in the move
              // chain below instead, to keep this footer slot compact now
              // that review is always showing here, not just on request.
              <div className="review-flanked">
                <button
                  type="button"
                  className="review-nav-button"
                  aria-label="First move"
                  onClick={() => goToMove(0)}
                  disabled={navDisabled || reviewMoveNumber === 0}
                >
                  {/* A thin stroked chevron + bar ("|<") reads as noticeably
                      more subtle than a filled glyph like ⏮ — closer to a
                      light/glass icon weight than a solid shape. */}
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <line x1="7" y1="5" x2="7" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <polyline
                      points="17,5 8,12 17,19"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {shortResult ? (
                  <div className="go-turn-menu" ref={resultBalloonRef}>
                    <button
                      type="button"
                      className="footer-result"
                      onClick={() => setResultBalloonOpen((open) => !open)}
                    >
                      {shortResult}
                    </button>
                    {resultBalloonOpen && (
                      <div className="go-turn-balloon go-result-balloon">
                        <div className="go-result-balloon-summary">{balloonSummary}</div>
                        <div>{resultSummary}</div>
                      </div>
                    )}
                  </div>
                ) : (
                  endReason === 'ended' && <span className="footer-result footer-result--static">No result</span>
                )}
                <button
                  type="button"
                  className="review-nav-button"
                  aria-label="Last move"
                  onClick={() => goToMove(latestMoveNumber ?? 0)}
                  disabled={navDisabled || reviewMoveNumber === latestMoveNumber}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <line x1="17" y1="5" x2="17" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <polyline
                      points="7,5 16,12 7,19"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            )}
          </div>
          <span className="capture-label">
            {!isReviewing && whiteClock && (
              <span className={`go-clock${currentColor === 'white' && status === 'in_progress' ? ' go-clock--active' : ''}`}>
                {clockLabel(whiteClock)}
                {periodDots(whiteClock)}
              </span>
            )}
            <span className="capture-count capture-count--black" aria-label={`White's prisoners: ${displayedCaptures.white}`}>
              {displayedCaptures.white}
            </span>
          </span>
        </div>
      </footer>
      {(error || historyError || invalidMoveError) && (
        <div className="error-toast">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="#d1242f"
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
            />
          </svg>
          <span>{error || historyError || invalidMoveError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              clearError();
              clearHistoryError();
              setInvalidMoveError(null);
            }}
          >
            ×
          </button>
        </div>
      )}
      {settingsModal}
      {tagsModal}
    </>
  );
}

// The Title & tags modal's contents: the game's title in an editable field,
// its tags as removable chips with one input for adding another, and a star
// toggling the game in and out of the viewer's favourites. The server
// validates the title and every tag and answers with the whole tag list, so
// this holds no rules of its own beyond a maxLength hint — anything it
// rejects comes back as a message shown under the fields.
//
// Only the two players can edit a title or tags; anyone else sees them
// read-only, since the star is open to everyone and is reached through this
// same modal.
interface TitleTagsEditorProps {
  gameId: string;
  title: string | null;
  tags: string[];
  starred: boolean;
  canEdit: boolean;
  onTitleChange: (title: string | null) => void;
  onTagsChange: (tags: string[]) => void;
  onStarredChange: (starred: boolean) => void;
}

function TitleTagsEditor({
  gameId,
  title,
  tags,
  starred,
  canEdit,
  onTitleChange,
  onTagsChange,
  onStarredChange,
}: TitleTagsEditorProps) {
  const [titleDraft, setTitleDraft] = useState(title ?? '');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveTitle = (e: React.FormEvent) => {
    e.preventDefault();
    const next = titleDraft.trim();
    if (busy || next === (title ?? '')) {
      return;
    }
    setBusy(true);
    updateGameTitle(gameId, next)
      .then((saved) => {
        onTitleChange(saved.title);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const toggleStarred = () => {
    setBusy(true);
    (starred ? unstarGame(gameId) : starGame(gameId))
      .then(() => {
        onStarredChange(!starred);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const tag = draft.trim();
    if (!tag || busy) {
      return;
    }
    setBusy(true);
    addGameTag(gameId, tag)
      .then(({ tags: updated }) => {
        onTagsChange(updated);
        setDraft('');
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const remove = (tag: string) => {
    setBusy(true);
    removeGameTag(gameId, tag)
      .then(({ tags: updated }) => {
        onTagsChange(updated);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        className={`star-button star-button--modal${starred ? ' star-button--active' : ''}`}
        aria-label={starred ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={starred}
        disabled={busy}
        onClick={toggleStarred}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
          />
        </svg>
      </button>
      {canEdit ? (
        <form className="tag-form" onSubmit={saveTitle}>
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Game title"
            aria-label="Game title"
            maxLength={100}
          />
          <button type="submit" className="modal-action" disabled={busy || titleDraft.trim() === (title ?? '')}>
            Save
          </button>
        </form>
      ) : (
        title && <p className="tag-empty">{title}</p>
      )}
      {tags.length > 0 ? (
        <ul className="tag-chips">
          {tags.map((tag) => (
            <li key={tag} className="tag-chip">
              {tag}
              {canEdit && (
                <button type="button" aria-label={`Remove tag ${tag}`} disabled={busy} onClick={() => remove(tag)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tag-empty">No tags yet.</p>
      )}
      {canEdit && (
        <form className="tag-form" onSubmit={submit}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a tag"
            aria-label="Add a tag"
            maxLength={24}
          />
          <button type="submit" className="modal-action" disabled={busy || !draft.trim()}>
            Add
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

export default Game;
