const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Data directory: on Render this should be the mount path of your persistent Disk
// (see render.yaml / README). Locally it just falls back to ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'wheels.db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set. Set it in Render env vars or nobody will be able to edit the wheels.');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wheel TEXT NOT NULL CHECK(wheel IN ('gear','rune')),
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const WHEELS = ['gear', 'rune'];

app.use(express.json());
app.set('trust proxy', 1); // required behind Render's proxy for secure cookies
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 90, // 90 days
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authorized' });
}

function validWheel(w) {
  return WHEELS.includes(w);
}

function getWheel(wheel) {
  return db.prepare('SELECT id, name, position FROM players WHERE wheel = ? ORDER BY position ASC').all(wheel);
}

function renumberAndSave(wheel, orderedList) {
  const update = db.prepare('UPDATE players SET position = ? WHERE id = ?');
  const tx = db.transaction((list) => {
    list.forEach((p, i) => update.run(i, p.id));
  });
  tx(orderedList);
}

// ---------- Auth ----------

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Server missing ADMIN_PASSWORD configuration' });
  }
  if (typeof password === 'string' && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---------- Read (public) ----------

app.get('/api/wheel/:wheel', (req, res) => {
  const { wheel } = req.params;
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid wheel' });
  res.json(getWheel(wheel));
});

// ---------- Write (admin only) ----------

app.post('/api/wheel/:wheel/add', requireAdmin, (req, res) => {
  const { wheel } = req.params;
  const { name } = req.body || {};
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid wheel' });
  const trimmed = (name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Name required' });
  if (trimmed.length > 40) return res.status(400).json({ error: 'Name too long' });

  const row = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM players WHERE wheel = ?').get(wheel);
  db.prepare('INSERT INTO players (wheel, name, position) VALUES (?, ?, ?)').run(wheel, trimmed, row.m + 1);
  res.json(getWheel(wheel));
});

app.post('/api/wheel/:wheel/remove', requireAdmin, (req, res) => {
  const { wheel } = req.params;
  const { id } = req.body || {};
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid wheel' });
  db.prepare('DELETE FROM players WHERE id = ? AND wheel = ?').run(id, wheel);
  renumberAndSave(wheel, getWheel(wheel));
  res.json(getWheel(wheel));
});

// "Award" = the Suicide Kings action: this player got the loot, send them to the bottom
app.post('/api/wheel/:wheel/award', requireAdmin, (req, res) => {
  const { wheel } = req.params;
  const { id } = req.body || {};
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid wheel' });

  const players = getWheel(wheel);
  const idx = players.findIndex(p => p.id === Number(id));
  if (idx === -1) return res.status(404).json({ error: 'Player not found' });

  const [player] = players.splice(idx, 1);
  players.push(player);
  renumberAndSave(wheel, players);
  res.json(getWheel(wheel));
});

// Manual nudge up/down, for correcting mistakes without a full "award"
app.post('/api/wheel/:wheel/move', requireAdmin, (req, res) => {
  const { wheel } = req.params;
  const { id, direction } = req.body || {};
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid wheel' });
  if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });

  const players = getWheel(wheel);
  const idx = players.findIndex(p => p.id === Number(id));
  if (idx === -1) return res.status(404).json({ error: 'Player not found' });

  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= players.length) return res.json(players);

  [players[idx], players[swapWith]] = [players[swapWith], players[idx]];
  renumberAndSave(wheel, players);
  res.json(getWheel(wheel));
});

// Randomize the current order of everyone already on a wheel
app.post('/api/wheel/:wheel/shuffle', requireAdmin, (req, res) => {
  const { wheel } = req.params;
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid wheel' });

  const players = getWheel(wheel);
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  renumberAndSave(wheel, players);
  res.json(getWheel(wheel));
});

// Replace this wheel's roster with a (freshly shuffled) copy of the other wheel's names
app.post('/api/wheel/:wheel/copy-from', requireAdmin, (req, res) => {
  const { wheel } = req.params;
  const { source } = req.body || {};
  if (!validWheel(wheel)) return res.status(400).json({ error: 'Invalid target wheel' });
  if (!validWheel(source) || source === wheel) return res.status(400).json({ error: 'Invalid source wheel' });

  const sourcePlayers = getWheel(source);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM players WHERE wheel = ?').run(wheel);
    const insert = db.prepare('INSERT INTO players (wheel, name, position) VALUES (?, ?, ?)');
    // Insert in a shuffled order right away
    const shuffled = [...sourcePlayers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((p, i) => insert.run(wheel, p.name, i));
  });
  tx();

  res.json(getWheel(wheel));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Embers Adrift loot wheel server listening on port ${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
