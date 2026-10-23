// Orbit — grade da Visão geral e modo de edição dos widgets (19/10, no estilo do iPhone; grade de 21/10). Carregado
// logo depois da #vista-geral, antes da pintura: o layout gravado já aparece no lugar.
// A Home é uma grade de colunas (12, 8, 4 ou 1, pela largura) e linhas de LINHA px (CSS em widgets.css). Itens: a
// lista de sessões (.col-lista[data-wd]), os widgets e a Cena do dia (.graf[data-widget]). Cada item tem coluna,
// linha, largura em colunas e uma altura escolhida (a, em px; 0 = a do conteúdo). A altura de verdade nunca fica
// abaixo da do conteúdo naquela largura (medida no próprio item), então nada é cortado; a lista é sempre do
// tamanho dela. Sem sobreposição: quem bate desce, e depois todos sobem até o primeiro obstáculo (gravidade).
// Editar: segurar o clique num widget por SEGURAR ms (sem mexer). Mover: arrastar para qualquer ponto da grade —
// sobre outro widget, entra antes ou depois dele, na largura daquela vaga; num espaço livre, ocupa a largura livre
// daquela linha (num trecho todo livre, fica com a dele). A vaga aparece de leve enquanto arrasta, e os outros
// abrem espaço (FLIP). Redimensionar: puxar o canto (a lista, só a largura), em colunas e linhas, entre o mínimo
// do conteúdo e o máximo do widget. Sair: Esc, clique fora ou "Concluir"; "Padrão" volta à disposição de fábrica.
// Esc no meio de um arrasto ou redimensionamento só cancela ele. Movimento reduzido: sem tremor e sem animação.
// localStorage: gi.widgets.grade = { <colunas>: { <item>: [x, y, w, a] } }, um layout por número de colunas (o que
// foi editado naquela largura); sem ele, o de 12 (ou o de fábrica) adaptado. gi.widgets (a ordem das vagas fixas,
// até 21/10) vira o layout de 12 colunas na primeira carga e sai.
(() => {
  const vista = document.getElementById('vista-geral');
  const grade = vista && vista.querySelector('.geral-grade');
  if (!grade) return;
  const C_GRADE = 'gi.widgets.grade', C_ANTIGA = 'gi.widgets';
  const LINHA = 8, VAO = 16, ZONA = 160, SEGURAR = 480, AFUNDA = 120, FOLGA = 8, LIMIAR = 4, BORDA = 56;
  const DUR = 380, CURVA = 'cubic-bezier(.2, .8, .2, 1)';
  const ler = (k, p) => { try { const v = localStorage.getItem(k); return v == null ? p : JSON.parse(v); } catch { return p; } };
  const gravar = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const reduzido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visivel = (el) => el.getClientRects().length > 0;
  const limitar = (v, a, b) => Math.max(a, Math.min(b, v));

  // ───────────────────────── itens ─────────────────────────
  // minL: largura mínima (px) · maxA: altura máxima (px; nunca abaixo do conteúdo) · livre: sem altura de conteúdo
  // (a cena: a natural é a da proporção da imagem; a escolhida vai de minA a maxA).
  const SPEC = {
    lista: { minL: 440 }, // não se arrasta; só a largura muda
    estado: { minL: 240, maxA: 720 },
    ctx: { minL: 240, maxA: 1100 },
    sinc: { minL: 240, maxA: 800 },
    uso: { minL: 260, maxA: 640 },
    disco: { minL: 260, maxA: 480 },
    grafo: { minL: 260, maxA: 1100 },
    cena: { minL: 160, minA: 120, maxA: 1100, livre: true },
  };
  // De fábrica, em 12 colunas: [x, y, w, a]. O y só ordena (a gravidade sobe tudo). A lista com a lateral de sempre
  // (3 colunas ≈ 300 px a 1500 px de tela); embaixo dela, Uso do plano e Grafo; na lateral, a cena em pé no fim.
  const PADRAO = { lista: [0, 0, 9, 0], estado: [9, 0, 3, 0], ctx: [9, 1, 3, 0], sinc: [9, 2, 3, 0], disco: [9, 3, 3, 0], cena: [9, 4, 3, 520], uso: [0, 90, 9, 0], grafo: [0, 91, 9, 0] };
  const chave = (el) => el.dataset.widget || el.dataset.wd;
  const EL = new Map([...grade.querySelectorAll(':scope > [data-widget], :scope > [data-wd]')].map((el) => [chave(el), el]));
  for (const k of EL.keys()) { SPEC[k] ||= { minL: 240, maxA: 900 }; PADRAO[k] ||= [0, 999, 12, 0]; } // item novo sem entrada aqui: no fim
  for (const k of Object.keys(PADRAO)) if (!EL.has(k)) delete PADRAO[k];
  const cartoes = () => [...EL.values()].filter((el) => el.matches('.graf[data-widget]'));

  // Alça de redimensionar (aparece só no modo de edição) e régua: mede a largura da grade sem mudar de tamanho
  // quando a altura dela muda (o ResizeObserver dela não entra em laço com o layout).
  for (const el of EL.values()) {
    const b = document.createElement('span');
    b.className = 'wd-alca';
    b.setAttribute('aria-hidden', 'true');
    b.title = el.dataset.wd === 'lista' ? 'Arraste para mudar a largura' : 'Arraste para redimensionar';
    el.append(b);
  }
  const regua = document.createElement('div');
  regua.style.cssText = 'position:absolute;left:0;right:0;top:0;height:0;pointer-events:none;visibility:hidden';
  const vaga = document.createElement('div');
  vaga.className = 'wd-vaga';
  vaga.hidden = true;
  grade.append(regua, vaga);

  // ───────────────────────── medidas ─────────────────────────
  let cols = 12;
  const colsPara = (w) => (w >= 1000 ? 12 : w >= 680 ? 8 : w >= 500 ? 4 : 1);
  function metricas() {
    const r = grade.getBoundingClientRect(), cs = getComputedStyle(grade);
    const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    const larg = grade.clientWidth - pl - pr;
    const col = (larg - (cols - 1) * VAO) / cols;
    return { left: r.left + grade.clientLeft + pl, top: r.top + grade.clientTop + (parseFloat(cs.paddingTop) || 0), col, passo: col + VAO };
  }
  const minC = (k, m) => limitar(Math.ceil((SPEC[k].minL + VAO) / m.passo - 1e-6), 1, cols);
  // Altura natural de cada item na largura atual: cada um na altura do próprio conteúdo (wd-medindo, sem as sobras).
  const nat = new Map();
  function medir() {
    if (!visivel(grade)) return false;
    grade.classList.add('wd-medindo');
    let mudou = false;
    for (const [k, el] of EL) {
      const v = el.offsetHeight;
      if (v && nat.get(k) !== v) { nat.set(k, v); mudou = true; }
    }
    grade.classList.remove('wd-medindo');
    return mudou;
  }
  // Altura em linhas (com o vão de baixo): a escolhida, sem ficar abaixo do conteúdo nem acima do máximo do widget.
  function linhas(k, a) {
    const s = SPEC[k], n = nat.get(k) || 0;
    let px = s.livre ? (a ? Math.max(a, s.minA || 0) : n) : Math.max(a || 0, n);
    if (s.maxA) px = Math.min(px, Math.max(s.maxA, s.livre ? 0 : n));
    return Math.max(1, Math.ceil((px + VAO) / LINHA - 1e-6));
  }

  // ───────────────────────── layout ─────────────────────────
  const bate = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const ordenar = (l) => l.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  // O fixo (o que está sendo movido ou redimensionado) fica onde está; os outros, na ordem (y, x), descem até não
  // bater em ninguém. Depois, todos sobem até o primeiro obstáculo da coluna deles.
  function assentar(outros, fixo) {
    const postos = fixo ? [fixo] : [];
    for (const it of ordenar(outros)) {
      const p = { ...it };
      for (let b; (b = postos.find((q) => bate(q, p)));) p.y = b.y + b.h;
      postos.push(p);
    }
    const out = [];
    for (const it of ordenar(postos)) {
      let y = 0;
      for (const p of out) if (p.x < it.x + it.w && it.x < p.x + p.w && p.y < it.y) y = Math.max(y, p.y + p.h);
      out.push({ ...it, y: Math.min(it.y, y) });
    }
    return out;
  }
  // Largura mínima e limites da grade; altura pelo conteúdo.
  function ajustar(it, m) {
    const w = limitar(Math.max(it.w, minC(it.k, m)), 1, cols), a = it.k === 'lista' ? 0 : it.a || 0;
    return { k: it.k, x: limitar(it.x, 0, cols - w), y: Math.max(0, it.y), w, a, h: linhas(it.k, a) };
  }
  // Sem layout gravado para menos colunas: o de 12 adaptado. Metade ou largura toda (o que tinha até metade das 12 fica
  // com metade), na ordem de leitura, cada um no lugar mais alto livre (e mais à esquerda).
  function derivar(base, m) {
    const meia = cols >= 4 ? cols / 2 : cols, out = [];
    for (const it of ordenar(Object.entries(base).map(([k, v]) => ({ k, x: v[0], y: v[1], w: v[2], a: v[3] })))) {
      let w = (it.w * cols) / 12 <= meia + 1e-6 ? meia : cols;
      if (w < minC(it.k, m)) w = cols;
      const h = linhas(it.k, it.a);
      let melhor = null;
      for (let x = 0; x + w <= cols; x += meia) {
        let y = 0;
        for (const p of out) if (p.x < x + w && x < p.x + p.w) y = Math.max(y, p.y + p.h);
        if (!melhor || y < melhor.y) melhor = { x, y };
      }
      out.push({ k: it.k, x: melhor.x, y: melhor.y, w, a: it.a || 0, h });
    }
    return out;
  }
  // Layout gravado de um número de colunas, validado; item que falta (widget novo) entra no fim.
  function gravado(n) {
    const g = guardado && guardado[n];
    if (!g || typeof g !== 'object') return null;
    const out = [];
    for (const k of EL.keys()) {
      const v = g[k];
      if (Array.isArray(v) && v.length === 4 && v.every((x) => Number.isFinite(x) && x >= 0)) out.push({ k, x: Math.round(v[0]), y: Math.round(v[1]), w: Math.max(1, Math.round(v[2])), a: Math.round(v[3]) });
      else out.push({ k, x: 0, y: 1e5, w: n, a: 0 });
    }
    return out;
  }
  function montar() {
    const m = metricas();
    const g = gravado(cols) || (cols === 12 ? Object.entries(PADRAO).map(([k, v]) => ({ k, x: v[0], y: v[1], w: v[2], a: v[3] })) : null);
    if (g) return assentar(g.map((it) => ajustar(it, m)));
    const g12 = gravado(12);
    return assentar(derivar(g12 ? Object.fromEntries(g12.map((it) => [it.k, [it.x, it.y, it.w, it.a]])) : PADRAO, m));
  }
  // Com um item fixo: os outros (já assentados, sem ele) abrem espaço.
  function montarCom(outros, fixo) {
    const m = metricas();
    return assentar(outros.map((it) => ({ ...it, h: linhas(it.k, it.a) })), ajustar(fixo, m));
  }

  let atual = [];
  function pintar(L) {
    for (const it of L) {
      const el = EL.get(it.k);
      el.style.gridColumn = `${it.x + 1} / span ${it.w}`;
      el.style.gridRow = `${it.y + 1} / span ${it.h}`;
    }
    atual = L;
  }
  // Pinta e mede de novo até a altura do conteúdo parar de mudar (a largura nova muda a altura do conteúdo).
  function aplicar(fazer) {
    let L;
    for (let i = 0; i < 4; i++) { L = fazer(); pintar(L); if (!medir()) break; }
    return L;
  }
  // Sobra (px além do conteúdo) de cada item e aviso a quem adapta o conteúdo à altura (cena em pé, linhas a mais do
  // Uso de contexto): no próximo ciclo, fora do ResizeObserver.
  let aviso = 0;
  function avisar() {
    for (const it of atual) {
      const el = EL.get(it.k), s = String(Math.max(0, Math.round(it.h * LINHA - VAO - (nat.get(it.k) || 0))));
      if (el.dataset.sobra !== s) el.dataset.sobra = s;
    }
    if (!aviso) aviso = setTimeout(() => { aviso = 0; grade.dispatchEvent(new CustomEvent('wd-layout')); });
  }
  function refazer() {
    if (ed.arrasto) { previa(true); return; }
    if (ed.redim) { redimensionar(true); return; }
    const W = regua.offsetWidth;
    if (!W) return; // Home oculta: fica o último layout
    const n = colsPara(W);
    if (n !== cols) { cols = n; grade.style.setProperty('--wd-cols', n); }
    aplicar(montar);
    avisar();
  }

  // ───────────────────────── gravado ─────────────────────────
  let guardado = ler(C_GRADE, null);
  if (!guardado || typeof guardado !== 'object' || Array.isArray(guardado)) guardado = null;
  // A ordem das vagas fixas (até 21/10: lateral 1–3, pé 1–3) vira o layout de 12 colunas: cada widget vai para a
  // posição de fábrica do que estava naquela vaga.
  {
    const VAGAS = ['estado', 'ctx', 'sinc', 'uso', 'disco', 'grafo'];
    let o = ler(C_ANTIGA, null);
    if (Array.isArray(o) && !guardado) {
      o = o.filter((k, i) => VAGAS.includes(k) && o.indexOf(k) === i);
      VAGAS.forEach((k, i) => { if (!o.includes(k)) o.splice(i, 0, k); });
      if (o.join() !== VAGAS.join() && VAGAS.every((k) => PADRAO[k])) {
        const g = Object.fromEntries(Object.entries(PADRAO).map(([k, v]) => [k, v.slice()]));
        o.forEach((k, i) => { const v = PADRAO[VAGAS[i]]; g[k] = [v[0], v[1], v[2], 0]; });
        guardado = { 12: g };
        gravar(C_GRADE, guardado);
      }
    }
    if (o != null) gravar(C_ANTIGA, null);
  }
  const ehPadrao = () => !guardado || !Object.keys(guardado).length;
  function salvar(L) {
    guardado = { ...(guardado || {}), [cols]: Object.fromEntries(ordenar(L).map((it) => [it.k, [it.x, it.y, it.w, it.a || 0]])) };
    gravar(C_GRADE, guardado);
    atualizarBarra();
  }

  // ───────────────────────── estado ─────────────────────────
  // segura: o tempo do clique longo correndo · pega: ponteiro abaixado num widget, ainda sem arrastar ·
  // arrasto: o widget seguindo o ponteiro · redim: puxando o canto · engolir: o click que vem depois de segurar ou de arrastar.
  const ed = { on: false, segura: null, pega: null, arrasto: null, redim: null, engolir: false, barra: null, rolador: null };
  const fora = () => [vista.querySelector('#faixa-acao'), vista.querySelector('.tiles-wrap'), vista.querySelector('.col-lista')].filter(Boolean);

  // Tremor: o canto do cartão anda ~1,6 px em qualquer largura (cartão largo gira menos); fases desencontradas.
  function tremor(c, i) {
    const w = c.getBoundingClientRect().width || 300;
    c.style.setProperty('--wd-ang', Math.min(.5, (1.6 / (w / 2)) * 180 / Math.PI).toFixed(3) + 'deg');
    if (i != null) c.style.setProperty('--wd-fase', (-(i * .17) % .3).toFixed(2) + 's');
  }

  function entrar() {
    if (ed.on) return;
    ed.on = true;
    for (const el of fora()) el.classList.add('wd-fora');
    vista.classList.add('wd-editando');
    cartoes().forEach((c, i) => tremor(c, i));
    try { getSelection().removeAllRanges(); } catch {}
    const foco = document.activeElement;
    if (foco && foco !== document.body && foco.closest && foco.closest('.graf[data-widget]')) foco.blur();
    mostrarBarra(true);
  }
  function sair() {
    if (!ed.on) return;
    if (ed.arrasto) soltar(false);
    if (ed.redim) fimRedim(false);
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
    dica.textContent = '· arraste para mover, puxe o canto para redimensionar';
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
  function atualizarBarra() { if (ed.padrao) ed.padrao.disabled = ehPadrao(); }
  function mostrarBarra(sim) {
    const b = ed.barra || criarBarra();
    if (!sim && b.contains(document.activeElement)) document.activeElement.blur();
    b.inert = !sim;
    b.classList.toggle('fechada', !sim);
    atualizarBarra();
    posicionarBarra();
  }
  addEventListener('resize', () => { posicionarBarra(); if (ed.on) cartoes().forEach((c) => tremor(c)); });

  // ───────────────────────── animação (FLIP) ─────────────────────────
  // Mede tudo, muda o layout e anima cada item do lugar antigo (de onde ele está agora, mesmo no meio de outra
  // animação) para o novo, pelo canto de cima. Quem está na mão (exceto) não anima.
  function animar(mudar, exceto) {
    const els = [...EL.values()].filter((el) => el !== exceto && visivel(el));
    const antes = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    for (const el of els) for (const an of el.getAnimations()) if (an.id === 'wd-flip') an.cancel();
    mudar();
    if (ed.on) for (const c of cartoes()) tremor(c);
    if (reduzido()) return;
    for (const el of els) {
      const r0 = antes.get(el), r1 = el.getBoundingClientRect();
      if (!r1.width || !r1.height) continue;
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DUR, easing: CURVA }).id = 'wd-flip';
    }
  }
  function restaurar() {
    if (ehPadrao()) return;
    guardado = null;
    gravar(C_GRADE, null);
    animar(() => { aplicar(montar); avisar(); });
    atualizarBarra();
  }

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

  // ───────────────────────── mover ─────────────────────────
  function rolador(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
  }
  function pintarVaga(it) {
    vaga.style.gridColumn = `${it.x + 1} / span ${it.w}`;
    vaga.style.gridRow = `${it.y + 1} / span ${it.h}`;
    vaga.hidden = false;
  }
  function iniciarArrasto(x, y) {
    const p = ed.pega, c = p.c, k = chave(c);
    ed.pega = null;
    ed.rolador = rolador(c);
    for (const an of c.getAnimations()) if (an.id === 'wd-flip') an.cancel();
    const r = c.getBoundingClientRect(), eu = atual.find((it) => it.k === k);
    ed.arrasto = {
      c, k, id: p.id, x, y, dx: p.x - r.left, dy: p.y - r.top,
      eu, base: assentar(atual.filter((it) => it.k !== k)), L: atual, fixo: { k, x: eu.x, y: eu.y, w: eu.w, a: eu.a }, alvo: null, v: 0, raf: 0,
    };
    c.classList.remove('wd-volta');
    c.classList.add('wd-arrastado');
    grade.classList.add('wd-movendo');
    document.documentElement.classList.add('wd-arrastando');
    pintarVaga(eu);
    posicionar();
  }
  // Onde o widget vai encaixar, nas posições da base (os outros sem ele):
  //  - antes/depois de outro: na coluna e na largura dele (ajustada ao mínimo), em cima ou embaixo;
  //  - livre: a largura livre daquela linha em volta do ponteiro (trecho todo livre: a largura dele), na linha do ponteiro.
  function fixoDe(alvo) {
    const a = ed.arrasto, m = metricas(), mn = minC(a.k, m);
    if (alvo.tipo !== 'livre') {
      const b = a.base.find((it) => it.k === alvo.k);
      if (!b) return null;
      const w = limitar(Math.max(b.w, mn), 1, cols);
      return { k: a.k, x: limitar(b.x, 0, cols - w), y: alvo.tipo === 'antes' ? b.y : b.y + b.h, w, a: a.eu.a };
    }
    const ocup = new Array(cols).fill(false);
    for (const it of a.base) if (it.y <= alvo.r && alvo.r < it.y + it.h) for (let i = it.x; i < it.x + it.w; i++) ocup[i] = true;
    if (ocup[alvo.c]) return null;
    let ini = alvo.c, fim = alvo.c + 1;
    while (ini > 0 && !ocup[ini - 1]) ini--;
    while (fim < cols && !ocup[fim]) fim++;
    const livre = fim - ini, w = livre === cols ? limitar(Math.max(a.eu.w, mn), 1, cols) : limitar(Math.max(livre, mn), 1, cols);
    const x = w <= livre ? limitar(alvo.c - Math.floor(w / 2), ini, fim - w) : limitar(alvo.c - Math.floor(w / 2), 0, cols - w);
    return { k: a.k, x, y: alvo.r, w, a: a.eu.a };
  }
  // Monta o layout com o widget no alvo e os outros abrindo espaço (animados); a vaga mostra o lugar.
  // Sem mudança de largura, o layout é montado antes: se der no mesmo (a gravidade sobe o widget para a mesma vaga),
  // nada se mexe.
  const mesmo = (A, B) => A.length === B.length && A.every((it) => { const o = B.find((x) => x.k === it.k); return o && o.x === it.x && o.y === it.y && o.w === it.w && o.h === it.h; });
  function previa(forcar) {
    const a = ed.arrasto;
    const f = forcar ? a.fixo : fixoDe(a.alvo) || a.fixo;
    if (!forcar && f.x === a.fixo.x && f.y === a.fixo.y && f.w === a.fixo.w) return;
    a.fixo = f;
    const eu = a.L.find((it) => it.k === a.k);
    if (!forcar && f.w === eu.w && mesmo(montarCom(a.base, f), a.L)) return;
    const fazer = () => { a.L = aplicar(() => montarCom(a.base, f)); pintarVaga(a.L.find((it) => it.k === a.k)); };
    if (forcar) fazer(); else animar(fazer, a.c);
    seguir();
  }
  // O widget preso ao ponteiro, no mesmo ponto em que foi pego (dentro da largura da vaga atual, se ela encolheu).
  function seguir() {
    const a = ed.arrasto, m = metricas(), eu = a.L.find((it) => it.k === a.k);
    const w = eu.w * m.passo - VAO;
    a.c.style.translate = `${a.x - Math.min(a.dx, w - 24) - (m.left + eu.x * m.passo)}px ${a.y - a.dy - (m.top + eu.y * LINHA)}px`;
  }
  // Alvo pelo ponteiro, nas posições que estão na tela: sobre a própria vaga, fica; sobre outro item, antes (perto do
  // topo dele) ou depois (perto do fim; no meio de um item alto, fica como estava); fora de todos, livre.
  function posicionar() {
    const a = ed.arrasto, m = metricas();
    const c = limitar(Math.floor((a.x - m.left + VAO / 2) / m.passo), 0, cols - 1), rr = (a.y - m.top) / LINHA;
    const dentro = (it) => a.x >= m.left + it.x * m.passo - VAO / 2 && a.x < m.left + (it.x + it.w) * m.passo - VAO / 2 && rr >= it.y && rr < it.y + it.h;
    const eu = a.L.find((it) => it.k === a.k);
    if (!dentro(eu)) {
      const b = a.L.find((it) => it.k !== a.k && dentro(it));
      let alvo = a.alvo;
      if (b) {
        const topo = (rr - b.y) * LINHA, alt = b.h * LINHA - VAO, zona = Math.min(alt / 2, ZONA);
        if (topo < zona) alvo = { tipo: 'antes', k: b.k };
        else if (alt - topo < zona) alvo = { tipo: 'depois', k: b.k };
      } else alvo = { tipo: 'livre', c, r: Math.max(0, Math.floor(rr)) };
      if (alvo !== a.alvo) { a.alvo = alvo; previa(false); }
    }
    seguir();
  }
  // Perto da borda de cima ou de baixo da área que rola, ela rola sozinha (mais rápido quanto mais perto).
  function autoRolar(a) {
    const r = ed.rolador;
    const box = r === document.scrollingElement ? { top: 0, bottom: innerHeight } : r.getBoundingClientRect();
    const topo = Math.max(0, box.top), fim = Math.min(innerHeight, box.bottom);
    let v = 0;
    if (a.y < topo + BORDA) v = -Math.ceil(((topo + BORDA - a.y) / BORDA) * 14);
    else if (a.y > fim - BORDA) v = Math.ceil(((a.y - (fim - BORDA)) / BORDA) * 14);
    a.v = Math.max(-18, Math.min(18, v));
    if (a.v && !a.raf) a.raf = requestAnimationFrame(passo);
  }
  function passo() {
    const a = ed.arrasto || ed.redim;
    if (!a) return;
    a.raf = 0;
    if (!a.v) return;
    const antes = ed.rolador.scrollTop;
    ed.rolador.scrollTop += a.v;
    if (ed.rolador.scrollTop !== antes) { if (ed.arrasto) posicionar(); else redimensionar(false); }
    a.raf = requestAnimationFrame(passo);
  }
  function terminar() {
    grade.classList.remove('wd-movendo');
    document.documentElement.classList.remove('wd-arrastando', 'wd-redimensionando', 'wd-so-largura');
    vaga.hidden = true;
  }
  function soltar(ok) {
    const a = ed.arrasto;
    ed.arrasto = null;
    cancelAnimationFrame(a.raf);
    terminar();
    const c = a.c, r0 = c.getBoundingClientRect();
    c.classList.remove('wd-arrastado');
    c.style.translate = '';
    if (ok) { salvar(a.L); refazer(); } else animar(() => refazer(), c);
    // O widget sai de onde foi solto para a vaga.
    if (reduzido()) return;
    const r1 = c.getBoundingClientRect();
    c.animate([{ transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px)` }, { transform: 'none' }], { duration: 280, easing: CURVA }).id = 'wd-flip';
  }

  // ───────────────────────── redimensionar ─────────────────────────
  function iniciarRedim(alca, e) {
    const el = alca.parentElement, k = chave(el), eu = atual.find((it) => it.k === k);
    if (!eu) return;
    ed.rolador = rolador(el);
    // ox/oy: do ponteiro ao canto de baixo à direita do item (o ponto pego na alça fica sob o ponteiro).
    const m = metricas();
    const ox = m.left + (eu.x + eu.w) * m.passo - VAO - e.clientX, oy = m.top + (eu.y + eu.h) * LINHA - VAO - e.clientY;
    ed.redim = { el, k, id: e.pointerId, x: e.clientX, y: e.clientY, ox, oy, eu, base: assentar(atual.filter((it) => it.k !== k)), fixo: { ...eu }, v: 0, raf: 0 };
    try { alca.setPointerCapture(e.pointerId); } catch {}
    for (const an of el.getAnimations()) if (an.id === 'wd-flip') an.cancel();
    el.classList.add('wd-redim');
    grade.classList.add('wd-movendo');
    document.documentElement.classList.add('wd-redimensionando');
    if (k === 'lista') document.documentElement.classList.add('wd-so-largura');
  }
  // Largura em colunas e altura em linhas pelo ponteiro (encaixe na mais perto), entre o mínimo e o máximo. Abaixo do
  // conteúdo, a altura escolhida volta a ser "a do conteúdo" (0), e o widget cresce sozinho se o conteúdo crescer.
  function redimensionar(forcar) {
    const r = ed.redim, m = metricas(), eu = r.eu, s = SPEC[r.k];
    const w = limitar(Math.round((r.x + r.ox - (m.left + eu.x * m.passo) + VAO) / m.passo), minC(r.k, m), cols - eu.x);
    let a = 0;
    if (r.k !== 'lista') {
      a = Math.round((r.y + r.oy - (m.top + eu.y * LINHA)) / LINHA) * LINHA;
      a = limitar(a, s.minA || 0, s.maxA || Infinity);
    }
    const f = { k: r.k, x: eu.x, y: eu.y, w: Math.max(w, 1), a };
    if (!forcar && f.w === r.fixo.w && f.a === r.fixo.a) return;
    r.fixo = f;
    const fazer = () => {
      r.L = aplicar(() => montarCom(r.base, f));
      if (!s.livre && a && a <= (nat.get(r.k) || 0)) f.a = 0;
    };
    if (forcar) fazer(); else animar(fazer, r.el);
  }
  function fimRedim(ok) {
    const r = ed.redim;
    ed.redim = null;
    cancelAnimationFrame(r.raf);
    r.el.classList.remove('wd-redim');
    terminar();
    if (ok && r.L) {
      salvar(r.L.map((it) => (it.k === r.k ? { ...it, a: r.fixo.a } : it)));
      refazer();
    } else animar(() => refazer());
  }

  // ───────────────────────── eventos ─────────────────────────
  vista.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || ed.arrasto || ed.redim) return;
    const alca = ed.on && e.target.closest && e.target.closest('.wd-alca');
    if (alca && grade.contains(alca)) {
      e.preventDefault();
      e.stopPropagation();
      ed.engolir = true;
      iniciarRedim(alca, e);
      return;
    }
    const c = e.target.closest && e.target.closest('.graf[data-widget]');
    if (!c || !grade.contains(c)) return;
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
    if (!ed.redim) ed.engolir = false;
    if (!ed.on) return;
    const t = e.target;
    if (t.closest && (t.closest('.graf[data-widget]') || t.closest('.wd-barra') || t.closest('.wd-alca'))) return;
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
    if (a && e.pointerId === a.id) { a.x = e.clientX; a.y = e.clientY; posicionar(); autoRolar(a); }
    const r = ed.redim;
    if (r && e.pointerId === r.id) { r.x = e.clientX; r.y = e.clientY; redimensionar(false); autoRolar(r); }
  });
  const fim = (e) => {
    if (ed.segura && e.pointerId === ed.segura.id) cancelarSegura();
    if (ed.pega && e.pointerId === ed.pega.id) ed.pega = null;
    if (ed.arrasto && e.pointerId === ed.arrasto.id) { ed.engolir = true; soltar(e.type === 'pointerup'); }
    if (ed.redim && e.pointerId === ed.redim.id) { ed.engolir = true; fimRedim(e.type === 'pointerup'); }
  };
  addEventListener('pointerup', fim);
  addEventListener('pointercancel', fim);
  addEventListener('click', (e) => { if (ed.engolir) { ed.engolir = false; e.preventDefault(); e.stopPropagation(); } }, true);
  // Toque: o segurar não abre o menu do sistema, e o dedo que já segurou arrasta em vez de rolar a página.
  addEventListener('contextmenu', (e) => {
    if ((ed.segura || ed.on) && e.target.closest && e.target.closest('.graf[data-widget]')) e.preventDefault();
  }, true);
  addEventListener('touchmove', (e) => { if (ed.pega || ed.arrasto || ed.redim) e.preventDefault(); }, { passive: false });
  document.addEventListener('scroll', () => { if (ed.arrasto) posicionar(); else if (ed.redim) redimensionar(false); }, true);
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ed.on) return;
    e.preventDefault();
    e.stopPropagation();
    if (ed.arrasto) soltar(false); else if (ed.redim) fimRedim(false); else sair();
  }, true);
  // A Home saiu de vista (outra vista, aba escondida): sai do modo de edição.
  new ResizeObserver(() => { if (ed.on && !visivel(vista)) sair(); }).observe(vista);
  new MutationObserver(() => { if (ed.on && vista.hidden) sair(); }).observe(vista, { attributes: true, attributeFilter: ['hidden'] });

  // ───────────────────────── início ─────────────────────────
  // Refaz na hora (antes da pintura) quando a largura da grade ou o conteúdo de algum item muda. Os filhos que
  // crescem com o item (área do grafo, a cena) não são observados: mudam com o layout, não com o conteúdo.
  const ro = new ResizeObserver(() => refazer());
  ro.observe(regua);
  for (const el of EL.values()) for (const f of el.children) if (!f.classList.contains('wd-alca') && getComputedStyle(f).flexGrow === '0') ro.observe(f);
  refazer();
  window.OrbitGrade = { refazer, layout: () => atual.map((it) => ({ ...it })), colunas: () => cols };
})();
