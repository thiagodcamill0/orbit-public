// Orbit — legenda dos grupos por pasta do grafo. Script clássico: globalThis.GrafoLegenda.
//   GrafoLegenda.criar(el, { aoDestacar(chave|null) }) → { atualizar([{chave, rotulo, cor, n}]), destruir() }
// A cor vem como 'var(--grafo-...)' (definida em grafo.css e herdada do hospedeiro). Estilo em grafo-legenda.css.
(function () {
  'use strict';
  const FIM = { bastidores: 1, outras: 2 };

  function criar(host, cb) {
    cb = cb || {};
    let recolhida = false;
    const raiz = document.createElement('div');
    raiz.className = 'gl';
    raiz.hidden = true;
    const topo = document.createElement('button');
    topo.type = 'button'; topo.className = 'gl-topo'; topo.setAttribute('aria-expanded', 'true');
    const seta = document.createElement('span'); seta.className = 'gl-seta'; seta.setAttribute('aria-hidden', 'true');
    const tit = document.createElement('span'); tit.textContent = 'Grupos';
    topo.append(seta, tit);
    const lista = document.createElement('ul');
    lista.className = 'gl-lista'; lista.setAttribute('aria-label', 'Legenda dos grupos');
    raiz.append(topo, lista);
    const destacar = (c) => { if (cb.aoDestacar) cb.aoDestacar(c); };
    topo.addEventListener('click', () => {
      recolhida = !recolhida;
      raiz.classList.toggle('gl-recolhida', recolhida);
      topo.setAttribute('aria-expanded', String(!recolhida));
      if (recolhida) destacar(null);
    });
    for (const ev of ['wheel', 'pointerdown', 'dblclick', 'contextmenu']) raiz.addEventListener(ev, (e) => e.stopPropagation());
    host.append(raiz);

    return {
      atualizar(grupos) {
        const gs = (grupos || []).slice().sort((a, b) => (FIM[a.chave] || 0) - (FIM[b.chave] || 0) || b.n - a.n);
        lista.textContent = '';
        destacar(null);
        raiz.hidden = !gs.length;
        for (const g of gs) {
          const li = document.createElement('li');
          li.className = 'gl-item'; li.tabIndex = 0; li.dataset.grupo = g.chave;
          const b = document.createElement('span'); b.className = 'gl-bola'; b.style.background = g.cor;
          const r = document.createElement('span'); r.className = 'gl-rot'; r.textContent = g.rotulo; r.title = g.rotulo;
          const n = document.createElement('span'); n.className = 'gl-n'; n.textContent = String(g.n);
          li.append(b, r, n);
          li.addEventListener('pointerenter', () => destacar(g.chave));
          li.addEventListener('pointerleave', () => destacar(null));
          li.addEventListener('focus', () => destacar(g.chave));
          li.addEventListener('blur', () => destacar(null));
          lista.append(li);
        }
      },
      destruir() { destacar(null); raiz.remove(); },
    };
  }

  globalThis.GrafoLegenda = { criar };
})();
