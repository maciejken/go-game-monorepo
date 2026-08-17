import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createGame,
  deleteGame,
  listGames,
  updateGameTitle,
  type GameSummary,
  type TimeControlName,
} from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useLiveSocket } from '../hooks/useLiveSocket';
import { timeControlLabel } from '../utils/clock';

const BOARD_SIZES = [9, 13, 19];

function getMaxHandicap(size: number): number {
  return size === 19 ? 9 : 5;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function Home() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(19);
  const [handicap, setHandicap] = useState(0);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'local' | 'remote' | 'gnugo'>('local');
  const [timeControl, setTimeControl] = useState<TimeControlName>('unlimited');
  const [opponentUsername, setOpponentUsername] = useState('');

  const refresh = useCallback(() => {
    listGames()
      .then(setGames)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates: a new invite, a finished game, or any other player's
  // move updates the list here without needing a manual reload.
  useLiveSocket('/ws/games', refresh);

  const maxHandicap = getMaxHandicap(size);
  const handicapOptions = [0, ...Array.from({ length: maxHandicap - 1 }, (_, i) => i + 2)];

  const handleSizeChange = (newSize: number) => {
    setSize(newSize);
    setHandicap((h) => Math.min(h, getMaxHandicap(newSize)));
  };

  const startNewGame = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    createGame({
      size,
      handicap,
      title: title.trim() || undefined,
      mode,
      timeControl,
      ...(mode === 'remote' ? { opponentUsername: opponentUsername.trim() } : {}),
    })
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
      <div className="auth-status">
        {user ? (
          <>
            Logged in as <strong>{user.username}</strong>
            <button type="button" onClick={() => logout().then(refresh)}>
              Log out
            </button>
          </>
        ) : (
          <Link to="/login">Log in / Register</Link>
        )}
      </div>
      {user ? (
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
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as 'local' | 'remote' | 'gnugo')}>
              <option value="local">Local (play both sides)</option>
              <option value="remote">Remote (invite a player)</option>
              <option value="gnugo">Vs. computer (GNU Go)</option>
            </select>
          </label>
          {mode === 'remote' && (
            <input
              type="text"
              value={opponentUsername}
              onChange={(e) => setOpponentUsername(e.target.value)}
              placeholder="Opponent's username"
              aria-label="Opponent's username"
              required
            />
          )}
          <label>
            Time control
            <select value={timeControl} onChange={(e) => setTimeControl(e.target.value as TimeControlName)}>
              <option value="unlimited">Unlimited</option>
              <option value="standard">10 minutes</option>
              <option value="correspondence">24h per move</option>
            </select>
          </label>
          <button type="submit">+</button>
        </form>
      ) : (
        <p>
          <Link to="/login">Log in</Link> to start a new game.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!games ? (
        <p>Loading games...</p>
      ) : games.length === 0 ? (
        <p>No games yet.</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <GameListItem key={game.id} game={game} onDelete={handleDelete} onRename={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface GameListItemProps {
  game: GameSummary;
  onDelete: (id: string) => void;
  onRename: () => void;
}

function GameListItem({ game, onDelete, onRename }: GameListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [titleInput, setTitleInput] = useState(game.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const canEdit = game.myColor !== null;

  const startEdit = () => {
    setError(null);
    setTitleInput(game.title ?? '');
    setIsEditing(true);
  };

  const cancelEdit = () => setIsEditing(false);

  const saveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    updateGameTitle(game.id, titleInput.trim())
      .then(() => {
        setIsEditing(false);
        onRename();
      })
      .catch((err: Error) => setError(err.message));
  };

  const playerLabel = (playerColor: 'black' | 'white', username: string | null) => {
    if (!username) {
      return null;
    }
    const isMe = game.myColor === playerColor || game.myColor === 'both';
    return `${playerColor === 'black' ? 'Black' : 'White'}: ${username}${isMe ? ' (you)' : ''}`;
  };

  const metaRows = (
    <>
      <div className="game-card-row">
        {game.size}x{game.size}
        {game.handicap > 0 ? ` · Handicap ${game.handicap}` : ''} · {timeControlLabel(game.timeControl)} —{' '}
        {game.result ?? game.status}
      </div>
      <div className="game-card-row">
        {[playerLabel('black', game.blackUsername), playerLabel('white', game.whiteUsername)]
          .filter(Boolean)
          .join(' · ')}
      </div>
      <div className="game-card-row">Created: {formatDate(game.createdAt)}</div>
      <div className="game-card-row">Updated: {formatDate(game.updatedAt)}</div>
    </>
  );

  // Nested inside the card (an <a> when not editing), so clicks must stop
  // propagation or they'd also trigger the card's own navigation.
  const actions = canEdit ? (
    <div className="game-card-actions">
      <button
        type="button"
        className="edit-button"
        aria-label="Edit game title"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          startEdit();
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
          />
        </svg>
      </button>
      <button
        type="button"
        className="delete-button"
        aria-label="Delete game"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete(game.id);
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M9 3a1 1 0 0 0-1 1v1H4v2h16V5h-4V4a1 1 0 0 0-1-1H9zM5 9l1 11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-11H5z"
          />
        </svg>
      </button>
    </div>
  ) : null;

  return (
    <li>
      {isEditing ? (
        <div className="game-card">
          {actions}
          <form onSubmit={saveEdit}>
            <input
              type="text"
              className="game-card-title-input"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelEdit();
              }}
              onBlur={cancelEdit}
              placeholder="Title (optional)"
              aria-label="Game title"
              maxLength={100}
              autoFocus
            />
          </form>
          {metaRows}
        </div>
      ) : (
        <Link to={`/games/${game.id}`} className="game-card">
          {actions}
          {game.title && <div className="game-card-title">{game.title}</div>}
          {metaRows}
        </Link>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  );
}

export default Home;
