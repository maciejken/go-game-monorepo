import { useCallback, useEffect, useState } from 'react';
import type { Board, Color, Point } from 'shared';
import {
  finalizeScoring as finalizeScoringRequest,
  getGame,
  makeMove,
  passTurn,
  reopenScoring as reopenScoringRequest,
  resignGame,
  undoMove,
  type Captures,
  type EndReason,
  type MyColor,
  type StoredTimeControl,
} from '../services/api';
import { useLiveSocket } from './useLiveSocket';

export function useGame(gameId: string) {
  const [board, setBoard] = useState<Board | null>(null);
  const [currentColor, setCurrentColor] = useState<Color>('black');
  const [status, setStatus] = useState<string>('in_progress');
  const [result, setResult] = useState<string | null>(null);
  const [handicap, setHandicap] = useState(0);
  const [title, setTitle] = useState<string | null>(null);
  const [captures, setCaptures] = useState<Captures>({ black: 0, white: 0 });
  const [blackUsername, setBlackUsername] = useState<string | null>(null);
  const [whiteUsername, setWhiteUsername] = useState<string | null>(null);
  const [myColor, setMyColor] = useState<MyColor>(null);
  const [pendingUndoBy, setPendingUndoBy] = useState<Color | null>(null);
  const [endReason, setEndReason] = useState<EndReason>(null);
  const [pendingReopenBy, setPendingReopenBy] = useState<Color | null>(null);
  const [isAiOpponent, setIsAiOpponent] = useState(false);
  const [timeControl, setTimeControl] = useState<StoredTimeControl>(null);
  const [mainTimeSeconds, setMainTimeSeconds] = useState<number | null>(null);
  const [byoyomiSeconds, setByoyomiSeconds] = useState<number | null>(null);
  const [byoyomiPeriods, setByoyomiPeriods] = useState<number | null>(null);
  const [blackTimeRemainingMs, setBlackTimeRemainingMs] = useState<number | null>(null);
  const [whiteTimeRemainingMs, setWhiteTimeRemainingMs] = useState<number | null>(null);
  const [blackPeriodsLeft, setBlackPeriodsLeft] = useState<number | null>(null);
  const [whitePeriodsLeft, setWhitePeriodsLeft] = useState<number | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [lastMove, setLastMove] = useState<Point | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return getGame(gameId)
      .then((game) => {
        setBoard(game.board);
        setCurrentColor(game.currentColor);
        setStatus(game.status);
        setResult(game.result);
        setHandicap(game.handicap);
        setTitle(game.title);
        setCaptures(game.captures);
        setBlackUsername(game.blackUsername);
        setWhiteUsername(game.whiteUsername);
        setMyColor(game.myColor);
        setPendingUndoBy(game.pendingUndoBy);
        setEndReason(game.endReason);
        setPendingReopenBy(game.pendingReopenBy);
        setIsAiOpponent(game.isAiOpponent);
        setTimeControl(game.timeControl);
        setMainTimeSeconds(game.mainTimeSeconds);
        setByoyomiSeconds(game.byoyomiSeconds);
        setByoyomiPeriods(game.byoyomiPeriods);
        setBlackTimeRemainingMs(game.blackTimeRemainingMs);
        setWhiteTimeRemainingMs(game.whiteTimeRemainingMs);
        setBlackPeriodsLeft(game.blackPeriodsLeft);
        setWhitePeriodsLeft(game.whitePeriodsLeft);
        setTurnStartedAt(game.turnStartedAt);
        setLastMove(game.lastMove);
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates: the opponent's move/pass/undo request lands here without
  // needing a manual reload.
  useLiveSocket(`/ws/games/${gameId}`, refresh);

  const play = useCallback(
    (x: number, y: number) => {
      setError(null);
      makeMove(gameId, x, y, currentColor)
        .then((res) => {
          setBoard(res.board);
          setCurrentColor(res.nextColor);
          setCaptures(res.captures);
          // The move response doesn't carry clock fields (they'd just
          // duplicate GameStateResponse) — refresh to pick up the newly
          // reset turnStartedAt and deducted remaining time.
          return refresh();
        })
        .catch((err: Error) => setError(err.message));
    },
    [gameId, currentColor, refresh],
  );

  const pass = useCallback(() => {
    setError(null);
    passTurn(gameId, currentColor)
      .then((res) => {
        setCurrentColor(res.nextColor);
        setStatus(res.status);
        setResult(res.result);
        return refresh();
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId, currentColor, refresh]);

  const resign = useCallback(() => {
    setError(null);
    // Resigning isn't turn-gated, so it goes out as the caller's own
    // assigned color rather than whoever's turn it happens to be — for a
    // local game (myColor 'both') that distinction doesn't matter.
    const resignColor = myColor === 'black' || myColor === 'white' ? myColor : currentColor;
    resignGame(gameId, resignColor)
      .then((res) => {
        setStatus(res.status);
        setResult(res.result);
        setEndReason('resign');
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId, currentColor, myColor]);

  const undo = useCallback(() => {
    setError(null);
    undoMove(gameId)
      .then((res) => {
        setPendingUndoBy(res.pendingUndoBy);
        if (res.action === 'confirmed') {
          setBoard(res.board);
          setCurrentColor(res.currentColor);
          setStatus(res.status);
          setResult(res.result);
          setCaptures(res.captures);
          // Undo resets turnStartedAt server-side — pick that up.
          return refresh();
        }
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId, refresh]);

  const reopenScoring = useCallback(() => {
    setError(null);
    reopenScoringRequest(gameId)
      .then((res) => {
        setPendingReopenBy(res.pendingReopenBy);
        if (res.action === 'confirmed') {
          setStatus(res.status);
          setResult(res.result);
          setEndReason(null);
        }
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId]);

  const finalizeScoring = useCallback(
    (deadPoints: Point[]) => {
      setError(null);
      return finalizeScoringRequest(gameId, deadPoints)
        .then((res) => {
          setStatus(res.status);
          setResult(res.result);
          setCaptures(res.captures);
          setEndReason('scoring');
        })
        .catch((err: Error) => {
          setError(err.message);
          throw err;
        });
    },
    [gameId],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    board,
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
    error,
    play,
    pass,
    resign,
    undo,
    finalizeScoring,
    reopenScoring,
    clearError,
  };
}
