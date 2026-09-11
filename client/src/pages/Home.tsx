import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Color } from 'shared';
import {
  createGame,
  deleteGame,
  listGames,
  starGame,
  unstarGame,
  updateGameTitle,
  type GameListScope,
  type GameSummary,
  type TimeControlName,
} from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useDialog } from '../hooks/useDialog';
import { useLiveSocket } from '../hooks/useLiveSocket';
import { timeControlLabel } from '../utils/clock';

const BOARD_SIZES = [9, 13, 19];

// Komi choices for an even (no handicap) game, supporting correct scoring
// under each classic ruleset.
const KOMI_OPTIONS_EVEN = [6.5, 5.5, 0.5, 0];

// A handicap game's stones are the real compensation, so komi there is
// only ever a tie-breaker: the standard 0.5, or 0 for no tie-breaker at all.
const KOMI_OPTIONS_HANDICAP = [0.5, 0];

// Matches the server's own default (GNUGO_LEVEL) and GTP --level's range.
const GNUGO_LEVEL_DEFAULT = 5;
const GNUGO_LEVEL_MIN = 1;
const GNUGO_LEVEL_MAX = 10;

// Ascending "how much time you get", ending at unlimited — matches the
// board-size/handicap sliders' low-to-high feel.
const TIME_CONTROL_STEPS: { value: TimeControlName; label: string }[] = [
  { value: 'standard', label: '10 minutes' },
  { value: 'correspondence', label: '24h per move' },
  { value: 'unlimited', label: 'Unlimited' },
];

