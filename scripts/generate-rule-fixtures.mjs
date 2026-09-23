#!/usr/bin/env node
// Writes shared/fixtures/rules.json: the rules, stated as cases rather than
// as code, so the TypeScript engine and the Swift one can be held to the
// same answers. The file is generated from shared/ (the engine the server
// has always used), which makes that engine the reference by definition —
// the Swift port is what has to agree.
//
//   node scripts/generate-rule-fixtures.mjs           # regenerate
//   node scripts/generate-rule-fixtures.mjs --check   # fail if stale
//
// Boards are rows of ".", "B" and "W", so a failing case is readable in the
// diff rather than a wall of nested arrays.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  applyDeadStones,
  createEmptyBoard,
  deductClock,
  hasTimedOut,
  resolveTimeControl,
  TIME_CONTROL_PRESETS,
  getHandicapPoints,
  getKomi,
  scoreBoard,
  validateMove,
} from '../shared/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'shared/fixtures/rules.json');

const render = (board) => board.map((row) => row.map((c) => (c === 'black' ? 'B' : c === 'white' ? 'W' : '.')).join(''));

const parse = (rows) =>
  rows.map((row) => [...row].map((c) => (c === 'B' ? 'black' : c === 'W' ? 'white' : null)));

// Replays a sequence of attempted moves through the engine, recording what
// it said about each one. `moveNumber` only advances on a legal move, which
// is what the server does — an illegal attempt doesn't consume a turn.
// Odd move numbers are Black's (getCurrentColor), and move 0 is the START
// event the server logs before play — so the first stone is move 1. A
// handicap game shifts by one more, because the placement counts as a move
// and White answers it (see turnMoveNumber).
function sequence(name, size, steps, { handicap = 0 } = {}) {
  let board = createEmptyBoard(size);
  let moveNumber = handicap >= 2 ? 2 : 1;
  const history = [];
  const recorded = [];

  for (const step of steps) {
    const { color, x, y } = step;
    const result = validateMove(board, { x, y }, color, moveNumber, history);
    const record = { color, x, y, valid: result.valid };
    if (result.valid) {
      record.captured = (result.capturedPoints ?? []).map((p) => ({ x: p.x, y: p.y }));
      history.push({ hash: result.hash, nextColor: color === 'black' ? 'white' : 'black', board: result.board });
      board = result.board;
      moveNumber += 1;
    } else {
      record.error = result.error;
    }
    recorded.push(record);
  }

  return { name, size, steps: recorded, finalBoard: render(board) };
}

// Fills the turns either side of the interesting move: Go alternates, so a
// case that needs three black stones in a row needs somewhere harmless for
// white to play in between.
const B = (x, y) => ({ color: 'black', x, y });
const W = (x, y) => ({ color: 'white', x, y });

// The classic ko shape: Black surrounds (3,3) on three sides, White
// surrounds (4,3), and the two points share the last liberty. This engine
// enforces ko through positional superko — recreating an earlier board with
// the same player to move — so the banned move is the immediate recapture,
// and a threat played elsewhere makes the position different enough to
// allow it.
function koSequence() {
  return sequence('ko: taking back immediately is rejected, and allowed after a play elsewhere', 9, [
    // Black's three stones surround (3,3); White's three surround (4,3),
    // and those two points are each other's last liberty.
    B(3, 2), W(4, 2),
    B(2, 3), W(5, 3),
    B(3, 4), W(4, 4),
    // Black plays away; White steps into the shape with one liberty left.
    B(8, 8), W(3, 3),
    // Black captures it. White may not take straight back.
    B(4, 3), W(3, 3),
    // A threat and an answer, then the same point is legal again.
    W(0, 8), B(1, 8), W(3, 3),
  ]);
}

const moveSequences = [
  sequence('capture a single stone in the centre', 9, [
    B(4, 3), W(4, 4), B(3, 4), W(8, 8), B(5, 4), W(8, 7), B(4, 5),
  ]),
  sequence('capture a single stone on the edge', 9, [
    B(0, 3), W(0, 4), B(0, 5), W(8, 8), B(1, 4),
  ]),
  sequence('capture a single stone in the corner', 9, [
    B(1, 0), W(0, 0), B(0, 1),
  ]),
  sequence('capture a two-stone group', 9, [
    B(4, 2), W(4, 3), B(3, 3), W(4, 4), B(3, 4), W(8, 8), B(5, 3), W(8, 7), B(5, 4), W(8, 6), B(4, 5),
  ]),
  sequence('suicide is rejected', 9, [
    B(8, 8), W(1, 0), B(8, 7), W(0, 1), B(0, 0),
  ]),
  sequence('filling your own last liberty is legal when it captures', 9, [
    B(0, 2), W(0, 1), B(1, 2), W(1, 1), B(2, 1), W(1, 0), B(2, 0), W(8, 8), B(0, 0),
  ]),
  koSequence(),
  sequence('playing out of turn is rejected', 9, [
    B(2, 2), B(3, 3), W(3, 3),
  ]),
  sequence('an occupied point is rejected', 9, [
    B(2, 2), W(2, 2), W(3, 3),
  ]),
  sequence('a point off the board is rejected', 9, [
    B(9, 4), B(-1, 4), B(4, 9), B(0, 0),
  ]),
];

