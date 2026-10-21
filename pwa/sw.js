// Orbit — service worker do app instalado (PWA). Servido em /sw.js para valer em todo o site.
// Faz só duas coisas:
//  1) Navegação (abrir ou recarregar a página): vai à rede. Se o servidor local não responder,
//     entrega a tela "Orbit offline" guardada no cache, em vez do erro do navegador.
//  2) Os arquivos dessa tela (ela mesma, a fonte e os ícones): rede primeiro, cache se falhar.
// Todo o resto (/fluxo, /estado, os POSTs e os assets da página) passa direto, sem cache.
// Mais embaixo, só para o Orbit no celular (/m): os handlers de Web Push (`push` e `notificationclick`).

const CACHE = 'orbit-offline-v1';
const OFFLINE = '/offline.html';
const ARQUIVOS = [OFFLINE, '/assets/Geist-Variable.woff2', '/assets/pwa/icone-32.png', '/assets/pwa/icone-192.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    // A página vai à rede em paralelo com o arranque do service worker.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

const offline = async () =>
  (await caches.match(OFFLINE)) ||
  new Response('Orbit offline: o servidor local não está respondendo.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        return (await ev.preloadResponse) || (await fetch(req));
      } catch {
        return offline();
      }
    })());
    return;
  }
  if (ARQUIVOS.includes(url.pathname)) {
    ev.respondWith(fetch(req).catch(async () => (await caches.match(url.pathname)) || Response.error()));
  }
});

// Orbit no celular (Web Push): o servidor manda { titulo, corpo, url: '/m#s=<id>', tag: 's-<id>' }.
// Destino de notificação: só /m (com ?/#), sem barra invertida (o navegador lê '/\x' como '//x'); senão, /m.
const urlDoOrbit = (u) => (typeof u === 'string' && /^\/m(?:[/?#]|$)/.test(u) && !u.includes('\\') ? u : '/m');

// Só o PC do usuário manda push; o PC em si nunca assina, então estes dois handlers só agem no celular.
self.addEventListener('push', (ev) => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch { d = {}; }
  const titulo = typeof d.titulo === 'string' && d.titulo ? d.titulo : 'Orbit';
  const tag = typeof d.tag === 'string' && d.tag ? d.tag : undefined;
  const url = urlDoOrbit(d.url);
  const opcoes = {
    body: typeof d.corpo === 'string' ? d.corpo : '',
    icon: '/assets/pwa/icone-192.png',
    badge: '/assets/pwa/icone-96.png',
    data: { url },
  };
  if (tag) { opcoes.tag = tag; opcoes.renotify = true; } // renotify exige tag
  ev.waitUntil(self.registration.showNotification(titulo, opcoes));
});

// Toque na notificação: foca o Orbit do celular que já estiver aberto e manda ele abrir a sessão; sem nenhum aberto, abre uma janela.
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const data = ev.notification.data;
  const url = urlDoOrbit(data && data.url);
  ev.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const m = abertas.find((c) => { try { return /^\/m\/?$/.test(new URL(c.url).pathname); } catch { return false; } });
    if (m) {
      try { await m.focus(); } catch {}
      m.postMessage({ tipo: 'abrir', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
