const { sendText, sendImage } = require('./whapi');
const DB = require('./db');

// Indicatifs anonymes pour le chauffeur (avant acceptation)
const INDICATORS = ['🧍A','🧍B','🧍C','🧍D','🧍E','🧍F','🧍G','🧍H'];
function getIndicator(phone) {
  const n = parseInt(phone.slice(-1));
  return INDICATORS[n % INDICATORS.length];
}

// Notifier tous les chauffeurs disponibles dans la zone
async function notifyDrivers(rideId, clientPhone, lat, lng) {
  try {
    const radius  = await DB.getRadius();
    const offered = await DB.pool.query(
      `SELECT driver_phone FROM rides WHERE status IN ('offered','assigned') AND driver_phone IS NOT NULL`
    );
    const busy = new Set(offered.rows.map(r => r.driver_phone).filter(Boolean));

    const nearby = (await DB.findNearestDrivers(lat, lng, radius))
      .filter(d => !busy.has(d.phone))
      .slice(0, 8);

    if (!nearby.length) {
      await DB.queue.add(clientPhone, lat, lng);
      await sendText(clientPhone,
        `⏳ *لا يوجد سائق متاح الآن | Aucun chauffeur disponible*\n_سنُخطرك فور توفر سائق | Vous serez notifié dès qu'un chauffeur est disponible_\n\nاكتب *0* للإلغاء`
      );
      return;
    }

    const indicator = getIndicator(clientPhone);

    // Sauvegarder la liste ordonnée dans client_selections
    await DB.clientSelections.set(clientPhone, rideId,
      nearby.map(d => ({ ...d, distKm: d.dist.toFixed(1) })), lat, lng
    );

    // Notifier TOUS les chauffeurs disponibles
    for (const d of nearby) {
      const eta = DB.estimateMinutes(d.dist);
      await sendText(d.phone,
        `🔔 *عميل يبحث عن سائق ! | Client recherche un taxi !*\n\n` +
        `${indicator} · 📍 *${d.dist.toFixed(1)} km* · ⏱ ${eta} min\n\n` +
        `✅ اضغط *1* للقبول والتفاوض مع العميل\n` +
        `❌ اضغط *2* للرفض\n\n` +
        `_ستصل معلومات العميل بعد الموافقة_\n` +
        `_Le contact client vous sera envoyé après acceptation_`
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[QUEUE] Ride ${rideId} notifié à ${nearby.length} chauffeurs`);
  } catch(e) { console.error('[NOTIFY DRIVERS]', e.message); }
}

// Premier chauffeur qui répond "1" → reçoit contact client
async function driverAccept(driverPhone) {
  try {
    const driver = await DB.drivers.get(driverPhone);
    if (!driver) return null;

    // Chercher une course offered ou searching où ce chauffeur est dans la liste
    const fromSel = await DB.pool.query(
      `SELECT cs.client_phone, r.id AS ride_id, r.status
       FROM client_selections cs
       JOIN rides r ON r.client_phone = cs.client_phone
       WHERE r.status = 'searching'
       AND cs.drivers_json::text LIKE $1
       ORDER BY r.created_at DESC LIMIT 1`,
      [`%${driverPhone}%`]
    );

    if (!fromSel.rows[0]) {
      // Chercher par GPS si pas dans selections
      if (!driver.lat || !driver.lng) return null;
      const byGps = await DB.pool.query(
        `SELECT id AS ride_id, client_phone FROM rides
         WHERE status='searching' AND client_lat IS NOT NULL
         AND created_at > NOW() - INTERVAL '3 hours'
         ORDER BY (POW(client_lat-$1,2)+POW(client_lng-$2,2)) ASC LIMIT 1`,
        [driver.lat, driver.lng]
      );
      if (!byGps.rows[0]) return null;
      fromSel.rows[0] = byGps.rows[0];
    }

    const { client_phone, ride_id } = fromSel.rows[0];

    // Atomique : marquer offered uniquement si encore searching
    const updated = await DB.pool.query(
      `UPDATE rides SET status='offered', driver_phone=$1, offered_at=NOW()
       WHERE id=$2 AND status='searching' RETURNING id`,
      [driverPhone, ride_id]
    );
    if (!updated.rows.length) {
      await sendText(driverPhone, `⚠️ هذه الرحلة محجوزة | Course déjà prise par un autre chauffeur.`);
      return null;
    }

    // Envoyer infos complètes client immédiatement
    const { sendDriverInfoToClient } = require('./handlers/client');
    // Client reçoit infos chauffeur
    await sendDriverInfoToClient(client_phone, driverPhone, ride_id);
    // Chauffeur reçoit contact client pour négocier
    await sendText(driverPhone,
      `✅ *تم القبول ! | Accepté !*\n\n` +
      `📞 *العميل :* wa.me/${client_phone}\n\n` +
      `_تفاوض على السعر_\n_Négociez le prix avec le client_\n\n` +
      `*2* → 🤝 تأكيد | Confirmer (accord)\n` +
      `*0* → ❌ رفض | Rejeter (désaccord)`
    );

    return { clientPhone: client_phone, rideId: ride_id };
  } catch(e) { console.error('[DRIVER ACCEPT]', e.message); return null; }
}

// Chauffeur confirme après négociation → client reçoit les infos
async function driverConfirm(driverPhone) {
  try {
    const ride = await DB.pool.query(
      `SELECT * FROM rides WHERE driver_phone=$1 AND status='offered' ORDER BY offered_at DESC LIMIT 1`,
      [driverPhone]
    );
    if (!ride.rows[0]) return false;
    const r = ride.rows[0];

    await DB.pool.query(
      `UPDATE rides SET status='assigned', assigned_at=NOW() WHERE id=$1`, [r.id]
    );
    await DB.drivers.setStatus('busy', driverPhone);
    await DB.queue.remove(r.client_phone);
    await DB.clientSelections.delete(r.client_phone).catch(() => {});

    const { sendDriverInfoToClient } = require('./handlers/client');
    await sendDriverInfoToClient(r.client_phone, driverPhone, r.id);

    await sendText(driverPhone,
      `🚕 *الرحلة مؤكدة ! | Course confirmée !*\n📞 wa.me/${r.client_phone}\n\n` +
      `🏁 *0* → انتهاء الرحلة | Terminer`
    );

    // Libérer les autres chauffeurs notifiés
    await cancelOtherOffers(r.client_phone, driverPhone);
    return true;
  } catch(e) { console.error('[DRIVER CONFIRM]', e.message); return false; }
}

// Chauffeur refuse → prochain chauffeur
async function driverReject(driverPhone) {
  try {
    const ride = await DB.pool.query(
      `SELECT * FROM rides WHERE driver_phone=$1 AND status IN ('offered','assigned') ORDER BY created_at DESC LIMIT 1`,
      [driverPhone]
    );
    if (!ride.rows[0]) return;
    const r = ride.rows[0];

    // Remettre en searching
    await DB.pool.query(
      `UPDATE rides SET status='searching', driver_phone=NULL WHERE id=$1`, [r.id]
    );
    await DB.drivers.setStatus('online', driverPhone);

    await sendText(driverPhone, `👌 تم الرفض | Refusé. 🟢 Vous êtes disponible.`);

    // Trouver prochain chauffeur (pas encore essayé)
    const sel = await DB.clientSelections.get(r.client_phone);
    const tried = sel?.tried_phones ? JSON.parse(sel.tried_phones) : [];
    tried.push(driverPhone);

    await DB.pool.query(
      `UPDATE client_selections SET tried_phones=$1 WHERE client_phone=$2`,
      [JSON.stringify(tried), r.client_phone]
    ).catch(() => {});

    // Chercher prochain disponible
    const next = (await DB.findNearestDrivers(r.client_lat, r.client_lng, await DB.getRadius()))
      .filter(d => !tried.includes(d.phone))
      .slice(0, 1);

    if (next.length) {
      const d = next[0];
      const indicator = getIndicator(r.client_phone);
      await sendText(d.phone,
        `🔔 *عميل يبحث عن سائق ! | Client recherche un taxi !*\n\n` +
        `${indicator} · 📍 *${d.dist.toFixed(1)} km* · ⏱ ${DB.estimateMinutes(d.dist)} min\n\n` +
        `✅ *1* → قبول | Accepter\n❌ *2* → رفض | Refuser`
      );
    } else {
      // Pas d'autre chauffeur
      const mins = Math.floor((Date.now() - new Date(r.created_at)) / 60000);
      await sendText(r.client_phone,
        `⏳ *نأسف للانتظار (${mins} min) | Désolé pour l'attente*\n_نبحث عن سائق آخر..._\n\nاكتب *0* للإلغاء`
      ).catch(() => {});
      await DB.queue.add(r.client_phone, r.client_lat, r.client_lng);
    }
  } catch(e) { console.error('[DRIVER REJECT]', e.message); }
}

