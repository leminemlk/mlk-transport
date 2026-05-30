// ============================================================
// TRIP ENGINE — MK TAXI
// Détection automatique de course par scoring GPS
// Score = Proximité(40) + Temps(30) + Mouvement(30) = 100
// Course confirmée si score ≥ 80 pendant ≥ 60 secondes
// ============================================================
const DB = require('./db');
const { sendText } = require('./whapi');

const SCORE_THRESHOLD = 80;  // Score minimum pour confirmer
const CONFIRM_AFTER   = 60;  // Secondes ensemble avant confirmation
const SEPARATION_DIST = 100; // Mètres → détection fin de course

// ─── HELPERS GPS ─────────────────────────────────────────────
function calcBearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
          - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function calcSpeed(pos1, pos2) {
  if (!pos1 || !pos2) return null;
  const distKm  = DB.distance(pos1.lat, pos1.lng, pos2.lat, pos2.lng);
  const dt      = (new Date(pos2.recorded_at) - new Date(pos1.recorded_at)) / 3600000; // heures
  return dt > 0 ? distKm / dt : 0; // km/h
}

// ─── SAUVEGARDER SNAPSHOT GPS ────────────────────────────────
async function saveSnapshot(phone, role, lat, lng) {
  try {
    // Calculer vitesse et direction depuis position précédente
    const prev = await DB.pool.query(
      `SELECT lat, lng, recorded_at FROM gps_snapshots
       WHERE phone=$1 AND role=$2
       ORDER BY recorded_at DESC LIMIT 1`, [phone, role]
    );
    let speed = null, bearing = null;
    if (prev.rows[0]) {
      const p = prev.rows[0];
      speed   = calcSpeed({ lat: p.lat, lng: p.lng, recorded_at: p.recorded_at },
                           { lat, lng, recorded_at: new Date() });
      bearing = calcBearing(p.lat, p.lng, lat, lng);
    }
    await DB.pool.query(
      `INSERT INTO gps_snapshots (phone, role, lat, lng, speed, bearing, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [phone, role, lat, lng, speed, bearing]
    );
    // Garder seulement les 10 derniers snapshots par chauffeur/client
    await DB.pool.query(
      `DELETE FROM gps_snapshots WHERE phone=$1 AND role=$2
       AND id NOT IN (
         SELECT id FROM gps_snapshots WHERE phone=$1 AND role=$2
         ORDER BY recorded_at DESC LIMIT 10
       )`, [phone, role]
    );
  } catch(e) { console.error('[GPS SNAPSHOT]', e.message); }
}

// ─── CALCULER LE SCORE DE CONFIANCE ──────────────────────────
async function calculateScore(ride) {
  let score = 0;
  const details = { prox: 0, time: 0, move: 0, distM: null };

  try {
    // Positions actuelles
    const driver = await DB.drivers.get(ride.driver_phone);
    if (!driver?.lat || !driver?.lng || !ride.client_lat || !ride.client_lng) return { score: 0, details };

    const distM = DB.distance(driver.lat, driver.lng, ride.client_lat, ride.client_lng) * 1000;
    details.distM = Math.round(distM);

    // A. PROXIMITÉ (0-40 pts)
    if      (distM < 30)  details.prox = 40;
    else if (distM < 50)  details.prox = 35;
    else if (distM < 80)  details.prox = 20;
    else if (distM < 150) details.prox = 10;
    score += details.prox;

    // B. TEMPS ENSEMBLE (0-30 pts)
    // Compter combien de secondes la distance est restée < 80m
    const proxHistory = await DB.pool.query(
      `SELECT COUNT(*) AS cnt FROM gps_snapshots gs
       JOIN drivers d ON d.phone=$1
       WHERE gs.phone=$2 AND gs.role='client'
       AND gs.recorded_at > NOW() - INTERVAL '3 minutes'`,
      [ride.driver_phone, ride.client_phone]
    );
    const secsClose = await DB.pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(recorded_at))) AS secs
       FROM gps_snapshots
       WHERE phone=$1 AND role='driver'
       AND recorded_at > COALESCE(
         (SELECT MAX(recorded_at) FROM gps_snapshots
          WHERE phone=$1 AND role='driver'
          AND bearing IS NULL),
         NOW() - INTERVAL '5 minutes'
       )`, [ride.driver_phone]
    );
    const proximityScore = ride.near_since
      ? Math.floor((Date.now() - new Date(ride.near_since)) / 1000)
      : 0;
    if      (proximityScore >= 120) details.time = 30;
    else if (proximityScore >=  90) details.time = 25;
    else if (proximityScore >=  60) details.time = 20;
    else if (proximityScore >=  30) details.time = 10;
    score += details.time;

    // C. MOUVEMENT COMMUN (0-30 pts)
    const driverPrev = await DB.pool.query(
      `SELECT lat, lng, bearing, speed, recorded_at FROM gps_snapshots
       WHERE phone=$1 AND role='driver' ORDER BY recorded_at DESC LIMIT 2`,
      [ride.driver_phone]
    );
    const clientPrev = await DB.pool.query(
      `SELECT lat, lng, bearing, speed, recorded_at FROM gps_snapshots
       WHERE phone=$1 AND role='client' ORDER BY recorded_at DESC LIMIT 2`,
      [ride.client_phone]
    );

    if (driverPrev.rows.length >= 2 && clientPrev.rows.length >= 1) {
      const dBearing = driverPrev.rows[0].bearing;
      const cBearing = clientPrev.rows[0]?.bearing;
      const dSpeed   = driverPrev.rows[0].speed;
      const cSpeed   = clientPrev.rows[0]?.speed;

      // Même direction (diff < 45°)
      if (dBearing !== null && cBearing !== null) {
        const bearDiff = Math.abs(((dBearing - cBearing) + 360) % 360);
        const normalBearDiff = bearDiff > 180 ? 360 - bearDiff : bearDiff;
        if      (normalBearDiff < 20) details.move += 15;
        else if (normalBearDiff < 45) details.move += 10;
        else if (normalBearDiff < 90) details.move += 5;
      }

      // Même vitesse (diff < 10 km/h)
      if (dSpeed !== null && cSpeed !== null) {
        const speedDiff = Math.abs(dSpeed - cSpeed);
        if      (speedDiff < 3)  details.move += 15;
        else if (speedDiff < 8)  details.move += 10;
        else if (speedDiff < 15) details.move += 5;
      }
    }
    score += details.move;

    return { score: Math.min(100, score), details };

  } catch(e) {
    console.error('[SCORE]', e.message);
    return { score: 0, details };
  }
}

