const { sendText, sendLocation, sendImage } = require('./whapi');
const DB = require('./db');

const states = new Map();
function getState(phone)             { return states.get(phone) || { state:'idle', data:{} }; }
function setState(phone, state, data){ states.set(phone, { state, data:data||{} }); }
function clearState(phone)           { states.delete(phone); }

async function offerRide(driver, rideId, clientPhone, clientLat, clientLng) {
  const dist = DB.distance(driver.lat, driver.lng, clientLat, clientLng);
  const eta  = DB.estimateMinutes(dist);
  await sendText(driver.phone,
    `🚖 *طلب رحلة ! | Nouvelle course !*\n\n` +
    `📍 *${dist.toFixed(1)} كم* | *${dist.toFixed(1)} km*\n` +
    `⏱ *${eta} دقيقة* | *${eta} min*\n\n` +
    `✅ *1* → قبول | Accepter`
  );
  await sendLocation(driver.phone, clientLat, clientLng, 'موقع العميل');
  await DB.pool.query(
    `UPDATE rides SET status='offered', driver_phone=$1, offered_at=NOW() WHERE id=$2`,
    [driver.phone, rideId]
  );
}

async function findDriver(clientPhone, clientLat, clientLng, rideId) {
  const radius  = await DB.getRadius();
  const offered = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status='offered'`);
  const busy    = new Set(offered.rows.map(r => r.driver_phone));
  const nearby  = (await DB.findNearestDrivers(clientLat, clientLng, radius))
    .filter(d => !busy.has(d.phone));

  if (!nearby.length) {
    await DB.queue.add(clientPhone, clientLat, clientLng);
    const pos = await DB.queue.getPosition(clientPhone);
    await sendText(clientPhone,
      `⏳ *جميع السائقين مشغولون | Tous les chauffeurs sont occupés*\n` +
      `أنت رقم *${pos}* | n°${pos}\n\n` +
      `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
    );
    return false;
  }
  await offerRide(nearby[0], rideId, clientPhone, clientLat, clientLng);
  return true;
}

async function retryNextDriver(rideId, clientPhone, clientLat, clientLng, skipPhone) {
  const radius  = await DB.getRadius();
  const offered = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status='offered'`);
  const busy    = new Set([skipPhone, ...offered.rows.map(r => r.driver_phone)]);
  const next    = (await DB.findNearestDrivers(clientLat, clientLng, radius))
    .filter(d => !busy.has(d.phone));

  if (next.length) {
    await offerRide(next[0], rideId, clientPhone, clientLat, clientLng);
  } else {
    await DB.queue.add(clientPhone, clientLat, clientLng);
    await sendText(clientPhone,
      `⏳ *نبحث عن سيارة أخرى | Nous cherchons...*\n\nاكتب *0* للإلغاء`
    );
  }
}

async function acceptRide(driverPhone) {
  const r = await DB.pool.query(
    `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY created_at DESC LIMIT 1`,
    [driverPhone]
  );
  if (!r.rows[0]) {
    await sendText(driverPhone, `⚠️ لا توجد رحلة في الانتظار | Aucune course en attente.`);
    return false;
  }
  const offer  = r.rows[0];
  const driver = await DB.drivers.get(driverPhone);
  const dist   = DB.distance(driver.lat, driver.lng, offer.client_lat, offer.client_lng);
  const eta    = DB.estimateMinutes(dist);
  const clim   = driver.clim ? '❄️ Climatisée' : '🌡 Sans clim';

  await DB.rides.assign(driverPhone, offer.id);
  await DB.drivers.setStatus('busy', driverPhone);
  await DB.queue.remove(offer.client_phone);
  await DB.clientSelections.delete(offer.client_phone);

  const cap = `🚕 *تم قبول طلبك !*\n\n👤 *${driver.name}*\n📞 wa.me/${driverPhone}\n${clim}\n⏱ ~${eta} min`;
  if (driver.photo_ext) {
    try { await sendImage(offer.client_phone, driver.photo_ext, cap); }
    catch(e) { await sendText(offer.client_phone, cap); }
  } else { await sendText(offer.client_phone, cap); }

  await sendText(driverPhone,
    `✅ *Course acceptée !*\n\n📞 wa.me/${offer.client_phone}\n\nاضغط *1* عند الانتهاء | Tapez *1* pour terminer.`
  );
  await sendLocation(driverPhone, offer.client_lat, offer.client_lng, 'موقع العميل');
  return true;
}

async function refuseRide(driverPhone) {
  const r = await DB.pool.query(
    `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY created_at DESC LIMIT 1`,
    [driverPhone]
  );
  if (!r.rows[0]) return false;
  const offer = r.rows[0];
  await DB.pool.query(`UPDATE rides SET driver_phone=NULL, status='searching' WHERE id=$1`, [offer.id]);
  await sendText(driverPhone, `👌 Course refusée.`);
  await retryNextDriver(offer.id, offer.client_phone, offer.client_lat, offer.client_lng, driverPhone);
  return true;
}

async function processQueue(driver) {
  if (!driver || driver.status !== 'online') return;
  const { handleClient } = require('./handlers/client');
  const radius = await DB.getRadius();

  const queueList = await DB.queue.getAll();
  for (const q of queueList) {
    try {
      if (DB.distance(driver.lat, driver.lng, q.client_lat, q.client_lng) > radius) continue;
      await DB.queue.remove(q.client_phone);
      await sendText(q.client_phone, `🎉 *سائق متاح ! | Chauffeur disponible !*`);
      const fake = { type:'location', from:q.client_phone+'@s.whatsapp.net',
        location:{ latitude:q.client_lat, longitude:q.client_lng, name:null } };
      await handleClient(fake, q.client_phone);
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {}
  }

  const stuck = await DB.pool.query(`
    SELECT DISTINCT ON (client_phone) * FROM rides
    WHERE status='searching' AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY client_phone, created_at ASC
  `);
  for (const ride of stuck.rows) {
    try {
      if (DB.distance(driver.lat, driver.lng, ride.client_lat, ride.client_lng) > radius) continue;
      const sel = await DB.clientSelections.get(ride.client_phone);
      const dist = DB.distance(driver.lat, driver.lng, ride.client_lat, ride.client_lng);
      const eta  = DB.estimateMinutes(dist);

      if (sel && !sel.drivers.find(d => d.phone === driver.phone)) {
        sel.drivers.push({ ...driver, distKm: dist.toFixed(1) });
        await DB.clientSelections.set(ride.client_phone, sel.ride_id, sel.drivers, sel.lat, sel.lng);
        const i = sel.drivers.length;
        const caption = `🆕 *${i}️⃣ ${driver.name}*\n📍 ${dist.toFixed(1)} km · ⏱️ ${eta} min\n${driver.clim?'❄️':'🌡'}\n📞 wa.me/${driver.phone}\n\n👉 اكتب *${i}*`;
        if (driver.photo_ext) {
          try { await sendImage(ride.client_phone, driver.photo_ext, caption); }
          catch(e) { await sendText(ride.client_phone, caption); }
        } else { await sendText(ride.client_phone, caption); }
      } else if (!sel) {
        await DB.pool.query(`UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching'`, [ride.client_phone]);
        await sendText(ride.client_phone, `🎉 *سائق متاح ! | Chauffeur disponible !*`);
        const fake = { type:'location', from:ride.client_phone+'@s.whatsapp.net',
          location:{ latitude:ride.client_lat, longitude:ride.client_lng, name:ride.zone } };
        await handleClient(fake, ride.client_phone);
      }
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {}
  }
}


