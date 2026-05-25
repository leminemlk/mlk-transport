// ============================================================
// BOT CLIENT - Ultra simple : envoie position → reçoit chauffeur
// ============================================================
const { sendText, sendButtons } = require('../whapi');
const DB = require('../db');
const { getState, setState, clearState, findDriver } = require('../queue');

async function handleClient(msg, phone) {
  // S'assurer que le client existe en DB
  DB.clients.upsert.run(phone);

  const text = (msg.text?.body || '').trim().toLowerCase();
  const hasLocation = msg.type === 'location';
  const { state, data } = getState(phone);

  // ─── ANNULER ──────────────────────────────────────────────
  if (text === 'annuler' || text === 'cancel') {
    DB.queue.remove.run(phone);
    clearState(phone);
    await sendText(phone, '❌ Demande annulée.\n\nEnvoyez votre 📍 *position* quand vous êtes prêt.');
    return;
  }

  // ─── ENREGISTRER ADRESSE FAVORITE ─────────────────────────
  if (state === 'saving_favorite' && hasLocation) {
    const { label } = data;
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    DB.clients.saveFavorite.run(label, JSON.stringify({ lat, lng }), phone);
    clearState(phone);
    await sendText(phone, `✅ *${label === 'maison' ? '🏠 Maison' : '🏢 Bureau'}* enregistré !\n\nEnvoyez votre 📍 position pour appeler une voiture.`);
    return;
  }

  // ─── MENU FAVORIS ─────────────────────────────────────────
  if (text === 'favoris' || text === 'favori') {
    await sendButtons(phone,
      '📌 *Adresses favorites*\nQue voulez-vous faire ?',
      ['🏠 Enregistrer Maison', '🏢 Enregistrer Bureau', '🗺 Utiliser Maison', '🗺 Utiliser Bureau']
    );
    setState(phone, 'favorites_menu');
    return;
  }

  // ─── RÉPONSES MENU FAVORIS ────────────────────────────────
  if (state === 'favorites_menu') {
    if (text === '1' || text.includes('enregistrer maison')) {
      setState(phone, 'saving_favorite', { label: 'maison' });
      await sendText(phone, '🏠 Envoyez la 📍 *position de votre maison* maintenant.');
      return;
    }
    if (text === '2' || text.includes('enregistrer bureau')) {
      setState(phone, 'saving_favorite', { label: 'bureau' });
      await sendText(phone, '🏢 Envoyez la 📍 *position de votre bureau* maintenant.');
      return;
    }
    // Utiliser un favori
    const client = DB.clients.get.get(phone);
    const favorites = JSON.parse(client?.favorites || '{}');

    if (text === '3' || text.includes('utiliser maison')) {
      if (!favorites.maison) {
        await sendText(phone, '❌ Maison pas encore enregistrée.\nEnvoyez "favoris" pour l\'ajouter.');
        clearState(phone);
        return;
      }
      clearState(phone);
      await requestRideFromLocation(phone, favorites.maison.lat, favorites.maison.lng, '🏠 Maison');
      return;
    }
    if (text === '4' || text.includes('utiliser bureau')) {
      if (!favorites.bureau) {
        await sendText(phone, '❌ Bureau pas encore enregistré.\nEnvoyez "favoris" pour l\'ajouter.');
        clearState(phone);
        return;
      }
      clearState(phone);
      await requestRideFromLocation(phone, favorites.bureau.lat, favorites.bureau.lng, '🏢 Bureau');
      return;
    }
    clearState(phone);
  }

  // ─── POSITION GPS REÇUE → DEMANDER UNE VOITURE ────────────
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    clearState(phone);
    await requestRideFromLocation(phone, lat, lng);
    return;
  }

  // ─── MESSAGE D'ACCUEIL ────────────────────────────────────
  await sendText(phone,
    `🚖 *Bienvenue chez MLK Transport !*\n\n` +
    `📍 Envoyez votre *position GPS* pour appeler une voiture.\n\n` +
    `Autres commandes :\n` +
    `• *favoris* — gérer vos adresses (🏠 Maison, 🏢 Bureau)\n` +
    `• *annuler* — annuler une demande en cours`
  );
}

/** Créer une course depuis une position */
async function requestRideFromLocation(phone, lat, lng, label = '') {
  const ride = DB.rides.create.run(phone, lat, lng);
  const rideId = ride.lastInsertRowid;

  const where = label ? ` depuis *${label}*` : '';
  await sendText(phone, `🔍 Recherche d'un chauffeur${where}...\nVeuillez patienter.`);

  const found = await findDriver(phone, lat, lng, rideId);
  // Si found=false, le client est mis en file d'attente (géré dans findDriver)
}

module.exports = { handleClient };
