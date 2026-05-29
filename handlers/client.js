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

  // 0 = annuler
  if (text === '0') {
    await DB.clientSelections.delete(phone);
    await DB.queue.remove(phone);
    await DB.pool.query(`UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status IN ('searching','offered')`, [phone]);
    await sendText(phone, `❌ تم الإلغاء | Annulé.`);
    return;
  }

  // Choix chauffeur par numéro
  const sel = await DB.clientSelections.get(phone);
  if (sel && /^[1-9]$/.test(text)) {
    const idx = parseInt(text)-1;
    if (idx >= sel.drivers.length) {
      await sendText(phone, `⚠️ اختر بين 1 و${sel.drivers.length}.`);
      return;
    }
    const chosen = sel.drivers[idx];
    await DB.clientSelections.delete(phone);
    await DB.pool.query(`UPDATE rides SET status='offered', driver_phone=$1, offered_at=NOW() WHERE id=$2`, [chosen.phone, sel.rideId]);
    await DB.drivers.setStatus('pending', chosen.phone);

    const eta = DB.estimateMinutes(parseFloat(chosen.distKm));
    const cap = `✅ *${chosen.name}*\n📍 ${chosen.distKm} km · ⏱️ ${eta} min\n${chosen.clim?'❄️':'🌡'}\n📞 wa.me/${chosen.phone}`;
    if (chosen.photo_ext) {
      try { await sendImage(phone, chosen.photo_ext, cap); } catch(e) { await sendText(phone, cap); }
    } else { await sendText(phone, cap); }

    if (chosen.photo_ext) { try { await sendImage(chosen.phone, chosen.photo_ext, '🚖 MK TAXI'); } catch(e){} }
    await sendText(chosen.phone,
      `🚖 *طلب رحلة !*\n📞 العميل : wa.me/${phone}\n📍 ${chosen.distKm} km · ⏱️ ${eta} min\n\n✅ *1* → قبول`
    );
    return;
  }

  // Sélection en attente
  if (sel) {
    await sendText(phone, `👆 اكتب رقم السائق (1-${sel.drivers.length})\nاكتب *0* للإلغاء`);
    return;
  }

  // Sticker/media → lien
  if (isMedia) {
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (existing.rows.length > 0) {
      await sendText(phone, `⏳ طلبك قيد المعالجة.\nاكتب *0* للإلغاء`);
      return;
    }
    await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
    return;
  }

  // Position GPS
  if (hasLocation) {
    const lat  = msg.location.latitude;
    const lng  = msg.location.longitude;
    const zone = msg.location.name || null;

    // Annuler les searching bloquées >5min
    await DB.pool.query(
      `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching' AND created_at < NOW() - INTERVAL '5 minutes'`,
      [phone]
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
    const offered = await DB.pool.query(`SELECT driver_phone FROM rides WHERE status='offered'`);
    const busy    = new Set(offered.rows.map(r => r.driver_phone));
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

    for (let i=0; i<nearby.length; i++) {
      const d   = nearby[i];
      const eta = DB.estimateMinutes(parseFloat(d.distKm));
      const cap = `*${i+1}️⃣ ${d.name}*\n📍 ${d.distKm} km · ⏱️ ${eta} min\n${d.clim?'❄️ Climatisée':'🌡 Sans clim'}\n📞 wa.me/${d.phone}\n\n👉 اكتب *${i+1}*`;
      if (d.photo_ext) {
        try { await sendImage(phone, d.photo_ext, cap); } catch(e) { await sendText(phone, cap); }
      } else { await sendText(phone, cap); }
      await new Promise(r => setTimeout(r, 600));
    }
    return;
  }

  // Tout autre message
  await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
}

module.exports = { handleClient };