// ─── CHERCHER PROCHAIN CHAUFFEUR ─────────────────────────────
async function tryNextDriver(clientPhone, rideId, refusedPhone = null) {
  try {
    const ride = await DB.pool.query(`SELECT * FROM rides WHERE id=$1`, [rideId]);
    if (!ride.rows[0]) return;
    const r = ride.rows[0];

    // Construire liste des chauffeurs déjà essayés
    const sel = await DB.clientSelections.get(clientPhone);
    const tried = new Set(sel?.tried_phones ? JSON.parse(sel.tried_phones) : []);
    if (refusedPhone) tried.add(refusedPhone);

    const radius  = await DB.getRadius();
    const busyQ   = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status='assigned' AND driver_phone IS NOT NULL`);
    const busy    = new Set(busyQ.rows.map(r => r.driver_phone));

    const nearby = (await DB.findNearestDrivers(r.client_lat, r.client_lng, radius))
      .filter(d => !busy.has(d.phone) && !tried.has(d.phone))
      .slice(0,3)
      .map(d => ({ ...d, distKm: d.dist.toFixed(1) }));

    if (nearby.length > 0) {
      // Envoyer nouvelle liste au client
      await sendText(clientPhone,
        `🔄 *بحث عن سائق جديد | Nouveau chauffeur trouvé :*
` +
        `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
      );
      for (let i=0; i<nearby.length; i++) {
        const d = nearby[i];
        const eta = DB.estimateMinutes(parseFloat(d.distKm));
        const cap = `*${i+1}. ${d.name}*
📍 ${d.distKm} km · ⏱️ ${eta} min
${d.clim?'❄️':'🌡'}
📞 *wa.me/${d.phone}*`;
        if (d.photo_ext) {
          try { await sendImage(clientPhone, d.photo_ext, cap); } catch(e) { await sendText(clientPhone, cap); }
        } else { await sendText(clientPhone, cap); }
        await new Promise(r => setTimeout(r, 500));
      }

      // MAJ tried_phones
      nearby.forEach(d => tried.add(d.phone));
      if (sel) {
        await DB.pool.query(
          `UPDATE client_selections SET tried_phones=$1, drivers_json=$2 WHERE client_phone=$3`,
          [JSON.stringify([...tried]),
           JSON.stringify([...(sel.drivers||[]), ...nearby]),
           clientPhone]
        );
      } else {
        await DB.clientSelections.set(clientPhone, rideId, nearby, r.client_lat, r.client_lng);
        await DB.pool.query(
          `UPDATE client_selections SET tried_phones=$1 WHERE client_phone=$2`,
          [JSON.stringify([...tried]), clientPhone]
        );
      }

      // Notifier les nouveaux chauffeurs
      for (const d of nearby) {
        await sendText(d.phone,
          `🔔 *عميل قريب | Client proche*
📍 ${d.distKm} km
_Si le client vous contacte, confirmez avec *1*_`
        ).catch(()=>{});
        await new Promise(r => setTimeout(r, 300));
      }
    } else {
      // Aucun chauffeur dispo → message d'attente
      const mins = Math.floor((Date.now() - new Date(r.created_at))/60000);
      await sendText(clientPhone,
        `⏳ *نأسف للانتظار (${mins} min) | Désolé pour l'attente*
` +
        `_لا يوجد سائق آخر متاح الآن | Aucun autre chauffeur disponible_

` +
        `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
      ).catch(()=>{});
    }
  } catch(e) { console.error('[TRY NEXT DRIVER]', e.message); }
}

module.exports = { getState, setState, clearState, offerRide, findDriver, retryNextDriver, acceptRide, refuseRide, processQueue, tryNextDriver };
