import path from 'node:path';
import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { assertRuntimeConfig, configFromEnv, loadEnvFile } from './config.js';
import { countAdmins, getRelayTiming, insertAdmin, openDatabase } from './db.js';
import { createPiRelay } from './gpio-relay.js';
import { startLocalRelay } from './local-relay.js';
import { createMidtransClient } from './midtrans.js';

loadEnvFile();
const config = configFromEnv();
const db = openDatabase(config.dbPath);
const needsSeed = countAdmins(db) === 0;
assertRuntimeConfig(config, { needsSeed });
if (needsSeed) {
  insertAdmin(db, {
    username: config.adminUsername,
    passwordHash: bcrypt.hashSync(config.adminPassword, 10),
  });
  console.log(`Admin awal dibuat: ${config.adminUsername}`);
}

const midtrans = createMidtransClient({
  serverKey: config.midtransServerKey,
  production: config.midtransProduction,
  notificationUrl: config.notificationUrl,
  acquirer: config.qrisAcquirer,
});
const relayApi = {
  requestManual() {
    return { error: 'inactive' };
  },
};
let localRelay = null;
const app = createApp({
  db,
  config,
  midtrans,
  manualRelay: (pulses) => relayApi.requestManual(pulses),
  onResetHistory(ids) {
    return localRelay ? localRelay.abandonMatching(ids) : undefined;
  },
});
if (config.localRelay) {
  localRelay = startLocalRelay({
    db,
    relay: createPiRelay({
      pin: config.relayGpio,
      activeHigh: config.relayActiveHigh,
    }),
    stateFile: path.join(path.dirname(config.dbPath), 'relay-state.json'),
    getTiming: () => getRelayTiming(db, {
      onMs: config.relayOnMs,
      gapMs: config.relayGapMs,
    }),
  });
  relayApi.requestManual = localRelay.requestManual;
  const level = config.relayActiveHigh ? 'HIGH' : 'LOW';
  console.log(`Relay GPIO BCM ${config.relayGpio}, kontak tertutup saat pin ${level}`);
}

const server = app.listen(config.port, () => {
  console.log(`Server berjalan di http://localhost:${config.port}`);
  console.log(`Midtrans: ${config.midtransProduction ? 'production' : 'sandbox'}`);
  console.log('Halaman pembeli: /');
  console.log('Halaman admin: /admin');
});

let closing = false;

function shutdown() {
  if (closing) return;
  closing = true;
  const done = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  if (!localRelay) {
    done();
    return;
  }
  const timer = setTimeout(done, 2000);
  localRelay.stop().then(() => {
    clearTimeout(timer);
    done();
  }, () => {
    clearTimeout(timer);
    done();
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
