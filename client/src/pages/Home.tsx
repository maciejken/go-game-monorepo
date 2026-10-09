import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Color } from 'shared';
import {
  createGame,
  listGames,
  recentGameVs,
  searchUsernames,
  type GameListScope,
  type GameSummary,
  type TimeControlName,
  type UsernameSearchResult,
} from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useLiveSocket } from '../hooks/useLiveSocket';
import { timeControlLabel } from '../utils/clock';
import { t } from '../i18n';

const BOARD_SIZES = [9, 13, 19];

const GAMES_PAGE_SIZE = 20;

// Matches the server's own floor for ?q= — below this the filter is
// ignored, so there's no point sending it.
const MIN_SEARCH_LENGTH = 3;

// Komi choices for an even (no handicap) game, supporting correct scoring
// under each classic ruleset.
const KOMI_OPTIONS_EVEN = [6.5, 5.5, 0.5, 0];

// A handicap game's stones are the real compensation, so komi there is
// only ever a tie-breaker: the standard 0.5, or 0 for no tie-breaker at all.
const KOMI_OPTIONS_HANDICAP = [0.5, 0];

// GTP --level's range is 1-10; the server's own fallback (GNUGO_LEVEL) is
// deliberately lower for reliability, but this form's default is the
// strongest setting since a player choosing gnugo mode explicitly wants a
// real opponent.
const GNUGO_LEVEL_DEFAULT = 10;
const GNUGO_LEVEL_MIN = 1;
const GNUGO_LEVEL_MAX = 10;

// Ascending "how much time you get", ending at unlimited — matches the
// board-size/handicap sliders' low-to-high feel.
const TIME_CONTROL_STEPS: { value: TimeControlName; label: () => string }[] = [
  { value: 'standard', label: () => t('10 minutes') },
  { value: 'correspondence', label: () => t('24h per move') },
  { value: 'unlimited', label: () => t('Unlimited') },
];

