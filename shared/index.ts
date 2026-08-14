export type Color = 'black' | 'white';

export type Board = (Color | null)[][];

export interface Point {
  x: number;
  y: number;
}

export function createEmptyBoard(size: number): Board {
  return Array.from({ length: size }, () => Array<Color | null>(size).fill(null));
}

export function getCurrentColor(moveNumber: number): Color {
  return moveNumber % 2 === 1 ? 'black' : 'white';
}

export function isPointOnBoard(board: Board, point: Point): boolean {
  return point.y >= 0 && point.y < board.length && point.x >= 0 && point.x < board[point.y].length;
}

export function isPointEmpty(board: Board, point: Point): boolean {
  return isPointOnBoard(board, point) && board[point.y][point.x] === null;
}

function oppositeColor(color: Color): Color {
  return color === 'black' ? 'white' : 'black';
}

function getNeighbors(board: Board, point: Point): Point[] {
  const candidates: Point[] = [
    { x: point.x - 1, y: point.y },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y - 1 },
    { x: point.x, y: point.y + 1 },
  ];
  return candidates.filter((p) => isPointOnBoard(board, p));
}

// Flood-fills the connected group of same-color stones starting at `point`.
function getGroup(board: Board, point: Point): Point[] {
  const color = board[point.y][point.x];
  if (color === null) {
    return [];
  }

  const visited = new Set<string>([`${point.x},${point.y}`]);
  const group: Point[] = [point];
  const stack: Point[] = [point];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const neighbor of getNeighbors(board, current)) {
      const key = `${neighbor.x},${neighbor.y}`;
      if (visited.has(key) || board[neighbor.y][neighbor.x] !== color) {
        continue;
      }
      visited.add(key);
      group.push(neighbor);
      stack.push(neighbor);
    }
  }

  return group;
}

function hasLiberties(board: Board, group: Point[]): boolean {
  return group.some((stone) => getNeighbors(board, stone).some((n) => board[n.y][n.x] === null));
}

function boardsEqual(a: Board, b: Board): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== b[y][x]) {
        return false;
      }
    }
  }
  return true;
}

// Places `color` at `point` and removes any now-liberty-less enemy groups.
// Must run before the suicide check, since capturing first can open up
// liberties for the just-placed stone.
function applyMove(board: Board, point: Point, color: Color): { board: Board; capturedPoints: Point[] } {
  const next = board.map((row) => row.slice());
  next[point.y][point.x] = color;

  const opponent = oppositeColor(color);
  const capturedPoints: Point[] = [];

  for (const neighbor of getNeighbors(next, point)) {
    if (next[neighbor.y][neighbor.x] !== opponent) {
      continue;
    }
    const group = getGroup(next, neighbor);
    if (!hasLiberties(next, group)) {
      for (const stone of group) {
        next[stone.y][stone.x] = null;
        capturedPoints.push(stone);
      }
    }
  }

  return { board: next, capturedPoints };
}

export interface MoveValidationResult {
  valid: boolean;
  error?: string;
  board?: Board;
  capturedPoints?: Point[];
}

// `previousBoard`, if given, is the board as it existed before the
// opponent's last stone placement — used to enforce the simple ko rule
// (a move may not recreate that exact position).
export function validateMove(
  board: Board,
  point: Point,
  color: Color,
  moveNumber: number,
  previousBoard?: Board,
): MoveValidationResult {
  if (!isPointOnBoard(board, point)) {
    return { valid: false, error: 'Point is outside the board' };
  }

  const currentColor = getCurrentColor(moveNumber);
  if (color !== currentColor) {
    return { valid: false, error: `It is ${currentColor}'s turn` };
  }

  if (!isPointEmpty(board, point)) {
    return { valid: false, error: 'Point is already occupied' };
  }

  const { board: resultBoard, capturedPoints } = applyMove(board, point, color);

  if (capturedPoints.length === 0 && !hasLiberties(resultBoard, getGroup(resultBoard, point))) {
    return { valid: false, error: 'Move is suicide' };
  }

  if (previousBoard && boardsEqual(resultBoard, previousBoard)) {
    return { valid: false, error: 'Move violates the ko rule' };
  }

  return { valid: true, board: resultBoard, capturedPoints };
}
