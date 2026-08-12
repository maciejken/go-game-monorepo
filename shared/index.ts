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

export interface MoveValidationResult {
  valid: boolean;
  error?: string;
}

export function validateMove(board: Board, point: Point, color: Color, moveNumber: number): MoveValidationResult {
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

  return { valid: true };
}
