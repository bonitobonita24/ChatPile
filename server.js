const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const db = require('./db');

let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const app = express();
const PORT = Number(process.env.PORT || 4173);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEFAULT_SESSION_SECRET = 'replace-this-session-secret-in-production';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : IS_PRODUCTION;
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_LOCK_BASE_MS = 30 * 1000;
const LOGIN_LOCK_MAX_MS = 10 * 60 * 1000;
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const AUTH_DIR = path.join(process.cwd(), '.auth');
const USERS_FILE = path.join(AUTH_DIR, 'users.json');
const LEGACY_CREDS_FILE = path.join(AUTH_DIR, 'credentials.json');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'noreply@localhost';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const INITIAL_ADMIN_EMAIL = process.env.APP_ADMIN_EMAIL || 'admin@localhost';
const INITIAL_ADMIN_USERNAME = process.env.APP_ADMIN_USERNAME || 'admin';

if (IS_PRODUCTION && SESSION_SECRET === DEFAULT_SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

// In-memory stores
const loginAttemptsByIp = new Map();
const pendingVerifications = new Map(); // email → { code, username, salt, hash, expires }
const passwordResetTokens = new Map(); // token → { email, expires }

// ─── Express setup ────────────────────────────────────────────────────────────

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(session({
  name: 'ai_chats_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    maxAge: SESSION_TTL_MS,
  },
}));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowLocalOrigin = typeof origin === 'string'
    && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

  if (allowLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }

  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function getLockState(ip) {
  const current = loginAttemptsByIp.get(ip) || { failedCount: 0, lockUntil: 0 };
  const remainingMs = current.lockUntil - Date.now();
  return { ...current, locked: remainingMs > 0, lockedForSeconds: Math.ceil(Math.max(0, remainingMs) / 1000) };
}

function registerFailedAttempt(ip) {
  const current = loginAttemptsByIp.get(ip) || { failedCount: 0, lockUntil: 0 };
  const failedCount = current.failedCount + 1;
  let lockUntil = 0;
  if (failedCount >= 3) {
    const exponent = Math.max(0, failedCount - 3);
    const delay = Math.min(LOGIN_LOCK_MAX_MS, LOGIN_LOCK_BASE_MS * Math.pow(2, exponent));
    lockUntil = Date.now() + delay;
  }
  loginAttemptsByIp.set(ip, { failedCount, lockUntil });
}

function clearAttempts(ip) {
  loginAttemptsByIp.delete(ip);
}

// ─── Password helpers ─────────────────────────────────────────────────────────

function derivePasswordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) { reject(error); return; }
      resolve(key.toString('hex'));
    });
  });
}

