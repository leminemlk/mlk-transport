const { sendText } = require('../whapi');
const DB = require('../db');
const { acceptRide, refuseRide, pendingOffers, processQueue } = require('../queue');

const BASE_URL = 'https://mlk-transport-production.up.railway.app';
const driverLink = (phone) => `${BASE_URL}/chauffeur.html?phone=${phone}`;

async function handleDriver(msg, driver) {
  const phone = driver.phone;
  const text = (msg.text?.body || '').trim();
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
        `✅ انتهت الرحلة ! | Course terminée !\n` +
        `أنت متاح الآن | Vous êtes en ligne.\n\n` +
        `*0️⃣* استراحة | Pause`
      );
      await processQueue(await DB.drivers.get(phone));
    } else {
      await sendText(phone, `⚠️ لا توجد رحلة نشطة | Aucune course active.`);
    }
    return;
  }

  // 0 = pause
  if (text === '0') {
    await DB.drivers.setStatus('offline', phone);
    await sendText(phone, `⏸ استراحة | Pause.\n\nافتح التطبيق للعودة :\n👉 ${driverLink(phone)}`);
    return;
  }

  // 9 = statut
  if (text === '9') {
    const now = new Date();
    const hasTrial = driver.trial_until && new Date(driver.trial_until) > now;
    const hasSub = driver.subscription_end && new Date(driver.subscription_end) > now;
    const sub = hasTrial
      ? `🎁 ${Math.ceil((new Date(driver.trial_until)-now)/86400000)} أيام مجانية`
      : hasSub
      ? `✅ ${Math.ceil((new Date(driver.subscription_end)-now)/86400000)} يوم متبقي`
      : `⚠️ انتهى الاشتراك | Expiré`;
    const s = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : '⚫';
    await sendText(phone,
      `📊 *${driver.name}*\n${s} ${driver.status}\n${sub}\n\n` +
      `تطبيق السائق :\n👉 ${driverLink(phone)}`
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
      await sendText(phone, `⚠️ انتهى اشتراكك | Abonnement expiré !\n💰 500 MRU/semaine`);
      return;
    }

    const wasOffline = driver.status === 'offline';
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    await sendText(phone,
      `✅ أنت متاح الآن ! | En ligne !\n\n` +
      `افتح التطبيق لإدارة رحلاتك :\n👉 ${driverLink(phone)}\n\n` +
      `*1* قبول | *2* رفض | *3* إنهاء | *0️⃣* استراحة`
    );
    if (wasOffline) await processQueue(await DB.drivers.get(phone));
    return;
  }

  // Tout autre message → envoyer le lien directement
  await sendText(phone,
    `🚕 *MK TAXI — تطبيق السائق*\n\n` +
    `افتح الرابط لإدارة رحلاتك :\n` +
    `Ouvrez ce lien pour gérer vos courses :\n\n` +
    `👉 ${driverLink(phone)}\n\n` +
    `*1* قبول | *2* رفض | *3* إنهاء | *0️⃣* استراحة | *9* معلوماتي`
  );
}

module.exports = { handleDriver };
