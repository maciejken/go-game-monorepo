import { spawn } from 'child_process';
// Same skip-"I" column convention already used by the client and by GTP
// itself, with row 1 at the bottom — so this is a direct port of the
// coordinate math already in Game.tsx's describeEntry.
const COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST';
function pointToVertex(point, size) {
    return `${COLUMN_LABELS[point.x]}${size - point.y}`;
}
function vertexToPoint(vertex, size) {
    const upper = vertex.toUpperCase();
    if (upper === 'PASS' || upper === 'RESIGN') {
        return null;
    }
    const x = COLUMN_LABELS.indexOf(upper[0]);
    const y = size - Number(upper.slice(1));
    return { x, y };
}
// Sends one GTP command and resolves with its result text once the
// terminating blank line arrives, per the GTP line protocol.
function sendCommand(stdin, stdout, command) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const onData = (chunk) => {
            buffer += chunk.toString();
            if (!buffer.includes('\n\n')) {
                return;
            }
            stdout.off('data', onData);
            const response = buffer.trim();
            if (response.startsWith('=')) {
                resolve(response.slice(1).trim());
            }
            else {
                reject(new Error(response.slice(1).trim() || `GTP command failed: ${command}`));
            }
        };
        stdout.on('data', onData);
        stdin.write(`${command}\n`);
    });
}
const GENERATE_TIMEOUT_MS = 20000;
// Stateless by design: a fresh gnugo process per request, replaying the
// whole game into it via GTP `play` before asking it to move. Slightly more
// work per call than keeping a process alive per game, but it means the
// game's own event log stays the single source of truth for board state —
// nothing to reconcile if the server restarts mid-game.
export async function generateAiMove(request) {
    const child = spawn('gnugo', ['--mode', 'gtp', '--quiet']);
    const timeout = setTimeout(() => child.kill(), GENERATE_TIMEOUT_MS);
    try {
        await sendCommand(child.stdin, child.stdout, `boardsize ${request.size}`);
        await sendCommand(child.stdin, child.stdout, 'clear_board');
        await sendCommand(child.stdin, child.stdout, `komi ${request.komi}`);
        for (const move of request.moves) {
            const vertex = move.point ? pointToVertex(move.point, request.size) : 'pass';
            await sendCommand(child.stdin, child.stdout, `play ${move.color} ${vertex}`);
        }
        const result = await sendCommand(child.stdin, child.stdout, `genmove ${request.colorToMove}`);
        const upper = result.toUpperCase();
        if (upper === 'PASS') {
            return { type: 'pass' };
        }
        if (upper === 'RESIGN') {
            return { type: 'resign' };
        }
        const point = vertexToPoint(result, request.size);
        return point ? { type: 'move', point } : { type: 'pass' };
    }
    finally {
        clearTimeout(timeout);
        child.stdin.write('quit\n');
        child.kill();
    }
}
export async function isGnuGoAvailable() {
    return new Promise((resolve) => {
        const child = spawn('gnugo', ['--version']);
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
    });
}
