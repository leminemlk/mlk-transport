// ============================================================
// FILE D'ATTENTE + OFFRES CHAUFFEURS - Version PostgreSQL
// ============================================================
const { sendText, sendLocation } = require('./whapi');
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
      `⏳ Tous les chauffeurs sont occupés.\n\n` +
      `Vous êtes *n°${pos}* dans la file d'attente.\n` +
      `Envoyez *annuler* pour annuler.`
    );
    return false;
  }

  await offerRide(available[0], rideId, clientPhone, clientLat, clientLng);
  return true;
}

async function offerRide(driver, rideId, clientPhone, clientLat, clientLng) {
  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta = DB.estimateMinutes(dist);

  await sendText(driver.phone,
    `🚖 *Nouvelle course !*\n\n` +
    `📍 Client à *${dist.toFixed(1)} km*\n` +
    `⏱ Temps estimé : *${eta} min*\n\n` +
    `✅ *1* — Accepter\n` +
    `❌ *2* — Refuser\n\n` +
    `_(60 secondes pour répondre)_`
  );

  await sendLocation(driver.phone, clientLat, clientLng, 'Client', 'Position du client');

  const timer = setTimeout(async () => {
    if (pendingOffers.has(driver.phone)) {
      pendingOffers.delete(driver.phone);
      await sendText(driver.phone, '⏰ Temps écoulé — course proposée à un autre chauffeur.');
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
      `😔 Aucun chauffeur disponible.\n\n` +
      `Vous êtes *n°${pos}* dans la file d'attente.`
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

  await sendText(clientPhone,
    `✅ *Chauffeur trouvé !*\n\n` +
    `🚖 *${driver.name}*\n` +
    `📞 ${driverPhone}\n` +
    `⏱ Arrive dans *~${eta} min*`
  );

  await sendText(driverPhone, `✅ Course acceptée !\n📞 Client : ${clientPhone}\nBonne route ! 🚗`);
  await sendLocation(driverPhone, clientLat, clientLng, 'Client');
  return true;
}

async function refuseRide(driverPhone) {
  const offer = pendingOffers.get(driverPhone);
  if (!offer) return false;

  clearTimeout(offer.timer);
  pendingOffers.delete(driverPhone);

  await sendText(driverPhone, '👌 Course refusée.');
  await retryNextDriver(offer.rideId, offer.clientPhone, offer.clientLat, offer.clientLng, driverPhone);
  return true;
}

async function processQueue(driver) {
  const queueList = await DB.queue.getAll();
  if (queueList.length === 0) return;

  const first = queueList[0];
  const rideId = await DB.rides.create(first.client_phone, first.client_lat, first.client_lng);

  await sendText(first.client_phone, `🎉 Un chauffeur est disponible ! Envoi de votre demande...`);
  await offerRide(driver, rideId, first.client_phone, first.client_lat, first.client_lng);
}

module.exports = {
  getState, setState, clearState,
  findDriver, acceptRide, refuseRide, processQueue, pendingOffers
};
