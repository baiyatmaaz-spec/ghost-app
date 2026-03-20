const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024
});

if (!fs.existsSync('./public/uploads')) {
  fs.mkdirSync('./public/uploads', { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './public/uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json());

// ── PERSISTENT ACCOUNT STORAGE ────────────────────────────────
const ACCOUNTS_FILE = './accounts.json';
const SESSIONS_FILE = './sessions.json';

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      const obj = JSON.parse(data);
      const map = new Map();
      for (const [key, value] of Object.entries(obj)) {
        map.set(key, value);
      }
      console.log('Loaded', map.size, 'accounts from disk');
      return map;
    }
  } catch (e) {
    console.error('Error loading accounts:', e);
  }
  return new Map();
}

function saveAccounts() {
  try {
    const obj = {};
    for (const [key, value] of accounts.entries()) {
      obj[key] = value;
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Error saving accounts:', e);
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const obj = JSON.parse(data);
      const map = new Map();
      for (const [key, value] of Object.entries(obj)) {
        map.set(key, value);
      }
      return map;
    }
  } catch (e) {
    console.error('Error loading sessions:', e);
  }
  return new Map();
}

function saveSessions() {
  try {
    const obj = {};
    for (const [key, value] of sessions.entries()) {
      obj[key] = value;
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Error saving sessions:', e);
  }
}

// Load accounts and sessions from disk on startup
const accounts = loadAccounts();
const sessions = loadSessions();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'ghost_salt_2024').digest('hex');
}

function createSession(email) {
  const token = uuidv4();
  sessions.set(token, email);
  saveSessions();
  return token;
}

function getAccountByToken(token) {
  const email = sessions.get(token);
  if (!email) return null;
  return accounts.get(email) || null;
}

// ── AUTH ENDPOINTS ────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { email, password, username, color, avatar } = req.body;

  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Email, password and username are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  if (accounts.has(email.toLowerCase())) {
    return res.status(400).json({ error: 'Email already registered — please sign in instead' });
  }

  for (const acc of accounts.values()) {
    if (acc.username.toLowerCase() === username.toLowerCase()) {
      return res.status(400).json({ error: 'Username already taken' });
    }
  }

  const account = {
    id: uuidv4(),
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    username,
    color: color || '#00ffcc',
    avatar: avatar || '👻',
    createdAt: Date.now()
  };

  accounts.set(email.toLowerCase(), account);
  saveAccounts(); // Save to disk immediately

  const token = createSession(email.toLowerCase());

  console.log('New account created:', username, email.toLowerCase());

  res.json({
    token,
    user: { username: account.username, color: account.color, avatar: account.avatar, id: account.id }
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const account = accounts.get(email.toLowerCase());

  if (!account) {
    return res.status(401).json({ error: 'No account found with that email. Please create an account first.' });
  }

  if (account.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = createSession(email.toLowerCase());

  console.log('Login:', account.username);

  res.json({
    token,
    user: { username: account.username, color: account.color, avatar: account.avatar, id: account.id }
  });
});

app.post('/verify', (req, res) => {
  const { token } = req.body;
  const account = getAccountByToken(token);
  if (!account) return res.status(401).json({ error: 'Invalid session' });
  res.json({
    user: { username: account.username, color: account.color, avatar: account.avatar, id: account.id }
  });
});

// ── FILE UPLOAD ───────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, type: req.file.mimetype });
});

// ── SOCKET ────────────────────────────────────────────────────
const users = new Map();
const messages = [];
const stories = [];

function getOnlineUsers() {
  return Array.from(users.values()).map(u => ({
    id: u.id, username: u.username, color: u.color, avatar: u.avatar, online: true
  }));
}

function broadcastUsers() {
  io.emit('users_update', getOnlineUsers());
}

