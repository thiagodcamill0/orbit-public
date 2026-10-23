// Orbit — service worker do app instalado (PWA). Servido em /sw.js para valer em todo o site.
// Faz três coisas:
//  1) Navegação (abrir ou recarregar a página): vai à rede. Se o servidor local não responder,
//     entrega a tela "Orbit offline" guardada no cache, em vez do erro do navegador.
//  2) Os arquivos dessa tela (ela mesma, a fonte e os ícones): rede primeiro, cache se falhar.
// Todo o resto (/fluxo, /estado, os POSTs e os assets da página) passa direto, sem cache.
// 3) Só o Orbit no celular (/m): a casca (a página /m, /m/*.js|css, o manifest e, pedidos por uma janela do /m, /assets/comum/*) vai à rede primeiro e
//    fica guardada num cache à parte; sem rede (ou servidor com erro 5xx), sai do cache. Nunca API, estado ou conversa.
// Mais embaixo, só para o Orbit no celular (/m): os handlers de Web Push (`push` e `notificationclick`).

const CACHE = 'orbit-offline-v1';
const OFFLINE = '/offline.html';
const CACHE_M = 'orbit-casca-m-v1';
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
    for (const k of await caches.keys()) if (k !== CACHE && k !== CACHE_M) await caches.delete(k);
    // A página vai à rede em paralelo com o arranque do service worker.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

const offline = async () =>
  (await caches.match(OFFLINE)) ||
  new Response('Orbit offline: o servidor local não está respondendo.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// Casca do celular: só arquivos estáticos do app (nada de /remoto, /estado, /fluxo, /sessao...).
const RE_CASCA_M = /^\/(?:m\/?|m\/[\w-]+\.(?:js|css)|manifest-m\.webmanifest|assets\/comum\/[\w-]+\.(?:js|css))$/;
const chaveM = (p) => (p === '/m/' ? '/m' : p);
// Só vale para o Orbit do celular: o próprio /m e o manifest, ou um pedido feito por uma janela do /m. Os /assets/comum/* que
// o PC (a mesma origem, o mesmo SW) pede continuam passando direto, sem cache. (O referrer não serve: a porta remota manda no-referrer.)
async function doCelular(ev, url) {
  if (url.pathname === '/m' || url.pathname.startsWith('/m/') || url.pathname === '/manifest-m.webmanifest') return true;
  try {
    const c = ev.clientId ? await self.clients.get(ev.clientId) : null;
    return !!c && /^\/m\/?$/.test(new URL(c.url).pathname);
  } catch { return false; }
}
async function casca(ev, url) {
  const req = ev.request;
  const chave = chaveM(url.pathname);
  let r = null;
  try { r = (req.mode === 'navigate' && (await ev.preloadResponse)) || (await fetch(req)); } catch { r = null; }
  if (r && r.status < 500) {
    if (r.status === 200 && (r.type === 'basic' || r.type === 'default')) {
      const c = r.clone();
      ev.waitUntil(caches.open(CACHE_M).then((k) => k.put(chave, c)).catch(() => {}));
    }
    return r;
  }
  const guardada = await caches.match(chave, { cacheName: CACHE_M });
  if (guardada) return guardada;
  if (req.mode === 'navigate') return offline();
  return r || Response.error();
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (RE_CASCA_M.test(url.pathname) && !url.search) { ev.respondWith((async () => ((await doCelular(ev, url)) ? casca(ev, url) : fetch(req)))()); return; }
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
