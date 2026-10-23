/* Configurações → Codex (Etapa 0; contrato da seção Codex).
 *
 * Chave "Ligar o Codex" (config.codex.ativo), campo "Caminho do codex.exe" (config.codex.exe; vazio = detectar no Codex
 * Desktop) e a linha com o executável detectado (GET /codex/estado) ou o motivo de não achar. Com a chave desligada o
 * campo e a linha ficam ocultos e nenhuma chamada ao servidor é feita.
 *
 * window.CodexConfig = { montar({el, config, salvar}), atualizar(), sincronizar() }
 *   config()  -> a config atual do front (est.config)      salvar(parcial) -> salvarConfig do index.html
 * Nada do servidor entra por innerHTML.
 */
(function () {
  'use strict';
  const ORIGENS = { auto: 'automático', manual: 'manual', env: 'variável de ambiente' };
  const st = { el: null, config: () => ({}), salvar: () => {}, ui: null, seq: 0, estado: null, erro: '' };

  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }

  const cfg = () => {
    const c = (st.config() || {}).codex;
    return { ativo: !!(c && c.ativo), exe: c && typeof c.exe === 'string' ? c.exe : '' };
  };

  function montarDom() {
    const chave = h('input', { id: 'cfg-codex', class: 'chave', type: 'checkbox' });
    const campo = h('input', { id: 'cfg-codex-exe', class: 'ctx-foco cdx-exe', type: 'text', maxlength: 500, spellcheck: 'false', autocomplete: 'off', placeholder: 'Detectar no Codex Desktop' });
    const estado = h('small', { id: 'cfg-codex-estado', class: 'estado-perm cdx-estado', role: 'status', 'aria-live': 'polite' });
    const usar = h('button', { id: 'cfg-codex-auto', class: 'link cdx-usar', type: 'button', hidden: true }, 'Usar o automático');
    const linhaChave = h('div', { class: 'cfg-linha' },
      h('label', { for: 'cfg-codex' }, 'Ligar o Codex', h('small', null, 'Mostra e controla as sessões do Codex ao lado das do Claude')), chave);
    const linhaExe = h('div', { class: 'cfg-linha cdx-linha', id: 'cfg-codex-exe-linha', hidden: true },
      h('label', { for: 'cfg-codex-exe' }, 'Caminho do codex.exe', h('small', null, 'Vazio = detectar no Codex Desktop')), campo);
    const linhaEstado = h('div', { class: 'cfg-linha cdx-linha', id: 'cfg-codex-estado-linha', hidden: true },
      h('div', { class: 'rot' }, 'Executável', estado), h('div', { class: 'ctl' }, usar));
    st.el.replaceChildren(linhaChave, linhaExe, linhaEstado);
    st.ui = { chave, campo, estado, usar, linhaExe, linhaEstado };

    chave.addEventListener('change', () => {
      const ativo = chave.checked;
      const salvo = st.salvar({ codex: { ativo, exe: cfg().exe } });
      if (ativo) Promise.resolve(salvo).then(atualizar); else { st.seq++; st.estado = null; st.erro = ''; }
      pintar();
    });
    const gravarCaminho = () => {
      const exe = campo.value.trim();
      if (campo.value !== exe) campo.value = exe;
      if (exe === cfg().exe) return;
      Promise.resolve(st.salvar({ codex: { ativo: true, exe } })).then(atualizar);
    };
    campo.addEventListener('change', gravarCaminho);
    campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); gravarCaminho(); } });
    usar.addEventListener('click', () => {
      campo.value = '';
      Promise.resolve(st.salvar({ codex: { ativo: true, exe: '' } })).then(atualizar);
    });
  }

  function pintar() {
    const u = st.ui;
    if (!u) return;
    const c = cfg();
    if (document.activeElement !== u.chave) u.chave.checked = c.ativo;
    if (document.activeElement !== u.campo && u.campo.value !== c.exe) u.campo.value = c.exe;
    u.linhaExe.hidden = u.linhaEstado.hidden = !c.ativo;
    if (!c.ativo) return;
    let texto = 'Verificando…';
    let tom = '';
    let sugerir = false;
    const e = st.estado && st.estado.exe;
    if (st.erro) { texto = st.erro; tom = 'ruim'; }
    else if (e && e.exe) {
      texto = e.exe + ' · ' + (ORIGENS[e.origem] || e.origem || 'automático');
      tom = 'ok';
    } else if (e) {
      texto = e.motivo || 'codex.exe não encontrado';
      tom = 'ruim';
      if (e.auto) { texto += ' · o automático achou ' + e.auto; sugerir = !!c.exe; }
    }
    u.estado.textContent = texto;
    u.estado.className = 'estado-perm cdx-estado' + (tom ? ' ' + tom : '');
    u.usar.hidden = !sugerir;
  }

  async function atualizar() {
    if (!st.ui || !cfg().ativo) { pintar(); return; }
    const eu = ++st.seq;
    try {
      const r = await fetch('/codex/estado', { cache: 'no-store' });
      if (eu !== st.seq) return;
      if (r.status === 404) { st.estado = null; st.erro = 'Este servidor ainda não tem o Codex ligado (reinicie o Orbit).'; }
      else if (!r.ok) { st.estado = null; st.erro = 'Não deu para ler o estado do Codex (HTTP ' + r.status + ').'; }
      else { st.estado = await r.json(); st.erro = ''; }
    } catch (err) {
      if (eu !== st.seq) return;
      st.estado = null;
      st.erro = 'Não deu para ler o estado do Codex: ' + (err && err.message ? err.message : err);
    }
    pintar();
  }

  window.CodexConfig = Object.freeze({
    montar(o) {
      st.el = o.el;
      if (typeof o.config === 'function') st.config = o.config;
      if (typeof o.salvar === 'function') st.salvar = o.salvar;
      montarDom();
      pintar();
      return atualizar();
    },
    atualizar,
    sincronizar: pintar,
  });
})();
