/**
 * TicXO — Production-ready server
 * Works locally AND on Railway, Render, Heroku, Fly.io etc.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
// On cloud hosts, PORT is set automatically by the platform.
// Locally it defaults to 3000.
const PORT = process.env.PORT || 3000;

// Use /tmp for data on cloud (writable), local ./data folder otherwise
const IS_CLOUD = !!process.env.RAILWAY_ENVIRONMENT ||
                 !!process.env.RENDER               ||
                 !!process.env.DYNO;                 // Heroku

const DATA_DIR  = IS_CLOUD ? '/tmp' : path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'users.json');

// ─── App setup ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Keep connections alive through cloud proxies
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check — required by Railway/Render to confirm the app is running
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
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

// ─── In-memory game state ─────────────────────────────────────────────────────
const rooms    = {};   // { [code]: room }
const sessions = {};   // { [socketId]: session }

function makeRoom(code, p1) {
  return {
    code,
    players:       { X: p1, O: null },
    board:         Array(9).fill(null),
    current:       'X',
    gameOver:      false,
    scores:        { X: 0, O: 0, D: 0 },
    round:         1,
    rematchVotes:  new Set()
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

// ─── REST: Auth ───────────────────────────────────────────────────────────────
app.post('/api/signup', (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const db  = loadDB();
  const key = username.toLowerCase().trim();

  if (db.users[key])
    return res.status(409).json({ error: 'Username already taken' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  db.users[key] = {
    username:  username.trim(),
    password:  hash,
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

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Fill in all fields' });

  const db   = loadDB();
  const key  = username.toLowerCase().trim();
  const user = db.users[key];

  if (!user)
    return res.status(401).json({ error: 'User not found' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (user.password !== hash)
    return res.status(401).json({ error: 'Wrong password' });

  const { password: _, ...safe } = user;
  res.json({ user: { ...safe, id: key } });
});

app.get('/api/leaderboard', (_req, res) => {
  const db    = loadDB();
  const board = Object.entries(db.users)
    .map(([id, u]) => ({
      id,
      username: u.username,
      avatar:   u.avatar,
      wins:     u.wins,
      losses:   u.losses,
      draws:    u.draws
    }))
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
  });

  // ── Create room ──
  socket.on('create_room', ({ userId, username }) => {
    const session = sessions[socket.id] || {};
    Object.assign(session, { userId, username });
    sessions[socket.id] = session;

    let code;
    do { code = Math.random().toString(36).substring(2,6).toUpperCase(); }
    while (rooms[code]);

    const room = makeRoom(code, { socketId: socket.id, userId, username });
    rooms[code] = room;

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
        const db         = loadDB();
        const winSym     = result.winner;
        const loseSym    = winSym === 'X' ? 'O' : 'X';
        const winPlayer  = room.players[winSym];
        const losePlayer = room.players[loseSym];
        if (winPlayer?.userId  && db.users[winPlayer.userId])  db.users[winPlayer.userId].wins++;
        if (losePlayer?.userId && db.users[losePlayer.userId]) db.users[losePlayer.userId].losses++;
        saveDB(db);
      } else {
        room.scores.D++;
        const db = loadDB();
        for (const sym of ['X','O']) {
          const p = room.players[sym];
          if (p?.userId && db.users[p.userId]) db.users[p.userId].draws++;
        }
        saveDB(db);
      }

      io.to(session.roomCode).emit('move_made', {
        index, symbol: session.symbol, board: room.board
      });
      io.to(session.roomCode).emit('game_over', {
        winner: result.winner,
        line:   result.line || null,
        scores: room.scores,
        round:  room.round
      });

    } else {
      room.current = room.current === 'X' ? 'O' : 'X';
      io.to(session.roomCode).emit('move_made', {
        index, symbol: session.symbol,
        board: room.board, next: room.current
      });
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
      room.board        = Array(9).fill(null);
      room.current      = 'X';
      room.gameOver     = false;
      room.round++;
      room.rematchVotes.clear();
      io.to(session.roomCode).emit('rematch_start', {
        round: room.round, current: 'X', scores: room.scores
      });
    }
  });

  // ── Chat ──
  socket.on('chat_msg', ({ text }) => {
    const session = sessions[socket.id];
    if (!session?.roomCode || !text?.trim()) return;
    io.to(session.roomCode).emit('chat_msg', {
      username: session.username,
      symbol:   session.symbol,
      text:     text.trim().slice(0, 120)
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const session = sessions[socket.id];
    console.log(`- disconnected: ${socket.id}`);

    if (session?.roomCode) {
      io.to(session.roomCode).emit('opponent_left', { username: session.username });
      const room = rooms[session.roomCode];
      if (room) {
        const otherSym    = session.symbol === 'X' ? 'O' : 'X';
        const otherPlayer = room.players[otherSym];
        if (!otherPlayer || !io.sockets.sockets.get(otherPlayer.socketId)) {
          delete rooms[session.roomCode];
          console.log(`Room ${session.roomCode} deleted (empty)`);
        }
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
