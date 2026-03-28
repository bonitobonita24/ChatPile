const Database = require('better-sqlite3');
const path = require('node:path');
const crypto = require('node:crypto');

const AUTH_DIR = path.join(process.cwd(), '.auth');
const DB_PATH = path.join(AUTH_DIR, 'aichats.db');

let db;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown',
      url TEXT,
      captured TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE,
      UNIQUE(conversation_id, user_id, sort_order)
    );

    CREATE TABLE IF NOT EXISTS code_snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'plaintext',
      code TEXT NOT NULL,
      detected INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_snippets_conv ON code_snippets(conversation_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, captured DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_platform ON conversations(user_id, platform);
  `);
}

// ─── Code detection helpers ──────────────────────────────────────────────────

const codeFenceRegex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
const inlineCodeRegex = /`([^`\n]{5,})`/g;

function isCodeLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[$>]\s/.test(t)) return true;
  if (/^#!/.test(t)) return true;
  if (/^\s{4,}\S/.test(line) || /^\t\S/.test(line)) return true;
  if (/^(function|def\s|class\s|import\s|from\s|const\s|let\s|var\s|return\s|async\s|await\s|export\s|require\s*\(|include\s|use\s|pub\s|fn\s|impl\s|package\s|struct\s|enum\s|interface\s|type\s|switch\s*\(|case\s|try\s*\{|catch\s*\(|throw\s|new\s)/.test(t)) return true;
  if (/[{};]$/.test(t) && t.length > 2) return true;
  if (/=>|->|::|===|!==|&&|\|\|/.test(t)) return true;
  return false;
}

function looksLikeCode(text) {
  const lines = text.split('\n');
  let streak = 0;
  for (const line of lines) {
    if (!line.trim()) { streak = 0; continue; }
    if (isCodeLine(line)) { if (++streak >= 2) return true; }
    else { streak = 0; }
  }
  return false;
}

function extractCodeSnippets(messages) {
  const snippets = [];
  messages.forEach((message, messageIndex) => {
    const fenced = [...message.text.matchAll(codeFenceRegex)];
    for (const match of fenced) {
      snippets.push({
        messageIndex,
        role: message.role,
        language: match[1] || 'plaintext',
        code: match[2].trim(),
        detected: false,
      });
    }

    if (!fenced.length) {
      const seen = new Set();
      const unique = [];
      for (const match of message.text.matchAll(inlineCodeRegex)) {
        const code = match[1].trim();
        if (!seen.has(code)) { seen.add(code); unique.push(code); }
      }
      if (unique.length > 0) {
        snippets.push({
          messageIndex,
          role: message.role,
          language: 'inline',
          code: unique.join('\n'),
          detected: true,
        });
      }
    }

    const hasAny = fenced.length > 0 || [...message.text.matchAll(inlineCodeRegex)].length > 0;
    if (!hasAny && looksLikeCode(message.text)) {
      snippets.push({
        messageIndex,
        role: message.role,
        language: 'detected',
        code: message.text.slice(0, 500),
        detected: true,
      });
    }
  });
  return snippets;
}

// ─── API Key helpers ─────────────────────────────────────────────────────────

function generateApiKey() {
  return 'aichat_' + crypto.randomBytes(24).toString('hex');
}

// ─── Public API (all scoped by user_id) ──────────────────────────────────────

function upsertConversation({ userId, id, title, platform, url, captured, messages }) {
  const db = getDb();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO conversations (id, user_id, title, platform, url, captured, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, user_id) DO UPDATE SET
        title = excluded.title,
        platform = excluded.platform,
        url = excluded.url,
        captured = excluded.captured,
        updated_at = excluded.updated_at
    `).run(id, userId, title, platform, url || null, captured, now, now);

    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM code_snippets WHERE conversation_id = ? AND user_id = ?').run(id, userId);

    const insertMsg = db.prepare(
      'INSERT INTO messages (conversation_id, user_id, role, text, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    messages.forEach((msg, i) => {
      insertMsg.run(id, userId, msg.role, msg.text, i);
    });

    const snippets = extractCodeSnippets(messages);
    const insertSnippet = db.prepare(
      'INSERT INTO code_snippets (conversation_id, user_id, message_index, role, language, code, detected) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    snippets.forEach((s) => {
      insertSnippet.run(id, userId, s.messageIndex, s.role, s.language, s.code, s.detected ? 1 : 0);
    });
  });

  tx();
  return { id, messagesCount: messages.length };
}

function listConversations({ userId, platform, query, limit = 200, offset = 0 } = {}) {
  const db = getDb();
  const conditions = ['c.user_id = ?'];
  const params = [userId];

  if (platform && platform !== 'all') {
    conditions.push('c.platform = ?');
    params.push(platform);
  }

  if (query) {
    conditions.push(`(c.title LIKE ? OR EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id AND m.text LIKE ?
    ))`);
    params.push(`%${query}%`, `%${query}%`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const conversations = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id) AS message_count
    FROM conversations c
    ${where}
    ORDER BY c.captured DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM conversations c ${where}
  `).get(...params).count;

  return { conversations, total };
}

function getConversation(userId, id) {
  const db = getDb();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
  if (!conversation) return null;

  conversation.messages = db.prepare(
    'SELECT role, text FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY sort_order'
  ).all(id, userId);

  conversation.codeSnippets = db.prepare(
    'SELECT message_index AS messageIndex, role, language, code, detected FROM code_snippets WHERE conversation_id = ? AND user_id = ? ORDER BY id'
  ).all(id, userId);

  conversation.codeSnippets.forEach(s => { s.detected = Boolean(s.detected); });

  return conversation;
}

function deleteConversation(userId, id) {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId);
}

function getStats(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE user_id = ?) AS conversations,
      (SELECT COUNT(*) FROM code_snippets WHERE user_id = ?) AS codeSnippets,
      (SELECT COUNT(*) FROM messages WHERE user_id = ?) AS messages
  `).get(userId, userId, userId);
}

function searchMessages(userId, query, { limit = 50 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT m.conversation_id, m.role, m.text, m.sort_order,
           c.title AS conversation_title, c.platform, c.captured
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
    WHERE m.user_id = ? AND m.text LIKE ?
    ORDER BY c.captured DESC
    LIMIT ?
  `).all(userId, `%${query}%`, limit);
}

module.exports = {
  getDb,
  generateApiKey,
  upsertConversation,
  listConversations,
  getConversation,
  deleteConversation,
  getStats,
  searchMessages,
};
