"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("./db"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.resolve(__dirname, '../../client/dist')));
app.get('/', (req, res) => {
    res.json({ message: 'Go server is running!' });
});
app.get('/db-test', (req, res) => {
    try {
        db_1.default.prepare(`
      INSERT INTO events (game_id, move_number, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('perm-test', 1, 'TEST', JSON.stringify({ ok: true }), Date.now());
        res.json({ ok: true });
    }
    catch (error) {
        res.json({ error });
    }
});
// For React Router — serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../../client/dist/index.html'));
});
app.listen(config_1.port, () => {
    console.log(`Server running on port ${config_1.port}; db path: ${config_1.dbPath}`);
});
