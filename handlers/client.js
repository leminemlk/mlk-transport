// ============================================================
// HANDLER CLIENT — MLK Transport
// ============================================================
const { sendText, sendVoice } = require('../whapi');
const DB = require('../db');
const { clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  await DB.clients.upsert(phone);

  const msgType     = msg.type;
  const hasLocation = msgType === 'location';
  const text        = (msgType === 'text' ? (msg.text?.body || '') : '').trim();
  const isMedia     = ['sticker','image','audio','video','document','reaction'].includes(msgType);
  const isCall      = msgType === 'call';
  const locateLink  = `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;

  // ── 0 : annuler ───────────────────────────────────────────
  if (text === '0') {
    await DB.queue.remove(phone);
    clearState(phone);
    try {
      await DB.pool.query(
        `UPDATE rides SET status='cancelled'
         WHERE client_phone=$1 AND status IN ('searching','offered')`,
        [phone]
      );
    } catch(e) {}
    await sendText(phone, `❌ تم الإلغاء | Demande annulée.`);
    return;
  }

  // ── Sticker / bitmoji / appel / audio ─────────────────────
  // → Chercher le premier chauffeur disponible et envoyer son contact
  if (isMedia || isCall) {
    // Course déjà en cours ?
    try {
      const inProg = await DB.pool.query(
        `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`,
        [phone]
      );
      if (inProg.rows.length > 0) {
        await sendText(phone,
          `⏳ *طلبك قيد المعالجة | Votre course est en cours...*\n` +
          `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
        );
        return;
      }
    } catch(e) {}

    // Chercher un chauffeur disponible
    // Message vocal Hassaniya en premier
    await sendVoice(phone, 'https://mlk-transport-production.up.railway.app/msg_taxi.ogg');

    const available = await DB.drivers.getAvailable();
    if (available.length > 0) {
      const d    = available[0]; // le plus proche viendra après partage de position
      const clim = d.clim ? '❄️ Climatisée' : '🌡 Sans clim';
      await sendText(phone,
        `🚕 *MK TAXI*\n\n` +
        `سائق متاح الآن ! | Chauffeur disponible !\n\n` +
        `👤 *${d.name}*\n` +
        `📞 wa.me/${d.phone}\n` +
        `${clim}\n\n` +
        `_اتصل مباشرة أو أرسل موقعك لطلب رسمي\nAppellez directement ou envoyez votre position pour une demande officielle._\n\n` +
        `👉 ${locateLink}`
      );
    } else {
      await sendText(phone,
        `🚕 *MK TAXI*\n\n` +
        `مرحباً ! اضغط الرابط لطلب تاكسي :\n` +
        `Appuyez sur ce lien pour appeler un taxi :\n\n` +
        `👉 ${locateLink}\n\n` +
        `اكتب الرقم *0️⃣* للإلغاء | Tapez le chiffre *0️⃣* pour annuler`
      );
    }
    return;
  }

  // ── Position GPS → créer une course ───────────────────────
  if (hasLocation) {
    const lat    = msg.location.latitude;
    const lng    = msg.location.longitude;
    const rideId = await DB.rides.create(phone, lat, lng);
    await sendText(phone, `🔍 جاري البحث عن سائق...\nRecherche d'un chauffeur...`);
    await findDriver(phone, lat, lng, rideId);
    return;
  }

  // ── Tout autre texte → envoyer le lien ────────────────────
  await sendText(phone,
    `🚕 *MK TAXI*\n\n` +
    `مرحباً ! اضغط الرابط لطلب تاكسي :\n` +
    `Appuyez sur ce lien pour appeler un taxi :\n\n` +
    `👉 ${locateLink}\n\n` +
    `اكتب الرقم *0️⃣* للإلغاء | Tapez le chiffre *0️⃣* pour annuler`
  );
}

module.exports = { handleClient };
