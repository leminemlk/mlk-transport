// ============================================================
// BOT CHAUFFEUR - Inscription, statut, courses, abonnement
// ============================================================
const { sendText } = require('../whapi');
const DB = require('../db');
const { getState, setState, clearState, acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

async function handleDriver(msg, driver) {
  const phone = driver.phone;
  const text = (msg.text?.body || '').trim().toLowerCase();
  const hasLocation = msg.type === 'location';
  const { state } = getState(phone);

  // ─── VÉRIFIER ABONNEMENT ──────────────────────────────────
  const isActive = driver.active === 1;
  const hasTrial = driver.trial_until && new Date(driver.trial_until) > new Date();
  const hasSub = driver.subscription_end && new Date(driver.subscription_end) > new Date();
  const canWork = isActive && (hasTrial || hasSub);

  // ─── ACCEPTER / REFUSER UNE COURSE ────────────────────────
  if (pendingOffers.has(phone)) {
    if (text === '1' || text === 'oui' || text === 'ok') {
      await acceptRide(phone);
      return;
    }
    if (text === '2' || text === 'non') {
      await refuseRide(phone);
      return;
    }
  }

  // ─── FIN DE COURSE ────────────────────────────────────────
  if (text === 'fin' || text === 'terminé' || text === 'termine') {
    // Trouver la course active du chauffeur
    const activeRides = DB.rides.getActive.all();
    const myRide = activeRides.find(r => r.driver_phone === phone && r.status === 'assigned');
    if (myRide) {
      DB.rides.complete.run(myRide.id);
      DB.drivers.setStatus.run('online', phone);

      await sendText(phone, '✅ Course terminée ! Vous êtes de nouveau *en ligne*.\n\nEnvoyez *pause* pour vous mettre hors ligne.');

      // Traiter la file d'attente
      const freshDriver = DB.drivers.get.get(phone);
      await processQueue(freshDriver);
    } else {
      await sendText(phone, '⚠️ Aucune course active trouvée.');
    }
    return;
  }

  // ─── PAUSE / SE METTRE HORS LIGNE ─────────────────────────
  if (text === 'pause' || text === 'stop' || text === 'offline') {
    DB.drivers.setStatus.run('offline', phone);
    await sendText(phone, '⏸ Vous êtes *hors ligne*.\n\nEnvoyez votre 📍 *position* pour repasser en ligne.');
    return;
  }

  // ─── STATUT ───────────────────────────────────────────────
  if (text === 'statut' || text === 'status' || text === 'info') {
    const now = new Date();
    const trialEnd = driver.trial_until ? new Date(driver.trial_until) : null;
    const subEnd = driver.subscription_end ? new Date(driver.subscription_end) : null;

    let subInfo = '';
    if (hasTrial && trialEnd) {
      const days = Math.ceil((trialEnd - now) / 86400000);
      subInfo = `🎁 *Période d'essai* — encore *${days} jours* gratuits`;
    } else if (hasSub && subEnd) {
      const days = Math.ceil((subEnd - now) / 86400000);
      subInfo = `✅ *Abonnement actif* — expire dans *${days} jours*`;
    } else {
      subInfo = `⚠️ *Abonnement expiré* — contactez MLK Transport pour renouveler`;
    }

    await sendText(phone,
      `📊 *Votre statut*\n\n` +
      `👤 ${driver.name}\n` +
      `🔴 État : *${driver.status === 'online' ? '🟢 En ligne' : driver.status === 'busy' ? '🟡 En course' : '⚫ Hors ligne'}*\n\n` +
      `${subInfo}\n\n` +
      `Commandes :\n` +
      `• Envoyez 📍 *position* → passer en ligne\n` +
      `• *pause* → se mettre hors ligne\n` +
      `• *fin* → terminer la course en cours`
    );
    return;
  }

  // ─── POSITION REÇUE → METTRE EN LIGNE ─────────────────────
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;

    if (!canWork) {
      await sendText(phone,
        `⚠️ *Abonnement expiré !*\n\n` +
        `Contactez MLK Transport pour renouveler votre abonnement.\n` +
        `💰 Tarif : *500 MRU/semaine*`
      );
      return;
    }

    const wasOffline = driver.status === 'offline';
    DB.drivers.setOnlineWithLocation.run(lat, lng, phone);

    await sendText(phone,
      `✅ Vous êtes *en ligne* et prêt à recevoir des courses !\n\n` +
      `📍 Position enregistrée\n\n` +
      `• *pause* → se mettre hors ligne\n` +
      `• *statut* → voir vos infos\n` +
      `• *fin* → terminer une course`
    );

    // Si le chauffeur revient en ligne, traiter la file d'attente
    if (wasOffline) {
      const freshDriver = DB.drivers.get.get(phone);
      await processQueue(freshDriver);
    }
    return;
  }

  // ─── AIDE ─────────────────────────────────────────────────
  await sendText(phone,
    `🚖 *MLK Transport — Espace Chauffeur*\n\n` +
    `Commandes disponibles :\n\n` +
    `📍 *Position GPS* → passer en ligne et recevoir des courses\n` +
    `*1* → accepter une course proposée\n` +
    `*2* → refuser une course proposée\n` +
    `*fin* → terminer la course en cours\n` +
    `*pause* → se mettre hors ligne\n` +
    `*statut* → voir votre statut et abonnement`
  );
}

module.exports = { handleDriver };
