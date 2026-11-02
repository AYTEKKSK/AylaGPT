/**
 * Konuşma kalıcılığı — Node 24'in built-in node:sqlite modülü.
 * Ek dependency yok.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'chat.db');

let db;

export function getDb() {
  if (db) return db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Yeni sohbet',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      provider        TEXT,
      model           TEXT,
      tool_calls      TEXT,
      reasoning       TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, id);
  `);

  // Eski şemaya reasoning kolonu ekle (migration)
  const cols = db.prepare('PRAGMA table_info(messages)').all();
  if (!cols.some((c) => c.name === 'reasoning')) {
    db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
  }

  return db;
}

const now = () => Date.now();

export function createConversation(title = 'Yeni sohbet') {
  const d = getDb();
  const id = `c_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = now();
  d.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, title, ts, ts);
  return { id, title, createdAt: ts, updatedAt: ts };
}

export function listConversations(limit = 100) {
  const d = getDb();
  const rows = d.prepare(
    `SELECT c.*, COUNT(m.id) AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT ?`,
  ).all(limit);
  return rows;
}

export function getConversation(id) {
  const d = getDb();
  return d.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
}

export function renameConversation(id, title) {
  const d = getDb();
  d.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, now(), id);
  return getConversation(id);
}

export function deleteConversation(id) {
  const d = getDb();
  d.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  d.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return true;
}

export function addMessage({ conversationId, role, content, provider = null, model = null, toolCalls = null, reasoning = null }) {
  const d = getDb();
  const ts = now();
  const info = d.prepare(
    `INSERT INTO messages (conversation_id, role, content, provider, model, tool_calls, reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId, role, content, provider, model,
    toolCalls ? JSON.stringify(toolCalls) : null,
    reasoning || null,
    ts,
  );
  d.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
  return { id: Number(info.lastInsertRowid), conversationId, role, content, provider, model, createdAt: ts };
}

export function getMessages(conversationId, limit = 200) {
  const d = getDb();
  return d.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?',
  ).all(conversationId, limit);
}

/** Sohbet başlığını ilk kullanıcı mesajından türetir */
export function autoTitle(conversationId, fallback = 'Yeni sohbet') {
  const d = getDb();
  const first = d.prepare(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1",
  ).get(conversationId);
  if (!first) return fallback;
  const title = String(first.content).replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!title) return fallback;
  d.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, now(), conversationId);
  return title;
}
