/**
 * TicXO — Production-ready server
 * Works locally AND on Railway, Render, Heroku, Fly.io etc.
 * Dependencies: express, socket.io only (built-in crypto handles passwords)
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

// ─── Password helpers (PBKDF2 — built into Node, no extra packages) ───────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (stored.startsWith('pbkdf2:')) {
    const [, salt, hash] = stored.split(':');
    const attempt = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    // timingSafeEqual prevents timing attacks
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
  }
  // Legacy SHA-256 accounts (migrate on next login)
  const sha = crypto.createHash('sha256').update(password).digest('hex');
  return sha === stored;
}

// ─── Simple in-memory rate limiter (no external package needed) ───────────────
const _rateBuckets = {};
function rateLimiter(maxHits, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    if (!_rateBuckets[key]) _rateBuckets[key] = [];
    _rateBuckets[key] = _rateBuckets[key].filter(t => now - t < windowMs);
    if (_rateBuckets[key].length >= maxHits)
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    _rateBuckets[key].push(now);
    next();
  };
}
const authLimiter = rateLimiter(20, 15 * 60 * 1000);

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const IS_CLOUD = !!process.env.RAILWAY_ENVIRONMENT ||
                 !!process.env.RENDER               ||
                 !!process.env.DYNO;

const DATA_DIR = IS_CLOUD ? '/tmp' : path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'users.json');

// ─── App setup ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Persistence helpers ─────────────────────────────────────────────────────
function loadDB() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE))  fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }));
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('DB load error:', e.message);
    return { users: {} };
  }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('DB save error:', e.message); }
}

// ─── In-memory game state ─────────────────────────────────────────────────────
const rooms             = {};
const sessions          = {};
const pendingReconnects = {};
const disconnectTimers  = {};

const RECONNECT_GRACE_MS = 15000;
const ROOM_WAIT_MS       = 5 * 60 * 1000;

function makeRoom(code, p1) {
  return {
    code,
    players:      { X: p1, O: null },
    board:        Array(9).fill(null),
    current:      'X',
    gameOver:     false,
    scores:       { X: 0, O: 0, D: 0 },
    round:        1,
    rematchVotes: new Set(),
    waitTimeout:  null
  };
}

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function checkWinner(board) {
  for (const [a,b,c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { winner: board[a], line: [a,b,c] };
  }
  if (board.every(Boolean)) return { winner: null };
  return null;
}

function cleanupRoom(code, notifyPayload) {
  if (!rooms[code]) return;
  if (notifyPayload) io.to(code).emit('opponent_left', notifyPayload);
  delete rooms[code];
  console.log(`Room ${code} deleted`);
}

// ─── REST: Auth ───────────────────────────────────────────────────────────────
app.post('/api/signup', authLimiter, (req, res) => {
  const { username, password, avatar } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 24)
    return res.status(400).json({ error: 'Username must be 2–24 characters' });
  if (password.length < 4 || password.length > 128)
    return res.status(400).json({ error: 'Password must be 4–128 characters' });

  const db  = loadDB();
  const key = trimmed.toLowerCase();

  if (db.users[key])
    return res.status(409).json({ error: 'Username already taken' });

  db.users[key] = {
    username:  trimmed,
    password:  hashPassword(password),
    avatar:    avatar || '🎮',
    wins:      0,
    losses:    0,
    draws:     0,
    createdAt: Date.now()
  };
  saveDB(db);

  const { password: _, ...safe } = db.users[key];
  res.json({ user: { ...safe, id: key } });
});

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Fill in all fields' });
  if (username.trim().length > 24 || password.length > 128)
    return res.status(400).json({ error: 'Invalid credentials' });

  const db   = loadDB();
  const key  = username.toLowerCase().trim();
  const user = db.users[key];

  if (!user)
    return res.status(401).json({ error: 'User not found' });

  if (!verifyPassword(password, user.password))
    return res.status(401).json({ error: 'Wrong password' });

  // Migrate legacy SHA-256 hash to PBKDF2 on first successful login
  if (!user.password.startsWith('pbkdf2:')) {
    user.password = hashPassword(password);
    saveDB(db);
    console.log(`Migrated ${key} to PBKDF2`);
  }

  const { password: _, ...safe } = user;
  res.json({ user: { ...safe, id: key } });
});

app.get('/api/leaderboard', (_req, res) => {
  const db = loadDB();
  const board = Object.entries(db.users)
    .map(([id, u]) => ({ id, username: u.username, avatar: u.avatar, wins: u.wins, losses: u.losses, draws: u.draws }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .slice(0, 20);
  res.json({ leaderboard: board });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`+ connected: ${socket.id}`);

  socket.on('auth', ({ userId, username }) => {
    sessions[socket.id] = { userId, username, roomCode: null, symbol: null };
    socket.emit('auth_ok', { socketId: socket.id });

    // Reconnect within grace period
    if (userId && userId !== 'guest' && pendingReconnects[userId]) {
      clearTimeout(disconnectTimers[userId]);
      delete disconnectTimers[userId];

      const { code, symbol } = pendingReconnects[userId];
      delete pendingReconnects[userId];

      const room = rooms[code];
      if (room) {
        sessions[socket.id] = { userId, username, roomCode: code, symbol };
        room.players[symbol] = { socketId: socket.id, userId, username };
        socket.join(code);
        socket.emit('reconnected', {
          code, symbol,
          board:    room.board,
          current:  room.current,
          scores:   room.scores,
          round:    room.round,
          gameOver: room.gameOver,
          players: {
            X: { username: room.players.X?.username, userId: room.players.X?.userId },
            O: { username: room.players.O?.username, userId: room.players.O?.userId }
          }
        });
        socket.to(code).emit('opponent_reconnected', { username });
        console.log(`${username} reconnected to room ${code}`);
      }
    }
  });

  // ── Create room ──
  socket.on('create_room', ({ userId, username }) => {
    const session = sessions[socket.id] || {};
    Object.assign(session, { userId, username });
    sessions[socket.id] = session;

    const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (rooms[code]);

    const room = makeRoom(code, { socketId: socket.id, userId, username });
    rooms[code] = room;

    room.waitTimeout = setTimeout(() => {
      if (rooms[code] && !rooms[code].players.O) {
        socket.emit('room_expired', { code });
        delete rooms[code];
        console.log(`Room ${code} expired`);
      }
    }, ROOM_WAIT_MS);

    session.roomCode = code;
    session.symbol   = 'X';
    socket.join(code);

    socket.emit('room_created', { code, symbol: 'X' });
    console.log(`Room ${code} created by ${username}`);
  });

  // ── Join room ──
  socket.on('join_room', ({ code, userId, username }) => {
    const upperCode = code?.toUpperCase();
    const room      = rooms[upperCode];

    if (!room)          return socket.emit('join_error', { message: 'Room not found. Check the code.' });
    if (room.players.O) return socket.emit('join_error', { message: 'Room is full.' });

    const session = sessions[socket.id] || {};
    Object.assign(session, { userId, username, roomCode: upperCode, symbol: 'O' });
    sessions[socket.id] = session;

    room.players.O = { socketId: socket.id, userId, username };
    if (room.waitTimeout) { clearTimeout(room.waitTimeout); room.waitTimeout = null; }
    socket.join(upperCode);

    socket.emit('room_joined', { code: upperCode, symbol: 'O' });
    io.to(upperCode).emit('game_start', {
      players: {
        X: { username: room.players.X.username, userId: room.players.X.userId },
        O: { username, userId }
      },
      current: 'X'
    });
    console.log(`${username} joined room ${upperCode}`);
  });

  // ── Make move ──
  socket.on('make_move', ({ index }) => {
    const session = sessions[socket.id];
    if (!session?.roomCode) return;
    const room = rooms[session.roomCode];
    if (!room || room.gameOver)          return;
    if (room.current !== session.symbol) return;
    if (room.board[index])               return;

    room.board[index] = session.symbol;
    const result = checkWinner(room.board);

    if (result) {
      room.gameOver = true;
      if (result.winner) {
        room.scores[result.winner]++;
        const db = loadDB();
        const winPlayer  = room.players[result.winner];
        const loseSym    = result.winner === 'X' ? 'O' : 'X';
        const losePlayer = room.players[loseSym];
        if (winPlayer?.userId  && db.users[winPlayer.userId])  db.users[winPlayer.userId].wins++;
        if (losePlayer?.userId && db.users[losePlayer.userId]) db.users[losePlayer.userId].losses++;
        saveDB(db);
      } else {
        room.scores.D++;
        const db = loadDB();
        for (const sym of ['X', 'O']) {
          const p = room.players[sym];
          if (p?.userId && db.users[p.userId]) db.users[p.userId].draws++;
        }
        saveDB(db);
      }
      io.to(session.roomCode).emit('move_made', { index, symbol: session.symbol, board: room.board });
      io.to(session.roomCode).emit('game_over', { winner: result.winner, line: result.line || null, scores: room.scores, round: room.round });
    } else {
      room.current = room.current === 'X' ? 'O' : 'X';
      io.to(session.roomCode).emit('move_made', { index, symbol: session.symbol, board: room.board, next: room.current });
    }
  });

  // ── Rematch ──
  socket.on('rematch', () => {
    const session = sessions[socket.id];
    if (!session?.roomCode) return;
    const room = rooms[session.roomCode];
    if (!room) return;

    room.rematchVotes.add(socket.id);
    io.to(session.roomCode).emit('rematch_vote', { count: room.rematchVotes.size });

    if (room.rematchVotes.size >= 2) {
      room.board = Array(9).fill(null);
      room.current = 'X';
      room.gameOver = false;
      room.round++;
      room.rematchVotes.clear();
      io.to(session.roomCode).emit('rematch_start', { round: room.round, current: 'X', scores: room.scores });
    }
  });

  // ── Chat ──
  socket.on('chat_msg', ({ text }) => {
    const session = sessions[socket.id];
    if (!session?.roomCode || !text?.trim()) return;
    io.to(session.roomCode).emit('chat_msg', { username: session.username, symbol: session.symbol, text: text.trim().slice(0, 120) });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const session = sessions[socket.id];
    console.log(`- disconnected: ${socket.id}`);

    if (session?.roomCode) {
      const room = rooms[session.roomCode];
      if (room && session.userId && session.userId !== 'guest') {
        pendingReconnects[session.userId] = { code: session.roomCode, symbol: session.symbol };
        socket.to(session.roomCode).emit('opponent_disconnected', { username: session.username, graceMs: RECONNECT_GRACE_MS });
        disconnectTimers[session.userId] = setTimeout(() => {
          delete pendingReconnects[session.userId];
          delete disconnectTimers[session.userId];
          cleanupRoom(session.roomCode, { username: session.username });
        }, RECONNECT_GRACE_MS);
      } else {
        cleanupRoom(session.roomCode, { username: session.username });
      }
    }
    delete sessions[socket.id];
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 TicXO running → http://localhost:${PORT}`);
  console.log(`   Environment: ${IS_CLOUD ? 'cloud ☁️' : 'local 💻'}`);
  console.log(`   Data file:   ${DB_FILE}\n`);
});
