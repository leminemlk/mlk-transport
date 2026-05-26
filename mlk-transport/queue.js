// ============================================================
// GESTIONNAIRE DE FILE D'ATTENTE + OFFRES CHAUFFEURS
// ============================================================
const { sendText, sendButtons, sendLocation } = require('./whapi');
const DB = require('./db');

// Offres en cours : driverPhone → { rideId, clientPhone, clientLat, clientLng, timer }
const pendingOffers = new Map();

// État de conversation : phone → { state, data }
const states = new Map();

function getState(phone) {
  return states.get(phone) || { state: 'idle', data: {} };
}

function setState(phone, state, data = {}) {
  states.set(phone, { state, data });
}

function clearState(phone) {
  states.delete(phone);
}

// ─── RECHERCHE D'UN CHAUFFEUR ────────────────────────────────

/**
 * Lance la recherche d'un chauffeur pour un client.
 * Retourne true si un chauffeur a été contacté, false si file d'attente.
 */
async function findDriver(clientPhone, clientLat, clientLng, rideId) {
  const drivers = DB.findNearestDrivers(clientLat, clientLng, 5);

  // Filtrer les chauffeurs déjà en attente d'une offre
  const available = drivers.filter(d => !pendingOffers.has(d.phone));

  if (available.length === 0) {
    // Aucun chauffeur dispo → file d'attente
    DB.queue.add.run(clientPhone, clientLat, clientLng);
    const pos = DB.queue.getPosition.get(clientPhone);
    await sendText(clientPhone,
      `⏳ Tous les chauffeurs sont occupés en ce moment.\n\n` +
      `Vous êtes *n°${pos?.position || 1}* dans la file d'attente.\n` +
      `Vous serez contacté dès qu'un chauffeur se libère.\n\n` +
      `Envoyez *annuler* pour annuler.`
    );
    return false;
  }

  // Envoyer l'offre au premier chauffeur disponible
  await offerRide(available[0], rideId, clientPhone, clientLat, clientLng);
  return true;
}

/** Envoyer une offre de course à un chauffeur (timeout 60s) */
async function offerRide(driver, rideId, clientPhone, clientLat, clientLng) {
  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta = DB.estimateMinutes(dist);

  await sendText(driver.phone,
    `🚖 *Nouvelle course !*\n\n` +
    `📍 Client à *${dist.toFixed(1)} km* de vous\n` +
    `⏱ Temps estimé : *${eta} min*\n\n` +
    `Répondez :\n` +
    `✅ *1* — Accepter\n` +
    `❌ *2* — Refuser\n\n` +
    `_(Vous avez 60 secondes)_`
  );

  // Envoyer la position du client au chauffeur
  await sendLocation(driver.phone, clientLat, clientLng, 'Client', 'Position du client');

  // Marquer le chauffeur comme ayant une offre en attente
  const timer = setTimeout(async () => {
    if (pendingOffers.has(driver.phone)) {
      pendingOffers.delete(driver.phone);
      await sendText(driver.phone, '⏰ Temps écoulé — la course a été proposée à un autre chauffeur.');
      // Essayer le chauffeur suivant
      await retryNextDriver(rideId, clientPhone, clientLat, clientLng, driver.phone);
    }
  }, 60_000);

  pendingOffers.set(driver.phone, { rideId, clientPhone, clientLat, clientLng, timer });
}

/** Essayer le prochain chauffeur disponible (après refus ou timeout) */
async function retryNextDriver(rideId, clientPhone, clientLat, clientLng, skipPhone) {
  const drivers = DB.findNearestDrivers(clientLat, clientLng, 5);
  const next = drivers.find(d => d.phone !== skipPhone && !pendingOffers.has(d.phone));

  if (next) {
    await offerRide(next, rideId, clientPhone, clientLat, clientLng);
  } else {
    // Plus personne → file d'attente
    DB.queue.add.run(clientPhone, clientLat, clientLng);
    const pos = DB.queue.getPosition.get(clientPhone);
    await sendText(clientPhone,
      `😔 Aucun chauffeur disponible pour le moment.\n\n` +
      `Vous êtes *n°${pos?.position || 1}* dans la file d'attente.\n` +
      `Vous serez contacté automatiquement.`
    );
  }
}

/** Le chauffeur accepte la course */
async function acceptRide(driverPhone) {
  const offer = pendingOffers.get(driverPhone);
  if (!offer) return false;

  clearTimeout(offer.timer);
  pendingOffers.delete(driverPhone);

  const { rideId, clientPhone, clientLat, clientLng } = offer;
  const driver = DB.drivers.get.get(driverPhone);

  // Mettre à jour la base
  DB.rides.assign.run(driverPhone, rideId);
  DB.drivers.setStatus.run('busy', driverPhone);
  DB.queue.remove.run(clientPhone);

  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta = DB.estimateMinutes(dist);

  // Notifier le client
  await sendText(clientPhone,
    `✅ *Chauffeur trouvé !*\n\n` +
    `🚖 *${driver.name}*\n` +
    `📞 ${driverPhone}\n` +
    `⏱ Arrive dans *~${eta} min*\n\n` +
    `Le chauffeur est en route vers vous.`
  );

  // Envoyer la position du client au chauffeur (confirmation)
  await sendText(driverPhone,
    `✅ Course acceptée !\n\n` +
    `📞 Client : ${clientPhone}\n` +
    `Bonne route ! 🚗`
  );
  await sendLocation(driverPhone, clientLat, clientLng, 'Client', 'Allez chercher le client ici');

  return true;
}

/** Le chauffeur refuse la course */
async function refuseRide(driverPhone) {
  const offer = pendingOffers.get(driverPhone);
  if (!offer) return false;

  clearTimeout(offer.timer);
  pendingOffers.delete(driverPhone);

  const { rideId, clientPhone, clientLat, clientLng } = offer;

  await sendText(driverPhone, '👌 Course refusée.');
  await retryNextDriver(rideId, clientPhone, clientLat, clientLng, driverPhone);
  return true;
}

/** Quand un chauffeur passe en ligne → traiter la file d'attente */
async function processQueue(driver) {
  const queue = DB.queue.getAll.all();
  if (queue.length === 0) return;

  const first = queue[0];
  const ride = DB.rides.create.run(first.client_phone, first.client_lat, first.client_lng);

  await sendText(first.client_phone,
    `🎉 Un chauffeur est maintenant disponible !\n\nNous lui envoyons votre demande...`
  );

  await offerRide(driver, ride.lastInsertRowid, first.client_phone, first.client_lat, first.client_lng);
}

module.exports = {
  getState, setState, clearState,
  findDriver, acceptRide, refuseRide, processQueue, pendingOffers
};
