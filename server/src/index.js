import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { assertRuntimeConfig, configFromEnv, loadEnvFile } from './config.js';
import { countAdmins, insertAdmin, openDatabase } from './db.js';
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
const app = createApp({ db, config, midtrans });
const server = app.listen(config.port, () => {
  console.log(`Server berjalan di http://localhost:${config.port}`);
  console.log(`Midtrans: ${config.midtransProduction ? 'production' : 'sandbox'}`);
  console.log('Halaman pembeli: /');
  console.log('Halaman admin: /admin');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
