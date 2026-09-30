import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { insertAdmin, openDatabase } from '../src/db.js';
import { signatureFor } from '../src/midtrans.js';

const serverKey = 'test-server-key-sandbox-0123456789';
const deviceToken = 'device-token-test-0123456789';
const db = openDatabase(':memory:');
const charges = [];
const statuses = new Map();

insertAdmin(db, {
  username: 'admin',
  passwordHash: bcrypt.hashSync('kata-sandi-admin', 10),
});

const midtrans = {
  async charge(input) {
    charges.push(input);
    return {
      status_code: '201',
      transaction_id: `tx-${charges.length}`,
      transaction_status: 'pending',
      fraud_status: 'accept',
      payment_type: 'qris',
      gross_amount: `${input.grossAmount}.00`,
      qr_string: `QRIS-${input.orderId}`,
      actions: [
        {
          name: 'generate-qr-code',
          method: 'GET',
          url: `https://api.sandbox.midtrans.com/v2/qris/${input.orderId}/qr-code`,
        },
      ],
    };
  },
  async getStatus(orderId) {
    const body = statuses.get(orderId);
    if (!body) throw new Error('tidak ada');
    return body;
  },
  async downloadQrImage() {
    return '';
  },
};

const app = createApp({
  db,
  config: {
    jwtSecret: serverKey,
    deviceTokens: [deviceToken, 'device-token-lain-0123456789'],
    midtransServerKey: serverKey,
    midtransProduction: false,
    paymentExpiryMinutes: 15,
    cookieSecure: false,
  },
  midtrans,
});

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function notify(partial) {
  const { signature_key: override, ...rest } = partial;
  const body = {
    payment_type: 'qris',
    fraud_status: 'accept',
    transaction_id: 'tx-notify',
    ...rest,
  };
  body.signature_key = override || signatureFor(body, serverKey);
  return body;
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.device ? { 'X-Device-Token': options.device } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = {};
  if (text) data = JSON.parse(text);
  return { status: response.status, data, cookie: response.headers.get('set-cookie') };
}

