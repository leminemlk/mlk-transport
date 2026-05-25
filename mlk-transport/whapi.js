// ============================================================
// WHAPI.CLOUD - Envoi de messages WhatsApp
// ============================================================
const axios = require('axios');

const API = axios.create({
  baseURL: 'https://gate.whapi.cloud',
  headers: {
    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

/** Formater le numéro en JID WhatsApp */
function toJid(phone) {
  const clean = phone.replace(/\D/g, '');
  return clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;
}

/** Envoyer un message texte */
async function sendText(phone, text) {
  try {
    await API.post('/messages/text', { to: toJid(phone), body: text });
  } catch (e) {
    console.error(`[WHAPI] Erreur envoi à ${phone}:`, e.response?.data || e.message);
  }
}

/** Envoyer des boutons (réponse rapide) */
async function sendButtons(phone, text, buttons) {
  try {
    // Whapi supporte les boutons via messages/interactive
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
    // Fallback : message texte avec numérotation
    const txt = text + '\n\n' + buttons.map((b, i) => `${i + 1}️⃣ ${b}`).join('\n');
    await sendText(phone, txt);
  }
}

/** Envoyer une localisation */
async function sendLocation(phone, lat, lng, name = '', address = '') {
  try {
    await API.post('/messages/location', {
      to: toJid(phone),
      latitude: lat,
      longitude: lng,
      name,
      address
    });
  } catch (e) {
    // Fallback lien Google Maps
    await sendText(phone, `📍 Position : https://maps.google.com/?q=${lat},${lng}`);
  }
}

module.exports = { sendText, sendButtons, sendLocation };
