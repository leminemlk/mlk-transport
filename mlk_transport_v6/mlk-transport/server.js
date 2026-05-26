// ============================================================
// MLK TRANSPORT - Serveur Principal
// ============================================================
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const DB = require('./db');
const { sendText } = require('./whapi');
const { handleClient } = require('./handlers/client');
const { handleDriver } = require('./handlers/driver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── WEBHOOK WHAPI.CLOUD ─────────────────────────────────────

app.post('/webhook', async (req, res) => {
  // Répondre immédiatement à Whapi
  res.sendStatus(200);

  const messages = req.body?.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue; // ignorer les messages envoyés par le bot

    try {
      const phone = msg.from.replace('@s.whatsapp.net', '');
      const text = (msg.text?.body || '').trim().toLowerCase();

      // ── Inscription chauffeur ─────────────────────────────
      if (text === 'chauffeur' || text === 'inscription') {
        // Vérifier si pas déjà chauffeur
        const existing = DB.drivers.get.get(phone);
        if (existing) {
          await sendText(phone, `✅ Vous êtes déjà enregistré comme chauffeur, ${existing.name} !`);
          continue;
        }
        // Démarrer l'inscription
        const { setState } = require('./queue');
        setState(phone, 'registering_name');
        await sendText(phone,
          `🚖 *Inscription Chauffeur MLK Transport*\n\n` +
          `Bienvenue ! Pour vous inscrire, répondez à cette question :\n\n` +
          `👤 Quel est votre *prénom et nom* ?`
        );
        continue;
      }

      // ── Finaliser inscription chauffeur ───────────────────
      const { getState, clearState } = require('./queue');
      const { state } = getState(phone);

      if (state === 'registering_name' && msg.text?.body) {
        const name = msg.text.body.trim();
        DB.drivers.insert.run(phone, name);
        clearState(phone);
        await sendText(phone,
          `✅ *Inscription réussie !*\n\n` +
          `🎉 Bienvenue *${name}* !\n\n` +
          `🎁 Vous bénéficiez de *3 mois gratuits*.\n` +
          `Ensuite : 500 MRU/semaine.\n\n` +
          `Pour commencer à recevoir des courses :\n` +
          `📍 Envoyez votre *position GPS* maintenant !`
        );
        continue;
      }

      // ── Router vers client ou chauffeur ───────────────────
      const driver = DB.drivers.get.get(phone);
      if (driver) {
        await handleDriver(msg, driver);
      } else {
        await handleClient(msg, phone);
      }

    } catch (err) {
      console.error('[WEBHOOK] Erreur traitement message:', err.message);
    }
  }
});

// ─── API ADMIN ───────────────────────────────────────────────

// Tous les chauffeurs
app.get('/api/drivers', (req, res) => {
  const drivers = DB.drivers.getAll.all().map(d => ({
    ...d,
    hasTrial: d.trial_until && new Date(d.trial_until) > new Date(),
    hasSub: d.subscription_end && new Date(d.subscription_end) > new Date(),
  }));
  res.json(drivers);
});

// Activer/bloquer un chauffeur
app.post('/api/drivers/:phone/block', (req, res) => {
  DB.drivers.block.run(req.params.phone);
  sendText(req.params.phone, '⛔ Votre accès MLK Transport a été suspendu. Contactez l\'administration.');
  res.json({ ok: true });
});

app.post('/api/drivers/:phone/unblock', (req, res) => {
  DB.drivers.unblock.run(req.params.phone);
  sendText(req.params.phone, '✅ Votre accès MLK Transport a été réactivé. Bonne route !');
  res.json({ ok: true });
});

// Valider un paiement d'abonnement
app.post('/api/drivers/:phone/pay', (req, res) => {
  const phone = req.params.phone;
  DB.drivers.renewSubscription.run(phone);
  const weekLabel = DB.getWeekLabel();
  DB.payments.create.run(phone, weekLabel);
  // Notifier le chauffeur
  sendText(phone,
    `✅ *Paiement reçu !*\n\n` +
    `💰 500 MRU — Abonnement semaine ${weekLabel}\n` +
    `Votre accès est renouvelé pour 7 jours. Merci ! 🙏`
  );
  res.json({ ok: true });
});


