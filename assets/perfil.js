/* Perfil — botão no pé da lateral, conta do Claude (servidor: conta-claude.mjs, 19/10) e conta do GitHub
 * (servidor: perfil.mjs).
 *
 * Claude: mostra a conta logada (e-mail e plano), entra pelo `claude auth login` oficial (abre o navegador) e
 * sai com confirmação. Antes de sair ou trocar, avisa o que está em andamento: as instâncias do Orbit podem
 * dormir e voltar sozinhas depois do novo login; as do VS Code e do terminal ficam só no aviso.
 *
 * Integração: o index.html tem o botão #btn-perfil (dentro de #perfil-pe) e carrega este arquivo
 * depois do script principal. Da página só se usa window.GerenciadorAPI.on('perfil' | 'conexao').
 *
 * Segurança: o token só passa por aqui uma vez, do campo para o POST /perfil/github. O campo é
 * limpo logo depois (e ao fechar o popover), e o servidor nunca devolve o token. Texto vindo do
 * servidor entra só por textContent.
 */
(function () {
  'use strict';

  const botao = document.getElementById('btn-perfil');
  if (!botao) return;
  const api = window.GerenciadorAPI;

  const URL_NOVO_TOKEN = 'https://github.com/settings/personal-access-tokens/new?name=Orbit&description=' +
    encodeURIComponent('Perfil no Orbit (só leitura do perfil público)');
  const URL_TOKENS = 'https://github.com/settings/personal-access-tokens';
  const MS_CONFIRMAR = 4000;

  const st = { perfil: null, antigo: false, aberto: false, form: false, enviando: false, saindo: false, erro: '', falha: '', confirmar: false, desconectado: false };
  // Conta do Claude: cl = o GET /conta/claude; conf = 'sair' | 'trocar' (painel de confirmação aberto).
  const cl = { dados: null, antigo: false, conf: '', ocupado: '', msg: '', falha: '' };
  let clT = 0;
  let confirmarT = 0;
  const ui = {};

  // ───────────────────────────── utilidades ─────────────────────────────
  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  function txt(el, v) {
    const t = v == null ? '' : String(v);
    if (el.textContent !== t) el.textContent = t;
  }

  // Mesmo traço dos ícones da página (16 × 16, linha 1,5); o do GitHub é a marca preenchida.
  const NS = 'http://www.w3.org/2000/svg';
  const ICONES = {
    github: [['path', { d: 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z', fill: 'currentColor', stroke: 'none' }]],
    seletor: [['path', { d: 'M5.5 6.2 8 3.7l2.5 2.5M5.5 9.8 8 12.3l2.5-2.5' }]],
    sair: [['path', { d: 'M6.5 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h2.5' }], ['path', { d: 'M10.5 11 13.5 8l-3-3M13.5 8H6.5' }]],
    externo: [['path', { d: 'M9.5 2.5h4v4M13.5 2.5 7.8 8.2' }], ['path', { d: 'M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3' }]],
    cadeado: [['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.2 }], ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }]],
    check: [['path', { d: 'M3.5 8.5l3 3 6-7' }]],
    alerta: [['path', { d: 'M8 2.5 14 13H2z' }], ['path', { d: 'M8 6.5v3' }], ['circle', { cx: 8, cy: 11.3, r: .5, fill: 'currentColor', stroke: 'none' }]],
    chevron: [['path', { d: 'M6 3.8 10.2 8 6 12.2' }]],
    info: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M8 7.3v3.7' }], ['circle', { cx: 8, cy: 5, r: .55, fill: 'currentColor', stroke: 'none' }]],
    entrar: [['path', { d: 'M9.5 2.5H12A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H9.5' }], ['path', { d: 'M6 5l3 3-3 3M9 8H2.5' }]],
    trocar: [['path', { d: 'M2.5 5.5h10L10 3' }], ['path', { d: 'M13.5 10.5h-10L6 13' }]],
  };
  // A marca do Claude, a mesma do card Uso do plano (index.html, .gu-logo).
  function logoClaude() {
    const v = document.createElementNS(NS, 'svg');
    for (const [k, x] of Object.entries({ viewBox: '0 0 24 24', width: 16, height: 16, class: 'pf-cl-marca', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, String(x));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M12.22 10.42L13.39 2.1M12.99 10.74L17.29 5.22M13.48 11.4L20.9 8.4M13.58 12.22L20.12 13.14M13.26 12.99L19.88 18.16M12.6 13.48L15.33 20.25M11.78 13.58L10.69 21.31M11.01 13.26L6.83 18.62M10.52 12.6L2.73 15.75M10.42 11.78L3.38 10.79M10.74 11.01L4.36 6.03M11.4 10.52L8.82 4.12');
    v.append(p);
    return v;
  }
  function icone(nome, tam = 16) {
    const v = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const k in attrs) v.setAttribute(k, String(attrs[k]));
    for (const [t, a] of ICONES[nome] || []) {
      const e = document.createElementNS(NS, t);
      for (const k in a) e.setAttribute(k, String(a[k]));
      v.append(e);
    }
    return v;
  }

  function iniciais(t) {
    const p = String(t || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    const a = [...p[0]][0] || '';
    const b = p.length > 1 ? [...p[p.length - 1]][0] || '' : '';
    return (a + b).toUpperCase();
  }
  // No botão cabe o primeiro e o último nome; o completo fica no popover e no title.
  function nomeCurto(t) {
    const p = String(t || '').trim().split(/\s+/).filter(Boolean);
    return p.length > 2 ? p[0] + ' ' + p[p.length - 1] : p.join(' ');
  }
  const github = () => (st.perfil && st.perfil.github) || null;

  // Foto do GitHub (servida pelo Orbit) ou iniciais; com GitHub, o selo pequeno no canto.
  function pintarAvatar(alvo, tamSelo) {
    const p = st.perfil, gh = github();
    const sig = gh ? [gh.avatar, gh.login, gh.expirado].join('|') : 'local|' + (p ? p.nome : '');
    if (alvo._sig === sig) return;
    alvo._sig = sig;
    const filhos = [];
    if (gh && gh.avatar) {
      const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => img.replaceWith(document.createTextNode(iniciais(gh.login))), { once: true });
      img.src = gh.avatar;
      filhos.push(img);
    } else filhos.push(document.createTextNode(iniciais(gh ? gh.login : p && p.nome)));
    if (gh && tamSelo) filhos.push(h('span', { class: 'pf-selo' + (gh.expirado ? ' aviso' : '') }, icone(gh.expirado ? 'alerta' : 'github', tamSelo)));
    alvo.replaceChildren(...filhos);
  }

  const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
  const lista = (nomes, max = 3) => nomes.slice(0, max).join(', ') + (nomes.length > max ? ' e mais ' + (nomes.length - max) : '');

  async function postar(caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, { method: 'POST', cache: 'no-store', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    } catch {
      throw new Error('Sem conexão com o servidor do Orbit.');
    }
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok) throw new Error((d && typeof d.erro === 'string' && d.erro) || 'O servidor do Orbit respondeu ' + r.status + '.');
    return d;
  }

  // ───────────────────────────── estado ─────────────────────────────
  function valido(p) {
    return p && typeof p === 'object' && typeof p.nome === 'string' &&
      (p.github == null || (typeof p.github === 'object' && typeof p.github.login === 'string'));
  }
  function aplicar(p) {
    if (!valido(p)) return;
    const tinha = !!github();
    st.perfil = p;
    st.antigo = false;
    if (!tinha && github()) st.desconectado = false;
    render();
  }
  async function carregar() {
    try {
      const r = await fetch('/perfil', { cache: 'no-store' });
      if (r.status === 404) { st.antigo = true; render(); return; }
      if (!r.ok) return;
      aplicar(await r.json());
      if (github()) verificar();
    } catch {}
  }
  // O servidor só reconfere o token de 10 em 10 min; aqui é só pedir.
  function verificar() {
    postar('/perfil/github/verificar').then(aplicar).catch(() => {});
  }

  // Conta do Claude. `agora` relê o `claude auth status` (o servidor guarda o último por 15 s).
  function aplicarCl(d) {
    if (!d || typeof d !== 'object' || !('logado' in d)) return;
    const antes = cl.dados;
    cl.dados = d;
    cl.antigo = false;
    // O login terminou (pelo Orbit, pelo terminal ou pelo VS Code): diz com que conta e o que voltou.
    if (antes && !antes.logado && d.logado && d.email) {
      cl.msg = 'Entrou como ' + d.email + '.' + (d.retomadas ? ' ' + plural(d.retomadas, 'instância do Orbit voltou', 'instâncias do Orbit voltaram') + ' a funcionar.' : '');
      cl.conf = '';
    }
    if (d.falha) cl.msg = '';
    // Enquanto o login está aberto, confere de 3 em 3 s (se um evento do SSE se perder, o fim chega igual).
    clearTimeout(clT);
    if (d.entrando || d.saindo) clT = setTimeout(() => carregarCl(false), 3000);
    render();
    posicionar();
  }
  async function carregarCl(agora) {
    try {
      const r = await fetch('/conta/claude' + (agora ? '?agora' : ''), { cache: 'no-store' });
      if (r.status === 404) { cl.antigo = true; render(); return; }
      if (!r.ok) return;
      aplicarCl(await r.json());
    } catch {}
  }

  // ───────────────────────────── montagem ─────────────────────────────
  function montar() {
    ui.av = botao.querySelector('.perfil-av');
    ui.nome = botao.querySelector('.perfil-nome');
    ui.sub = botao.querySelector('.perfil-sub');
    if (!botao.querySelector('.perfil-seta')) botao.append(h('span', { class: 'perfil-seta' }, icone('seletor', 14)));

    ui.cabAv = h('span', { class: 'perfil-av', 'aria-hidden': 'true' });
    ui.cabNome = h('b');
    ui.cabSub = h('small', { text: 'Este computador' });

    ui.antigo = h('div', { class: 'pf-aviso neutro' }, icone('info', 14), h('span', { text: 'Reinicie o servidor do Orbit para conectar o GitHub.' }));
    ui.inseguro = h('div', { class: 'pf-aviso neutro' }, icone('info', 14), h('span', { text: 'Conectar o GitHub precisa do Windows: o token fica cifrado pela DPAPI.' }));
    ui.desc = h('div', { class: 'pf-aviso neutro', role: 'status' }, icone('info', 14),
      h('span', null, 'Desconectado. O token continua valendo no GitHub até você apagá-lo em ',
        h('a', { href: URL_TOKENS, target: '_blank', rel: 'noopener noreferrer' }, 'Tokens'), '.'));

    ui.cardAv = h('span', { class: 'perfil-av', 'aria-hidden': 'true' });
    ui.cardLogin = h('b');
    ui.cardNome = h('small');
    ui.cardVinc = h('span', { class: 'pf-vinc' });
    ui.card = h('div', { class: 'pf-gh' }, ui.cardAv, h('div', { class: 'pf-gh-txt' }, ui.cardLogin, ui.cardNome), ui.cardVinc);
    ui.expirou = h('div', { class: 'pf-aviso', role: 'status' }, icone('alerta', 14),
      h('span', { text: 'O GitHub recusou o token guardado: ele expirou ou foi revogado. Conecte um token novo.' }));

    ui.conectarRot = h('span', { class: 'pf-item-rot' });
    ui.conectar = h('button', { type: 'button', class: 'pf-item', 'aria-expanded': 'false', 'aria-controls': 'pf-form', onclick: alternarForm },
      icone('github', 15), ui.conectarRot, h('span', { class: 'pf-item-fim' }, icone('chevron', 14)));

    ui.campo = h('input', {
      id: 'pf-token', class: 'pf-campo', type: 'password', placeholder: 'github_pat_…', 'aria-label': 'Token do GitHub',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-1p-ignore': true, 'data-lpignore': 'true',
    });
    // O erro fica até o próximo envio: apagar a cada tecla faria o popover mudar de altura enquanto se digita.
    ui.campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enviar(); } });
    ui.erro = h('p', { class: 'pf-erro', id: 'pf-erro', role: 'alert' });
    ui.enviarRot = h('span', { text: 'Conectar' });
    ui.enviar = h('button', { type: 'button', class: 'btn p solido', onclick: enviar }, ui.enviarRot);
    ui.form = h('div', { class: 'pf-form', id: 'pf-form' },
      h('p', { class: 'pf-dica', text: 'Cole um token de acesso pessoal do GitHub. O Orbit só lê o seu perfil público, então o token não precisa de nenhuma permissão.' }),
      ui.campo, ui.erro,
      h('div', { class: 'pf-acoes' },
        h('a', { class: 'pf-link', href: URL_NOVO_TOKEN, target: '_blank', rel: 'noopener noreferrer' }, 'Criar token no GitHub', icone('externo', 12)),
        ui.enviar),
      h('p', { class: 'pf-nota' }, icone('cadeado', 13), ui.nota = h('span', { text: 'Fica cifrado neste Windows (DPAPI), fora da pasta do projeto. A página nunca recebe o token de volta.' })));

    ui.abrir = h('a', { class: 'pf-item', target: '_blank', rel: 'noopener noreferrer' },
      icone('externo', 15), h('span', { class: 'pf-item-rot', text: 'Abrir perfil no GitHub' }));
    ui.sairRot = h('span', { class: 'pf-item-rot' });
    ui.sair = h('button', { type: 'button', id: 'pf-gh-sair', class: 'pf-item perigo', onclick: clicarSair }, icone('sair', 15), ui.sairRot);
    ui.sair.addEventListener('blur', () => cancelarConfirmar());
    ui.falha = h('p', { class: 'pf-erro', role: 'alert' });
    ui.falha.style.padding = '0 9px 6px';

    // Claude
    ui.clAntigo = h('div', { class: 'pf-aviso neutro' }, icone('info', 14), h('span', { text: 'Reinicie o servidor do Orbit para gerenciar a conta do Claude por aqui.' }));
    ui.clSemLer = h('div', { class: 'pf-aviso neutro' }, icone('info', 14), h('span', { text: 'Não deu para ler a conta do Claude: o Orbit não achou o claude ou ele não respondeu.' }));
    ui.clNada = h('div', { class: 'pf-aviso neutro' }, icone('info', 14), h('span', { text: 'Nenhuma conta do Claude logada.' }));
    ui.clEmail = h('b');
    ui.clPlano = h('small');
    ui.clVinc = h('span', { class: 'pf-vinc' }, icone('check', 12), 'Logada');
    ui.clCard = h('div', { class: 'pf-gh pf-cl' }, h('span', { class: 'perfil-av pf-cl-logo', 'aria-hidden': 'true' }, logoClaude()),
      h('div', { class: 'pf-gh-txt' }, ui.clEmail, ui.clPlano), ui.clVinc);
    ui.clMsgTxt = h('span');
    ui.clMsg = h('div', { class: 'pf-aviso neutro pf-ok', role: 'status' }, icone('check', 14), ui.clMsgTxt);
    ui.clEntUrl = h('a', { class: 'pf-link', target: '_blank', rel: 'noopener noreferrer' }, 'Abrir a página de novo', icone('externo', 12));
    ui.clEntCancelar = h('button', { type: 'button', class: 'pf-link', onclick: cancelarEntrar }, 'Cancelar');
    ui.clEntrando = h('div', { class: 'pf-aviso neutro pf-cl-ent', role: 'status' }, h('span', { class: 'pf-girar claro', 'aria-hidden': 'true' }),
      h('div', null, h('span', { text: 'Termine o login no navegador que o Orbit abriu.' }), h('div', { class: 'pf-cl-ent-acoes' }, ui.clEntUrl, ui.clEntCancelar)));
    ui.clEntrarRot = h('span', { class: 'pf-item-rot', text: 'Entrar no Claude' });
    ui.clEntrar = h('button', { type: 'button', class: 'pf-item', onclick: entrarCl }, icone('entrar', 15), ui.clEntrarRot);
    ui.clTrocar = h('button', { type: 'button', class: 'pf-item', 'aria-expanded': 'false', onclick: () => pedirConf('trocar') }, icone('trocar', 15), h('span', { class: 'pf-item-rot', text: 'Trocar de conta' }));
    ui.clSair = h('button', { type: 'button', class: 'pf-item perigo', 'aria-expanded': 'false', onclick: () => pedirConf('sair') }, icone('sair', 15), h('span', { class: 'pf-item-rot', text: 'Sair da conta' }));
    ui.clConf = h('div', { class: 'pf-conf', role: 'group', tabindex: '-1' });
    ui.clFalha = h('p', { class: 'pf-erro', role: 'alert' });
    ui.clFalha.style.padding = '0 9px 6px';
    ui.clNota = h('p', { class: 'pf-nota pf-cl-nota' }, icone('info', 13),
      h('span', { text: 'O login vale para este usuário do computador inteiro: terminal, VS Code e instâncias do Orbit usam a mesma conta.' }));

    ui.pop = h('div', { class: 'perfil-pop', id: 'perfil-pop', role: 'dialog', 'aria-label': 'Perfil', hidden: true },
      h('div', { class: 'pf-cab' }, ui.cabAv, h('div', { class: 'pf-cab-txt' }, ui.cabNome, ui.cabSub)),
      h('div', { class: 'pf-sep' }),
      h('div', { class: 'pf-rot', text: 'Claude' }),
      ui.clAntigo, ui.clSemLer, ui.clNada, ui.clCard, ui.clMsg, ui.clEntrando, ui.clEntrar, ui.clTrocar, ui.clSair, ui.clConf, ui.clFalha, ui.clNota,
      h('div', { class: 'pf-sep' }),
      h('div', { class: 'pf-rot', text: 'GitHub' }),
      ui.antigo, ui.inseguro, ui.desc, ui.card, ui.expirou, ui.conectar, ui.form, ui.abrir, ui.sair, ui.falha);
    ui.pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Com a confirmação da conta aberta, o Esc só a fecha.
      if (cl.conf && !cl.ocupado) return fecharConf(true);
      fechar(true);
    });
    document.body.append(ui.pop);
    botao.setAttribute('aria-controls', 'perfil-pop');

    botao.addEventListener('click', () => (st.aberto ? fechar(true) : abrir()));
    document.addEventListener('pointerdown', (e) => {
      if (st.aberto && !ui.pop.contains(e.target) && !botao.contains(e.target)) fechar(false);
    }, true);
    addEventListener('resize', posicionar);
  }

  // ───────────────────────────── desenho ─────────────────────────────
  function render() {
    const p = st.perfil, gh = github();
    const nomeLocal = (p && p.nome) || 'Perfil';

    // Botão da lateral
    pintarAvatar(ui.av, 10);
    txt(ui.nome, gh ? gh.login : nomeCurto(nomeLocal));
    txt(ui.sub, gh ? (gh.expirado ? 'Token do GitHub expirou' : 'GitHub') : 'Conta local');
    ui.sub.classList.toggle('aviso', !!(gh && gh.expirado));
    botao.title = gh ? gh.login + (gh.nome ? ' · ' + gh.nome : '') + ' — conta do GitHub vinculada' : nomeLocal + ' — perfil';
    botao.setAttribute('aria-label', 'Perfil: ' + (gh ? gh.login + ', GitHub vinculado' + (gh.expirado ? ' (token expirado)' : '') : nomeLocal));
    if (!st.aberto) return;

    // Popover
    renderCl();
    pintarAvatar(ui.cabAv, 11);
    txt(ui.cabNome, nomeLocal);
    ui.cabNome.title = nomeLocal;
    const pode = !st.antigo && !!p && p.seguro !== false;
    ui.antigo.hidden = !st.antigo;
    ui.inseguro.hidden = st.antigo || !p || p.seguro !== false;
    // Mac: o servidor diz onde o token fica (guardado: 'chaveiro'); sem o campo, o texto do Windows.
    if (p && p.guardado === 'chaveiro') txt(ui.nota, 'Fica no Chaveiro deste Mac, fora da pasta do projeto. A página nunca recebe o token de volta.');
    ui.desc.hidden = !pode || !!gh || !st.desconectado;
    ui.card.hidden = !gh;
    ui.expirou.hidden = !(gh && gh.expirado);
    ui.abrir.hidden = !gh;
    ui.sair.hidden = !gh;
    if (gh) {
      pintarAvatar(ui.cardAv, 0);
      txt(ui.cardLogin, gh.login);
      txt(ui.cardNome, gh.nome || 'github.com/' + gh.login);
      ui.cardLogin.title = gh.login;
      ui.cardNome.title = gh.nome || '';
      ui.cardVinc.classList.toggle('aviso', !!gh.expirado);
      const vinc = gh.expirado ? 'Expirou' : 'Vinculada';
      if (ui.cardVinc._v !== vinc) { ui.cardVinc._v = vinc; ui.cardVinc.replaceChildren(icone(gh.expirado ? 'alerta' : 'check', 12), vinc); }
      ui.abrir.href = 'https://github.com/' + encodeURIComponent(gh.login);
      txt(ui.sairRot, st.saindo ? 'Desconectando…' : st.confirmar ? 'Clique de novo para desconectar' : 'Desconectar');
      ui.sair.classList.toggle('confirmar', st.confirmar);
      ui.sair.disabled = st.saindo;
    }
    // "Conectar" quando não há conta; "Trocar o token" quando o guardado expirou.
    ui.conectar.hidden = !pode || (!!gh && !gh.expirado);
    txt(ui.conectarRot, gh ? 'Conectar um token novo' : 'Conectar conta do GitHub');
    const comForm = !ui.conectar.hidden && st.form;
    ui.form.hidden = !comForm;
    ui.conectar.setAttribute('aria-expanded', String(comForm));
    txt(ui.erro, st.erro);
    ui.erro.hidden = !st.erro;
    ui.campo.setAttribute('aria-invalid', String(!!st.erro));
    if (st.erro) ui.campo.setAttribute('aria-describedby', 'pf-erro'); else ui.campo.removeAttribute('aria-describedby');
    ui.campo.disabled = st.enviando;
    ui.enviar.disabled = st.enviando;
    if (st.enviando !== !!ui.enviar._gira) {
      ui.enviar._gira = st.enviando;
      ui.enviar.replaceChildren(...(st.enviando ? [h('span', { class: 'pf-girar', 'aria-hidden': 'true' }), 'Conferindo…'] : [ui.enviarRot]));
    }
    txt(ui.falha, st.falha);
    ui.falha.hidden = !st.falha;
  }

  function renderCl() {
    const d = cl.dados;
    const conhecido = !cl.antigo && !!d && d.logado != null;
    const logado = conhecido && d.logado === true;
    const entrando = conhecido && !!d.entrando;
    const ocupado = !!cl.ocupado || (conhecido && d.saindo);
    ui.clAntigo.hidden = !cl.antigo;
    ui.clSemLer.hidden = cl.antigo || !d || d.logado != null;
    ui.clNada.hidden = !conhecido || logado || entrando;
    ui.clCard.hidden = !logado;
    if (logado) {
      txt(ui.clEmail, d.email || 'Conta do Claude');
      ui.clEmail.title = d.email || '';
      const sub = [d.plano ? 'Plano ' + d.plano : d.metodo === 'claude.ai' ? 'Assinatura do Claude' : d.metodo ? 'Login: ' + d.metodo : '', d.org].filter(Boolean).join(' · ');
      txt(ui.clPlano, sub);
      ui.clPlano.title = sub;
    }
    ui.clMsg.hidden = !cl.msg;
    txt(ui.clMsgTxt, cl.msg);
    ui.clEntrando.hidden = !entrando;
    if (entrando) {
      ui.clEntUrl.hidden = !d.entrando.url;
      if (d.entrando.url) ui.clEntUrl.href = d.entrando.url;
    }
    ui.clEntrar.hidden = !conhecido || logado || entrando;
    ui.clEntrar.disabled = ocupado;
    txt(ui.clEntrarRot, cl.ocupado === 'entrar' ? 'Abrindo o login…' : 'Entrar no Claude');
    ui.clTrocar.hidden = !logado || (!!cl.conf && cl.conf !== 'trocar');
    ui.clSair.hidden = !logado || (!!cl.conf && cl.conf !== 'sair');
    ui.clTrocar.disabled = ui.clSair.disabled = ocupado;
    ui.clTrocar.setAttribute('aria-expanded', String(cl.conf === 'trocar'));
    ui.clSair.setAttribute('aria-expanded', String(cl.conf === 'sair'));
    ui.clConf.hidden = !logado || !cl.conf;
    if (!ui.clConf.hidden) desenharConf();
    const falha = cl.falha || (conhecido && d.falha) || '';
    txt(ui.clFalha, falha);
    ui.clFalha.hidden = !falha;
    ui.clNota.hidden = cl.antigo || !ui.clConf.hidden; // a confirmação já diz o mesmo
  }

  // Confirmação de sair/trocar: o que está em andamento e o que acontece com cada coisa.
  function desenharConf() {
    const d = cl.dados || {};
    const em = d.emAndamento || { orbit: [], fora: [] };
    const orbit = Array.isArray(em.orbit) ? em.orbit : [];
    const fora = Array.isArray(em.fora) ? em.fora : [];
    const trocar = cl.conf === 'trocar';
    const sig = [cl.conf, cl.ocupado, JSON.stringify(orbit), JSON.stringify(fora)].join('|');
    if (ui.clConf._sig === sig) return;
    const focoDentro = ui.clConf.contains(document.activeElement);
    ui.clConf._sig = sig;
    const ocup = orbit.filter((o) => o.ocupada).map((o) => o.nome);
    const linhas = [];
    if (orbit.length) {
      linhas.push(h('li', null, h('b', { text: 'No Orbit: ' }), plural(orbit.length, 'instância aberta', 'instâncias abertas') +
        (ocup.length ? ', ' + plural(ocup.length, 'trabalhando', 'trabalhando') + ' (' + lista(ocup) + ')' : '') + '. ' +
        'Pausando, as que estão respondendo são interrompidas; todas dormem e voltam sozinhas depois do ' + (trocar ? 'login na outra conta' : 'novo login') + '. Sem pausar, podem parar com erro de login.'));
    }
    if (fora.length) {
      linhas.push(h('li', null, h('b', { text: 'No VS Code ou no terminal: ' }), plural(fora.length, 'sessão trabalhando', 'sessões trabalhando') + ' (' + lista(fora) + '). ' +
        'O Orbit não controla essas sessões: elas podem parar com erro de login.'));
    }
    if (!orbit.length && !fora.length) linhas.push(h('li', null, 'Nenhuma instância em andamento agora.'));
    linhas.push(h('li', null, 'Os logins dos conectores MCP feitos pelo Claude podem precisar ser refeitos.'));
    const rotulo = cl.ocupado === 'pausar' ? (trocar ? 'Pausando e trocando…' : 'Pausando e saindo…') : cl.ocupado === 'sair' ? (trocar ? 'Saindo para trocar…' : 'Saindo…') : '';
    const botao = (rot, cls, pausar, girando) => h('button', { type: 'button', class: 'btn p ' + cls, disabled: !!cl.ocupado, onclick: () => confirmarSair(pausar) },
      girando ? h('span', { class: 'pf-girar' + (cls.includes('solido') ? '' : ' claro'), 'aria-hidden': 'true' }) : null, girando ? rotulo : rot);
    const acoes = [];
    if (orbit.length) {
      acoes.push(botao(trocar ? 'Pausar as instâncias do Orbit e trocar' : 'Pausar as instâncias do Orbit e sair', 'solido', true, cl.ocupado === 'pausar'));
      acoes.push(botao(trocar ? 'Trocar sem pausar' : 'Sair sem pausar', 'perigo', false, cl.ocupado === 'sair'));
    } else acoes.push(botao(trocar ? 'Sair e entrar com outra conta' : 'Sair da conta', 'perigo', false, cl.ocupado === 'sair'));
    acoes.push(h('button', { type: 'button', class: 'btn p contorno', disabled: !!cl.ocupado, onclick: () => fecharConf(true) }, 'Cancelar'));
    ui.clConf.setAttribute('aria-label', trocar ? 'Confirmar a troca de conta do Claude' : 'Confirmar a saída da conta do Claude');
    ui.clConf.replaceChildren(
      h('b', { class: 'pf-conf-tit', text: trocar ? 'Trocar de conta do Claude?' : 'Sair da conta do Claude?' }),
      h('p', { class: 'pf-conf-txt', text: trocar
        ? 'O Orbit sai desta conta e abre o login oficial no navegador. Até você entrar, o terminal, o VS Code e o Orbit ficam sem login neste usuário do computador.'
        : 'Vale para este usuário do computador inteiro: o terminal, o VS Code e o Orbit ficam sem login até você entrar de novo.' }),
      h('ul', { class: 'pf-conf-lista' }, ...linhas),
      h('div', { class: 'pf-conf-acoes' }, ...acoes));
    // Redesenhar troca os botões: o foco que estava dentro volta para o primeiro.
    if (focoDentro) (ui.clConf.querySelector('.pf-conf-acoes .btn:not(:disabled)') || ui.clConf).focus({ preventScroll: true });
  }

  // Acima do botão (lateral aberta), à direita do avatar (recolhida) ou abaixo (barra do topo).
  // Ancorado pela borda perto do botão (bottom ou top no CSS): quando o conteúdo muda de altura,
  // a borda ancorada fica parada e nada pula embaixo do cursor.
  function posicionar() {
    if (!st.aberto) return;
    const r = botao.getBoundingClientRect();
    const w = ui.pop.offsetWidth, m = 12, vw = innerWidth, vh = innerHeight;
    const estreita = vw < 1100;
    const recolhida = !estreita && document.body.classList.contains('lat-recolhida');
    const s = ui.pop.style;
    let x;
    if (estreita) {
      x = r.right - w;
      const top = Math.round(r.bottom + 8);
      Object.assign(s, { top: top + 'px', bottom: 'auto', maxHeight: Math.max(160, vh - top - m) + 'px' });
    } else {
      x = recolhida ? r.right + 12 : r.left;
      const base = Math.round(recolhida ? r.bottom : r.top - 8);
      Object.assign(s, { top: 'auto', bottom: Math.max(m, vh - base) + 'px', maxHeight: Math.max(160, Math.min(base, vh - m) - m) + 'px' });
    }
    ui.pop.classList.toggle('abaixo', estreita);
    s.left = Math.round(Math.max(m, Math.min(x, vw - w - m))) + 'px';
  }

  // ───────────────────────────── ações ─────────────────────────────
  function abrir() {
    st.aberto = true;
    st.falha = '';
    ui.pop.hidden = false;
    botao.setAttribute('aria-expanded', 'true');
    render();
    posicionar();
    const primeiro = [ui.clEntrar, ui.clTrocar, ui.conectar, ui.abrir, ui.sair].find((b) => !b.hidden);
    (primeiro || ui.pop).focus({ preventScroll: true });
    if (github()) verificar();
    carregarCl(true);
  }
  function fechar(devolverFoco) {
    if (!st.aberto) return;
    st.aberto = false;
    ui.pop.hidden = true;
    botao.setAttribute('aria-expanded', 'false');
    ui.campo.value = '';
    Object.assign(st, { form: false, erro: '', falha: '', desconectado: false });
    if (!cl.ocupado) Object.assign(cl, { conf: '', msg: '', falha: '' });
    cancelarConfirmar();
    if (devolverFoco) botao.focus({ preventScroll: true });
  }
  function alternarForm() {
    st.form = !st.form;
    st.erro = '';
    if (!st.form) ui.campo.value = '';
    render();
    posicionar();
    if (st.form) ui.campo.focus({ preventScroll: true });
  }
  async function enviar() {
    if (st.enviando) return;
    const token = ui.campo.value.trim();
    if (!token) {
      st.erro = 'Cole o token do GitHub.';
      render();
      ui.campo.focus();
      return;
    }
    st.enviando = true;
    st.erro = '';
    render();
    try {
      const p = await postar('/perfil/github', { token });
      ui.campo.value = '';
      st.form = false;
      st.enviando = false;
      aplicar(p);
      posicionar();
      if (st.aberto) ui.abrir.focus({ preventScroll: true });
    } catch (e) {
      st.enviando = false;
      st.erro = e.message;
      render();
      ui.campo.focus();
    }
  }
  function cancelarConfirmar() {
    clearTimeout(confirmarT);
    if (!st.confirmar) return;
    st.confirmar = false;
    render();
  }
  // Dois cliques: o primeiro arma (4 s), o segundo desconecta.
  function clicarSair() {
    if (st.saindo) return;
    if (!st.confirmar) {
      st.confirmar = true;
      render();
      clearTimeout(confirmarT);
      confirmarT = setTimeout(cancelarConfirmar, MS_CONFIRMAR);
      return;
    }
    clearTimeout(confirmarT);
    st.confirmar = false;
    st.saindo = true;
    st.falha = '';
    render();
    postar('/perfil/github/desconectar').then((p) => {
      st.saindo = false;
      st.desconectado = true;
      aplicar(p);
      posicionar();
      if (st.aberto) ui.conectar.focus({ preventScroll: true });
    }).catch((e) => {
      st.saindo = false;
      st.falha = e.message;
      render();
    });
  }

  // ── conta do Claude ──
  function pedirConf(tipo) {
    if (cl.ocupado) return;
    if (cl.conf === tipo) return fecharConf(true);
    cl.conf = tipo;
    cl.msg = '';
    cl.falha = '';
    ui.clConf._sig = '';
    render();
    posicionar();
    const primeiro = ui.clConf.querySelector('.pf-conf-acoes .btn');
    if (primeiro) primeiro.focus({ preventScroll: true });
    carregarCl(true); // o que está em andamento, lido agora
  }
  function fecharConf(devolverFoco) {
    if (!cl.conf || cl.ocupado) return;
    const de = cl.conf === 'trocar' ? ui.clTrocar : ui.clSair;
    cl.conf = '';
    render();
    posicionar();
    if (devolverFoco && !de.hidden) de.focus({ preventScroll: true });
  }
  async function confirmarSair(pausar) {
    if (cl.ocupado) return;
    const trocar = cl.conf === 'trocar';
    cl.ocupado = pausar ? 'pausar' : 'sair';
    cl.falha = '';
    render();
    try {
      const d = await postar('/conta/claude/sair', { pausar, entrar: trocar });
      cl.ocupado = '';
      cl.conf = '';
      const n = (d.pausa && d.pausa.pausadas) || 0;
      const nf = (d.pausa && d.pausa.falharam) || 0;
      cl.msg = (trocar ? 'Você saiu da conta.' : 'Você saiu da conta do Claude.') +
        (n ? ' ' + plural(n, 'instância do Orbit pausada', 'instâncias do Orbit pausadas') + ': ' + (n === 1 ? 'volta' : 'voltam') + ' depois do novo login.' : '') +
        (nf ? ' ' + plural(nf, 'instância não parou', 'instâncias não pararam') + ' a tempo.' : '');
      aplicarCl(d);
      const alvo = trocar ? ui.clEntCancelar : ui.clEntrar;
      if (st.aberto && !alvo.hidden) alvo.focus({ preventScroll: true });
    } catch (e) {
      cl.ocupado = '';
      cl.falha = e.message;
      ui.clConf._sig = '';
      render();
    }
  }
  async function entrarCl() {
    if (cl.ocupado) return;
    cl.ocupado = 'entrar';
    cl.falha = '';
    cl.msg = '';
    render();
    try {
      const d = await postar('/conta/claude/entrar', {});
      cl.ocupado = '';
      aplicarCl(d);
      if (st.aberto && !ui.clEntCancelar.hidden) ui.clEntCancelar.focus({ preventScroll: true });
    } catch (e) {
      cl.ocupado = '';
      cl.falha = e.message;
      render();
    }
  }
  function cancelarEntrar() {
    postar('/conta/claude/entrar/cancelar').then((d) => {
      cl.msg = '';
      aplicarCl(d);
      if (st.aberto && !ui.clEntrar.hidden) ui.clEntrar.focus({ preventScroll: true });
    }).catch((e) => { cl.falha = e.message; render(); });
  }

  montar();
  render();
  carregar();
  carregarCl(false);
  if (api && typeof api.on === 'function') {
    api.on('perfil', aplicar);
    api.on('contaClaudeAuth', aplicarCl);
    api.on('contaClaude', () => carregarCl(true)); // login ou logout pelo terminal ou pelo VS Code
    api.on('conexao', (estado) => { if (estado === 'vivo') { carregar(); carregarCl(false); } });
  }
})();
