const { Pool } = require('pg');
const crypto = require('node:crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://aichats:aichats@localhost:5432/aichats',
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        verified BOOLEAN NOT NULL DEFAULT false,
        role TEXT NOT NULL DEFAULT 'user',
        api_key TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'unknown',
        url TEXT,
        captured TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id UUID NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE,
        UNIQUE(conversation_id, user_id, sort_order)
      );

      CREATE TABLE IF NOT EXISTS code_snippets (
        id SERIAL PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id UUID NOT NULL,
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'plaintext',
        code TEXT NOT NULL,
        detected BOOLEAN NOT NULL DEFAULT false,
        FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_snippets_conv ON code_snippets(conversation_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, captured DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON conversations(user_id, platform);
      CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
      -- idx_users_email omitted: UNIQUE constraint on email already creates an index
    `);

    // v1.1: persistent auth state tables (replaces in-memory Maps)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_verifications (
        email TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        username TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        failed_count INTEGER NOT NULL DEFAULT 0,
        lock_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // v2: tier, storage, attachments
    const addCol = async (table, col, def) => {
      try { await client.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
      catch (e) { if (e.code !== '42701') throw e; } // 42701 = duplicate_column
    };
    await addCol('users', 'tier', "TEXT NOT NULL DEFAULT 'free'");
    await addCol('users', 'storage_used_bytes', 'BIGINT NOT NULL DEFAULT 0');
    await addCol('users', 'storage_limit_bytes', 'BIGINT NOT NULL DEFAULT 0');
    await addCol('users', 'xendit_plan_id', 'TEXT');
    await addCol('users', 'subscription_status', "TEXT NOT NULL DEFAULT 'none'");
    await addCol('users', 'subscription_expires_at', 'TIMESTAMPTZ');
    await addCol('users', 'storage_tier', 'INTEGER NOT NULL DEFAULT 0');

    await client.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id TEXT NOT NULL,
        user_id UUID NOT NULL,
        message_index INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_category TEXT NOT NULL,
        file_size BIGINT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conversation_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);
    `);

    // v3: full-text search index on messages
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_text_fts ON messages USING GIN(to_tsvector('english', text));
      CREATE INDEX IF NOT EXISTS idx_conversations_title_fts ON conversations USING GIN(to_tsvector('english', title));
    `);

    // v4: missing indexes for common queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_snippets_user ON code_snippets(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_xendit_plan ON users(xendit_plan_id) WHERE xendit_plan_id IS NOT NULL;
    `);
  } finally {
    client.release();
  }
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
      snippets.push({ messageIndex, role: message.role, language: match[1] || 'plaintext', code: match[2].trim(), detected: false });
    }

    if (!fenced.length) {
      const seen = new Set();
      const unique = [];
      for (const match of message.text.matchAll(inlineCodeRegex)) {
        const code = match[1].trim();
        if (!seen.has(code)) { seen.add(code); unique.push(code); }
      }
      if (unique.length > 0) {
        snippets.push({ messageIndex, role: message.role, language: 'inline', code: unique.join('\n'), detected: true });
      }
    }

    const hasAny = fenced.length > 0 || [...message.text.matchAll(inlineCodeRegex)].length > 0;
    if (!hasAny && looksLikeCode(message.text)) {
      snippets.push({ messageIndex, role: message.role, language: 'detected', code: message.text.slice(0, 500), detected: true });
    }
  });
  return snippets;
}

// ─── API Key helper ─────────────────────────────────────────────────────────

function generateApiKey() {
  return 'aichat_' + crypto.randomBytes(24).toString('hex');
}

// ─── User CRUD (replaces users.json) ─────────────────────────────────────────

async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function findUserByApiKey(apiKey) {
  const { rows } = await pool.query('SELECT * FROM users WHERE api_key = $1 AND verified = true', [apiKey]);
  return rows[0] || null;
}

async function createUser({ email, username, salt, hash, verified, role }) {
  const apiKey = generateApiKey();
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, salt, hash, verified, role, api_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [email, username, salt, hash, verified, role || 'user', apiKey]
  );
  return rows[0];
}

async function updateUserPassword(id, salt, hash) {
  await pool.query('UPDATE users SET salt = $1, hash = $2, changed_at = NOW() WHERE id = $3', [salt, hash, id]);
}

async function updateUserApiKey(id) {
  const apiKey = generateApiKey();
  await pool.query('UPDATE users SET api_key = $1 WHERE id = $2', [apiKey, id]);
  return apiKey;
}

async function getApiKey(userId) {
  const { rows } = await pool.query('SELECT api_key FROM users WHERE id = $1', [userId]);
  return rows[0]?.api_key || null;
}