// Scoring is the half the app already ports, so these cases pin the port
// that exists as well as the one being written.
function scoringCase(name, size, rows, { captures = { black: 0, white: 0 }, komi = 6.5, dead = [], seki = [] } = {}) {
  const board = parse(rows);
  const { board: effective, captures: adjusted } = applyDeadStones(board, captures, dead);
  const result = scoreBoard(effective, adjusted, komi, seki);
  return {
    name,
    size,
    board: rows,
    captures,
    komi,
    dead,
    seki,
    expect: {
      black: result.black,
      white: result.white,
      winner: result.winner,
      margin: result.margin,
      blackTerritory: result.blackTerritoryPoints.length,
      whiteTerritory: result.whiteTerritoryPoints.length,
    },
  };
}

const scoring = [
  scoringCase('split board, no captures', 9, [
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
  ]),
  scoringCase('split board with komi 0', 9, [
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
  ], { komi: 0 }),
  scoringCase('a dead stone counts as a prisoner and its point as territory', 9, [
    '..BW.....',
    '..BW.....',
    '..BW.....',
    '..BWB....',
    '..BW.....',
    '..BW.....',
    '..BW.....',
    '..BW.....',
    '..BW.....',
  ], { dead: [{ x: 4, y: 3 }] }),
  scoringCase('prisoners already taken count towards the score', 9, [
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
    '...BW....',
  ], { captures: { black: 7, white: 2 } }),
];

const handicap = [];
for (const size of [9, 13, 19]) {
  for (let stones = 2; stones <= 9; stones += 1) {
    handicap.push({
      size,
      handicap: stones,
      points: getHandicapPoints(size, stones).map(([x, y]) => ({ x, y })),
      komi: getKomi(stones),
    });
  }
}

// Clocks: byoyomi is the one piece of timing logic with any subtlety —
// main time first, then whole periods burned only when a period elapses in
// full — so the cases walk a clock through each of those transitions.
const clockCases = [];
for (const [label, state, byoyomiSeconds, elapsedMs] of [
  ['inside main time', { remainingMs: 600_000, periodsLeft: 5 }, 30, 10_000],
  ['exactly main time', { remainingMs: 600_000, periodsLeft: 5 }, 30, 600_000],
  ['into the first period', { remainingMs: 5_000, periodsLeft: 5 }, 30, 20_000],
  ['a whole period burned', { remainingMs: 0, periodsLeft: 5 }, 30, 31_000],
  ['two whole periods burned', { remainingMs: 0, periodsLeft: 5 }, 30, 61_000],
  ['moving within a period costs nothing', { remainingMs: 0, periodsLeft: 3 }, 30, 29_999],
  ['the last period runs out', { remainingMs: 0, periodsLeft: 1 }, 30, 31_000],
  ['correspondence: a day per move', { remainingMs: 0, periodsLeft: 1 }, 86_400, 3_600_000],
]) {
  clockCases.push({
    name: label,
    state,
    byoyomiSeconds,
    elapsedMs,
    expect: {
      timedOut: hasTimedOut(state, byoyomiSeconds, elapsedMs),
      after: deductClock(state, byoyomiSeconds, elapsedMs),
    },
  });
}

const timeControls = ['unlimited', 'standard', 'correspondence', 'nonsense'].map((name) => ({
  name,
  preset: resolveTimeControl(name),
}));

const fixtures = {
  // Bumped by hand when the shape of this file changes, so a stale reader
  // fails loudly instead of quietly skipping cases it doesn't understand.
  version: 1,
  generatedBy: 'scripts/generate-rule-fixtures.mjs',
  reference: 'shared/src/index.ts',
  moveSequences,
  scoring,
  handicap,
  clocks: clockCases,
  timeControls,
  presets: TIME_CONTROL_PRESETS,
};

const serialised = `${JSON.stringify(fixtures, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (existing !== serialised) {
    console.error('shared/fixtures/rules.json is out of date — run: npm run fixtures');
    process.exit(1);
  }
  const caseCount = moveSequences.length + scoring.length + handicap.length + clockCases.length;
  console.log(`${caseCount} rule fixtures match the TypeScript engine.`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, serialised);
console.log(
  `wrote ${path.relative(root, outputPath)}: ` +
    `${moveSequences.length} sequences, ${scoring.length} scoring cases, ` +
    `${handicap.length} handicap layouts, ${clockCases.length} clock cases`,
);
