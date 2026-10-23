// Vista do Grafo (contrato C1): canvas 2D com devicePixelRatio + física no Web Worker (grafo-worker.js).
// Código próprio, escrito a partir de "06 Referências/Graph View do Obsidian — especificação.md" §1, §3–§6.
//   GrafoVista.criar(elemento, {aoAbrir(id, {novaAba}), aoLocal(id), aoMenu(id, x, y)})
//     → {definirDados(dados, foco?), definirOpcoes(o), opcoes(), timelapse(), centralizar(), destruir()}
// Coordenadas internas em px CSS (o canvas é desenhado com escala devicePixelRatio): equivale à spec, que trabalha
// em px de dispositivo com pan e centro do zoom × devicePixelRatio.
/* global GrafoDados, GrafoFisica */
(function () {
  'use strict';

  const SCRIPT = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  const URL_WORKER = new URL('grafo-worker.js', SCRIPT || (typeof location !== 'undefined' ? location.href : 'http://x/')).href;

  // ── Constantes da spec ──
  const SUAVE = 0.9;              // curva única: novo = atual·0,9 + alvo·0,1
  const ZOOM_SUAVE = 0.85;
  const ESC_MIN = 1 / 128, ESC_MAX = 8;
  const POR_QUADRO = 50;          // carga progressiva
  const OCIOSOS = 60;             // quadros ociosos até o rAF dormir
  const APAGADO = 0.2;            // alpha dos não vizinhos com destaque
  const ROTULO_DESCE = 15;        // px de tela
  const LIMIAR_CLIQUE = 5;        // px
  const INERCIA_JANELA = 100;     // ms
  const QUADRO_MS = 1000 / 60;

  const PADROES = {
    busca: '', tags: false, anexos: false, soExistentes: false, orfaos: true, grupos: [],
    setas: false, fadeTexto: 0, tamanhoNo: 1, espessuraLink: 1,
    centro: 0.518713, repulsao: 10, link: 1, distancia: 250,
    local: { profundidade: 1, entrada: true, saida: true, vizinhos: true },
  };
  const CHAVES_FILTRO = ['busca', 'tags', 'anexos', 'soExistentes', 'orfaos', 'grupos', 'local', 'corPorPasta'];
  const CHAVES_FORCA = ['centro', 'repulsao', 'link', 'distancia'];
  const PAPEIS = { no: '--grafo-no', linha: '--grafo-linha', texto: '--grafo-texto', foco: '--grafo-foco',
    destaque: '--grafo-destaque', inexistente: '--grafo-inexistente', anexo: '--grafo-anexo', tag: '--grafo-tag',
    seta: '--grafo-seta', linkDestaque: '--grafo-link-destaque', halo: '--grafo-halo' };
  const CORES_PADRAO = { no: [179, 179, 179, 1], linha: [63, 63, 63, 1], texto: [218, 218, 218, 1],
    foco: [166, 138, 249, 1], destaque: [138, 92, 245, 1], inexistente: [102, 102, 102, 0.5], anexo: [168, 159, 145, 1],
    tag: [56, 208, 224, 1], seta: [218, 218, 218, 0.5], linkDestaque: [176, 160, 232, 0.65], halo: [0, 0, 0, 0] };

  const limitar = (v, a, b) => (v < a ? a : v > b ? b : v);
  const copiar = (o) => JSON.parse(JSON.stringify(o));
  const agora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function padroes() {
    const g = globalThis.GrafoDados;
    return copiar(g && typeof g.padroes === 'function' ? Object.assign({}, PADROES, g.padroes()) : PADROES);
  }

  // Converte qualquer cor CSS em [r,g,b,a] desenhando 1 px num canvas (aceita color-mix, hsl, var já resolvida…).
  let sonda = null;
  function corRGBA(txt, padrao) {
    if (!txt) return padrao.slice();
    try {
      if (!sonda) { const c = document.createElement('canvas'); c.width = c.height = 1; sonda = c.getContext('2d', { willReadFrequently: true }); }
      sonda.clearRect(0, 0, 1, 1);
      sonda.fillStyle = '#000'; sonda.fillStyle = txt;
      const confere = sonda.fillStyle;
      sonda.fillStyle = '#fff'; sonda.fillStyle = txt;
      if (sonda.fillStyle !== confere) return padrao.slice(); // cor inválida (fillStyle não mudou)
      sonda.fillRect(0, 0, 1, 1);
      const d = sonda.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch { return padrao.slice(); }
  }

  // Física fora do worker (plano B se Worker não puder ser criado, p. ex. file://): mesma interface de mensagens.
  function fisicaLocal(aoPos) {
    const sim = globalThis.GrafoFisica.criar();
    let relogio = null;
    const enviar = () => aoPos({ data: { tipo: 'pos', pos: sim.pos.slice(), alpha: sim.alpha } });
    let parada = false; // pausar(): o widget da Home fora da tela
    const passo = () => { relogio = null; if (parada || !sim.ativa()) return; sim.tick(); enviar(); agendar(); };
    const agendar = () => { if (relogio === null && !parada && sim.ativa()) relogio = setTimeout(passo, QUADRO_MS); };
    return {
      postMessage(m) {
        if (m.tipo === 'dados') { sim.definirDados(m); sim.aquecer(0.3); enviar(); }
        else if (m.tipo === 'forcas') { sim.definirForcas(m.forcas); sim.aquecer(0.3); }
        else if (m.tipo === 'fixar') { sim.fixar(m.i, m.x, m.y); sim.aquecer(0.3, 0.3); }
        else if (m.tipo === 'soltar') { sim.soltar(m.i); sim.aquecer(undefined, 0); }
        else if (m.tipo === 'aquecer') sim.aquecer(m.alpha, m.alvo);
        else if (m.tipo === 'pausar') { parada = true; clearTimeout(relogio); relogio = null; }
        else if (m.tipo === 'retomar') parada = false;
        agendar();
      },
      terminate() { clearTimeout(relogio); relogio = null; },
    };
  }

  function criar(elemento, cb) {
    cb = cb || {};
    elemento.classList.add('grafo-vista');
    const canvas = document.createElement('canvas');
    canvas.className = 'grafo-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Grafo de notas');
    elemento.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let opc = padroes();
    let bruto = { nos: [], links: [] };
    let foco = null;
    let grupoDest = null;               // chave de grupo realçada pela legenda (os outros caem para APAGADO)
    let destruido = false;
    let pausado = false;                // pausar(): física e desenho parados (widget fora da tela)

    // Câmera: tela = mundo·escala + pan (px CSS).
    let L = 0, A = 0, dpr = 1;
    let escala = 1, escalaAlvo = 1, panX = 0, panY = 0;
    let zoomCentro = null;              // {x, y} em px de tela
    let iniciouVista = false;

    // Grafo atual
    let nos = [];                       // objetos de nó (ver montar)
    let links = [];                     // {a, b, i (índice), duplo, alpha, mix}
    let porId = new Map();
    const memoria = new Map();          // id → estado visual (sobrevive a definirDados)
    const memLinks = new Map();         // origem+destino → estado visual do link
    let pendentes = 0;                  // nós ainda sem gráfico (carga progressiva)
    let temPos = false;
    let alphaFisica = 1;

    let cores = {};
    let fonte = 'system-ui, sans-serif';

    // Interação
    let mouse = null;                   // {x, y} dentro do canvas (null fora)
    let dRot = -1;                      // nó cujo rótulo está em hover (para detectar a troca)
    let hover = -1;                   // índice do nó sob o mouse
    let arraste = null;                 // {i, x0, y0, moveu, id}
    let pan = null;                     // {x, y, t, vx, vy}
    let inercia = null;                 // {vx, vy} px/ms
    const toques = new Map();           // pointerId → {x, y} (pinça)
    let pinca = null;                   // {d, mx, my}
    const teclas = new Set();
    let kvx = 0, kvy = 0;
    let tl = null;                      // timelapse

    // ── Worker ──
    let worker;
    const aoMensagem = (ev) => {
      const m = ev.data;
      if (!m || m.tipo !== 'pos' || destruido) return;
      alphaFisica = m.alpha;
      if (m.pos.length !== nos.length * 2) return; // resposta de um conjunto de dados anterior
      const p = m.pos;
      for (let i = 0; i < nos.length; i++) {
        const n = nos[i];
        if (arraste && arraste.i === i && arraste.fixo) continue;
        n.x = p[2 * i]; n.y = p[2 * i + 1]; n.temPos = true;
      }
      temPos = true;
      acordar();
    };
    try {
      worker = new Worker(URL_WORKER, { name: 'Grafo (física)' });
      worker.onmessage = aoMensagem;
      worker.onerror = (e) => {
        // sem worker (file:// ou bloqueado): física na página, se GrafoFisica estiver carregado
        if (globalThis.GrafoFisica && !destruido) { e.preventDefault && e.preventDefault(); trocarParaLocal(); }
      };
    } catch {
      worker = null;
    }
    function trocarParaLocal() {
      try { worker && worker.terminate(); } catch {}
      worker = fisicaLocal(aoMensagem);
      enviarForcas(); enviarDados();
    }
    if (!worker && globalThis.GrafoFisica) worker = fisicaLocal(aoMensagem);
    const postar = (m) => { if (worker) worker.postMessage(m); };
    const enviarForcas = () => postar({ tipo: 'forcas', forcas: { centro: opc.centro, repulsao: opc.repulsao, link: opc.link, distancia: opc.distancia } });
    const enviarDados = () => postar({ tipo: 'dados', nos: nos.map((n) => ({ id: n.id })), links: links.map((l) => ({ origem: nos[l.a].id, destino: nos[l.b].id })) });

    // ── Cores ──
    function lerCores() {
      const cs = getComputedStyle(elemento);
      corGrupo.clear();
      for (const k in PAPEIS) cores[k] = corRGBA(cs.getPropertyValue(PAPEIS[k]).trim(), CORES_PADRAO[k]);
      fonte = cs.getPropertyValue('--grafo-fonte').trim() || cs.fontFamily || fonte;
      for (const n of nos) n.linhas = null; // re-mede rótulos
      acordar();
    }
    const corGrupo = new Map();
    function corDoTexto(t) {
      if (!corGrupo.has(t)) {
        const v = /^var\((--[\w-]+)\)$/.exec(t); // cor de grupo automático: lê a variável CSS do hospedeiro
        corGrupo.set(t, corRGBA(v ? getComputedStyle(elemento).getPropertyValue(v[1]).trim() : t, CORES_PADRAO.no));
      }
      return corGrupo.get(t);
    }

    // ── Dados ──
    function filtrar() {
      const g = globalThis.GrafoDados;
      if (g && typeof g.filtrar === 'function') {
        try { return g.filtrar(bruto, opc) || bruto; } catch (e) { console.warn('GrafoDados.filtrar falhou', e); }
      }
      return bruto;
    }

    // vis: Set de ids permitidos (timelapse) ou null
    function montar(vis) {
      const f = filtrar();
      const novos = [];
      const mapa = new Map();
      for (const d of f.nos || []) {
        if (!d || d.id == null || mapa.has(d.id)) continue;
        if (vis && !vis.has(d.id)) continue;
        let n = memoria.get(d.id);
        if (!n) {
          n = { id: d.id, x: 0, y: 0, temPos: false, criado: false, alpha: 0, rgb: null, dy: 0, linhas: null };
          memoria.set(d.id, n);
        }
        n.nome = d.nome != null ? String(d.nome) : String(d.id);
        n.tipo = d.tipo || 'nota';
        n.cor = d.cor || null;
        n.grupo = d.grupo || null; n.grupoRotulo = d.grupoRotulo || null;
        n.salto = typeof d.salto === 'number' ? d.salto : null;
        n.peso = 0; n.viz = new Set(); n.linhas = null;
        mapa.set(d.id, novos.length);
        novos.push(n);
      }
      const vistos = new Map();
      const ls = [];
      for (const l of f.links || []) {
        const a = mapa.get(l.origem), b = mapa.get(l.destino);
        if (a === undefined || b === undefined || a === b) continue;
        novos[a].peso++; novos[b].peso++;
        novos[a].viz.add(b); novos[b].viz.add(a);
        const k1 = a + '>' + b, k2 = b + '>' + a;
        if (vistos.has(k2)) { ls[vistos.get(k2)].duplo = true; continue; } // dois sentidos: uma linha só
        if (vistos.has(k1)) continue;
        vistos.set(k1, ls.length);
        const chave = novos[a].id + '|' + novos[b].id;
        let l2 = memLinks.get(chave);
        if (!l2) { l2 = { alpha: 0, mix: 0 }; memLinks.set(chave, l2); } // links novos nascem com alpha 0
        if (!novos[a].criado || !novos[b].criado) { l2.alpha = 0; l2.mix = 0; }
        l2.a = a; l2.b = b; l2.duplo = false;
        ls.push(l2);
      }
      // peso por salto no grafo local: centro 30; salto k → 30 − (30/saltos)·k
      const saltos = novos.reduce((m, n) => (n.salto != null && n.salto > m ? n.salto : m), 0);
      for (const n of novos) if (n.salto != null) n.peso = saltos > 0 ? 30 - (30 / (saltos + 1)) * n.salto : 30;
      // nós que saíram perdem o gráfico (voltam a nascer com alpha 0)
      const ficam = new Set(novos);
      for (const n of nos) if (!ficam.has(n)) { n.criado = false; n.alpha = 0; n.rgb = null; }
      nos = novos; links = ls; porId = mapa;
      pendentes = nos.reduce((s, n) => s + (n.criado ? 0 : 1), 0);
      if (arraste) { const i = porId.get(arraste.id); if (i === undefined) arraste = null; else arraste.i = i; }
      hover = -1;
      enviarDados();
      acordar();
      if (cb.aoGrupos) cb.aoGrupos(listarGrupos());
    }
    function listarGrupos() {
      const m = new Map();
      for (const n of nos) if (n.grupo) (m.get(n.grupo) || m.set(n.grupo, { chave: n.grupo, rotulo: n.grupoRotulo || n.grupo, cor: n.cor, n: 0 }).get(n.grupo)).n++;
      return [...m.values()];
    }

    function tamanho(n) { return opc.tamanhoNo * limitar(3 * Math.sqrt(n.peso + 1), 8, 30); }

    function corAlvo(i, n) {
      if (i === destacado()) return cores.destaque;
      if (foco != null && n.id === foco) return cores.foco;
      if (n.cor) return corDoTexto(n.cor);
      if (n.tipo === 'tag') return cores.tag;
      if (n.tipo === 'inexistente') return cores.inexistente;
      if (n.tipo === 'anexo') return cores.anexo;
      return cores.no;
    }
    const destacado = () => (arraste ? arraste.i : hover);

    // ── Câmera ──
    const paraMundo = (sx, sy) => [(sx - panX) / escala, (sy - panY) / escala];
    function zoomEm(nova, cx, cy) {
      const wx = (cx - panX) / escala, wy = (cy - panY) / escala;
      escala = nova;
      panX = cx - wx * escala; panY = cy - wy * escala;
    }
    function medir() {
      const r = elemento.getBoundingClientRect();
      const nl = Math.max(1, Math.round(r.width)), na = Math.max(1, Math.round(r.height));
      const nd = window.devicePixelRatio || 1;
      if (!iniciouVista) { panX = nl / 2; panY = na / 2; iniciouVista = true; }
      else { panX += (nl - L) / 2; panY += (na - A) / 2; } // mantém o centro
      L = nl; A = na; dpr = nd;
      canvas.width = Math.round(L * dpr); canvas.height = Math.round(A * dpr);
      desenhar(agora());
      acordar();
    }

    // ── Laço de desenho ──
    let raf = 0, ociosos = 0, ultimoQuadro = 0;
    function acordar() { ociosos = 0; if (!raf && !destruido && !pausado) { ultimoQuadro = agora(); raf = requestAnimationFrame(quadro); } }
    function quadro(t) {
      raf = 0;
      if (destruido) return;
      const dt = limitar(t - ultimoQuadro, 1, 50);
      ultimoQuadro = t;
      let ativo = passoCamera(dt);
      if (passoTimelapse(t)) ativo = true;
      if (pendentes > 0) { carregar(); ativo = true; }
      verificarHover();
      if (desenhar(t)) ativo = true;
      if (alphaFisica > 0.001 && temPos) ativo = true;
      ociosos = ativo ? 0 : ociosos + 1;
      if (ociosos < OCIOSOS) raf = requestAnimationFrame(quadro);
    }

    function passoCamera(dt) {
      let ativo = false;
      // zoom suave
      if (escala !== escalaAlvo) {
        const c = zoomCentro || { x: L / 2, y: A / 2 };
        const razao = escala / escalaAlvo;
        zoomEm(Math.abs(razao - 1) < 0.01 ? escalaAlvo : escala * ZOOM_SUAVE + escalaAlvo * (1 - ZOOM_SUAVE), c.x, c.y);
        ativo = true;
      }
      // inércia do pan
      if (inercia) {
        panX += inercia.vx * dt; panY += inercia.vy * dt;
        inercia.vx *= 0.9; inercia.vy *= 0.9;
        if (Math.abs(inercia.vx) < 0.005 && Math.abs(inercia.vy) < 0.005) inercia = null;
        ativo = true;
      }
      // teclado
      if (teclas.size) {
        const sh = teclas.has('Shift') ? 3 : 1;
        const ax = (teclas.has('ArrowRight') ? 1 : 0) - (teclas.has('ArrowLeft') ? 1 : 0);
        const ay = (teclas.has('ArrowDown') ? 1 : 0) - (teclas.has('ArrowUp') ? 1 : 0);
        kvx = kvx * SUAVE + ax * sh * (1 - SUAVE); kvy = kvy * SUAVE + ay * sh * (1 - SUAVE);
        const z = (teclas.has('+') ? 1 : 0) - (teclas.has('-') ? 1 : 0);
        if (z) {
          const f = teclas.has('Shift') ? 1.1 : 1.03;
          const nova = limitar(escala * (z > 0 ? f : 1 / f), ESC_MIN, ESC_MAX);
          zoomEm(nova, L / 2, A / 2); escalaAlvo = nova; zoomCentro = null;
        }
        ativo = true;
      } else { kvx *= SUAVE; kvy *= SUAVE; }
      if (Math.abs(kvx) > 0.001 || Math.abs(kvy) > 0.001) {
        panX -= kvx * QUADRO_MS; panY -= kvy * QUADRO_MS; ativo = true;
      } else { kvx = kvy = 0; }
      return ativo;
    }

    // Carga progressiva: até 50 nós por quadro, os mais próximos do centro da vista primeiro.
    function carregar() {
      const [cx, cy] = paraMundo(L / 2, A / 2);
      const cand = [];
      for (const n of nos) if (!n.criado && n.temPos) cand.push(n);
      if (!cand.length) return;
      cand.sort((p, q) => ((p.x - cx) ** 2 + (p.y - cy) ** 2) - ((q.x - cx) ** 2 + (q.y - cy) ** 2));
      const k = Math.min(POR_QUADRO, cand.length);
      for (let j = 0; j < k; j++) { cand[j].criado = true; cand[j].alpha = 0; }
      pendentes -= k;
    }

    // Hover: entra no círculo (raio na tela = tam·√escala); sai quando o cursor passa de tam·nodeScale + 2 (mundo).
    function verificarHover() {
      if (arraste) return;
      const ns = 1 / Math.sqrt(escala);
      if (hover >= 0) {
        const n = nos[hover];
        if (!mouse || !n) { hover = -1; return; }
        const [wx, wy] = paraMundo(mouse.x, mouse.y);
        if (Math.hypot(wx - n.x, wy - n.y) > tamanho(n) * ns + 2) hover = -1; else return;
      }
      if (!mouse || mouse.toque) return;
      const i = noEm(mouse.x, mouse.y);
      if (i >= 0) hover = i;
      elemento.classList.toggle('sobre-no', hover >= 0);
    }
    function noEm(sx, sy) {
      const se = Math.sqrt(escala);
      let melhor = -1, md = Infinity;
      for (let i = 0; i < nos.length; i++) {
        const n = nos[i];
        if (!n.criado) continue;
        const dx = n.x * escala + panX - sx, dy = n.y * escala + panY - sy;
        const d2 = dx * dx + dy * dy, r = tamanho(n) * se;
        if (d2 <= r * r && d2 < md) { md = d2; melhor = i; }
      }
      return melhor;
    }

    function rgbaTxt(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
    const ani = (v, alvo, eps = 0.002) => { const n = v * SUAVE + alvo * (1 - SUAVE); return Math.abs(n - alvo) < eps ? alvo : n; };

    function quebrar(n, tamFonte) {
      ctx.font = tamFonte + 'px ' + fonte;
      const palavras = n.nome.split(/\s+/);
      const linhas = []; let atual = '';
      for (const p of palavras) {
        const t = atual ? atual + ' ' + p : p;
        if (atual && ctx.measureText(t).width > 300) { linhas.push(atual); atual = p; } else atual = t;
      }
      if (atual) linhas.push(atual);
      n.linhas = linhas; n.fonteBase = tamFonte;
    }

    // Desenha um quadro; devolve true se alguma animação ainda está em curso.
    function desenhar() {
      let anima = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const se = Math.sqrt(escala), ns = 1 / se;
      const d = destacado();
      const vizD = d >= 0 ? nos[d].viz : null;
      const alphaTexto = limitar(Math.log2(escala) + 1 - opc.fadeTexto, 0, 1);
      if (d !== dRot) { // troca do nó em hover: rótulo invisível aparece na hora já deslocado; ao sair, alpha volta na hora
        if (dRot >= 0 && nos[dRot]) nos[dRot].rotForca = false;
        if (d >= 0) {
          const nd = nos[d];
          nd.rotForca = alphaTexto * nd.alpha * cores.texto[3] <= 0.01;
          if (nd.rotForca) nd.dy = ROTULO_DESCE;
        }
        dRot = d;
      }
      // alvos de alpha e cor dos nós
      for (let i = 0; i < nos.length; i++) {
        const n = nos[i];
        if (!n.criado) continue;
        const alvoA = d >= 0 ? (i === d || vizD.has(i) ? 1 : APAGADO) : grupoDest == null || n.grupo === grupoDest ? 1 : APAGADO;
        const c = corAlvo(i, n);
        if (!n.rgb) n.rgb = c.slice();
        const na = ani(n.alpha, alvoA);
        if (na !== n.alpha) anima = true;
        n.alpha = na;
        for (let k = 0; k < 4; k++) { const v = ani(n.rgb[k], c[k], k < 3 ? 0.5 : 0.002); if (v !== n.rgb[k]) anima = true; n.rgb[k] = v; }
        const dy = ani(n.dy, i === d ? ROTULO_DESCE : 0, 0.05);
        if (dy !== n.dy) anima = true;
        n.dy = dy;
        n.tam = tamanho(n);
        n.sx = n.x * escala + panX; n.sy = n.y * escala + panY; n.sr = n.tam * se;
      }
      // links (fundo): os comuns (alpha 1, sem destaque) num caminho só; os demais um a um
      const lw = opc.espessuraLink;
      const cl = cores.linha, ch = cores.linkDestaque, cs = cores.seta;
      const setaA = opc.setas ? limitar(2 * (escala - 0.3), 0, 1) : 0;
      const setaS = 2 * Math.sqrt(lw);
      const avulsos = [], setas = [];
      ctx.lineCap = 'butt';
      ctx.lineWidth = lw;
      ctx.beginPath();
      let lote = false;
      for (const l of links) {
        const p = nos[l.a], q = nos[l.b];
        if (!p.criado || !q.criado) continue;
        const ligado = d >= 0 && (l.a === d || l.b === d);
        const am = ani(l.alpha, d >= 0 ? (ligado ? 1 : APAGADO) : grupoDest == null || (p.grupo === grupoDest && q.grupo === grupoDest) ? 1 : APAGADO), mm = ani(l.mix, ligado ? 1 : 0);
        if (am !== l.alpha || mm !== l.mix) anima = true;
        l.alpha = am; l.mix = mm;
        // corte: caixa dos dois extremos fora da vista
        if (Math.max(p.sx, q.sx) < 0 || Math.min(p.sx, q.sx) > L || Math.max(p.sy, q.sy) < 0 || Math.min(p.sy, q.sy) > A) continue;
        const dx = q.sx - p.sx, dy = q.sy - p.sy, dist = Math.hypot(dx, dy);
        if (dist <= p.sr + q.sr) continue;
        const ux = dx / dist, uy = dy / dist;
        const x0 = p.sx + ux * p.sr, y0 = p.sy + uy * p.sr, x1 = q.sx - ux * q.sr, y1 = q.sy - uy * q.sr;
        if (l.alpha >= 1 && l.mix === 0) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); lote = true; }
        else avulsos.push([x0, y0, x1, y1, l.alpha, l.mix]);
        if (setaA > 0) {
          setas.push([x1, y1, ux, uy, l.alpha, l.mix]);
          if (l.duplo) setas.push([x0, y0, -ux, -uy, l.alpha, l.mix]);
        }
      }
      if (lote) { ctx.strokeStyle = rgbaTxt(cl, cl[3]); ctx.stroke(); }
      for (const [x0, y0, x1, y1, a, m] of avulsos) {
        const c = [0, 1, 2, 3].map((k) => cl[k] + (ch[k] - cl[k]) * m);
        ctx.strokeStyle = rgbaTxt(c, c[3] * a);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      for (const [x, y, ux, uy, a, m] of setas) {
        const c = [0, 1, 2, 3].map((k) => cs[k] + (ch[k] - cs[k]) * m);
        seta(x, y, ux, uy, setaS, rgbaTxt(c, c[3] * a * setaA));
      }
      // círculos e anel
      for (let i = 0; i < nos.length; i++) {
        const n = nos[i];
        if (!n.criado) continue;
        if (n.sx + n.sr < 0 || n.sx - n.sr > L || n.sy + n.sr < 0 || n.sy - n.sr > A) continue;
        ctx.fillStyle = rgbaTxt(n.rgb, n.rgb[3] * n.alpha);
        ctx.beginPath(); ctx.arc(n.sx, n.sy, n.sr, 0, Math.PI * 2); ctx.fill();
        if (i === d) {
          const w = Math.max(1, 1 / escala / ns); // largura no espaço do nó
          ctx.lineWidth = w * ns * escala;
          ctx.strokeStyle = rgbaTxt(cores.foco, cores.foco[3]);
          ctx.beginPath(); ctx.arc(n.sx, n.sy, (n.tam + w / 2) * se, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // rótulos
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const ct = cores.texto;
      for (let i = 0; i < nos.length; i++) {
        const n = nos[i];
        if (!n.criado) continue;
        const nativo = i === d && escala < 1;
        const at = n.rotForca || nativo ? ct[3] : alphaTexto * n.alpha * ct[3]; // nó sob o mouse abaixo da escala 1: alpha cheio (spec)
        if (at <= 0.01) continue;
        const base = 14 + n.tam / 4;
        if (!n.linhas || n.fonteBase !== base) quebrar(n, base);
        const k = nativo ? 1 : se; // escala do texto na tela
        const topo = n.sy + (n.tam + 5) * se + n.dy;
        if (n.sx + 300 * k < 0 || n.sx - 300 * k > L || topo + 200 * k < 0 || topo > A) continue;
        const kp = k;
        ctx.font = (base * kp).toFixed(2) + 'px ' + fonte;
        const lh = base * 1.2 * kp, tx = Math.round(n.sx), ty = Math.round(topo);
        const halo = cores.halo[3] > 0; // contorno só se o tema pedir (--grafo-halo)
        if (halo) { ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = rgbaTxt(cores.halo, cores.halo[3] * at); }
        ctx.fillStyle = rgbaTxt(ct, at);
        for (let j = 0; j < n.linhas.length; j++) {
          if (halo) ctx.strokeText(n.linhas[j], tx, ty + Math.round(j * lh));
          ctx.fillText(n.linhas[j], tx, ty + Math.round(j * lh));
        }
      }
      return anima;
    }

    // Seta: triângulo entalhado com a ponta encostada na borda do alvo (ponta 0, cantos a 4, entalhe a 3).
    function seta(x, y, ux, uy, s, cor) {
      const px = -uy, py = ux;
      ctx.fillStyle = cor;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - ux * 4 * s + px * 2 * s, y - uy * 4 * s + py * 2 * s);
      ctx.lineTo(x - ux * 3 * s, y - uy * 3 * s);
      ctx.lineTo(x - ux * 4 * s - px * 2 * s, y - uy * 4 * s - py * 2 * s);
      ctx.closePath(); ctx.fill();
    }

    // ── Timelapse (§6): notas por min(criação, modificação), limite(0,5·√ligações, 5, 100) itens/s ──
    function iniciarTimelapse() {
      const f = filtrar();
      const data = (n) => {
        const v = [n.criado, n.modificado, n.ctime, n.mtime].map((x) => (typeof x === 'string' ? Date.parse(x) : x)).filter((x) => typeof x === 'number' && isFinite(x));
        return v.length ? Math.min(...v) : Infinity;
      };
      const ordem = (f.nos || []).map((n, i) => ({ id: n.id, t: data(n), i })).sort((p, q) => (p.t - q.t) || (p.i - q.i)).map((x) => x.id);
      const taxa = limitar(0.5 * Math.sqrt((f.links || []).length), 5, 100);
      for (const n of nos) { n.criado = false; n.alpha = 0; n.rgb = null; }
      memoria.clear(); memLinks.clear();
      tl = { ordem, taxa, inicio: agora(), mostrados: -1 };
      acordar();
    }
    function passoTimelapse(t) {
      if (!tl) return false;
      const k = Math.min(tl.ordem.length, Math.floor(((t - tl.inicio) / 1000) * tl.taxa) + 1);
      if (k !== tl.mostrados) {
        tl.mostrados = k;
        if (k >= tl.ordem.length) { tl = null; montar(null); return true; }
        montar(new Set(tl.ordem.slice(0, k)));
      }
      return true;
    }

    function centralizar() {
      const vis = nos.filter((n) => n.temPos);
      if (!vis.length) { escalaAlvo = 1; zoomCentro = null; panX = L / 2; panY = A / 2; escala = 1; acordar(); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of vis) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      panX = L / 2 - cx * escala; panY = A / 2 - cy * escala;
      escalaAlvo = limitar(Math.min(L / Math.max(1, x1 - x0 + 120), A / Math.max(1, y1 - y0 + 120)), ESC_MIN, ESC_MAX);
      zoomCentro = null; inercia = null;
      acordar();
    }

    // ── Eventos ──
    const posEvt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    function aoRoda(e) {
      e.preventDefault();
      const mult = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const dy = e.deltaY * mult;
      if (!dy) return;
      escalaAlvo = limitar(escalaAlvo * Math.pow(1.5, -dy / 120), ESC_MIN, ESC_MAX);
      zoomCentro = dy < 0 ? posEvt(e) : { x: L / 2, y: A / 2 }; // aproximar: no cursor; afastar: no centro
      inercia = null;
      acordar();
    }

    function aoBaixar(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      canvas.focus({ preventScroll: true });
      const p = posEvt(e);
      if (e.pointerType === 'touch') {
        toques.set(e.pointerId, p);
        if (toques.size === 2) {
          const [a, b] = [...toques.values()];
          pinca = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
          if (arraste) { postar({ tipo: 'soltar', i: arraste.i }); arraste = null; }
          pan = null;
          return;
        }
        if (toques.size > 2) return;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      inercia = null;
      mouse = { x: p.x, y: p.y, toque: e.pointerType === 'touch' };
      const i = noEm(p.x, p.y);
      if (i >= 0) {
        arraste = { i, id: nos[i].id, x0: p.x, y0: p.y, moveu: false, fixo: false, ctrl: e.ctrlKey || e.metaKey };
        hover = i;
      } else {
        pan = { x: p.x, y: p.y, t: agora(), vx: 0, vy: 0, ultimo: agora() };
        elemento.classList.add('arrastando');
      }
      acordar();
    }

    function aoMover(e) {
      const p = posEvt(e);
      if (e.pointerType === 'touch' && toques.has(e.pointerId)) {
        toques.set(e.pointerId, p);
        if (pinca && toques.size >= 2) {
          const [a, b] = [...toques.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const nova = limitar(escala * (d / pinca.d), ESC_MIN, ESC_MAX);
          zoomEm(nova, pinca.mx, pinca.my); escalaAlvo = nova; zoomCentro = null;
          panX += mx - pinca.mx; panY += my - pinca.my;
          pinca = { d, mx, my };
          acordar();
          return;
        }
      }
      mouse = { x: p.x, y: p.y, toque: e.pointerType === 'touch' };
      if (arraste) {
        if (!arraste.moveu && Math.hypot(p.x - arraste.x0, p.y - arraste.y0) > LIMIAR_CLIQUE) arraste.moveu = true;
        if (arraste.moveu) {
          const [wx, wy] = paraMundo(p.x, p.y);
          const n = nos[arraste.i];
          n.x = wx; n.y = wy; arraste.fixo = true;
          postar({ tipo: 'fixar', i: arraste.i, x: wx, y: wy });
        }
      } else if (pan) {
        const t = agora(), dt = Math.max(1, t - pan.ultimo);
        const dx = p.x - pan.x, dy = p.y - pan.y;
        panX += dx; panY += dy;
        pan.vx = pan.vx * 0.8 + (dx / dt) * 0.2; pan.vy = pan.vy * 0.8 + (dy / dt) * 0.2;
        pan.x = p.x; pan.y = p.y; pan.ultimo = t;
      }
      acordar();
    }

    function aoSoltar(e) {
      if (e.pointerType === 'touch') {
        toques.delete(e.pointerId);
        if (pinca) { if (toques.size < 2) pinca = null; return; }
      }
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      if (arraste) {
        const a = arraste;
        arraste = null;
        if (a.fixo) postar({ tipo: 'soltar', i: a.i });
        if (!a.moveu && e.type === 'pointerup' && cb.aoAbrir) {
          const n = nos[a.i];
          if (n) cb.aoAbrir(n.id, { novaAba: a.ctrl || e.ctrlKey || e.metaKey, tipo: n.tipo });
        }
      } else if (pan) {
        if (e.type === 'pointerup' && agora() - pan.ultimo < INERCIA_JANELA && (pan.vx || pan.vy)) inercia = { vx: pan.vx, vy: pan.vy };
        pan = null;
        elemento.classList.remove('arrastando');
      }
      if (e.pointerType === 'touch') mouse = null;
      acordar();
    }

    function aoSair() { if (!arraste && !pan) { mouse = null; hover = -1; elemento.classList.remove('sobre-no'); acordar(); } }

    function aoMenu(e) {
      e.preventDefault();
      const p = posEvt(e);
      const i = noEm(p.x, p.y);
      if (i >= 0 && cb.aoMenu) cb.aoMenu(nos[i].id, e.clientX, e.clientY);
    }

    const TECLAS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Shift']);
    function aoTecla(e) {
      let k = e.key;
      if (!TECLAS.has(k)) return;
      if (k === '=') k = '+'; if (k === '_') k = '-';
      if (e.type === 'keydown') { if (e.ctrlKey || e.metaKey || e.altKey) return; teclas.add(k); if (k !== 'Shift') e.preventDefault(); }
      else { teclas.delete(k); if (k === '+') teclas.delete('='); }
      if (!e.shiftKey) teclas.delete('Shift'); else teclas.add('Shift');
      acordar();
    }
    function aoDesfocar() { teclas.clear(); acordar(); }

    canvas.addEventListener('wheel', aoRoda, { passive: false });
    canvas.addEventListener('pointerdown', aoBaixar);
    canvas.addEventListener('pointermove', aoMover);
    canvas.addEventListener('pointerup', aoSoltar);
    canvas.addEventListener('pointercancel', aoSoltar);
    canvas.addEventListener('pointerleave', aoSair);
    canvas.addEventListener('contextmenu', aoMenu);
    canvas.addEventListener('keydown', aoTecla);
    canvas.addEventListener('keyup', aoTecla);
    canvas.addEventListener('blur', aoDesfocar);

    // tema: relê as cores quando a classe/estilo de html, body ou do elemento mudarem, ou o esquema do SO
    const obsTema = new MutationObserver(() => lerCores());
    for (const alvo of [document.documentElement, document.body, elemento]) {
      if (alvo) obsTema.observe(alvo, { attributes: true, attributeFilter: ['class', 'style', 'data-tema', 'data-theme'] });
    }
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', lerCores);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => medir()) : null;
    if (ro) ro.observe(elemento); else window.addEventListener('resize', medir);
    const aoDpr = () => medir();
    window.addEventListener('resize', aoDpr);

    lerCores();
    medir();
    enviarForcas();

    return {
      definirDados(dados, novoFoco) {
        bruto = { nos: (dados && dados.nos) || [], links: (dados && dados.links) || [] };
        if (novoFoco !== undefined) foco = novoFoco;
        tl = null;
        montar(null);
      },
      definirFoco(id) { foco = id == null ? null : id; acordar(); },
      // Widget da Home (21/10): fora da tela, para a física (worker) e o laço de desenho; retomar() continua de onde parou.
      pausar() { if (pausado) return; pausado = true; postar({ tipo: 'pausar' }); if (raf) cancelAnimationFrame(raf); raf = 0; },
      retomar() { if (!pausado) return; pausado = false; postar({ tipo: 'retomar' }); acordar(); },
      pausado() { return pausado; },
      definirOpcoes(o) {
        const ant = opc;
        opc = Object.assign(padroes(), copiar(ant), o ? copiar(o) : {});
        if (CHAVES_FORCA.some((k) => ant[k] !== opc[k])) enviarForcas();
        if (CHAVES_FILTRO.some((k) => JSON.stringify(ant[k]) !== JSON.stringify(opc[k]))) { corGrupo.clear(); montar(tl ? new Set(tl.ordem.slice(0, Math.max(0, tl.mostrados))) : null); }
        acordar();
      },
      opcoes() { return copiar(opc); },
      grupos: listarGrupos,
      destacarGrupo(chave) { grupoDest = chave == null ? null : chave; acordar(); },
      timelapse: iniciarTimelapse,
      centralizar,
      escala() { return escalaAlvo; },
      definirEscala(e, o) {
        if (!(e > 0)) return;
        escalaAlvo = limitar(e, ESC_MIN, ESC_MAX); zoomCentro = null;
        if ((o && o.animar === false) || Math.abs(escala / escalaAlvo - 1) < 0.01) zoomEm(escalaAlvo, L / 2, A / 2);
        acordar();
      },
      destruir() {
        destruido = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        try { worker && worker.terminate(); } catch {}
        worker = null;
        if (ro) ro.disconnect(); else window.removeEventListener('resize', medir);
        window.removeEventListener('resize', aoDpr);
        obsTema.disconnect();
        if (mq && mq.removeEventListener) mq.removeEventListener('change', lerCores);
        canvas.remove();
        elemento.classList.remove('grafo-vista', 'arrastando', 'sobre-no');
      },
      // Para testes/diagnóstico: estado e posição de tela (px CSS) de um nó.
      _estado() {
        return { escala, escalaAlvo, panX, panY, n: nos.length, links: links.length, criados: nos.filter((n) => n.criado).length,
          hover: hover >= 0 ? nos[hover].id : null, arraste: arraste ? arraste.id : null, alphaFisica, dormindo: !raf,
          inercia: !!inercia, timelapse: tl ? tl.mostrados : null };
      },
      _no(id) {
        const i = porId.get(id); if (i === undefined) return null;
        const n = nos[i];
        return { x: n.x, y: n.y, sx: n.x * escala + panX, sy: n.y * escala + panY, r: tamanho(n) * Math.sqrt(escala), alpha: n.alpha,
          rgb: n.rgb && n.rgb.map((v) => Math.round(v * 100) / 100), dy: n.dy, peso: n.peso, criado: n.criado, viz: [...n.viz].map((j) => nos[j].id) };
      },
    };
  }

  globalThis.GrafoVista = { criar, PADROES };
})();
