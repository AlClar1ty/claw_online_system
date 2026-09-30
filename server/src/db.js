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
  const columns = db.prepare('PRAGMA table_info(payments)').all();
  if (!columns.some((column) => column.name === 'skipped')) {
    db.exec('ALTER TABLE payments ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export function jakartaDate(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  return new Date(time + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

export function listPayments(db, filters = {}) {
  const hiddenSkipped = filters.includeSkipped
    ? ''
    : 'WHERE NOT (skipped = 1 AND midtrans_status = \'pending\' AND signal_status = \'none\')';
  const rows = db.prepare(`
    SELECT id, order_id, token_id, price, play_count, midtrans_transaction_id,
           midtrans_status, fraud_status, signal_status, expires_at, qr_image,
           signal_queued_at, signal_accepted_at, signal_done_at, created_at, updated_at
    FROM payments
    ${hiddenSkipped}
    ORDER BY id DESC
  `).all();
  return rows.filter((row) => {
    if (filters.from || filters.to) {
      const date = jakartaDate(row.created_at);
      if (filters.from && date < filters.from) return false;
      if (filters.to && date > filters.to) return false;
    }
    if (filters.payment && row.midtrans_status !== filters.payment) return false;
    if (filters.signal && row.signal_status !== filters.signal) return false;
    return true;
  });
}

export function dashboardStats(db, now = new Date()) {
  const today = jakartaDate(now);
  const month = today.slice(0, 7);
  const todayNumber = Number(today.slice(8, 10));
  const daily = [];
  for (let day = 1; day <= todayNumber; day += 1) {
    daily.push({ date: `${month}-${String(day).padStart(2, '0')}`, transactions: 0 });
  }
  const counts = new Map(daily.map((item) => [item.date, item]));
  const rows = db.prepare(`
    SELECT price, play_count, created_at
    FROM payments
    WHERE midtrans_status = 'settlement'
  `).all();
  let monthTotal = 0;
  let todayTotal = 0;
  let todayTransactions = 0;
  let playSum = 0;
  for (const row of rows) {
    const date = jakartaDate(row.created_at);
    playSum += row.play_count;
    if (date.slice(0, 7) === month) {
      monthTotal += row.price;
      const bucket = counts.get(date);
      if (bucket) bucket.transactions += 1;
    }
    if (date === today) {
      todayTotal += row.price;
      todayTransactions += 1;
    }
  }
  const average = rows.length === 0 ? 0 : playSum / rows.length;
  return {
    month_total: monthTotal,
    today_total: todayTotal,
    today_transactions: todayTransactions,
    average_plays: Math.round(average * 10) / 10,
    daily,
  };
}

export function resetPayments(db, ids) {
  const unique = [...new Set(ids)];
  const remove = db.prepare('DELETE FROM payments WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of unique) deleted += remove.run(id).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return deleted;
}

export function getRelayTiming(db, defaults) {
  const onRow = db.prepare(`SELECT value FROM settings WHERE key = 'relay_on_ms'`).get();
  const gapRow = db.prepare(`SELECT value FROM settings WHERE key = 'relay_gap_ms'`).get();
  const onMs = onRow ? Number(onRow.value) : defaults.onMs;
  const gapMs = gapRow ? Number(gapRow.value) : defaults.gapMs;
  return {
    onMs: Number.isInteger(onMs) ? onMs : defaults.onMs,
    gapMs: Number.isInteger(gapMs) ? gapMs : defaults.gapMs,
  };
}

export function setRelayTiming(db, { onMs, gapMs }) {
  if (!Number.isInteger(onMs) || onMs < 20 || onMs > 500) {
    return { error: 'Lama kontak harus bilangan bulat 20 sampai 500 milidetik' };
  }
  if (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > 2000) {
    return { error: 'Jeda harus bilangan bulat 0 sampai 2000 milidetik' };
  }
  const save = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  save.run('relay_on_ms', String(onMs));
  save.run('relay_gap_ms', String(gapMs));
  return { ok: true, onMs, gapMs };
}

export function skipPendingPayment(db, id) {
  const row = findPaymentById(db, id);
  if (!row) return { error: 'not_found' };
  if (row.midtrans_status !== 'pending' || row.signal_status !== 'none') {
    return { error: 'not_skippable' };
  }
  const now = isoNow();
  const result = db.prepare(`
    UPDATE payments
    SET skipped = 1, updated_at = ?
    WHERE id = ? AND midtrans_status = 'pending' AND signal_status = 'none'
  `).run(now, id);
  if (result.changes !== 1) return { error: 'not_skippable' };
  return { ok: true };
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

export function releaseForeignJobs(db, ownerHash) {
  const now = isoNow();
  const result = db.prepare(`
    UPDATE payments
    SET signal_status = 'queued',
        accepted_by = NULL,
        signal_accepted_at = NULL,
        updated_at = ?
    WHERE signal_status = 'accepted' AND IFNULL(accepted_by, '') != ?
  `).run(now, ownerHash);
  return result.changes;
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
