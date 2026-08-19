const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Multer – we'll keep it but note that uploads won't persist on Vercel
const multer = require('multer');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || 'hyssop-super-secret-key-change-in-production';
const SALT_ROUNDS = 10;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// IN-MEMORY DATA (no file persistence)
// ============================================================
let newsData = [];
let subscribersData = [];
let users = [];

// ============================================================
// FIND FRONTEND FOLDER
// ============================================================
const backendDir = __dirname;
const frontendDir = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(frontendDir)) {
  console.log('✅ Found frontend at:', frontendDir);
  app.use(express.static(frontendDir));
}
app.use(express.static(backendDir));

// ============================================================
// IMAGE UPLOAD SETUP – DISABLED ON VERCEL (ephemeral)
// ============================================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) { /* ignore */ }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'news-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg'];
  cb(null, allowed.includes(file.mimetype));
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter
});

// ============================================================
// CREATE DEFAULT ADMIN (in-memory)
// ============================================================
(async function createDefaultAdmin() {
  const adminExists = users.find(u => u.email === 'admin@hyssop.com');
  if (!adminExists) {
    const hashedPassword = await bcrypt.hash('admin123', SALT_ROUNDS);
    users.push({
      id: uuidv4(),
      email: 'admin@hyssop.com',
      password: hashedPassword,
      name: 'Administrator',
      role: 'admin',
      created_at: new Date().toISOString()
    });
    console.log('👤 Default admin created (in‑memory)');
  }
})();

// ============================================================
// WEBSOCKET BROADCAST – DISABLED (just logs)
// ============================================================
function broadcast(data) {
  console.log('📡 Broadcast (disabled on Vercel):', data.type);
}

// ============================================================
// JWT AUTH MIDDLEWARE
// ============================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token.' });
    req.user = user;
    next();
  });
}

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/test-broadcast', (req, res) => {
  broadcast({ type: 'test', data: { message: 'Test broadcast (disabled on Vercel)' } });
  res.json({ success: true, message: 'Broadcast triggered (but WebSocket inactive)' });
});

// --- Auth routes ---
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User already exists' });
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = {
      id: uuidv4(),
      email,
      password: hashedPassword,
      name: name || email.split('@')[0],
      role: 'admin',
      created_at: new Date().toISOString()
    };
    users.push(newUser);
    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ success: true, token, user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/verify', authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// --- Public routes ---
app.get('/api/news', (req, res) => res.json(newsData));
app.get('/api/news/:id', (req, res) => {
  const item = newsData.find(n => n.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

app.post('/api/subscribers', (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (subscribersData.some(s => s.email === email)) return res.status(400).json({ error: 'Already subscribed' });
  const newSub = { id: uuidv4(), email, name: name || '', date: new Date().toISOString() };
  subscribersData.push(newSub);
  broadcast({ type: 'subscriber_added', data: newSub });
  res.json({ success: true, data: newSub });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayNews = newsData.filter(n => n.date === today).length;
  const todaySubs = subscribersData.filter(s => s.date.split('T')[0] === today).length;
  res.json({
    totalNews: newsData.length,
    totalSubscribers: subscribersData.length,
    todayNews,
    todaySubscribers: todaySubs,
    latestNews: newsData.length > 0 ? newsData[0] : null
  });
});

// --- Protected routes ---
app.post('/api/news', authenticateToken, upload.single('image'), (req, res) => {
  if (req.file) {
    console.warn('⚠️ File upload attempted on Vercel – will not persist.');
  }
  const title = req.body.title?.trim() || '';
  const description = req.body.description?.trim() || '';
  if (!title || !description) return res.status(400).json({ error: 'Title and description required' });
  const newNews = {
    id: uuidv4(),
    title,
    description,
    date: req.body.date || new Date().toISOString().split('T')[0],
    time: req.body.time || '',
    location: req.body.location || '',
    tag: req.body.tag || 'General',
    image: req.file ? '/uploads/' + req.file.filename : '',
    created_by: req.user.email,
    created_at: new Date().toISOString()
  };
  newsData.unshift(newNews);
  broadcast({ type: 'news_created', data: newNews });
  res.json({ success: true, data: newNews });
});

app.put('/api/news/:id', authenticateToken, upload.single('image'), (req, res) => {
  const index = newsData.findIndex(n => n.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const title = req.body.title?.trim() || newsData[index].title;
  const description = req.body.description?.trim() || newsData[index].description;
  newsData[index] = {
    ...newsData[index],
    title,
    description,
    date: req.body.date || newsData[index].date,
    time: req.body.time || newsData[index].time,
    location: req.body.location || newsData[index].location,
    tag: req.body.tag || newsData[index].tag,
    image: req.file ? '/uploads/' + req.file.filename : newsData[index].image,
    updated_by: req.user.email,
    updated_at: new Date().toISOString()
  };
  broadcast({ type: 'news_updated', data: newsData[index] });
  res.json({ success: true, data: newsData[index] });
});

app.delete('/api/news/:id', authenticateToken, (req, res) => {
  const index = newsData.findIndex(n => n.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  newsData.splice(index, 1);
  broadcast({ type: 'news_deleted', data: { id: req.params.id } });
  res.json({ success: true });
});

app.get('/api/subscribers', authenticateToken, (req, res) => res.json(subscribersData));
app.delete('/api/subscribers/:id', authenticateToken, (req, res) => {
  const index = subscribersData.findIndex(s => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  subscribersData.splice(index, 1);
  res.json({ success: true });
});

// ============================================================
// SERVE HTML FILES
// ============================================================
function findFile(filename) {
  const backendFile = path.join(backendDir, filename);
  if (fs.existsSync(backendFile)) return backendFile;
  if (frontendDir && fs.existsSync(frontendDir)) {
    const frontendFile = path.join(frontendDir, filename);
    if (fs.existsSync(frontendFile)) return frontendFile;
  }
  return null;
}

app.get('/', (req, res) => {
  const file = findFile('index.html');
  file ? res.sendFile(file) : res.status(404).send('index.html not found');
});
app.get('/dashboard', (req, res) => {
  const file = findFile('dashboard.html');
  file ? res.sendFile(file) : res.status(404).send('dashboard.html not found');
});
app.get('/login', (req, res) => {
  const file = findFile('login.html');
  file ? res.sendFile(file) : res.status(404).send('login.html not found');
});

// ============================================================
// EXPORT FOR VERCEL
// ============================================================
module.exports = app;