// ─── VÉRIFICATION PRINCIPALE (appelée à chaque GPS update) ──
async function checkRide(driverPhone, lat, lng) {
  try {
    // 1. Course assigned à ce chauffeur
    let r = await DB.pool.query(
      `SELECT * FROM rides WHERE driver_phone=$1 AND status IN ('assigned','in_progress')
       ORDER BY created_at DESC LIMIT 1`, [driverPhone]
    );

    // 2. Si pas de course assignée → chercher client searching dans le rayon
    if (!r.rows[0]) {
      const radius = await DB.getRadius();
      const searching = await DB.pool.query(
        `SELECT * FROM rides WHERE status='searching' AND client_lat IS NOT NULL
         AND created_at > NOW() - INTERVAL '2 hours'
         ORDER BY created_at ASC LIMIT 5`
      );
      for (const ride of searching.rows) {
        const d = DB.distance(lat, lng, ride.client_lat, ride.client_lng);
        if (d * 1000 <= 100) {
          // Chauffeur à moins de 100m d'un client searching → auto-assigner
          await DB.pool.query(
            `UPDATE rides SET status='assigned', driver_phone=$1, assigned_at=NOW() WHERE id=$2`,
            [driverPhone, ride.id]
          );
          await DB.drivers.setStatus('busy', driverPhone);
          await DB.queue.remove(ride.client_phone);
          const driver = await DB.drivers.get(driverPhone);
          const clim = driver.clim ? '❄️' : '🌡';
          const cap = `🚕 *تم تأكيد الرحلة ! | Course confirmée !*

👤 *${driver.name}*
📞 wa.me/${driverPhone}
${clim}
📍 ${Math.round(d*1000)}m`;
          if (driver.photo_ext) {
            try { await (require('./whapi')).sendImage(ride.client_phone, driver.photo_ext, cap); }
            catch(e) { await sendText(ride.client_phone, cap); }
          } else { await sendText(ride.client_phone, cap); }
          await sendText(driverPhone,
            `✅ *تم تعيين رحلة تلقائياً !*
📞 wa.me/${ride.client_phone}
📍 ${Math.round(d*1000)}m

*1* → Terminer`
          ).catch(()=>{});
          console.log(`[TRIP ENGINE] Auto-assign ride ${ride.id} → driver ${driverPhone} (${Math.round(d*1000)}m)`);
          r = await DB.pool.query(`SELECT * FROM rides WHERE id=$1`, [ride.id]);
          break;
        }
      }
      if (!r.rows[0]) return;
    }

    if (!r.rows[0]) return;
    const ride = r.rows[0];

    // Sauvegarder snapshot driver
    await saveSnapshot(driverPhone, 'driver', lat, lng);

    // Calculer score
    const { score, details } = await calculateScore(ride);

    // Sauvegarder score en DB (ignorer erreur si colonne manquante)
    try {
      await DB.pool.query(`UPDATE rides SET confidence_score=$1 WHERE id=$2`, [score, ride.id]);
    } catch(e) {}
    try {
      if (details.distM !== null && details.distM < 80) {
        await DB.pool.query(`UPDATE rides SET near_since=COALESCE(near_since, NOW()) WHERE id=$1`, [ride.id]);
      } else if (details.distM !== null && details.distM >= 150) {
        await DB.pool.query(`UPDATE rides SET near_since=NULL WHERE id=$1`, [ride.id]);
      }
    } catch(e) {}

    console.log(`[TRIP ENGINE] Ride ${ride.id} | Score: ${score}/100 | Dist: ${details.distM}m | Prox:${details.prox} Time:${details.time} Move:${details.move}`);

    // ── CONFIRMER LA COURSE (score ≥ 80) ─────────────────────
    if (score >= SCORE_THRESHOLD && ride.status !== 'in_progress') {
      const nearSecs = ride.near_since
        ? (Date.now() - new Date(ride.near_since)) / 1000 : 0;
      if (nearSecs >= CONFIRM_AFTER) {
        await confirmRide(ride, score, details);
      }
    }

    // ── DÉTECTER FIN DE COURSE (séparation après IN_PROGRESS) ─
    if (ride.status === 'in_progress' && details.distM !== null && details.distM > SEPARATION_DIST) {
      // Vérifier que la séparation dure depuis > 30s (éviter faux positifs)
      let sep = null;
      try {
        const separatedSince = await DB.pool.query(`SELECT separated_since FROM rides WHERE id=$1`, [ride.id]);
        sep = separatedSince.rows[0]?.separated_since;
      } catch(e) {}
      if (sep && (Date.now() - new Date(sep)) > 30000) {
        await endRide(ride, 'auto');
      } else if (!sep) {
        try { await DB.pool.query(`UPDATE rides SET separated_since=NOW() WHERE id=$1`, [ride.id]); } catch(e) {}
      }
    } else if (ride.status === 'in_progress') {
      // Toujours ensemble → reset separated_since
      try { await DB.pool.query(`UPDATE rides SET separated_since=NULL WHERE id=$1`, [ride.id]); } catch(e) {}
    }

  } catch(e) { console.error('[TRIP ENGINE CHECK]', e.message); }
}

