#!/usr/bin/env node
// The one-shot that turns tagged favourites back into rows in `stars`,
// checked on a database built to look like one that predates the change.
// Worth its own script because a migration runs once against real data
// and cannot be tried again afterwards — and because the way this one
// goes wrong is not by failing but by running a second time, resurrecting
// a star somebody has since removed.
//
//   node scripts/check-db-migration.mjs
//
// Loads the real db.ts through tsx, twice, in fresh processes, because
// the migration runs as an import side effect. The source rather than
// server/dist, so that what is checked is what the rest of the suite
// runs — a build left stale would otherwise quietly check nothing.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbModule = path.join(root, 'server/src/db.ts');

const failures = [];
let checked = 0;

function expect(condition, describe) {
  checked += 1;
  if (!condition) {
    failures.push(describe);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'igo5-migration-'));
const dbPath = path.join(work, 'migrate.db');

// Importing the module is what runs the schema and the migrations.
function openServerDatabase() {
  const loader = path.join(work, 'load.ts');
  fs.writeFileSync(loader, `import ${JSON.stringify(dbModule)};\n`);
  execFileSync('npx', ['tsx', loader], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath },
    stdio: 'pipe',
  });
}

try {
  // A database as it was before: the tables exist, nothing to migrate yet.
  openServerDatabase();

  const db = new Database(dbPath);
  const now = Date.now();
  db.exec(`
    INSERT INTO users (id, username, password_hash, created_at, favourite_tag)
      VALUES ('u1', 'tagger', 'x', ${now}, 'favourite');
    INSERT INTO users (id, username, password_hash, created_at)
      VALUES ('u2', 'plain', 'x', ${now});
    INSERT INTO games (id, size, status, created_at, updated_at)
      VALUES ('g1', 9, 'active', ${now}, ${now});
    INSERT INTO games (id, size, status, created_at, updated_at)
      VALUES ('g2', 9, 'active', ${now}, ${now});
    INSERT INTO game_tags (game_id, tag_key, tag, user_id, is_public, created_at)
      VALUES ('g1', 'favourite', 'Favourite', 'u1', 0, ${now});
    INSERT INTO game_tags (game_id, tag_key, tag, user_id, is_public, created_at)
      VALUES ('g2', 'teaching', 'teaching', 'u1', 0, ${now});
    INSERT INTO game_tags (game_id, tag_key, tag, user_id, is_public, created_at)
      VALUES ('g1', 'favourite', 'Favourite', 'u2', 0, ${now});
  `);
  db.close();

  // ...and now the version that migrates it.
  openServerDatabase();

  const after = new Database(dbPath, { readonly: true });
  const starred = after.prepare('SELECT user_id, game_id FROM stars ORDER BY user_id, game_id').all();
  expect(
    starred.length === 1 && starred[0].user_id === 'u1' && starred[0].game_id === 'g1',
    `after migrating: stars holds ${JSON.stringify(starred)}, expected only u1/g1`,
  );
  // A tag that wasn't the favourite one is just a tag.
  expect(
    !starred.some((row) => row.game_id === 'g2'),
    'a tag that was never the favourite one became a star',
  );
  // Somebody else's identically-named tag is not this user's favourite —
  // u2 never nominated one.
  expect(!starred.some((row) => row.user_id === 'u2'), 'a user who nominated no tag got stars anyway');
  // The tags themselves survive: they are ordinary tags now.
  const tagsLeft = after.prepare('SELECT COUNT(*) AS count FROM game_tags').get().count;
  expect(tagsLeft === 3, `the migration changed the tags: ${tagsLeft} left of 3`);
  // And the marker that says it has run.
  const stillNominated = after.prepare('SELECT COUNT(*) AS count FROM users WHERE favourite_tag IS NOT NULL').get();
  expect(stillNominated.count === 0, `${stillNominated.count} user(s) still carry a favourite_tag`);
  after.close();

  // The part that matters most: a star removed afterwards must stay
  // removed. The tag that produced it is still on the game, so a
  // migration that ran twice would quietly bring it back.
  const between = new Database(dbPath);
  between.prepare("DELETE FROM stars WHERE user_id = 'u1' AND game_id = 'g1'").run();
  between.close();

  openServerDatabase();

  const final = new Database(dbPath, { readonly: true });
  const resurrected = final.prepare('SELECT COUNT(*) AS count FROM stars').get().count;
  expect(resurrected === 0, 'an un-starred game came back: the migration ran a second time');
  final.close();
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log(`Tagged favourites become stars, once (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