function getMaxHandicap(size: number): number {
  return size === 19 ? 9 : 5;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// Subtle step markers under a slider — a plain CSS overlay rather than
// <input list> datalist ticks, since Safari/iOS doesn't render those at all.
function SliderTicks({ count }: { count: number }) {
  return (
    <div className="modal-slider-ticks" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

function Home() {
  const { user, logout } = useAuth();
  const { confirm: confirmDialog } = useDialog();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(19);
  const [handicap, setHandicap] = useState(0);
  const [komi, setKomi] = useState(KOMI_OPTIONS_EVEN[0]);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'local' | 'remote' | 'gnugo'>('local');
  const [timeControl, setTimeControl] = useState<TimeControlName>('unlimited');
  const [opponentUsername, setOpponentUsername] = useState('');
  const [color, setColor] = useState<Color | 'random'>('black');
  const [gnugoLevel, setGnugoLevel] = useState(GNUGO_LEVEL_DEFAULT);
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [scope, setScope] = useState<GameListScope>('mine');

  const refresh = useCallback(() => {
    listGames(scope)
      .then(setGames)
      .catch((err: Error) => setError(err.message));
  }, [scope]);

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

  const handleModeChange = (newMode: 'local' | 'remote' | 'gnugo') => {
    setMode(newMode);
    if (newMode === 'gnugo') {
      // 10-min defaults for a computer opponent; a handicap game only makes
      // sense if the human — not GNU Go — receives the free stones.
      setTimeControl('standard');
      if (handicap > 0) {
        setColor('black');
      }
    }
  };

  const handleHandicapChange = (newHandicap: number) => {
    setHandicap(newHandicap);
    if (mode === 'gnugo' && newHandicap > 0) {
      setColor('black');
    }
    // A handicap game only offers 0.5/0 — fall back to the default rather
    // than submit a now-invalid even-game value like 6.5.
    if (newHandicap > 0 && !(KOMI_OPTIONS_HANDICAP as number[]).includes(komi)) {
      setKomi(0.5);
    }
  };

  const startNewGame = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    createGame({
      size,
      handicap,
      komi,
      title: title.trim() || undefined,
      mode,
      timeControl,
      ...(mode === 'remote' ? { color, opponentUsername: opponentUsername.trim() } : {}),
      ...(mode === 'gnugo' ? { color, level: gnugoLevel } : {}),
    })
      .then((game) => navigate(`/games/${game.id}`))
      .catch((err: Error) => setError(err.message));
  };

  const handleDelete = (id: string) => {
    confirmDialog('Delete this game and all its moves? This cannot be undone.', 'Delete').then((confirmed) => {
      if (!confirmed) {
        return;
      }
      setError(null);
      deleteGame(id)
        .then(refresh)
        .catch((err: Error) => setError(err.message));
    });
  };

  return (
    <div className="game-list-wrap">
      <div className="auth-status">
        {user ? (
          <>
            Logged in as{' '}
            <Link to={`/profile/${user.id}`}>
              <strong>{user.username}</strong>
            </Link>
            <button type="button" onClick={() => logout().then(refresh)}>
              Log out
            </button>
          </>
        ) : (
          <Link to="/login">Log in / Register</Link>
        )}
      </div>
      {user ? (
        <div className="home-toolbar">
          <button type="button" className="new-game-trigger" onClick={() => setNewGameOpen(true)}>
            New game
          </button>
          <button
            type="button"
            className="new-game-trigger"
            onClick={() => setScope((s) => (s === 'mine' ? 'all' : 'mine'))}
          >
            {scope === 'mine' ? 'All games' : 'My games'}
          </button>
        </div>
      ) : (
        <p>
          <Link to="/login">Log in</Link> to start a new game.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {newGameOpen && (
        <div className="modal-overlay" onClick={() => setNewGameOpen(false)}>
          <form className="modal new-game-modal" onClick={(e) => e.stopPropagation()} onSubmit={startNewGame}>
            <h3>New game</h3>
            <label className="modal-form-row">
              <span className="modal-form-label">Title</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional"
                maxLength={100}
              />
            </label>
            <label className="modal-form-row">
              <span className="modal-form-label">Mode</span>
              <select value={mode} onChange={(e) => handleModeChange(e.target.value as 'local' | 'remote' | 'gnugo')}>
                <option value="local">Local</option>
                <option value="remote">Remote</option>
                <option value="gnugo">Vs. computer</option>
              </select>
            </label>
            {mode === 'remote' && (
              <label className="modal-form-row">
                <span className="modal-form-label">Opponent</span>
                <input
                  type="text"
                  value={opponentUsername}
                  onChange={(e) => setOpponentUsername(e.target.value)}
                  placeholder="Username"
                  required
                />
              </label>
            )}
            <label className="modal-form-row">
              <span className="modal-form-label">Komi</span>
              <select value={komi} onChange={(e) => setKomi(Number(e.target.value))}>
                {(handicap > 0 ? KOMI_OPTIONS_HANDICAP : KOMI_OPTIONS_EVEN).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            {(mode === 'remote' || mode === 'gnugo') && (
              <div className="modal-wide-row">
                <div className="modal-wide-row-label">
                  <span className="modal-form-label">Your color</span>
                  <span>{color === 'black' ? 'Black' : color === 'white' ? 'White' : 'Random'}</span>
                </div>
                <div className="color-radio-group" role="radiogroup" aria-label="Your color">
                  {(['black', 'white', 'random'] as const).map((option) => (
                    <label
                      key={option}
                      className={`color-stone color-stone--${option}${
                        color === option ? ' color-stone--selected' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="color"
                        value={option}
                        checked={color === option}
                        onChange={() => setColor(option)}
                        aria-label={option === 'black' ? 'Black' : option === 'white' ? 'White' : 'Random'}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-wide-row">
              <div className="modal-wide-row-label">
                <span className="modal-form-label">Board size</span>
                <span>
                  {size}x{size}
                </span>
              </div>
              <div className="modal-slider-wrap">
                <input
                  type="range"
                  className="modal-slider"
                  min={0}
                  max={BOARD_SIZES.length - 1}
                  step={1}
                  value={BOARD_SIZES.indexOf(size)}
                  onChange={(e) => handleSizeChange(BOARD_SIZES[Number(e.target.value)])}
                />
                <SliderTicks count={BOARD_SIZES.length} />
              </div>
            </div>
            {mode === 'gnugo' && (
              <div className="modal-wide-row">
                <div className="modal-wide-row-label">
                  <span className="modal-form-label">GNU Go level</span>
                  <span>{gnugoLevel}</span>
                </div>
                <div className="modal-slider-wrap">
                  <input
                    type="range"
                    className="modal-slider"
                    min={GNUGO_LEVEL_MIN}
                    max={GNUGO_LEVEL_MAX}
                    step={1}
                    value={gnugoLevel}
                    onChange={(e) => setGnugoLevel(Number(e.target.value))}
                  />
                  <SliderTicks count={GNUGO_LEVEL_MAX - GNUGO_LEVEL_MIN + 1} />
                </div>
              </div>
            )}
            <div className="modal-wide-row">
              <div className="modal-wide-row-label">
                <span className="modal-form-label">Handicap</span>
                <span>{handicap === 0 ? 'None' : handicap}</span>
              </div>
              <div className="modal-slider-wrap">
                <input
                  type="range"
                  className="modal-slider"
                  min={0}
                  max={handicapOptions.length - 1}
                  step={1}
                  value={handicapOptions.indexOf(handicap)}
                  onChange={(e) => handleHandicapChange(handicapOptions[Number(e.target.value)])}
                />
                <SliderTicks count={handicapOptions.length} />
              </div>
            </div>
            <div className="modal-wide-row">
              <div className="modal-wide-row-label">
                <span className="modal-form-label">Time control</span>
                <span>{TIME_CONTROL_STEPS[TIME_CONTROL_STEPS.findIndex((s) => s.value === timeControl)].label}</span>
              </div>
              <div className="modal-slider-wrap">
                <input
                  type="range"
                  className="modal-slider"
                  min={0}
                  max={TIME_CONTROL_STEPS.length - 1}
                  step={1}
                  value={TIME_CONTROL_STEPS.findIndex((s) => s.value === timeControl)}
                  onChange={(e) => setTimeControl(TIME_CONTROL_STEPS[Number(e.target.value)].value)}
                />
                <SliderTicks count={TIME_CONTROL_STEPS.length} />
              </div>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="modal-action" onClick={() => setNewGameOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="modal-action">
                Start
              </button>
            </div>
          </form>
        </div>
      )}
      {!games ? (
        <p>Loading games...</p>
      ) : games.length === 0 ? (
        <p>No games yet.</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <GameListItem key={game.id} game={game} onDelete={handleDelete} onRename={refresh} onStarChange={refresh} />
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
  onStarChange: () => void;
}

// A player's name inside the game card, linked to their profile — stops
// propagation since the whole card is itself a link to the game.
function PlayerLink({ username, userId }: { username: string | null; userId: string | null }) {
  if (!username || !userId) {
    return <>{username ?? '—'}</>;
  }
  return (
    <Link to={`/profile/${userId}`} onClick={(e) => e.stopPropagation()}>
      {username}
    </Link>
  );
}

function GameListItem({ game, onDelete, onRename, onStarChange }: GameListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [titleInput, setTitleInput] = useState(game.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const canEdit = game.myColor !== null;

  const toggleStar = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    (game.starred ? unstarGame(game.id) : starGame(game.id))
      .then(onStarChange)
      .catch((err: Error) => setError(err.message));
  };

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

  const metaParts = [`${game.size}x${game.size}`];
  if (game.isAiOpponent && game.gnugoLevel !== null) {
    metaParts.push(`level ${game.gnugoLevel}`);
  }
  if (game.handicap > 0) {
    metaParts.push(`handicap ${game.handicap}`);
  }
  metaParts.push(game.komi === 0 ? 'no komi' : `komi ${game.komi}`);
  if (game.timeControl !== null) {
    metaParts.push(timeControlLabel(game.timeControl));
  }
  if (game.status === 'finished') {
    metaParts.push(game.shortResult ?? 'no result');
  }

  const metaRows = (
    <>
      <div className="game-card-row">
        {metaParts[0]}
        {game.myColor !== 'both' && (
          <>
            {' · '}
            <PlayerLink username={game.blackUsername} userId={game.blackUserId} /> vs{' '}
            <PlayerLink username={game.whiteUsername} userId={game.whiteUserId} />
          </>
        )}
        {metaParts.length > 1 && ` · ${metaParts.slice(1).join(' · ')}`}
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
  ) : (
    <div className="game-card-actions">
      <button
        type="button"
        className={`star-button${game.starred ? ' star-button--active' : ''}`}
        aria-label={game.starred ? 'Unstar game' : 'Star game'}
        aria-pressed={game.starred}
        onClick={toggleStar}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
          />
        </svg>
      </button>
    </div>
  );

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
