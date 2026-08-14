import { Link, useParams } from 'react-router-dom';
import { useGame } from '../hooks/useGame';

// Go board columns skip the letter "I" to avoid confusion with the numeral 1
const COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST';

// Standard hoshi (star point) markers, as 0-indexed [x, y] coordinates
const HOSHI_POINTS: Record<number, [number, number][]> = {
  9: [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]],
  13: [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]],
  19: [
    [3, 3], [3, 9], [3, 15],
    [9, 3], [9, 9], [9, 15],
    [15, 3], [15, 9], [15, 15],
  ],
};

function getHoshiPoints(size: number): [number, number][] {
  return HOSHI_POINTS[size] ?? [];
}

function Game() {
  const { id: gameId } = useParams<{ id: string }>();

  if (!gameId) {
    return <p>Game not found.</p>;
  }

  return <GameView gameId={gameId} />;
}

interface GameViewProps {
  gameId: string;
}

function GameView({ gameId }: GameViewProps) {
  const { board, currentColor, status, result, handicap, error, play, pass, resign } = useGame(gameId);

  if (!board) {
    return <p>Loading game...</p>;
  }

  const size = board.length;
  const finished = status !== 'in_progress';

  return (
    <div className="go-board-wrap">
      <Link to="/" className="back-link">Back to games</Link>
      {handicap > 0 && <p>Handicap: {handicap}</p>}
      {finished ? <p>{result}</p> : <p>Current turn: {currentColor}</p>}
      {error && <p className="error">{error}</p>}
      {!finished && (
        <div className="go-actions">
          <button type="button" onClick={pass}>
            Pass
          </button>
          <button type="button" onClick={resign}>
            Resign
          </button>
        </div>
      )}
      <div className="go-board-frame" style={{ '--size': size } as React.CSSProperties}>
        <div className="go-coords go-coords--top">
          {Array.from({ length: size }, (_, x) => (
            <span key={x}>{COLUMN_LABELS[x]}</span>
          ))}
        </div>
        <div className="go-coords go-coords--left">
          {Array.from({ length: size }, (_, y) => (
            <span key={y}>{size - y}</span>
          ))}
        </div>
        <div className="go-board">
          <div className="go-board-lines">
            {getHoshiPoints(size).map(([gx, gy]) => (
              <span
                key={`${gx}-${gy}`}
                className="go-hoshi"
                style={{ left: `${(gx / (size - 1)) * 100}%`, top: `${(gy / (size - 1)) * 100}%` }}
              />
            ))}
          </div>
          {board.map((row, y) => (
            <div className="go-row" key={y}>
              {row.map((stone, x) => (
                <button
                  key={x}
                  type="button"
                  className="go-point"
                  onClick={() => play(x, y)}
                  disabled={stone !== null || finished}
                  aria-label={`Point ${COLUMN_LABELS[x]}${size - y}`}
                >
                  {stone && <span className={`go-stone go-stone--${stone}`} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Game;
