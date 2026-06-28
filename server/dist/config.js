"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.port = exports.dbPath = void 0;
exports.dbPath = process.env.DB_PATH || './data/go.db';
exports.port = process.env.PORT || 3000;
