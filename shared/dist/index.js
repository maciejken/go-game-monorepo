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
function oppositeColor(color) {
    return color === 'black' ? 'white' : 'black';
}
function getNeighbors(board, point) {
    const candidates = [
        { x: point.x - 1, y: point.y },
        { x: point.x + 1, y: point.y },
        { x: point.x, y: point.y - 1 },
        { x: point.x, y: point.y + 1 },
    ];
    return candidates.filter((p) => isPointOnBoard(board, p));
}
// Flood-fills the connected group of same-color stones starting at `point`.
function getGroup(board, point) {
    const color = board[point.y][point.x];
    if (color === null) {
        return [];
    }
    const visited = new Set([`${point.x},${point.y}`]);
    const group = [point];
    const stack = [point];
    while (stack.length > 0) {
        const current = stack.pop();
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
function hasLiberties(board, group) {
    return group.some((stone) => getNeighbors(board, stone).some((n) => board[n.y][n.x] === null));
}
function boardsEqual(a, b) {
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
function applyMove(board, point, color) {
    const next = board.map((row) => row.slice());
    next[point.y][point.x] = color;
    const opponent = oppositeColor(color);
    const capturedPoints = [];
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
// `previousBoard`, if given, is the board as it existed before the
// opponent's last stone placement — used to enforce the simple ko rule
// (a move may not recreate that exact position).
function validateMove(board, point, color, moveNumber, previousBoard) {
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
