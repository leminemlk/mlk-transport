const { sendText } = require('../whapi');
const DB = require('../db');
const { clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  await DB.clients.upsert(phone);

  const hasLocation = msg.type === 'location';
  const text = (msg.text?.body || '').trim();

  // 0 = annuler
  if (text === '0') {
    await DB.queue.remove(phone);
    clearState(phone);
    await sendText(phone,
      `❌ تم الإلغاء | Demande annulée.`
    );
    return;
  }

  // Position reçue
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const rideId = await DB.rides.create(phone, lat, lng);
    await sendText(phone, `🔍 جاري البحث عن سائق...\nRecherche d'un chauffeur...`);
    await findDriver(phone, lat, lng, rideId);
    return;
  }

  // Tout autre message
  const link = `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;
  await sendText(phone,
    `🚕 *MK TAXI*\n\n` +
    `مرحباً ! اضغط الرابط لطلب تاكسي :\n` +
    `Appuyez sur ce lien pour appeler un taxi :\n\n` +
    `👉 ${link}\n\n` +
    `اكتب الرقم *0️⃣* للإلغاء | Tapez le chiffre *0️⃣* pour annuler`
  );
}

module.exports = { handleClient };
