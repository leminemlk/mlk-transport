// ============================================================
// HANDLER CLIENT — MLK Transport v3
// ============================================================
const { sendText, sendVoice, sendImage } = require('../whapi');
const DB = require('../db');

const VOICE_URL  = 'https://mlk-transport-production.up.railway.app/msg_taxi.ogg';
const LOCATE_URL = (phone) => `https://mlk-transport-production.up.railway.app/locate.html?phone=${phone}`;

async function handleClient(msg, phone) {
  await DB.clients.upsert(phone);

  const msgType     = msg.type;
  const hasLocation = msgType === 'location';
  const text        = (msgType === 'text' ? (msg.text?.body || '') : '').trim();
  const isMedia     = ['sticker','image','audio','video','document','reaction'].includes(msgType);
  const isCall      = msgType === 'call';

  // ── 0 : annuler ───────────────────────────────────────────
  if (text === '0') {
    await DB.queue.remove(phone);
    try {
      await DB.pool.query(
        `UPDATE rides SET status='cancelled'
         WHERE client_phone=$1 AND status IN ('searching','offered')`, [phone]
      );
    } catch(e) {}
    await sendText(phone, `❌ تم الإلغاء | Annulé.`);
    return;
  }



  // ── Sticker / bitmoji / appel ──────────────────────────────
  if (isMedia || isCall) {
    const inProgress = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (inProgress.rows.length > 0) {
      await sendText(phone, `⏳ طلبك قيد المعالجة | Course en cours.\nاكتب *0* للإلغاء | Tapez *0* pour annuler.`);
      return;
    }
    await sendVoice(phone, VOICE_URL).catch(()=>{});
    await sendText(phone,
      `🚕 *MK TAXI*\n\n📍 أرسل موقعك لطلب سيارة\nEnvoyez votre position.\n\n👉 ${LOCATE_URL(phone)}`
    );
    return;
  }

  // ── Position GPS → afficher liste des chauffeurs ──────────
  if (hasLocation) {
    const lat  = msg.location.latitude;
    const lng  = msg.location.longitude;
    const zone = msg.location.name || null;

    // Vérifier si course en cours (sauf si réinitialisé après 30min)
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (existing.rows.length > 0) {
      await sendText(phone, `⏳ طلبك قيد المعالجة | Course en cours.\nاكتب *0* للإلغاء | Tapez *0* pour annuler.`);
      return;
    }

    const rideId = await DB.rides.create(phone, lat, lng, zone);

    // Lire le rayon depuis settings
    let radius = 5;
    try {
      const r = await DB.pool.query(`SELECT value FROM settings WHERE key='radius'`);
      radius = parseFloat(r.rows[0]?.value || '5');
    } catch(e) {}

    const { pendingOffers } = require('../queue');
    const nearbyRaw = await DB.findNearestDrivers(lat, lng, radius);
    const nearby = nearbyRaw
      .filter(d => !pendingOffers.has(d.phone))
      .slice(0, 5)
      .map(d => ({ ...d, distKm: d.dist.toFixed(1) }));

    if (nearby.length === 0) {
      await DB.queue.add(phone, lat, lng);
      const pos = await DB.queue.getPosition(phone);
      await sendText(phone,
        `⏳ *جميع السائقين مشغولون | Tous les chauffeurs sont occupés.*\n\n` +
        `أنت رقم *${pos}* في قائمة الانتظار.\n` +
        `Vous êtes *n°${pos}* dans la file.\n\n` +
        `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
      );
      return;
    }

    await sendText(phone,
      `🚕 *${nearby.length} سائق متاح | ${nearby.length} chauffeur(s) disponible(s)*\n` +
      `_اتصل مباشرة بالسائق الذي تريد | Appelez directement le chauffeur de votre choix_`
    );

    for (let i = 0; i < nearby.length; i++) {
      const d = nearby[i];
      const eta = DB.estimateMinutes(parseFloat(d.distKm));
      const caption =
        `*${i+1}. ${d.name}*\n` +
        `📍 ${d.distKm} كم | ${d.distKm} km\n` +
        `⏱️ وقت الوصول : *${eta} دقيقة* | *${eta} min*\n` +
        `${d.clim ? '❄️ Climatisée' : '🌡 Sans clim'}\n` +
        `📞 *wa.me/${d.phone}*`;

      if (d.photo_ext) {
        try { await sendImage(phone, d.photo_ext, caption); }
        catch(e) { await sendText(phone, caption); }
      } else {
        await sendText(phone, caption);
      }
      await new Promise(r => setTimeout(r, 600));
    }

    await sendText(phone,
      `_سيتم تأكيد الرحلة تلقائياً عند لقائكم (50م)\n` +
      `La course sera confirmée automatiquement à votre rencontre (50m)._\n\n` +
      `اكتب *0* للإلغاء | Tapez *0* pour annuler.`
    );
    return;
  }



  await sendText(phone,
    `🚕 *MK TAXI*\n\n📍 أرسل موقعك لطلب سيارة\nEnvoyez votre position.\n\n👉 ${LOCATE_URL(phone)}`
  );
}

module.exports = { handleClient };
