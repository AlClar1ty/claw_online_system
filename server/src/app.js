import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import {
  claimNextJob,
  completeJob,
  countActiveAdmins,
  findAdminById,
  findAdminByUsername,
  findPaymentByOrderId,
  findToken,
  insertAdmin,
  insertPayment,
  insertToken,
  listAdmins,
  listPayments,
  listTokens,
  getRelayTiming,
  setRelayTiming,
  skipPendingPayment,
  recordGatewayUpdate,
  updateAdmin,
  updateToken,
} from './db.js';
import { qrActionUrl, verifySignature } from './midtrans.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BCRYPT_COST = 10;
const SESSION_SECONDS = 12 * 60 * 60;

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function asId(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function routeId(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return number;
}

function publicAdmin(row) {
  return {
    id: row.id,
    username: row.username,
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicToken(row) {
  return {
    id: row.id,
    price: row.price,
    play_count: row.play_count,
    active: row.active === 1,
  };
}

function publicPayment(row, { includeQr }) {
  const body = {
    order_id: row.order_id,
    price: row.price,
    play_count: row.play_count,
    midtrans_status: row.midtrans_status,
    signal_status: row.signal_status,
    expires_at: row.expires_at,
  };
  if (includeQr && row.qr_image) body.qr_data_url = row.qr_image;
  if (includeQr && row.qr_link) body.qr_link = row.qr_link;
  return body;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

function sessionCookie(token, config) {
  const parts = [
    `claw_admin=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${token ? SESSION_SECONDS : 0}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function deviceAuthorized(presented, expectedTokens) {
  const given = Buffer.from(String(presented || ''));
  let ok = false;
  for (const expected of expectedTokens) {
    const candidate = Buffer.from(expected);
    if (given.length === candidate.length && crypto.timingSafeEqual(given, candidate)) ok = true;
  }
  return ok;
}

function deviceHash(presented) {
  return crypto.createHash('sha256').update(String(presented || '')).digest('hex');
}

function uniqueError(error) {
  return String(error?.message || '').includes('UNIQUE');
}

export function createApp({ db, config, midtrans, manualRelay }) {
  const app = express();
  const loginAttempts = new Map();
  const statusCheckedAt = new Map();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  function requireAdmin(req, res, next) {
    const token = readCookie(req, 'claw_admin');
    if (!token) {
      res.status(401).json({ error: 'Login diperlukan' });
      return;
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const admin = findAdminById(db, payload.sub);
      if (!admin || admin.active !== 1) {
        res.status(401).json({ error: 'Login diperlukan' });
        return;
      }
      req.admin = admin;
      next();
    } catch {
      res.status(401).json({ error: 'Login diperlukan' });
    }
  }

  function requireDevice(req, res, next) {
    const presented = req.headers['x-device-token'];
    if (!deviceAuthorized(presented, config.deviceTokens)) {
      res.status(401).json({ error: 'Token perangkat ditolak' });
      return;
    }
    next();
  }

  function loginAllowed(ip) {
    const now = Date.now();
    const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
    loginAttempts.set(ip, recent);
    return recent.length < 8;
  }

  function recordLoginFailure(ip) {
    const recent = loginAttempts.get(ip) || [];
    recent.push(Date.now());
    loginAttempts.set(ip, recent);
  }

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      midtrans: config.midtransProduction ? 'production' : 'sandbox',
    });
  });

  app.post('/api/admin/login', asyncRoute(async (req, res) => {
    const ip = req.socket.remoteAddress || 'local';
    if (!loginAllowed(ip)) {
      res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      return;
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const admin = username ? findAdminByUsername(db, username) : null;
    const match = admin ? await bcrypt.compare(password, admin.password_hash) : false;
    if (!admin || !match || admin.active !== 1) {
      recordLoginFailure(ip);
      res.status(401).json({ error: 'Username atau kata sandi salah' });
      return;
    }
    const token = jwt.sign({ sub: admin.id }, config.jwtSecret, { expiresIn: SESSION_SECONDS });
    res.setHeader('Set-Cookie', sessionCookie(token, config));
    res.json({ admin: publicAdmin(admin) });
  }));

  app.post('/api/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', config));
    res.status(204).end();
  });

  app.get('/api/admin/me', requireAdmin, (req, res) => {
    res.json({ admin: publicAdmin(req.admin) });
  });

  app.get('/api/admin/admins', requireAdmin, (req, res) => {
    res.json({ admins: listAdmins(db).map(publicAdmin) });
  });

  app.post('/api/admin/admins', requireAdmin, asyncRoute(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      res.status(400).json({ error: 'Username 3-32 karakter, huruf, angka, atau garis bawah' });
      return;
    }
    if (password.length < 8 || password.length > 72) {
      res.status(400).json({ error: 'Kata sandi 8-72 karakter' });
      return;
    }
    try {
      const admin = insertAdmin(db, { username, passwordHash: await bcrypt.hash(password, BCRYPT_COST) });
      res.status(201).json({ admin: publicAdmin(admin) });
    } catch (error) {
      if (uniqueError(error)) {
        res.status(409).json({ error: 'Username sudah dipakai' });
        return;
      }
      throw error;
    }
  }));

  app.patch('/api/admin/admins/:id', requireAdmin, asyncRoute(async (req, res) => {
    const id = routeId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Akun tidak valid' });
      return;
    }
    const current = findAdminById(db, id);
    if (!current) {
      res.status(404).json({ error: 'Akun tidak ditemukan' });
      return;
    }
    const body = req.body || {};
    const hasUsername = Object.hasOwn(body, 'username');
    const hasPassword = Object.hasOwn(body, 'password');
    const hasActive = Object.hasOwn(body, 'active');
    if (!hasUsername && !hasPassword && !hasActive) {
      res.status(400).json({ error: 'Tidak ada perubahan' });
      return;
    }
    let username;
    if (hasUsername) {
      username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
        res.status(400).json({ error: 'Username 3-32 karakter, huruf, angka, atau garis bawah' });
        return;
      }
    }
    let passwordHash;
    if (hasPassword) {
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 72) {
        res.status(400).json({ error: 'Kata sandi 8-72 karakter' });
        return;
      }
      passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
    }
    let active;
    if (hasActive) {
      if (typeof body.active !== 'boolean') {
        res.status(400).json({ error: 'Status aktif tidak valid' });
        return;
      }
      if (!body.active) {
        if (current.id === req.admin.id) {
          res.status(400).json({ error: 'Akun yang sedang dipakai tidak bisa dinonaktifkan sendiri' });
          return;
        }
        if (current.active === 1 && countActiveAdmins(db) <= 1) {
          res.status(400).json({ error: 'Akun admin terakhir tidak bisa dinonaktifkan' });
          return;
        }
      }
      active = body.active;
    }
    try {
      const admin = updateAdmin(db, id, { username, passwordHash, active });
      res.json({ admin: publicAdmin(admin) });
    } catch (error) {
      if (uniqueError(error)) {
        res.status(409).json({ error: 'Username sudah dipakai' });
        return;
      }
      throw error;
    }
  }));

  app.get('/api/admin/payments', requireAdmin, (req, res) => {
    res.json({
      payments: listPayments(db).map((row) => {
        const waiting = row.midtrans_status === 'pending' && row.signal_status === 'none';
        const payment = {
          id: row.id,
          order_id: row.order_id,
          token_id: row.token_id,
          price: row.price,
          play_count: row.play_count,
          midtrans_transaction_id: row.midtrans_transaction_id,
          midtrans_status: row.midtrans_status,
          fraud_status: row.fraud_status,
          signal_status: row.signal_status,
          expires_at: row.expires_at,
          signal_queued_at: row.signal_queued_at,
          signal_accepted_at: row.signal_accepted_at,
          signal_done_at: row.signal_done_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
        if (waiting && row.qr_image) payment.qr_data_url = row.qr_image;
        return payment;
      }),
    });
  });

  app.post('/api/admin/payments/:id/skip', requireAdmin, (req, res) => {
    const id = routeId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Pembayaran tidak valid' });
      return;
    }
    const result = skipPendingPayment(db, id);
    if (result.error === 'not_found') {
      res.status(404).json({ error: 'Pembayaran tidak ditemukan' });
      return;
    }
    if (result.error === 'not_skippable') {
      res.status(409).json({ error: 'Hanya pembayaran yang masih menunggu dan belum mengirim sinyal yang bisa dilewati' });
      return;
    }
    res.json({ ok: true });
  });

  function relayDefaults() {
    return {
      onMs: Number.isInteger(config.relayOnMs) ? config.relayOnMs : 80,
      gapMs: Number.isInteger(config.relayGapMs) ? config.relayGapMs : 200,
    };
  }

  app.get('/api/admin/relay', requireAdmin, (req, res) => {
    const timing = getRelayTiming(db, relayDefaults());
    res.json({ on_ms: timing.onMs, gap_ms: timing.gapMs });
  });

  app.patch('/api/admin/relay', requireAdmin, (req, res) => {
    const onMs = req.body?.on_ms;
    const gapMs = req.body?.gap_ms;
    const result = setRelayTiming(db, { onMs, gapMs });
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ on_ms: result.onMs, gap_ms: result.gapMs });
  });

  app.post('/api/admin/relay/test', requireAdmin, (req, res) => {
    if (!config.localRelay || typeof manualRelay !== 'function') {
      res.status(409).json({ error: 'Relay GPIO tidak aktif' });
      return;
    }
    const pulses = req.body?.pulses === undefined ? 1 : req.body.pulses;
    const result = manualRelay(pulses);
    if (result.error === 'invalid') {
      res.status(400).json({ error: 'Jumlah pulsa uji harus 1 sampai 20' });
      return;
    }
    if (result.error === 'busy') {
      res.status(409).json({ error: 'Relay sedang mengirim sinyal' });
      return;
    }
    res.json({ ok: true, pulses: result.pulses });
  });

  app.get('/api/admin/tokens', requireAdmin, (req, res) => {
    res.json({
      tokens: listTokens(db).map((row) => ({
        ...publicToken(row),
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    });
  });

  app.post('/api/admin/tokens', requireAdmin, (req, res) => {
    const price = req.body?.price;
    const playCount = req.body?.play_count;
    if (typeof price !== 'number' || !Number.isInteger(price) || price < 1 || price > 10_000_000) {
      res.status(400).json({ error: 'Harga harus bilangan bulat rupiah, 1 sampai 10000000' });
      return;
    }
    if (typeof playCount !== 'number' || !Number.isInteger(playCount) || playCount < 1 || playCount > 100) {
      res.status(400).json({ error: 'Jumlah main harus 1 sampai 100' });
      return;
    }
    const token = insertToken(db, { price, playCount });
    res.status(201).json({ token: publicToken(token) });
  });

  app.patch('/api/admin/tokens/:id', requireAdmin, (req, res) => {
    const id = routeId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Token tidak valid' });
      return;
    }
    const current = findToken(db, id);
    if (!current) {
      res.status(404).json({ error: 'Token tidak ditemukan' });
      return;
    }
    const body = req.body || {};
    const hasPrice = Object.hasOwn(body, 'price');
    const hasPlays = Object.hasOwn(body, 'play_count');
    const hasActive = Object.hasOwn(body, 'active');
    if (!hasPrice && !hasPlays && !hasActive) {
      res.status(400).json({ error: 'Tidak ada perubahan' });
      return;
    }
    let price;
    if (hasPrice) {
      price = body.price;
      if (typeof price !== 'number' || !Number.isInteger(price) || price < 1 || price > 10_000_000) {
        res.status(400).json({ error: 'Harga harus bilangan bulat rupiah, 1 sampai 10000000' });
        return;
      }
    }
    let playCount;
    if (hasPlays) {
      playCount = body.play_count;
      if (typeof playCount !== 'number' || !Number.isInteger(playCount) || playCount < 1 || playCount > 100) {
        res.status(400).json({ error: 'Jumlah main harus 1 sampai 100' });
        return;
      }
    }
    if (hasActive && typeof body.active !== 'boolean') {
      res.status(400).json({ error: 'Status aktif tidak valid' });
      return;
    }
    const token = updateToken(db, id, { price, playCount, active: hasActive ? body.active : undefined });
    res.json({ token: publicToken(token) });
  });

  app.get('/api/tokens', (req, res) => {
    res.json({
      tokens: listTokens(db, { activeOnly: true }).map((row) => ({
        id: row.id,
        price: row.price,
        play_count: row.play_count,
      })),
    });
  });

  app.post('/api/payments', asyncRoute(async (req, res) => {
    const tokenId = asId(req.body?.token_id);
    if (!tokenId) {
      res.status(400).json({ error: 'Token tidak valid' });
      return;
    }
    const token = findToken(db, tokenId);
    if (!token || token.active !== 1) {
      res.status(404).json({ error: 'Token tidak tersedia' });
      return;
    }
    const orderId = `claw_${crypto.randomBytes(16).toString('hex')}`;
    let charge;
    try {
      charge = await midtrans.charge({
        orderId,
        grossAmount: token.price,
        playCount: token.play_count,
        expiryMinutes: config.paymentExpiryMinutes,
      });
    } catch (error) {
      console.error('Charge QRIS gagal:', error.message);
      res.status(502).json({ error: 'Pembayaran QRIS gagal dibuat. Periksa Server Key sandbox dan coba lagi.' });
      return;
    }
    if (String(charge.status_code) !== '201') {
      res.status(502).json({ error: 'Pembayaran QRIS gagal dibuat. Periksa Server Key sandbox dan coba lagi.' });
      return;
    }
    let qrImage = '';
    if (typeof charge.qr_string === 'string' && charge.qr_string.length > 0) {
      qrImage = await QRCode.toDataURL(charge.qr_string, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 360,
      });
    }
    if (!qrImage) qrImage = await midtrans.downloadQrImage(charge);
    if (!qrImage.startsWith('data:image/png;base64,')) {
      res.status(502).json({ error: 'QRIS gagal dibuat' });
      return;
    }
    const expiresAt = new Date(Date.now() + config.paymentExpiryMinutes * 60 * 1000).toISOString();
    const payment = insertPayment(db, {
      orderId,
      tokenId: token.id,
      price: token.price,
      playCount: token.play_count,
      transactionId: typeof charge.transaction_id === 'string' ? charge.transaction_id : '',
      midtransStatus: typeof charge.transaction_status === 'string' ? charge.transaction_status : 'pending',
      fraudStatus: typeof charge.fraud_status === 'string' ? charge.fraud_status : null,
      qrString: typeof charge.qr_string === 'string' ? charge.qr_string : '',
      qrImage,
      qrLink: qrActionUrl(charge),
      expiresAt,
    });
    if (payment.midtrans_status === 'settlement') {
      recordGatewayUpdate(db, {
        ...charge,
        order_id: orderId,
        gross_amount: typeof charge.gross_amount === 'string' ? charge.gross_amount : `${token.price}.00`,
      });
    }
    const stored = findPaymentByOrderId(db, orderId);
    res.status(201).json({
      ...publicPayment(stored, { includeQr: true }),
      sandbox: !config.midtransProduction,
    });
  }));

  async function refreshPayment(payment) {
    if (payment.midtrans_status !== 'pending') return findPaymentByOrderId(db, payment.order_id);
    const now = Date.now();
    const last = statusCheckedAt.get(payment.order_id) || 0;
    if (now - last < 2000) return payment;
    statusCheckedAt.set(payment.order_id, now);
    try {
      const remote = await midtrans.getStatus(payment.order_id);
      if (!verifySignature(remote, config.midtransServerKey)) {
        console.error('Status Midtrans ditolak karena tanda tangan tidak cocok:', payment.order_id);
        return payment;
      }
      recordGatewayUpdate(db, remote);
    } catch (error) {
      console.error('Status Midtrans gagal diambil:', error.message);
    }
    return findPaymentByOrderId(db, payment.order_id);
  }

  app.get('/api/payments/:orderId', asyncRoute(async (req, res) => {
    if (!/^claw_[a-f0-9]{32}$/.test(req.params.orderId)) {
      res.status(400).json({ error: 'Pembayaran tidak valid' });
      return;
    }
    const payment = findPaymentByOrderId(db, req.params.orderId);
    if (!payment) {
      res.status(404).json({ error: 'Pembayaran tidak ditemukan' });
      return;
    }
    const current = await refreshPayment(payment);
    const pending = current.midtrans_status === 'pending' && current.signal_status === 'none';
    res.json({
      ...publicPayment(current, { includeQr: pending }),
      sandbox: !config.midtransProduction,
    });
  }));

  app.post('/api/midtrans/notification', (req, res) => {
    const body = req.body;
    if (!verifySignature(body, config.midtransServerKey)) {
      res.status(403).json({ error: 'Tanda tangan tidak valid' });
      return;
    }
    const result = recordGatewayUpdate(db, body);
    if (result.queued) {
      console.log(`Sinyal diantrekan untuk ${body.order_id}`);
    } else if (result.reason) {
      console.log(`Notifikasi ${body.order_id} tidak mengantrekan sinyal: ${result.reason}`);
    }
    res.json({ received: true });
  });

  function rejectExternalDevice(req, res, next) {
    if (!config.localRelay) {
      next();
      return;
    }
    res.status(409).json({ error: 'Sinyal dikirim oleh GPIO Raspberry Pi' });
  }

  app.get('/api/machine/jobs', rejectExternalDevice, requireDevice, (req, res) => {
    const job = claimNextJob(db, deviceHash(req.headers['x-device-token']));
    res.json({ job });
  });

  app.post('/api/machine/jobs/:id/complete', rejectExternalDevice, requireDevice, (req, res) => {
    const id = routeId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Pembayaran tidak valid' });
      return;
    }
    const result = completeJob(db, id);
    if (result.error === 'not_found') {
      res.status(404).json({ error: 'Pembayaran tidak ditemukan' });
      return;
    }
    if (result.error === 'not_accepted') {
      res.status(409).json({ error: 'Sinyal belum diambil perangkat' });
      return;
    }
    res.json({ ok: true, already: Boolean(result.already) });
  });

  app.get('/admin', (req, res) => {
    res.redirect('/admin.html');
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Tidak ditemukan' });
  });
  app.use(express.static(publicDir, { maxAge: 0 }));

  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'JSON tidak valid' });
      return;
    }
    console.error(error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ error: 'Terjadi kesalahan di server' });
  });

  return app;
}
