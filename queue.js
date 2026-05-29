// ============================================================
// FILE D'ATTENTE + OFFRES — MLK Transport
// Tout stocké en DB — zéro mémoire locale critique
// ============================================================
const { sendText, sendLocation, sendImage } = require('./whapi');
const DB = require('./db');

// États inscription (mémoire OK — léger, court-vécu)
const states = new Map();
function getState(phone)              { return states.get(phone) || { state: 'idle', data: {} }; }
function setState(phone, state, data) { states.set(phone, { state, data: data || {} }); }
function clearState(phone)            { states.delete(phone); }

// ─── RAYON + TIMEOUT depuis settings ─────────────────────────
async function getTimeout() {
  try {
    const r = await DB.pool.query(`SELECT value FROM settings WHERE key='timeout'`);
    return parseInt(r.rows[0]?.value || '60');
  } catch(e) { return 60; }
}

// ─── OFFRIR UNE COURSE ───────────────────────────────────────
async function offerRide(driver, rideId, clientPhone, clientLat, clientLng) {
  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta  = DB.estimateMinutes(dist);

  await sendText(driver.phone,
    `🚖 *طلب رحلة جديد ! | Nouvelle course !*\n\n` +
    `📍 العميل على بعد *${dist.toFixed(1)} كم* | à *${dist.toFixed(1)} km*\n` +
    `⏱ وقت الوصول : *${eta} دقيقة* | *${eta} min*\n\n` +
    `✅ *1* → قبول | Accepter`
  );
  await sendLocation(driver.phone, clientLat, clientLng, 'موقع العميل | Position client');

  // Sauvegarder en DB
  await DB.pool.query(
    `UPDATE rides SET status='offered', driver_phone=$1, offered_at=NOW() WHERE id=$2`,
    [driver.phone, rideId]
  );
}

