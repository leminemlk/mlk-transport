const { sendText } = require('../whapi');
const DB = require('../db');
const { getState, setState, clearState, acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

async function handleDriver(msg, driver) {
  const phone = driver.phone;
  const text = (msg.text?.body || '').trim().toLowerCase();
  const hasLocation = msg.type === 'location';

  // قبول/رفض course
  if (pendingOffers.has(phone)) {
    if (text === '1' || text === 'oui' || text === 'ok' || text === 'نعم') {
      await acceptRide(phone);
      return;
    }
    if (text === '2' || text === 'non' || text === 'لا') {
      await refuseRide(phone);
      return;
    }
  }

  // نهاية الرحلة
  if (text === 'fin' || text === 'terminé' || text === 'termine' || text === 'انهاء' || text === 'إنهاء') {
    const myRide = await DB.rides.getActiveByDriver(phone);
    if (myRide) {
      await DB.rides.complete(myRide.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone,
        `✅ انتهت الرحلة ! | Course terminée !\n\n` +
        `أنت متاح الآن لاستقبال رحلات جديدة.\n` +
        `Vous êtes de nouveau en ligne.`
      );
      const freshDriver = await DB.drivers.get(phone);
      await processQueue(freshDriver);
    } else {
      await sendText(phone, `⚠️ لا توجد رحلة نشطة | Aucune course active.`);
    }
    return;
  }

  // استراحة
  if (text === 'pause' || text === 'stop' || text === 'استراحة') {
    await DB.drivers.setStatus('offline', phone);
    await sendText(phone,
      `⏸ أنت الآن غير متاح | Vous êtes hors ligne.\n\n` +
      `أرسل موقعك 📍 للعودة\nEnvoyez votre position 📍 pour reprendre.`
    );
    return;
  }

  // الحالة
  if (text === 'statut' || text === 'status' || text === 'حالة') {
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;
    let subInfo = '';
    if (hasTrial) {
      const days = Math.ceil((new Date(driver.trial_until) - now) / 86400000);
      subInfo = `🎁 فترة تجريبية | Essai gratuit — ${days} jours`;
    } else if (hasSub) {
      const days = Math.ceil((new Date(driver.subscription_end) - now) / 86400000);
      subInfo = `✅ اشتراك نشط | Abonnement actif — ${days} jours`;
    } else {
      subInfo = `⚠️ انتهى الاشتراك | Abonnement expiré`;
    }
    const statusEmoji = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : '⚫';
    await sendText(phone,
      `📊 *حالتك | Votre statut*\n\n` +
      `👤 ${driver.name}\n` +
      `${statusEmoji} ${driver.status}\n\n` +
      `${subInfo}\n\n` +
      `📍 موقعك → متاح | Position → en ligne\n` +
      `*pause* → غير متاح | hors ligne\n` +
      `*fin* → إنهاء الرحلة | terminer\n` +
      `*1* → قبول | accepter\n` +
      `*2* → رفض | refuser`
    );
    return;
  }

  // موقع GPS → متاح
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;

    if (!driver.active || (!hasTrial && !hasSub)) {
      await sendText(phone,
        `⚠️ انتهى اشتراكك | Abonnement expiré !\n\n` +
        `تواصل مع MLK Transport\n` +
        `💰 500 MRU/semaine`
      );
      return;
    }

    const wasOffline = driver.status === 'offline';
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);

    await sendText(phone,
      `✅ أنت متاح الآن ! | Vous êtes en ligne !\n\n` +
      `*pause* → استراحة | hors ligne\n` +
      `*fin* → إنهاء الرحلة | terminer course\n` +
      `*حالة* | *statut* → معلوماتك`
    );

    if (wasOffline) {
      const freshDriver = await DB.drivers.get(phone);
      await processQueue(freshDriver);
    }
    return;
  }

  // مساعدة
  await sendText(phone,
    `🚖 *MLK Transport — سائق | Chauffeur*\n\n` +
    `📍 أرسل موقعك → متاح | Position → en ligne\n` +
    `*1* → قبول رحلة | accepter\n` +
    `*2* → رفض رحلة | refuser\n` +
    `*fin* → إنهاء الرحلة | terminer\n` +
    `*pause* → استراحة | hors ligne\n` +
    `*حالة* | *statut* → معلوماتك`
  );
}

module.exports = { handleDriver };
