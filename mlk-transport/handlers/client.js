const { sendText } = require('../whapi');
const DB = require('../db');
const { clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  DB.clients.upsert.run(phone);

  const hasLocation = msg.type === 'location';
  const text = (msg.text?.body || '').trim().toLowerCase();

  // Annuler
  if (text === 'annuler' || text === 'cancel') {
    DB.queue.remove.run(phone);
    clearState(phone);
    await sendText(phone, `❌ Demande annulée.\n\nEnvoyez un message pour appeler une voiture.`);
    return;
  }

  // Position reçue via WhatsApp 📎
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const ride = DB.rides.create.run(phone, lat, lng);
    await sendText(phone, `🔍 Recherche d'un chauffeur...\nVeuillez patienter.`);
    await findDriver(phone, lat, lng, ride.lastInsertRowid);
    return;
  }

  // Tout autre message → envoyer le lien de localisation
  const link = `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;
  await sendText(phone,
    `🚖 *MLK Transport - Nouakchott*\n\n` +
    `Cliquez sur ce lien pour appeler une voiture :\n\n` +
    `👉 ${link}\n\n` +
    `_Votre position sera détectée automatiquement_ 📍`
  );
}

module.exports = { handleClient };
