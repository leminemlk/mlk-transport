const { sendText } = require('../whapi');
const DB = require('../db');
const { clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  await DB.clients.upsert(phone);

  const hasLocation = msg.type === 'location';
  const text = (msg.text?.body || '').trim().toLowerCase();

  if (text === 'annuler' || text === 'cancel' || text === 'إلغاء') {
    await DB.queue.remove(phone);
    clearState(phone);
    await sendText(phone,
      `❌ Demande annulée | تم الإلغاء\n\n` +
      `أرسل رسالة لطلب سيارة\nEnvoyez un message pour appeler le chauffeur.`
    );
    return;
  }

  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const rideId = await DB.rides.create(phone, lat, lng);
    await sendText(phone,
      `🔍 جاري البحث عن سائق...\nRecherche d'un chauffeur...`
    );
    await findDriver(phone, lat, lng, rideId);
    return;
  }

  const link = `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;
  await sendText(phone,
    `🚖 *MLK Transport*\n\n` +
    `مرحباً بك في MLK Transport !\n` +
    `Bienvenue chez MLK Transport !\n\n` +
    `اضغط على الرابط لطلب سيارة :\n` +
    `Cliquez sur ce lien pour appeler le chauffeur :\n\n` +
    `👉 ${link}\n\n` +
    `لإلغاء الطلب : *إلغاء*\nPour annuler : *annuler*`
  );
}

module.exports = { handleClient };