// ─── Conversation CRUD (all scoped by user_id) ──────────────────────────────

async function upsertConversation({ userId, id, title, platform, url, captured, messages }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO conversations (id, user_id, title, platform, url, captured, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT(id, user_id) DO UPDATE SET
        title = EXCLUDED.title,
        platform = EXCLUDED.platform,
        url = EXCLUDED.url,
        captured = EXCLUDED.captured,
        updated_at = NOW()
    `, [id, userId, title, platform, url || null, captured]);

    await client.query('DELETE FROM messages WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
    await client.query('DELETE FROM code_snippets WHERE conversation_id = $1 AND user_id = $2', [id, userId]);

    // Batch insert messages (chunks of 100 to stay within PG parameter limits)
    for (let batch = 0; batch < messages.length; batch += 100) {
      const chunk = messages.slice(batch, batch + 100);
      const values = [];
      const params = [];
      chunk.forEach((msg, i) => {
        const offset = i * 5;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        params.push(id, userId, msg.role, msg.text, batch + i);
      });
      await client.query(
        `INSERT INTO messages (conversation_id, user_id, role, text, sort_order) VALUES ${values.join(', ')}`,
        params
      );
    }

    const snippets = extractCodeSnippets(messages);
    if (snippets.length > 0) {
      for (let batch = 0; batch < snippets.length; batch += 100) {
        const chunk = snippets.slice(batch, batch + 100);
        const values = [];
        const params = [];
        chunk.forEach((s, i) => {
          const offset = i * 7;
          values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`);
          params.push(id, userId, s.messageIndex, s.role, s.language, s.code, s.detected);
        });
        await client.query(
          `INSERT INTO code_snippets (conversation_id, user_id, message_index, role, language, code, detected) VALUES ${values.join(', ')}`,
          params
        );
      }
    }

    await client.query('COMMIT');
    return { id, messagesCount: messages.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listConversations({ userId, platform, query, limit = 200, offset = 0 } = {}) {
  const conditions = ['c.user_id = $1'];
  const params = [userId];
  let pIdx = 2;

  if (platform && platform !== 'all') {
    conditions.push(`c.platform = $${pIdx++}`);
    params.push(platform);
  }

  if (query) {
    conditions.push(`(c.title ILIKE $${pIdx} OR EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id AND m.text ILIKE $${pIdx + 1}
    ))`);
    params.push(`%${query}%`, `%${query}%`);
    pIdx += 2;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows: conversations } = await pool.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id) AS message_count
    FROM conversations c
    ${where}
    ORDER BY c.captured DESC
    LIMIT $${pIdx} OFFSET $${pIdx + 1}
  `, [...params, limit, offset]);

  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*) as count FROM conversations c ${where}`, params
  );

  return { conversations, total: Number(count) };
}

async function getConversation(userId, id, { messageLimit = 5000, snippetLimit = 1000, attachmentLimit = 500 } = {}) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  const conversation = rows[0];
  if (!conversation) return null;

  const { rows: messages } = await pool.query(
    'SELECT role, text FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY sort_order LIMIT $3', [id, userId, messageLimit]
  );
  conversation.messages = messages;

  const { rows: snippets } = await pool.query(
    'SELECT message_index AS "messageIndex", role, language, code, detected FROM code_snippets WHERE conversation_id = $1 AND user_id = $2 ORDER BY id LIMIT $3', [id, userId, snippetLimit]
  );
  conversation.codeSnippets = snippets;

  const { rows: attachments } = await pool.query(
    'SELECT id, message_index AS "messageIndex", file_name AS "fileName", file_type AS "fileType", file_category AS "fileCategory", file_size AS "fileSize" FROM attachments WHERE conversation_id = $1 AND user_id = $2 ORDER BY message_index, created_at LIMIT $3',
    [id, userId, attachmentLimit]
  );
  conversation.attachments = attachments;

  return conversation;
}

