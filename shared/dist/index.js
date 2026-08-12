"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEmptyBoard = createEmptyBoard;
exports.getCurrentColor = getCurrentColor;
exports.isPointOnBoard = isPointOnBoard;
exports.isPointEmpty = isPointEmpty;
exports.validateMove = validateMove;
function createEmptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(null));
}
function getCurrentColor(moveNumber) {
    return moveNumber % 2 === 1 ? 'black' : 'white';
}
function isPointOnBoard(board, point) {
    return point.y >= 0 && point.y < board.length && point.x >= 0 && point.x < board[point.y].length;
}
function isPointEmpty(board, point) {
    return isPointOnBoard(board, point) && board[point.y][point.x] === null;
}
function validateMove(board, point, color, moveNumber) {
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
