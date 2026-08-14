import { useCallback, useState } from 'react';
import { getGameHistory, type HistoryEntry } from '../services/api';

export function useGameHistory(gameId: string) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return getGameHistory(gameId)
      .then((res) => {
        setHistory(res.moves);
        return res.moves;
      })
      .catch((err: Error) => {
        setError(err.message);
        throw err;
      });
  }, [gameId]);

  return { history, error, load };
}
