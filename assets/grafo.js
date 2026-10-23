/* Aba "Grafo" (controlador): barra de pasta/modo/nota, GrafoVista + GrafoPainel, prévia da nota, menu de contexto.
   index.html chama window.GrafoAba.entrar(elemento) ao mostrar a aba e sair() ao esconder.
   Dados: GET /grafo/dados?pasta= e /grafo/nota?pasta=&id= (grafo.mjs); pastas: GET /arquivos/pastas?caminho=.
   Persistência: localStorage "gi.grafo" = {pasta, modo, nota, recentes, opcoes:{[pastaAbsoluta]: opções}}. */
(function () {
  'use strict';
  const CHAVE = 'gi.grafo';
  const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };

  let est = lerEstado();
  let raiz = null, barra, txtPasta, txtCaminho, btnPasta, notaEl, btnGlobal, btnLocal, campoNota, listaNota, btnRecarregar, corpo, area, prev, aviso;
  let vista = null, painel = null, painelLocal = null, legenda = null;
  let dados = null;            // última resposta de /grafo/dados
  let assinatura = '';
  let carga = 0;
  let gravando = 0;
  let menuEl = null;

  function lerEstado() {
    let e = {};
    try { e = JSON.parse(localStorage.getItem(CHAVE) || '{}') || {}; } catch {}
    return { pasta: typeof e.pasta === 'string' ? e.pasta : '', modo: e.modo === 'local' ? 'local' : 'global', nota: typeof e.nota === 'string' ? e.nota : '',
      recentes: Array.isArray(e.recentes) ? e.recentes.filter((x) => typeof x === 'string').slice(0, 8) : [], opcoes: e.opcoes && typeof e.opcoes === 'object' ? e.opcoes : {},
      escalas: e.escalas && typeof e.escalas === 'object' ? e.escalas : {} };
  }
  // Escala alvo da vista, por pasta: conferida a cada 2 s na aba e ao sair; grava só se mudou.
  let relogioEscala = 0;
  function salvarEscala() {
    if (!vista || !dados || !vista.escala) return;
    const k = dados.pasta, e = vista.escala();
    if (!k || !(e > 0) || est.escalas[k] === e) return;
    est.escalas[k] = e; gravar();
  }
  function restaurarEscala() {
    const e = est.escalas[chavePasta()];
    if (vista && vista.definirEscala) vista.definirEscala(typeof e === 'number' && e > 0 ? e : 1);
  }
  function gravar() { try { localStorage.setItem(CHAVE, JSON.stringify(est)); } catch {} }
  function gravarDepois() { clearTimeout(gravando); gravando = setTimeout(gravar, 100); }

  function svgIcone(corpo, cls, tam) {
    const sp = document.createElement('span'); sp.className = 'gb-ico' + (cls ? ' ' + cls : ''); sp.setAttribute('aria-hidden', 'true');
    sp.innerHTML = '<svg width="' + (tam || 14) + '" height="' + (tam || 14) + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + corpo + '</svg>';
    return sp;
  }
  // nome da pasta em destaque + caminho do pai abreviado ("…\Orbit\brain"); o completo vai no title
  function mostrarPasta(p) {
    p = String(p || '');
    const partes = p.split(/[\\/]+/).filter(Boolean);
    const nome = partes.length ? partes[partes.length - 1] : (p || 'Escolher pasta');
    const sep = p.includes('\\') ? '\\' : '/';
    const pai = partes.slice(0, -1);
    txtPasta.textContent = nome;
    txtCaminho.textContent = pai.length ? (pai.length > 2 ? '…' + sep : '') + pai.slice(-2).join(sep) : '';
    btnPasta.title = p ? p + ' (clique para trocar de pasta)' : 'Escolher pasta';
    txtCaminho.title = p; txtPasta.title = p;
  }
  const chavePasta = () => (dados && dados.pasta) || est.pasta || '';
  function opcoesDaPasta() { return Object.assign(window.GrafoDados.padroes(), est.opcoes[chavePasta()] || {}); }

  // ───────── estilo (injetado uma vez; usa os tokens do Orbit) ─────────
  function estilo() {
    if (document.getElementById('gv-estilo')) return;
    const s = document.createElement('style');
    s.id = 'gv-estilo';
    s.textContent = `
.gv-vista { position: relative; height: 100%; min-height: 420px; display: flex; flex-direction: column; overflow: hidden; background: #1c1c1c; color: var(--t1); font-family: var(--sans); }
.gv-vista[hidden] { display: none; }
.gv-btn { font: inherit; font-size: 12px; color: var(--t1); background: var(--bloco); border: 1px solid var(--fio); border-radius: 7px; padding: 5px 10px; cursor: pointer; }
.gv-btn:hover { background: var(--cartao); }
.gv-btn:focus-visible, .gv-campo:focus-visible { outline: 2px solid var(--anel); outline-offset: 1px; }
.gv-campo { font: inherit; font-size: 12px; color: var(--t1); background: var(--bloco); border: 1px solid var(--fio); border-radius: 7px; padding: 5px 9px; width: 220px; }
.gv-lista { position: absolute; top: 100%; left: 0; z-index: 30; width: 320px; max-height: 260px; overflow: auto; background: var(--cartao); border: 1px solid var(--fio); border-radius: 8px; margin-top: 4px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
.gv-lista button { display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; color: var(--t1); background: transparent; border: 0; border-radius: 5px; padding: 5px 8px; cursor: pointer; }
.gv-lista button:hover, .gv-lista button:focus-visible { background: var(--bloco); outline: none; }
.gv-lista small { color: var(--t3); margin-left: 6px; }
.gv-corpo { position: relative; flex: 1; min-height: 0; display: flex; }
.gv-area { position: relative; flex: 1; min-width: 0; }
.gv-prev { width: 340px; flex: none; border-left: 1px solid var(--fio); background: var(--sup); display: flex; flex-direction: column; min-height: 0; }
.gv-prev[hidden] { display: none; }
.gv-prev header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--fio); font-size: 13px; }
.gv-prev header b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.gv-prev pre { margin: 0; padding: 12px; overflow: auto; flex: 1; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--t2); }
.gv-menu { position: fixed; z-index: 60; min-width: 190px; background: var(--cartao); border: 1px solid var(--fio); border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.gv-menu button { display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; color: var(--t1); background: transparent; border: 0; border-radius: 5px; padding: 6px 10px; cursor: pointer; }
.gv-menu button:hover, .gv-menu button:focus-visible { background: var(--bloco); outline: none; }
.gv-modal { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
.gv-dlg { width: min(560px, 92vw); max-height: 80vh; display: flex; flex-direction: column; gap: 8px; background: var(--cartao); border: 1px solid var(--fio); border-radius: 12px; padding: 14px; color: var(--t1); font-family: var(--sans); }
.gv-dlg h3 { margin: 0; font-size: 14px; }
.gv-dlg .gv-linha { display: flex; gap: 6px; }
.gv-dlg .gv-linha .gv-campo { flex: 1; width: auto; }
.gv-dlg .gv-pastas { overflow: auto; flex: 1; min-height: 120px; border: 1px solid var(--fio); border-radius: 8px; padding: 4px; }
.gv-dlg .gv-pastas button { display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; color: var(--t1); background: transparent; border: 0; border-radius: 5px; padding: 5px 8px; cursor: pointer; }
.gv-dlg .gv-pastas button:hover { background: var(--bloco); }
.gv-dlg .gv-rot { color: var(--t3); font-size: 11px; padding: 4px 8px; }
.gv-dlg .gv-rodape { display: flex; gap: 6px; justify-content: flex-end; }
`;
    document.head.appendChild(s);
  }

  // ───────── construção ─────────
  function montarDom(host) {
    raiz = host;
    raiz.replaceChildren();
    barra = el('div', 'gv-barra');
    barra.setAttribute('role', 'toolbar'); barra.setAttribute('aria-label', 'Barra do grafo');
    // fonte: seletor "pasta + chevron" com o caminho abreviado ao lado (completo no title)
    const fonte = el('div', 'gb-fonte');
    btnPasta = el('button', 'btn p gb-pasta-btn'); btnPasta.type = 'button';
    btnPasta.setAttribute('aria-label', 'Escolher pasta'); btnPasta.title = 'Escolher pasta';
    txtPasta = el('span', 'gv-pasta', 'Escolher pasta');
    btnPasta.append(svgIcone('<path d="M1.75 4.5a1 1 0 0 1 1-1h3l1.4 1.5h5.1a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z"/>'), txtPasta, svgIcone('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>', 'gb-seta'));
    btnPasta.addEventListener('click', escolherPasta);
    txtCaminho = el('span', 'gb-caminho');
    fonte.append(btnPasta, txtCaminho);
    const seg = el('div', 'seg gv-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Modo do grafo');
    btnGlobal = el('button', null, 'Global'); btnLocal = el('button', null, 'Local');
    btnGlobal.type = btnLocal.type = 'button';
    btnGlobal.addEventListener('click', () => trocarModo('global'));
    btnLocal.addEventListener('click', () => trocarModo('local'));
    seg.append(btnGlobal, btnLocal);
    const nota = el('div', 'gv-nota'); notaEl = nota; nota.hidden = true;
    campoNota = el('input', 'gv-campo'); campoNota.type = 'text'; campoNota.placeholder = 'Buscar nota…'; campoNota.setAttribute('aria-label', 'Nota do grafo local');
    listaNota = el('div', 'gv-lista'); listaNota.hidden = true;
    campoNota.addEventListener('input', () => listarNotas(campoNota.value));
    campoNota.addEventListener('focus', () => { campoNota.select(); listarNotas(''); });
    campoNota.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { listaNota.hidden = true; campoNota.blur(); }
      if (e.key === 'Enter') { const b = listaNota.querySelector('button'); if (b) b.click(); }
    });
    campoNota.addEventListener('blur', () => setTimeout(() => { listaNota.hidden = true; campoNota.value = est.nota ? nomeDe(est.nota) : ''; }, 150));
    nota.append(campoNota, listaNota);
    const dir = el('div', 'gb-dir');
    aviso = el('span', 'gv-aviso'); aviso.setAttribute('role', 'status');
    btnRecarregar = el('button', 'btn-icone gb-recarregar'); btnRecarregar.type = 'button';
    btnRecarregar.title = 'Recarregar'; btnRecarregar.setAttribute('aria-label', 'Recarregar');
    btnRecarregar.append(svgIcone('<path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v2.4h-2.4"/>', null, 16));
    btnRecarregar.addEventListener('click', () => carregar(false));
    dir.append(aviso, btnRecarregar);
    barra.append(fonte, seg, nota, dir);
    corpo = el('div', 'gv-corpo');
    area = el('div', 'gv-area');
    prev = el('aside', 'gv-prev'); prev.hidden = true;
    corpo.append(area, prev);
    raiz.append(barra, corpo);
    const G = window.GrafoVista;
    vista = G.criar(area, {
      aoAbrir: (id) => abrirNota(id),
      aoLocal: (id) => irLocal(id),
      aoMenu: (id, x, y) => menu(id, x, y),
      aoGrupos: (g) => { if (legenda) legenda.atualizar(g); },
    });
    if (window.GrafoLegenda) legenda = window.GrafoLegenda.criar(area, { aoDestacar: (c) => vista.destacarGrupo(c) });
    montarPainel();
    document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) fecharMenu(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharMenu(); });
  }

  function montarPainel() {
    if (painel) { try { painel.destruir(); } catch {} painel = null; }
    painel = window.GrafoPainel.criar(area, opcoesDaPasta(), {
      aoMudar: (o, chave) => {
        const ant = est.opcoes[chavePasta()] || {};
        est.opcoes[chavePasta()] = o;
        vista.definirOpcoes(o);
        if (est.modo === 'local' && JSON.stringify(ant.local) !== JSON.stringify(o.local)) aplicar();
        gravarDepois();
      },
      aoRestaurar: () => {
        const o = window.GrafoDados.padroes();
        est.opcoes[chavePasta()] = o;
        vista.definirOpcoes(o);
        painel.definir(o);
        if (est.modo === 'local') aplicar();
        gravarDepois();
      },
      aoTimelapse: () => vista.timelapse(),
    }, { local: est.modo === 'local' });
  }

  // ───────── dados ─────────
  async function carregar(silencioso) {
    const n = ++carga;
    aviso.textContent = silencioso ? aviso.textContent : 'Carregando…';
    let r;
    try {
      const q = est.pasta ? '?pasta=' + encodeURIComponent(est.pasta) : '';
      const resp = await fetch('/grafo/dados' + q, { cache: 'no-store' });
      r = await resp.json();
      if (!resp.ok) throw new Error(r.erro || 'erro ' + resp.status);
    } catch (e) {
      if (n !== carga) return;
      aviso.textContent = 'Não carregou: ' + (e.message || e);
      if (est.pasta) mostrarPasta(est.pasta);
      return;
    }
    if (n !== carga) return;
    const sigNova = (r.nos || []).map((x) => x.id + '|' + x.tipo).join('\n') + '\n#\n' + (r.links || []).map((l) => l.origem + '>' + l.destino).join('\n');
    const mudouPasta = !dados || dados.pasta !== r.pasta;
    dados = r;
    mostrarPasta(r.pasta);
    aviso.textContent = r.nos.filter((n) => n.tipo === 'nota').length + (r.nos.filter((n) => n.tipo === 'nota').length === 1 ? ' nota · ' : ' notas · ') + (r.links || []).length + ((r.links || []).length === 1 ? ' link' : ' links') + (r.truncado ? ' (truncado)' : '');
    if (silencioso && !mudouPasta && sigNova === assinatura) return; // nada mudou
    assinatura = sigNova;
    if (mudouPasta) { const o = opcoesDaPasta(); vista.definirOpcoes(o); painel.definir(o); restaurarEscala(); }
    aplicar();
  }

  function notasDe() { return dados ? dados.nos.filter((n) => n.tipo === 'nota') : []; }
  function nomeDe(id) { const n = dados && dados.nos.find((x) => x.id === id); return (n && n.nome) || String(id).replace(/^.*\//, '').replace(/\.md$/i, ''); }

  function aplicar() {
    if (!dados) return;
    atualizarBarra();
    if (est.modo === 'local') {
      const existe = est.nota && dados.nos.some((n) => n.id === est.nota);
      if (!existe) { vista.definirDados({ nos: [], links: [] }); aviso.textContent = 'Escolha uma nota para o grafo local'; return; }
      const sub = window.GrafoDados.local(dados, est.nota, opcoesDaPasta().local);
      vista.definirDados(sub, est.nota);
    } else {
      vista.definirDados(dados, null);
    }
  }

  function atualizarBarra() {
    const loc = est.modo === 'local';
    btnGlobal.setAttribute('aria-pressed', String(!loc));
    btnLocal.setAttribute('aria-pressed', String(loc));
    campoNota.disabled = !loc; notaEl.hidden = !loc;
    if (listaNota.hidden) campoNota.value = est.nota ? nomeDe(est.nota) : '';
  }

  function trocarModo(m) {
    if (est.modo === m) return;
    est.modo = m;
    gravar();
    montarPainel();
    aplicar();
    if (m === 'local' && !est.nota) campoNota.focus();
  }
  function irLocal(id) {
    est.nota = id; est.modo = 'local'; gravar();
    montarPainel();
    aplicar();
  }

  function listarNotas(termo) {
    const t = termo.trim().toLowerCase();
    const achadas = notasDe().filter((n) => !t || n.id.toLowerCase().includes(t) || (n.nome || '').toLowerCase().includes(t)).slice(0, 40);
    listaNota.replaceChildren();
    for (const n of achadas) {
      const b = el('button', null, n.nome || nomeDe(n.id)); b.type = 'button';
      const pasta = n.id.includes('/') ? n.id.replace(/\/[^/]*$/, '') : '';
      if (pasta) b.append(el('small', null, pasta));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { listaNota.hidden = true; irLocal(n.id); campoNota.blur(); });
      listaNota.appendChild(b);
    }
    if (!achadas.length) listaNota.appendChild(el('div', 'gv-rot', 'Nenhuma nota encontrada'));
    listaNota.hidden = false;
  }

  // ───────── abrir nota (prévia lateral) ─────────
  async function abrirNota(id) {
    const no = dados && dados.nos.find((n) => n.id === id);
    if (!no || no.tipo === 'inexistente') { aviso.textContent = 'A nota "' + id + '" ainda não existe'; return; }
    prev.hidden = false;
    prev.replaceChildren();
    const cab = el('header');
    const tit = el('b', null, no.nome || nomeDe(id)); tit.title = id;
    const fechar = el('button', 'gv-btn', 'Fechar'); fechar.type = 'button';
    fechar.addEventListener('click', () => { prev.hidden = true; });
    cab.append(tit, fechar);
    const pre = el('pre', null, 'Carregando…');
    prev.append(cab, pre);
    if (!/\.(md|markdown|txt)$/i.test(id)) { pre.textContent = 'Sem prévia para este tipo de arquivo.\n' + id; return; }
    try {
      const resp = await fetch('/grafo/nota?pasta=' + encodeURIComponent(dados.pasta) + '&id=' + encodeURIComponent(id), { cache: 'no-store' });
      const r = await resp.json();
      if (!resp.ok) throw new Error(r.erro || 'erro');
      pre.textContent = r.texto;
    } catch (e) { pre.textContent = 'Não foi possível ler a nota: ' + (e.message || e); }
  }

  // ───────── menu de contexto ─────────
  function fecharMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function caminhoAbsoluto(id) {
    const base = dados.pasta, sep = base.includes('\\') ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + sep + id.split('/').join(sep);
  }
  function copiar(texto) {
    const f = () => { const t = document.createElement('textarea'); t.value = texto; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).catch(f); else f();
    aviso.textContent = 'Caminho copiado';
  }
  function menu(id, x, y) {
    fecharMenu();
    const itens = [['Abrir', () => abrirNota(id)], ['Grafo local desta nota', () => irLocal(id)], ['Copiar caminho', () => copiar(caminhoAbsoluto(id))]];
    menuEl = el('div', 'gv-menu'); menuEl.setAttribute('role', 'menu');
    for (const [rot, fn] of itens) {
      const b = el('button', null, rot); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => { fecharMenu(); fn(); });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
  }

  // ───────── seletor de pasta ─────────
  async function listarPastas(caminho) {
    const r = await fetch('/arquivos/pastas' + (caminho ? '?caminho=' + encodeURIComponent(caminho) : ''), { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.erro || 'erro ' + r.status);
    return j;
  }
  function escolherPasta() {
    const fundo = el('div', 'gv-modal');
    const dlg = el('div', 'gv-dlg'); dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-label', 'Escolher pasta do grafo');
    const campo = el('input', 'gv-campo'); campo.type = 'text'; campo.placeholder = 'Caminho completo da pasta'; campo.setAttribute('aria-label', 'Caminho da pasta');
    const ir = el('button', 'gv-btn', 'Ir'); ir.type = 'button';
    const subir = el('button', 'gv-btn', 'Subir'); subir.type = 'button';
    const linha = el('div', 'gv-linha'); linha.append(campo, ir, subir);
    const lista = el('div', 'gv-pastas');
    const msg = el('div', 'gv-rot');
    const usar = el('button', 'gv-btn', 'Usar esta pasta'); usar.type = 'button';
    const cofre = el('button', 'gv-btn', 'Cofre padrão'); cofre.type = 'button';
    const cancelar = el('button', 'gv-btn', 'Cancelar'); cancelar.type = 'button';
    const rodape = el('div', 'gv-rodape'); rodape.append(cofre, cancelar, usar);
    dlg.append(el('h3', null, 'Escolher pasta do grafo'), linha, msg, lista, rodape);
    fundo.appendChild(dlg);
    let atual = '', pai = null;
    const item = (rot, caminho) => { const b = el('button', null, rot); b.type = 'button'; b.title = caminho; b.addEventListener('click', () => ir_(caminho)); return b; };
    async function ir_(caminho) {
      msg.textContent = '';
      try {
        const j = await listarPastas(caminho);
        atual = j.caminho || ''; pai = j.pai || null; campo.value = atual;
        lista.replaceChildren();
        if (!atual) {
          if (est.recentes.length) { lista.appendChild(el('div', 'gv-rot', 'Recentes')); for (const c of est.recentes) lista.appendChild(item(c, c)); }
          lista.appendChild(el('div', 'gv-rot', 'Atalhos e unidades'));
          for (const a of [...(j.atalhos || []), ...(j.unidades || [])]) lista.appendChild(item(a.nome, a.caminho));
        } else {
          for (const p of j.pastas) lista.appendChild(item(p.nome, p.caminho));
          if (!j.pastas.length) lista.appendChild(el('div', 'gv-rot', 'Sem subpastas'));
        }
      } catch (e) { msg.textContent = e.message || String(e); }
    }
    const fechar = () => { fundo.remove(); document.removeEventListener('keydown', tecla, true); };
    const tecla = (e) => { if (e.key === 'Escape') { e.stopPropagation(); fechar(); } };
    document.addEventListener('keydown', tecla, true);
    ir.addEventListener('click', () => ir_(campo.value.trim()));
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') ir_(campo.value.trim()); });
    subir.addEventListener('click', () => ir_(pai || ''));
    cancelar.addEventListener('click', fechar);
    fundo.addEventListener('pointerdown', (e) => { if (e.target === fundo) fechar(); });
    usar.addEventListener('click', () => { const c = campo.value.trim(); if (c) { fechar(); trocarPasta(c); } });
    cofre.addEventListener('click', () => { fechar(); trocarPasta(''); });
    document.body.appendChild(fundo);
    campo.focus();
    ir_(est.pasta || '');
  }
  async function trocarPasta(c) {
    salvarEscala();
    est.pasta = c;
    est.nota = '';
    gravar();
    await carregar(false);
    if (c && dados && dados.pasta) { est.recentes = [dados.pasta, ...est.recentes.filter((x) => x !== dados.pasta)].slice(0, 8); gravar(); }
  }

  // ───────── ciclo de vida ─────────
  function entrar(host) {
    if (!host) return;
    estilo();
    host.classList.add('gv-vista');
    if (!window.GrafoVista || !window.GrafoPainel || !window.GrafoDados) { host.textContent = 'Módulos do grafo não carregaram'; return; }
    if (raiz !== host) { if (vista) { try { vista.destruir(); } catch {} } dados = null; assinatura = ''; montarDom(host); }
    carregar(!!dados);
    clearInterval(relogioEscala); relogioEscala = setInterval(salvarEscala, 2000);
  }
  function sair() { fecharMenu(); salvarEscala(); clearInterval(relogioEscala); relogioEscala = 0; }

  // Widget "Grafo do projeto" da Home (assets/grafo-widget.js, 21/10): a aba abre já na pasta do brain do projeto.
  // Chamado antes de mostrar a aba; o entrar() carrega a pasta nova. Com a aba já montada e à vista, recarrega aqui.
  function definirPasta(c) {
    c = String(c || '');
    if (c === est.pasta) return;
    salvarEscala();
    est.pasta = c; est.nota = ''; est.modo = 'global';
    if (c) est.recentes = [c, ...est.recentes.filter((x) => x !== c)].slice(0, 8);
    gravar();
    if (raiz && raiz.isConnected && raiz.getClientRects().length) { montarPainel(); carregar(false); }
  }

  window.GrafoAba = { entrar, sair, definirPasta, _estado: () => ({ est, dados, vista }) };
})();
