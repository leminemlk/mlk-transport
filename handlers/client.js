const { sendText, sendImage } = require('../whapi');
const DB = require('../db');

const BASE = 'https://mlk-transport-production.up.railway.app';

async function handleClient(msg, phone, pushName=null) {
  await DB.clients.upsert(phone, pushName);
  const locateToken = await DB.getOrCreateClientToken(phone);
  const LOCATE = `${BASE}/locate.html?t=${locateToken}`;

  const msgType     = msg.type;
  const hasLocation = msgType === 'location';
  const text        = (msgType === 'text' ? (msg.text?.body||'') : '').trim();
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

  // ── Client choisit un chauffeur → AUTO-ASSIGNATION ────────
  const sel = await DB.clientSelections.get(phone);
  if (sel && /^[1-9]$/.test(text)) {
    const idx = parseInt(text)-1;
    if (idx >= sel.drivers.length) {
      await sendText(phone, `⚠️ اختر بين 1 و${sel.drivers.length}.`);
      return;
    }
    const chosen = sel.drivers[idx];

    // Marquer ce chauffeur comme "essayé" pour cette session
    const tried = sel.tried_phones ? JSON.parse(sel.tried_phones) : [];
    tried.push(chosen.phone);

    // AUTO-ASSIGNATION immédiate
    await DB.pool.query(
      `UPDATE rides SET status='assigned', driver_phone=$1, assigned_at=NOW() WHERE id=$2`,
      [chosen.phone, sel.ride_id]
    );
    await DB.drivers.setStatus('busy', chosen.phone);
    await DB.queue.remove(phone);

    // Garder sélection en DB avec liste des essayés
    await DB.clientSelections.set(phone, sel.ride_id, sel.drivers, sel.lat, sel.lng);
    await DB.pool.query(
      `UPDATE client_selections SET tried_phones=$1 WHERE client_phone=$2`,
      [JSON.stringify(tried), phone]
    );

    // Envoyer contact chauffeur au client
    const eta = DB.estimateMinutes(parseFloat(chosen.distKm));
    const cap = `✅ *${chosen.name}*\n📍 ${chosen.distKm} km · ⏱️ ${eta} min\n${chosen.clim?'❄️':'🌡'}\n📞 *wa.me/${chosen.phone}*\n\n_اتصل مباشرة | Appelez directement_\n\nاكتب *0* للإلغاء`;
    if (chosen.photo_ext) {
      try { await sendImage(phone, chosen.photo_ext, cap); } catch(e) { await sendText(phone, cap); }
    } else { await sendText(phone, cap); }

    // Notifier le chauffeur automatiquement
    await sendText(chosen.phone,
      `🚖 *تم تعيين رحلة لك ! | Course assignée !*\n\n` +
      `📞 *العميل ينتظرك :*\nwa.me/${phone}\n` +
      `📍 ${chosen.distKm} km · ⏱️ ${eta} min\n\n` +
      `_الرحلة ستُؤكَّد تلقائياً عند لقائكم_\n` +
      `_La course sera confirmée automatiquement_\n\n` +
      `*1* → Terminer la course quand c'est fini`
    );

    console.log(`[CLIENT] ${phone} → assigné à ${chosen.name} (${chosen.distKm}km)`);
    return;
  }

  // ── Client envoie un autre message avec course en cours → nouvelle liste ──
  if (sel) {
    // Re-envoyer la liste sans les chauffeurs déjà essayés
    const tried = sel.tried_phones ? JSON.parse(sel.tried_phones) : [];
    if (tried.length > 0 && sel.drivers.length > tried.length) {
      const remaining = sel.drivers.filter(d => !tried.includes(d.phone));
      if (remaining.length > 0) {
        await sendText(phone,
          `🔄 *اختر سائقاً آخر | Choisissez un autre chauffeur :*`
        );
        for (let i=0; i<remaining.length; i++) {
          const d = remaining[i];
          const eta = DB.estimateMinutes(parseFloat(d.distKm));
          const caption = `*${i+1}️⃣ ${d.name}*\n📍 ${d.distKm} km · ⏱️ ${eta} min\n${d.clim?'❄️':'🌡'}\n📞 wa.me/${d.phone}\n\n👉 اكتب *${i+1}*`;
          if (d.photo_ext) {
            try { await sendImage(phone, d.photo_ext, caption); } catch(e) { await sendText(phone, caption); }
          } else { await sendText(phone, caption); }
          await new Promise(r => setTimeout(r, 600));
        }
        return;
      }
    }
    await sendText(phone, `⏳ طلبك قيد المعالجة.\nاكتب *0* للإلغاء`);
    return;
  }

  // ── Sticker / media ───────────────────────────────────────
  if (isMedia) {
    const inProg = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (inProg.rows.length > 0) {
      await sendText(phone, `⏳ طلبك قيد المعالجة.\nاكتب *0* للإلغاء`);
      return;
    }
    await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
    return;
  }

  // ── Position GPS → liste des chauffeurs ──────────────────
  if (hasLocation) {
    const lat  = msg.location.latitude;
    const lng  = msg.location.longitude;
    const zone = msg.location.name || null;

    // Annuler searching bloquées >5min
    await DB.pool.query(
      `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching' AND created_at < NOW() - INTERVAL '5 minutes'`, [phone]
    );
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (existing.rows.length > 0) {
      await sendText(phone, `⏳ طلبك قيد المعالجة.\nاكتب *0* للإلغاء`);
      return;
    }

    const rideId  = await DB.rides.create(phone, lat, lng, zone);
    const radius  = await DB.getRadius();
    const offered = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status IN ('offered','assigned','busy')`);
    const busy    = new Set(offered.rows.map(r => r.driver_phone).filter(Boolean));
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

    await DB.clientSelections.set(phone, rideId, nearby, lat, lng);

    await sendText(phone,
      `🚕 *${nearby.length} سائق متاح | ${nearby.length} chauffeur(s)*\n_اختر رقم السائق | Choisissez le numéro :_`
    );
    for (let i=0; i<nearby.length; i++) {
      const d = nearby[i];
      const eta = DB.estimateMinutes(parseFloat(d.distKm));
      const caption = `*${i+1}️⃣ ${d.name}*\n📍 ${d.distKm} km · ⏱️ ${eta} min\n${d.clim?'❄️ Climatisée':'🌡 Sans clim'}\n📞 wa.me/${d.phone}\n\n👉 اكتب *${i+1}*`;
      if (d.photo_ext) {
        try { await sendImage(phone, d.photo_ext, caption); } catch(e) { await sendText(phone, caption); }
      } else { await sendText(phone, caption); }
      await new Promise(r => setTimeout(r, 600));
    }
    return;
  }

  // Tout autre message
  await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
}

module.exports = { handleClient };
