import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function isoNow() {
  return new Date().toISOString();
}

export function openDatabase(filename) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY,
      price INTEGER NOT NULL CHECK (price > 0),
      play_count INTEGER NOT NULL CHECK (play_count > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      token_id INTEGER,
      price INTEGER NOT NULL,
      play_count INTEGER NOT NULL,
      midtrans_transaction_id TEXT,
      midtrans_status TEXT NOT NULL,
      fraud_status TEXT,
      qr_string TEXT,
      qr_image TEXT,
      qr_link TEXT,
      signal_status TEXT NOT NULL DEFAULT 'none'
        CHECK (signal_status IN ('none', 'queued', 'accepted', 'done')),
      expires_at TEXT,
      signal_queued_at TEXT,
      signal_accepted_at TEXT,
      signal_done_at TEXT,
      accepted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payments_signal
      ON payments (signal_status, signal_queued_at, id);
  `);
}

export function countAdmins(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

export function countActiveAdmins(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admins WHERE active = 1').get().n;
}

export function insertAdmin(db, { username, passwordHash }) {
  const now = isoNow();
  const result = db.prepare(`
    INSERT INTO admins (username, password_hash, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(username, passwordHash, now, now);
  return findAdminById(db, Number(result.lastInsertRowid));
}

export function listAdmins(db) {
  return db.prepare('SELECT * FROM admins ORDER BY username COLLATE NOCASE').all();
}

export function findAdminById(db, id) {
  return db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
}

export function findAdminByUsername(db, username) {
  return db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(username);
}

export function updateAdmin(db, id, { username, passwordHash, active }) {
  const current = findAdminById(db, id);
  if (!current) return null;
  db.prepare(`
    UPDATE admins
    SET username = ?, password_hash = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    username ?? current.username,
    passwordHash ?? current.password_hash,
    active === undefined ? current.active : active ? 1 : 0,
    isoNow(),
    id,
  );
  return findAdminById(db, id);
}

export function insertToken(db, { price, playCount }) {
  const now = isoNow();
  const result = db.prepare(`
    INSERT INTO tokens (price, play_count, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(price, playCount, now, now);
  return findToken(db, Number(result.lastInsertRowid));
}

export function listTokens(db, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM tokens WHERE active = 1 ORDER BY play_count, price, id'
    : 'SELECT * FROM tokens ORDER BY active DESC, play_count, price, id';
  return db.prepare(sql).all();
}

export function findToken(db, id) {
  return db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
}

export function updateToken(db, id, { price, playCount, active }) {
  const current = findToken(db, id);
  if (!current) return null;
  db.prepare(`
    UPDATE tokens
    SET price = ?, play_count = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    price ?? current.price,
    playCount ?? current.play_count,
    active === undefined ? current.active : active ? 1 : 0,
    isoNow(),
    id,
  );
  return findToken(db, id);
}

export function insertPayment(db, payment) {
  const now = isoNow();
  const result = db.prepare(`
    INSERT INTO payments (
      order_id, token_id, price, play_count, midtrans_transaction_id, midtrans_status,
      fraud_status, qr_string, qr_image, qr_link, signal_status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?)
  `).run(
    payment.orderId,
    payment.tokenId,
    payment.price,
    payment.playCount,
    payment.transactionId,
    payment.midtransStatus,
    payment.fraudStatus,
    payment.qrString,
    payment.qrImage,
    payment.qrLink,
    payment.expiresAt,
    now,
    now,
  );
  return findPaymentById(db, Number(result.lastInsertRowid));
}

export function findPaymentById(db, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

export function findPaymentByOrderId(db, orderId) {
  return db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
}

export function listPayments(db) {
  return db.prepare(`
    SELECT id, order_id, token_id, price, play_count, midtrans_transaction_id,
           midtrans_status, fraud_status, signal_status, expires_at,
           signal_queued_at, signal_accepted_at, signal_done_at, created_at, updated_at
    FROM payments
    ORDER BY id DESC
  `).all();
}

export function amountsEqual(grossAmount, price) {
  if (typeof grossAmount !== 'string' || !Number.isInteger(price)) return false;
  const text = grossAmount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return false;
  return Number(text) === price;
}

export function recordGatewayUpdate(db, body) {
  const order = findPaymentByOrderId(db, body.order_id);
  if (!order) return { found: false, queued: false };
  const status = typeof body.transaction_status === 'string' ? body.transaction_status : '';
  if (!status) return { found: true, queued: false, reason: 'status' };
  const now = isoNow();
  const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id : null;

  if (status === 'settlement') {
    const queueable =
      body.payment_type === 'qris' &&
      body.fraud_status === 'accept' &&
      amountsEqual(body.gross_amount, order.price);
    if (queueable) {
      const result = db.prepare(`
        UPDATE payments
        SET midtrans_status = 'settlement',
            fraud_status = 'accept',
            midtrans_transaction_id = COALESCE(?, midtrans_transaction_id),
            signal_status = 'queued',
            signal_queued_at = ?,
            updated_at = ?
        WHERE id = ? AND signal_status = 'none'
      `).run(transactionId, now, now, order.id);
      return { found: true, queued: result.changes === 1 };
    }
    db.prepare(`
      UPDATE payments
      SET midtrans_status = 'settlement',
          fraud_status = COALESCE(?, fraud_status),
          midtrans_transaction_id = COALESCE(?, midtrans_transaction_id),
          updated_at = ?
      WHERE id = ? AND signal_status = 'none'
    `).run(body.fraud_status || null, transactionId, now, order.id);
    return { found: true, queued: false, reason: 'rejected_settlement' };
  }

  const result = db.prepare(`
    UPDATE payments
    SET midtrans_status = ?,
        fraud_status = COALESCE(?, fraud_status),
        midtrans_transaction_id = COALESCE(?, midtrans_transaction_id),
        updated_at = ?
    WHERE id = ? AND signal_status = 'none' AND midtrans_status != 'settlement'
  `).run(status, body.fraud_status || null, transactionId, now, order.id);
  return { found: true, queued: false, updated: result.changes === 1 };
}

export function claimNextJob(db, deviceHash) {
  const owned = db.prepare(`
    SELECT id, play_count
    FROM payments
    WHERE signal_status = 'accepted' AND accepted_by = ?
    ORDER BY signal_accepted_at ASC, id ASC
    LIMIT 1
  `).get(deviceHash);
  if (owned) return { payment_id: owned.id, pulses: owned.play_count };

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`
      SELECT id, play_count
      FROM payments
      WHERE signal_status = 'queued'
      ORDER BY signal_queued_at ASC, id ASC
      LIMIT 1
    `).get();
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    const now = isoNow();
    const result = db.prepare(`
      UPDATE payments
      SET signal_status = 'accepted', signal_accepted_at = ?, accepted_by = ?, updated_at = ?
      WHERE id = ? AND signal_status = 'queued'
    `).run(now, deviceHash, now, row.id);
    db.exec('COMMIT');
    if (result.changes !== 1) return null;
    return { payment_id: row.id, pulses: row.play_count };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function completeJob(db, paymentId) {
  const row = findPaymentById(db, paymentId);
  if (!row) return { error: 'not_found' };
  if (row.signal_status === 'done') return { ok: true, already: true };
  if (row.signal_status !== 'accepted') return { error: 'not_accepted' };
  const now = isoNow();
  const result = db.prepare(`
    UPDATE payments
    SET signal_status = 'done', signal_done_at = ?, updated_at = ?
    WHERE id = ? AND signal_status = 'accepted'
  `).run(now, now, paymentId);
  if (result.changes === 1) return { ok: true };
  const again = findPaymentById(db, paymentId);
  if (again?.signal_status === 'done') return { ok: true, already: true };
  return { error: 'not_accepted' };
}
