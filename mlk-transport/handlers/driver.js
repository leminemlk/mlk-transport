const { sendText } = require('../whapi');
const DB = require('../db');
const { getState, setState, clearState, acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

async function handleDriver(msg, driver) {
  const phone = driver.phone;
  const text = (msg.text?.body || '').trim().toLowerCase();
  const hasLocation = msg.type === 'location';

  // Accepter/Refuser une course
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

  // Fin de course
  if (text === 'fin' || text === 'terminé' || text === 'termine') {
    const myRide = await DB.rides.getActiveByDriver(phone);
    if (myRide) {
      await DB.rides.complete(myRide.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone, '✅ Course terminée ! Vous êtes de nouveau *en ligne*.\n\nEnvoyez *pause* pour vous mettre hors ligne.');
      const freshDriver = await DB.drivers.get(phone);
      await processQueue(freshDriver);
    } else {
      await sendText(phone, '⚠️ Aucune course active trouvée.');
    }
    return;
  }

  // Pause
  if (text === 'pause' || text === 'stop') {
    await DB.drivers.setStatus('offline', phone);
    await sendText(phone, '⏸ Vous êtes *hors ligne*.\n\nEnvoyez votre 📍 position pour repasser en ligne.');
    return;
  }

  // Statut
  if (text === 'statut' || text === 'status') {
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;

    let subInfo = '';
    if (hasTrial) {
      const days = Math.ceil((new Date(driver.trial_until) - now) / 86400000);
      subInfo = `🎁 *Période d'essai* — encore *${days} jours* gratuits`;
    } else if (hasSub) {
      const days = Math.ceil((new Date(driver.subscription_end) - now) / 86400000);
      subInfo = `✅ *Abonnement actif* — expire dans *${days} jours*`;
    } else {
      subInfo = `⚠️ *Abonnement expiré* — contactez MLK Transport`;
    }

    const statusEmoji = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : '⚫';
    await sendText(phone,
      `📊 *Votre statut*\n\n` +
      `👤 ${driver.name}\n` +
      `${statusEmoji} État : *${driver.status}*\n\n` +
      `${subInfo}\n\n` +
      `• 📍 Position → passer en ligne\n` +
      `• *pause* → hors ligne\n` +
      `• *fin* → terminer la course\n` +
      `• *1* → accepter | *2* → refuser`
    );
    return;
  }

  // Position reçue → en ligne
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;

    if (!driver.active || (!hasTrial && !hasSub)) {
      await sendText(phone,
        `⚠️ *Abonnement expiré !*\n\n` +
        `Contactez MLK Transport pour renouveler.\n` +
        `💰 Tarif : *500 MRU/semaine*`
      );
      return;
    }

    const wasOffline = driver.status === 'offline';
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);

    await sendText(phone,
      `✅ Vous êtes *en ligne* et prêt à recevoir des courses !\n\n` +
      `• *pause* → hors ligne\n` +
      `• *fin* → terminer une course\n` +
      `• *statut* → voir vos infos`
    );

    if (wasOffline) {
      const freshDriver = await DB.drivers.get(phone);
      await processQueue(freshDriver);
    }
    return;
  }

  // Aide
  await sendText(phone,
    `🚖 *MLK Transport — Chauffeur*\n\n` +
    `📍 *Position GPS* → passer en ligne\n` +
    `*1* → accepter une course\n` +
    `*2* → refuser une course\n` +
    `*fin* → terminer la course\n` +
    `*pause* → hors ligne\n` +
    `*statut* → voir votre abonnement`
  );
}

module.exports = { handleDriver };
