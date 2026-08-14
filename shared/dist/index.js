export function createEmptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(null));
}
export function getCurrentColor(moveNumber) {
    return moveNumber % 2 === 1 ? 'black' : 'white';
}
export function isPointOnBoard(board, point) {
    return point.y >= 0 && point.y < board.length && point.x >= 0 && point.x < board[point.y].length;
}
export function isPointEmpty(board, point) {
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
// splitmix64 — a small, fast, deterministic 64-bit PRNG. Used to build the
// Zobrist table so hashes are reproducible across process restarts.
function splitmix64(seed) {
    const mask = 0xffffffffffffffffn;
    let state = seed & mask;
    return () => {
        state = (state + 0x9e3779b97f4a7c15n) & mask;
        let z = state;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
        return z ^ (z >> 31n);
    };
}
// table[y][x][0|1] = a random 64-bit value for (black|white) occupying (x, y).
// Cached per board size, since a game's size never changes mid-game.
const zobristTables = new Map();
function getZobristTable(size) {
    const cached = zobristTables.get(size);
    if (cached) {
        return cached;
    }
    const next = splitmix64(0x9e3779b97f4a7c15n + BigInt(size));
    const table = Array.from({ length: size }, () => Array.from({ length: size }, () => [next(), next()]));
    zobristTables.set(size, table);
    return table;
}
// Zobrist hash of a board: XOR together the random value for every occupied
// point. XOR is its own inverse, so this could be updated incrementally as
// stones are added/removed rather than recomputed from scratch — the usual
// reason to use this scheme — but here it's simply used as a cheap,
// collision-resistant fingerprint for comparing positions.
export function hashBoard(board) {
    const table = getZobristTable(board.length);
    let hash = 0n;
    for (let y = 0; y < board.length; y++) {
        for (let x = 0; x < board[y].length; x++) {
            const stone = board[y][x];
            if (stone) {
                hash ^= table[y][x][stone === 'black' ? 0 : 1];
            }
        }
    }
    return hash;
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
// `history`, if given, is every position the game has passed through so
// far (including the empty/handicap starting position). Situational
// superko: a move is illegal if the position it produces — board plus whose
// turn is next — has occurred before. This subsumes the classic "simple ko"
// rule (recreating the position from just before the opponent's last move
// is one specific case of this) while also catching longer cycles.
export function validateMove(board, point, color, moveNumber, history = []) {
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
    const resultHash = hashBoard(resultBoard).toString();
    const nextColor = oppositeColor(color);
    const violatesSuperko = history.some((entry) => entry.nextColor === nextColor && entry.hash === resultHash && boardsEqual(entry.board, resultBoard));
    if (violatesSuperko) {
        return { valid: false, error: 'Move violates the superko rule (position already occurred)' };
    }
    return { valid: true, board: resultBoard, capturedPoints, hash: resultHash };
}
// Japanese-style territory scoring: surrounded empty territory (an empty
// region counts for a color only if every stone bordering it is that color;
// regions touching both, or neither, are neutral) plus prisoners — stones
// each color has captured over the course of the game. This scores the
// board exactly as it stands — it does not know which stones are "dead", so
// it's only correct if the position has no stones left on it that both
// players would agree are already captured in substance but not yet
// removed.
export function scoreBoard(board, captures, komi) {
    let blackTerritory = 0;
    let whiteTerritory = 0;
    const visited = new Set();
    for (let y = 0; y < board.length; y++) {
        for (let x = 0; x < board[y].length; x++) {
            const stone = board[y][x];
            if (stone === 'black' || stone === 'white') {
                continue;
            }
            const key = `${x},${y}`;
            if (visited.has(key)) {
                continue;
            }
            // Flood-fill this empty region, tracking which color(s) border it.
            let regionSize = 0;
            const borders = new Set();
            const stack = [{ x, y }];
            visited.add(key);
            while (stack.length > 0) {
                const point = stack.pop();
                regionSize += 1;
                for (const neighbor of getNeighbors(board, point)) {
                    const neighborStone = board[neighbor.y][neighbor.x];
                    if (neighborStone === null) {
                        const neighborKey = `${neighbor.x},${neighbor.y}`;
                        if (!visited.has(neighborKey)) {
                            visited.add(neighborKey);
                            stack.push(neighbor);
                        }
                    }
                    else {
                        borders.add(neighborStone);
                    }
                }
            }
            if (borders.size === 1) {
                if (borders.has('black')) {
                    blackTerritory += regionSize;
                }
                else {
                    whiteTerritory += regionSize;
                }
            }
            // borders.size === 0 (empty board) or 2 (touches both colors): neutral
        }
    }
    const black = blackTerritory + captures.black;
    const white = whiteTerritory + captures.white + komi;
    return {
        black,
        white,
        winner: black > white ? 'black' : 'white',
        margin: Math.abs(black - white),
    };
}
