# TicXO — Online Multiplayer Tic-Tac-Toe

A full-stack real-time Tic-Tac-Toe game with user accounts, online multiplayer, score tracking, and a global leaderboard.

---

## ✨ Features

| Feature | Details |
|---|---|
| **User Accounts** | Sign up with username, password & avatar emoji |
| **Online Multiplayer** | Real-time via Socket.IO — play on different devices |
| **Room Codes** | Player 1 creates a room → gets a 4-letter code → Player 2 joins |
| **Live Chat** | In-game chat during online matches |
| **AI Opponent** | Easy / Medium / Unbeatable (Minimax) |
| **Score Tracking** | Wins / Losses / Draws saved to JSON (swap to DB for production) |
| **Leaderboard** | Global top-20 ranked by wins |
| **Profile Page** | Personal stats + win rate |
| **Endless Mode** | Local play auto-resets on draw |
| **Undo** | Take back moves in local/AI mode |
| **Dark UI** | Responsive, mobile-friendly design |

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) **v18+**
- npm (comes with Node)

### 2. Install & Run

```bash
# Clone or unzip the project
cd tictactoe-online

# Install dependencies
npm install

# Start the server
npm start
```

Open your browser at **http://localhost:3000**

### 3. Play Online (Two Devices)

1. Both players open the app and sign in
2. Player 1 → **Online Multiplayer** → **Create Room** → shares the 4-letter code
3. Player 2 → **Online Multiplayer** → **Join Room** → enters the code
4. Game starts automatically!

---

## 📁 Project Structure

```
tictactoe-online/
├── server.js          # Express + Socket.IO backend
├── package.json
├── data/
│   └── users.json     # Auto-created: stores accounts & scores
└── public/
    └── index.html     # Single-file frontend (HTML + CSS + JS)
```

---

## 🔧 Development Mode (Auto-restart)

```bash
npm run dev
```

This uses `nodemon` to auto-restart the server when you edit `server.js`.

---

## 🌐 Deployment

### Option A: Railway (Easiest)
1. Push to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set `PORT` environment variable if needed (Railway auto-detects it)

### Option B: Render
1. Push to GitHub
2. New Web Service on [render.com](https://render.com)
3. Build command: `npm install`  
4. Start command: `npm start`

### Option C: Heroku
```bash
heroku create your-app-name
git push heroku main
```

### Option D: Fly.io
```bash
fly launch
fly deploy
```

> **Important for deployment:** The `data/users.json` file is ephemeral on most platforms (resets on restart). For production, use a real database (see below).

---

## 🗄️ Upgrading to a Real Database

The default setup uses a local JSON file for simplicity. For production:

### Firebase Firestore

1. Install: `npm install firebase-admin`
2. Create a Firebase project → Service Account → download JSON key
3. Replace the `loadDB()` / `saveDB()` functions in `server.js`:

```js
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();

// Get user
const doc = await db.collection('users').doc(userId).get();
const user = doc.exists ? doc.data() : null;

// Save user
await db.collection('users').doc(userId).set(userData, { merge: true });
```

### MongoDB (Atlas)

1. Install: `npm install mongoose`
2. Add `MONGODB_URI` to your environment variables
3. Define a User schema and replace JSON file calls with Mongoose queries

```js
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI);

const User = mongoose.model('User', {
  username: String, password: String, avatar: String,
  wins: Number, losses: Number, draws: Number, createdAt: Date
});
```

---

## 🔐 Security Notes

Passwords are currently stored as **SHA-256 hashes**. For production:

```bash
npm install bcrypt
```

Replace the hash logic in `server.js`:

```js
const bcrypt = require('bcrypt');

// Signup
const hash = await bcrypt.hash(password, 12);

// Login
const match = await bcrypt.compare(password, storedHash);
```

---

## 🌍 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `MONGODB_URI` | — | MongoDB connection string (if using Mongo) |

---

## 🎮 Gameplay Rules

1. Players alternate placing X or O on the 3×3 grid
2. First to get 3 in a row (horizontal, vertical, diagonal) wins
3. If the board fills with no winner → draw (board auto-resets in Endless mode)
4. Scores accumulate across rounds until you exit

---

## 🛠️ Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML5 + CSS3 + Vanilla JS |
| Backend | Node.js + Express |
| Real-time | Socket.IO v4 |
| Storage | JSON file (swap for Firebase / MongoDB) |
| Fonts | Google Fonts (Outfit + JetBrains Mono) |

---

## 🗺️ Roadmap / Ideas

- [ ] Spectator mode
- [ ] Tournament brackets
- [ ] 5×5 board variant
- [ ] Emoji reactions during game
- [ ] Push notifications for game invites
- [ ] OAuth login (Google / GitHub)
- [ ] Head-to-head history between two players
- [ ] Mobile app (React Native or PWA)

---

## 📄 License

MIT — free to use, modify, and distribute.
