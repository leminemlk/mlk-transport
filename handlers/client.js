const { sendText, sendImage } = require('../whapi');
const DB = require('../db');

const BASE = 'https://mlk-transport-production.up.railway.app';

async function handleClient(msg, phone, pushName=null) {
  await DB.clients.upsert(phone, pushName);
  const locateToken = await DB.getOrCreateClientToken(phone);
  const LOCATE = `${BASE}/locate.html?t=${locateToken}`;

  const msgType     = msg.type;
  const hasLocation = msgType === 'location';
  const text        = (msgType === 'text' ? (msg.text?.body||'') : '').trim().toLowerCase();
  const isMedia     = ['sticker','image','audio','video','document','reaction'].includes(msgType);

  // ── 0 : annuler ───────────────────────────────────────────
  if (text === '0') {
    await DB.clientSelections.delete(phone);
    await DB.queue.remove(phone);
    await DB.pool.query(
      `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status IN ('searching','offered','assigned')`,
      [phone]
    );
    await sendText(phone, `❌ تم الإلغاء | Annulé.`);
    return;
  }

  // ── Course déjà en cours → rien faire ────────────────────
  // (Trip Engine gère tout automatiquement)
  const activePending = await DB.pool.query(
    `SELECT status FROM rides WHERE client_phone=$1 AND status IN ('searching','assigned') LIMIT 1`, [phone]
  );
  if (activePending.rows.length > 0 && !hasLocation) {
    // Client a renvoyé un message → veut relancer
    if (text && text !== '0') {
      // Annuler et relancer si course non encore confirmée
      const st = activePending.rows[0].status;
      if (st === 'searching') {
        await DB.pool.query(`UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching'`, [phone]);
        await sendText(phone, `🔄 _Relancez en envoyant votre position_\n📍 ${LOCATE}`);
        return;
      }
      // Course assigned → en route, informer
      await sendText(phone, `🚕 _Le chauffeur est en route._ \nاكتب *0* للإلغاء | Tapez *0* pour annuler.`);
      return;
    }
    return;
  }

  // ── Sticker / media → lien ────────────────────────────────
  if (isMedia) {
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','assigned') LIMIT 1`, [phone]
    );
    if (existing.rows.length > 0) return;
    await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
    return;
  }

  // ── Autre texte sans course → lien ────────────────────────
  if (!hasLocation && !isMedia) {
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','assigned') LIMIT 1`, [phone]
    );
    if (existing.rows.length === 0) {
      await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
    }
    return;
  }

  // ── Position GPS → liste chauffeurs (1 seule fois) ────────
  if (hasLocation) {
    const lat  = msg.location.latitude;
    const lng  = msg.location.longitude;
    const zone = msg.location.name || null;

    // Annuler searching bloquées >5min
    await DB.pool.query(
      `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching' AND created_at < NOW() - INTERVAL '5 minutes'`, [phone]
    );

    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','assigned') LIMIT 1`, [phone]
    );
    if (existing.rows.length > 0) return;

    const rideId  = await DB.rides.create(phone, lat, lng, zone);
    const radius  = await DB.getRadius();
    const busyR   = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status IN ('assigned') AND driver_phone IS NOT NULL`);
    const busy    = new Set(busyR.rows.map(r => r.driver_phone).filter(Boolean));
    const nearby  = (await DB.findNearestDrivers(lat, lng, radius))
      .filter(d => !busy.has(d.phone))
      .slice(0,5)
      .map(d => ({ ...d, distKm: d.dist.toFixed(1) }));

    if (!nearby.length) {
      await DB.queue.add(phone, lat, lng);
      const pos = await DB.queue.getPosition(phone);
      await sendText(phone,
        `⏳ *جميع السائقين مشغولون | Tous les chauffeurs sont occupés*\n` +
        `أنت رقم *${pos}* | n°${pos}\n\nاكتب *0* للإلغاء`
      );
      return;
    }

    // Sauvegarder sélection pour Trip Engine
    await DB.clientSelections.set(phone, rideId, nearby, lat, lng);

    // Envoyer liste — CLIENT CLIQUE DIRECTEMENT sur wa.me, pas besoin de taper
    await sendText(phone,
      `🚕 *${nearby.length} سائق متاح | ${nearby.length} chauffeur(s)*\n` +
      `_اتصل مباشرة بالسائق الذي تريد | Appelez directement le chauffeur de votre choix_\n\n` +
      `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
    );

    for (let i=0; i<nearby.length; i++) {
      const d = nearby[i];
      const eta = DB.estimateMinutes(parseFloat(d.distKm));
      const caption =
        `*${i+1}. ${d.name}*\n` +
        `📍 ${d.distKm} km · ⏱️ ${eta} min\n` +
        `${d.clim?'❄️ Climatisée':'🌡 Sans clim'}\n` +
        `📞 *wa.me/${d.phone}*`;

      if (d.photo_ext) {
        try { await sendImage(phone, d.photo_ext, caption); } catch(e) { await sendText(phone, caption); }
      } else { await sendText(phone, caption); }
      await new Promise(r => setTimeout(r, 600));
    }

    // Notifier tous les chauffeurs de la liste qu'un client est proche
    for (const d of nearby) {
      await sendText(d.phone,
        `🔔 *عميل قريب منك | Client proche de vous*\n\n` +
        `📍 ${d.distKm} km · ⏱️ ${DB.estimateMinutes(parseFloat(d.distKm))} min\n\n` +
        `_إذا اتصل بك عميل فالرحلة ستُؤكَّد تلقائياً عند لقائكم_\n` +
        `_Si un client vous appelle, la course se confirmera automatiquement_`
      ).catch(()=>{});
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

module.exports = { handleClient };
