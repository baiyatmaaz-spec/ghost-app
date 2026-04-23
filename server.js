const exress = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 50 * 1024 * 1024 });

if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './public/uploads/'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static('public'));
app.use(express.json());

// ── STORAGE ───────────────────────────────────────────────────
const ACCOUNTS_FILE = './accounts.json';
const SESSIONS_FILE = './sessions.json';

function loadJSON(file) {
  try {
    if (fs.existsSync(file)) {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const map = new Map();
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
      return map;
    }
  } catch (e) { console.error('Load error:', e); }
  return new Map();
}

function saveJSON(file, map) {
  try {
    const obj = {};
    for (const [k, v] of map.entries()) obj[k] = v;
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('Save error:', e); }
}

const accounts = loadJSON(ACCOUNTS_FILE);
const sessions = loadJSON(SESSIONS_FILE);

// accountId -> email lookup
const accountsById = new Map();
for (const [email, acc] of accounts.entries()) {
  accountsById.set(acc.id, email);
  if (!acc.friends) acc.friends = [];
  if (!acc.friendRequests) acc.friendRequests = [];
  if (!acc.offlineMessages) acc.offlineMessages = [];
}
console.log('Loaded', accounts.size, 'accounts');

function hashPwd(p) { return crypto.createHash('sha256').update(p + 'ghost_salt_2024').digest('hex'); }
function createSession(email) { const t = uuidv4(); sessions.set(t, email); saveJSON(SESSIONS_FILE, sessions); return t; }
function getAccountByToken(token) { const e = sessions.get(token); return e ? accounts.get(e) : null; }
function getAccountById(id) { const e = accountsById.get(id); return e ? accounts.get(e) : null; }

// ── AUTH ──────────────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { email, password, username, color, avatar } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (accounts.has(email.toLowerCase())) return res.status(400).json({ error: 'Email already registered — sign in instead' });
  for (const acc of accounts.values()) {
    if (acc.username.toLowerCase() === username.toLowerCase()) return res.status(400).json({ error: 'Username already taken' });
  }
  const account = {
    id: uuidv4(), email: email.toLowerCase(), passwordHash: hashPwd(password),
    username, color: color || '#00ffcc', avatar: avatar || '👻', createdAt: Date.now(),
    friends: [], friendRequests: [], offlineMessages: []
  };
  accounts.set(email.toLowerCase(), account);
  accountsById.set(account.id, email.toLowerCase());
  saveJSON(ACCOUNTS_FILE, accounts);
  const token = createSession(email.toLowerCase());
  res.json({ token, user: { id: account.id, username: account.username, color: account.color, avatar: account.avatar } });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const acc = accounts.get(email.toLowerCase());
  if (!acc) return res.status(401).json({ error: 'No account found with that email. Create an account first.' });
  if (acc.passwordHash !== hashPwd(password)) return res.status(401).json({ error: 'Wrong password' });
  const token = createSession(email.toLowerCase());
  res.json({ token, user: { id: acc.id, username: acc.username, color: acc.color, avatar: acc.avatar } });
});

app.post('/verify', (req, res) => {
  const acc = getAccountByToken(req.body.token);
  if (!acc) return res.status(401).json({ error: 'Invalid session' });
  res.json({ user: { id: acc.id, username: acc.username, color: acc.color, avatar: acc.avatar } });
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, type: req.file.mimetype });
});

// ── RUNTIME ───────────────────────────────────────────────────
const users = new Map();
const messages = [];
const stories = [];
const userLocations = new Map();
const socketToAccountId = new Map();
const accountIdToSocketId = new Map();

function getOnlineUsers() {
  return Array.from(users.values()).map(u => ({ id: u.id, accountId: u.accountId, username: u.username, color: u.color, avatar: u.avatar }));
}

function getFriendsList(account) {
  return (account.friends || []).map(fId => {
    const f = getAccountById(fId);
    if (!f) return null;
    const sid = accountIdToSocketId.get(fId);
    return { accountId: f.id, username: f.username, avatar: f.avatar, color: f.color, online: !!sid, socketId: sid || null };
  }).filter(Boolean);
}