function constantTimeEqualHex(leftHex, rightHex) {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function verifyPassword(password, user) {
  const hash = await derivePasswordHash(password, user.salt);
  return constantTimeEqualHex(hash, user.hash);
}

// ─── User store ───────────────────────────────────────────────────────────────

async function loadUsers() {
  await ensureAuthStore();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  return JSON.parse(raw);
}

async function saveUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function findByEmail(users, email) {
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}

function findByApiKey(users, apiKey) {
  return users.find((u) => u.apiKey === apiKey && u.verified) ?? null;
}

async function ensureAuthStore() {
  await fs.mkdir(AUTH_DIR, { recursive: true });

  try {
    await fs.access(USERS_FILE);
    return;
  } catch {
    // users.json doesn't exist — check for legacy credentials.json
  }

  let legacyAdmin = null;
  try {
    const raw = await fs.readFile(LEGACY_CREDS_FILE, 'utf8');
    legacyAdmin = JSON.parse(raw);
  } catch {
    // no legacy file
  }

  if (legacyAdmin) {
    const adminUser = {
      id: crypto.randomUUID(),
      email: INITIAL_ADMIN_EMAIL,
      username: legacyAdmin.username ?? INITIAL_ADMIN_USERNAME,
      salt: legacyAdmin.salt,
      hash: legacyAdmin.hash,
      verified: true,
      role: 'admin',
      apiKey: db.generateApiKey(),
      createdAt: legacyAdmin.changedAt ?? new Date().toISOString(),
      changedAt: legacyAdmin.changedAt ?? new Date().toISOString(),
    };
    await saveUsers([adminUser]);
    console.log(`Migrated credentials.json → users.json (admin: ${adminUser.email})`);
    return;
  }

  const initialPassword = process.env.APP_ADMIN_PASSWORD;
  if (!initialPassword) {
    console.error('APP_ADMIN_PASSWORD must be set to seed the initial admin account.');
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await derivePasswordHash(initialPassword, salt);
  const adminUser = {
    id: crypto.randomUUID(),
    email: INITIAL_ADMIN_EMAIL,
    username: INITIAL_ADMIN_USERNAME,
    salt,
    hash,
    verified: true,
    role: 'admin',
    apiKey: db.generateApiKey(),
    createdAt: new Date().toISOString(),
    changedAt: new Date().toISOString(),
  };
  await saveUsers([adminUser]);
}

// ─── Email helper ─────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, text }) {
  if (!nodemailer || !SMTP_HOST) {
    console.log(`\n[EMAIL - no SMTP configured]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({ from: SMTP_FROM, to, subject, text });
}

function generateVerificationCode() {
  return String(crypto.randomInt(100000, 999999));
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

app.get('/api/auth/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.user),
    email: req.session?.user?.email || null,
    username: req.session?.user?.username || null,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const ip = getClientIp(req);
  const lock = getLockState(ip);
  if (lock.locked) {
    res.status(429).json({ ok: false, error: 'Too many failed attempts.', lockedForSeconds: lock.lockedForSeconds });
    return;
  }

  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid login payload.' });
    return;
  }

  try {
    const users = await loadUsers();
    const user = findByEmail(users, email.trim());

    const fail = () => {
      registerFailedAttempt(ip);
      const state = getLockState(ip);
      res.status(401).json({
        ok: false,
        error: 'Invalid credentials.',
        lockedForSeconds: state.locked ? state.lockedForSeconds : 0,
      });
    };

    if (!user || !user.verified) { fail(); return; }

    const valid = await verifyPassword(password, user);
    if (!valid) { fail(); return; }

    clearAttempts(ip);
    req.session.user = { userId: user.id, email: user.email, username: user.username };
    res.json({ ok: true, email: user.email, username: user.username });
  } catch {
    res.status(500).json({ ok: false, error: 'Authentication failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ai_chats_sid');
    res.json({ ok: true });
  });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body || {};

  if (typeof email !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid payload.' });
    return;
  }

  const emailNorm = email.trim().toLowerCase();
  const usernameTrim = username.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    res.status(400).json({ ok: false, error: 'Invalid email address.' });
    return;
  }

  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(usernameTrim)) {
    res.status(400).json({ ok: false, error: 'Username must be 3–30 characters (letters, numbers, _ or -).' });
    return;
  }

  if (password.length < 12) {
    res.status(400).json({ ok: false, error: 'Password must be at least 12 characters.' });
    return;
  }

  try {
    const users = await loadUsers();
    const existing = findByEmail(users, emailNorm);

    if (existing && existing.verified) {
      // Don't reveal that the account exists — respond as if successful
      res.json({ ok: true });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await derivePasswordHash(password, salt);
    const code = generateVerificationCode();

    pendingVerifications.set(emailNorm, {
      code,
      username: usernameTrim,
      salt,
      hash,
      expires: Date.now() + VERIFICATION_TTL_MS,
    });

    await sendEmail({
      to: emailNorm,
      subject: 'Your AI Chats verification code',
      text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you did not register for AI Chats, ignore this email.`,
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  const { email, code } = req.body || {};

  if (typeof email !== 'string' || typeof code !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid payload.' });
    return;
  }

  const emailNorm = email.trim().toLowerCase();
  const pending = pendingVerifications.get(emailNorm);

  if (!pending || pending.expires < Date.now()) {
    pendingVerifications.delete(emailNorm);
    res.status(400).json({ ok: false, error: 'Verification code expired or not found. Please register again.' });
    return;
  }

  if (pending.code !== code.trim()) {
    res.status(400).json({ ok: false, error: 'Incorrect verification code.' });
    return;
  }

  try {
    const users = await loadUsers();
    // Remove any unverified entry for this email, then add the verified user
    const filtered = users.filter((u) => u.email.toLowerCase() !== emailNorm || u.verified);
    const newUser = {
      id: crypto.randomUUID(),
      email: emailNorm,
      username: pending.username,
      salt: pending.salt,
      hash: pending.hash,
      verified: true,
      role: 'user',
      apiKey: db.generateApiKey(),
      createdAt: new Date().toISOString(),
      changedAt: new Date().toISOString(),
    };
    filtered.push(newUser);
    await saveUsers(filtered);
    pendingVerifications.delete(emailNorm);

    req.session.user = { userId: newUser.id, email: newUser.email, username: newUser.username };
    res.json({ ok: true, email: newUser.email, username: newUser.username });
  } catch {
    res.status(500).json({ ok: false, error: 'Verification failed. Please try again.' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body || {};

  if (typeof email !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid payload.' });
    return;
  }

  const emailNorm = email.trim().toLowerCase();
  const pending = pendingVerifications.get(emailNorm);

  // Always respond with ok — don't reveal if email is pending
  res.json({ ok: true });

  if (!pending) return;

  const code = generateVerificationCode();
  pendingVerifications.set(emailNorm, { ...pending, code, expires: Date.now() + VERIFICATION_TTL_MS });

  try {
    await sendEmail({
      to: emailNorm,
      subject: 'Your AI Chats verification code',
      text: `Your new verification code is: ${code}\n\nThis code expires in 15 minutes.`,
    });
  } catch {
    // fail silently — code already printed to console in dev
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};

  if (typeof email !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid payload.' });
    return;
  }

  const emailNorm = email.trim().toLowerCase();

  // Always respond immediately — don't reveal whether the account exists
  res.json({ ok: true });

  try {
    const users = await loadUsers();
    const user = findByEmail(users, emailNorm);
    if (!user || !user.verified) return;

    const token = generateResetToken();
    passwordResetTokens.set(token, { email: emailNorm, expires: Date.now() + RESET_TTL_MS });

    await sendEmail({
      to: emailNorm,
      subject: 'Reset your AI Chats password',
      text: `Click the link below to reset your password. This link expires in 1 hour.\n\n${APP_URL}/?reset=${token}\n\nIf you did not request this, ignore this email.`,
    });
  } catch {
    // fail silently
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};

  if (typeof token !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid payload.' });
    return;
  }

  if (newPassword.length < 12) {
    res.status(400).json({ ok: false, error: 'Password must be at least 12 characters.' });
    return;
  }

  const entry = passwordResetTokens.get(token);
  if (!entry || entry.expires < Date.now()) {
    passwordResetTokens.delete(token);
    res.status(400).json({ ok: false, error: 'Reset link expired or invalid. Please request a new one.' });
    return;
  }

  try {
    const users = await loadUsers();
    const userIndex = users.findIndex((u) => u.email.toLowerCase() === entry.email);
    if (userIndex < 0) {
      res.status(400).json({ ok: false, error: 'Account not found.' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await derivePasswordHash(newPassword, salt);
    users[userIndex] = { ...users[userIndex], salt, hash, changedAt: new Date().toISOString() };
    await saveUsers(users);
    passwordResetTokens.delete(token);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: 'Password reset failed. Please try again.' });
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid payload.' });
    return;
  }

  if (newPassword.length < 12) {
    res.status(400).json({ ok: false, error: 'New password must be at least 12 characters.' });
    return;
  }

  if (currentPassword === newPassword) {
    res.status(400).json({ ok: false, error: 'New password must be different from current password.' });
    return;
  }

  try {
    const users = await loadUsers();
    const userIndex = users.findIndex((u) => u.id === req.session.user.userId);
    if (userIndex < 0) {
      res.status(404).json({ ok: false, error: 'User not found.' });
      return;
    }

    const currentIsValid = await verifyPassword(currentPassword, users[userIndex]);
    if (!currentIsValid) {
      res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await derivePasswordHash(newPassword, salt);
    users[userIndex] = { ...users[userIndex], salt, hash, changedAt: new Date().toISOString() };
    await saveUsers(users);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: 'Unable to change password.' });
  }
});

// ─── Conversation API ─────────────────────────────────────────────────────────

// Resolve user from API key (for Tampermonkey ingest)
async function resolveApiKeyUser(req) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return null;
  const users = await loadUsers();
  return findByApiKey(users, apiKey);
}

// Ingest endpoint — Tampermonkey pushes here with API key
app.post('/api/conversations', async (req, res) => {
  const user = await resolveApiKeyUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'Invalid or missing API key. Add your key in Settings.' });
    return;
  }

  const { id, title, platform, url, captured, messages } = req.body || {};
  if (!id || !title || !Array.isArray(messages) || !messages.length) {
    res.status(400).json({ ok: false, error: 'Missing required fields: id, title, messages[].' });
    return;
  }

  try {
    const result = db.upsertConversation({
      userId: user.id,
      id,
      title,
      platform: platform || 'unknown',
      url: url || null,
      captured: captured || new Date().toISOString(),
      messages,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Upsert error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to save conversation.' });
  }
});

// List conversations (session auth, scoped to user)
app.get('/api/conversations', requireAuth, (req, res) => {
  const { platform, q, limit, offset } = req.query;
  try {
    const result = db.listConversations({
      userId: req.session.user.userId,
      platform: platform || 'all',
      query: q || '',
      limit: Math.min(Number(limit) || 200, 500),
      offset: Number(offset) || 0,
    });
    res.json(result);
  } catch (e) {
    console.error('List error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to list conversations.' });
  }
});

// Get single conversation (session auth, scoped to user)
app.get('/api/conversations/:id', requireAuth, (req, res) => {
  try {
    const conversation = db.getConversation(req.session.user.userId, req.params.id);
    if (!conversation) {
      res.status(404).json({ ok: false, error: 'Conversation not found.' });
      return;
    }
    res.json(conversation);
  } catch (e) {
    console.error('Get error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to get conversation.' });
  }
});

// Delete conversation (session auth, scoped to user)
app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  try {
    db.deleteConversation(req.session.user.userId, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to delete conversation.' });
  }
});

