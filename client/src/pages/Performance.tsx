import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getGame, listGnugoTimings, type GameStateResponse, type GnugoTiming } from '../services/api';

// Deliberately not translated: this screen only exists on a server run
// with GNUGO_DEBUG_PERFORMANCE, it is read by whoever administers that
// server, and nine translations of "Queue wait" would be nine strings to
// keep in step for an audience of one.
//
// What each GNU Go move cost, for a server running with
// GNUGO_DEBUG_PERFORMANCE. A debug screen rather than something a player
// would look for, so it is reached from the game's own menu and only
// where the server collects the numbers at all.
//
// The form is a stacked bar per move: the question is not "how long did
// this move take" — the move list could say that — but "where did the
// time go", and the phases only mean something against each other. Each
// bar links to that move in review, which is what makes the chart worth
// having: a spike is a position, and the position is one click away.

const PHASES = [
  { key: 'queueWaitMs', token: 'var(--series-1)', label: 'Queue wait' },
  { key: 'setupMs', token: 'var(--series-2)', label: 'Setup' },
  { key: 'replayMs', token: 'var(--series-3)', label: 'Replay' },
  { key: 'genmoveMs', token: 'var(--series-4)', label: 'Thinking' },
] as const;

const CHART_HEIGHT = 220;
const BAR_GAP = 2;
const SEGMENT_GAP = 2;

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${ms}ms`;
}

function Performance() {
  const { id } = useParams<{ id: string }>();
  const gameId = id ?? '';
  const [timings, setTimings] = useState<GnugoTiming[] | null>(null);
  const [game, setGame] = useState<GameStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) {
      return;
    }
    listGnugoTimings(gameId)
      .then(setTimings)
      .catch((err: Error) => setError(err.message));
    getGame(gameId)
      .then(setGame)
      .catch(() => undefined);
  }, [gameId]);

  if (error) {
    return (
      <div className="perf-page">
        <h2>{'GNU Go performance'}</h2>
        <p className="error">{error}</p>
        <Link to={`/games/${gameId}`}>{'Back to the game'}</Link>
      </div>
    );
  }

  if (!timings) {
    return <div className="perf-page">{'Loading…'}</div>;
  }

  if (timings.length === 0) {
    return (
      <div className="perf-page">
        <h2>{'GNU Go performance'}</h2>
        <p className="muted">{'No moves measured in this game yet.'}</p>
        <Link to={`/games/${gameId}`}>{'Back to the game'}</Link>
      </div>
    );
  }

  const worst = timings.reduce((slowest, row) => (row.totalMs > slowest.totalMs ? row : slowest));
  const peak = worst.totalMs;
  const cpuTotal = timings.reduce((sum, row) => sum + (row.cpuMs ?? 0), 0);
  const hasCpu = timings.some((row) => row.cpuMs !== null);

  // One column per measured move, sharing the width.
  const columnWidth = Math.max(6, Math.min(28, Math.floor(860 / timings.length)));
  const chartWidth = timings.length * columnWidth;

  return (
    <div className="perf-page">
      <h2>{'GNU Go performance'}</h2>
      <p className="muted">
        {game?.title ? `${game.title} · ` : ''}
        {`${timings.length} moves measured`} · {`level ${timings[0].level}`} ·{' '}
        {timings[0].boardSize}×{timings[0].boardSize}
      </p>

      <dl className="perf-summary">
        <div>
          <dt>{'Median move'}</dt>
          <dd>{formatMs(median(timings.map((row) => row.totalMs)))}</dd>
        </div>
        <div>
          <dt>{'Slowest move'}</dt>
          <dd>
            <Link to={`/games/${gameId}?move=${worst.moveNumber}`}>
              {formatMs(worst.totalMs)} ({`move ${worst.moveNumber}`})
            </Link>
          </dd>
        </div>
        <div>
          <dt>{'Median thinking'}</dt>
          <dd>{formatMs(median(timings.map((row) => row.genmoveMs)))}</dd>
        </div>
        {hasCpu && (
          <div>
            <dt>{'Total CPU'}</dt>
            <dd>{formatMs(cpuTotal)}</dd>
          </div>
        )}
      </dl>

      <ul className="perf-legend">
        {PHASES.map((phase) => (
          <li key={phase.key}>
            <span className="perf-swatch" style={{ background: phase.token }} aria-hidden="true" />
            {phase.label}
          </li>
        ))}
      </ul>

      <div className="perf-chart-scroll">
        <svg
          className="perf-chart"
          width={chartWidth}
          height={CHART_HEIGHT}
          role="img"
          aria-label={'Time per move, split into phases'}
        >
          {timings.map((row, index) => {
            let offset = 0;
            return (
              <a key={row.moveNumber} href={`/games/${gameId}?move=${row.moveNumber}`}>
                <title>
                  {`move ${row.moveNumber} — ${formatMs(row.totalMs)}`}
                  {PHASES.map((phase) => ` · ${phase.label} ${formatMs(row[phase.key])}`).join('')}
                </title>
                {PHASES.map((phase) => {
                  const value = row[phase.key];
                  const full = peak === 0 ? 0 : (value / peak) * (CHART_HEIGHT - 8);
                  // Segments under a pixel would disappear or, worse,
                  // render as a line of the wrong colour; they are real
                  // and the tooltip reports them, so the bar doesn't
                  // pretend otherwise.
                  const height = value > 0 ? Math.max(1, full) : 0;
                  const y = CHART_HEIGHT - offset - height;
                  offset += height + (height > 0 ? SEGMENT_GAP : 0);
                  if (height === 0) {
                    return null;
                  }
                  return (
                    <rect
                      key={phase.key}
                      x={index * columnWidth}
                      y={y}
                      width={columnWidth - BAR_GAP}
                      height={height}
                      fill={phase.token}
                    />
                  );
                })}
              </a>
            );
          })}
        </svg>
      </div>

      {/* Also the relief for the two lighter series, which sit under 3:1
          against the light surface: every number is readable here. */}
      <table className="perf-table">
        <thead>
          <tr>
            <th>{'Move'}</th>
            {PHASES.map((phase) => (
              <th key={phase.key}>{phase.label}</th>
            ))}
            <th>{'Total'}</th>
            {hasCpu && <th>{'CPU'}</th>}
            <th>{'Replayed'}</th>
          </tr>
        </thead>
        <tbody>
          {timings.map((row) => (
            <tr key={row.moveNumber}>
              <td>
                <Link to={`/games/${gameId}?move=${row.moveNumber}`}>{row.moveNumber}</Link>
              </td>
              {PHASES.map((phase) => (
                <td key={phase.key}>{formatMs(row[phase.key])}</td>
              ))}
              <td>{formatMs(row.totalMs)}</td>
              {hasCpu && <td>{row.cpuMs === null ? '—' : formatMs(row.cpuMs)}</td>}
              <td>{row.movesReplayed}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <Link to={`/games/${gameId}`}>{'Back to the game'}</Link>
      </p>
    </div>
  );
}

export default Performance;
