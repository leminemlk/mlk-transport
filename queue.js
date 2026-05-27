// ============================================================
// FILE D'ATTENTE + OFFRES CHAUFFEURS
// ============================================================
const { sendText, sendLocation, sendImage } = require('./whapi');
const DB = require('./db');

const pendingOffers = new Map();
const states = new Map();

function getState(phone) { return states.get(phone) || { state: 'idle', data: {} }; }
function setState(phone, state, data = {}) { states.set(phone, { state, data }); }
function clearState(phone) { states.delete(phone); }

async function findDriver(clientPhone, clientLat, clientLng, rideId) {
  const drivers = await DB.findNearestDrivers(clientLat, clientLng, 5);
  const available = drivers.filter(d => !pendingOffers.has(d.phone));

  if (available.length === 0) {
    await DB.queue.add(clientPhone, clientLat, clientLng);
    const pos = await DB.queue.getPosition(clientPhone);
    await sendText(clientPhone,
      `⏳ جميع السائقين مشغولون | Tous les chauffeurs sont occupés.\n\n` +
      `أنت رقم *${pos}* في قائمة الانتظار.\n` +
      `Vous êtes *n°${pos}* dans la file.\n\n` +
      `اكتب الرقم *0️⃣* للإلغاء | Tapez le chiffre *0️⃣* pour annuler.`
    );
    return false;
  }

  await offerRide(available[0], rideId, clientPhone, clientLat, clientLng);
  return true;
}

async function offerRide(driver, rideId, clientPhone, clientLat, clientLng) {
  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta = DB.estimateMinutes(dist);
  const clim = driver.clim ? '❄️ مكيفة | Climatisée' : '🌡 بدون تكييف | Sans clim';

  await sendText(driver.phone,
    `🚖 *طلب رحلة جديد ! | Nouvelle course !*\n\n` +
    `📍 العميل على بعد *${dist.toFixed(1)} كم* | à *${dist.toFixed(1)} km*\n` +
    `⏱ وقت الوصول : *${eta} دقيقة* | *${eta} min*\n` +
    `📞 رقم العميل : wa.me/${clientPhone}\n` +
    `✅ *1* → قبول | Accepter\n` +
    `❌ *2* → رفض | Refuser\n\n` +
    `_(60 ثانية للرد | 60 secondes)_`
  );

  await sendLocation(driver.phone, clientLat, clientLng, 'موقع العميل | Position client');

  const timer = setTimeout(async () => {
    if (pendingOffers.has(driver.phone)) {
      pendingOffers.delete(driver.phone);
      await sendText(driver.phone, '⏰ انتهى الوقت | Temps écoulé — course proposée à un autre.');
      await retryNextDriver(rideId, clientPhone, clientLat, clientLng, driver.phone);
    }
  }, 60_000);

  pendingOffers.set(driver.phone, { rideId, clientPhone, clientLat, clientLng, timer });
}

async function retryNextDriver(rideId, clientPhone, clientLat, clientLng, skipPhone) {
  const drivers = await DB.findNearestDrivers(clientLat, clientLng, 5);
  const next = drivers.find(d => d.phone !== skipPhone && !pendingOffers.has(d.phone));

  if (next) {
    await offerRide(next, rideId, clientPhone, clientLat, clientLng);
  } else {
    await DB.queue.add(clientPhone, clientLat, clientLng);
    const pos = await DB.queue.getPosition(clientPhone);
    await sendText(clientPhone,
      `😔 لا يوجد سائق متاح | Aucun chauffeur disponible.\n\n` +
      `أنت رقم *${pos}* في قائمة الانتظار.\n` +
      `Vous êtes *n°${pos}* dans la file.`
    );
  }
}

