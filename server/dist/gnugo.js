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
// terminating blank line arrives. Also settles (rejects) if the process
// exits or errors before that — otherwise, killing a stuck process (see the
// timeout in generateAiMove below) would leave this promise pending
// forever, since it would have had no other way to notice.
function sendCommand(child, command) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const cleanup = () => {
            child.stdout.off('data', onData);
            child.off('exit', onExit);
            child.off('error', onError);
        };
        const onData = (chunk) => {
            buffer += chunk.toString();
            if (!buffer.includes('\n\n') || settled) {
                return;
            }
            settled = true;
            cleanup();
            const response = buffer.trim();
            if (response.startsWith('=')) {
                resolve(response.slice(1).trim());
            }
            else {
                reject(new Error(response.slice(1).trim() || `GTP command failed: ${command}`));
            }
        };
        const onExit = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new Error(`gnugo exited before responding to: ${command}`));
        };
        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(err);
        };
        child.stdout.on('data', onData);
        child.once('exit', onExit);
        child.once('error', onError);
        child.stdin.write(`${command}\n`);
    });
}
const DEFAULT_TIMEOUT_MS = 600000;
// Stateless by design: a fresh gnugo process per request, replaying the
// whole game into it via GTP `play` before asking it to move. Slightly more
// work per call than keeping a process alive per game, but it means the
// game's own event log stays the single source of truth for board state —
// nothing to reconcile if the server restarts mid-game.
//
// Some positions can make gnugo's reading take a very long time (or, per
// observed behavior, effectively never return) — the timeout forces the
// process to die either way, and since sendCommand also listens for process
// exit, that reliably turns into a rejected promise instead of a permanent
// hang. The caller (server.ts) is expected to retry at one level lower on
// failure, since a lower level is both faster and far less likely to hit
// that same reading blowup again.
async function generateAiMoveNow(request, timeoutMs) {
    const child = spawn('gnugo', ['--mode', 'gtp', '--quiet', '--level', String(request.level)]);
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    try {
        await sendCommand(child, `boardsize ${request.size}`);
        await sendCommand(child, 'clear_board');
        await sendCommand(child, `komi ${request.komi}`);
        for (const move of request.moves) {
            const vertex = move.point ? pointToVertex(move.point, request.size) : 'pass';
            await sendCommand(child, `play ${move.color} ${vertex}`);
        }
        const result = await sendCommand(child, `genmove ${request.colorToMove}`);
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
        if (child.exitCode === null && child.signalCode === null) {
            child.stdin.write('quit\n');
            child.kill();
        }
    }
}
// One gnugo process at a time across the whole server, not one per game —
// two games both wanting a move at once would otherwise spawn two
// concurrent searches competing for the same CPU, which is exactly the
// kind of contention that turns an ordinary slow position into a genuinely
// timed-out one. Queued as a plain promise chain: each call waits for
// every earlier one to settle (success or failure) before its own gnugo
// process even starts. Fine for a single Node process; would need a real
// queue (or a lock in shared storage) if this ever ran multiple instances.
let queue = Promise.resolve();
export function generateAiMove(request, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const run = queue.then(() => generateAiMoveNow(request, timeoutMs));
    queue = run.catch(() => { });
    return run;
}
export async function isGnuGoAvailable() {
    return new Promise((resolve) => {
        const child = spawn('gnugo', ['--version']);
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
    });
}
