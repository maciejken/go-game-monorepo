export * from './clock.js';
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
export declare function getGroup(board: Board, point: Point): Point[];
export declare function hashBoard(board: Board): bigint;
export interface PositionRecord {
    hash: string;
    nextColor: Color;
    board: Board;
}
export interface MoveValidationResult {
    valid: boolean;
    error?: string;
    board?: Board;
    capturedPoints?: Point[];
    hash?: string;
}
export declare function validateMove(board: Board, point: Point, color: Color, moveNumber: number, history?: PositionRecord[]): MoveValidationResult;
export interface Captures {
    black: number;
    white: number;
}
export declare function getKomi(handicap: number): number;
export declare function applyDeadStones(board: Board, captures: Captures, deadPoints: Point[]): {
    board: Board;
    captures: Captures;
};
export interface ScoreResult {
    black: number;
    white: number;
    winner: Color;
    margin: number;
    blackTerritoryPoints: Point[];
    whiteTerritoryPoints: Point[];
}
export declare function findSekiPartnerStones(board: Board, point: Point): Point[];
export declare function scoreBoard(board: Board, captures: Captures, komi: number, declaredSekiPoints?: Point[]): ScoreResult;
export declare function getHandicapPoints(size: number, handicap: number): [number, number][];
export declare const BOARD_SIZES: number[];
