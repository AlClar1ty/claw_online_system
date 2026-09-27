import crypto from 'node:crypto';

export function signatureFor({ order_id, status_code, gross_amount }, serverKey) {
  return crypto
    .createHash('sha512')
    .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
    .digest('hex');
}

export function verifySignature(body, serverKey) {
  if (!body || typeof serverKey !== 'string' || serverKey.length === 0) return false;
  const { order_id, status_code, gross_amount, signature_key } = body;
  if (
    typeof order_id !== 'string' ||
    typeof status_code !== 'string' ||
    typeof gross_amount !== 'string' ||
    typeof signature_key !== 'string'
  ) {
    return false;
  }
  const expected = signatureFor({ order_id, status_code, gross_amount }, serverKey);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature_key);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function qrActionUrl(charge) {
  const actions = Array.isArray(charge?.actions) ? charge.actions : [];
  for (const name of ['generate-qr-code', 'generate-qr-code-v2']) {
    const found = actions.find((item) => item && item.name === name && typeof item.url === 'string');
    if (found?.url.startsWith('https://')) return found.url;
  }
  return '';
}

export function createMidtransClient({ serverKey, production, notificationUrl, acquirer }) {
  const base = production ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
  const authorization = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;

  async function request(urlPath, { method = 'GET', body } = {}) {
    const headers = {
      Authorization: authorization,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (notificationUrl) headers['X-Override-Notification'] = notificationUrl;
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
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
    const code = data.status_code ? String(data.status_code) : '';
    if (!response.ok || (code && !code.startsWith('2'))) {
      const error = new Error(data.status_message || `Midtrans menolak permintaan (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return {
    base,
    charge({ orderId, grossAmount, playCount, expiryMinutes }) {
      return request('/v2/charge', {
        method: 'POST',
        body: {
          payment_type: 'qris',
          transaction_details: {
            order_id: orderId,
            gross_amount: grossAmount,
          },
          item_details: [
            {
              id: 'token',
              price: grossAmount,
              quantity: 1,
              name: `Token ${playCount} main`.slice(0, 50),
            },
          ],
          custom_expiry: {
            expiry_duration: expiryMinutes,
            unit: 'minute',
          },
          qris: { acquirer },
        },
      });
    },
    getStatus(orderId) {
      return request(`/v2/${encodeURIComponent(orderId)}/status`);
    },
    async downloadQrImage(charge) {
      const url = qrActionUrl(charge);
      if (!url) return '';
      const response = await fetch(url, {
        headers: { Authorization: authorization, Accept: 'image/png' },
      });
      if (!response.ok) return '';
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) return '';
      return `data:image/png;base64,${bytes.toString('base64')}`;
    },
  };
}
