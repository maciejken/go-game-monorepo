import express from 'express';
import db from './db';

import { dbPath, port } from './config';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Go server is running!' });
});

app.get('/db-test', (req, res) => {
  try {
    db.prepare(`
      INSERT INTO events (game_id, move_number, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'perm-test',
      1,
      'TEST',
      JSON.stringify({ ok: true }),
      Date.now()
    );

    res.json({ ok: true });
  } catch (error) {
    res.json({ error });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}; db path: ${dbPath}`);
});
