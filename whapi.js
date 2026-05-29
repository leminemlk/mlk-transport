// ============================================================
// WHAPI.CLOUD - Envoi optimisé avec retry et déduplication
// ============================================================
const axios = require('axios');

const API = axios.create({
  baseURL: 'https://gate.whapi.cloud',
  headers: {
    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

function toJid(phone) {
  const clean = String(phone).replace(/\D/g, '').replace(/^00/, '');
  return clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;
}

/** Retry automatique (3 essais) */
async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isLast = i === retries - 1;
      if (isLast) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function sendText(phone, text) {
  try {
    await withRetry(() =>
      API.post('/messages/text', { to: toJid(phone), body: text })
    );
  } catch (e) {
    console.error(`[WHAPI] Erreur envoi à ${phone}:`, e.response?.data || e.message);
  }
}

async function sendLocation(phone, lat, lng, name = '', address = '') {
  try {
    await withRetry(() =>
      API.post('/messages/location', { to: toJid(phone), latitude: lat, longitude: lng, name, address })
    );
  } catch (e) {
    await sendText(phone, `📍 https://maps.google.com/?q=${lat},${lng}`);
  }
}

async function sendImage(phone, url, caption = '') {
  try {
    await withRetry(() =>
      API.post('/messages/image', { to: toJid(phone), media: url, caption })
    );
  } catch (e) {
    console.error(`[WHAPI] Erreur image à ${phone}:`, e.message);
  }
}

async function sendButtons(phone, text, buttons) {
  try {
    await withRetry(() =>
      API.post('/messages/interactive', {
        to: toJid(phone),
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.map((b, i) => ({
            type: 'reply',
            reply: { id: String(i + 1), title: b }
          }))
        }
      })
    );
  } catch (e) {
    const txt = text + '\n\n' + buttons.map((b, i) => `*${i + 1}* → ${b}`).join('\n');
    await sendText(phone, txt);
  }
}

async function sendVoice(phone, url) {
  try {
    await withRetry(() => API.post('/messages/voice', { to: toJid(phone), media: url }));
  } catch(e) { console.error('[WHAPI voice]', e.message); }
}

module.exports = { sendText, sendLocation, sendImage, sendButtons, sendVoice };
