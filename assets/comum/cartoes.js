// Orbit — cartões de permissão (ferramenta, pergunta, plano), comuns ao PC e ao celular. Script clássico, sem dependências
// de página: define só window.OrbitCartoes. Lógica e textos do assets/conversa.js (~1301-1590), sem CSS e sem estado da página.
//   const api = { responder(corpo) → Promise, icone(nome, tam), md(texto) → nós, toast(texto), confirmar(texto) → Promise<boolean> };
//   const el = OrbitCartoes.cartao(pend, api, { fila: 2, aoResponder(info) {} });   // escolhe o tipo por tipoPermissao(pend)
//   OrbitCartoes.cartaoFerramenta | cartaoPergunta | cartaoPlano (pend, api, opcoes) → HTMLElement.ct-cartao
// `api.responder` recebe EXATAMENTE o corpo do POST /sessao/:id/permissao: { id: pend.id, decisao: 'permitir'|'negar',
// sugestao?: índice, mensagem?: texto, respostas?: { [pergunta]: resposta } } e deve rejeitar com {status, message} no erro
// (404/409 = alguém respondeu antes: o cartão avisa e termina). Se faltar, `icone` e `md` caem em OrbitIcones/OrbitMd e
// `toast`/`confirmar` ficam mudos (`confirmar` está no contrato para as páginas; nenhum cartão o exige hoje).
// `opcoes.aoResponder({ ok, jaRespondido, corpo })` e o evento 'ct-respondido' (bolha) no cartão avisam a página, que tira o cartão.
// Estrutura: .ct-cartao[data-tipo] > .ct-cab (.ct-ico, .ct-titulo, .ct-fila, .ct-chip), .ct-corpo, extras, .ct-erro, .ct-botoes.
// Botões: .btn (+ .p primário, .contorno, .perigo) e .link; o resto são classes ct-* (o CSS fica com a página).
(function () {
  'use strict';
  let seq = 0;
  const h = (tag, attrs, ...filhos) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) { const v = attrs[k]; if (v === false || v == null) continue; e.setAttribute(k, v === true ? '' : String(v)); }
    for (const f of filhos) if (f != null) e.append(f);
    return e;
  };
  const txt = (e, v) => { const t = v == null ? '' : String(v); if (e.textContent !== t) e.textContent = t; };
  const limpo = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const idSeguro = (id) => String(id).replace(/[^\w-]/g, '_');

  function tipoPermissao(p) {
    if (p && (p.tipo === 'pergunta' || p.tipo === 'plano' || p.tipo === 'ferramenta')) return p.tipo;
    if (p && p.ferramenta === 'AskUserQuestion' && Array.isArray(p.perguntas)) return 'pergunta';
    if (p && p.ferramenta === 'ExitPlanMode') return 'plano';
    return 'ferramenta';
  }
  const textoFila = (n) => 'mais ' + n + (n === 1 ? ' pedido na fila' : ' pedidos na fila');
  const ehAceitarEdicoes = (s) => s && (s.modo === 'acceptEdits' || /aceit\w*\s+(as\s+)?edi[cç]/i.test(String(s.rotulo || '')));
  const sugestoesDe = (p) => (Array.isArray(p.sugestoes) ? p.sugestoes : []).filter((s) => s && s.indice != null && limpo(s.rotulo));

  // api completa: o que faltar cai nos módulos comuns (ou fica mudo).
  function completar(api) {
    const a = api || {};
    return {
      responder: a.responder,
      icone: a.icone || (window.OrbitIcones ? window.OrbitIcones.icone : () => document.createTextNode('')),
      md: a.md || (window.OrbitMd ? window.OrbitMd.render : (t) => document.createTextNode(String(t || ''))),
      toast: a.toast || (() => {}),
      confirmar: a.confirmar || (() => Promise.resolve(true)),
    };
  }

  // Contexto de um cartão: botões com rótulo trocável, erro, envio único com "Enviando…".
  function contexto(p, api, opcoes) {
    const ctx = { p, api: completar(api), opcoes: opcoes || {}, enviando: false };
    ctx.erro = h('p', { class: 'ct-erro', role: 'alert', hidden: true });
    ctx.raiz = h('div', { class: 'ct-cartao', 'data-tipo': tipoPermissao(p), role: 'group' });
    ctx.botao = (classe, icone, rotulo, extra) => {
      const rot = h('span', { class: 'ct-rot' }, rotulo);
      const b = h('button', Object.assign({ type: 'button', class: 'btn ' + classe }, extra), icone ? ctx.api.icone(icone, 13) : null, rot);
      b._rot = rot;
      b._txt = rotulo;
      return b;
    };
    // Campo que abre sob demanda (motivo da negativa, comentário do plano).
    ctx.campo = (rotulo, placeholder, multilinha) => {
      const campo = multilinha
        ? h('textarea', { class: 'ct-txt', rows: 2, maxlength: 2000, placeholder, 'aria-label': rotulo, spellcheck: 'true' })
        : h('input', { class: 'ct-txt', type: 'text', maxlength: 2000, placeholder, 'aria-label': rotulo, spellcheck: 'true', autocomplete: 'off' });
      const caixa = h('div', { class: 'ct-campo', hidden: true }, campo);
      return { caixa, campo, valor: () => (caixa.hidden ? '' : campo.value.trim().slice(0, 2000)) };
    };
    ctx.terminar = (info) => {
      ctx.raiz.dataset.estado = 'respondido';
      ctx.raiz.removeAttribute('aria-busy');
      if (typeof ctx.opcoes.aoResponder === 'function') { try { ctx.opcoes.aoResponder(info); } catch (e) { console.warn('cartões: aoResponder', e); } }
      ctx.raiz.dispatchEvent(new CustomEvent('ct-respondido', { bubbles: true, detail: info }));
    };
    // Envia a resposta; `botao` mostra "Enviando…". 404/409 = alguém respondeu antes.
    ctx.enviar = async (corpo, botao, aviso) => {
      if (ctx.enviando || ctx.raiz.dataset.estado === 'respondido') return;
      ctx.enviando = true;
      const controles = [...ctx.raiz.querySelectorAll('button, input, textarea')];
      for (const x of controles) x.disabled = true;
      ctx.raiz.setAttribute('aria-busy', 'true');
      ctx.erro.hidden = true;
      if (botao && botao._rot) txt(botao._rot, 'Enviando…');
      const completo = Object.assign({ id: p.id }, corpo);
      try {
        if (typeof ctx.api.responder !== 'function') throw new Error('sem api.responder');
        await ctx.api.responder(completo);
        ctx.api.toast(aviso);
        ctx.terminar({ ok: true, jaRespondido: false, corpo: completo });
      } catch (e) {
        if (e && (e.status === 404 || e.status === 409)) {
          ctx.api.toast('Esse pedido já foi respondido.');
          ctx.terminar({ ok: true, jaRespondido: true, corpo: completo });
          return;
        }
        ctx.enviando = false;
        for (const x of controles) x.disabled = false;
        ctx.raiz.removeAttribute('aria-busy');
        if (botao && botao._rot) txt(botao._rot, botao._txt);
        if (ctx.validar) ctx.validar();
        txt(ctx.erro, 'Não deu para responder: ' + (e && e.message ? e.message : 'erro desconhecido'));
        ctx.erro.hidden = false;
      }
    };
    return ctx;
  }

  // Monta o cartão a partir de [icone, titulo, chip, corpo, extras, botoes].
  function montar(ctx, partes) {
    const [icone, titulo, chip, corpo, extras, botoes] = partes;
    const fila = Math.max(0, Number(ctx.opcoes.fila) || 0);
    const tid = 'ct-t-' + (++seq);
    const filaEl = h('span', { class: 'ct-fila', hidden: !fila }, fila ? textoFila(fila) : '');
    ctx.raiz.setAttribute('aria-labelledby', tid);
    ctx.raiz.atualizarFila = (n) => { txt(filaEl, n > 0 ? textoFila(n) : ''); filaEl.hidden = !(n > 0); };
    ctx.raiz.pendente = ctx.p;
    ctx.raiz.append(
      h('div', { class: 'ct-cab' }, h('span', { class: 'ct-ico' }, ctx.api.icone(icone, 14)), h('strong', { class: 'ct-titulo', id: tid }, titulo), filaEl,
        chip ? h('span', { class: 'ct-chip', title: chip }, chip) : null),
      corpo && corpo.childNodes.length ? corpo : null,
      ...(extras || []),
      ctx.erro,
      botoes);
    return ctx.raiz;
  }

  // ───── Ferramenta: resumo, entrada recolhível, Permitir, uma opção por sugestão, Negar com motivo opcional ─────
  function partesFerramenta(ctx) {
    const { p } = ctx;
    let entrada = '';
    try { entrada = p.entrada == null ? '' : typeof p.entrada === 'string' ? p.entrada : JSON.stringify(p.entrada, null, 2); } catch {}
    const corpo = h('div', { class: 'ct-corpo' },
      p.resumo ? h('p', { class: 'ct-resumo', title: String(p.resumo) }, String(p.resumo)) : null,
      entrada ? h('details', { class: 'ct-det' }, h('summary', null, 'Ver a entrada completa'), h('pre', null, entrada)) : null);
    const sugs = sugestoesDe(p).map((s) => {
      const b = ctx.botao('contorno ct-sug', 'check', String(s.rotulo));
      b.title = String(s.rotulo);
      b.addEventListener('click', () => ctx.enviar({ decisao: 'permitir', sugestao: s.indice }, b, 'Permitido: ' + String(s.rotulo) + '.'));
      if (!s.libera) return b;
      // Regra de terminal ampliada pelo servidor: o que ela libera fica escrito embaixo do botão.
      const id = 'ct-lib-' + (++seq);
      b.setAttribute('aria-describedby', id);
      return h('div', { class: 'ct-sug-item' }, b, h('p', { class: 'ct-libera', id }, String(s.libera)));
    });
    const motivo = ctx.campo('Motivo da negativa (opcional)', 'Motivo (opcional): o agente recebe este texto', false);
    const comMotivo = h('button', { type: 'button', class: 'link ct-link', 'aria-expanded': 'false' }, 'Negar com motivo…');
    const negar = ctx.botao('contorno perigo', 'x', 'Negar');
    const permitir = ctx.botao('p', 'check', 'Permitir');
    const enviarNegar = () => {
      const m = motivo.valor();
      ctx.enviar(m ? { decisao: 'negar', mensagem: m } : { decisao: 'negar' }, negar, m ? 'Negado, com o motivo.' : 'Negado.');
    };
    comMotivo.addEventListener('click', () => {
      const abrir = motivo.caixa.hidden;
      motivo.caixa.hidden = !abrir;
      comMotivo.setAttribute('aria-expanded', String(abrir));
      txt(comMotivo, abrir ? 'Sem motivo' : 'Negar com motivo…');
      negar._txt = abrir ? 'Negar com o motivo' : 'Negar';
      txt(negar._rot, negar._txt);
      if (abrir) motivo.campo.focus(); else { motivo.campo.value = ''; negar.focus(); }
    });
    motivo.campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); enviarNegar(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); comMotivo.click(); }
    });
    negar.addEventListener('click', enviarNegar);
    permitir.addEventListener('click', () => ctx.enviar({ decisao: 'permitir' }, permitir, 'Permitido.'));
    const extras = [];
    if (sugs.length) extras.push(h('div', { class: 'ct-sugs', role: 'group', 'aria-label': 'Permitir com uma regra' }, ...sugs));
    extras.push(motivo.caixa);
    return ['cadeado', 'Permissão pedida', String(p.ferramenta || 'Ferramenta'), corpo, extras,
      h('div', { class: 'ct-botoes' }, comMotivo, h('span', { class: 'ct-esp' }), negar, permitir)];
  }

  // ───── Pergunta (AskUserQuestion): um bloco por pergunta, rádio (caixa na múltipla) e "Outra resposta" ─────
  function partesPergunta(ctx) {
    const { p } = ctx;
    const perguntas = (Array.isArray(p.perguntas) ? p.perguntas : []).filter((q) => q && limpo(q.pergunta));
    if (!perguntas.length) { ctx.raiz.dataset.tipo = 'ferramenta'; return partesFerramenta(ctx); }
    const nome = 'ct-q-' + (++seq) + '-' + idSeguro(p.id);
    const estado = perguntas.map(() => ({ sel: new Set(), outra: false }));
    const corpo = h('div', { class: 'ct-corpo' });
    const responder = ctx.botao('p', 'check', 'Responder');
    const pular = ctx.botao('contorno', 'x', 'Não responder');
    const livres = [];
    const opcoesDe = (q) => (Array.isArray(q.opcoes) ? q.opcoes : []).filter((o) => o && limpo(o.rotulo));
    perguntas.forEach((q, qi) => {
      const multipla = !!q.multipla;
      const tituloId = nome + '-' + qi + '-t';
      const ops = h('div', { class: 'ct-ops', role: multipla ? 'group' : 'radiogroup', 'aria-labelledby': tituloId });
      const livre = h('input', { class: 'ct-livre', type: 'text', maxlength: 2000, placeholder: 'Escreva a sua resposta', 'aria-label': 'Outra resposta para: ' + String(q.pergunta), autocomplete: 'off', spellcheck: 'true', hidden: true });
      livres[qi] = livre;
      const opcao = (rotulo, descricao, chave) => {
        const input = h('input', { type: multipla ? 'checkbox' : 'radio', name: nome + '-' + qi, class: 'ct-op-in', value: String(chave) });
        const lab = h('label', { class: 'ct-op' + (chave === 'outra' ? ' ct-op-outra' : '') }, input,
          h('span', { class: 'ct-op-txt' }, h('span', { class: 'ct-op-rot' }, rotulo), descricao ? h('span', { class: 'ct-op-desc' }, descricao) : null));
        input.addEventListener('change', () => {
          const e = estado[qi];
          if (!multipla) { e.sel.clear(); e.outra = false; }
          if (chave === 'outra') e.outra = input.checked;
          else if (input.checked) e.sel.add(chave); else e.sel.delete(chave);
          for (const l of ops.querySelectorAll('.ct-op')) l.classList.toggle('ct-marcada', l.firstChild.checked);
          livre.hidden = !e.outra;
          if (e.outra && chave === 'outra') livre.focus();
          validar();
        });
        return lab;
      };
      opcoesDe(q).forEach((o, oi) => ops.append(opcao(String(o.rotulo), o.descricao ? String(o.descricao) : '', oi)));
      ops.append(opcao('Outra resposta', '', 'outra'));
      livre.addEventListener('input', validar);
      livre.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); responder.click(); } });
      corpo.append(h('div', { class: 'ct-q', role: 'group', 'aria-labelledby': tituloId },
        h('div', { class: 'ct-q-cab' }, q.cabecalho ? h('span', { class: 'ct-q-tag' }, String(q.cabecalho)) : null, multipla ? h('span', { class: 'ct-q-dica' }, 'Escolha uma ou mais') : null),
        h('p', { class: 'ct-q-txt', id: tituloId }, String(q.pergunta)),
        ops, livre));
    });
    // Resposta de cada pergunta: rótulo, texto livre ou (na múltipla) os rótulos unidos por ", ".
    function respostas() {
      const r = {};
      let faltam = 0;
      perguntas.forEach((q, qi) => {
        const e = estado[qi];
        const ops = opcoesDe(q);
        const partes = [...e.sel].sort((a, b) => a - b).map((i) => String(ops[i].rotulo));
        const livre = e.outra ? livres[qi].value.trim() : '';
        if (livre) partes.push(livre);
        if (!partes.length) { faltam++; return; }
        r[String(q.pergunta)] = q.multipla ? partes.join(', ') : partes[0];
      });
      return { r, faltam };
    }
    function validar() {
      const { faltam } = respostas();
      const motivo = !faltam ? '' : perguntas.length === 1 ? 'Escolha uma resposta primeiro.' : faltam === 1 ? 'Falta responder 1 pergunta.' : 'Faltam ' + faltam + ' perguntas.';
      responder.setAttribute('aria-disabled', motivo ? 'true' : 'false');
      responder._motivo = motivo;
      if (motivo) responder.title = motivo; else responder.removeAttribute('title');
    }
    ctx.validar = validar;
    validar();
    responder.addEventListener('click', () => {
      if (responder.getAttribute('aria-disabled') === 'true') { txt(ctx.erro, responder._motivo); ctx.erro.hidden = false; return; }
      ctx.enviar({ decisao: 'permitir', respostas: respostas().r }, responder, 'Resposta enviada.');
    });
    pular.addEventListener('click', () => ctx.enviar({ decisao: 'negar' }, pular, 'Pergunta recusada.'));
    return ['ajuda', perguntas.length > 1 ? 'O agente tem ' + perguntas.length + ' perguntas' : 'Pergunta do agente', null, corpo, [],
      h('div', { class: 'ct-botoes' }, h('span', { class: 'ct-esp' }), pular, responder)];
  }

  // ───── Plano (ExitPlanMode): markdown, Aprovar, "Aprovar e aceitar edições" e "Continuar planejando" com comentário ─────
  function partesPlano(ctx) {
    const { p } = ctx;
    let plano = typeof p.plano === 'string' ? p.plano : '';
    if (!plano && p.entrada && typeof p.entrada.plan === 'string') plano = p.entrada.plan;
    const md = h('div', { class: 'ct-plano md' });
    try { md.append(ctx.api.md(plano || '_O agente não mandou o texto do plano._')); } catch { md.textContent = plano; }
    const corpo = h('div', { class: 'ct-corpo' }, md);
    const sugs = sugestoesDe(p);
    const aceitar = sugs.find(ehAceitarEdicoes);
    const outras = sugs.filter((s) => s !== aceitar).map((s) => {
      const b = ctx.botao('contorno ct-sug', 'check', String(s.rotulo));
      b.title = String(s.rotulo);
      b.addEventListener('click', () => ctx.enviar({ decisao: 'permitir', sugestao: s.indice }, b, 'Plano aprovado: ' + String(s.rotulo) + '.'));
      return b;
    });
    const comentario = ctx.campo('Comentário sobre o plano (opcional)', 'O que mudar no plano (opcional): o agente recebe este texto', true);
    const continuar = ctx.botao('contorno', 'lapis', 'Continuar planejando', { 'aria-expanded': 'false' });
    const aprovar = ctx.botao('p', 'check', 'Aprovar');
    let aprovarEd = null;
    if (aceitar) {
      aprovarEd = ctx.botao('contorno', 'check', 'Aprovar e aceitar edições');
      aprovarEd.title = String(aceitar.rotulo);
      aprovarEd.addEventListener('click', () => ctx.enviar({ decisao: 'permitir', sugestao: aceitar.indice }, aprovarEd, 'Plano aprovado; edições aceitas sem perguntar.'));
    }
    const fecharComentario = () => {
      comentario.caixa.hidden = true;
      comentario.campo.value = '';
      continuar.setAttribute('aria-expanded', 'false');
      continuar._txt = 'Continuar planejando';
      txt(continuar._rot, continuar._txt);
    };
    const enviarComentario = () => {
      const m = comentario.valor();
      ctx.enviar(m ? { decisao: 'negar', mensagem: m } : { decisao: 'negar' }, continuar, 'O agente continua planejando.');
    };
    continuar.addEventListener('click', () => {
      if (comentario.caixa.hidden) {
        comentario.caixa.hidden = false;
        continuar.setAttribute('aria-expanded', 'true');
        continuar._txt = 'Enviar e continuar planejando';
        txt(continuar._rot, continuar._txt);
        comentario.campo.focus();
        return;
      }
      enviarComentario();
    });
    comentario.campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); enviarComentario(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharComentario(); continuar.focus(); }
    });
    aprovar.addEventListener('click', () => ctx.enviar({ decisao: 'permitir' }, aprovar, 'Plano aprovado.'));
    const extras = [];
    if (outras.length) extras.push(h('div', { class: 'ct-sugs', role: 'group', 'aria-label': 'Aprovar com uma regra' }, ...outras));
    extras.push(comentario.caixa);
    return ['lista', 'Plano para aprovar', null, corpo, extras,
      h('div', { class: 'ct-botoes' }, continuar, h('span', { class: 'ct-esp' }), aprovarEd, aprovar)];
  }

  const fabrica = (partes) => (pend, api, opcoes) => {
    const ctx = contexto(pend, api, opcoes);
    ctx.raiz.dataset.tipo = partes === partesPergunta ? 'pergunta' : partes === partesPlano ? 'plano' : 'ferramenta';
    return montar(ctx, partes(ctx));
  };
  const cartaoFerramenta = fabrica(partesFerramenta);
  const cartaoPergunta = fabrica(partesPergunta);
  const cartaoPlano = fabrica(partesPlano);

  // Escolhe o cartão pelo tipo; se montar falhar, cai no de ferramenta (que sempre funciona).
  function cartao(pend, api, opcoes) {
    const tipo = tipoPermissao(pend);
    try { return (tipo === 'pergunta' ? cartaoPergunta : tipo === 'plano' ? cartaoPlano : cartaoFerramenta)(pend, api, opcoes); }
    catch (e) { console.warn('cartões: permissão', e); return cartaoFerramenta(pend, api, opcoes); }
  }

  window.OrbitCartoes = { tipoPermissao, textoFila, cartaoFerramenta, cartaoPergunta, cartaoPlano, cartao };
})();
