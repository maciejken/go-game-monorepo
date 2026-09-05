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
export function getGroup(board, point) {
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
// Standard Japanese-rules komi: 6.5 for an even game, 0.5 for a handicap
// game (just enough to avoid a tie — Black's handicap stones are the real
// compensation there).
export function getKomi(handicap) {
    return handicap >= 2 ? 0.5 : 6.5;
}
// Removes stones marked dead from the board (so they no longer block
// territory for their color) and credits each one to the opposing color as
// a prisoner — the standard pre-scoring cleanup step once both sides agree
// on which groups didn't survive. Leaves the inputs untouched.
export function applyDeadStones(board, captures, deadPoints) {
    const nextBoard = board.map((row) => row.slice());
    const nextCaptures = { ...captures };
    for (const { x, y } of deadPoints) {
        if (!isPointOnBoard(nextBoard, { x, y })) {
            continue;
        }
        const stone = nextBoard[y][x];
        if (!stone) {
            continue;
        }
        nextBoard[y][x] = null;
        nextCaptures[oppositeColor(stone)] += 1;
    }
    return { board: nextBoard, captures: nextCaptures };
}
// Assigns a stable numeric id to every stone's group (flood-filled once),
// so the region pass below can cross-reference "which specific group is
// this" rather than just "which color" — needed to tell seki apart from an
// ordinary dame point next to an already-alive group (see scoreBoard).
function labelGroups(board) {
    const size = board.length;
    const groupId = Array.from({ length: size }, () => new Array(size).fill(-1));
    const groupColor = new Map();
    let nextId = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const color = board[y][x];
            if (color === null || groupId[y][x] !== -1) {
                continue;
            }
            const id = nextId++;
            groupColor.set(id, color);
            for (const stone of getGroup(board, { x, y })) {
                groupId[stone.y][stone.x] = id;
            }
        }
    }
    return { groupId, groupColor };
}
// Flood-fills every connected empty region on the board, recording which
// color(s) and which specific stone groups border each one.
function findRegions(board, groupId) {
    const regions = [];
    const visited = new Set();
    for (let y = 0; y < board.length; y++) {
        for (let x = 0; x < board[y].length; x++) {
            if (board[y][x] !== null) {
                continue;
            }
            const key = `${x},${y}`;
            if (visited.has(key)) {
                continue;
            }
            const region = { size: 0, colors: new Set(), groupIds: new Set() };
            const stack = [{ x, y }];
            visited.add(key);
            while (stack.length > 0) {
                const point = stack.pop();
                region.size += 1;
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
                        region.colors.add(neighborStone);
                        region.groupIds.add(groupId[neighbor.y][neighbor.x]);
                    }
                }
            }
            regions.push(region);
        }
    }
    return regions;
}
// A shared region only counts as a plausible seki vital point if it's
// small — real seki vital liberties are almost always exactly 1 point,
// occasionally 2, essentially never more. Without this, two entirely
// ordinary, unconnected groups facing each other across a large open dame
// area also satisfy "fewer than two eyes each" (each has just the one big
// territory on its far side) and would be wrongly declared seki, wiping
// out both sides' real territory — nobody's group is actually in any
// danger there, unlike a genuine 1-2 point shared vital liberty.
const MAX_SEKI_SHARED_REGION_SIZE = 2;
// Which single-color regions count as territory outright, and which are
// actually part of a seki and so score nothing for either side — including
// each side's own "eye" points, not just the point(s) they share.
//
// A region touching both colors (borders.size === 2) is already always
// neutral (ordinary dame) regardless of anything below. The extra step
// here: a group with fewer than two independent eyes of its own, kept
// alive only by a small shared liberty with an enemy group in the same
// position, is in seki — and Japanese rules count nothing for either side
// in a seki, including points that look like ordinary one-color eyes but
// are really part of the same shared-life situation. This only recognizes
// the clear, symmetric case (a small shared liberty where every bordering
// group on both sides lacks two eyes of its own); anything requiring
// genuine life-and-death reading to resolve is left as-is, same as this
// scorer already leaves dead stones for a human to mark before calling
// this at all.
function findSekiNeutralRegions(regions) {
    const privateRegionsByGroup = new Map();
    const eyeCountByGroup = new Map();
    regions.forEach((region, index) => {
        if (region.colors.size !== 1) {
            return;
        }
        for (const id of region.groupIds) {
            eyeCountByGroup.set(id, (eyeCountByGroup.get(id) ?? 0) + 1);
            const list = privateRegionsByGroup.get(id);
            if (list) {
                list.push(index);
            }
            else {
                privateRegionsByGroup.set(id, [index]);
            }
        }
    });
    const neutral = new Set();
    for (const region of regions) {
        if (region.colors.size !== 2 || region.size > MAX_SEKI_SHARED_REGION_SIZE) {
            continue;
        }
        const isMutualSeki = [...region.groupIds].every((id) => (eyeCountByGroup.get(id) ?? 0) < 2);
        if (!isMutualSeki) {
            continue;
        }
        for (const id of region.groupIds) {
            for (const privateIndex of privateRegionsByGroup.get(id) ?? []) {
                neutral.add(privateIndex);
            }
        }
    }
    return neutral;
}
// A player can also directly declare a group to be in seki, via a separate
// scoring action from marking dead stones (see the client's "mark seki"
// toggle) — those stones stay on the board, since they're alive, unlike
// applyDeadStones. Only one side needs to be flagged: this pulls in every
// group directly sharing a liberty with a declared group too, so both
// sides' eyes end up excluded from territory either way — the same
// outcome as findSekiNeutralRegions above, but without its eye-count/
// region-size limits, since a human confirmed it rather than the
// automatic heuristic inferring it. This is the escape hatch for seki
// shapes that heuristic doesn't recognize (more than the usual 1-2 shared
// liberties, more irregular shapes, etc).
function findDeclaredSekiRegions(board, groupId, regions, declaredPoints) {
    const declaredGroups = new Set();
    for (const point of declaredPoints) {
        if (!isPointOnBoard(board, point) || board[point.y][point.x] === null) {
            continue;
        }
        declaredGroups.add(groupId[point.y][point.x]);
    }
    for (const region of regions) {
        if (region.colors.size === 2 && [...region.groupIds].some((id) => declaredGroups.has(id))) {
            for (const id of region.groupIds) {
                declaredGroups.add(id);
            }
        }
    }
    const neutral = new Set();
    regions.forEach((region, index) => {
        if (region.colors.size === 1 && [...region.groupIds].some((id) => declaredGroups.has(id))) {
            neutral.add(index);
        }
    });
    return neutral;
}
// Japanese-style territory scoring: surrounded empty territory (an empty
// region counts for a color only if every stone bordering it is that color;
// regions touching both, or neither, are neutral — see findSekiNeutralRegions
// and findDeclaredSekiRegions for the seki exceptions to that) plus
// prisoners — stones each color has captured over the course of the game.
// This scores the board exactly as it stands — it does not know which
// stones are "dead", so it's only correct if the position has no stones
// left on it that both players would agree are already captured in
// substance but not yet removed.
export function scoreBoard(board, captures, komi, declaredSekiPoints = []) {
    const { groupId } = labelGroups(board);
    const regions = findRegions(board, groupId);
    const sekiNeutral = findSekiNeutralRegions(regions);
    const declaredNeutral = findDeclaredSekiRegions(board, groupId, regions, declaredSekiPoints);
    let blackTerritory = 0;
    let whiteTerritory = 0;
    regions.forEach((region, index) => {
        if (region.colors.size !== 1 || sekiNeutral.has(index) || declaredNeutral.has(index)) {
            return;
        }
        if (region.colors.has('black')) {
            blackTerritory += region.size;
        }
        else {
            whiteTerritory += region.size;
        }
    });
    const black = blackTerritory + captures.black;
    const white = whiteTerritory + captures.white + komi;
    return {
        black,
        white,
        winner: black > white ? 'black' : 'white',
        margin: Math.abs(black - white),
    };
}
