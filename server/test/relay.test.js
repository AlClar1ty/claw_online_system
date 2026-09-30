import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import {
  claimNextJob,
  findPaymentById,
  insertPayment,
  insertToken,
  openDatabase,
  recordGatewayUpdate,
} from '../src/db.js';
import { LOCAL_OWNER, startLocalRelay } from '../src/local-relay.js';

function queuePayment(db, { orderId, playCount, price = 1000 }) {
  const token = insertToken(db, { price, playCount });
  insertPayment(db, {
    orderId,
    tokenId: token.id,
    price,
    playCount,
    transactionId: 'tx',
    midtransStatus: 'pending',
    fraudStatus: 'accept',
    qrString: 'q',
    qrImage: '',
    qrLink: '',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const queued = recordGatewayUpdate(db, {
    order_id: orderId,
    transaction_status: 'settlement',
    payment_type: 'qris',
    fraud_status: 'accept',
    gross_amount: `${price}.00`,
    status_code: '200',
    transaction_id: 'tx',
  });
  assert.equal(queued.queued, true);
}

function fakeRelay() {
  const events = [];
  return {
    events,
    async setClosed(closed) {
      events.push(closed ? 'on' : 'off');
    },
    async close() {
      events.push('close');
    },
  };
}

function pulses(events) {
  return events.filter((event) => event === 'on').length;
}

async function waitFor(check) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waktu habis');
}

test('GPIO mengirim pulsa sesuai jumlah main, lalu menutup antrean', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-relay-'));
  const db = openDatabase(':memory:');
  const relay = fakeRelay();
  queuePayment(db, { orderId: 'claw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', playCount: 2 });
  queuePayment(db, { orderId: 'claw_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', playCount: 1 });
  const runner = startLocalRelay({
    db,
    relay,
    stateFile: path.join(dir, 'relay-state.json'),
    onMs: 15,
    gapMs: 15,
    pollMs: 15,
    log() {},
  });

  try {
    await waitFor(() => findPaymentById(db, 1).signal_status === 'done'
      && findPaymentById(db, 2).signal_status === 'done');
    assert.equal(pulses(relay.events), 3);
    assert.equal(relay.events[relay.events.length - 1], 'off');
    assert.equal(fs.existsSync(path.join(dir, 'relay-state.json')), false);
  } finally {
    await runner.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sisa pulsa yang tersimpan tidak diulang dari nol', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-relay-'));
  const stateFile = path.join(dir, 'relay-state.json');
  const db = openDatabase(':memory:');
  const relay = fakeRelay();
  queuePayment(db, { orderId: 'claw_cccccccccccccccccccccccccccccccc', playCount: 3 });
  const claimed = claimNextJob(db, LOCAL_OWNER);
  assert.equal(claimed.pulses, 3);
  fs.writeFileSync(stateFile, JSON.stringify({ paymentId: claimed.payment_id, remain: 1 }));
  const runner = startLocalRelay({
    db,
    relay,
    stateFile,
    onMs: 15,
    gapMs: 15,
    pollMs: 15,
    log() {},
  });

  try {
    await waitFor(() => findPaymentById(db, claimed.payment_id).signal_status === 'done');
    assert.equal(pulses(relay.events), 1);
  } finally {
    await runner.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pekerjaan yang sudah dipegang perangkat lain dikembalikan ke GPIO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-relay-'));
  const db = openDatabase(':memory:');
  const relay = fakeRelay();
  queuePayment(db, { orderId: 'claw_dddddddddddddddddddddddddddddddd', playCount: 1 });
  claimNextJob(db, 'perangkat-lain');
  const runner = startLocalRelay({
    db,
    relay,
    stateFile: path.join(dir, 'relay-state.json'),
    onMs: 15,
    gapMs: 15,
    pollMs: 15,
    log() {},
  });

  try {
    await waitFor(() => findPaymentById(db, 1).signal_status === 'done');
    assert.equal(pulses(relay.events), 1);
  } finally {
    await runner.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sinyal uji menutup kontak tanpa membuat pembayaran', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-relay-'));
  const db = openDatabase(':memory:');
  const relay = fakeRelay();
  const runner = startLocalRelay({
    db,
    relay,
    stateFile: path.join(dir, 'relay-state.json'),
    onMs: 10,
    gapMs: 10,
    pollMs: 15,
    log() {},
  });

  try {
    const first = runner.requestManual(2);
    const second = runner.requestManual(1);
    assert.equal(first.ok, true);
    assert.equal(second.error, 'busy');
    await waitFor(() => pulses(relay.events) >= 2);
    assert.equal(pulses(relay.events), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
  } finally {
    await runner.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antrean HTTP ditolak saat relay lokal aktif', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({
    db,
    config: {
      localRelay: true,
      deviceTokens: ['device-token-test-0123456789'],
      jwtSecret: 'rahasia-uji-relay-lokal-012345',
      cookieSecure: false,
    },
    midtrans: {},
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/machine/jobs`, {
      headers: { 'X-Device-Token': 'device-token-test-0123456789' },
    });
    assert.equal(response.status, 409);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
  }
});
