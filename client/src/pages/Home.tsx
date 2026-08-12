import { useCallback, useEffect, useState } from 'react';
import { createGame, deleteGame, listGames, type GameSummary } from '../services/api';

interface HomeProps {
  onSelectGame: (id: string) => void;
}

const BOARD_SIZES = [9, 13, 19];

function getMaxHandicap(size: number): number {
  return size === 19 ? 9 : 5;
}

function Home({ onSelectGame }: HomeProps) {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(19);
  const [handicap, setHandicap] = useState(0);

  const refresh = useCallback(() => {
    listGames()
      .then(setGames)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const maxHandicap = getMaxHandicap(size);
  const handicapOptions = [0, ...Array.from({ length: maxHandicap - 1 }, (_, i) => i + 2)];

  const handleSizeChange = (newSize: number) => {
    setSize(newSize);
    setHandicap((h) => Math.min(h, getMaxHandicap(newSize)));
  };

  const startNewGame = () => {
    setError(null);
    createGame(size, handicap)
      .then((game) => onSelectGame(game.id))
      .catch((err: Error) => setError(err.message));
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this game and all its moves? This cannot be undone.')) {
      return;
    }
    setError(null);
    deleteGame(id)
      .then(refresh)
      .catch((err: Error) => setError(err.message));
  };

  return (
    <div className="game-list-wrap">
      <div className="new-game-form">
        <label>
          Board size
          <select value={size} onChange={(e) => handleSizeChange(Number(e.target.value))}>
            {BOARD_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}x{s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Handicap
          <select value={handicap} onChange={(e) => setHandicap(Number(e.target.value))}>
            {handicapOptions.map((h) => (
              <option key={h} value={h}>
                {h === 0 ? 'None' : h}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={startNewGame}>
          Start a new game
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!games ? (
        <p>Loading games...</p>
      ) : games.length === 0 ? (
        <p>No games yet.</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <li key={game.id}>
              <button type="button" className="game-list-entry" onClick={() => onSelectGame(game.id)}>
                {game.size}x{game.size}
                {game.handicap > 0 ? ` H${game.handicap}` : ''} — {game.result ?? game.status}
              </button>
              <button
                type="button"
                className="delete-button"
                aria-label="Delete game"
                onClick={() => handleDelete(game.id)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M9 3a1 1 0 0 0-1 1v1H4v2h16V5h-4V4a1 1 0 0 0-1-1H9zM5 9l1 11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-11H5z"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Home;
