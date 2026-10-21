// Orbit — modo de edição dos widgets da Visão geral (19/10, no estilo do iPhone). Carregado logo depois da
// #vista-geral, antes da pintura: a ordem gravada já aparece no lugar.
// Editáveis: os gráficos e a Sincronização (.graf[data-widget]); a lista de sessões e o resto da Home ficam de fora.
// As vagas são da coluna: três na lateral (.col-lado) e duas no pé (.col-pe), cada uma com o formato de sempre. O
// widget que muda de vaga assume a largura dela e a versão do layout para esse tamanho (container queries em
// index.html, sincronia.css e widgets.css).
// Entrar: segurar o clique num widget por SEGURAR ms (sem mexer). Trocar: arrastar um widget sobre outro e soltar;
// os dois trocam de lugar (FLIP). Sair: Esc, clique fora ou "Concluir"; "Padrão" volta à disposição de fábrica.
// Esc durante o arrasto só cancela o arrasto. Movimento reduzido: sem tremor e trocas sem animação.
// localStorage: gi.widgets = [chave por vaga, na ordem lateral → pé] (sem a chave = padrão).
(() => {
  const vista = document.getElementById('vista-geral');
  const lado = vista && vista.querySelector('.col-lado'), pe = vista && vista.querySelector('.col-pe');
  if (!lado || !pe) return;
  const C_ORDEM = 'gi.widgets', SEGURAR = 480, AFUNDA = 120, FOLGA = 8, LIMIAR = 4, BORDA = 56;
  const DUR = 380, CURVA = 'cubic-bezier(.2, .8, .2, 1)';
  const ler = (k, p) => { try { const v = localStorage.getItem(k); return v == null ? p : JSON.parse(v); } catch { return p; } };
  const gravar = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const reduzido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visivel = (el) => el.getClientRects().length > 0;

  // ───────────────────────── ordem ─────────────────────────
  const daColuna = (col) => [...col.querySelectorAll(':scope > .graf[data-widget]')];
  const cartoes = () => [...daColuna(lado), ...daColuna(pe)];
  const VAGAS_LADO = daColuna(lado).length;
  const PADRAO = cartoes().map((c) => c.dataset.widget);
  const ordem = () => cartoes().map((c) => c.dataset.widget);
  const ehPadrao = (o) => o.join() === PADRAO.join();
  const valida = (o) => Array.isArray(o) && o.length === PADRAO.length && PADRAO.every((k) => o.includes(k));
  function aplicar(o) {
    const por = new Map(cartoes().map((c) => [c.dataset.widget, c]));
    const ancora = lado.querySelector(':scope > .cena-v'); // a cena em pé vem depois das vagas da lateral
    o.forEach((k, i) => { if (i < VAGAS_LADO) lado.insertBefore(por.get(k), ancora); else pe.appendChild(por.get(k)); });
  }
  { const o = ler(C_ORDEM, null); if (valida(o) && !ehPadrao(o)) aplicar(o); } // ordem antiga ou estranha: padrão

  // ───────────────────────── estado ─────────────────────────
  // segura: o tempo do clique longo correndo · pega: ponteiro abaixado num widget, ainda sem arrastar ·
  // arrasto: o widget seguindo o ponteiro · engolir: o click que vem depois de segurar ou de arrastar.
  const ed = { on: false, segura: null, pega: null, arrasto: null, engolir: false, barra: null, rolador: null };
  const fora = () => [vista.querySelector('#faixa-acao'), vista.querySelector('.tiles-wrap'), vista.querySelector('.col-lista'), vista.querySelector('#cena-v img')].filter(Boolean);

  // Tremor: o canto do cartão anda ~1,6 px em qualquer largura (cartão largo gira menos); fases desencontradas.
  function tremor(c, i) {
    const w = c.getBoundingClientRect().width || 300;
    c.style.setProperty('--wd-ang', Math.min(.5, (1.6 / (w / 2)) * 180 / Math.PI).toFixed(3) + 'deg');
    if (i != null) c.style.setProperty('--wd-fase', (-(i * .17) % .3).toFixed(2) + 's');
  }

  function entrar() {
    if (ed.on) return;
    ed.on = true;
    cartoes().forEach((c, i) => tremor(c, i));
    for (const el of fora()) el.classList.add('wd-fora');
    vista.classList.add('wd-editando');
    try { getSelection().removeAllRanges(); } catch {}
    const foco = document.activeElement;
    if (foco && foco !== document.body && foco.closest && foco.closest('.graf[data-widget]')) foco.blur();
    mostrarBarra(true);
  }
  function sair() {
    if (!ed.on) return;
    if (ed.arrasto) soltar(false);
    cancelarSegura();
    ed.pega = null;
    ed.on = false;
    vista.classList.remove('wd-editando');
    mostrarBarra(false);
  }

  // ───────────────────────── barra ─────────────────────────
  function criarBarra() {
    const b = document.createElement('div');
    b.className = 'wd-barra fechada';
    b.setAttribute('role', 'toolbar');
    b.setAttribute('aria-label', 'Organizar widgets');
    b.inert = true;
    const txt = document.createElement('span');
    txt.className = 'wd-barra-txt';
    const dica = document.createElement('span');
    dica.className = 'wd-barra-dica';
    dica.textContent = '· arraste um sobre o outro para trocar';
    txt.append(document.createElement('i'), 'Organizando widgets', dica);
    const botao = (rot, cls, fn, titulo) => {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = cls;
      x.textContent = rot;
      if (titulo) x.title = titulo;
      x.addEventListener('click', fn);
      return x;
    };
    ed.padrao = botao('Padrão', 'wd-padrao', restaurar, 'Voltar à disposição padrão');
    b.append(txt, ed.padrao, botao('Concluir', 'wd-concluir', sair));
    document.body.append(b);
    return (ed.barra = b);
  }
  // No centro da Home e no pé da área que rola (com o terminal aberto, acima dele).
  function posicionarBarra() {
    const b = ed.barra;
    if (!b || b.classList.contains('fechada')) return;
    const r = vista.getBoundingClientRect(), rol = rolador(vista);
    const base = rol && rol !== document.scrollingElement ? Math.min(innerHeight, rol.getBoundingClientRect().bottom) : innerHeight;
    b.style.left = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2 + 'px';
    b.style.bottom = Math.max(16, innerHeight - base + 20) + 'px';
  }
  function atualizarBarra() { if (ed.padrao) ed.padrao.disabled = ehPadrao(ordem()); }
  function mostrarBarra(sim) {
    const b = ed.barra || criarBarra();
    if (!sim && b.contains(document.activeElement)) document.activeElement.blur();
    b.inert = !sim;
    b.classList.toggle('fechada', !sim);
    atualizarBarra();
    posicionarBarra();
  }
  addEventListener('resize', () => { posicionarBarra(); if (ed.on) cartoes().forEach((c) => tremor(c)); });

  // ───────────────────────── troca (FLIP) ─────────────────────────
  // Mede tudo, muda a ordem, refaz os alinhamentos da Home na hora (medirCenaV, do index.html) e anima cada cartão do
  // lugar antigo para o novo pelo centro. Os dois que trocam também saem do tamanho antigo (escala uniforme, sem
  // distorcer) e de uma leve transparência; o conteúdo já está no layout da vaga nova.
  function animarTroca(mudar, destaque = []) {
    const els = cartoes().filter(visivel);
    const antes = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    for (const el of els) {
      for (const an of el.getAnimations()) if (an.id === 'wd-flip') an.cancel();
      el.style.translate = '';
      el.classList.remove('wd-arrastado', 'wd-volta', 'wd-alvo');
    }
    mudar();
    const o = ordem();
    gravar(C_ORDEM, ehPadrao(o) ? null : o);
    atualizarBarra();
    if (typeof medirCenaV === 'function') medirCenaV();
    for (const el of els) tremor(el);
    if (reduzido()) return;
    for (const el of els) {
      const r0 = antes.get(el), r1 = el.getBoundingClientRect();
      if (!r1.width || !r1.height) continue;
      const dx = r0.left + r0.width / 2 - (r1.left + r1.width / 2), dy = r0.top + r0.height / 2 - (r1.top + r1.height / 2);
      const troca = destaque.includes(el);
      if (!troca && Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      const s = troca ? Math.min(1.12, Math.max(.88, Math.sqrt((r0.width * r0.height) / (r1.width * r1.height)))) : 1;
      const an = el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: troca ? .6 : 1 },
        { transform: 'none', opacity: 1 },
      ], { duration: DUR, easing: CURVA });
      an.id = 'wd-flip';
    }
  }
  function restaurar() { if (!ehPadrao(ordem())) animarTroca(() => aplicar(PADRAO), cartoes()); }

  // ───────────────────────── segurar ─────────────────────────
  function cancelarSegura() {
    const s = ed.segura;
    if (!s) return;
    clearTimeout(s.t); clearTimeout(s.t2);
    s.c.classList.remove('wd-segurando');
    ed.segura = null;
  }
  function disparar() {
    const s = ed.segura;
    ed.segura = null;
    s.c.classList.remove('wd-segurando');
    if (!visivel(s.c)) return;
    entrar();
    ed.engolir = true; // o click do soltar não aciona o que estava embaixo (filtro, botão, linha)
    ed.pega = { c: s.c, id: s.id, x: s.x, y: s.y };
    try { s.c.setPointerCapture(s.id); } catch {}
    if (s.toque && navigator.vibrate) try { navigator.vibrate(8); } catch {}
  }

  // ───────────────────────── arrastar ─────────────────────────
  function rolador(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
  }
  function iniciarArrasto(x, y) {
    const p = ed.pega, c = p.c;
    ed.pega = null;
    ed.rolador = rolador(c);
    for (const an of c.getAnimations()) if (an.id === 'wd-flip') an.cancel();
    ed.arrasto = { c, id: p.id, x0: p.x, y0: p.y, s0: ed.rolador.scrollTop, x, y, alvo: null, v: 0, raf: 0 };
    c.classList.remove('wd-volta');
    c.classList.add('wd-arrastado');
    document.documentElement.classList.add('wd-arrastando');
    posicionar();
  }
  // O widget preso ao ponteiro (com a rolagem desde o começo) e o alvo: o outro widget sob o ponteiro.
  function posicionar() {
    const a = ed.arrasto;
    a.c.style.translate = `${a.x - a.x0}px ${a.y - a.y0 + ed.rolador.scrollTop - a.s0}px`;
    let alvo = null;
    for (const o of cartoes()) {
      if (o === a.c || !visivel(o)) continue;
      const r = o.getBoundingClientRect();
      if (a.x >= r.left && a.x <= r.right && a.y >= r.top && a.y <= r.bottom) { alvo = o; break; }
    }
    if (alvo !== a.alvo) {
      if (a.alvo) a.alvo.classList.remove('wd-alvo');
      if (alvo) alvo.classList.add('wd-alvo');
      a.alvo = alvo;
    }
  }
  // Perto da borda de cima ou de baixo da área que rola, ela rola sozinha (mais rápido quanto mais perto).
  function autoRolar() {
    const a = ed.arrasto, r = ed.rolador;
    const box = r === document.scrollingElement ? { top: 0, bottom: innerHeight } : r.getBoundingClientRect();
    const topo = Math.max(0, box.top), fim = Math.min(innerHeight, box.bottom);
    let v = 0;
    if (a.y < topo + BORDA) v = -Math.ceil(((topo + BORDA - a.y) / BORDA) * 14);
    else if (a.y > fim - BORDA) v = Math.ceil(((a.y - (fim - BORDA)) / BORDA) * 14);
    a.v = Math.max(-18, Math.min(18, v));
    if (a.v && !a.raf) a.raf = requestAnimationFrame(passo);
  }
  function passo() {
    const a = ed.arrasto;
    if (!a) return;
    a.raf = 0;
    if (!a.v) return;
    const antes = ed.rolador.scrollTop;
    ed.rolador.scrollTop += a.v;
    if (ed.rolador.scrollTop !== antes) posicionar();
    a.raf = requestAnimationFrame(passo);
  }
  function soltar(trocar) {
    const a = ed.arrasto;
    ed.arrasto = null;
    cancelAnimationFrame(a.raf);
    document.documentElement.classList.remove('wd-arrastando');
    if (a.alvo) a.alvo.classList.remove('wd-alvo');
    if (trocar && a.alvo) {
      const b = a.alvo;
      animarTroca(() => { const m = document.createComment(''); a.c.replaceWith(m); b.replaceWith(a.c); m.replaceWith(b); }, [a.c, b]);
      return;
    }
    // Sem alvo: volta para a vaga dele.
    const c = a.c;
    c.classList.remove('wd-arrastado');
    if (reduzido()) { c.style.translate = ''; return; }
    c.classList.add('wd-volta');
    c.style.translate = '';
    setTimeout(() => c.classList.remove('wd-volta'), 300);
  }

  // ───────────────────────── eventos ─────────────────────────
  vista.addEventListener('pointerdown', (e) => {
    const c = e.target.closest && e.target.closest('.graf[data-widget]');
    if (!c || e.button !== 0 || !e.isPrimary || ed.arrasto) return;
    if (ed.on) {
      e.preventDefault(); // sem seleção de texto nem foco no que está embaixo
      ed.pega = { c, id: e.pointerId, x: e.clientX, y: e.clientY };
      try { c.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    cancelarSegura();
    ed.segura = {
      c, id: e.pointerId, x: e.clientX, y: e.clientY, toque: e.pointerType === 'touch',
      t: setTimeout(disparar, SEGURAR), t2: setTimeout(() => c.classList.add('wd-segurando'), AFUNDA),
    };
  }, true);
  document.addEventListener('pointerdown', (e) => {
    ed.engolir = false;
    if (!ed.on) return;
    const t = e.target;
    if (t.closest && (t.closest('.graf[data-widget]') || t.closest('.wd-barra'))) return;
    // A barra de rolagem da área da Home não conta como clique fora.
    if (t instanceof HTMLElement && t.clientWidth && e.offsetX >= t.clientWidth && t.scrollHeight > t.clientHeight) return;
    sair();
  }, true);
  addEventListener('pointermove', (e) => {
    const s = ed.segura;
    if (s && e.pointerId === s.id && Math.hypot(e.clientX - s.x, e.clientY - s.y) > FOLGA) cancelarSegura();
    const p = ed.pega;
    if (p && e.pointerId === p.id && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LIMIAR) iniciarArrasto(e.clientX, e.clientY);
    const a = ed.arrasto;
    if (a && e.pointerId === a.id) { a.x = e.clientX; a.y = e.clientY; posicionar(); autoRolar(); }
  });
  const fim = (e) => {
    if (ed.segura && e.pointerId === ed.segura.id) cancelarSegura();
    if (ed.pega && e.pointerId === ed.pega.id) ed.pega = null;
    if (ed.arrasto && e.pointerId === ed.arrasto.id) { ed.engolir = true; soltar(e.type === 'pointerup'); }
  };
  addEventListener('pointerup', fim);
  addEventListener('pointercancel', fim);
  addEventListener('click', (e) => { if (ed.engolir) { ed.engolir = false; e.preventDefault(); e.stopPropagation(); } }, true);
  // Toque: o segurar não abre o menu do sistema, e o dedo que já segurou arrasta em vez de rolar a página.
  addEventListener('contextmenu', (e) => {
    if ((ed.segura || ed.on) && e.target.closest && e.target.closest('.graf[data-widget]')) e.preventDefault();
  }, true);
  addEventListener('touchmove', (e) => { if (ed.pega || ed.arrasto) e.preventDefault(); }, { passive: false });
  document.addEventListener('scroll', () => { if (ed.arrasto) posicionar(); }, true);
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ed.on) return;
    e.preventDefault();
    e.stopPropagation();
    if (ed.arrasto) soltar(false); else sair();
  }, true);
  // A Home saiu de vista (outra vista, aba escondida): sai do modo de edição.
  new ResizeObserver(() => { if (ed.on && !visivel(vista)) sair(); }).observe(vista);
  new MutationObserver(() => { if (ed.on && vista.hidden) sair(); }).observe(vista, { attributes: true, attributeFilter: ['hidden'] });
})();
