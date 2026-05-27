const { sendText } = require('../whapi');
const DB = require('../db');
const { getState, setState, clearState, acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

async function handleDriver(msg, driver) {
  const phone = driver.phone;
  const text = (msg.text?.body || '').trim().toLowerCase();
  const hasLocation = msg.type === 'location';

  // 1 = قبول | 2 = رفض
  if (pendingOffers.has(phone)) {
    if (text === '1') { await acceptRide(phone); return; }
    if (text === '2') { await refuseRide(phone); return; }
  }

  // 3 = إنهاء الرحلة
  if (text === '3') {
    const myRide = await DB.rides.getActiveByDriver(phone);
    if (myRide) {
      await DB.rides.complete(myRide.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone,
        `✅ انتهت الرحلة ! | Course terminée !\n\n` +
        `أنت متاح الآن لرحلات جديدة.\n` +
        `Vous êtes de nouveau en ligne.\n\n` +
        `*0* → استراحة | Pause`
      );
      const freshDriver = await DB.drivers.get(phone);
      await processQueue(freshDriver);
    } else {
      await sendText(phone, `⚠️ لا توجد رحلة نشطة | Aucune course active.`);
    }
    return;
  }

  // 0 = استراحة / pause
  if (text === '0') {
    await DB.drivers.setStatus('offline', phone);
    await sendText(phone,
      `⏸ أنت في وضع الاستراحة | Vous êtes en pause.\n\n` +
      `أرسل موقعك 📍 للعودة للعمل\n` +
      `Envoyez votre position 📍 pour reprendre.`
    );
    return;
  }

  // 9 = معلومات / statut
  if (text === '9') {
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;
    let subInfo = '';
    if (hasTrial) {
      const days = Math.ceil((new Date(driver.trial_until) - now) / 86400000);
      subInfo = `🎁 ${days} أيام مجانية | jours gratuits`;
    } else if (hasSub) {
      const days = Math.ceil((new Date(driver.subscription_end) - now) / 86400000);
      subInfo = `✅ اشتراك نشط ${days} يوم | Abonnement ${days}j`;
    } else {
      subInfo = `⚠️ انتهى الاشتراك | Abonnement expiré`;
    }
    const statusEmoji = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : '⚫';
    await sendText(phone,
      `📊 *${driver.name}*\n` +
      `${statusEmoji} ${driver.status}\n` +
      `${subInfo}\n\n` +
      `📍 موقعك → متاح | Position → en ligne\n` +
      `*1* → قبول رحلة | Accepter\n` +
      `*2* → رفض رحلة | Refuser\n` +
      `*3* → إنهاء الرحلة | Terminer\n` +
      `*0* → استراحة | Pause\n` +
      `*9* → معلوماتي | Mon statut`
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
        `⚠️ انتهى اشتراكك | Abonnement expiré !\n` +
        `تواصل مع الإدارة | Contactez MLK Transport.\n` +
        `💰 500 MRU/semaine`
      );
      return;
    }

    const wasOffline = driver.status === 'offline';
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);

    await sendText(phone,
      `✅ أنت متاح الآن ! | Vous êtes en ligne !\n\n` +
      `*1* → قبول | Accepter\n` +
      `*2* → رفض | Refuser\n` +
      `*3* → إنهاء الرحلة | Terminer\n` +
      `*0* → استراحة | Pause\n` +
      `*9* → معلوماتي | Statut`
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
    `📍 أرسل موقعك → متاح | Position → en ligne\n\n` +
    `*1* → قبول رحلة | Accepter course\n` +
    `*2* → رفض رحلة | Refuser course\n` +
    `*3* → إنهاء الرحلة | Terminer course\n` +
    `*0* → استراحة | Pause\n` +
    `*9* → معلوماتي | Mon statut`
  );
}

module.exports = { handleDriver };
