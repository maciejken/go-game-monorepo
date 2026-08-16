import { useCallback, useEffect, useState } from 'react';
import type { Board, Color, Point } from 'shared';
import {
  finalizeScoring as finalizeScoringRequest,
  getGame,
  makeMove,
  passTurn,
  resignGame,
  undoMove,
  type Captures,
  type MyColor,
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
        })
        .catch((err: Error) => setError(err.message));
    },
    [gameId, currentColor],
  );

  const pass = useCallback(() => {
    setError(null);
    passTurn(gameId, currentColor)
      .then((res) => {
        setCurrentColor(res.nextColor);
        setStatus(res.status);
        setResult(res.result);
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId, currentColor]);

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
    error,
    play,
    pass,
    resign,
    undo,
    finalizeScoring,
    clearError,
  };
}
