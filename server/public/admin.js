const app = document.querySelector('#app');
let me = null;
let view = 'dashboard';

function rupiah(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
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
  if (!response.ok) {
    const error = new Error(data.error || 'Permintaan gagal');
    error.status = response.status;
    throw error;
  }
  return data;
}

function field(labelText, input) {
  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, input);
  return label;
}

function textInput(type, name, autocomplete) {
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.required = true;
  input.autocomplete = autocomplete;
  return input;
}

function renderLogin(message = '') {
  app.replaceChildren();
  const screen = document.createElement('div');
  screen.className = 'login-screen';
  const panel = document.createElement('form');
  panel.className = 'panel stack';
  const brand = document.createElement('p');
  brand.className = 'brand';
  brand.textContent = 'AlMa Claw System';
  const title = document.createElement('h1');
  title.textContent = 'Masuk admin';
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = message;
  const username = textInput('text', 'username', 'username');
  const password = textInput('password', 'password', 'current-password');
  const submit = document.createElement('button');
  submit.className = 'primary';
  submit.type = 'submit';
  submit.textContent = 'Masuk';
  panel.append(brand, title, field('Username', username), field('Kata sandi', password), note, submit);
  panel.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    note.textContent = '';
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        body: { username: username.value.trim(), password: password.value },
      });
      me = data.admin;
      await renderShell();
    } catch (error) {
      note.textContent = error.message;
      submit.disabled = false;
    }
  });
  screen.append(panel);
  app.append(screen);
  username.focus();
}

function shellButton(text, current, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-btn';
  button.textContent = text;
  if (current) button.setAttribute('aria-current', 'page');
  button.addEventListener('click', onClick);
  return button;
}

async function renderShell() {
  app.replaceChildren();
  const shell = document.createElement('div');
  shell.className = 'admin-shell';
  const side = document.createElement('aside');
  side.className = 'side';
  const brand = document.createElement('p');
  brand.className = 'brand';
  brand.textContent = 'AlMa Claw System';
  const who = document.createElement('p');
  who.textContent = me.username;
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'nav-btn logout';
  logout.textContent = 'Keluar';
  logout.addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    me = null;
    renderLogin();
  });
  side.append(
    brand,
    who,
    shellButton('Dashboard', view === 'dashboard', () => {
      view = 'dashboard';
      renderShell();
    }),
    shellButton('Token', view === 'tokens', () => {
      view = 'tokens';
      renderShell();
    }),
    shellButton('Riwayat', view === 'history', () => {
      view = 'history';
      renderShell();
    }),
    shellButton('Akses admin', view === 'admins', () => {
      view = 'admins';
      renderShell();
    }),
    shellButton('Relay', view === 'relay', () => {
      view = 'relay';
      renderShell();
    }),
    logout,
  );
  const content = document.createElement('main');
  content.className = 'content';
  shell.append(side, content);
  app.append(shell);
  if (view === 'admins') await renderAdmins(content);
  else if (view === 'history') await renderHistory(content);
  else if (view === 'relay') await renderRelay(content);
  else if (view === 'tokens') await renderTokens(content);
  else await renderDashboard(content);
}

function messageLine() {
  const note = document.createElement('p');
  note.className = 'note';
  return note;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function paymentLabel(status) {
  const labels = {
    pending: 'Menunggu',
    settlement: 'Berhasil',
    expire: 'Kedaluwarsa',
    deny: 'Ditolak',
    cancel: 'Dibatalkan',
    failure: 'Gagal',
  };
  return labels[status] || status || '—';
}

function signalLabel(status) {
  const labels = {
    none: 'Belum dikirim',
    queued: 'Diantrekan',
    accepted: 'Diambil mesin',
    done: 'Selesai',
  };
  return labels[status] || status || '—';
}

function statusBadge(text, kind) {
  const badge = document.createElement('span');
  badge.className = `badge ${kind}`;
  badge.textContent = text;
  return badge;
}

function paymentBadge(status) {
  if (status === 'settlement') return statusBadge(paymentLabel(status), 'on');
  if (status === 'pending') return statusBadge(paymentLabel(status), 'wait');
  return statusBadge(paymentLabel(status), 'bad');
}

function signalBadge(status) {
  if (status === 'done') return statusBadge(signalLabel(status), 'on');
  if (status === 'queued' || status === 'accepted') return statusBadge(signalLabel(status), 'wait');
  return statusBadge(signalLabel(status), 'off');
}

function detailRow(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value || '—';
  list.append(term, description);
}

function todayJakarta() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let historyFilter = null;

function currentHistoryFilter() {
  if (!historyFilter) {
    const today = todayJakarta();
    historyFilter = { from: today, to: today, payment: '', signal: '' };
  }
  return historyFilter;
}

function selectOption(value, label, selected) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  option.selected = value === selected;
  return option;
}

