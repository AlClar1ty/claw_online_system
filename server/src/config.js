import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnvFile(file = path.join(serverRoot, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function configFromEnv(env = process.env) {
  const deviceTokens = String(env.DEVICE_TOKEN || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const dbPath = env.DB_PATH
    ? path.resolve(serverRoot, env.DB_PATH)
    : path.join(serverRoot, 'data', 'app.db');
  return {
    port: Number(env.PORT || 3000),
    jwtSecret: env.JWT_SECRET || '',
    deviceTokens,
    midtransServerKey: env.MIDTRANS_SERVER_KEY || '',
    midtransProduction: env.MIDTRANS_IS_PRODUCTION === 'true',
    notificationUrl: env.MIDTRANS_NOTIFICATION_URL || '',
    qrisAcquirer: env.MIDTRANS_QRIS_ACQUIRER || 'gopay',
    paymentExpiryMinutes: Number(env.PAYMENT_EXPIRY_MINUTES || 15),
    cookieSecure: env.COOKIE_SECURE === 'true',
    adminUsername: String(env.ADMIN_USERNAME || '').trim(),
    adminPassword: env.ADMIN_PASSWORD || '',
    dbPath,
    localRelay: env.LOCAL_RELAY === 'true',
    relayGpio: Number(env.RELAY_GPIO ?? 17),
    relayActiveHigh: env.RELAY_ACTIVE_HIGH !== 'false',
    relayOnMs: Number(env.RELAY_ON_MS ?? 80),
    relayGapMs: Number(env.RELAY_GAP_MS ?? 200),
  };
}

export function assertRuntimeConfig(config, { needsSeed }) {
  const missing = [];
  if (!config.jwtSecret || config.jwtSecret.length < 24) missing.push('JWT_SECRET');
  if (!config.midtransServerKey) missing.push('MIDTRANS_SERVER_KEY');
  if (config.deviceTokens.length === 0) missing.push('DEVICE_TOKEN');
  if (needsSeed) {
    if (!config.adminUsername) missing.push('ADMIN_USERNAME');
    if (!config.adminPassword) missing.push('ADMIN_PASSWORD');
  }
  if (missing.length > 0) {
    throw new Error(`Environment belum lengkap: ${missing.join(', ')}`);
  }
  if (needsSeed && config.adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD minimal 8 karakter');
  }
  if (!['gopay', 'airpay shopee'].includes(config.qrisAcquirer)) {
    throw new Error('MIDTRANS_QRIS_ACQUIRER harus gopay atau airpay shopee');
  }
  if (
    !Number.isInteger(config.paymentExpiryMinutes) ||
    config.paymentExpiryMinutes < 1 ||
    config.paymentExpiryMinutes > 60
  ) {
    throw new Error('PAYMENT_EXPIRY_MINUTES harus bilangan bulat 1 sampai 60');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT tidak valid');
  }
  if (!config.localRelay) return;
  if (!Number.isInteger(config.relayGpio) || config.relayGpio < 2 || config.relayGpio > 27) {
    throw new Error('RELAY_GPIO harus nomor BCM 2 sampai 27');
  }
  if (!Number.isInteger(config.relayOnMs) || config.relayOnMs < 20 || config.relayOnMs > 500) {
    throw new Error('RELAY_ON_MS harus bilangan bulat 20 sampai 500');
  }
  if (!Number.isInteger(config.relayGapMs) || config.relayGapMs < 0 || config.relayGapMs > 2000) {
    throw new Error('RELAY_GAP_MS harus bilangan bulat 0 sampai 2000');
  }
}
