// Orbit — Whiteboard: edicao (etapa 3). Registra-se em window.Whiteboard (ver o topo de whiteboard.js).
// Ações sobre a seleção atual: agrupar/desagrupar, duplicar, apagar, copiar/colar, alinhar/distribuir, camadas,
// selecionarTudo. Cada uma que muda o quadro termina em nucleo.confirmar(rotulo) (copiar e selecionarTudo não mudam nada).
// Atalhos: listener próprio em keydown (captura, registrado depois do núcleo, que consome o que é dele).
(() => {
  'use strict';
  if (!window.Whiteboard || !window.Whiteboard.nucleo) return;
  const WB = window.Whiteboard;
  const N = window.Whiteboard.nucleo;
  const MARCA = 'orbit-whiteboard';
  const PASSO = 16;

  let interna = null;      // { elementos, quando }
  let ptr = null;          // último ponto do ponteiro no mundo (dentro da vista)
  let nColar = 0;          // colagens seguidas no mesmo ponto
  const novoId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const novoGrupo = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const selecionados = () => { const s = new Set(N.selecao()); return N.elementos().filter((e) => s.has(e.id) && !N.travado(e)); }; // travados ficam de fora de agrupar/alinhar/distribuir/camada (copiar e duplicar usam naSelecao: a cópia sai destravada)
  const naSelecao = () => { const s = new Set(N.selecao()); return N.elementos().filter((e) => s.has(e.id)); };
  const selecaoBruta = () => { const s = new Set(N.selecao()); return N.elementos().filter((e) => s.has(e.id)); };
  const reconciliar = (ids) => { try { if (ids && ids.length && WB.setas && typeof WB.setas.reconciliar === 'function') WB.setas.reconciliar(ids); } catch (e) { console.warn('whiteboard-edicao: reconciliar', e); } };
  const limpo = (el) => JSON.parse(JSON.stringify(el, (k, v) => (k.startsWith('_') ? undefined : v)));

  // Clona a lista (já ordenada por z) com ids/grupos novos e deslocamento; adiciona ao quadro e seleciona.
  function inserir(lista, dx, dy) {
    const ids = new Map(lista.map((e) => [e.id, novoId()]));
    const grupos = new Map();
    const temSetas = !!(WB.setas && typeof WB.setas.reconciliar === 'function');
    const novos = [];
    for (const orig of lista) {
      const e = limpo(orig);
      e.id = ids.get(orig.id);
      delete e.z; delete e.travado;
      e.x = (e.x || 0) + dx; e.y = (e.y || 0) + dy;
      if (e.grupo) { if (!grupos.has(e.grupo)) grupos.set(e.grupo, novoGrupo()); e.grupo = grupos.get(e.grupo); }
      if (Array.isArray(e.ligacoes)) e.ligacoes = null; // formas presas: a lista de setas é refeita pelas setas
      else if (e.ligacoes && typeof e.ligacoes === 'object') {
        for (const lado of ['inicio', 'fim']) {
          const l = e.ligacoes[lado];
          if (!l) continue;
          if (ids.has(l.id)) l.id = ids.get(l.id);
          else if (!temSetas) e.ligacoes[lado] = null;
        }
      }
      novos.push(N.adicionar(e).id);
    }
    reconciliar(novos);
    N.selecionar(novos);
    return novos;
  }

  function agrupar() {
    const sel = selecionados();
    if (sel.length < 2) return false;
    const g = novoGrupo();
    for (const e of sel) N.atualizar(e.id, { grupo: g });
    N.confirmar('agrupar');
    return true;
  }
  function desagrupar() {
    const sel = selecionados().filter((e) => e.grupo);
    if (!sel.length) return false;
    for (const e of sel) N.atualizar(e.id, { grupo: null });
    N.confirmar('desagrupar');
    return true;
  }
  function duplicar() {
    const sel = naSelecao();
    if (!sel.length) return [];
    const novos = inserir(sel, PASSO, PASSO);
    N.confirmar('duplicar');
    return novos;
  }
  function apagar() {
    const ids = N.selecao().filter((id) => !N.travado(N.elemento(id)));
    if (!ids.length) return false;
    N.remover(ids);
    reconciliar(ids);
    N.confirmar('excluir');
    return true;
  }
  function copiar() {
    const sel = naSelecao();
    if (!sel.length) return false;
    interna = { elementos: sel.map(limpo), quando: Date.now() };
    nColar = 0;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(JSON.stringify({ orbit: MARCA, versao: 1, elementos: interna.elementos })).catch(() => {});
      }
    } catch {}
    return true;
  }
  async function lerClipboard() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) return null;
      const txt = await Promise.race([navigator.clipboard.readText(), new Promise((r) => setTimeout(() => r(null), 400))]);
      if (!txt || txt[0] !== '{') return null;
      const o = JSON.parse(txt);
      return o && o.orbit === MARCA && Array.isArray(o.elementos) && o.elementos.length ? o.elementos : null;
    } catch { return null; }
  }
  function colar() {
    if (interna) return colarLista(interna.elementos);
    return lerClipboard().then((l) => (l ? colarLista(l) : []));
  }
  function colarLista(itens) {
    if (!itens || !itens.length) return [];
    const lista = itens.map(limpo).sort((a, b) => (a.z || 0) - (b.z || 0));
    let dx = PASSO * (nColar + 1), dy = PASSO * (nColar + 1);
    if (ptr) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const e of lista) { const c = N.util.caixaNormal(e); x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); }
      dx = ptr.x - (x0 + x1) / 2 + PASSO * nColar; dy = ptr.y - (y0 + y1) / 2 + PASSO * nColar;
    }
    nColar++;
    const novos = inserir(lista, dx, dy);
    N.confirmar('colar');
    return novos;
  }

  function alinhar(lado) {
    const sel = selecionados();
    if (sel.length < 2) return false;
    const cx = sel.map((e) => ({ e, c: N.caixaMundo(e) }));
    const x0 = Math.min(...cx.map((o) => o.c.x)), x1 = Math.max(...cx.map((o) => o.c.x + o.c.w));
    const y0 = Math.min(...cx.map((o) => o.c.y)), y1 = Math.max(...cx.map((o) => o.c.y + o.c.h));
    for (const { e, c } of cx) {
      let dx = 0, dy = 0;
      if (lado === 'esquerda') dx = x0 - c.x;
      else if (lado === 'direita') dx = x1 - (c.x + c.w);
      else if (lado === 'centroH') dx = (x0 + x1) / 2 - (c.x + c.w / 2);
      else if (lado === 'topo') dy = y0 - c.y;
      else if (lado === 'base') dy = y1 - (c.y + c.h);
      else if (lado === 'centroV') dy = (y0 + y1) / 2 - (c.y + c.h / 2);
      else return false;
      if (dx || dy) N.atualizar(e.id, { x: e.x + dx, y: e.y + dy });
    }
    N.confirmar('alinhar');
    return true;
  }
  function distribuir(eixo) {
    const sel = selecionados();
    if (sel.length < 3 || (eixo !== 'h' && eixo !== 'v')) return false;
    const h = eixo === 'h';
    const cx = sel.map((e) => ({ e, c: N.caixaMundo(e) })).sort((a, b) => (h ? a.c.x - b.c.x : a.c.y - b.c.y));
    const ini = h ? cx[0].c.x : cx[0].c.y;
    const ult = cx[cx.length - 1].c, fim = h ? ult.x + ult.w : ult.y + ult.h;
    const soma = cx.reduce((s, o) => s + (h ? o.c.w : o.c.h), 0);
    const vao = (fim - ini - soma) / (cx.length - 1);
    let pos = ini;
    for (const { e, c } of cx) {
      const d = pos - (h ? c.x : c.y);
      if (d) N.atualizar(e.id, h ? { x: e.x + d } : { y: e.y + d });
      pos += (h ? c.w : c.h) + vao;
    }
    N.confirmar('distribuir');
    return true;
  }

  function camada(modo) {
    const sel = new Set(N.selecao().filter((id) => !N.travado(N.elemento(id)))); // travado não muda de camada
    if (!sel.size) return false;
    const ordem = N.elementos().map((e) => e.id); // já por z
    let nova;
    if (modo === 'frente') nova = [...ordem.filter((i) => !sel.has(i)), ...ordem.filter((i) => sel.has(i))];
    else if (modo === 'trás' || modo === 'tras') nova = [...ordem.filter((i) => sel.has(i)), ...ordem.filter((i) => !sel.has(i))];
    else if (modo === 'subir') {
      nova = ordem.slice();
      for (let i = nova.length - 2; i >= 0; i--) if (sel.has(nova[i]) && !sel.has(nova[i + 1])) [nova[i], nova[i + 1]] = [nova[i + 1], nova[i]];
    } else if (modo === 'descer') {
      nova = ordem.slice();
      for (let i = 1; i < nova.length; i++) if (sel.has(nova[i]) && !sel.has(nova[i - 1])) [nova[i], nova[i - 1]] = [nova[i - 1], nova[i]];
    } else return false;
    if (nova.every((id, i) => id === ordem[i])) return false;
    nova.forEach((id, i) => { const e = N.elemento(id); if (e && e.z !== i + 1) N.atualizar(id, { z: i + 1 }); });
    N.confirmar('camada');
    return true;
  }
  function selecionarTudo() { N.selecionar(N.elementos().filter((e) => !N.travado(e)).map((e) => e.id)); }
  // Trava: o grupo inteiro de qualquer elemento selecionado entra junto.
  function comGrupo(lista) {
    const gs = new Set(lista.map((e) => e.grupo).filter(Boolean)), ids = new Set(lista.map((e) => e.id));
    return N.elementos().filter((e) => ids.has(e.id) || (e.grupo && gs.has(e.grupo)));
  }
  function definirTrava(valor, rotulo) {
    const alvo = comGrupo(selecaoBruta()).filter((e) => N.travado(e) !== valor);
    if (!alvo.length) return false;
    for (const e of alvo) N.atualizar(e.id, { travado: valor });
    N.confirmar(rotulo);
    return true;
  }
  const travar = () => definirTrava(true, 'Travar');
  const destravar = () => definirTrava(false, 'Destravar');
  function alternarTrava() {
    const sel = selecaoBruta();
    if (!sel.length) return false;
    return sel.every((e) => N.travado(e)) ? destravar() : travar();
  }

  // ── Atalhos ──
  const editavel = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  function aoTecla(e) {
    if (e.defaultPrevented || !WB.estado().ativo) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const t = e.target;
    const raiz = document.querySelector('.wb-palco');
    if (!raiz) return;
    if (t !== document.body && t !== document.documentElement && !(t.closest && t.closest('.wb-vista'))) return;
    if (editavel(t) || document.querySelector('.wb-dialogo, .wb-painel')) return;
    const k = (e.key || '').toLowerCase();
    let ok = null;
    if (e.code === 'BracketRight') ok = () => camada(e.shiftKey ? 'frente' : 'subir');
    else if (e.code === 'BracketLeft') ok = () => camada(e.shiftKey ? 'trás' : 'descer');
    else if (e.shiftKey && k === 'l') ok = alternarTrava;
    else if (k === 'g') ok = () => (e.shiftKey ? desagrupar() : agrupar());
    else if (!e.shiftKey && k === 'd') ok = duplicar;
    else if (!e.shiftKey && k === 'c') ok = copiar;
    else if (!e.shiftKey && k === 'v') ok = colar;
    if (!ok) return;
    e.preventDefault(); e.stopPropagation();
    ok();
  }
  document.addEventListener('keydown', aoTecla, true);
  document.addEventListener('pointermove', (e) => {
    const p = document.querySelector('.wb-palco');
    if (!p || !p.contains(e.target)) return;
    const r = p.getBoundingClientRect();
    const m = N.telaParaMundo(e.clientX - r.left, e.clientY - r.top);
    if (!ptr || ptr.x !== m.x || ptr.y !== m.y) { ptr = { x: m.x, y: m.y }; nColar = 0; }
  }, true);

  const acoes = Object.freeze({ agrupar, desagrupar, duplicar, apagar, copiar, colar, alinhar, distribuir, camada, selecionarTudo, travar, destravar, alternarTrava });
  window.Whiteboard.estender('acoes', acoes);
})();
