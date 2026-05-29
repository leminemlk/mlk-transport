// ============================================================
// HANDLER CHAUFFEUR — MLK Transport
// ============================================================
const { sendText, sendLocation } = require('../whapi');
const DB = require('../db');
const { acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

const BASE_URL  = 'https://mlk-transport-production.up.railway.app';
const driverLink = (phone) => `${BASE_URL}/chauffeur.html?phone=${phone}`;

// Message standard "pas de course active"
const NO_RIDE_MSG = (phone) =>
  `⚠️ *لا توجد رحلة نشطة | Aucune course active*\n\n` +
  `_سيتم إعلامك فور طلب عميل رحلة._\n` +
  `_Vous serez notifié dès qu'un client demande une course._\n\n` +
  `*9* معلوماتي | Statut\n*0️⃣* استراحة | Pause\n👉 ${driverLink(phone)}`;

async function handleDriver(msg, driver) {
  const phone      = driver.phone;
  const msgType    = msg.type;
  const text       = (msgType === 'text' ? (msg.text?.body || '') : '').trim();
  const hasLocation = msgType === 'location';

  // ── 1 / 2 : répondre à une offre en attente ───────────────
  if (pendingOffers.has(phone)) {
    if (text === '1') { await acceptRide(phone); return; }
    if (text === '2') { await refuseRide(phone); return; }
    // Tout autre message pendant une offre → rappel
    const offer = pendingOffers.get(phone);
    const dist  = offer ? DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng).toFixed(1) : '?';
    await sendText(phone,
      `🚖 *طلب رحلة في الانتظار !*\n\n` +
      `📍 Client à ${dist} km\n\n` +
      `✅ *1* → قبول | Accepter\n` +
      `❌ *2* → رفض | Refuser\n\n` +
      `_(60 ثانية للرد | 60 secondes)_`
    );
    return;
  }

  // ── 3 : terminer la course ─────────────────────────────────
  if (text === '3') {
    const myRide = await DB.rides.getActiveByDriver(phone);
    if (myRide) {
      await DB.rides.complete(myRide.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone,
        `✅ *انتهت الرحلة ! | Course terminée !*\n` +
        `أنت متاح الآن | Vous êtes en ligne.\n\n` +
        `*0️⃣* استراحة | Pause`
      );
      await processQueue(await DB.drivers.get(phone));
    } else {
      await sendText(phone, `⚠️ لا توجد رحلة نشطة | Aucune course active.`);
    }
    return;
  }

  // ── 0 : pause ─────────────────────────────────────────────
  if (text === '0') {
    await DB.drivers.setStatus('offline', phone);
    await sendText(phone, `⏸ استراحة | Pause.\n\nافتح التطبيق للعودة :\n👉 ${driverLink(phone)}`);
    return;
  }

  // ── 9 : statut ────────────────────────────────────────────
  if (text === '9') {
    const now      = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub   = driver.subscription_end && new Date(driver.subscription_end) > now;
    const sub = hasTrial
      ? `🎁 ${Math.ceil((new Date(driver.trial_until) - now) / 86400000)} أيام مجانية`
      : hasSub
        ? `✅ ${Math.ceil((new Date(driver.subscription_end) - now) / 86400000)} يوم متبقي`
        : `⚠️ انتهى الاشتراك | Expiré`;
    const s = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : '⚫';
    await sendText(phone,
      `📊 *${driver.name}*\n${s} ${driver.status}\n${sub}\n\n` +
      `تطبيق السائق :\n👉 ${driverLink(phone)}`
    );
    return;
  }

  // ── GPS → se mettre en ligne ───────────────────────────────
  if (hasLocation) {
    const lat      = msg.location.latitude;
    const lng      = msg.location.longitude;
    const now      = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub   = driver.subscription_end && new Date(driver.subscription_end) > now;

    if (!driver.active || (!hasTrial && !hasSub)) {
      await sendText(phone, `⚠️ انتهى اشتراكك | Abonnement expiré !\n💰 500 MRU/semaine`);
      return;
    }

    const wasOffline = driver.status === 'offline';
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    await sendText(phone,
      `✅ أنت متاح الآن ! | En ligne !\n\n` +
      `افتح التطبيق لإدارة رحلاتك :\n👉 ${driverLink(phone)}\n\n` +
      `*1* قبول | *2* رفض | *3* إنهاء | *0️⃣* استراحة`
    );
    if (wasOffline) await processQueue(await DB.drivers.get(phone));
    return;
  }

  // ── Course active : "1" position, "2" contact ──────────────
  const activeRide = await DB.rides.getActiveByDriver(phone);

  if (activeRide) {
    if (text === '1') {
      if (activeRide.client_lat && activeRide.client_lng) {
        await sendLocation(phone, activeRide.client_lat, activeRide.client_lng,
          `📍 موقع العميل | Position client`);
      } else {
        await sendText(phone, `⚠️ Localisation client non disponible.`);
      }
      return;
    }
    if (text === '2') {
      await sendText(phone,
        `📞 *Contacter le client :*\n` +
        `wa.me/${activeRide.client_phone}`
      );
      return;
    }
    // Tout autre message pendant une course → rappel menu
    await sendText(phone,
      `🚖 *Course en cours | رحلة جارية*\n\n` +
      `📞 wa.me/${activeRide.client_phone}\n\n` +
      `*1* → 📍 Position client\n` +
      `*2* → 📞 Contacter client\n` +
      `*3* → ✅ Terminer la course`
    );
    return;
  }

  // ── Aucune course, aucune offre — tout message / sticker ───
  // "1" sans course active → "لا توجد رحلة نشطة"
  // Sticker / bitmoji / n'importe quoi → même réponse
  await sendText(phone, NO_RIDE_MSG(phone));
}

module.exports = { handleDriver };
