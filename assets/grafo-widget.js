/* Orbit — widget "Grafo do projeto" da Visão geral (21/10). Versão compacta da aba Grafo (assets/grafo-vista.js):
   mesmas cores, ligações e hover, com as opções da aba para a mesma pasta (localStorage gi.grafo.opcoes[pasta]).
   Mostra o brain do projeto selecionado (o filtro da lateral; sem filtro, o último escolhido; sem nenhum, o do Orbit)
   e troca sozinho quando o projeto muda. Clique num nó: prévia da nota no próprio card. "Abrir no Grafo": a aba
   completa já na pasta do brain. Sem brain: estado vazio com "Vincular brain".
   Leve na Home: a física e o desenho param fora da tela (IntersectionObserver, aba escondida) e quando o grafo
   acomoda (a física da vista já dorme sozinha). A roda rola a página; Ctrl/⌘ + roda aproxima.
   index.html chama GrafoWidget.montar(card, api) e api.atualizar() a cada render (barato: compara o projeto e o brain).
   GrafoWidget.escolherPasta({ inicio, titulo }) → Promise<caminho | null>: o seletor de pasta (também usado no
   "Personalizar projeto"). Dados: GET /grafo/dados?pasta= e /grafo/nota?pasta=&id= (grafo.mjs); /arquivos/pastas. */
