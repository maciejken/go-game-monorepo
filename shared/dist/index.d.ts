export type Color = 'black' | 'white';
export type Board = (Color | null)[][];
export interface Point {
    x: number;
    y: number;
}
export declare function createEmptyBoard(size: number): Board;
export declare function getCurrentColor(moveNumber: number): Color;
export declare function isPointOnBoard(board: Board, point: Point): boolean;
export declare function isPointEmpty(board: Board, point: Point): boolean;
export interface MoveValidationResult {
    valid: boolean;
    error?: string;
    board?: Board;
    capturedPoints?: Point[];
}
export declare function validateMove(board: Board, point: Point, color: Color, moveNumber: number, previousBoard?: Board): MoveValidationResult;
