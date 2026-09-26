#!/usr/bin/env node
// Takes a consistent snapshot of the live database, without stopping the
// server.
//
//   DB_PATH=/home/pi/projects/go-server/data/go.db node scripts/backup-db.mjs
//
// Snapshots land in a backups/ directory beside the database itself, so
// they travel with it and are obvious to whoever finds the data directory.
// BACKUP_DIR overrides that, KEEP says how many to leave behind (60 —
// two months of nightly snapshots, which at a few hundred kB each is
// cheaper than deciding how far back you might want to look).
//
// Copying go.db with cp is not the same thing: in WAL mode the newest
// committed data lives in go.db-wal, so a plain copy of the one file is a
// snapshot of some older moment, and copying all three separately can
// catch them mid-checkpoint. SQLite's own online backup — what
// better-sqlite3's db.backup() calls — reads a consistent version of the
// whole database while writers carry on, and hands back a single file with
// nothing to replay.
//
// Snapshots are gzipped, because a Go database is mostly stored board
// positions and those are JSON full of nulls — they compress by an order
// of magnitude, which is the difference between keeping a fortnight of
// them on an SD card and not.
//
// To restore: stop the server, then
//   gunzip -c data/backups/go-<stamp>.db.gz > data/go.db
// deleting any go.db-wal and go.db-shm beside it, and start the server.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH || './data/go.db';
const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dbPath)), 'backups');
const keep = Number(process.env.KEEP ?? 60);

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DB_PATH to the one the server uses.`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

// Sorts chronologically as a string, which is what the pruning below wants.
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, '');
const name = `go-${stamp}.db`;
const destination = path.join(backupDir, name);

const source = new Database(dbPath, { readonly: true });
await source.backup(destination);
source.close();

// A backup nobody checked is a file, not a backup.
const copy = new Database(destination, { readonly: true });
const integrity = copy.pragma('integrity_check', { simple: true });
const users = copy.prepare('SELECT COUNT(*) as count FROM users').get().count;
const games = copy.prepare('SELECT COUNT(*) as count FROM games').get().count;
const events = copy.prepare('SELECT COUNT(*) as count FROM events').get().count;
copy.close();

// Reading a WAL database leaves a -wal and a -shm beside it, even though
// nothing was written. A snapshot should be the one file you can copy
// anywhere, so they go.
removeSidecars(destination);

if (integrity !== 'ok') {
  console.error(`The snapshot did not verify: ${integrity}`);
  process.exit(1);
}

const plainSize = fs.statSync(destination).size;
// Streamed rather than read whole: this runs on a machine with less
// memory than some of these databases deserve.
await pipeline(
  fs.createReadStream(destination),
  zlib.createGzip({ level: 9 }),
  fs.createWriteStream(`${destination}.gz`),
);
fs.rmSync(destination);

const packedSize = fs.statSync(`${destination}.gz`).size;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `${destination}.gz — ${mb(packedSize)} (from ${mb(plainSize)}), ` +
    `${users} users, ${games} games, ${events} events, integrity ok`,
);

// Oldest first, so everything past the newest `keep` goes.
if (Number.isInteger(keep) && keep > 0) {
  const snapshots = fs
    .readdirSync(backupDir)
    .filter((file) => /^go-\d{8}T\d{6}\.db\.gz$/.test(file))
    .sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    fs.rmSync(path.join(backupDir, old));
    console.log(`removed ${old}`);
  }
}

function removeSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}
