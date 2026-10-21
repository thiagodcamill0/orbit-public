// Orbit — grupos da lateral (17/10). Carregado logo depois do </aside>, antes da pintura: a ordem e os grupos
// recolhidos já aparecem no lugar. Recolher: clique no título. Reordenar: arrastar itens (entre grupos também,
// menos para Projetos, que vem do servidor) e títulos de grupo, no padrão das abas (assets/abas.js): limiar de
// 4 px, fantasma preso ao cursor, vizinhos deslizam (FLIP), Esc cancela. Teclado: Alt+↑/↓ move o item ou o grupo.
// localStorage: gi.lat.ordem = { grupos: [nome...], itens: { grupo: [data-lat...] } } · gi.lat.recolhidos = { grupo: true }.
(() => {
  const raiz = document.getElementById('lat-grupos');
  if (!raiz) return;
  const LIMIAR = 4, DUR = 200, CURVA = 'cubic-bezier(.2, .8, .2, 1)';
  const C_ORDEM = 'gi.lat.ordem', C_REC = 'gi.lat.recolhidos';
  const ler = (k, p) => { try { const v = localStorage.getItem(k); return v == null ? p : JSON.parse(v); } catch { return p; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const reduzido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const largo = () => matchMedia('(min-width: 1100px)').matches;

  const grupos = () => [...raiz.children].filter((g) => g.classList.contains('lat-grupo'));
  const navDe = (g) => g.querySelector(':scope > .lat-corpo .nav'); // Projetos não tem .nav
  const itens = (nav) => [...nav.children].filter((b) => b.dataset.lat);
  const visiveis = (nav) => itens(nav).filter((b) => !b.hidden);
  const grupoDe = (el) => el.closest('.lat-grupo');

  // ───────────────────────── ordem gravada ─────────────────────────
  function salvar() {
    const it = {};
    for (const g of grupos()) { const n = navDe(g); if (n) it[g.dataset.grupo] = itens(n).map((b) => b.dataset.lat); }
    gravar(C_ORDEM, { grupos: grupos().map((g) => g.dataset.grupo), itens: it });
  }
  function aplicarOrdem() {
    const o = ler(C_ORDEM, null);
    if (!o || typeof o !== 'object') return;
    const padrao = grupos();
    if (Array.isArray(o.grupos)) {
      const por = new Map(padrao.map((g) => [g.dataset.grupo, g]));
      const fim = o.grupos.map((n) => por.get(n)).filter((g, i, a) => g && a.indexOf(g) === i);
      // Grupo que não estava gravado (veio numa versão nova) entra na posição de fábrica.
      padrao.forEach((g, i) => { if (!fim.includes(g)) fim.splice(Math.min(i, fim.length), 0, g); });
      for (const g of fim) raiz.appendChild(g);
    }
    if (o.itens && typeof o.itens === 'object') {
      const todos = new Map();
      for (const g of padrao) { const n = navDe(g); if (n) itens(n).forEach((b, i) => todos.set(b.dataset.lat, { b, n, i })); }
      const postos = new Set();
      for (const g of grupos()) {
        const n = navDe(g), lista = o.itens[g.dataset.grupo];
        if (!n || !Array.isArray(lista)) continue;
        for (const k of lista) { const x = todos.get(k); if (x && !postos.has(k)) { n.appendChild(x.b); postos.add(k); } }
      }
      // Item novo (sem lugar gravado): volta ao grupo de fábrica, na posição de fábrica.
      for (const [k, x] of todos) if (!postos.has(k)) x.n.insertBefore(x.b, itens(x.n)[x.i] || null);
    }
  }

  // ───────────────────────── recolher ─────────────────────────
  const rec = ler(C_REC, {}) || {};
  function marcar(g, fechado) {
    g.classList.toggle('recolhido', fechado);
    g.querySelector('.lat-alt').setAttribute('aria-expanded', String(!fechado));
  }
  function alternar(g) {
    const fechado = !g.classList.contains('recolhido');
    marcar(g, fechado);
    if (fechado) rec[g.dataset.grupo] = true; else delete rec[g.dataset.grupo];
    gravar(C_REC, rec);
  }

  aplicarOrdem();
  raiz.classList.add('sem-anim');
  for (const g of grupos()) {
    const b = g.querySelector('.lat-alt'), c = g.querySelector('.lat-corpo');
    c.id = 'lat-corpo-' + g.dataset.grupo;
    b.setAttribute('aria-controls', c.id);
    marcar(g, !!rec[g.dataset.grupo]);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => raiz.classList.remove('sem-anim')));

  // ───────────────────────── FLIP ─────────────────────────
  // Foto da tela (com as animações em curso) → mexe no DOM → cada um desliza de onde estava.
  function foto() {
    const m = new Map();
    for (const g of grupos()) {
      m.set(g, g.getBoundingClientRect());
      const n = navDe(g); if (n) for (const b of visiveis(n)) m.set(b, b.getBoundingClientRect());
    }
    return m;
  }
  function animar(ft) {
    if (!ft || reduzido()) return;
    const novos = new Map();
    for (const el of ft.keys()) { for (const a of el.getAnimations()) if (a.id === 'lat') a.cancel(); }
    for (const el of ft.keys()) if (el.isConnected) novos.set(el, el.getBoundingClientRect());
    for (const [el, r1] of novos) {
      const r0 = ft.get(el);
      let dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (!el.classList.contains('lat-grupo')) {
        // O grupo já desliza: o item só anda o que falta (senão anda duas vezes).
        const g = grupoDe(el), g0 = ft.get(g), g1 = novos.get(g);
        if (g0 && g1) { dx -= g0.left - g1.left; dy -= g0.top - g1.top; }
      }
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      const a = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DUR, easing: CURVA });
      a.id = 'lat';
    }
  }
  // Posição de layout (sem os transforms das animações): soma os offsetTop até a raiz.
  function topo(el) { let y = 0; for (let n = el; n && n !== raiz; n = n.offsetParent) y += n.offsetTop; return raiz.getBoundingClientRect().top + y; }
  const meio = (el) => topo(el) + el.offsetHeight / 2;

  // ───────────────────────── arrastar ─────────────────────────
  let arr = null, semClique = false;
  const lateral = raiz.closest('.lateral');

  raiz.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || arr || !largo() || document.body.classList.contains('lat-recolhida')) return;
    if (e.target.closest('.proj-add')) return;
    const cab = e.target.closest('.lat-alt');
    const item = !cab && e.target.closest('.nav-item[data-lat]');
    if (!cab && !item) return;
    const el = cab ? grupoDe(cab) : item;
    arr = { tipo: cab ? 'grupo' : 'item', el, pega: cab || item, x0: e.clientX, y0: e.clientY, pid: e.pointerId, ativo: false,
      pai: el.parentNode, ind: [...el.parentNode.children].indexOf(el) };
    document.addEventListener('pointermove', aoMover);
    document.addEventListener('pointerup', aoSoltar);
    document.addEventListener('pointercancel', aoCancelar);
    document.addEventListener('keydown', aoTecla, true);
  });
  function desligar() {
    document.removeEventListener('pointermove', aoMover);
    document.removeEventListener('pointerup', aoSoltar);
    document.removeEventListener('pointercancel', aoCancelar);
    document.removeEventListener('keydown', aoTecla, true);
  }
  function aoMover(e) {
    if (!arr || e.pointerId !== arr.pid) return;
    if (!arr.ativo) {
      if (Math.hypot(e.clientX - arr.x0, e.clientY - arr.y0) < LIMIAR) return;
      comecar();
    }
    e.preventDefault();
    mover(e.clientX, e.clientY);
  }
  function aoSoltar(e) {
    if (!arr || e.pointerId !== arr.pid) return;
    const fim = arr; arr = null; desligar();
    if (!fim.ativo) return;
    semClique = true; setTimeout(() => { semClique = false; }, 0);
    terminar(fim, false);
  }
  function aoCancelar() { if (!arr) return; const fim = arr; arr = null; desligar(); if (fim.ativo) terminar(fim, true); }
  function aoTecla(e) { if (e.key === 'Escape' && arr) { e.preventDefault(); e.stopPropagation(); aoCancelar(); } }
  // O clique que fecha um arraste não abre nada nem recolhe o grupo.
  document.addEventListener('click', (e) => { if (semClique) { e.preventDefault(); e.stopPropagation(); } }, true);

  function comecar() {
    arr.ativo = true;
    const r = arr.pega.getBoundingClientRect();
    arr.dx = arr.x0 - r.left; arr.dy = arr.y0 - r.top;
    const f = document.createElement('div');
    f.className = 'lat-fantasma' + (arr.tipo === 'grupo' ? ' grupo' : '');
    f.setAttribute('aria-hidden', 'true');
    for (const n of arr.pega.children) if (!n.matches('#proj-n')) { const c = n.cloneNode(true); c.removeAttribute('id'); f.appendChild(c); }
    f.style.width = Math.round(r.width) + 'px';
    f.style.height = Math.round(r.height) + 'px';
    f.style.transformOrigin = `${Math.round(arr.dx)}px ${Math.round(arr.dy)}px`;
    f.style.transform = `translate3d(${Math.round(r.left)}px, ${Math.round(r.top)}px, 0)`;
    arr.fantasma = f;
    document.body.appendChild(f);
    const ft = foto();
    arr.el.classList.add('lat-arrastado');
    raiz.classList.add('arrastando');
    animar(ft); // o grupo arrastado encolhe para só o título: os de baixo sobem deslizando
  }
  function mover(x, y) {
    arr.fantasma.style.transform = `translate3d(${Math.round(x - arr.dx)}px, ${Math.round(y - arr.dy)}px, 0)`;
    rolarPerto(y);
    const ft = foto();
    if (arr.tipo === 'grupo' ? alvoGrupo(y) : alvoItem(y)) animar(ft);
  }
  // Perto da borda de cima ou de baixo, a lateral rola sozinha.
  function rolarPerto(y) {
    if (!lateral) return;
    const r = lateral.getBoundingClientRect(), m = 28;
    if (y < r.top + m) lateral.scrollTop -= Math.ceil((r.top + m - y) / 3);
    else if (y > r.bottom - m) lateral.scrollTop += Math.ceil((y - (r.bottom - m)) / 3);
  }
  // Grupo: troca com o vizinho quando o cursor passa do meio dele (estável: depois da troca o meio fica do outro lado).
  function alvoGrupo(y) {
    const el = arr.el;
    let mexeu = false;
    for (let k = 0; k < 8; k++) {
      const gs = grupos(), i = gs.indexOf(el), ant = gs[i - 1], prox = gs[i + 1];
      if (ant && y < meio(ant)) raiz.insertBefore(el, ant);
      else if (prox && y > meio(prox)) raiz.insertBefore(el, prox.nextSibling);
      else break;
      mexeu = true;
    }
    return mexeu;
  }
  // Item: o grupo é o que está sob o cursor (aberto e com lista); a posição, pelo meio dos vizinhos.
  function alvoItem(y) {
    const el = arr.el;
    const cands = grupos().filter((g) => navDe(g) && !g.classList.contains('recolhido'));
    if (!cands.length) return false;
    let g = null;
    for (const c of cands) { const t = topo(c); if (y >= t && y < t + c.offsetHeight) { g = c; break; } }
    if (!g) {
      if (y < topo(cands[0])) g = cands[0];
      else { const u = cands[cands.length - 1]; if (y >= topo(u) + u.offsetHeight) g = u; }
    }
    if (!g) return false; // sobre Projetos ou um grupo recolhido: fica onde está
    const nav = navDe(g);
    const outros = visiveis(nav).filter((b) => b !== el);
    let ind = 0;
    while (ind < outros.length && meio(outros[ind]) < y) ind++;
    const ref = outros[ind] || null;
    if (el.parentNode === nav) {
      const atual = outros.findIndex((b) => el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      if ((atual < 0 ? outros.length : atual) === ind) return false;
    }
    if (ref) nav.insertBefore(el, ref);
    else { const v = visiveis(nav).filter((b) => b !== el), u = v[v.length - 1]; nav.insertBefore(el, u ? u.nextSibling : nav.firstChild); }
    return true;
  }
  function terminar(fim, cancelar) {
    const ft = foto();
    if (fim.fantasma && fim.fantasma.isConnected) ft.set(fim.el, fim.fantasma.getBoundingClientRect()); // voa de onde o fantasma está
    if (cancelar) {
      const irmaos = [...fim.pai.children].filter((n) => n !== fim.el);
      fim.pai.insertBefore(fim.el, irmaos[fim.ind] || null);
    }
    if (fim.fantasma) fim.fantasma.remove();
    fim.el.classList.remove('lat-arrastado');
    raiz.classList.remove('arrastando');
    animar(ft);
    if (!cancelar) salvar();
  }

  // ───────────────────────── teclado e clique ─────────────────────────
  raiz.addEventListener('click', (e) => {
    const b = e.target.closest('.lat-alt');
    if (b && raiz.contains(b)) alternar(grupoDe(b));
  });
  // Alt+↑/↓: move o item (passando para o grupo vizinho nas pontas) ou o grupo, com o mesmo deslize.
  raiz.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const sobe = e.key === 'ArrowUp';
    const cab = e.target.closest('.lat-alt'), item = !cab && e.target.closest('.nav-item[data-lat]');
    if (!cab && !item) return;
    e.preventDefault();
    const ft = foto();
    let el;
    if (cab) {
      el = grupoDe(cab);
      const gs = grupos(), i = gs.indexOf(el), viz = gs[sobe ? i - 1 : i + 1];
      if (!viz) return;
      raiz.insertBefore(el, sobe ? viz : viz.nextSibling);
    } else {
      el = item;
      const nav = el.parentNode, v = visiveis(nav), i = v.indexOf(el);
      const viz = v[sobe ? i - 1 : i + 1];
      if (viz) nav.insertBefore(el, sobe ? viz : viz.nextSibling);
      else {
        const navs = grupos().filter((g) => navDe(g) && !g.classList.contains('recolhido')).map(navDe);
        const outro = navs[navs.indexOf(nav) + (sobe ? -1 : 1)];
        if (!outro) return;
        const ov = visiveis(outro);
        if (sobe) { const u = ov[ov.length - 1]; outro.insertBefore(el, u ? u.nextSibling : outro.firstChild); }
        else outro.insertBefore(el, ov[0] || outro.firstChild);
      }
    }
    animar(ft);
    salvar();
    (cab || item).focus({ preventScroll: true });
  });
})();