// Annuler offres aux autres chauffeurs (course prise)
async function cancelOtherOffers(clientPhone, acceptedDriver) {
  const sel = await DB.clientSelections.get(clientPhone).catch(() => null);
  if (!sel?.drivers) return;
  for (const d of sel.drivers) {
    if (d.phone !== acceptedDriver) {
      await sendText(d.phone,
        `ℹ️ *تم أخذ الرحلة | Course prise par un autre chauffeur.*`
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

// Fin de course
async function driverFinish(driverPhone) {
  try {
    const ride = await DB.rides.getActiveByDriver(driverPhone);
    if (!ride) return false;
    const dur = ride.assigned_at
      ? Math.floor((Date.now() - new Date(ride.assigned_at)) / 60000) : null;
    await DB.rides.complete(ride.id);
    await DB.drivers.setStatus('online', driverPhone);
    await sendText(ride.client_phone,
      `✅ *شكراً ! | Merci d'avoir utilisé MK TAXI !*\n${dur ? `⏱ ${dur} min` : ''}`
    ).catch(() => {});
    await sendText(driverPhone,
      `🏁 *انتهت الرحلة ! | Course terminée !*\n${dur ? `⏱ ${dur} min · ` : ''}🟢 Disponible.`
    );
    await processQueue(await DB.drivers.get(driverPhone));
    return true;
  } catch(e) { console.error('[FINISH]', e.message); return false; }
}

// Vérifier clients en attente quand chauffeur se connecte
async function processQueue(driver) {
  if (!driver || driver.status !== 'online') return;
  const radius = await DB.getRadius();
  const waiting = await DB.queue.getAll();
  for (const q of waiting) {
    const dist = DB.distance(driver.lat, driver.lng, q.client_lat, q.client_lng);
    if (dist > radius) continue;
    await DB.queue.remove(q.client_phone);
    const indicator = getIndicator(q.client_phone);
    await sendText(driver.phone,
      `🔔 *عميل ينتظر منذ فترة ! | Client en attente !*\n\n` +
      `${indicator} · 📍 *${dist.toFixed(1)} km*\n\n` +
      `✅ *1* → قبول | Accepter\n❌ *2* → رفض | Refuser`
    ).catch(() => {});
    break;
  }
}

module.exports = { notifyDrivers, driverAccept, driverConfirm, driverReject, driverFinish, processQueue };
