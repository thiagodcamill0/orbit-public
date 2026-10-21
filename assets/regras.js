/* Configurações → Permissões dos agentes (regras.mjs no servidor).
 *
 * Lista as regras de permissão de cada projeto conhecido (.claude/settings.local.json e .claude/settings.json
 * da pasta), com um botão para remover cada uma. Não cria regra: elas nascem do "Permitir sempre" do cartão.
 * Nada aqui mexe no ~/.claude/settings.json (global).
 *
 * window.Regras = { montar({el, toast, icone}), atualizar(), receber(lista) }. O index.html carrega este
 * arquivo na primeira abertura das Configurações e repassa o SSE "regras".
 */
(function () {
  'use strict';
  const TIPO = { allow: 'Permitir', ask: 'Perguntar', deny: 'Negar' };
  const ARQ = {
    local: ['Só nesta máquina', '.claude/settings.local.json, fora do git'],
    projeto: ['Compartilhado no repositório', '.claude/settings.json, vai junto no git'],
  };
  const st = { el: null, toast: () => {}, icone: () => null, dados: null, ocupado: false, erro: '' };

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

  async function pedir(caminho, corpo) {
    const r = await fetch(caminho, corpo === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((d && d.erro) || 'HTTP ' + r.status);
      e.status = r.status;
      throw e;
    }
    return d;
  }

  // ───────────────────────────── desenho ─────────────────────────────
  const chaveFoco = (el) => el && el.closest && el.closest('[data-k]') ? el.closest('[data-k]').dataset.k : '';

  function render() {
    const el = st.el;
    if (!el) return;
    const focoK = el.contains(document.activeElement) ? chaveFoco(document.activeElement) : '';
    const d = st.dados;
    const filhos = [h('p', { class: 'rg-nota' },
      'Cada regra fica na pasta .claude/ do projeto e vale só nele. Os comandos simples de leitura o próprio Claude Code já roda sem perguntar; aqui ficam as regras criadas pelo "Permitir sempre".')];
    if (st.erro) filhos.push(h('p', { class: 'rg-erro', role: 'alert' }, st.erro));
    if (!d) {
      filhos.push(h('p', { class: 'rg-vazio' }, st.erro ? '' : 'Carregando…'));
    } else {
      const com = d.projetos.filter((p) => p.arquivos.some((a) => a.regras.length || a.erro));
      const sem = d.projetos.filter((p) => !com.includes(p));
      for (const p of com) filhos.push(projeto(p));
      if (sem.length) {
        const det = h('details', { class: 'rg-outros' }, h('summary', null, sem.length === 1 ? '1 projeto sem regras' : sem.length + ' projetos sem regras'));
        for (const p of sem) det.append(projeto(p));
        filhos.push(det);
      }
      if (!d.projetos.length) filhos.push(h('p', { class: 'rg-vazio' }, 'Nenhum projeto conhecido ainda.'));
    }
    el.replaceChildren(...filhos);
    el.setAttribute('aria-busy', String(st.ocupado));
    if (focoK) {
      const alvo = el.querySelector('[data-k="' + CSS.escape(focoK) + '"]');
      if (alvo) alvo.focus();
    }
  }

  function projeto(p) {
    const filhos = [h('div', { class: 'rg-cab' },
      h('div', { class: 'rg-nome' }, h('strong', null, p.nome || p.pasta), h('span', { class: 'mono rg-pasta', title: p.pasta }, p.pasta)))];
    let alguma = false;
    for (const a of p.arquivos) {
      if (a.erro) { filhos.push(h('p', { class: 'rg-erro' }, a.caminho + ': ' + a.erro + '. Corrija o arquivo à mão; o Orbit não regrava.')); continue; }
      if (!a.regras.length) continue;
      alguma = true;
      const [rot, dica] = ARQ[a.arquivo] || [a.arquivo, ''];
      filhos.push(h('div', { class: 'rg-arq' }, h('span', { class: 'rg-arq-rot', title: a.caminho }, rot), h('span', { class: 'rg-arq-dica' }, dica)));
      filhos.push(h('ul', { class: 'rg-regras', 'aria-label': 'Regras: ' + rot }, ...a.regras.map((r) => regra(p, a, r))));
    }
    if (!alguma && !p.arquivos.some((a) => a.erro)) filhos.push(h('p', { class: 'rg-vazio' }, 'Nenhuma regra neste projeto.'));
    return h('div', { class: 'rg-proj' }, ...filhos);
  }

  function regra(p, a, r) {
    const k = ['x', p.pasta, a.arquivo, r.tipo, r.regra].join('\u0001');
    return h('li', { class: 'rg-regra' + (r.tipo !== 'allow' ? ' rg-' + r.tipo : '') },
      r.tipo !== 'allow' ? h('span', { class: 'rg-tipo' }, TIPO[r.tipo] || r.tipo) : null,
      h('code', { class: 'mono', title: r.regra }, r.regra),
      h('button', {
        type: 'button', class: 'btn-icone rg-x', 'data-k': k, disabled: st.ocupado,
        title: 'Remover esta regra', 'aria-label': 'Remover a regra ' + r.regra,
        onclick: () => remover(p, a, r),
      }, st.icone('x', 12)));
  }

  // ───────────────────────────── ações ─────────────────────────────
  async function acao(fn) {
    if (st.ocupado) return;
    st.ocupado = true;
    st.erro = '';
    render();
    try {
      await fn();
    } catch (e) {
      st.erro = 'Não deu: ' + e.message;
      if (e.status === 404) await atualizar(true);
    } finally {
      st.ocupado = false;
      render();
    }
  }

  function remover(p, a, r) {
    acao(async () => {
      const d = await pedir('/regras/remover', { pasta: p.pasta, arquivo: a.arquivo, tipo: r.tipo, regra: r.regra });
      receberLista(d);
      st.toast('Regra removida: ' + r.regra + '. ' + (r.tipo === 'allow' ? 'O agente volta a pedir permissão.' : r.tipo === 'deny' ? 'O comando deixa de ser bloqueado.' : ''));
      // O foco vai para a próxima regra (ou para o primeiro botão da seção) depois do redesenho.
      requestAnimationFrame(() => {
        if (st.el.contains(document.activeElement) && document.activeElement !== document.body) return;
        const alvo = st.el.querySelector('.rg-x:not([disabled])') || st.el.querySelector('button, summary');
        if (alvo) alvo.focus();
      });
    });
  }

  function receberLista(d) {
    if (!d || !Array.isArray(d.projetos)) return;
    st.dados = { projetos: d.projetos };
  }

  async function atualizar(semRender) {
    try {
      receberLista(await pedir('/regras'));
    } catch (e) {
      st.erro = e.status === 404 ? 'Este servidor ainda não tem as regras de permissão (reinicie o Orbit).' : 'Não deu para ler as regras: ' + e.message;
    }
    if (!semRender) render();
  }

  window.Regras = Object.freeze({
    montar(o) {
      st.el = o.el;
      if (typeof o.toast === 'function') st.toast = o.toast;
      if (typeof o.icone === 'function') st.icone = o.icone;
      render();
    },
    atualizar: () => { st.erro = ''; return atualizar(); },
    receber(d) { if (st.ocupado) return; receberLista(d); render(); },
  });
})();