io.on('connection', (socket) => {

  socket.on('join', ({ username, color, avatar }) => {
    const user = { id: socket.id, username, color: color || '#00ffcc', avatar: avatar || '👻', joinedAt: Date.now() };
    users.set(socket.id, user);
    socket.emit('init', {
      user,
      messages: messages.slice(-50),
      stories: stories.filter(s => Date.now() - s.createdAt < 24 * 60 * 60 * 1000),
      onlineUsers: getOnlineUsers()
    });
    io.emit('user_joined', user);
    broadcastUsers();
    io.emit('system_message', { id: uuidv4(), text: username + ' entered the ghost network', timestamp: Date.now() });
  });

  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    const msg = {
      id: uuidv4(), userId: socket.id, username: user.username,
      color: user.color, avatar: user.avatar, text: data.text || '',
      mediaUrl: data.mediaUrl || null, mediaType: data.mediaType || null,
      voiceUrl: data.voiceUrl || null, timestamp: Date.now(), type: data.type || 'text'
    };
    messages.push(msg);
    if (messages.length > 100) messages.shift();
    io.emit('new_message', msg);
  });

  socket.on('private_message', ({ toId, text, mediaUrl, mediaType, voiceUrl, type }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const msg = {
      id: uuidv4(), userId: socket.id, username: user.username,
      color: user.color, avatar: user.avatar, text: text || '',
      mediaUrl: mediaUrl || null, mediaType: mediaType || null,
      voiceUrl: voiceUrl || null, timestamp: Date.now(), type: type || 'text', private: true
    };
    socket.to(toId).emit('private_message', { ...msg, from: socket.id });
    socket.emit('private_message_sent', { ...msg, to: toId });
    socket.to(toId).emit('notification', {
      title: user.username,
      body: text || (type === 'voice' ? 'Sent a voice message' : type === 'image' ? 'Sent a photo' : 'New message'),
      from: socket.id, username: user.username
    });
  });

  socket.on('typing', ({ toId }) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (toId) socket.to(toId).emit('typing', { userId: socket.id, username: user.username });
    else socket.broadcast.emit('typing', { userId: socket.id, username: user.username });
  });

  socket.on('stop_typing', ({ toId }) => {
    if (toId) socket.to(toId).emit('stop_typing', { userId: socket.id });
    else socket.broadcast.emit('stop_typing', { userId: socket.id });
  });

  socket.on('post_story', ({ text, mediaUrl, mediaType, bg }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const story = {
      id: uuidv4(), userId: socket.id, username: user.username,
      color: user.color, avatar: user.avatar, text, mediaUrl: mediaUrl || null,
      mediaType: mediaType || null, bg: bg || user.color, createdAt: Date.now(), views: []
    };
    stories.push(story);
    io.emit('new_story', story);
  });

  socket.on('view_story', ({ storyId }) => {
    const story = stories.find(s => s.id === storyId);
    if (story && !story.views.includes(socket.id)) {
      story.views.push(socket.id);
      io.to(story.userId).emit('story_viewed', { storyId, viewerId: socket.id });
    }
  });

  socket.on('call_user', ({ toId, signal, callType }) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(toId).emit('incoming_call', {
      from: socket.id, username: user.username, color: user.color,
      avatar: user.avatar, signal, callType
    });
  });

  socket.on('answer_call', ({ toId, signal }) => {
    socket.to(toId).emit('call_answered', { signal, from: socket.id });
  });

  socket.on('reject_call', ({ toId }) => {
    const user = users.get(socket.id);
    socket.to(toId).emit('call_rejected', { from: socket.id, username: user ? user.username : 'Unknown' });
  });

  socket.on('end_call', ({ toId }) => {
    socket.to(toId).emit('call_ended', { from: socket.id });
  });

  socket.on('ice_candidate', ({ toId, candidate }) => {
    socket.to(toId).emit('ice_candidate', { candidate, from: socket.id });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      io.emit('user_left', { id: socket.id, username: user.username });
      io.emit('system_message', { id: uuidv4(), text: user.username + ' left the ghost network', timestamp: Date.now() });
      users.delete(socket.id);
      broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ghost running on port ' + PORT));