function averageText(value) {
  const number = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(value);
  return `${number} main`;
}

function dayLabel(date) {
  return date.slice(8, 10).replace(/^0/, '');
}

async function renderDashboard(content) {
  content.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Dashboard';
  const note = messageLine();
  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent = 'Uang masuk dan permainan dihitung dari pembayaran yang berhasil.';
  content.append(title, lead, note);
  let stats;
  try {
    stats = await api('/api/admin/dashboard');
  } catch (error) {
    note.textContent = error.message;
    return;
  }
  const cards = document.createElement('section');
  cards.className = 'stats';
  const items = [
    ['Uang masuk bulan ini', rupiah(stats.month_total)],
    ['Uang masuk hari ini', rupiah(stats.today_total)],
    ['Permainan hari ini', `${stats.today_transactions} transaksi`],
    ['Rata-rata token', averageText(stats.average_plays)],
  ];
  for (const [label, value] of items) {
    const card = document.createElement('article');
    card.className = 'stat';
    const name = document.createElement('span');
    name.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    card.append(name, strong);
    cards.append(card);
  }
  const chartCard = document.createElement('section');
  chartCard.className = 'chart-card';
  const chartTitle = document.createElement('h2');
  chartTitle.textContent = 'Pemain per hari';
  const chart = document.createElement('div');
  chart.className = 'chart';
  const daily = stats.daily || [];
  const peak = Math.max(1, ...daily.map((item) => item.transactions));
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', daily.map((item) => `${item.date} ${item.transactions} transaksi`).join(', '));
  for (const item of daily) {
    const column = document.createElement('div');
    column.className = 'chart-col';
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = item.transactions === 0
      ? '0px'
      : `${Math.max(8, Math.round((item.transactions / peak) * 140))}px`;
    bar.title = `${item.date}: ${item.transactions} transaksi`;
    const label = document.createElement('span');
    label.textContent = dayLabel(item.date);
    column.append(bar, label);
    chart.append(column);
  }
  chartCard.append(chartTitle, chart);
  content.append(cards, chartCard);
}