// ─── API PAGE CHAUFFEUR (GPS temps réel) ─────────────────────

app.post('/api/driver/location', (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || !lat || !lng) return res.status(400).json({ error: 'Données manquantes' });
  DB.drivers.setOnlineWithLocation.run(lat, lng, phone);
  res.json({ ok: true });
});

app.get('/api/driver/:phone/status', (req, res) => {
  const driver = DB.drivers.get.get(req.params.phone);
  if (!driver) return res.status(404).json({ error: 'Chauffeur introuvable' });
  const { pendingOffers } = require('./queue');
  const offer = pendingOffers.get(req.params.phone);
  const todayRides = DB.db.prepare(
    "SELECT COUNT(*) as n FROM rides WHERE driver_phone = ? AND DATE(created_at) = DATE('now')"
  ).get(req.params.phone);
  res.json({
    driver,
    todayRides: todayRides?.n || 0,
    pendingOffer: offer ? {
      rideId: offer.rideId,
      dist: DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng).toFixed(1),
      eta: DB.estimateMinutes(DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng))
    } : null
  });
});

app.post('/api/driver/:phone/offline', (req, res) => {
  DB.drivers.setStatus.run('offline', req.params.phone);
  res.json({ ok: true });
});

app.post('/api/driver/respond', async (req, res) => {
  const { phone, response } = req.body;
  const { acceptRide, refuseRide } = require('./queue');
  if (response === 'accept') await acceptRide(phone);
  else await refuseRide(phone);
  res.json({ ok: true });
});

// Courses actives
app.get('/api/rides', (req, res) => {
  res.json(DB.rides.getActive.all());
});

// File d'attente
app.get('/api/queue', (req, res) => {
  res.json(DB.queue.getAll.all());
});

// Stats
app.get('/api/stats', (req, res) => {
  const rides = DB.rides.getStats.get();
  const driversAll = DB.drivers.getAll.all();
  const online = DB.drivers.getOnline.all();
  res.json({
    rides,
    drivers: {
      total: driversAll.length,
      online: online.length,
      active: driversAll.filter(d => d.active).length
    }
  });
});

// Envoyer un message à tous les chauffeurs (broadcast)
app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  const drivers = DB.drivers.getAll.all().filter(d => d.active);
  for (const d of drivers) {
    await sendText(d.phone, `📢 *MLK Transport :*\n\n${message}`);
  }
  res.json({ sent: drivers.length });
});

// ─── TÂCHES AUTOMATIQUES (CRON) ──────────────────────────────

// Chaque dimanche à 9h : alertes abonnements expirants
cron.schedule('0 9 * * 0', async () => {
  const expiring = DB.drivers.getExpiring.all();
  for (const d of expiring) {
    await sendText(d.phone,
      `⚠️ *Rappel abonnement MLK Transport*\n\n` +
      `Votre abonnement expire bientôt !\n` +
      `💰 Tarif : *500 MRU/semaine*\n\n` +
      `Payez dès maintenant pour continuer à recevoir des courses.`
    );
  }
  console.log(`[CRON] Alertes abonnement envoyées à ${expiring.length} chauffeurs`);
});

// Chaque heure : nettoyer les chauffeurs inactifs depuis >2h
cron.schedule('0 * * * *', () => {
  const { db } = DB;
  db.prepare(`
    UPDATE drivers SET status = 'offline'
    WHERE status = 'online'
    AND last_seen < datetime('now', '-2 hours')
  `).run();
});

// ─── DÉMARRAGE ───────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚖 MLK Transport démarré sur le port ${PORT}`);
  console.log(`📊 Dashboard : http://localhost:${PORT}`);
  console.log(`🔗 Webhook   : http://localhost:${PORT}/webhook\n`);
});
