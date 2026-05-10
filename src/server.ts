import express from 'express';
import dotenv from 'dotenv';
import db from './db';

const dbPath = process.env.DB_PATH || '../data/go.db'

dotenv.config();

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}; db path: ${dbPath}`);
});