async function renderHistory(content) {
  content.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Riwayat pembelian';
  const note = messageLine();
  const filter = currentHistoryFilter();
  const form = document.createElement('form');
  form.className = 'filters';
  const from = document.createElement('input');
  from.type = 'date';
  from.required = true;
  from.value = filter.from;
  const to = document.createElement('input');
  to.type = 'date';
  to.required = true;
  to.value = filter.to;
  const payment = document.createElement('select');
  payment.append(
    selectOption('', 'Semua', filter.payment),
    selectOption('pending', 'Menunggu', filter.payment),
    selectOption('settlement', 'Berhasil', filter.payment),
    selectOption('expire', 'Kedaluwarsa', filter.payment),
    selectOption('deny', 'Ditolak', filter.payment),
    selectOption('cancel', 'Dibatalkan', filter.payment),
    selectOption('failure', 'Gagal', filter.payment),
  );
  const signal = document.createElement('select');
  signal.append(
    selectOption('', 'Semua', filter.signal),
    selectOption('none', 'Belum dikirim', filter.signal),
    selectOption('queued', 'Diantrekan', filter.signal),
    selectOption('accepted', 'Diambil mesin', filter.signal),
    selectOption('done', 'Selesai', filter.signal),
  );
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = 'Tampilkan';
  form.append(
    field('Dari tanggal', from),
    field('Sampai tanggal', to),
    field('Status pembayaran', payment),
    field('Status sinyal', signal),
    submit,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (from.value > to.value) {
      note.textContent = 'Tanggal mulai harus sebelum tanggal akhir.';
      return;
    }
    historyFilter = {
      from: from.value,
      to: to.value,
      payment: payment.value,
      signal: signal.value,
    };
    renderHistory(content);
  });
  content.append(title, form, note);
  const params = new URLSearchParams();
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.payment) params.set('payment', filter.payment);
  if (filter.signal) params.set('signal', filter.signal);
  const data = await api(`/api/admin/payments?${params}`).catch((error) => {
    note.textContent = error.message;
    return { payments: [] };
  });
  const payments = data.payments || [];
  if (payments.length === 0 && !note.textContent) {
    const empty = document.createElement('p');
    empty.className = 'lead';
    empty.textContent = 'Tidak ada pembelian pada filter ini.';
    content.append(empty);
    return;
  }

  const detail = document.createElement('section');
  detail.className = 'detail';
  detail.hidden = true;

  function showDetail(payment) {
    detail.hidden = false;
    detail.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = `Pembayaran #${payment.id}`;
    const list = document.createElement('dl');
    detailRow(list, 'Order ID', payment.order_id);
    detailRow(list, 'Token', payment.token_id ? `#${payment.token_id}` : '—');
    detailRow(list, 'Jumlah main', `${payment.play_count} main`);
    detailRow(list, 'Harga', rupiah(payment.price));
    detailRow(list, 'Status pembayaran', paymentLabel(payment.midtrans_status));
    detailRow(list, 'Status fraud', payment.fraud_status || '—');
    detailRow(list, 'ID transaksi Midtrans', payment.midtrans_transaction_id || '—');
    detailRow(list, 'Status sinyal', signalLabel(payment.signal_status));
    detailRow(list, 'Dibuat', formatTime(payment.created_at));
    detailRow(list, 'Kedaluwarsa', formatTime(payment.expires_at));
    detailRow(list, 'Sinyal diantrekan', formatTime(payment.signal_queued_at));
    detailRow(list, 'Sinyal diambil mesin', formatTime(payment.signal_accepted_at));
    detailRow(list, 'Sinyal selesai', formatTime(payment.signal_done_at));
    detailRow(list, 'Diperbarui', formatTime(payment.updated_at));
    detail.append(heading, list);
    const waiting = payment.midtrans_status === 'pending' && payment.signal_status === 'none';
    if (waiting && payment.qr_data_url) {
      const image = document.createElement('img');
      image.className = 'qr';
      image.alt = 'QR pembayaran';
      image.src = payment.qr_data_url;
      detail.append(image);
    }
    if (waiting) {
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'secondary';
      skip.textContent = 'Lewati';
      skip.addEventListener('click', async () => {
        note.textContent = '';
        skip.disabled = true;
        try {
          await api(`/api/admin/payments/${payment.id}/skip`, { method: 'POST' });
          await renderHistory(content);
        } catch (error) {
          note.textContent = error.message;
          skip.disabled = false;
        }
      });
      detail.append(skip);
    }
  }

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Waktu', 'Main', 'Harga', 'Pembayaran', 'Sinyal', '']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  for (const payment of payments) {
    const row = document.createElement('tr');
    const when = document.createElement('td');
    when.textContent = formatTime(payment.created_at);
    const plays = document.createElement('td');
    plays.textContent = `${payment.play_count} main`;
    const price = document.createElement('td');
    price.textContent = rupiah(payment.price);
    const pay = document.createElement('td');
    pay.append(paymentBadge(payment.midtrans_status));
    const signal = document.createElement('td');
    signal.append(signalBadge(payment.signal_status));
    const actions = document.createElement('td');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'secondary';
    open.textContent = 'Detail';
    open.addEventListener('click', () => showDetail(payment));
    actions.append(open);
    row.append(when, plays, price, pay, signal, actions);
    body.append(row);
  }
  table.append(thead, body);
  wrap.append(table);
  content.append(note, wrap, detail);
}