function getMaxHandicap(size: number): number {
  return size === 19 ? 9 : 5;
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
  const { user, features, logout } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(19);
  const [handicap, setHandicap] = useState(0);
  const [komi, setKomi] = useState(KOMI_OPTIONS_EVEN[0]);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'local' | 'remote' | 'gnugo'>('remote');
  const [timeControl, setTimeControl] = useState<TimeControlName>('unlimited');
  const [opponentUsername, setOpponentUsername] = useState('');
  const [color, setColor] = useState<Color | 'random'>('black');
  const [gnugoLevel, setGnugoLevel] = useState(GNUGO_LEVEL_DEFAULT);
  const [usernameSuggestions, setUsernameSuggestions] = useState<UsernameSearchResult[]>([]);
  // A create-game failure specific to the opponent field (not found, opted
  // out of invitations, self-invite) — shown under that input rather than
  // the form's generic error, and cleared as soon as the username changes
  // rather than lingering until the next submit attempt.
  const [opponentError, setOpponentError] = useState<string | null>(null);
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [scope, setScope] = useState<GameListScope>('mine');
  const [search, setSearch] = useState('');
  // The debounced, long-enough-to-use version of `search` — what actually
  // gets sent. Kept separate so typing doesn't refetch on every keystroke
  // and so a 1-2 character query cleanly means "no filter" rather than a
  // request the server would ignore anyway.
  const [appliedSearch, setAppliedSearch] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  // Resets back to page one — used for the initial load, a scope switch,
  // and every live-update/mutation refresh. Simpler than trying to merge
  // an in-place update into whatever pages are currently loaded, at the
  // cost of losing scroll-loaded pages on those refreshes.
  // Same 300ms debounce the opponent autocomplete above uses, for the same
  // reason: it drives visible feedback while typing.
  useEffect(() => {
    const query = search.trim();
    const timeoutId = setTimeout(() => {
      setAppliedSearch(query.length >= MIN_SEARCH_LENGTH ? query : '');
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [search]);

  const refresh = useCallback(() => {
    listGames(scope, { limit: GAMES_PAGE_SIZE, offset: 0, q: appliedSearch })
      .then(({ games: page, hasMore: more }) => {
        setGames(page);
        setHasMore(more);
      })
      .catch((err: Error) => setError(err.message));
  }, [scope, appliedSearch]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadMore = useCallback(() => {
    if (!games || loadingMore || !hasMore) {
      return;
    }
    setLoadingMore(true);
    listGames(scope, { limit: GAMES_PAGE_SIZE, offset: games.length, q: appliedSearch })
      .then(({ games: page, hasMore: more }) => {
        setGames((prev) => (prev ? [...prev, ...page] : page));
        setHasMore(more);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoadingMore(false));
  }, [games, scope, appliedSearch, hasMore, loadingMore]);

  // Fires loadMore once the sentinel row at the end of the list scrolls
  // into view — re-observing whenever loadMore itself changes (i.e. after
  // hasMore/loadingMore change) so a short page that doesn't fill the
  // viewport keeps pulling in more pages until it either fills up or runs
  // out, rather than waiting for a scroll event that may never come.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        loadMore();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

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
    setOpponentError(null);
    if (newMode === 'gnugo') {
      // 10-min defaults for a computer opponent; a handicap game only makes
      // sense if the human — not GNU Go — receives the free stones.
      setTimeControl('standard');
      if (handicap > 0) {
        setColor('black');
      }
      // Picking up where the last game against the computer left off —
      // routed through handleHandicapChange so its color/komi side effects
      // still apply to the prefilled value, not just a manual pick.
      recentGameVs({ ai: true })
        .then((recent) => {
          if (recent) {
            handleHandicapChange(recent.handicap);
            if (recent.gnugoLevel != null) {
              setGnugoLevel(recent.gnugoLevel);
            }
          }
        })
        .catch(() => {});
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

  // 2s after the user stops typing a remote opponent's username, check
  // whether there's a previous game against them and, if so, prefill the
  // same handicap — routed through handleHandicapChange for the same
  // reason as the gnugo prefill above. An unknown/not-yet-valid username
  // just means no prefill; the real "no such user" error still surfaces at
  // submit time, same as today.
  useEffect(() => {
    if (mode !== 'remote') {
      return;
    }
    const username = opponentUsername.trim();
    if (!username) {
      return;
    }
    const timeoutId = setTimeout(() => {
      recentGameVs({ username })
        .then((recent) => {
          if (recent) {
            handleHandicapChange(recent.handicap);
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, opponentUsername]);

  // Username autocomplete — a much lighter debounce than the handicap
  // lookup above since this one drives visible list feedback while typing,
  // not a background prefill. Any non-empty query is sent — the server
  // itself narrows a 1-2 character query to recent opponents rather than
  // the whole user base, only searching everyone once there's a 3rd
  // character. Doesn't clear usernameSuggestions when the query empties
  // out or mode changes — the render below already gates the dropdown on
  // the current length/mode, so stale results just stay harmlessly unused
  // in state until a new query replaces them.
  useEffect(() => {
    if (mode !== 'remote' || !opponentUsername.trim()) {
      return;
    }
    const query = opponentUsername.trim();
    const timeoutId = setTimeout(() => {
      searchUsernames(query)
        .then(setUsernameSuggestions)
        .catch(() => setUsernameSuggestions([]));
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [mode, opponentUsername]);

  // Selecting the computer's or your own username switches mode instead of
  // filling in an opponent — those aren't real remote opponents, and
  // handleModeChange already carries the gnugo prefill/color-forcing logic
  // a plain setMode wouldn't.
  const handleSuggestionSelect = (suggestion: UsernameSearchResult) => {
    setUsernameSuggestions([]);
    setOpponentError(null);
    if (suggestion.isAi) {
      setOpponentUsername('');
      handleModeChange('gnugo');
    } else if (user && suggestion.username === user.username) {
      setOpponentUsername('');
      handleModeChange('local');
    } else {
      setOpponentUsername(suggestion.username);
    }
  };

  const startNewGame = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOpponentError(null);
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
      .catch((err: Error) => {
        if (mode === 'remote') {
          setOpponentError(err.message);
        } else {
          setError(err.message);
        }
      });
  };

  return (
    <div className="game-list-wrap">
      <div className="auth-status">
        {user ? (
          <>
            {/* The whole phrase is the link: splitting it around the
                username would fix the word order to English's, and
                Japanese puts the name first. */}
            <Link to={`/profile/${user.id}`}>
              <strong>{t('Logged in as %@', user.username)}</strong>
            </Link>
            <button type="button" onClick={() => logout().then(refresh)}>
              {t('Log out')}
            </button>
          </>
        ) : (
          <Link to="/login">{t('Log in / Register')}</Link>
        )}
      </div>
      {user ? (
        <>
          <div className="home-heading">
            <h1 className="page-title">{t('Your Games')}</h1>
            {/* Filled only while the filter is on: the star says what the
                list is showing, not what it could show. */}
            <button
              type="button"
              className={`star-button${scope === 'starred' ? ' star-button--active' : ''}`}
              aria-pressed={scope === 'starred'}
              aria-label={t('Show favourites only')}
              onClick={() => setScope((s) => (s === 'mine' ? 'starred' : 'mine'))}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path
                  fill={scope === 'starred' ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
                />
              </svg>
            </button>
          </div>
          <div className="home-toolbar">
            <button type="button" className="new-game-trigger" onClick={() => setNewGameOpen(true)}>
              {t('New game')}
            </button>
          </div>
          <input
            type="search"
            className="game-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Search titles, players, tags')}
            aria-label={t('Search games')}
            maxLength={100}
          />
        </>
      ) : (
        <p>
          <Link to="/login">{t('Log in')}</Link> {t('Log in to start a new game.')}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {newGameOpen && (
        <div className="modal-overlay" onClick={() => setNewGameOpen(false)}>
          <form className="modal new-game-modal" onClick={(e) => e.stopPropagation()} onSubmit={startNewGame}>
            <h3>{t('New game')}</h3>
            <label className="modal-form-row">
              <span className="modal-form-label">{t('Title')}</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('Optional')}
                maxLength={100}
              />
            </label>
            <label className="modal-form-row">
              <span className="modal-form-label">{t('Mode')}</span>
              <select value={mode} onChange={(e) => handleModeChange(e.target.value as 'local' | 'remote' | 'gnugo')}>
                <option value="local">{t('Local')}</option>
                <option value="remote">{t('Remote')}</option>
                {/* Only where there is a GNU Go to play: a server can have
                    it switched off, or not have it installed at all. */}
                {features.gnugo && <option value="gnugo">{t('Vs. Computer')}</option>}
              </select>
            </label>
            {mode === 'remote' && (
              <label className="modal-form-row">
                <span className="modal-form-label">{t('Opponent')}</span>
                <div className="opponent-field">
                  <input
                    type="text"
                    value={opponentUsername}
                    onChange={(e) => {
                      setOpponentUsername(e.target.value);
                      setOpponentError(null);
                    }}
                    onBlur={() => setTimeout(() => setUsernameSuggestions([]), 150)}
                    placeholder={t('Username')}
                    required
                  />
                  {opponentUsername.trim().length >= 1 && usernameSuggestions.length > 0 && (
                    <ul className="opponent-suggestions">
                      {usernameSuggestions.map((suggestion) => (
                        <li key={suggestion.username}>
                          <button type="button" onMouseDown={() => handleSuggestionSelect(suggestion)}>
                            {suggestion.username}
                            {suggestion.isAi && ' (computer)'}
                            {user && suggestion.username === user.username && ' (you)'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {opponentError && <p className="error">{opponentError}</p>}
                </div>
              </label>
            )}
            <label className="modal-form-row">
              <span className="modal-form-label">{t('Komi')}</span>
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
                  <span className="modal-form-label">{t('Your color')}</span>
                  <span>{color === 'black' ? 'Black' : color === 'white' ? 'White' : 'Random'}</span>
                </div>
                <div className="color-radio-group" role="radiogroup" aria-label={t('Your color')}>
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
                        aria-label={option === 'black' ? t('Black') : option === 'white' ? t('White') : t('Random')}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-wide-row">
              <div className="modal-wide-row-label">
                <span className="modal-form-label">{t('Board size')}</span>
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
                  <span className="modal-form-label">{t('GNU Go level')}</span>
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
                <span className="modal-form-label">{t('Handicap')}</span>
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
                <span className="modal-form-label">{t('Time control')}</span>
                <span>{TIME_CONTROL_STEPS[TIME_CONTROL_STEPS.findIndex((s) => s.value === timeControl)].label()}</span>
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
        <p>{t('Loading games...')}</p>
      ) : games.length === 0 ? (
        <p>{appliedSearch ? t('No games match "%@".', appliedSearch) : t('No games yet')}</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <GameListItem key={game.id} game={game} />
          ))}
          {hasMore && <li ref={sentinelRef} aria-hidden="true" />}
        </ul>
      )}
    </div>
  );
}

interface GameListItemProps {
  game: GameSummary;
}

// One card, one action. The whole card is a link into the game, and nothing
// inside it is separately clickable: the title, tags, favourite and delete
// all live in the game view now, so a card no longer carries edit/delete/
// star buttons or a link per player name competing with its own tap target.
function GameListItem({ game }: GameListItemProps) {
  const metaParts = [`${game.size}x${game.size}`];
  if (game.myColor !== 'both') {
    metaParts.push(t('%@ vs %@', game.blackUsername ?? '—', game.whiteUsername ?? '—'));
  }
  if (game.isAiOpponent && game.gnugoLevel !== null) {
    metaParts.push(t('level %lld', game.gnugoLevel));
  }
  if (game.handicap > 0) {
    metaParts.push(t('handicap %lld', game.handicap));
  }
  metaParts.push(game.komi === 0 ? t('no komi') : t('komi %@', game.komi));
  if (game.timeControl !== null) {
    metaParts.push(timeControlLabel(game.timeControl));
  }
  if (game.status === 'finished') {
    metaParts.push(game.shortResult ?? t('no result'));
  }

  return (
    <li>
      <Link to={`/games/${game.id}`} className="game-card">
        {game.title && <div className="game-card-title">{game.title}</div>}
        <div className="game-card-row">{metaParts.join(' · ')}</div>
        {game.tags.length > 0 && (
          <ul className="tag-chips tag-chips--readonly">
            {game.tags.map((tag) => (
              <li key={tag} className="tag-chip">
                {tag}
              </li>
            ))}
          </ul>
        )}
      </Link>
    </li>
  );
}

export default Home;