// ─── CONFIRMER LA COURSE ─────────────────────────────────────
async function confirmRide(ride, score, details) {
  try {
    await DB.pool.query(
      `UPDATE rides SET status='in_progress', assigned_at=NOW(), confidence_score=$1 WHERE id=$2`,
      [score, ride.id]
    );
    await DB.drivers.setStatus('busy', ride.driver_phone);
    await DB.queue.remove(ride.client_phone);

    const driver = await DB.drivers.get(ride.driver_phone);

    console.log(`[TRIP ENGINE] ✅ Course ${ride.id} confirmée! Score: ${score}/100`);

    // Notifier client
    await sendText(ride.client_phone,
      `🚕 *تم تأكيد الرحلة ! | Course confirmée !*\n\n` +
      `👤 *${driver.name}*\n` +
      `📍 ${details.distM}m · ✅ Score: ${score}/100\n\n` +
      `_الرحلة في التقدم | Course en cours..._`
    ).catch(()=>{});

    // Notifier chauffeur
    await sendText(ride.driver_phone,
      `✅ *تم تأكيد الرحلة تلقائياً ! | Course auto-confirmée !*\n\n` +
      `📞 wa.me/${ride.client_phone}\n` +
      `📍 ${details.distM}m ensemble\n\n` +
      `_اضغط 1 عند إنهاء الرحلة | Tapez 1 pour terminer_`
    ).catch(()=>{});

  } catch(e) { console.error('[CONFIRM RIDE]', e.message); }
}