async function renderRelay(content) {
  content.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Relay';
  const note = messageLine();
  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent = 'Lama kontak tertutup dan jeda sebelum main berikutnya. Nilai baru dipakai pada pulsa selanjutnya.';
  const form = document.createElement('form');
  form.className = 'row';
  const onMs = document.createElement('input');
  onMs.type = 'number';
  onMs.min = '20';
  onMs.max = '500';
  onMs.step = '1';
  onMs.required = true;
  onMs.placeholder = 'Lama kontak (ms)';
  onMs.setAttribute('aria-label', 'Lama kontak dalam milidetik');
  onMs.className = 'grow';
  const gapMs = document.createElement('input');
  gapMs.type = 'number';
  gapMs.min = '0';
  gapMs.max = '2000';
  gapMs.step = '1';
  gapMs.required = true;
  gapMs.placeholder = 'Jeda (ms)';
  gapMs.setAttribute('aria-label', 'Jeda dalam milidetik');
  gapMs.className = 'grow';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = 'Simpan';
  form.append(onMs, gapMs, submit);
  try {
    const timing = await api('/api/admin/relay');
    onMs.value = String(timing.on_ms);
    gapMs.value = String(timing.gap_ms);
  } catch (error) {
    note.textContent = error.message;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.textContent = '';
    note.className = 'note';
    submit.disabled = true;
    try {
      const saved = await api('/api/admin/relay', {
        method: 'PATCH',
        body: { on_ms: Number(onMs.value), gap_ms: Number(gapMs.value) },
      });
      onMs.value = String(saved.on_ms);
      gapMs.value = String(saved.gap_ms);
      note.className = 'note ok';
      note.textContent = 'Waktu relay disimpan.';
    } catch (error) {
      note.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  content.append(title, lead, form, note);
  const testLead = document.createElement('p');
  testLead.className = 'lead';
  testLead.textContent = 'Kirim pulsa ke mesin tanpa pembayaran. Dipakai untuk mencoba relay.';
  const testForm = document.createElement('form');
  testForm.className = 'row';
  const pulses = document.createElement('input');
  pulses.type = 'number';
  pulses.min = '1';
  pulses.max = '20';
  pulses.step = '1';
  pulses.required = true;
  pulses.value = '1';
  pulses.placeholder = 'Jumlah pulsa';
  pulses.setAttribute('aria-label', 'Jumlah pulsa uji');
  pulses.className = 'grow';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'secondary';
  send.textContent = 'Kirim sinyal';
  testForm.append(pulses, send);
  const testNote = messageLine();
  testForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    testNote.textContent = '';
    testNote.className = 'note';
    send.disabled = true;
    try {
      const result = await api('/api/admin/relay/test', {
        method: 'POST',
        body: { pulses: Number(pulses.value) },
      });
      testNote.className = 'note ok';
      testNote.textContent = `Sinyal uji dikirim, ${result.pulses} pulsa.`;
    } catch (error) {
      testNote.textContent = error.message;
    } finally {
      send.disabled = false;
    }
  });
  content.append(testLead, testForm, testNote);
}

