import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../gpio_relay.py', import.meta.url));

export function createPiRelay({
  pin,
  activeHigh,
  python = 'python3',
  script = scriptPath,
}) {
  const child = spawn(python, [script, String(pin), activeHigh ? '1' : '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const waiters = [];
  let failed = null;

  function fail(error) {
    if (failed) return;
    failed = error;
    while (waiters.length > 0) waiters.shift().reject(error);
  }

  function pushLine(line) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) pushLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`Relay GPIO: ${text}`);
  });
  child.on('error', (error) => fail(error));
  child.on('exit', (code) => {
    fail(new Error(`Proses relay berhenti (kode ${code})`));
  });

  function nextLine() {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  const ready = nextLine().then((line) => {
    if (line !== 'ready') throw new Error(`Relay GPIO tidak siap: ${line}`);
  });

  return {
    async setClosed(closed) {
      await ready;
      if (failed) throw failed;
      child.stdin.write(closed ? '1\n' : '0\n');
      const line = await nextLine();
      if (line !== 'ok') throw new Error(`Relay GPIO menolak perintah: ${line}`);
    },
    async close() {
      if (failed || child.exitCode !== null) return;
      child.stdin.write('quit\n');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve();
        }, 1000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