let cookie = '';

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('admin, token, pembayaran, dan sinyal hanya sekali', async () => {
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(html.includes(serverKey), false);
  assert.equal(html.includes('SB-Mid'), false);
  const clientJs = await (await fetch(`${base}/client.js`)).text();
  assert.equal(clientJs.includes('api.midtrans.com'), false);

  const denied = await request('/api/admin/tokens');
  assert.equal(denied.status, 401);

  const badLogin = await request('/api/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'salah-sekali' },
  });
  assert.equal(badLogin.status, 401);

  const login = await request('/api/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'kata-sandi-admin' },
  });
  assert.equal(login.status, 200);
  cookie = login.cookie.split(';')[0];

  const selfOff = await request('/api/admin/admins/1', {
    method: 'PATCH',
    cookie,
    body: { active: false },
  });
  assert.equal(selfOff.status, 400);

  const createdAdmin = await request('/api/admin/admins', {
    method: 'POST',
    cookie,
    body: { username: 'kasir', password: 'kata-sandi-kasir' },
  });
  assert.equal(createdAdmin.status, 201);

  const off = await request(`/api/admin/admins/${createdAdmin.data.admin.id}`, {
    method: 'PATCH',
    cookie,
    body: { active: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.data.admin.active, false);

  const kasir = await request('/api/admin/login', {
    method: 'POST',
    body: { username: 'kasir', password: 'kata-sandi-kasir' },
  });
  assert.equal(kasir.status, 401);

  const renamed = await request(`/api/admin/admins/${createdAdmin.data.admin.id}`, {
    method: 'PATCH',
    cookie,
    body: { username: 'kasir2', password: 'kata-sandi-baru' },
  });
  assert.equal(renamed.status, 200);

  const token = await request('/api/admin/tokens', {
    method: 'POST',
    cookie,
    body: { price: 8000, play_count: 3 },
  });
  assert.equal(token.status, 201);
  const hidden = await request('/api/admin/tokens', {
    method: 'POST',
    cookie,
    body: { price: 5000, play_count: 1 },
  });
  await request(`/api/admin/tokens/${hidden.data.token.id}`, {
    method: 'PATCH',
    cookie,
    body: { active: false },
  });
  const edited = await request(`/api/admin/tokens/${token.data.token.id}`, {
    method: 'PATCH',
    cookie,
    body: { price: 9000, play_count: 2 },
  });
  assert.equal(edited.data.token.price, 9000);
  assert.equal(edited.data.token.play_count, 2);

  const publicTokens = await request('/api/tokens');
  assert.deepEqual(publicTokens.data.tokens, [{ id: token.data.token.id, price: 9000, play_count: 2 }]);

  const payment = await request('/api/payments', {
    method: 'POST',
    body: { token_id: token.data.token.id, price: 1 },
  });
  assert.equal(payment.status, 201);
  assert.equal(payment.data.price, 9000);
  assert.equal(payment.data.play_count, 2);
  assert.equal(payment.data.qr_data_url.startsWith('data:image/png;base64,'), true);
  assert.equal(charges[0].grossAmount, 9000);
  assert.equal(JSON.stringify(payment.data).includes(serverKey), false);

  const forged = await request('/api/midtrans/notification', {
    method: 'POST',
    body: notify({
      order_id: payment.data.order_id,
      status_code: '200',
      gross_amount: '9000.00',
      transaction_status: 'settlement',
      signature_key: 'salah',
    }),
  });
  assert.equal(forged.status, 403);

  const mismatch = await request('/api/midtrans/notification', {
    method: 'POST',
    body: notify({
      order_id: payment.data.order_id,
      status_code: '200',
      gross_amount: '1.00',
      transaction_status: 'settlement',
    }),
  });
  assert.equal(mismatch.status, 200);
  const still = await request(`/api/payments/${payment.data.order_id}`);
  assert.equal(still.data.signal_status, 'none');

  const machineDenied = await request('/api/machine/jobs');
  assert.equal(machineDenied.status, 401);
  const empty = await request('/api/machine/jobs', { device: deviceToken });
  assert.equal(empty.data.job, null);

  const expiredPayment = await request('/api/payments', {
    method: 'POST',
    body: { token_id: token.data.token.id },
  });
  await request('/api/midtrans/notification', {
    method: 'POST',
    body: notify({
      order_id: expiredPayment.data.order_id,
      status_code: '202',
      gross_amount: '9000.00',
      transaction_status: 'expire',
    }),
  });
  const expired = await request(`/api/payments/${expiredPayment.data.order_id}`);
  assert.equal(expired.data.midtrans_status, 'expire');
  assert.equal(expired.data.signal_status, 'none');

  const settled = await request('/api/midtrans/notification', {
    method: 'POST',
    body: notify({
      order_id: payment.data.order_id,
      status_code: '200',
      gross_amount: '9000.00',
      transaction_status: 'settlement',
    }),
  });
  assert.equal(settled.status, 200);
  await request('/api/midtrans/notification', {
    method: 'POST',
    body: notify({
      order_id: payment.data.order_id,
      status_code: '200',
      gross_amount: '9000.00',
      transaction_status: 'settlement',
    }),
  });

  const job = await request('/api/machine/jobs', { device: deviceToken });
  assert.deepEqual(job.data.job, { payment_id: 1, pulses: 2 });
  const recovered = await request('/api/machine/jobs', { device: deviceToken });
  assert.deepEqual(recovered.data.job, { payment_id: 1, pulses: 2 });
  const otherDevice = await request('/api/machine/jobs', { device: 'device-token-lain-0123456789' });
  assert.equal(otherDevice.data.job, null);

  const done = await request('/api/machine/jobs/1/complete', { method: 'POST', device: deviceToken });
  assert.equal(done.status, 200);
  const doneAgain = await request('/api/machine/jobs/1/complete', { method: 'POST', device: deviceToken });
  assert.equal(doneAgain.data.already, true);
  const after = await request(`/api/payments/${payment.data.order_id}`);
  assert.equal(after.data.midtrans_status, 'settlement');
  assert.equal(after.data.signal_status, 'done');

  const polled = await request('/api/payments', {
    method: 'POST',
    body: { token_id: token.data.token.id },
  });
  statuses.set(
    polled.data.order_id,
    notify({
      order_id: polled.data.order_id,
      status_code: '200',
      gross_amount: '9000.00',
      transaction_status: 'settlement',
    }),
  );
  const seen = await request(`/api/payments/${polled.data.order_id}`);
  assert.equal(seen.data.signal_status, 'queued');
  const claimed = await request('/api/machine/jobs', { device: deviceToken });
  assert.equal(claimed.data.job.pulses, 2);
  const lateExpire = await request('/api/midtrans/notification', {
    method: 'POST',
    body: notify({
      order_id: polled.data.order_id,
      status_code: '202',
      gross_amount: '9000.00',
      transaction_status: 'expire',
    }),
  });
  assert.equal(lateExpire.status, 200);
  const kept = await request('/api/machine/jobs/' + claimed.data.job.payment_id + '/complete', {
    method: 'POST',
    device: deviceToken,
  });
  assert.equal(kept.status, 200);

  const unpaid = await request('/api/payments', {
    method: 'POST',
    body: { token_id: token.data.token.id },
  });
  assert.equal(unpaid.status, 201);
  const withQr = await request('/api/admin/payments', { cookie });
  const waiting = withQr.data.payments.find((item) => item.order_id === unpaid.data.order_id);
  assert.equal(waiting.midtrans_status, 'pending');
  assert.equal(waiting.signal_status, 'none');
  assert.equal(waiting.qr_data_url.startsWith('data:image/png;base64,'), true);
  const skipped = await request(`/api/admin/payments/${waiting.id}/skip`, { method: 'POST', cookie });
  assert.equal(skipped.status, 200);
  const afterSkip = await request('/api/admin/payments', { cookie });
  assert.equal(afterSkip.data.payments.some((item) => item.id === waiting.id), false);
  const skipDone = await request('/api/admin/payments/1/skip', { method: 'POST', cookie });
  assert.equal(skipDone.status, 409);

  const relayDenied = await request('/api/admin/relay');
  assert.equal(relayDenied.status, 401);
  const relayDefaults = await request('/api/admin/relay', { cookie });
  assert.equal(relayDefaults.status, 200);
  assert.equal(relayDefaults.data.on_ms, 80);
  assert.equal(relayDefaults.data.gap_ms, 200);
  const relaySaved = await request('/api/admin/relay', {
    method: 'PATCH',
    cookie,
    body: { on_ms: 100, gap_ms: 250 },
  });
  assert.equal(relaySaved.status, 200);
  assert.deepEqual(relaySaved.data, { on_ms: 100, gap_ms: 250 });
  const relayAgain = await request('/api/admin/relay', { cookie });
  assert.equal(relayAgain.data.gap_ms, 250);
  const relayBad = await request('/api/admin/relay', {
    method: 'PATCH',
    cookie,
    body: { on_ms: 1, gap_ms: 10 },
  });
  assert.equal(relayBad.status, 400);
  const testDenied = await request('/api/admin/relay/test', { method: 'POST', cookie, body: { pulses: 1 } });
  assert.equal(testDenied.status, 409);

  const hiddenHistory = await request('/api/admin/payments');
  assert.equal(hiddenHistory.status, 401);
  const history = await request('/api/admin/payments', { cookie });
  assert.equal(history.status, 200);
  const recorded = history.data.payments.find((item) => item.order_id === payment.data.order_id);
  assert.equal(recorded.price, 9000);
  assert.equal(recorded.play_count, 2);
  assert.equal(recorded.midtrans_status, 'settlement');
  assert.equal(recorded.signal_status, 'done');
  assert.equal(Object.hasOwn(recorded, 'qr_string'), false);
  assert.equal(Object.hasOwn(recorded, 'qr_image'), false);
});