async function renderTokens(content) {
  content.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Token';
  const note = messageLine();
  const data = await api('/api/admin/tokens').catch((error) => {
    note.textContent = error.message;
    return { tokens: [] };
  });
  const form = document.createElement('form');
  form.className = 'row';
  const price = document.createElement('input');
  price.type = 'number';
  price.min = '1';
  price.step = '1';
  price.required = true;
  price.placeholder = 'Harga';
  price.setAttribute('aria-label', 'Harga');
  price.className = 'grow';
  const plays = document.createElement('input');
  plays.type = 'number';
  plays.min = '1';
  plays.max = '100';
  plays.step = '1';
  plays.required = true;
  plays.placeholder = 'Jumlah main';
  plays.setAttribute('aria-label', 'Jumlah main');
  plays.className = 'grow';
  const editing = { id: null };
  const submit = document.createElement('button');
  submit.className = 'primary';
  submit.type = 'submit';
  submit.textContent = 'Tambah';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Batal';
  cancel.hidden = true;
  cancel.addEventListener('click', () => {
    editing.id = null;
    form.reset();
    submit.textContent = 'Tambah';
    cancel.hidden = true;
    form.querySelector('label.check')?.remove();
  });
  form.append(price, plays, submit, cancel);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.textContent = '';
    const body = { price: Number(price.value), play_count: Number(plays.value) };
    const box = form.querySelector('input[name="active"]');
    if (box) body.active = box.checked;
    try {
      if (editing.id) {
        await api(`/api/admin/tokens/${editing.id}`, { method: 'PATCH', body });
      } else {
        await api('/api/admin/tokens', { method: 'POST', body });
      }
      await renderTokens(content);
    } catch (error) {
      note.textContent = error.message;
    }
  });

  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Main', 'Harga', 'Status', '']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  for (const token of data.tokens) {
    const row = document.createElement('tr');
    const playsCell = document.createElement('td');
    playsCell.textContent = `${token.play_count} main`;
    const priceCell = document.createElement('td');
    priceCell.textContent = rupiah(token.price);
    const state = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${token.active ? 'on' : 'off'}`;
    badge.textContent = token.active ? 'Aktif' : 'Nonaktif';
    state.append(badge);
    const actions = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Ubah';
    edit.addEventListener('click', () => {
      editing.id = token.id;
      price.value = String(token.price);
      plays.value = String(token.play_count);
      submit.textContent = 'Simpan';
      cancel.hidden = false;
      const activeBox = form.querySelector('input[name="active"]');
      if (!activeBox) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.name = 'active';
        const label = document.createElement('label');
        label.className = 'check';
        label.append(box, document.createTextNode('Aktif'));
        form.insertBefore(label, submit);
      }
      form.querySelector('input[name="active"]').checked = token.active;
    });
    actions.append(edit);
    if (token.active) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'secondary';
      off.textContent = 'Nonaktifkan';
      off.addEventListener('click', async () => {
        note.textContent = '';
        try {
          await api(`/api/admin/tokens/${token.id}`, { method: 'PATCH', body: { active: false } });
          await renderTokens(content);
        } catch (error) {
          note.textContent = error.message;
        }
      });
      actions.append(off);
    }
    row.append(playsCell, priceCell, state, actions);
    body.append(row);
  }
  table.append(thead, body);
  content.append(title, note, form, table);
}

async function renderAdmins(content) {
  content.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Akses admin';
  const note = messageLine();
  const data = await api('/api/admin/admins').catch((error) => {
    note.textContent = error.message;
    return { admins: [] };
  });
  const form = document.createElement('form');
  form.className = 'stack';
  const username = textInput('text', 'username', 'off');
  const password = textInput('password', 'password', 'new-password');
  const editing = { id: null };
  const submit = document.createElement('button');
  submit.className = 'primary';
  submit.type = 'submit';
  submit.textContent = 'Tambah';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Batal';
  cancel.hidden = true;
  const buttons = document.createElement('div');
  buttons.className = 'row';
  buttons.append(submit, cancel);
  form.append(field('Username', username), field('Kata sandi', password), buttons);
  cancel.addEventListener('click', () => {
    editing.id = null;
    form.reset();
    password.required = true;
    submit.textContent = 'Tambah';
    cancel.hidden = true;
    form.querySelector('label.check')?.remove();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.textContent = '';
    try {
      if (editing.id) {
        const body = { username: username.value.trim() };
        if (password.value) body.password = password.value;
        const box = form.querySelector('input[name="active"]');
        if (box) body.active = box.checked;
        await api(`/api/admin/admins/${editing.id}`, { method: 'PATCH', body });
      } else {
        await api('/api/admin/admins', {
          method: 'POST',
          body: { username: username.value.trim(), password: password.value },
        });
      }
      await renderAdmins(content);
    } catch (error) {
      note.textContent = error.message;
    }
  });

  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Username', 'Status', '']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  for (const admin of data.admins) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = admin.username;
    const state = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${admin.active ? 'on' : 'off'}`;
    badge.textContent = admin.active ? 'Aktif' : 'Nonaktif';
    state.append(badge);
    const actions = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Ubah';
    edit.addEventListener('click', () => {
      editing.id = admin.id;
      username.value = admin.username;
      password.value = '';
      password.required = false;
      submit.textContent = 'Simpan';
      cancel.hidden = false;
      let box = form.querySelector('input[name="active"]');
      if (!box) {
        box = document.createElement('input');
        box.type = 'checkbox';
        box.name = 'active';
        const label = document.createElement('label');
        label.className = 'check';
        label.append(box, document.createTextNode('Aktif'));
        form.insertBefore(label, buttons);
      }
      box.checked = admin.active;
      box.disabled = admin.id === me.id;
    });
    actions.append(edit);
    if (admin.active && admin.id !== me.id) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'secondary';
      off.textContent = 'Nonaktifkan';
      off.addEventListener('click', async () => {
        note.textContent = '';
        try {
          await api(`/api/admin/admins/${admin.id}`, { method: 'PATCH', body: { active: false } });
          await renderAdmins(content);
        } catch (error) {
          note.textContent = error.message;
        }
      });
      actions.append(off);
    }
    row.append(name, state, actions);
    body.append(row);
  }
  table.append(thead, body);
  content.append(title, note, form, table);
}

const session = await api('/api/admin/me').catch((error) => {
  if (error.status === 401) return null;
  throw error;
});
if (session?.admin) {
  me = session.admin;
  await renderShell();
} else {
  renderLogin();
}