io.on('connection', (socket) => {

  socket.on('join', ({ username, color, avatar, accountId }) => {
    if (accountId) { socketToAccountId.set(socket.id, accountId); accountIdToSocketId.set(accountId, socket.id); }
    const user = { id: socket.id, accountId: accountId || null, username, color: color || '#00ffcc', avatar: avatar || '👻', joinedAt: Date.now() };
    users.set(socket.id, user);

    const account = accountId ? getAccountById(accountId) : null;
    const offlineMsgs = account ? [...account.offlineMessages] : [];

    if (account && account.offlineMessages.length > 0) {
      account.offlineMessages = [];
      saveJSON(ACCOUNTS_FILE, accounts);
    }

    socket.emit('init', {
      user,
      messages: messages.slice(-50),
      stories: stories.filter(s => Date.now() - s.createdAt < 86400000),
      onlineUsers: getOnlineUsers(),
      locations: Array.from(userLocations.values()),
      friends: account ? getFriendsList(account) : [],
      friendRequests: account ? account.friendRequests : [],
      offlineMessages: offlineMsgs
    });

    // Tell friends this user is now online
    if (account) {
      account.friends.forEach(fId => {
        const fSid = accountIdToSocketId.get(fId);
        if (fSid) io.to(fSid).emit('friend_came_online', { accountId, username, avatar, color, socketId: socket.id });
      });
    }

    io.emit('users_update', getOnlineUsers());
    io.emit('system_message', { id: uuidv4(), text: username + ' entered the ghost network', timestamp: Date.now() });
  });

  // ── FRIEND REQUESTS ───────────────────────────────────────
  socket.on('send_friend_request', ({ toSocketId }) => {
    const fromId = socketToAccountId.get(socket.id);
    const toId = socketToAccountId.get(toSocketId);
    if (!fromId || !toId || fromId === toId) return;
    const fromAcc = getAccountById(fromId);
    const toAcc = getAccountById(toId);
    if (!fromAcc || !toAcc) return;
    if (fromAcc.friends.includes(toId)) return;
    if (toAcc.friendRequests.find(r => r.fromAccountId === fromId)) return;
    const req = { id: uuidv4(), fromAccountId: fromId, fromUsername: fromAcc.username, fromAvatar: fromAcc.avatar, fromColor: fromAcc.color, timestamp: Date.now() };
    toAcc.friendRequests.push(req);
    saveJSON(ACCOUNTS_FILE, accounts);
    socket.to(toSocketId).emit('friend_request_received', req);
    socket.emit('friend_request_sent', { toAccountId: toId, toUsername: toAcc.username });
  });

  socket.on('accept_friend_request', ({ requestId, fromAccountId }) => {
    const myId = socketToAccountId.get(socket.id);
    if (!myId) return;
    const myAcc = getAccountById(myId);
    const fromAcc = getAccountById(fromAccountId);
    if (!myAcc || !fromAcc) return;
    myAcc.friendRequests = myAcc.friendRequests.filter(r => r.id !== requestId);
    if (!myAcc.friends.includes(fromAccountId)) myAcc.friends.push(fromAccountId);
    if (!fromAcc.friends.includes(myId)) fromAcc.friends.push(myId);
    saveJSON(ACCOUNTS_FILE, accounts);
    const fromSid = accountIdToSocketId.get(fromAccountId);
    if (fromSid) {
      io.to(fromSid).emit('friend_accepted', { accountId: myId, username: myAcc.username, avatar: myAcc.avatar, color: myAcc.color, socketId: socket.id });
    }
    socket.emit('friends_update', getFriendsList(myAcc));
    socket.emit('friend_requests_update', myAcc.friendRequests);
  });

  socket.on('decline_friend_request', ({ requestId }) => {
    const myId = socketToAccountId.get(socket.id);
    if (!myId) return;
    const myAcc = getAccountById(myId);
    if (!myAcc) return;
    myAcc.friendRequests = myAcc.friendRequests.filter(r => r.id !== requestId);
    saveJSON(ACCOUNTS_FILE, accounts);
    socket.emit('friend_requests_update', myAcc.friendRequests);
  });

  socket.on('remove_friend', ({ friendAccountId }) => {
    const myId = socketToAccountId.get(socket.id);
    if (!myId) return;
    const myAcc = getAccountById(myId);
    const friendAcc = getAccountById(friendAccountId);
    if (!myAcc) return;
    myAcc.friends = myAcc.friends.filter(id => id !== friendAccountId);
    if (friendAcc) friendAcc.friends = friendAcc.friends.filter(id => id !== myId);
    saveJSON(ACCOUNTS_FILE, accounts);
    socket.emit('friends_update', getFriendsList(myAcc));
  });

  // ── MESSAGES ─────────────────────────────────────────────
  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    const msg = { id: uuidv4(), userId: socket.id, username: user.username, color: user.color, avatar: user.avatar, text: data.text || '', mediaUrl: data.mediaUrl || null, mediaType: data.mediaType || null, voiceUrl: data.voiceUrl || null, timestamp: Date.now(), type: data.type || 'text' };
    messages.push(msg);
    if (messages.length > 100) messages.shift();
    io.emit('new_message', msg);
  });

  socket.on('private_message', ({ toAccountId, text, mediaUrl, mediaType, voiceUrl, type }) => {
    const fromId = socketToAccountId.get(socket.id);
    const user = users.get(socket.id);
    if (!user) return;
    const msg = { id: uuidv4(), fromAccountId: fromId, toAccountId, userId: socket.id, username: user.username, color: user.color, avatar: user.avatar, text: text || '', mediaUrl: mediaUrl || null, mediaType: mediaType || null, voiceUrl: voiceUrl || null, timestamp: Date.now(), type: type || 'text', private: true };
    const recipientSid = accountIdToSocketId.get(toAccountId);
    if (recipientSid && users.has(recipientSid)) {
      socket.to(recipientSid).emit('private_message', { ...msg, from: socket.id });
      socket.to(recipientSid).emit('notification', { title: user.username, body: text || (type === 'voice' ? 'Voice message' : type === 'image' ? 'Photo' : type === 'video' ? 'Video' : 'New message'), from: socket.id, fromAccountId: fromId, username: user.username });
    } else {
      const recipientAcc = getAccountById(toAccountId);
      if (recipientAcc) {
        if (!recipientAcc.offlineMessages) recipientAcc.offlineMessages = [];
        recipientAcc.offlineMessages.push(msg);
        if (recipientAcc.offlineMessages.length > 200) recipientAcc.offlineMessages.shift();
        saveJSON(ACCOUNTS_FILE, accounts);
      }
    }
    socket.emit('private_message_sent', { ...msg });
  });

  socket.on('typing', ({ toAccountId }) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (toAccountId) { const sid = accountIdToSocketId.get(toAccountId); if (sid) socket.to(sid).emit('typing', { userId: socket.id, username: user.username }); }
    else socket.broadcast.emit('typing', { userId: socket.id, username: user.username });
  });

  socket.on('stop_typing', ({ toAccountId }) => {
    if (toAccountId) { const sid = accountIdToSocketId.get(toAccountId); if (sid) socket.to(sid).emit('stop_typing', { userId: socket.id }); }
    else socket.broadcast.emit('stop_typing', { userId: socket.id });
  });

  // ── LOCATION ─────────────────────────────────────────────
  socket.on('share_location', ({ lat, lng }) => {
    const user = users.get(socket.id);
    if (!user) return;
    userLocations.set(socket.id, { id: socket.id, lat, lng, username: user.username, avatar: user.avatar, color: user.color, timestamp: Date.now() });
    io.emit('locations_update', Array.from(userLocations.values()));
  });

  socket.on('stop_sharing_location', () => { userLocations.delete(socket.id); io.emit('locations_update', Array.from(userLocations.values())); });

  // ── STORIES ───────────────────────────────────────────────
  socket.on('post_story', ({ text, mediaUrl, mediaType, bg }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const story = { id: uuidv4(), userId: socket.id, username: user.username, color: user.color, avatar: user.avatar, text, mediaUrl: mediaUrl || null, mediaType: mediaType || null, bg: bg || user.color, createdAt: Date.now(), views: [] };
    stories.push(story);
    io.emit('new_story', story);
  });

  socket.on('view_story', ({ storyId }) => { const s = stories.find(s => s.id === storyId); if (s && !s.views.includes(socket.id)) s.views.push(socket.id); });

  // ── CALLS ─────────────────────────────────────────────────
  socket.on('call_user', ({ toAccountId, signal, callType }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const sid = accountIdToSocketId.get(toAccountId);
    if (!sid) return;
    socket.to(sid).emit('incoming_call', { from: socket.id, username: user.username, color: user.color, avatar: user.avatar, signal, callType });
  });

  socket.on('answer_call', ({ toId, signal }) => { socket.to(toId).emit('call_answered', { signal, from: socket.id }); });
  socket.on('reject_call', ({ toId }) => { const u = users.get(socket.id); socket.to(toId).emit('call_rejected', { from: socket.id, username: u ? u.username : '' }); });
  socket.on('end_call', ({ toId }) => { socket.to(toId).emit('call_ended', { from: socket.id }); });
  socket.on('ice_candidate', ({ toId, candidate }) => { socket.to(toId).emit('ice_candidate', { candidate, from: socket.id }); });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    const accountId = socketToAccountId.get(socket.id);
    if (user) {
      io.emit('system_message', { id: uuidv4(), text: user.username + ' left the ghost network', timestamp: Date.now() });
      users.delete(socket.id);
      userLocations.delete(socket.id);
      io.emit('users_update', getOnlineUsers());
      io.emit('locations_update', Array.from(userLocations.values()));
    }
    if (accountId) {
      socketToAccountId.delete(socket.id);
      accountIdToSocketId.delete(accountId);
      const acc = getAccountById(accountId);
      if (acc) {
        acc.friends.forEach(fId => {
          const fSid = accountIdToSocketId.get(fId);
          if (fSid) io.to(fSid).emit('friend_went_offline', { accountId });
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ghost running on port ' + PORT));
