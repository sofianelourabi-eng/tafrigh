// Service worker : garde l'application et son moteur sur l'appareil pour fonctionner hors ligne
const VERSION = 'tafrigh-v2';
const RUNTIME = 'tafrigh-runtime';
const SHELL = [
  './', './index.html', './app.js', './worker.js', './recorder.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable.png'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('tafrigh-v') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// En-têtes qui débloquent le calcul multi-cœur (transcription plus rapide)
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      // Page : réseau d'abord (mises à jour), sinon version gardée
      e.respondWith(
        fetch(req)
          .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return isolate(res); })
          .catch(() => caches.match('./index.html').then(isolate))
      );
    } else {
      e.respondWith(
        caches.match(req, { ignoreSearch: true }).then(hit => {
          const net = fetch(req).then(res => {
            if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
            return res;
          });
          return (hit ? Promise.resolve(hit) : net).then(isolate);
        })
      );
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    // Moteur et polices : gardés après le premier téléchargement
    e.respondWith(
      caches.open(RUNTIME).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })))
    );
  }
  // Les modèles Whisper sont gardés par le moteur lui-même (cache « transformers-cache »)
});
