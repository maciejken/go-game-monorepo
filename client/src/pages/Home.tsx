import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createGame, deleteGame, listGames, type GameSummary } from '../services/api';

const BOARD_SIZES = [9, 13, 19];

function getMaxHandicap(size: number): number {
  return size === 19 ? 9 : 5;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function Home() {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(19);
  const [handicap, setHandicap] = useState(0);
  const [title, setTitle] = useState('');

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

  const startNewGame = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    createGame(size, handicap, title.trim() || undefined)
      .then((game) => navigate(`/games/${game.id}`))
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
      <form className="new-game-form" onSubmit={startNewGame}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          aria-label="Title (optional)"
          maxLength={100}
        />
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
        <button type="submit">Start a new game</button>
      </form>
      {error && <p className="error">{error}</p>}
      {!games ? (
        <p>Loading games...</p>
      ) : games.length === 0 ? (
        <p>No games yet.</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <li key={game.id}>
              <Link to={`/games/${game.id}`} className="game-card">
                {game.title && <div className="game-card-title">{game.title}</div>}
                <div className="game-card-row">
                  {game.size}x{game.size}
                  {game.handicap > 0 ? ` · Handicap ${game.handicap}` : ''} — {game.result ?? game.status}
                </div>
                <div className="game-card-row">Created: {formatDate(game.createdAt)}</div>
                <div className="game-card-row">Updated: {formatDate(game.updatedAt)}</div>
              </Link>
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
