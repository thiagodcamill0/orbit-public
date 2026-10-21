/* Configurações → Acesso pelo celular (remoto.mjs no servidor).
 *
 * Liga e desliga a porta remota, mostra o estado do Tailscale (instalado, logado, host, serve) com o botão de ativar/
 * desativar o `tailscale serve`, o endereço para abrir no iPhone, as opções (criar instâncias, avisos), os aparelhos
 * pareados (revogar um ou todos) e o passo a passo. Também mostra, em destaque e fora das Configurações, o PEDIDO DE
 * PAREAMENTO: o código de 6 dígitos só aparece aqui, no PC (GET /remoto/estado e o evento SSE "remoto").
 *
 * window.RemotoConfig = { montar({el, toast, icone, balao}), atualizar(), receber(estado) }. O index.html carrega este
 * arquivo na abertura da página (o pedido pode chegar com as Configurações fechadas) e repassa o SSE "remoto".
 * Nada do servidor entra por innerHTML.
 */
(function () {
  'use strict';
  const DOWNLOAD = 'https://tailscale.com/download';
  const PASSOS = [
    'Instale o Tailscale neste computador e no iPhone (o link de download está acima) e entre com a mesma conta nos dois.',
    'No painel do Tailscale (login.tailscale.com, aba DNS), ligue o MagicDNS e, em HTTPS Certificates, clique em Enable HTTPS.',
    'Aqui, ligue "Permitir acesso pelo celular" e toque em "Ativar no Tailscale". Na primeira vez o Tailscale pode pedir uma ativação no painel dele: o aviso aparece aqui.',
    'No iPhone, com o Tailscale conectado, abra o endereço acima no Safari.',
    'Toque em parear. Um código de 6 dígitos aparece neste computador: digite-o no iPhone. Vale 2 minutos.',
    'No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início.',
    'Abra o Orbit pelo ícone novo na tela do iPhone e ative as notificações quando ele pedir.',
  ];
  const st = {
    el: null, toast: () => {}, icone: () => null, balao: null,
    estado: null, seq: 0, erro: '', erroServe: '', ocupado: false, copiado: false,
    pedidoId: '', foco: null, relogio: 0,
  };
  let camada = null; // o aviso do pedido de pareamento

  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'checked') e.checked = !!v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }

  // Resposta com o corpo mesmo no erro (o `erro` do tailscale serve vem num 502).
  async function chamar(caminho, corpo) {
    const r = await fetch(caminho, corpo === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    let d = null;
    try { d = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, dados: d };
  }
  async function pedir(caminho, corpo) {
    const r = await chamar(caminho, corpo);
    if (!r.ok) throw new Error((r.dados && r.dados.erro) || 'HTTP ' + r.status);
    return r.dados;
  }

  const dataHora = (t) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  function ha(t) {
    if (!t) return 'nunca';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'agora';
    if (s < 3600) return 'há ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.round(s / 3600) + ' h';
    return 'há ' + Math.round(s / 86400) + ' d';
  }

  // ───────────────────────────── seção das Configurações ─────────────────────────────
  const chaveFoco = (el) => (el && el.closest && el.closest('[data-k]') ? el.closest('[data-k]').dataset.k : '');

  function interruptor(k, rotulo, dica, marcado, aoMudar, desligado) {
    const id = 'rm-' + k;
    return h('div', { class: 'cfg-linha' },
      h('label', { for: id }, rotulo, dica ? h('small', null, dica) : null),
      h('input', { id, class: 'chave', type: 'checkbox', 'data-k': k, checked: marcado, disabled: desligado || st.ocupado, onchange: (e) => aoMudar(e.currentTarget.checked, e.currentTarget) }));
  }

  function linhaTailscale(e) {
    const t = e.tailscale || {};
    const c = [];
    let texto;
    let tom = '';
    if (!t.instalado) { texto = 'O Tailscale não foi encontrado neste computador.'; tom = 'ruim'; }
    else if (!t.logado) { texto = 'Tailscale instalado, mas sem login. Abra o app e entre na sua conta.'; tom = 'ruim'; }
    else {
      texto = 'Conectado' + (t.dono ? ' como ' + t.dono : '') + (t.host ? ' · ' + t.host : '');
      tom = 'ok';
    }
    const info = [h('span', { class: 'estado-perm ' + tom, 'data-k': 'ts-estado' }, texto)];
    if (t.instalado && t.logado) info.push(h('small', { class: 'rm-serve ' + (t.serve ? 'ligado' : '') }, t.serve ? 'Publicado na sua tailnet (tailscale serve ligado).' : 'Ainda não publicado na sua tailnet.'));
    c.push(h('div', { class: 'rm-info' }, ...info));
    const acoes = [];
    if (!t.instalado) {
      acoes.push(h('a', { class: 'btn p', href: DOWNLOAD, target: '_blank', rel: 'noopener noreferrer', 'data-k': 'ts-baixar' }, st.icone('externo', 13), h('span', null, 'Baixar o Tailscale')));
    } else if (t.logado) {
      acoes.push(h('button', {
        type: 'button', class: 'btn p', 'data-k': 'ts-serve', disabled: st.ocupado || !e.ativo,
        title: e.ativo ? '' : 'Ligue o acesso pelo celular primeiro',
        onclick: () => alternarServe(!t.serve),
      }, t.serve ? 'Desativar' : 'Ativar no Tailscale'));
    }
    return h('div', { class: 'cfg-linha rm-ts' },
      h('div', { class: 'rot' }, 'Tailscale', ...c, st.erroServe ? h('small', { class: 'rm-erro', role: 'alert', 'data-k': 'ts-erro' }, st.erroServe) : null),
      acoes.length ? h('div', { class: 'ctl' }, ...acoes) : null);
  }

  function linhaEndereco(e) {
    const url = e.host ? 'https://' + e.host : '';
    return h('div', { class: 'cfg-linha' },
      h('div', { class: 'rot' }, 'Endereço no iPhone', h('small', null, url ? 'Abra no Safari, com o Tailscale conectado no iPhone.' : 'Aparece depois que o Tailscale estiver conectado.')),
      h('div', { class: 'ctl rm-end' },
        h('code', { class: 'rm-url', 'data-k': 'endereco', title: url }, url || '—'),
        url ? h('button', { type: 'button', class: 'btn p', 'data-k': 'copiar', onclick: () => copiar(url) }, st.icone(st.copiado ? 'check' : 'copiar', 13), h('span', null, st.copiado ? 'Copiado' : 'Copiar')) : null));
  }

  function aparelho(a) {
    return h('li', { class: 'rm-ap', 'data-id': a.id },
      h('div', { class: 'rm-ap-meio' },
        h('strong', { class: 'rm-ap-nome', title: a.nome }, a.nome),
        h('span', { class: 'rm-ap-det' }, 'Pareado em ' + dataHora(a.criadoEm) + ' · último acesso ' + ha(a.ultimoAcesso) + ' · push: ' + (a.push ? 'sim' : 'não'))),
      h('button', { type: 'button', class: 'btn p rm-rev', 'data-k': 'rev-' + a.id, disabled: st.ocupado, 'aria-label': 'Revogar ' + a.nome, onclick: () => revogar(a.id) }, st.icone('lixeira', 12), h('span', null, 'Revogar')));
  }

  function render() {
    const el = st.el;
    if (!el) return;
    const foco = el.contains(document.activeElement) ? chaveFoco(document.activeElement) : '';
    const e = st.estado;
    const filhos = [];
    if (!e) {
      filhos.push(h('p', { class: 'rm-vazio' }, st.erro || 'Carregando…'));
    } else {
      const liga = !!e.ativo;
      filhos.push(interruptor('ativo', 'Permitir acesso pelo celular', 'Abre uma porta só neste computador; o Tailscale leva até o seu iPhone, nunca à internet.', liga, ligar));
      if (st.erro) filhos.push(h('p', { class: 'rm-erro', role: 'alert' }, st.erro));
      filhos.push(linhaTailscale(e), linhaEndereco(e));
      filhos.push(interruptor('criar', 'Criar instâncias pelo celular', 'Só nos projetos cadastrados no Orbit. Nunca no modo que pula as permissões.', !!(e.opcoes && e.opcoes.criarInstancias), (v) => config({ criarInstancias: v }), !liga));
      const n = (e.opcoes && e.opcoes.notificar) || {};
      filhos.push(interruptor('n-precisa', 'Avisar no iPhone: precisa de você', 'Permissão, pergunta ou plano. Sem o texto do agente.', n.precisa !== false, (v) => config({ notificar: { precisa: v, terminou: n.terminou !== false } }), !liga));
      filhos.push(interruptor('n-terminou', 'Avisar no iPhone: terminou', null, n.terminou !== false, (v) => config({ notificar: { precisa: n.precisa !== false, terminou: v } }), !liga));
      if (e.bloqueadoAte) filhos.push(h('p', { class: 'rm-erro', role: 'status' }, 'Pareamento bloqueado até ' + new Date(e.bloqueadoAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' (códigos errados demais).'));
      const ap = e.aparelhos || [];
      filhos.push(h('div', { class: 'rm-aps' },
        h('div', { class: 'rm-aps-cab' },
          h('span', { class: 'rm-aps-tit' }, ap.length ? 'Aparelhos pareados (' + ap.length + ')' : 'Aparelhos pareados'),
          ap.length ? h('button', { type: 'button', class: 'btn p', 'data-k': 'rev-todos', disabled: st.ocupado, onclick: (ev) => revogarTodos(ev.currentTarget) }, 'Revogar todos') : null),
        ap.length ? h('ul', { class: 'rm-lista', 'aria-label': 'Aparelhos pareados' }, ...ap.map(aparelho)) : h('p', { class: 'rm-vazio', 'data-k': 'sem-aparelhos' }, 'Nenhum aparelho pareado ainda.')));
      filhos.push(h('details', { class: 'rm-passos', 'data-k': 'passos' },
        h('summary', null, 'Passo a passo'),
        h('ol', null, ...PASSOS.map((p) => h('li', null, p)))));
    }
    el.replaceChildren(...filhos);
    el.setAttribute('aria-busy', String(st.ocupado));
    if (foco) {
      const alvo = el.querySelector('[data-k="' + CSS.escape(foco) + '"]');
      if (alvo && !alvo.disabled) alvo.focus({ preventScroll: true });
    }
  }

  // ───────────────────────────── ações ─────────────────────────────
  function guardar(d) {
    if (d && typeof d === 'object' && 'ativo' in d && Array.isArray(d.aparelhos)) {
      // Respostas de fetch e eventos SSE chegam em qualquer ordem: o `seq` do servidor cresce a cada estado gerado.
      if (typeof d.seq === 'number') {
        if (d.seq < st.seq) return;
        st.seq = d.seq;
      }
      st.estado = d;
      pintarPedido();
    }
  }
  async function agir(fn) {
    if (st.ocupado) return null;
    st.ocupado = true;
    st.erro = '';
    render();
    try {
      const d = await fn();
      guardar(d);
      return d;
    } catch (e) {
      st.erro = 'Não deu: ' + e.message;
      return null;
    } finally {
      st.ocupado = false;
      render();
    }
  }
  const config = (patch) => agir(() => pedir('/remoto/config', patch));
  async function ligar(v, caixa) {
    const d = await config({ ativo: v });
    if (!d && caixa) caixa.checked = !v;
    if (d && !v) st.erroServe = '';
  }
  async function alternarServe(ligarServe) {
    st.erroServe = '';
    await agir(async () => {
      const r = await chamar('/remoto/tailscale/serve', { ligar: ligarServe });
      if (!r.ok) st.erroServe = (r.dados && r.dados.erro) || 'O Tailscale não aceitou o pedido (HTTP ' + r.status + ').';
      // O estado novo (serve, host) vem do GET; a resposta do POST só traz a parte do Tailscale.
      return pedir('/remoto/estado');
    });
    if (!st.erroServe) st.toast(ligarServe ? 'Orbit publicado na sua tailnet.' : 'Publicação na tailnet desligada.');
  }
  async function revogar(id) {
    const d = await agir(() => pedir('/remoto/revogar', { id }));
    if (d) st.toast('Aparelho revogado.');
  }
  async function revogarTodos(botao) {
    const n = ((st.estado && st.estado.aparelhos) || []).length;
    const ok = st.balao
      ? (await st.balao({ titulo: 'Revogar todos os aparelhos?', texto: n + (n === 1 ? ' aparelho perde' : ' aparelhos perdem') + ' o acesso agora e terá de parear de novo.', sim: 'Revogar todos', perigo: true, gatilho: botao })).ok
      : window.confirm('Revogar todos os aparelhos?');
    if (!ok) return;
    const d = await agir(() => pedir('/remoto/revogar', { todos: true }));
    if (d) st.toast('Todos os aparelhos foram revogados.');
  }
  async function copiar(url) {
    try { await navigator.clipboard.writeText(url); st.copiado = true; } catch { st.toast('Não consegui copiar: selecione o endereço e copie.'); return; }
    render();
    setTimeout(() => { st.copiado = false; render(); }, 1800);
  }

  async function atualizar() {
    try { guardar(await pedir('/remoto/estado')); st.erro = ''; } catch (e) {
      st.erro = /404/.test(e.message) ? 'Este servidor ainda não tem o acesso pelo celular (reinicie o Orbit).' : 'Não deu para ler o estado: ' + e.message;
    }
    render();
  }

  // ───────────────────────────── pedido de pareamento (em destaque) ─────────────────────────────
  function criarCamada() {
    const titulo = h('h2', { id: 'rm-ped-tit' });
    const codigo = h('div', { class: 'rm-codigo', id: 'rm-ped-cod', 'data-k': 'codigo' });
    const resta = h('p', { class: 'rm-resta', id: 'rm-ped-resta', role: 'timer' });
    const recusar = h('button', { type: 'button', class: 'btn p perigo', id: 'rm-ped-recusar', onclick: recusarPedido }, 'Recusar');
    const c = h('div', { id: 'rm-pedido', class: 'camada rm-pedido', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'rm-ped-tit', 'aria-describedby': 'rm-ped-desc', hidden: true },
      h('div', { class: 'modal rm-modal' },
        h('div', { class: 'modal-cab' }, st.icone('cadeado', 16), h('div', null, titulo, h('p', null, 'Pedido de acesso pelo celular')) ),
        h('div', { class: 'modal-corpo rm-corpo' },
          h('p', { id: 'rm-ped-desc', class: 'rm-desc' }, 'Digite este código no aparelho. Se não foi você, recuse.'),
          codigo, resta,
          h('div', { class: 'rm-ped-b' }, recusar))));
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Tab') { ev.preventDefault(); recusar.focus(); } });
    document.body.append(c);
    camada = { el: c, titulo, codigo, resta, recusar };
  }
  function pintarPedido() {
    const p = st.estado && st.estado.pedido;
    if (!camada) return;
    clearInterval(st.relogio);
    st.relogio = 0;
    if (!p || !p.id || !(p.expiraEm > Date.now())) {
      if (!camada.el.hidden) {
        camada.el.hidden = true;
        if (st.foco && st.foco.isConnected) { try { st.foco.focus({ preventScroll: true }); } catch {} }
        st.foco = null;
      }
      st.pedidoId = '';
      return;
    }
    camada.titulo.textContent = p.nome + ' quer acessar o Orbit';
    camada.codigo.textContent = p.codigo;
    camada.codigo.setAttribute('aria-label', 'Código ' + String(p.codigo).split('').join(' '));
    const tick = () => {
      const s = Math.ceil((p.expiraEm - Date.now()) / 1000);
      if (s <= 0) {
        // Expirou: some na hora (o servidor também avisa pelo SSE).
        if (st.estado && st.estado.pedido && st.estado.pedido.id === p.id) st.estado.pedido = null;
        pintarPedido();
        return;
      }
      camada.resta.textContent = 'Vale por ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    tick();
    if (!st.estado.pedido) return;
    st.relogio = setInterval(tick, 250);
    if (camada.el.hidden) {
      st.foco = document.activeElement;
      camada.el.hidden = false;
      camada.recusar.focus({ preventScroll: true });
    }
    st.pedidoId = p.id;
  }
  async function recusarPedido() {
    const id = st.pedidoId;
    if (!id) return;
    camada.recusar.disabled = true;
    try { guardar(await pedir('/remoto/parear/recusar', { pedido: id })); } catch (e) { st.toast('Não consegui recusar: ' + e.message); }
    camada.recusar.disabled = false;
    if (st.estado && st.estado.pedido && st.estado.pedido.id === id) { st.estado.pedido = null; pintarPedido(); }
    render();
  }

  window.RemotoConfig = Object.freeze({
    montar(o) {
      st.el = o.el;
      if (typeof o.toast === 'function') st.toast = o.toast;
      if (typeof o.icone === 'function') st.icone = o.icone;
      if (typeof o.balao === 'function') st.balao = o.balao;
      if (!camada) criarCamada();
      render();
      return atualizar(); // o pedido pode já estar na tela de quem abriu a página depois dele
    },
    atualizar: () => { st.erro = ''; return atualizar(); },
    receber(d) {
      guardar(d);
      if (st.ocupado) return;
      render();
    },
  });
})();