// ─── FIN DE COURSE AUTOMATIQUE ───────────────────────────────
async function endRide(ride, reason='auto') {
  try {
    const driver = await DB.drivers.get(ride.driver_phone);
    const dur = ride.assigned_at
      ? Math.floor((Date.now() - new Date(ride.assigned_at)) / 60000) : null;

    // Calculer distance totale approximative
    const distData = await DB.pool.query(
      `SELECT SUM(
         6371 * 2 * ASIN(SQRT(
           POWER(SIN((LAT - LAG(LAT) OVER (ORDER BY recorded_at)) * PI()/360), 2) +
           COS(LAT * PI()/180) * COS(LAG(LAT) OVER (ORDER BY recorded_at) * PI()/180) *
           POWER(SIN((LNG - LAG(LNG) OVER (ORDER BY recorded_at)) * PI()/360), 2)
         ))
       ) AS total_km FROM gps_snapshots
       WHERE phone=$1 AND role='driver'
       AND recorded_at > $2`,
      [ride.driver_phone, ride.assigned_at || ride.created_at]
    );
    const distKm = parseFloat(distData.rows[0]?.total_km || 0).toFixed(1);

    // Compléter la course
    await DB.pool.query(
      `UPDATE rides SET status='completed', completed_at=NOW() WHERE id=$1`, [ride.id]
    );
    await DB.pool.query(
      `INSERT INTO ride_history (ride_id, client_phone, driver_phone, driver_name, zone, status, created_at, completed_at, duration_min, distance_km)
       VALUES ($1,$2,$3,$4,$5,'completed',$6,NOW(),$7,$8)`,
      [ride.id, ride.client_phone, ride.driver_phone, driver?.name, ride.zone, ride.created_at, dur, distKm]
    ).catch(()=>{});

    await DB.drivers.setStatus('online', ride.driver_phone);

    // Résumé au chauffeur
    await sendText(ride.driver_phone,
      `✅ *انتهت الرحلة ! | Course terminée !*\n\n` +
      `⏱ *${dur || '?'} دقيقة* | *${dur || '?'} min*\n` +
      `📍 *${distKm} كم* | *${distKm} km*\n\n` +
      `🟢 متاح للرحلة القادمة | Disponible.`
    ).catch(()=>{});

    // Message au client
    await sendText(ride.client_phone,
      `✅ *شكراً على استخدام MK TAXI !*\n` +
      `_Merci d'avoir utilisé MK TAXI !_\n\n` +
      `⏱ ${dur || '?'} min · 📍 ${distKm} km`
    ).catch(()=>{});

    // Notifier les clients en attente
    const { processQueue } = require('./queue');
    await processQueue(await DB.drivers.get(ride.driver_phone)).catch(()=>{});

    console.log(`[TRIP ENGINE] 🏁 Course ${ride.id} terminée. ${dur}min · ${distKm}km`);
  } catch(e) { console.error('[END RIDE]', e.message); }
}

module.exports = { checkRide, saveSnapshot, calculateScore };