async function acceptRide(driverPhone) {
  const offer = pendingOffers.get(driverPhone);
  if (!offer) return false;

  clearTimeout(offer.timer);
  pendingOffers.delete(driverPhone);

  const { rideId, clientPhone, clientLat, clientLng } = offer;
  const driver = await DB.drivers.get(driverPhone);

  await DB.rides.assign(driverPhone, rideId);
  await DB.drivers.setStatus('busy', driverPhone);
  await DB.queue.remove(clientPhone);

  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta = DB.estimateMinutes(dist);
  const clim = driver.clim ? '❄️ مكيفة | Climatisée' : '🌡 بدون تكييف | Sans clim';

  // ── Envoyer photo + détails chauffeur au client ─────────────
  if (driver.photo_ext) {
    // Envoyer la photo avec tous les détails en caption
    try {
      await sendImage(clientPhone, driver.photo_ext,
        `🚕 *تم قبول طلبك ! | Chauffeur trouvé !*\n\n` +
        `👤 *${driver.name}*\n` +
        `📞 wa.me/${driverPhone}\n` +
        `${clim}\n` +
        `⏱ يصل في *~${eta} دق* | ~${eta} min\n\n` +
        `💬 تفاوض مباشرة على السعر\n` +
        `Négociez directement le prix\n` +
        `🚫 بدون عمولة | Sans commission`
      );
    } catch(e) {
      // Si l'image échoue, envoyer texte seul
      await sendText(clientPhone,
        `🚕 *تم قبول طلبك ! | Chauffeur trouvé !*\n\n` +
        `👤 *${driver.name}*\n` +
        `📞 wa.me/${driverPhone}\n` +
        `${clim}\n` +
        `⏱ يصل في *~${eta} دق* | ~${eta} min\n\n` +
        `💬 تفاوض مباشرة على السعر\n` +
        `🚫 بدون عمولة | Sans commission`
      );
    }
  } else {
    // Pas de photo → texte seul
    await sendText(clientPhone,
      `🚕 *تم قبول طلبك ! | Chauffeur trouvé !*\n\n` +
      `👤 *${driver.name}*\n` +
      `📞 wa.me/${driverPhone}\n` +
      `${clim}\n` +
      `⏱ يصل في *~${eta} دق* | ~${eta} min\n\n` +
      `💬 تفاوض مباشرة على السعر\n` +
      `🚫 بدون عمولة | Sans commission`
    );
  }

  // ── Envoyer info client au chauffeur ───────────────────────
  await sendText(driverPhone,
    `✅ *قبلت الرحلة ! | Course acceptée !*\n\n` +
    `📞 *العميل | Client :*\nwa.me/${clientPhone}\n\n` +
    `اتصل بالعميل لتحديد السعر\n` +
    `Appelez le client pour négocier le prix.\n\n` +
    `بعد انتهاء الرحلة اضغط : *3️⃣*`
  );

  await sendLocation(driverPhone, clientLat, clientLng, 'موقع العميل | Position client');
  return true;
}

async function refuseRide(driverPhone) {
  const offer = pendingOffers.get(driverPhone);
  if (!offer) return false;

  clearTimeout(offer.timer);
  pendingOffers.delete(driverPhone);

  await sendText(driverPhone, '👌 رفضت الرحلة | Course refusée.');
  await retryNextDriver(offer.rideId, offer.clientPhone, offer.clientLat, offer.clientLng, driverPhone);
  return true;
}

async function processQueue(driver) {
  const queueList = await DB.queue.getAll();
  if (queueList.length === 0) return;

  const first = queueList[0];
  const rideId = await DB.rides.create(first.client_phone, first.client_lat, first.client_lng);

  await sendText(first.client_phone,
    `🎉 سائق متاح الآن ! | Un chauffeur est disponible !\nجاري إرسال طلبك...\nEnvoi de votre demande...`
  );
  await offerRide(driver, rideId, first.client_phone, first.client_lat, first.client_lng);
}

module.exports = {
  getState, setState, clearState,
  findDriver, acceptRide, refuseRide, processQueue, pendingOffers
};
