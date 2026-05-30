const { sendText } = require('../whapi');
const DB = require('../db');
const { driverAccept, driverConfirm, driverReject, driverFinish, processQueue } = require('../queue');

const BASE      = 'https://mlk-transport-production.up.railway.app';
const driverUrl = (token) => `${BASE}/chauffeur.html?t=${token}`;

async function handleDriver(msg, driver) {
  const phone   = driver.phone;
  const msgType = msg.type;
  const text    = (msgType === 'text' ? (msg.text?.body || '') : '').trim();
  const hasLoc  = msgType === 'location';
  const token   = await DB.getOrCreateDriverToken(phone);

  // ── GPS → se mettre en ligne ─────────────────────────────
  if (hasLoc) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const now = new Date();
    const ok  = (driver.trial_until && new Date(driver.trial_until) > now)
              || (driver.subscription_end && new Date(driver.subscription_end) > now);
    if (!driver.active || !ok) {
      await sendText(phone, `⚠️ انتهى اشتراكك | Abonnement expiré !`);
      return;
    }
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    await sendText(phone,
      `✅ *أنت متاح | En ligne !*\n\n` +
      `*1* → ✅ قبول رحلة | Accepter\n` +
      `*2* → 🤝 تأكيد الاتفاق | Confirmer\n` +
      `*0* → ❌ رفض | Rejeter\n` +
      `*3* → 🏁 إنهاء | Terminer\n\n` +
      `👉 ${driverUrl(token)}`
    );
    await processQueue(await DB.drivers.get(phone));
    return;
  }

  // ── 1 : Accepter → client reçoit infos immédiatement ────
  if (text === '1') {
    const active = await DB.rides.getActiveByDriver(phone);
    if (active) {
      await sendText(phone,
        `🚕 *رحلة جارية | Course en cours*\n📞 wa.me/${active.client_phone}\n\n*3* → 🏁 Terminer\n*0* → ❌ Annuler`
      );
      return;
    }
    const offered = await DB.pool.query(
      `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' LIMIT 1`, [phone]
    );
    if (offered.rows[0]) {
      await sendText(phone,
        `✅ *تفاوض مع العميل | Négociez avec le client*\n📞 wa.me/${offered.rows[0].client_phone}\n\n*2* → 🤝 Confirmer (accord)\n*0* → ❌ Rejeter (désaccord)`
      );
      return;
    }
    // Accepter → client reçoit immédiatement les infos
    const result = await driverAccept(phone);
    if (!result) {
      await sendText(phone, `⚠️ لا توجد رحلة متاحة | Aucune course.\n\n👉 ${driverUrl(token)}`);
    }
    return;
  }

  // ── 2 : Confirmer (prix OK) ───────────────────────────────
  if (text === '2') {
    const done = await driverConfirm(phone);
    if (!done) {
      await sendText(phone, `⚠️ لا توجد رحلة في الانتظار | Aucune course en attente.\n\n👉 ${driverUrl(token)}`);
    }
    return;
  }

  // ── 0 : Rejeter (pas d'accord) ───────────────────────────
  if (text === '0') {
    await driverReject(phone);
    return;
  }

  // ── 3 : Terminer la course ───────────────────────────────
  if (text === '3') {
    const done = await driverFinish(phone);
    if (!done) {
      await DB.drivers.setStatus('online', phone);
      await sendText(phone, `🟢 متاح | Disponible.\n\n👉 ${driverUrl(token)}`);
    }
    return;
  }

  // Tout autre message → rappel des commandes
  const active = await DB.rides.getActiveByDriver(phone);
  if (active) {
    await sendText(phone,
      `🚕 *رحلة جارية | Course en cours*\n📞 wa.me/${active.client_phone}\n\n*3* → 🏁 Terminer\n\n👉 ${driverUrl(token)}`
    );
    return;
  }
  const offeredR = await DB.pool.query(
    `SELECT client_phone FROM rides WHERE driver_phone=$1 AND status='offered' LIMIT 1`, [phone]
  );
  if (offeredR.rows[0]) {
    await sendText(phone,
      `🤝 *تفاوض مع العميل | Négociez avec le client*\n📞 wa.me/${offeredR.rows[0].client_phone}\n\n` +
      `*2* → 🤝 Confirmer\n*0* → ❌ Rejeter`
    );
    return;
  }
  await sendText(phone,
    `🟢 *متاح | Disponible*\n\n*1* ✅ · *2* 🤝 · *0* ❌ · *3* 🏁\n\n👉 ${driverUrl(token)}`
  );
}

module.exports = { handleDriver };
