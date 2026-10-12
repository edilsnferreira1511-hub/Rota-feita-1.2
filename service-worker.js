/* ============================================================
   BALANCÍMETRO · service-worker.js
   Cache-first para os arquivos do app, garantindo uso 100% offline.
   Todos os dados financeiros ficam em LocalStorage no dispositivo,
   este worker só cuida dos arquivos estáticos do app.
============================================================ */

// Trocar este número sempre que o app for atualizado, para que os
// aparelhos baixem os arquivos novos em vez de usar o cache antigo.
const CACHE_NAME = 'balancimetro-cache-v12';

// Arquivos essenciais: se algum faltar, a instalação do cache falha.
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

// Imagens: entram no cache quando existirem, sem travar a instalação.
const OPTIONAL_FILES = [
  './icon-192.png',
  './icon-512.png',
  './splash-map.webp'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(APP_SHELL).then(() =>
          Promise.all(OPTIONAL_FILES.map((url) => cache.add(url).catch(() => {})))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Apenas trata requisições GET; ignora outros métodos.
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Atualiza o cache em segundo plano (stale-while-revalidate leve).
        fetch(event.request)
          .then((fresh) => {
            if (fresh && fresh.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, fresh.clone()));
            }
          })
          .catch(() => { /* offline: mantém o cache existente */ });
        return cached;
      }

      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Sem rede e sem cache: cai de volta para a tela inicial,
          // caso seja uma navegação de página.
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        });
    })
  );
});