async function deleteConversation(userId, id) {
  await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function getStats(userId) {
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE user_id = $1) AS conversations,
      (SELECT COUNT(*) FROM code_snippets WHERE user_id = $1) AS "codeSnippets",
      (SELECT COUNT(*) FROM messages WHERE user_id = $1) AS messages,
      (SELECT COUNT(*) FROM attachments WHERE user_id = $1) AS attachments,
      u.tier, u.storage_used_bytes AS "storageUsed", u.storage_limit_bytes AS "storageLimit"
    FROM users u WHERE u.id = $1
  `, [userId]);
  return {
    conversations: Number(stats.conversations), codeSnippets: Number(stats.codeSnippets),
    messages: Number(stats.messages), attachments: Number(stats.attachments),
    tier: stats.tier, storageUsed: Number(stats.storageUsed), storageLimit: Number(stats.storageLimit),
  };
}

async function searchMessages(userId, query, { limit = 50 } = {}) {
  // Use websearch_to_tsquery (PG 11+) which safely handles user input
  // including special chars like C++, node.js, &, !, etc.
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const { rows } = await pool.query(`
      SELECT m.conversation_id, m.role, m.text, m.sort_order,
             c.title AS conversation_title, c.platform, c.captured,
             ts_rank(to_tsvector('english', m.text), websearch_to_tsquery('english', $2)) AS rank
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
      WHERE m.user_id = $1 AND to_tsvector('english', m.text) @@ websearch_to_tsquery('english', $2)
      ORDER BY rank DESC, c.captured DESC
      LIMIT $3
    `, [userId, trimmed, limit]);
    return rows;
  } catch {
    // Fallback to ILIKE if FTS fails (e.g. single character queries)
    const { rows } = await pool.query(`
      SELECT m.conversation_id, m.role, m.text, m.sort_order,
             c.title AS conversation_title, c.platform, c.captured
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
      WHERE m.user_id = $1 AND m.text ILIKE $2
      ORDER BY c.captured DESC
      LIMIT $3
    `, [userId, `%${trimmed}%`, limit]);
    return rows;
  }
}

// ─── Attachment CRUD ─────────────────────────────────────────────────────────

async function createAttachment({ conversationId, userId, messageIndex, fileName, fileType, fileCategory, fileSize, storagePath }) {
  const { rows } = await pool.query(
    `INSERT INTO attachments (conversation_id, user_id, message_index, file_name, file_type, file_category, file_size, storage_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [conversationId, userId, messageIndex, fileName, fileType, fileCategory, fileSize, storagePath]
  );
  return rows[0];
}

async function getAttachment(userId, attachmentId) {
  const { rows } = await pool.query(
    'SELECT * FROM attachments WHERE id = $1 AND user_id = $2', [attachmentId, userId]
  );
  return rows[0] || null;
}

async function getAttachmentsByConversation(userId, conversationId) {
  const { rows } = await pool.query(
    'SELECT id, message_index, file_name, file_type, file_category, file_size, created_at FROM attachments WHERE conversation_id = $1 AND user_id = $2 ORDER BY message_index, created_at',
    [conversationId, userId]
  );
  return rows;
}

