import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { claimNextJob, completeJob, findPaymentById, releaseForeignJobs } from './db.js';

export const LOCAL_OWNER = crypto.createHash('sha256').update('raspberry-gpio').digest('hex');

function readState(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const paymentId = Number(parsed.paymentId);
  const remain = Number(parsed.remain);
  if (!Number.isInteger(paymentId) || paymentId < 1) {
    throw new Error('Status relay tidak valid');
  }
  if (!Number.isInteger(remain) || remain < 0 || remain > 100) {
    throw new Error('Sisa pulsa relay tidak valid');
  }
  return { paymentId, remain };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
}

function clearState(file) {
  fs.rmSync(file, { force: true });
}

export function startLocalRelay({
  db,
  relay,
  stateFile,
  onMs,
  gapMs,
  pollMs = 250,
  owner = LOCAL_OWNER,
  getTiming,
  log = console.log,
}) {
  let stopped = false;
  let pendingWait = null;
  let manualRemain = 0;
  let dropJob = false;
  releaseForeignJobs(db, owner);

  function sleep(ms) {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingWait = null;
        resolve();
      }, ms);
      pendingWait = { timer, resolve };
    });
  }

  function wake() {
    if (!pendingWait) return;
    clearTimeout(pendingWait.timer);
    const { resolve } = pendingWait;
    pendingWait = null;
    resolve();
  }

  function jobDropped() {
    if (!dropJob) return false;
    dropJob = false;
    clearState(stateFile);
    return true;
  }

  async function finishPayment(paymentId) {
    const result = completeJob(db, paymentId);
    if (result.ok) {
      clearState(stateFile);
      log(`Sinyal GPIO selesai untuk pembayaran ${paymentId}`);
      return true;
    }
    if (result.error === 'not_found') {
      clearState(stateFile);
      return true;
    }
    return false;
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        log(`Relay gagal: ${error.message}`);
        try {
          await relay.setClosed(false);
        } catch {
          // Pin dimatikan lagi pada percobaan berikutnya.
        }
        await sleep(1000);
      }
    }
    try {
      await relay.setClosed(false);
    } catch {
      // Proses relay mungkin sudah berhenti.
    }
  })();

  async function tick() {
      if (jobDropped()) {
        await relay.setClosed(false);
        return;
      }
      let state = null;
      try {
        state = readState(stateFile);
      } catch (error) {
        log(`Status relay tidak dibaca: ${error.message}`);
        await sleep(1000);
        return;
      }

      if (!state && manualRemain > 0) {
        await relay.setClosed(true);
        const timing = typeof getTiming === 'function' ? getTiming() : { onMs, gapMs };
        log(`Sinyal uji, sisa ${manualRemain}`);
        await sleep(timing.onMs);
        await relay.setClosed(false);
        if (stopped || jobDropped()) return;
        manualRemain -= 1;
        log(`Pulsa uji selesai, sisa ${manualRemain}`);
        if (manualRemain > 0) await sleep(timing.gapMs);
        return;
      }

      if (!state) {
        const job = claimNextJob(db, owner);
        if (!job) {
          await sleep(pollMs);
          return;
        }
        if (!Number.isInteger(job.pulses) || job.pulses < 1 || job.pulses > 100) {
          log(`Antrean ${job.payment_id} diabaikan`);
          await sleep(1000);
          return;
        }
        state = { paymentId: job.payment_id, remain: job.pulses };
        writeState(stateFile, state);
        log(`Antrean ${state.paymentId} disimpan, ${state.remain} pulsa`);
      }

      const payment = findPaymentById(db, state.paymentId);
      if (!payment || payment.signal_status === 'done') {
        clearState(stateFile);
        return;
      }

      if (state.remain === 0) {
        if (!(await finishPayment(state.paymentId))) await sleep(1000);
        return;
      }

      await relay.setClosed(true);
      const timing = typeof getTiming === 'function' ? getTiming() : { onMs, gapMs };
      log(`Kontak GPIO tertutup, sisa ${state.remain}`);
      await sleep(timing.onMs);
      await relay.setClosed(false);
      if (stopped || jobDropped()) return;
      state = { paymentId: state.paymentId, remain: state.remain - 1 };
      writeState(stateFile, state);
      log(`Pulsa selesai, sisa ${state.remain}`);
      if (state.remain > 0) await sleep(timing.gapMs);
  }

  return {
    done: loop,
    requestManual(pulses) {
      if (!Number.isInteger(pulses) || pulses < 1 || pulses > 20) return { error: 'invalid' };
      if (manualRemain > 0) return { error: 'busy' };
      try {
        const state = readState(stateFile);
        if (state && state.remain > 0) return { error: 'busy' };
      } catch {
        return { error: 'busy' };
      }
      manualRemain = pulses;
      wake();
      return { ok: true, pulses };
    },
    abandon() {
      dropJob = true;
      manualRemain = 0;
      clearState(stateFile);
      wake();
      return relay.setClosed(false).catch(() => {});
    },
    abandonMatching(ids) {
      let state = null;
      try {
        state = readState(stateFile);
      } catch {
        return undefined;
      }
      if (!state || !ids.includes(state.paymentId)) return undefined;
      return this.abandon();
    },
    async stop() {
      stopped = true;
      wake();
      await loop;
      await relay.close();
    },
  };
}
