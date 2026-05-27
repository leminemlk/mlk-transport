const { sendText } = require('../whapi');
const DB = require('../db');
const { getState, setState, clearState, acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

async function handleDriver(msg, driver) {
  const phone = driver.phone;
  const text = (msg.text?.body || '').trim();
  const hasLocation = msg.type === 'location';

  // Offre en attente → 1 accepter, 2 refuser
  if (pendingOffers.has(phone)) {
    if (text === '1') { await acceptRide(phone); return; }
    if (text === '2') { await refuseRide(phone); return; }
  }

  // 3 = fin de course
  if (text === '3') {
    const myRide = await DB.rides.getActiveByDriver(phone);
    if (myRide) {
      await DB.rides.complete(myRide.id);
      await DB.drivers.setStatus('online', phone);
      await sendText(phone,
        `✅ انتهت الرحلة ! | Course terminée !\n` +
        `أنت متاح الآن | Vous êtes en ligne.\n\n` +
        `اكتب *0️⃣* للاستراحة | Tapez *0️⃣* pour pause`
      );
      const freshDriver = await DB.drivers.get(phone);
      await processQueue(freshDriver);
    } else {
      await sendText(phone, `⚠️ لا توجد رحلة نشطة | Aucune course active.`);
    }
    return;
  }

  // 0 = pause
  if (text === '0') {
    await DB.drivers.setStatus('offline', phone);
    await sendText(phone,
      `⏸ استراحة | Pause.\n` +
      `أرسل موقعك 📍 للعودة | Envoyez position 📍 pour reprendre.`
    );
    return;
  }

  // 9 = statut
  if (text === '9') {
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;
    let subInfo = hasTrial
      ? `🎁 ${Math.ceil((new Date(driver.trial_until)-now)/86400000)} يوم مجاني | jours gratuits`
      : hasSub
      ? `✅ ${Math.ceil((new Date(driver.subscription_end)-now)/86400000)} يوم | jours restants`
      : `⚠️ انتهى الاشتراك | Abonnement expiré`;
    const s = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : '⚫';
    await sendText(phone,
      `📊 *${driver.name}*\n${s} ${driver.status}\n${subInfo}\n\n` +
      `📍 موقعك → متاح\n*1* قبول | *2* رفض\n*3* إنهاء الرحلة\n*0️⃣* استراحة\n*9* معلوماتي`
    );
    return;
  }

  // موقع GPS
  if (hasLocation) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;

    if (!driver.active || (!hasTrial && !hasSub)) {
      await sendText(phone,
        `⚠️ انتهى اشتراكك | Abonnement expiré !\n💰 500 MRU/semaine`
      );
      return;
    }

    const wasOffline = driver.status === 'offline';
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    await sendText(phone,
      `✅ أنت متاح الآن ! | En ligne !\n\n` +
      `*1* قبول | *2* رفض | *3* إنهاء\n*0️⃣* استراحة | *9* معلوماتي`
    );
    if (wasOffline) await processQueue(await DB.drivers.get(phone));
    return;
  }

  // Message non reconnu → aide
  await sendText(phone,
    `🚕 *MK TAXI — سائق | Chauffeur*\n\n` +
    `📍 أرسل موقعك → متاح | Position → en ligne\n` +
    `*1* قبول رحلة | Accepter course\n` +
    `*2* رفض رحلة | Refuser course\n` +
    `*3* إنهاء الرحلة | Terminer course\n` +
    `*0️⃣* استراحة | Pause\n` +
    `*9* معلوماتي | Mon statut`
  );
}

module.exports = { handleDriver };
