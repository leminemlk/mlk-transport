const { sendText } = require('../whapi');
const DB = require('../db');
const { clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  await DB.clients.upsert(phone);

  const hasLocation = msg.type === 'location';
  const text = (msg.text?.body || '').trim().toLowerCase();

  // 0 = annuler
  if (text === '0' || text === 'annuler' || text === 'cancel' || text === 'إلغاء') {
    await DB.queue.remove(phone);
    clearState(phone);
    await sendText(phone,
      `❌ تم الإلغاء | Demande annulée.\n\n` +
      `أرسل أي رسالة لطلب سيارة\n` +
      `Envoyez un message pour appeler le chauffeur.`
    );
    return;
  }

  // Position reçue → chercher un chauffeur
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const rideId = await DB.rides.create(phone, lat, lng);
    await sendText(phone, `🔍 جاري البحث عن سائق...\nRecherche d'un chauffeur...`);
    await findDriver(phone, lat, lng, rideId);
    return;
  }

  // Tout autre message → envoyer le lien
  const link = `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;
  await sendText(phone,
    `🚖 *MLK Transport*\n\n` +
    `مرحباً ! اضغط على الرابط لطلب سيارة :\n` +
    `Bienvenue ! Cliquez pour appeler le chauffeur :\n\n` +
    `👉 ${link}\n\n` +
    `*0* → إلغاء الطلب | Annuler la demande`
  );
}

module.exports = { handleClient };
