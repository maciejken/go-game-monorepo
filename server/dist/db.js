"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
// Ensure directory exists
const dbDir = path_1.default.dirname(config_1.dbPath);
if (!fs_1.default.existsSync(dbDir)) {
    fs_1.default.mkdirSync(dbDir, { recursive: true });
}
// Open database
const db = new better_sqlite3_1.default(config_1.dbPath);
// Enable WAL mode (best for Raspberry Pi)
db.pragma('journal_mode = WAL');
// Recommended for Pi: good balance of safety + speed
db.pragma('synchronous = NORMAL');
// Optional: reduce fragmentation
db.pragma('auto_vacuum = FULL');
// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    move_number INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    game_id TEXT NOT NULL,
    move_number INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, move_number)
  );

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );
`);
exports.default = db;
