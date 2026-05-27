const { sendText } = require('../whapi');
const DB = require('../db');
const { clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  await DB.clients.upsert(phone);

  const hasLocation = msg.type === 'location';
  const text = (msg.text?.body || '').trim().toLowerCase();

  if (text === 'annuler' || text === 'cancel') {
    await DB.queue.remove(phone);
    clearState(phone);
    await sendText(phone, `❌ Demande annulée.\n\nEnvoyez un message pour appeler une voiture.`);
    return;
  }

  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const rideId = await DB.rides.create(phone, lat, lng);
    await sendText(phone, `🔍 Recherche d'un chauffeur...\nVeuillez patienter.`);
    await findDriver(phone, lat, lng, rideId);
    return;
  }

  const link = `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;
  await sendText(phone,
    `🚖 *MLK Transport - Nouakchott*\n\n` +
    `Cliquez sur ce lien pour appeler une voiture :\n\n` +
    `👉 ${link}\n\n` +
    `_Votre position sera détectée automatiquement_ 📍`
  );
}

module.exports = { handleClient };
