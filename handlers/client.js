const { sendText, sendImage } = require('../whapi');
const DB = require('../db');

const BASE = 'https://mlk-transport-production.up.railway.app';

async function handleClient(msg, phone, pushName = null) {
  await DB.clients.upsert(phone, pushName);
  const locateToken = await DB.getOrCreateClientToken(phone);
  const LOCATE = `${BASE}/locate.html?t=${locateToken}`;

  const msgType     = msg.type;
  const hasLocation = msgType === 'location';
  const text        = (msgType === 'text' ? (msg.text?.body || '') : '').trim();
  const isMedia     = ['sticker','image','audio','video','document','reaction'].includes(msgType);

  // ── 0 : annuler ──────────────────────────────────────────
  if (text === '0') {
    await DB.pool.query(
      `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status IN ('searching','offered','assigned')`,
      [phone]
    );
    await DB.clientSelections.delete(phone).catch(() => {});
    await DB.queue.remove(phone);
    await sendText(phone, `❌ تم الإلغاء | Annulé.\n\n📍 ${LOCATE}`);
    return;
  }

  // ── Course active → infos ─────────────────────────────────
  const activePending = await DB.pool.query(
    `SELECT * FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (activePending.rows.length > 0 && !hasLocation) {
    const ride = activePending.rows[0];
    if (ride.status === 'assigned') {
      const drv = await DB.drivers.get(ride.driver_phone);
      await sendText(phone,
        `🚕 *السائق في طريقه | Chauffeur en route*\n👤 ${drv?.name || ''}\n📞 wa.me/${ride.driver_phone}\n\nاكتب *0* للإلغاء`
      );
    } else {
      await sendText(phone, `⏳ *جاري البحث | Recherche en cours...*\n\nاكتب *0* للإلغاء | Tapez *0* pour annuler.`);
    }
    return;
  }

  // ── Sticker / media → lien ────────────────────────────────
  if (isMedia || (!hasLocation && !text)) {
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (!existing.rows.length) await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
    return;
  }

  // ── Tout autre texte sans course → lien ───────────────────
  if (!hasLocation) {
    const existing = await DB.pool.query(
      `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
    );
    if (!existing.rows.length) await sendText(phone, `🚕 *MK TAXI*\n\n📍 ${LOCATE}`);
    return;
  }

  // ── Position GPS → lancer la recherche ───────────────────
  const lat  = msg.location.latitude;
  const lng  = msg.location.longitude;
  const zone = msg.location.name || null;

  await DB.pool.query(
    `UPDATE rides SET status='cancelled' WHERE client_phone=$1 AND status='searching' AND created_at < NOW() - INTERVAL '5 minutes'`,
    [phone]
  );
  const existing = await DB.pool.query(
    `SELECT id FROM rides WHERE client_phone=$1 AND status IN ('searching','offered','assigned') LIMIT 1`, [phone]
  );
  if (existing.rows.length) {
    await sendText(phone, `⏳ طلبك قيد المعالجة.\nاكتب *0* للإلغاء`);
    return;
  }

  const rideId = await DB.rides.create(phone, lat, lng, zone);
  await sendText(phone,
    `🚕 *نبحث عن أقرب سائق | Recherche du chauffeur le plus proche...*\n\nاكتب *0* للإلغاء | Tapez *0* pour annuler.`
  );

  // Notifier les chauffeurs disponibles (compétition : premier à taper 1)
  const { notifyDrivers } = require('../queue');
  await notifyDrivers(rideId, phone, lat, lng);
}

// Appelé quand chauffeur accepte → envoyer info complète au client
async function sendDriverInfoToClient(clientPhone, driverPhone, rideId) {
  const driver = await DB.drivers.get(driverPhone);
  if (!driver) return;
  const ride = await DB.pool.query(`SELECT client_lat, client_lng FROM rides WHERE id=$1`, [rideId]);
  const r = ride.rows[0];
  const distKm = r ? DB.distance(driver.lat || 0, driver.lng || 0, r.client_lat, r.client_lng).toFixed(1) : '?';
  const eta    = DB.estimateMinutes(parseFloat(distKm));
  const clim   = driver.clim ? '❄️ Climatisée' : '🌡 Sans clim';
  const cap    = `✅ *تم قبول طلبك ! | Chauffeur trouvé !*\n\n👤 *${driver.name}*\n${clim}\n📍 ${distKm} km · ⏱ ${eta} min\n📞 wa.me/${driverPhone}\n\nاكتب *0* للإلغاء`;

  if (driver.photo_ext) {
    try { await sendImage(clientPhone, driver.photo_ext, cap); }
    catch(e) { await sendText(clientPhone, cap); }
  } else { await sendText(clientPhone, cap); }
}

module.exports = { handleClient, sendDriverInfoToClient };