// Stats (session auth, scoped to user)
app.get('/api/stats', requireAuth, (_req, res) => {
  try {
    res.json(db.getStats(_req.session.user.userId));
  } catch (e) {
    console.error('Stats error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to get stats.' });
  }
});

// Search (session auth, scoped to user)
app.get('/api/search', requireAuth, (req, res) => {
  const { q, limit } = req.query;
  if (!q) {
    res.status(400).json({ ok: false, error: 'Query parameter q is required.' });
    return;
  }
  try {
    const results = db.searchMessages(req.session.user.userId, q, { limit: Math.min(Number(limit) || 50, 200) });
    res.json({ results });
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ ok: false, error: 'Search failed.' });
  }
});

// Get API key (session auth)
app.get('/api/auth/api-key', requireAuth, async (req, res) => {
  try {
    const users = await loadUsers();
    const user = users.find((u) => u.id === req.session.user.userId);
    if (!user) { res.status(404).json({ ok: false, error: 'User not found.' }); return; }

    // Generate key if user doesn't have one yet (migrated users)
    if (!user.apiKey) {
      user.apiKey = db.generateApiKey();
      await saveUsers(users);
    }

    res.json({ ok: true, apiKey: user.apiKey });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to get API key.' });
  }
});

// Regenerate API key (session auth)
app.post('/api/auth/regenerate-api-key', requireAuth, async (req, res) => {
  try {
    const users = await loadUsers();
    const user = users.find((u) => u.id === req.session.user.userId);
    if (!user) { res.status(404).json({ ok: false, error: 'User not found.' }); return; }

    user.apiKey = db.generateApiKey();
    await saveUsers(users);
    res.json({ ok: true, apiKey: user.apiKey });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to regenerate API key.' });
  }
});

app.use(express.static(path.join(process.cwd(), 'app')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'app', 'index.html'));
});

ensureAuthStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AI Chats server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize auth store.', error);
    process.exit(1);
  });