async function getConversationAttachmentPaths(userId, conversationId) {
  const { rows } = await pool.query(
    'SELECT storage_path, file_size FROM attachments WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return rows;
}

async function addStorageUsed(userId, bytes) {
  await pool.query('UPDATE users SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2', [bytes, userId]);
}

async function subtractStorageUsed(userId, bytes) {
  await pool.query('UPDATE users SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2', [bytes, userId]);
}

async function getUserAccount(userId) {
  // Lazy expiration: atomically downgrade cancelled subscriptions past their expiry
  // The UPDATE ... RETURNING pattern avoids read-then-write race conditions
  const { rows: expired } = await pool.query(
    `UPDATE users SET tier = 'free', storage_tier = 0, storage_limit_bytes = 0, subscription_status = 'expired'
     WHERE id = $1 AND subscription_status = 'cancelled' AND subscription_expires_at IS NOT NULL AND subscription_expires_at < NOW()
     RETURNING id, email, username, role, tier, storage_tier, storage_used_bytes, storage_limit_bytes,
       xendit_plan_id, subscription_status, subscription_expires_at, created_at`,
    [userId]
  );
  if (expired.length > 0) return expired[0];

  const { rows } = await pool.query(
    `SELECT id, email, username, role, tier, storage_tier, storage_used_bytes, storage_limit_bytes,
     xendit_plan_id, subscription_status, subscription_expires_at, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ─── Subscription helpers ────────────────────────────────────────────────────

const STORAGE_INCREMENT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB per tier
const PRICE_PER_TIER_CENTS = 200; // $2 per 5 GB tier
const MAX_STORAGE_TIER = 20; // cap at 100 GB / $40 per month

function storageBytesForTier(tier) {
  return tier * STORAGE_INCREMENT_BYTES;
}

function priceForTier(tier) {
  return tier * PRICE_PER_TIER_CENTS;
}

async function updateSubscription(userId, { xenditPlanId, status, expiresAt, storageTier }) {
  const sets = ['changed_at = NOW()'];
  const params = [];
  let idx = 1;

  if (xenditPlanId !== undefined) { sets.push(`xendit_plan_id = $${idx++}`); params.push(xenditPlanId); }
  if (status !== undefined) { sets.push(`subscription_status = $${idx++}`); params.push(status); }
  if (expiresAt !== undefined) { sets.push(`subscription_expires_at = $${idx++}`); params.push(expiresAt); }
  if (storageTier !== undefined) {
    sets.push(`tier = 'premium'`);
    sets.push(`storage_tier = $${idx++}`); params.push(storageTier);
    sets.push(`storage_limit_bytes = $${idx++}`); params.push(storageBytesForTier(storageTier));
  }

  params.push(userId);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

async function findUserByXenditPlanId(planId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE xendit_plan_id = $1', [planId]);
  return rows[0] || null;
}

// ─── Persistent auth state (replaces in-memory Maps) ────────────────────────

async function setPendingVerification(email, { code, username, salt, hash, expiresAt }) {
  await pool.query(
    `INSERT INTO pending_verifications (email, code, username, salt, hash, attempts, expires_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)
     ON CONFLICT (email) DO UPDATE SET
       code = EXCLUDED.code, username = EXCLUDED.username,
       salt = EXCLUDED.salt, hash = EXCLUDED.hash,
       attempts = 0, expires_at = EXCLUDED.expires_at`,
    [email, code, username, salt, hash, new Date(expiresAt).toISOString()]
  );
}

async function getPendingVerification(email) {
  const { rows } = await pool.query(
    'SELECT * FROM pending_verifications WHERE email = $1 AND expires_at > NOW()', [email]
  );
  return rows[0] || null;
}

async function incrementVerificationAttempts(email) {
  await pool.query(
    'UPDATE pending_verifications SET attempts = attempts + 1 WHERE email = $1', [email]
  );
}

async function deletePendingVerification(email) {
  await pool.query('DELETE FROM pending_verifications WHERE email = $1', [email]);
}

async function setPasswordResetToken(token, { email, userId, expiresAt }) {
  await pool.query(
    `INSERT INTO password_reset_tokens (token, email, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, email, userId, new Date(expiresAt).toISOString()]
  );
}

async function getPasswordResetToken(token) {
  const { rows } = await pool.query(
    'SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()', [token]
  );
  return rows[0] || null;
}

async function deletePasswordResetToken(token) {
  await pool.query('DELETE FROM password_reset_tokens WHERE token = $1', [token]);
}

async function deleteExpiredPasswordResetTokens() {
  await pool.query('DELETE FROM password_reset_tokens WHERE expires_at <= NOW()');
}

async function getLoginAttempts(ip) {
  const { rows } = await pool.query('SELECT * FROM login_attempts WHERE ip = $1', [ip]);
  return rows[0] || null;
}

async function registerFailedLogin(ip, failedCount, lockUntil) {
  await pool.query(
    `INSERT INTO login_attempts (ip, failed_count, lock_until, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (ip) DO UPDATE SET
       failed_count = EXCLUDED.failed_count,
       lock_until = EXCLUDED.lock_until,
       updated_at = NOW()`,
    [ip, failedCount, new Date(lockUntil).toISOString()]
  );
}

async function clearLoginAttempts(ip) {
  await pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
}

async function cleanupExpiredAuthState() {
  await pool.query('DELETE FROM pending_verifications WHERE expires_at <= NOW()');
  await pool.query('DELETE FROM password_reset_tokens WHERE expires_at <= NOW()');
  await pool.query("DELETE FROM login_attempts WHERE lock_until <= NOW() AND failed_count < 3");
}

module.exports = {
  pool,
  migrate,
  generateApiKey,
  findUserByEmail,
  findUserById,
  findUserByApiKey,
  createUser,
  updateUserPassword,
  updateUserApiKey,
  getApiKey,
  getUserAccount,
  upsertConversation,
  listConversations,
  getConversation,
  deleteConversation,
  getStats,
  searchMessages,
  createAttachment,
  getAttachment,
  getAttachmentsByConversation,
  getConversationAttachmentPaths,
  addStorageUsed,
  subtractStorageUsed,
  updateSubscription,
  findUserByXenditPlanId,
  setPendingVerification,
  getPendingVerification,
  incrementVerificationAttempts,
  deletePendingVerification,
  setPasswordResetToken,
  getPasswordResetToken,
  deletePasswordResetToken,
  deleteExpiredPasswordResetTokens,
  getLoginAttempts,
  registerFailedLogin,
  clearLoginAttempts,
  cleanupExpiredAuthState,
  STORAGE_INCREMENT_BYTES,
  PRICE_PER_TIER_CENTS,
  MAX_STORAGE_TIER,
  storageBytesForTier,
  priceForTier,
};
