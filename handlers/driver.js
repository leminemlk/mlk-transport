// ============================================================
// HANDLER CHAUFFEUR — MLK Transport
// 1 = confirmer course OU terminer course (toggle)
// ON/OFF = même chose via la page web
// ============================================================
const { sendText, sendLocation } = require('../whapi');
const DB = require('../db');
const { acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

const BASE_URL   = 'https://mlk-transport-production.up.railway.app';
const driverLink = (phone) => `${BASE_URL}/chauffeur.html?phone=${phone}`;

async function handleDriver(msg, driver) {
  const phone   = driver.phone;
  const msgType = msg.type;
  const text    = (msgType === 'text' ? (msg.text?.body || '') : '').trim().toLowerCase();
  const hasLoc  = msgType === 'location';

  // ── GPS → se mettre en ligne ──────────────────────────────
  if (hasLoc) {
    const { lat, lng } = { lat: msg.location.latitude, lng: msg.location.longitude };
    const now      = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub   = driver.subscription_end && new Date(driver.subscription_end) > now;
    if (!driver.active || (!hasTrial && !hasSub)) {
      await sendText(phone, `⚠️ انتهى اشتراكك | Abonnement expiré !\n💰 500 MRU/semaine`);
      return;
    }
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    await sendText(phone,
      `✅ أنت متاح الآن ! | En ligne !\n\n` +
      `👉 ${driverLink(phone)}\n\n` +
      `اضغط *1* لقبول الرحلة أو إنهائها\nTapez *1* pour accepter ou terminer`
    );
    // Notifier tous les clients en attente
    await processQueue(await DB.drivers.get(phone));
    return;
  }

  // ── 1 : TOUT FAIRE (confirmer OU terminer) ─────────────────
  if (text === '1') {
    // Offre en attente → accepter
    if (pendingOffers.has(phone)) {
      await acceptRide(phone);
      return;
    }
    // Vérifier offre en DB
    try {
      const r = await DB.pool.query(
        `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY created_at DESC LIMIT 1`, [phone]
      );
      if (r.rows[0]) { await acceptRide(phone); return; }
    } catch(e) {}

    // Course active → terminer + redevenir dispo
    const activeRide = await DB.rides.getActiveByDriver(phone);
    if (activeRide) {
      await DB.rides.complete(activeRide.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone,
        `✅ *انتهت الرحلة ! | Course terminée !*\n\n` +
        `🟢 أنت متاح الآن | Vous êtes disponible.\n\n` +
        `👉 ${driverLink(phone)}`
      );
      await processQueue(await DB.drivers.get(phone));
      return;
    }

    // Rien → pas de course
    await sendText(phone,
      `⚠️ *لا توجد رحلة نشطة | Aucune course active*\n\n` +
      `_سيتم إعلامك فور طلب عميل رحلة._\n\n` +
      `👉 ${driverLink(phone)}`
    );
    return;
  }

  // ── Refus (si offre en attente, tout autre message) ────────
  if (pendingOffers.has(phone)) {
    await sendText(phone,
      `🚖 *طلب رحلة في الانتظار !*\n\n` +
      `✅ *1* → قبول | Accepter\n\n` +
      `_(60 ثانية للرد | 60 secondes)_`
    );
    return;
  }

  // Course active → rappel
  const activeRide = await DB.rides.getActiveByDriver(phone);
  if (activeRide) {
    await sendText(phone,
      `🚖 *Course en cours | رحلة جارية*\n\n` +
      `📞 wa.me/${activeRide.client_phone}\n\n` +
      `*1* → ✅ Terminer la course\n` +
      `👉 ${driverLink(phone)}`
    );
    return;
  }

  // Aucune course
  await sendText(phone,
    `⚠️ *لا توجد رحلة نشطة | Aucune course active*\n\n` +
    `_Vous serez notifié dès qu'un client demande._\n\n` +
    `👉 ${driverLink(phone)}`
  );
}

module.exports = { handleDriver };
