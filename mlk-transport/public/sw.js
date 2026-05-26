// ============================================================
// SERVICE WORKER - MLK Transport Chauffeur
// GPS en arrière-plan même écran éteint
// ============================================================

const CACHE_NAME = 'mlk-transport-v1';
const CACHE_FILES = ['/chauffeur.html', '/manifest.json'];

// ─── INSTALLATION ────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// ─── GPS EN ARRIÈRE-PLAN (Background Sync) ───────────────────
let gpsTimer = null;
let driverPhone = null;
let isTracking = false;

// Recevoir les messages de la page
self.addEventListener('message', (e) => {
  const { type, phone, interval } = e.data;

  if (type === 'START_GPS') {
    driverPhone = phone;
    isTracking = true;
    startBackgroundGPS(interval || 30000);
    e.source.postMessage({ type: 'GPS_STARTED' });
  }

  if (type === 'STOP_GPS') {
    isTracking = false;
    stopBackgroundGPS();
    e.source.postMessage({ type: 'GPS_STOPPED' });
  }
});

function startBackgroundGPS(interval) {
  stopBackgroundGPS();
  sendGPS(); // envoi immédiat
  gpsTimer = setInterval(sendGPS, interval);
}

function stopBackgroundGPS() {
  if (gpsTimer) { clearInterval(gpsTimer); gpsTimer = null; }
}

async function sendGPS() {
  if (!isTracking || !driverPhone) return;

  try {
    // Utiliser Background Geolocation via fetch
    const pos = await getPosition();
    if (!pos) return;

    await fetch('/api/driver/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: driverPhone,
        lat: pos.latitude,
        lng: pos.longitude
      })
    });

    // Notifier la page si elle est ouverte
    const allClients = await clients.matchAll({ type: 'window' });
    allClients.forEach(client => {
      client.postMessage({
        type: 'GPS_UPDATE',
        lat: pos.latitude,
        lng: pos.longitude,
        time: new Date().toLocaleTimeString('fr-FR')
      });
    });
  } catch (err) {
    console.log('[SW] Erreur GPS:', err);
  }
}

// Obtenir la position GPS
function getPosition() {
  return new Promise((resolve) => {
    if (!self.navigator?.geolocation) {
      resolve(null);
      return;
    }
    self.navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  });
}

// ─── BACKGROUND SYNC (si réseau perdu puis retrouvé) ─────────
self.addEventListener('sync', (e) => {
  if (e.tag === 'gps-sync') {
    e.waitUntil(sendGPS());
  }
});

// ─── FETCH (cache) ────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  // Ne pas intercepter les appels API
  if (e.request.url.includes('/api/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