// ─── LANCER RECHERCHE ────────────────────────────────────────
async function findDriver(clientPhone, clientLat, clientLng, rideId) {
  const radius    = await DB.getRadius();
  const available = (await DB.findNearestDrivers(clientLat, clientLng, radius))
    .filter(async d => {
      const r = await DB.pool.query(`SELECT id FROM rides WHERE driver_phone=$1 AND status='offered'`, [d.phone]);
      return r.rows.length === 0;
    });

  // Filtrer les chauffeurs déjà en offre active
  const offered = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status='offered'`);
  const busyPhones = new Set(offered.rows.map(r => r.driver_phone));
  const free = (await DB.findNearestDrivers(clientLat, clientLng, radius))
    .filter(d => !busyPhones.has(d.phone));

  if (free.length === 0) {
    await DB.queue.add(clientPhone, clientLat, clientLng);
    const pos = await DB.queue.getPosition(clientPhone);
    await sendText(clientPhone,
      `⏳ جميع السائقين مشغولون | Tous les chauffeurs sont occupés.\n\n` +
      `أنت رقم *${pos}* في قائمة الانتظار.\n` +
      `Vous êtes *n°${pos}* dans la file.\n\n` +
      `اكتب الرقم *0️⃣* للإلغاء | Tapez *0️⃣* pour annuler.`
    );
    return false;
  }

  await offerRide(free[0], rideId, clientPhone, clientLat, clientLng);
  return true;
}

// ─── RETRY PROCHAIN CHAUFFEUR ────────────────────────────────
async function retryNextDriver(rideId, clientPhone, clientLat, clientLng, skipPhone) {
  const radius = await DB.getRadius();
  const offered = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status='offered'`);
  const busyPhones = new Set([skipPhone, ...offered.rows.map(r => r.driver_phone)]);
  const drivers = (await DB.findNearestDrivers(clientLat, clientLng, radius))
    .filter(d => !busyPhones.has(d.phone));

  if (drivers.length > 0) {
    await offerRide(drivers[0], rideId, clientPhone, clientLat, clientLng);
  } else {
    await DB.queue.add(clientPhone, clientLat, clientLng);
    const pos = await DB.queue.getPosition(clientPhone);
    await sendText(clientPhone,
      `⏳ *نبحث عن سيارة أخرى...*\n*Nous cherchons un autre taxi...*\n\n` +
      `أنت رقم *${pos}* | n°${pos}\n\n` +
      `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
    );
  }
}

// ─── ACCEPTER (lecture DB) ───────────────────────────────────
async function acceptRide(driverPhone) {
  const r = await DB.pool.query(
    `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY created_at DESC LIMIT 1`,
    [driverPhone]
  );
  const offer = r.rows[0];
  if (!offer) {
    await sendText(driverPhone, `⚠️ لا توجد رحلة في الانتظار | Aucune course en attente.`);
    return false;
  }

  const driver = await DB.drivers.get(driverPhone);
  const dist   = DB.distance(driver.lat, driver.lng, offer.client_lat, offer.client_lng);
  const eta    = DB.estimateMinutes(dist);
  const clim   = driver.clim ? '❄️ Climatisée' : '🌡 Sans clim';

  await DB.rides.assign(driverPhone, offer.id);
  await DB.drivers.setStatus('busy', driverPhone);
  await DB.queue.remove(offer.client_phone);
  await DB.clientSelections.delete(offer.client_phone);

  // Notifier le client
  const cap = `🚕 *تم قبول طلبك ! | Chauffeur trouvé !*\n\n👤 *${driver.name}*\n📞 wa.me/${driverPhone}\n${clim}\n⏱ ~${eta} min`;
  if (driver.photo_ext) {
    try { await sendImage(offer.client_phone, driver.photo_ext, cap); }
    catch(e) { await sendText(offer.client_phone, cap); }
  } else { await sendText(offer.client_phone, cap); }

  // Notifier le chauffeur
  await sendText(driverPhone,
    `✅ *قبلت الرحلة ! | Course acceptée !*\n\n📞 wa.me/${offer.client_phone}\n\n` +
    `اضغط *1* عند الانتهاء | Tapez *1* pour terminer.`
  );
  await sendLocation(driverPhone, offer.client_lat, offer.client_lng, 'موقع العميل');
  return true;
}

// ─── REFUSER (lecture DB) ────────────────────────────────────
async function refuseRide(driverPhone) {
  const r = await DB.pool.query(
    `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY created_at DESC LIMIT 1`,
    [driverPhone]
  );
  const offer = r.rows[0];
  if (!offer) return false;

  await DB.pool.query(`UPDATE rides SET driver_phone=NULL, status='searching' WHERE id=$1`, [offer.id]);
  await sendText(driverPhone, `👌 رفضت الرحلة | Course refusée.`);
  await retryNextDriver(offer.id, offer.client_phone, offer.client_lat, offer.client_lng, driverPhone);
  return true;
}

// ─── PROCESS QUEUE ───────────────────────────────────────────
async function processQueue(driver) {
  if (!driver || driver.status !== 'online') return;
  const { handleClient } = require('./handlers/client');
  const radius = await DB.getRadius();

  // 1. Table queue
  const queueList = await DB.queue.getAll();
  for (const first of queueList) {
    try {
      const dist = DB.distance(driver.lat, driver.lng, first.client_lat, first.client_lng);
      if (dist > radius) continue;
      await DB.queue.remove(first.client_phone);
      await sendText(first.client_phone, `🎉 *سائق متاح الآن ! | Un chauffeur est disponible !*`);
      const fakeMsg = { type:'location', from: first.client_phone+'@s.whatsapp.net',
        location: { latitude: first.client_lat, longitude: first.client_lng, name: null } };
      await handleClient(fakeMsg, first.client_phone);
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {}
  }

  // 2. Rides searching
  const stuck = await DB.pool.query(`
    SELECT DISTINCT ON (client_phone) * FROM rides
    WHERE status='searching' AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY client_phone, created_at ASC
  `);
  for (const ride of stuck.rows) {
    try {
      const dist = DB.distance(driver.lat, driver.lng, ride.client_lat, ride.client_lng);
      if (dist > radius) continue;

      const sel = await DB.clientSelections.get(ride.client_phone);
      const eta = DB.estimateMinutes(dist);
      const newDriver = { ...driver, distKm: dist.toFixed(1), dist };

      // Annuler toutes les searching de ce client avant de relancer
      if (!sel) {
        await DB.pool.query(
          `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching'`,
          [ride.client_phone]
        );
      }

      if (sel && !sel.drivers.find(d => d.phone === driver.phone)) {
        sel.drivers.push(newDriver);
        await DB.clientSelections.set(ride.client_phone, sel.rideId, sel.drivers, sel.lat, sel.lng);
        const i = sel.drivers.length;
        const caption =
          `🆕 *سائق جديد ! | Nouveau chauffeur !*\n*${i}️⃣ ${driver.name}*\n` +
          `📍 ${dist.toFixed(1)} كم · ⏱️ ${eta} min\n${driver.clim ? '❄️' : '🌡'}\n📞 wa.me/${driver.phone}\n\n👉 اكتب *${i}*`;
        if (driver.photo_ext) {
          try { await sendImage(ride.client_phone, driver.photo_ext, caption); }
          catch(e) { await sendText(ride.client_phone, caption); }
        } else { await sendText(ride.client_phone, caption); }
      } else if (!sel) {
        await DB.pool.query(
          `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching'`,
          [ride.client_phone]
        );
        await sendText(ride.client_phone, `🎉 *سائق متاح الآن !*`);
        const fakeMsg = { type:'location', from: ride.client_phone+'@s.whatsapp.net',
          location: { latitude: ride.client_lat, longitude: ride.client_lng, name: ride.zone } };
        await handleClient(fakeMsg, ride.client_phone);
      }
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {}
  }
}

module.exports = { getState, setState, clearState, findDriver, offerRide, acceptRide, refuseRide, retryNextDriver, processQueue };
