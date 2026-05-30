const { sendText, sendLocation } = require('../whapi');
const DB = require('../db');
const { acceptRide, refuseRide, processQueue } = require('../queue');

const BASE      = 'https://mlk-transport-production.up.railway.app';
const driverUrl = (token) => `${BASE}/chauffeur.html?t=${token}`;

async function handleDriver(msg, driver) {
  const phone   = driver.phone;
  const msgType = msg.type;
  const text    = (msgType === 'text' ? (msg.text?.body||'') : '').trim().toLowerCase();
  const hasLoc  = msgType === 'location';
  const token   = await DB.getOrCreateDriverToken(phone);

  // GPS → mise en ligne
  if (hasLoc) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const now = new Date();
    const ok  = (driver.trial_until && new Date(driver.trial_until)>now)
              || (driver.subscription_end && new Date(driver.subscription_end)>now);
    if (!driver.active || !ok) {
      await sendText(phone, `⚠️ انتهى اشتراكك | Abonnement expiré !\n💰 500 MRU/semaine`);
      return;
    }
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    await sendText(phone,
      `✅ *أنت متاح الآن ! | En ligne !*\n\n` +
      `👉 ${driverUrl(token)}\n\n` +
      `اضغط *1* لقبول الرحلة أو إنهائها\nTapez *1* pour accepter ou terminer`
    );
    await processQueue(await DB.drivers.get(phone));
    return;
  }

  // 1 = tout faire
  if (text === '1') {
    const r = await DB.pool.query(
      `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY created_at DESC LIMIT 1`, [phone]
    );
    if (r.rows[0]) { await acceptRide(phone); return; }

    const active = await DB.rides.getActiveByDriver(phone);
    if (active) {
      await DB.rides.complete(active.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone,
        `✅ *انتهت الرحلة ! | Course terminée !*\n\n🟢 متاح | Disponible.\n\n👉 ${driverUrl(token)}`
      );
      await processQueue(await DB.drivers.get(phone));
      return;
    }

    await sendText(phone, `⚠️ لا توجد رحلة نشطة | Aucune course.

👉 ${driverUrl(token)}`);
    return;
  }

  // Tout autre message
  const active = await DB.rides.getActiveByDriver(phone);
  if (active) {
    await sendText(phone,
      `🚖 *رحلة جارية | Course en cours*\n\n📞 wa.me/${active.client_phone}\n\n*1* → ✅ Terminer\n\n👉 ${driverUrl(token)}`
    );
    return;
  }

  await sendText(phone,
    `⚠️ *لا توجد رحلة نشطة | Aucune course*\n\n_Vous serez notifié dès qu'un client demande._\n\n👉 ${driverUrl(token)}`
  );
}

module.exports = { handleDriver };
