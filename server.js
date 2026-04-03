require('dotenv').config();
/**
 * TicXO — Production-ready server with MongoDB
 * Works locally AND on Railway, Render, Heroku, Fly.io etc.
 * Dependencies: express, socket.io, mongoose
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const mongoose   = require('mongoose');

// ─── MongoDB connection ───────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ticxo';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB connection error:', err.message); process.exit(1); });

// ─── User schema ──────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  _id:       String,           // username lowercase (e.g. "ken")
  username:  String,           // display name (e.g. "Ken")
  password:  String,
  avatar:    { type: String, default: '🎮' },
  wins:      { type: Number,  default: 0 },
  losses:    { type: Number,  default: 0 },
  draws:     { type: Number,  default: 0 },
  createdAt: { type: Number,  default: () => Date.now() }
});

const User = mongoose.model('User', userSchema);

// ─── Password helpers ─────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (stored.startsWith('pbkdf2:')) {
    const [, salt, hash] = stored.split(':');
    const attempt = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
  }
  const sha = crypto.createHash('sha256').update(password).digest('hex');
  return sha === stored;
}

// ─── Simple in-memory rate limiter ───────────────────────────────────────────
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

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ─── App setup ────────────────────────────────────────────────────────────────
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
app.post('/api/signup', authLimiter, async (req, res) => {
  const { username, password, avatar } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 24)
    return res.status(400).json({ error: 'Username must be 2–24 characters' });
  if (password.length < 4 || password.length > 128)
    return res.status(400).json({ error: 'Password must be 4–128 characters' });

  const key = trimmed.toLowerCase();

  try {
    const existing = await User.findById(key);
    if (existing)
      return res.status(409).json({ error: 'Username already taken' });

    const newUser = await User.create({
      _id:      key,
      username: trimmed,
      password: hashPassword(password),
      avatar:   avatar || '🎮',
    });

    const { password: _, ...safe } = newUser.toObject();
    res.json({ user: { ...safe, id: key } });
  } catch (e) {
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Fill in all fields' });
  if (username.trim().length > 24 || password.length > 128)
    return res.status(400).json({ error: 'Invalid credentials' });

  const key = username.toLowerCase().trim();

  try {
    const user = await User.findById(key);

    if (!user)
      return res.status(401).json({ error: 'User not found' });

    if (!verifyPassword(password, user.password))
      return res.status(401).json({ error: 'Wrong password' });

    // Migrate legacy SHA-256 to PBKDF2
    if (!user.password.startsWith('pbkdf2:')) {
      user.password = hashPassword(password);
      await user.save();
      console.log(`Migrated ${key} to PBKDF2`);
    }

    const { password: _, ...safe } = user.toObject();
    res.json({ user: { ...safe, id: key } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const users = await User.find({})
      .sort({ wins: -1, losses: 1 })
      .limit(20)
      .select('-password');

    const leaderboard = users.map(u => ({
      id:       u._id,
      username: u.username,
      avatar:   u.avatar,
      wins:     u.wins,
      losses:   u.losses,
      draws:    u.draws
    }));

    res.json({ leaderboard });
  } catch (e) {
    console.error('Leaderboard error:', e.message);
    res.status(500).json({ error: 'Could not fetch leaderboard.' });
  }
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`+ connected: ${socket.id}`);

  socket.on('auth', ({ userId, username }) => {
    sessions[socket.id] = { userId, username, roomCode: null, symbol: null };
    socket.emit('auth_ok', { socketId: socket.id });

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

  socket.on('make_move', async ({ index }) => {
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
        const winPlayer  = room.players[result.winner];
        const loseSym    = result.winner === 'X' ? 'O' : 'X';
        const losePlayer = room.players[loseSym];

        if (winPlayer?.userId  && winPlayer.userId  !== 'guest')
          User.findByIdAndUpdate(winPlayer.userId,  { $inc: { wins:   1 } }).catch(console.error);
        if (losePlayer?.userId && losePlayer.userId !== 'guest')
          User.findByIdAndUpdate(losePlayer.userId, { $inc: { losses: 1 } }).catch(console.error);
      } else {
        room.scores.D++;
        for (const sym of ['X', 'O']) {
          const p = room.players[sym];
          if (p?.userId && p.userId !== 'guest')
            User.findByIdAndUpdate(p.userId, { $inc: { draws: 1 } }).catch(console.error);
        }
      }

      io.to(session.roomCode).emit('move_made', { index, symbol: session.symbol, board: room.board });
      io.to(session.roomCode).emit('game_over', { winner: result.winner, line: result.line || null, scores: room.scores, round: room.round });
    } else {
      room.current = room.current === 'X' ? 'O' : 'X';
      io.to(session.roomCode).emit('move_made', { index, symbol: session.symbol, board: room.board, next: room.current });
    }
  });

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

  socket.on('chat_msg', ({ text }) => {
    const session = sessions[socket.id];
    if (!session?.roomCode || !text?.trim()) return;
    io.to(session.roomCode).emit('chat_msg', { username: session.username, symbol: session.symbol, text: text.trim().slice(0, 120) });
  });

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
  console.log(`\n🎮 TicXO running → http://localhost:${PORT}\n`);
});
