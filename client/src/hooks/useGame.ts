import { useCallback, useEffect, useState } from 'react';
import type { Board, Color } from 'shared';
import { getGame, makeMove, passTurn, resignGame } from '../services/api';

export function useGame(gameId: string) {
  const [board, setBoard] = useState<Board | null>(null);
  const [currentColor, setCurrentColor] = useState<Color>('black');
  const [status, setStatus] = useState<string>('in_progress');
  const [result, setResult] = useState<string | null>(null);
  const [handicap, setHandicap] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getGame(gameId)
      .then((game) => {
        setBoard(game.board);
        setCurrentColor(game.currentColor);
        setStatus(game.status);
        setResult(game.result);
        setHandicap(game.handicap);
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId]);

  const play = useCallback(
    (x: number, y: number) => {
      setError(null);
      makeMove(gameId, x, y, currentColor)
        .then((res) => {
          setBoard(res.board);
          setCurrentColor(res.nextColor);
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
    resignGame(gameId, currentColor)
      .then((res) => {
        setStatus(res.status);
        setResult(res.result);
      })
      .catch((err: Error) => setError(err.message));
  }, [gameId, currentColor]);

  return { board, currentColor, status, result, handicap, error, play, pass, resign };
}
