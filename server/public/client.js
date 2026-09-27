const app = document.querySelector('#app');
const storageKey = 'claw-payment';
let pollTimer = 0;

function rupiah(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
}

function playLabel(count) {
  return `${count} main`;
}

function stopPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = 0;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal');
  return data;
}

function outcome(payment) {
  if (['queued', 'accepted', 'done'].includes(payment.signal_status)) return 'success';
  if (payment.midtrans_status === 'expire') return 'expired';
  if (['deny', 'cancel', 'failure'].includes(payment.midtrans_status)) return 'failed';
  if (payment.midtrans_status === 'settlement') return 'failed';
  return 'pending';
}

function statusText(payment) {
  const state = outcome(payment);
  if (state === 'success' && payment.signal_status === 'done') {
    return 'Pembayaran berhasil. Mesin sudah menerima sinyal main.';
  }
  if (state === 'success') return 'Pembayaran berhasil. Sinyal main sedang dikirim ke mesin.';
  if (state === 'expired') return 'Pembayaran kedaluwarsa.';
  if (state === 'failed') return 'Pembayaran gagal.';
  return 'Menunggu pembayaran';
}

function isQr(value) {
  return typeof value === 'string' && value.startsWith('data:image/png;base64,');
}

function renderList(tokens, message = '') {
  stopPoll();
  app.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Pilih main';
  app.append(title);
  if (message) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = message;
    app.append(note);
  }
  if (tokens.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lead';
    empty.textContent = 'Belum ada token aktif.';
    app.append(empty);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const token of tokens) {
    const button = document.createElement('button');
    button.className = 'ticket';
    button.type = 'button';
    const plays = document.createElement('span');
    plays.className = 'plays';
    plays.textContent = playLabel(token.play_count);
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = rupiah(token.price);
    button.append(plays, price);
    button.addEventListener('click', () => chooseToken(button, tokens));
    button.dataset.id = String(token.id);
    grid.append(button);
  }
  app.append(grid);
}

async function chooseToken(button, tokens) {
  const id = Number(button.dataset.id);
  for (const item of app.querySelectorAll('button')) item.disabled = true;
  try {
    const payment = await api('/api/payments', { method: 'POST', body: { token_id: id } });
    sessionStorage.setItem(storageKey, payment.order_id);
    renderPayment(payment);
  } catch (error) {
    renderList(tokens, error.message);
  }
}

function renderPayment(payment, extra = '') {
  stopPoll();
  app.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'panel';
  const plays = document.createElement('h1');
  plays.textContent = playLabel(payment.play_count);
  const price = document.createElement('p');
  price.className = 'price';
  price.textContent = rupiah(payment.price);
  panel.append(plays, price);

  if (isQr(payment.qr_data_url) && outcome(payment) === 'pending') {
    const image = document.createElement('img');
    image.className = 'qr';
    image.alt = 'QRIS pembayaran';
    image.src = payment.qr_data_url;
    panel.append(image);
  }

  const status = document.createElement('p');
  const state = outcome(payment);
  status.className = `status ${state}`;
  status.setAttribute('role', 'status');
  status.textContent = extra || statusText(payment);
  panel.append(status);

  if (payment.expires_at && state === 'pending') {
    const meta = document.createElement('p');
    meta.className = 'meta';
    const when = new Date(payment.expires_at);
    meta.textContent = `Berlaku sampai ${when.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Jakarta',
    })}`;
    panel.append(meta);
  }

  if (payment.sandbox && payment.qr_link && state === 'pending') {
    const box = document.createElement('div');
    box.className = 'sandbox';
    const hint = document.createElement('p');
    hint.textContent = 'Mode sandbox. Tempel URL gambar QR ini ke simulator QRIS Midtrans, lalu bayar lewat ShopeePay di simulator. QR yang dibuat dengan acquirer GoPay sering ditolak simulator (error 116).';
    const link = document.createElement('code');
    link.textContent = payment.qr_link.startsWith('https://') ? payment.qr_link : '';
    box.append(hint, link);
    panel.append(box);
  }

  const back = document.createElement('button');
  back.className = state === 'pending' ? 'secondary' : 'back';
  back.type = 'button';
  back.textContent = 'Kembali ke daftar token';
  back.addEventListener('click', () => {
    sessionStorage.removeItem(storageKey);
    loadList();
  });
  panel.append(back);

  app.append(panel);
  if (state === 'pending') schedulePoll(payment.order_id);
}

function schedulePoll(orderId) {
  pollTimer = setTimeout(() => refreshPayment(orderId), 2000);
}

async function refreshPayment(orderId) {
  try {
    const payment = await api(`/api/payments/${orderId}`);
    renderPayment(payment);
  } catch (error) {
    const status = app.querySelector('.status');
    if (status) status.textContent = `${error.message} Mencoba lagi.`;
    schedulePoll(orderId);
  }
}

async function loadList() {
  stopPoll();
  try {
    const data = await api('/api/tokens');
    renderList(data.tokens || []);
  } catch (error) {
    app.replaceChildren();
    const title = document.createElement('h1');
    title.textContent = 'Pilih main';
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = error.message;
    app.append(title, note);
  }
}

const saved = sessionStorage.getItem(storageKey);
if (saved && /^claw_[a-f0-9]{32}$/.test(saved)) {
  refreshPayment(saved);
} else {
  loadList();
}
