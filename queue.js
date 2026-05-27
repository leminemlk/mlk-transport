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
      `أرسل *إلغاء* للإلغاء | Envoyez *annuler* pour annuler.`
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
    `📞 رقم العميل : *+${clientPhone}*\n\n` +
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

  // ── Envoyer info chauffeur au client (avec photo) ──────────
  await sendText(clientPhone,
    `✅ *تم قبول طلبك ! | Chauffeur trouvé !*\n\n` +
    `👤 *${driver.name}*\n` +
    `📞 *+${driverPhone}*\n` +
    `${clim}\n` +
    `⏱ يصل في *~${eta} دقيقة* | arrive dans *~${eta} min*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *تفاوض مباشرة مع السائق على السعر*\n` +
    `*Négociez directement avec le chauffeur*\n` +
    `🚫 بدون عمولة وسيط | Sans commission intermédiaire\n` +
    `━━━━━━━━━━━━━━━━━━`
  );

  // Envoyer photo extérieure du véhicule si disponible
  if (driver.photo_ext) {
    try {
      await sendImage(clientPhone, driver.photo_ext,
        `🚗 ${driver.name} — +${driverPhone}`
      );
    } catch(e) {
      console.log('Photo non envoyée:', e.message);
    }
  }

  // ── Envoyer info client au chauffeur ───────────────────────
  await sendText(driverPhone,
    `✅ *قبلت الرحلة ! | Course acceptée !*\n\n` +
    `📞 *العميل | Client : +${clientPhone}*\n\n` +
    `اتصل بالعميل لتحديد السعر\n` +
    `Appelez le client pour négocier le prix.\n\n` +
    `بعد انتهاء الرحلة أرسل : *fin*`
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
