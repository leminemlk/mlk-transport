const axios = require('axios');

const API = axios.create({
  baseURL: 'https://gate.whapi.cloud/api/',
  headers: {
    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

function toJid(phone) {
  const clean = phone.replace(/\D/g, '').replace(/^00/, '');
  return clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;
}

async function sendText(phone, text) {
  try {
    await API.post('/messages/text', { to: toJid(phone), body: text });
  } catch (e) {
    console.error(`[WHAPI] Erreur envoi à ${phone}:`, e.response?.data || e.message);
  }
}

async function sendButtons(phone, text, buttons) {
  try {
    await API.post('/messages/interactive', {
      to: toJid(phone),
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.map((b, i) => ({
          type: 'reply',
          reply: { id: String(i + 1), title: b }
        }))
      }
    });
  } catch (e) {
    const txt = text + '\n\n' + buttons.map((b, i) => `${i + 1}️⃣ ${b}`).join('\n');
    await sendText(phone, txt);
  }
}

/** Bouton natif WhatsApp "Partager ma position" */
async function sendLocationRequest(phone) {
  try {
    await API.post('/messages/interactive', {
      to: toJid(phone),
      type: 'location_request_message',
      body: {
        text: '🚖 *MLK Transport*\n\nAppuyez sur le bouton ci-dessous pour envoyer votre position et appeler une voiture.'
      },
      action: { name: 'send_location' }
    });
  } catch (e) {
    // Fallback si non supporté
    await sendText(phone,
      `🚖 *MLK Transport*\n\n` +
      `Appuyez sur 📎 puis *Localisation* pour appeler une voiture.\n\n` +
      `Pour annuler : *annuler*`
    );
  }
}

async function sendLocation(phone, lat, lng, name = '', address = '') {
  try {
    await API.post('/messages/location', {
      to: toJid(phone), latitude: lat, longitude: lng, name, address
    });
  } catch (e) {
    await sendText(phone, `📍 Position : https://maps.google.com/?q=${lat},${lng}`);
  }
}

module.exports = { sendText, sendButtons, sendLocation, sendLocationRequest };
