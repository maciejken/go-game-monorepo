import { WebSocketServer, WebSocket } from 'ws';
// Live updates are signal-only: "something about this game/list changed,
// go refetch" rather than pushing full state. That keeps the one existing
// source of truth — the REST endpoints, with their per-session permission
// shaping (myColor, pendingUndoBy, etc.) — instead of duplicating it here.
const gameSubscribers = new Map();
const listSubscribers = new Set();
function addGameSubscriber(gameId, ws) {
    let subscribers = gameSubscribers.get(gameId);
    if (!subscribers) {
        subscribers = new Set();
        gameSubscribers.set(gameId, subscribers);
    }
    subscribers.add(ws);
    ws.on('close', () => {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
            gameSubscribers.delete(gameId);
        }
    });
}
function addListSubscriber(ws) {
    listSubscribers.add(ws);
    ws.on('close', () => listSubscribers.delete(ws));
}
export function broadcastGameUpdate(gameId) {
    const subscribers = gameSubscribers.get(gameId);
    if (!subscribers) {
        return;
    }
    const payload = JSON.stringify({ type: 'game-updated', gameId });
    for (const ws of subscribers) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    }
}
export function broadcastGamesListUpdate() {
    const payload = JSON.stringify({ type: 'games-list-updated' });
    for (const ws of listSubscribers) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    }
}
// Routed by path rather than a message-based subscribe protocol: one
// connection per game view (/ws/games/:id) or the games list (/ws/games).
export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        if (url.pathname === '/ws/games') {
            wss.handleUpgrade(req, socket, head, (ws) => addListSubscriber(ws));
            return;
        }
        const match = url.pathname.match(/^\/ws\/games\/([^/]+)$/);
        if (match) {
            const gameId = match[1];
            wss.handleUpgrade(req, socket, head, (ws) => addGameSubscriber(gameId, ws));
            return;
        }
        socket.destroy();
    });
}