(function () {
  'use strict';
  const C_WIDGET = 'gi.grafoWidget';
  const RECARGA = 60000;   // relê o brain a cada minuto com o widget à vista
  const ENCAIXE = 300;     // ms entre os encaixes enquanto a física acomoda
  const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };
  const ler = (k, p) => { try { const v = localStorage.getItem(k); return v == null ? p : JSON.parse(v) ?? p; } catch { return p; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const baseNome = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const assinatura = (r) => (r.nos || []).map((x) => x.id + '|' + x.tipo + '|' + (x.tags || []).join(',')).join('\n') + '\n#\n' + (r.links || []).map((l) => l.origem + '>' + l.destino).join('\n');

  // ───────────────────────── seletor de pasta ─────────────────────────
  async function listarPastas(caminho) {
    const r = await fetch('/arquivos/pastas' + (caminho ? '?caminho=' + encodeURIComponent(caminho) : ''), { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.erro || 'erro ' + r.status);
    return j;
  }
  function escolherPasta(o) {
    o = o || {};
    return new Promise((pronto) => {
      const fundo = el('div', 'gw-modal');
      const dlg = el('div', 'gw-dlg');
      dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', o.titulo || 'Escolher pasta');
      const campo = el('input', 'gw-campo'); campo.type = 'text'; campo.placeholder = 'Caminho completo da pasta'; campo.spellcheck = false; campo.setAttribute('aria-label', 'Caminho da pasta');
      const bt = (rot, cls, fn) => { const b = el('button', cls || 'btn', rot); b.type = 'button'; b.addEventListener('click', fn); return b; };
      const subir = bt('Subir', 'btn', () => ir(pai || ''));
      const lista = el('div', 'gw-pastas'); lista.setAttribute('role', 'list');
      const msg = el('p', 'gw-msg'); msg.setAttribute('role', 'status');
      const usar = bt('Usar esta pasta', 'btn solido', () => { const c = campo.value.trim(); if (c) fechar(c); });
      const rodape = el('div', 'gw-rodape');
      rodape.append(bt('Cancelar', 'btn', () => fechar(null)), usar);
      const linha = el('div', 'gw-linha'); linha.append(campo, bt('Ir', 'btn', () => ir(campo.value.trim())), subir);
      const cab = el('div', 'gw-cab'); cab.append(el('b', null, o.titulo || 'Escolher pasta'));
      if (o.dica) cab.append(el('small', null, o.dica));
      dlg.append(cab, linha, lista, msg, rodape);
      fundo.append(dlg);
      let atual = '', pai = null, n = 0;
      const item = (rot, caminho, sub) => {
        const b = el('button', 'gw-item'); b.type = 'button'; b.title = caminho; b.setAttribute('role', 'listitem');
        b.append(el('span', null, rot)); if (sub) b.append(el('small', null, sub));
        b.addEventListener('click', () => ir(caminho));
        return b;
      };
      async function ir(caminho) {
        const k = ++n;
        msg.textContent = '';
        try {
          const j = await listarPastas(caminho);
          if (k !== n) return;
          atual = j.caminho || ''; pai = j.pai || null; campo.value = atual;
          subir.disabled = !atual;
          usar.disabled = !atual;
          lista.replaceChildren();
          if (!atual) {
            for (const a of [...(j.atalhos || []), ...(j.unidades || [])]) lista.append(item(a.nome, a.caminho));
          } else {
            for (const p of j.pastas || []) lista.append(item(p.nome, p.caminho));
            if (!(j.pastas || []).length) lista.append(el('p', 'gw-msg', 'Sem subpastas'));
          }
        } catch (e) { if (k === n) msg.textContent = 'Não abriu: ' + (e.message || e); }
      }
      function fechar(v) {
        removeEventListener('keydown', tecla, true);
        fundo.remove();
        if (o.volta && o.volta.isConnected) try { o.volta.focus({ preventScroll: true }); } catch {}
        pronto(v);
      }
      // Na janela, em captura: antes do Esc do resto da página (popover do projeto, modo de edição).
      const tecla = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(null); }
        else if (e.key === 'Enter' && e.target === campo) { e.preventDefault(); ir(campo.value.trim()); }
      };
      addEventListener('keydown', tecla, true);
      fundo.addEventListener('pointerdown', (e) => { if (e.target === fundo) fechar(null); });
      document.body.append(fundo);
      campo.focus();
      ir(o.inicio || '');
    });
  }

  // ───────────────────────── widget ─────────────────────────
  function montar(card, api) {
    if (!card || card._gw) return card && card._gw;
    const $ = (s) => card.querySelector(s);
    const area = $('.gg-area'), host = $('.gg-vista'), vazio = $('.gg-vazio'), prev = $('.gg-prev');
    const num = $('#gg-n'), uni = $('#gg-uni'), sub = $('#gg-sub'), lido = $('#gg-lido'), abrir = $('#gg-abrir');
    const cache = new Map();   // pasta → { dados, sig }
    const w = {
      vista: null, chave: null, proj: '', pasta: '', dados: null, carga: 0, naTela: false, mexeu: false,
      relEncaixe: 0, relRecarga: 0, ptr: null, prevId: '',
    };

    // Projeto mostrado: o filtro da lateral; sem filtro, o último escolhido; sem nenhum, o do Orbit.
    function projetoAtual() {
      const f = api.filtro() || '';
      const memo = ler(C_WIDGET, {});
      if (f && f !== 'Sem projeto') { if (memo.ultimo !== f) gravar(C_WIDGET, { ...memo, ultimo: f }); return f; }
      const conhecidos = new Set((api.projetos() || []).map((p) => p.nome));
      if (memo.ultimo && (!conhecidos.size || conhecidos.has(memo.ultimo))) return memo.ultimo;
      return api.padrao() || '';
    }

    function criarVista() {
      if (w.vista || !window.GrafoVista) return w.vista;
      w.vista = window.GrafoVista.criar(host, {
        aoAbrir: (id, o) => abrirNota(id, o && o.tipo),
        aoLocal: () => {},
        aoMenu: () => {},
      });
      w.vista.definirEscala(0.3, { animar: false });
      sincronizarPausa();
      return w.vista;
    }

    // ── estados ──
    function mostrarVazio(tipo) {
      card.dataset.estado = tipo;
      host.hidden = tipo !== 'grafo';
      fecharPrevia();
      vazio.hidden = tipo === 'grafo';
      if (tipo === 'grafo') return;
      vazio.replaceChildren();
      const ic = el('span', 'gg-vazio-ic'); ic.append(api.icone('grafo', 22));
      const nome = w.proj ? api.nome(w.proj) : '';
      const txt = el('p', 'gg-vazio-txt');
      const botao = (rot, fn, solido) => { const b = el('button', solido ? 'btn solido' : 'btn', rot); b.type = 'button'; b.addEventListener('click', fn); return b; };
      let acao = null;
      if (tipo === 'sem-projeto') txt.textContent = 'Escolha um projeto na lateral para ver o grafo do brain dele.';
      else if (tipo === 'sem-brain') {
        txt.append(el('b', null, nome), document.createTextNode(' ainda não tem um brain vinculado.'));
        acao = botao('Vincular brain', () => vincular(acao), true);
      } else if (tipo === 'carregando') txt.textContent = 'Lendo o brain…';
      else if (tipo === 'vazio') {
        txt.append(document.createTextNode('O brain '), el('b', null, baseNome(w.pasta)), document.createTextNode(' ainda não tem notas.'));
        acao = botao('Trocar brain', () => vincular(acao));
      } else { // erro
        txt.append(document.createTextNode('Não achei o brain '), el('b', null, baseNome(w.pasta)), document.createTextNode('.'));
        txt.title = w.pasta;
        acao = botao('Trocar brain', () => vincular(acao));
      }
      vazio.append(ic, txt);
      if (acao) vazio.append(acao);
    }
    function pintarTopo() {
      const d = w.dados;
      const notas = d ? d.nos.filter((n) => n.tipo === 'nota').length : 0;
      num.textContent = d ? String(notas) : '—';
      uni.textContent = d ? (notas === 1 ? 'nota' : 'notas') : '';
      sub.textContent = w.proj ? api.nome(w.proj) + (w.pasta ? ' · ' + baseNome(w.pasta) : '') : '';
      sub.title = w.pasta || '';
      lido.textContent = d ? d.links.length + (d.links.length === 1 ? ' ligação' : ' ligações') + (d.truncado ? ' · parcial' : '') : '';
      abrir.disabled = !w.pasta;
      abrir.title = w.pasta ? 'Abrir a aba Grafo em ' + w.pasta : 'Sem brain vinculado';
    }

    // ── dados ──
    function opcoesDaAba(pasta) {
      const g = ler('gi.grafo', {});
      const o = g && g.opcoes && g.opcoes[pasta];
      return Object.assign(window.GrafoDados ? window.GrafoDados.padroes() : {}, o && typeof o === 'object' ? o : {});
    }
    function aplicar(r) {
      w.dados = r;
      pintarTopo();
      if (!r.nos.length) { mostrarVazio('vazio'); return; }
      mostrarVazio('grafo');
      const v = criarVista();
      if (!v) return;
      v.definirOpcoes(Object.assign(opcoesDaAba(r.pasta), { busca: '' }));
      v.definirDados(r, null);
      w.mexeu = false;
      encaixarLogo();
    }
    async function carregar(silencioso) {
      const pasta = w.pasta, k = ++w.carga;
      if (!pasta) return;
      const c = cache.get(pasta);
      if (!silencioso) { if (c) aplicar(c.dados); else { w.dados = null; pintarTopo(); mostrarVazio('carregando'); } }
      let r;
      try {
        const resp = await fetch('/grafo/dados?pasta=' + encodeURIComponent(pasta), { cache: 'no-store' });
        r = await resp.json();
        if (!resp.ok) throw new Error(r.erro || 'erro ' + resp.status);
      } catch {
        if (k !== w.carga) return;
        cache.delete(pasta);
        w.dados = null; pintarTopo(); mostrarVazio('erro');
        return;
      }
      if (k !== w.carga) return;
      const sig = assinatura(r);
      const antes = cache.get(pasta);
      cache.set(pasta, { dados: r, sig });
      if (antes && antes.sig === sig && w.dados) { w.dados = r; pintarTopo(); return; } // nada mudou: a vista fica como está
      aplicar(r);
    }

    // Chamado a cada render do index.html: só faz algo se o projeto ou o brain mudou.
    function atualizar() {
      const p = projetoAtual();
      const pasta = p ? api.brain(p) || '' : '';
      const chave = p + '\n' + pasta;
      if (chave === w.chave) return;
      w.chave = chave; w.proj = p; w.pasta = pasta;
      w.dados = null;
      pintarTopo();
      if (!p) { mostrarVazio('sem-projeto'); return; }
      if (!pasta) { mostrarVazio('sem-brain'); return; }
      carregar(false);
    }

    async function vincular(volta) {
      const p = w.proj;
      if (!p) return;
      const pasta = await escolherPasta({ titulo: 'Brain de ' + api.nome(p), dica: 'a pasta de notas (.md) que vira o grafo do projeto', inicio: w.pasta || api.pastaProjeto(p) || '', volta });
      if (pasta) api.vincular(p, pasta);
    }

    // ── encaixe: enquanto a física acomoda (e ninguém mexeu), o grafo cabe inteiro no card ──
    function encaixarLogo() {
      clearInterval(w.relEncaixe);
      w.relEncaixe = 0;
      if (!w.vista || w.mexeu || !ativo()) return;
      w.vista.centralizar();
      w.relEncaixe = setInterval(() => {
        if (!w.vista || w.mexeu || !ativo()) { clearInterval(w.relEncaixe); w.relEncaixe = 0; return; }
        const e = w.vista._estado();
        w.vista.centralizar();
        if (e.alphaFisica < 0.004 && e.criados >= e.n) { clearInterval(w.relEncaixe); w.relEncaixe = 0; } // acomodado: a vista dorme sozinha
      }, ENCAIXE);
    }

    // ── pausa ──
    const ativo = () => w.naTela && !document.hidden;
    function sincronizarPausa() {
      const sim = ativo();
      if (w.vista) { if (sim) w.vista.retomar(); else w.vista.pausar(); }
      clearInterval(w.relRecarga); w.relRecarga = 0;
      if (!sim) { clearInterval(w.relEncaixe); w.relEncaixe = 0; return; }
      w.relRecarga = setInterval(() => carregar(true), RECARGA);
      if (w.vista && !w.mexeu && !w.relEncaixe) encaixarLogo();
    }
    new IntersectionObserver((es) => { const e = es[es.length - 1]; const antes = w.naTela; w.naTela = !!e && e.isIntersecting; if (antes !== w.naTela) { sincronizarPausa(); if (w.naTela && w.pasta) carregar(true); } }).observe(area);
    document.addEventListener('visibilitychange', sincronizarPausa);

    // ── prévia da nota ──
    function fecharPrevia() { prev.hidden = true; w.prevId = ''; card.classList.remove('gg-com-prev'); }
    async function abrirNota(id, tipo) {
      if (!w.dados) return;
      const no = w.dados.nos.find((n) => n.id === id);
      if (!no) return;
      w.prevId = id;
      prev.hidden = false;
      card.classList.add('gg-com-prev');
      prev.replaceChildren();
      const cab = el('div', 'gg-prev-cab');
      const tit = el('b', null, no.nome || baseNome(id)); tit.title = id;
      const caminho = id.includes('/') ? id.replace(/\/[^/]*$/, '') : '';
      const txtCab = el('div', 'gg-prev-tit'); txtCab.append(tit); if (caminho) txtCab.append(el('small', null, caminho));
      const x = el('button', 'btn-icone gg-prev-x'); x.type = 'button'; x.title = 'Fechar a prévia'; x.setAttribute('aria-label', 'Fechar a prévia'); x.append(api.icone('x', 13));
      x.addEventListener('click', fecharPrevia);
      cab.append(txtCab, x);
      const corpo = el('pre', 'gg-prev-txt', 'Carregando…');
      prev.append(cab, corpo);
      if ((tipo || no.tipo) === 'inexistente') { corpo.textContent = 'Esta nota ainda não existe: só aparece porque outra nota aponta para ela.'; return; }
      if (!/\.(md|markdown|txt)$/i.test(id)) { corpo.textContent = 'Sem prévia para este tipo de arquivo.'; return; }
      try {
        const r = await fetch('/grafo/nota?pasta=' + encodeURIComponent(w.dados.pasta) + '&id=' + encodeURIComponent(id), { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.erro || 'erro');
        if (w.prevId === id) corpo.textContent = j.texto.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim() || '(nota vazia)';
      } catch (e) { if (w.prevId === id) corpo.textContent = 'Não deu para ler a nota: ' + (e.message || e); }
    }
    prev.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); fecharPrevia(); } });

    // ── eventos do card ──
    abrir.addEventListener('click', () => { if (w.pasta) api.abrirGrafo(w.pasta); });
    // A roda rola a Home; com Ctrl/⌘ (e a pinça do trackpad), aproxima o grafo.
    area.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); else w.mexeu = true; }, { capture: true, passive: true });
    area.addEventListener('pointerdown', (e) => { if (e.target.closest('.gg-vista')) { w.ptr = { id: e.pointerId, tipo: e.pointerType }; w.mexeu = true; } }, true);
    host.addEventListener('dblclick', () => { w.mexeu = false; encaixarLogo(); }); // duplo clique: o grafo inteiro de novo
    new ResizeObserver(() => { if (w.vista && !w.mexeu && ativo()) encaixarLogo(); }).observe(area);
    // Modo de edição dos widgets (assets/widgets.js): o segurar tira o ponteiro do canvas; a vista solta o arrasto ou o pan.
    const geral = card.closest('#vista-geral');
    if (geral) new MutationObserver(() => {
      if (!geral.classList.contains('wd-editando') || !w.ptr) return;
      const c = host.querySelector('canvas');
      if (c) try { c.dispatchEvent(new PointerEvent('pointercancel', { pointerId: w.ptr.id, pointerType: w.ptr.tipo, bubbles: true })); } catch {}
      w.ptr = null;
    }).observe(geral, { attributes: true, attributeFilter: ['class'] });

    card._gw = { atualizar, recarregar: () => carregar(true), _estado: () => ({ ...w, vista: w.vista && w.vista._estado(), pausado: w.vista ? w.vista.pausado() : null }), _no: (id) => (w.vista ? w.vista._no(id) : null) };
    atualizar();
    return card._gw;
  }

  window.GrafoWidget = { montar, escolherPasta };
})();
