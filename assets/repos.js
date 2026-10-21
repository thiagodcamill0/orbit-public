/* Repositórios — gestão dos repositórios do GitHub (servidor: repos.mjs; rodada 7).
 *
 * Integração (encaixe do Mestre no index.html): na 1ª vez que a vista abre, carregar assets/repos.css e
 * este arquivo e chamar window.Repos.montar(el, api), com el = #repos (irmão de .conteudo dentro de
 * main#rolar) e api = window.GerenciadorAPI (usa on('repos' | 'perfil' | 'conexao')). Ao sair da vista,
 * Repos.pausar(); ao voltar, Repos.retomar().
 *
 * Regras: texto do servidor só por textContent; o que mexe no remoto ou pode perder alterações passa pelo
 * 409 { codigo:'confirmar' } do servidor (a página nunca manda confirmar:true sem o diálogo); links do
 * GitHub montados aqui a partir de dono/nome validados. Diálogos, popovers e toasts ficam no <body>
 * (classes rp-*) e somem em pausar().
 */
(function () {
  'use strict';
  if (window.Repos) return;

  // A página roda no navegador da própria máquina: no Mac, exemplos e instruções do Mac (16/10).
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const URL_TOKENS = 'https://github.com/settings/personal-access-tokens';
  const DESC_TOKEN = 'Orbit: repositórios (listar, clonar, enviar, criar)';
  const MS_STATUS = 15000;
  const MS_REL = 30000;
  const MS_CONFERIR = 3 * 60 * 1000;
  const MAX_REPOS = 150;
  const RE_DONO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const RE_NOME = /^[A-Za-z0-9._-]{1,100}$/;
  // Atalhos da página que agiriam na lista escondida da Visão geral (seleção, peek, remover, VS Code).
  const BLOQUEAR = new Set(['j', 'k', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Enter', 'n', 'p', 'm', 'h', 'r', 'c', 'x', 'X', 'o', 'e', 'Backspace', 'Delete']);

  const OPS = { commit: 'Fazendo commit…', push: 'Enviando…', pull: 'Recebendo…', mesclar: 'Mesclando…', buscar: 'Buscando…', branch: 'Trocando de branch…', vincular: 'Vinculando…', desvincular: 'Desvinculando…', criar: 'Criando no GitHub…', remover: 'Tirando da lista…' };
  const NOME_OPERACAO = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };
  const LETRA = { modificado: 'M', novo: 'A', apagado: 'D', renomeado: 'R', conflito: 'U', 'nao-rastreado': '?' };
  const NOME_TIPO = { modificado: 'Modificado', novo: 'Novo (adicionado)', apagado: 'Apagado', renomeado: 'Renomeado', conflito: 'Em conflito', 'nao-rastreado': 'Novo, ainda não rastreado' };
  const VIS = { publico: 'Público', privado: 'Privado', interno: 'Interno' };
  const GRUPOS = ['atencao', 'emdia', 'semrepo', 'outros'];
  const NOME_GRUPO = { atencao: 'Pedem atenção', emdia: 'Em dia', semrepo: 'Sem repositório', outros: 'Outros' };
  const FASES = [[/count/i, 'Contando objetos'], [/compress/i, 'Comprimindo'], [/receiv/i, 'Recebendo objetos'], [/resolv/i, 'Resolvendo diferenças'], [/(updat|check)/i, 'Gravando arquivos'], [/enumer/i, 'Listando objetos'], [/inici/i, 'Começando']];
  const ERROS = {
    ocupado: 'Outra operação está rodando nesta pasta. Espere terminar e tente de novo.',
    orbit: 'Contém o Orbit e outros projetos; fica fora do git.',
    'sem-git': MAC ? 'O Git não foi encontrado neste computador. Instale pelo Terminal (xcode-select --install) e reinicie o Orbit.' : 'O Git não foi encontrado neste computador. Instale o Git for Windows e reinicie o Orbit.',
    'sem-github': 'Conecte o GitHub no seu perfil para continuar.',
    expirado: 'O token do GitHub expirou ou foi revogado. Conecte um token novo pelo perfil.',
    permissao: 'O token do GitHub não tem permissão para isso.',
    rede: 'O GitHub não respondeu. Confira a internet e tente de novo.',
    nada: 'Nada a fazer: não há o que commitar ou enviar.',
    operacao: 'Há um merge, rebase ou conflito em andamento. Resolva no editor antes.',
    hook: 'Um hook do repositório recusou o commit.',
    rejeitado: 'O GitHub tem commits que você ainda não tem. Receba antes de enviar.',
    destacado: 'Você não está em nenhum branch (HEAD destacado). Troque para um branch antes de enviar.',
    'sem-upstream': 'Este branch ainda não existe no GitHub. Envie primeiro para criá-lo.',
    divergiu: 'Seu branch e o do GitHub divergiram.',
    sobrescreveria: 'O git recusou para não sobrescrever alterações locais. Nada mudou.',
    sujo: 'Para mesclar, faça commit das alterações antes.',
    conflito: 'A mesclagem daria conflito; foi desfeita e nada mudou.',
    existe: 'Já existe uma pasta com esse nome e ela não está vazia.',
    'nome-em-uso': 'Já existe um repositório com esse nome na sua conta.',
    'ja-vinculado': 'Esta pasta já tem um origin. Use Vincular para trocá-lo.',
    parcial: 'O repositório foi criado no GitHub, mas uma etapa falhou.',
  };

  const st = {
    montado: false, ativo: false, el: null, api: null,
    aba: 'projetos', conexao: 'vivo',
    lista: null, erroLista: null, carregando: false, pendente: false, lidoEm: 0,
    pastaClones: '', github: { conectado: false, login: '', expirado: false }, githubConhecido: false,
    aberto: null, fixo: null, buscaProj: '',
    ocupado: new Map(), desmarcados: new Map(), avisos: new Map(), conferido: new Map(),
    repos: null, reposErro: null, reposCarregando: false, reposLido: 0, reposVelho: false, busca: '', vis: 'todos', limite: MAX_REPOS,
    perm: { aberto: false, destaque: false, faltando: [] },
    clones: new Map(),
  };
  const ui = { cartoes: new Map(), memo: new Map(), progs: new Map(), pop: null };
  const pilha = [];
  let seq = 0;
  const novoId = (p) => 'rp-' + p + '-' + (++seq);

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
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const reduzido = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
  function rel(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'agora';
    const m = Math.round(s / 60);
    if (m < 60) return 'há ' + m + ' min';
    const hh = Math.round(m / 60);
    if (hh < 24) return 'há ' + hh + ' h';
    const d = Math.round(hh / 24);
    if (d < 30) return 'há ' + d + ' d';
    const mes = Math.round(d / 30.4);
    if (mes < 12) return 'há ' + mes + (mes === 1 ? ' mês' : ' meses');
    const a = Math.round(d / 365);
    return 'há ' + a + (a === 1 ? ' ano' : ' anos');
  }
  function dataCompleta(ms) { try { return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; } }
  function letra(nome) { const c = [...String(nome || '').trim()][0]; return c ? c.toUpperCase() : '?'; }
  function caminhoCurto(c) {
    const s = String(c || '');
    const sep = s.includes('\\') ? '\\' : '/';
    const partes = s.split(/[\\/]+/).filter(Boolean);
    if (partes.length <= 3) return s;
    const raiz = /^[A-Za-z]:$/.test(partes[0]) ? partes[0] : s.startsWith(sep) ? '' : partes[0];
    return raiz + sep + '…' + sep + partes.slice(-2).join(sep);
  }
  const normCaminho = (c) => String(c || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  function juntar(base, nome) {
    const b = String(base || '').replace(/[\\/]+$/, '');
    const sep = b.includes('/') && !b.includes('\\') ? '/' : '\\';
    return b ? b + sep + nome : nome;
  }
  const limparCaminho = (v) => String(v || '').trim().replace(/^"(.*)"$/, '$1').trim();
  function primeiraLinha(t) { const l = String(t || '').split('\n')[0].trim(); return l.length > 72 ? l.slice(0, 71) + '…' : l; }
  const digitando = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  function partesRepo(r) {
    if (!r) return null;
    let dono = str(r.dono), nome = str(r.nome);
    if ((!dono || !nome) && str(r.completo).includes('/')) [dono, nome] = r.completo.split('/');
    return RE_DONO.test(dono) && RE_NOME.test(nome) ? { dono, nome } : null;
  }
  function urlRepo(r) { const p = partesRepo(r); return p ? 'https://github.com/' + p.dono + '/' + p.nome : null; }
  const remotoCurto = (u) => String(u || '').replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '');
  function nomeSugerido(n) {
    const s = norm(n).replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return s.slice(0, 100) || 'novo-repositorio';
  }
  function abrirPerfil() { const b = document.getElementById('btn-perfil'); if (b) b.click(); }
  function abrirUrl(u) { if (u && /^https:\/\/github\.com\//.test(u)) window.open(u, '_blank', 'noopener,noreferrer'); }

  // Mesmo traço dos ícones da página (16 × 16, linha 1,5).
  const NS = 'http://www.w3.org/2000/svg';
  const PASTA = ['path', { d: 'M2.5 4.8A1.3 1.3 0 0 1 3.8 3.5h2.6l1.5 1.6h4.3a1.3 1.3 0 0 1 1.3 1.3v5.3a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3z' }];
  const ICONES = {
    github: [['path', { d: 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z', fill: 'currentColor', stroke: 'none' }]],
    pasta: [PASTA],
    pastaMais: [PASTA, ['path', { d: 'M8 7.4v3.4M6.3 9.1h3.4' }]],
    repo: [['path', { d: 'M3.5 12.5v-9a1 1 0 0 1 1-1h8v9.5h-8a1 1 0 0 0-1 1 1 1 0 0 0 1 1h8' }]],
    cadeado: [['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.2 }], ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }]],
    branch: [['circle', { cx: 5, cy: 3.75, r: 1.25 }], ['circle', { cx: 5, cy: 12.25, r: 1.25 }], ['circle', { cx: 11, cy: 5.25, r: 1.25 }], ['path', { d: 'M5 5v6' }], ['path', { d: 'M11 6.5c0 2.6-2.2 3-4.6 3.9L5 11' }]],
    sobe: [['path', { d: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7' }]],
    desce: [['path', { d: 'M8 3.5v9M4.5 9 8 12.5 11.5 9' }]],
    check: [['path', { d: 'M3.5 8.5l3 3 6-7' }]],
    buscar: [['path', { d: 'M13 7.5A5 5 0 0 0 4.2 4.6L3 6' }], ['path', { d: 'M3 3v3h3' }], ['path', { d: 'M3 8.5a5 5 0 0 0 8.8 2.9L13 10' }], ['path', { d: 'M13 13v-3h-3' }]],
    externo: [['path', { d: 'M9.5 2.5h4v4M13.5 2.5 7.8 8.2' }], ['path', { d: 'M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3' }]],
    mais: [['circle', { cx: 3.5, cy: 8, r: 1, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 8, cy: 8, r: 1, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12.5, cy: 8, r: 1, fill: 'currentColor', stroke: 'none' }]],
    chevron: [['path', { d: 'M6 3.8 10.2 8 6 12.2' }]],
    baixo: [['path', { d: 'M4.5 6.5 8 10l3.5-3.5' }]],
    busca: [['circle', { cx: 7, cy: 7, r: 4.25 }], ['path', { d: 'M10.2 10.2 13.5 13.5' }]],
    clonar: [['path', { d: 'M8 2.5v7.5M5 7.2 8 10.2l3-3' }], ['path', { d: 'M2.5 10.5v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5' }]],
    link: [['path', { d: 'M6.6 9.4a2.5 2.5 0 0 0 3.6 0l2.3-2.3a2.5 2.5 0 0 0-3.6-3.6l-.9.9' }], ['path', { d: 'M9.4 6.6a2.5 2.5 0 0 0-3.6 0L3.5 8.9a2.5 2.5 0 0 0 3.6 3.6l.9-.9' }]],
    desvincular: [['path', { d: 'M9.9 4.1l.4-.4a2.5 2.5 0 0 1 3.6 3.6l-.9.9' }], ['path', { d: 'M6.1 11.9l-.4.4a2.5 2.5 0 0 1-3.6-3.6l.9-.9' }], ['path', { d: 'M3 3l10 10' }]],
    commit: [['circle', { cx: 8, cy: 8, r: 2.5 }], ['path', { d: 'M1.5 8h4M10.5 8h4' }]],
    mais1: [['path', { d: 'M8 3.5v9M3.5 8h9' }]],
    x: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
    fork: [['circle', { cx: 4.5, cy: 3.5, r: 1.25 }], ['circle', { cx: 11.5, cy: 3.5, r: 1.25 }], ['circle', { cx: 8, cy: 12.5, r: 1.25 }], ['path', { d: 'M4.5 4.75V6a1.5 1.5 0 0 0 1.5 1.5h4A1.5 1.5 0 0 0 11.5 6V4.75M8 7.5v3.75' }]],
    arquivado: [['rect', { x: 2.5, y: 3, width: 11, height: 3, rx: 0.8 }], ['path', { d: 'M3.5 6v6.2a.8.8 0 0 0 .8.8h7.4a.8.8 0 0 0 .8-.8V6M6.5 8.5h3' }]],
    alerta: [['path', { d: 'M8 2.5 14 13H2z' }], ['path', { d: 'M8 6.5v3' }], ['circle', { cx: 8, cy: 11.3, r: 0.5, fill: 'currentColor', stroke: 'none' }]],
    info: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M8 7.3v3.7' }], ['circle', { cx: 8, cy: 5, r: 0.55, fill: 'currentColor', stroke: 'none' }]],
    copiar: [['rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }], ['path', { d: 'M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5' }]],
    tirar: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M5.5 8h5' }]],
    escudo: [['path', { d: 'M8 2l5 1.8V8c0 2.8-2.1 5-5 6-2.9-1-5-3.2-5-6V3.8z' }], ['path', { d: 'M6 8.2l1.5 1.5L10.2 7' }]],
    nuvem: [['path', { d: 'M4.6 12.5h6.8a2.6 2.6 0 0 0 .5-5.15A3.9 3.9 0 0 0 4.4 7.8a2.35 2.35 0 0 0 .2 4.7z' }]],
  };
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
  const gira = () => h('span', { class: 'rp-gira', 'aria-hidden': 'true' });

  // Botão com ícone, rótulo, contador e spinner; só redesenha quando muda (o foco fica).
  function rotular(b, o) {
    const sig = [o.ico, o.rot, o.n, o.tom, o.gira, o.fim].join('|');
    if (b._sig !== sig) {
      b._sig = sig;
      b.replaceChildren(...[
        o.gira ? gira() : o.ico ? icone(o.ico, 14) : null,
        o.rot ? h('span', { class: 'rp-rot', text: o.rot }) : null,
        o.n ? h('span', { class: 'rp-badge' + (o.tom ? ' ' + o.tom : ''), text: String(o.n) }) : null,
        o.fim ? icone(o.fim, 12) : null,
      ].filter(Boolean));
    }
    if (o.aria) b.setAttribute('aria-label', o.aria);
    if (o.titulo != null) b.title = o.titulo;
  }
  // Desabilitado por aria (não tira o foco do botão durante a operação).
  function desab(b, sim) { b.setAttribute('aria-disabled', sim ? 'true' : 'false'); }
  const inerte = (b) => b && b.getAttribute('aria-disabled') === 'true';
  function botaoGira(b, sim, rot) { desab(b, sim); b.replaceChildren(...(sim ? [gira(), rot] : [rot])); }

  function memo(chave, sig, criar) {
    const s = String(sig);
    const m = ui.memo.get(chave);
    if (m && m.sig === s) return m.no;
    const no = criar();
    ui.memo.set(chave, { sig: s, no });
    return no;
  }
  // Põe os filhos na ordem pedida movendo só o necessário; devolve o foco se um nó com foco andou.
  function reconciliar(pai, nos) {
    const ativo = document.activeElement;
    nos.forEach((n, i) => { if (pai.childNodes[i] !== n) pai.insertBefore(n, pai.childNodes[i] || null); });
    while (pai.childNodes.length > nos.length) pai.lastChild.remove();
    if (ativo && ativo !== document.activeElement && ativo.isConnected) ativo.focus({ preventScroll: true });
  }
  function focoChave() {
    const a = document.activeElement;
    return a && a.dataset && a.dataset.foco && st.el && st.el.contains(a) ? a.dataset.foco : null;
  }
  function restaurarFoco(chave) {
    if (!chave) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const alvo = st.el.querySelector('[data-foco="' + CSS.escape(chave) + '"]');
    if (alvo) alvo.focus({ preventScroll: true });
  }
  function relEl(ms, pre, tit, classe) { const s = h('span', { class: classe || 'rp-rel' }); setRel(s, ms, pre, tit); return s; }
  function setRel(el, ms, pre, tit, vazio) {
    if (!ms) { txt(el, vazio || ''); delete el.dataset.rpT; el.removeAttribute('title'); return; }
    el.dataset.rpT = String(ms);
    el.dataset.rpPre = pre || '';
    txt(el, (pre || '') + rel(ms));
    el.title = (tit || '') + dataCompleta(ms);
  }
  function atualizarRel() { for (const el of document.querySelectorAll('[data-rp-t]')) txt(el, (el.dataset.rpPre || '') + rel(Number(el.dataset.rpT))); }

  // ───────────────────────────── servidor ─────────────────────────────
  class ErroRepo extends Error {
    constructor(mensagem, status, dados) { super(mensagem); this.status = status; this.dados = dados || {}; this.codigo = str(this.dados.codigo); }
  }
  function mensagemErro(status, d) {
    const c = str(d.codigo);
    if (c === 'hook') return ERROS.hook;
    if (str(d.erro).trim()) return d.erro.trim();
    if (c === 'divergiu' && (d.adiante || d.atras)) return ERROS.divergiu + ' Você tem ' + plural(num(d.adiante), 'commit', 'commits') + ' que o GitHub não tem, e ele tem ' + plural(num(d.atras), 'commit', 'commits') + ' que você não tem.';
    if (ERROS[c]) return ERROS[c];
    if (status === 404) return 'Reinicie o servidor do Orbit para usar os repositórios.';
    if (status === 504) return 'A operação passou do prazo e foi interrompida.';
    return 'O servidor do Orbit respondeu ' + status + '.';
  }
  async function chamar(caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, corpo !== undefined
        ? { method: 'POST', cache: 'no-store', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) }
        : { cache: 'no-store' });
    } catch { throw new ErroRepo('Sem conexão com o servidor do Orbit.', 0, { codigo: 'conexao' }); }
    let d = null;
    try { d = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, dados: d && typeof d === 'object' ? d : {} };
  }
  const erroDe = (res) => new ErroRepo(mensagemErro(res.status, res.dados), res.status, res.dados);
  async function obter(caminho) { const res = await chamar(caminho); if (!res.ok) throw erroDe(res); return res.dados; }
  // POST com o fluxo de confirmação: 409 confirmar → diálogo → mesmo corpo + confirmar:true. null = cancelado.
  async function pedir(caminho, corpo) {
    let res = await chamar(caminho, corpo);
    if (res.status === 409 && res.dados.codigo === 'confirmar') {
      if (!(await confirmar(res.dados))) return null;
      res = await chamar(caminho, Object.assign({}, corpo, { confirmar: true }));
      if (res.status === 409 && res.dados.codigo === 'confirmar') throw new ErroRepo('O servidor pediu confirmação de novo; nada foi feito.', 409, {});
    }
    if (!res.ok) throw erroDe(res);
    return res.dados;
  }

  // ───────────────────────────── dados ─────────────────────────────
  const valido = (p) => p && typeof p === 'object' && typeof p.chave === 'string' && typeof p.pasta === 'string';
  const validoRepo = (r) => r && typeof r === 'object' && typeof r.completo === 'string' && r.completo.includes('/') && typeof r.nome === 'string' && typeof r.dono === 'string';
  const projeto = (chave) => (st.lista ? st.lista.find((p) => p.chave === chave) || null : null);
  const nomeDe = (p) => str(p.nome) || caminhoCurto(p.pasta);
  const podeGithub = () => st.github.conectado && !st.github.expirado;
  const podeRemover = (p) => !!p.origem && p.origem !== 'sessao' && p.origem !== 'lateral' && p.origem !== 'subpasta';
  const temConflito = (s) => !!(s && Array.isArray(s.arquivos) && s.arquivos.some((a) => a && a.tipo === 'conflito'));
  const arquivosDe = (p) => (p.status && Array.isArray(p.status.arquivos) ? p.status.arquivos.filter((a) => a && typeof a.caminho === 'string') : []);

  function aplicarGithub(g) {
    const a = st.github;
    const novo = { conectado: !!g.conectado, login: str(g.login), expirado: !!g.expirado };
    const mudou = !st.githubConhecido || a.conectado !== novo.conectado || a.login !== novo.login || a.expirado !== novo.expirado;
    st.githubConhecido = true;
    if (!mudou) return false;
    if (a.conectado !== novo.conectado || a.login !== novo.login || (a.expirado && !novo.expirado)) { st.repos = null; st.reposErro = null; }
    st.github = novo;
    return true;
  }
  function aplicarProjeto(p) {
    if (!valido(p) || !st.lista) return;
    const i = st.lista.findIndex((x) => x.chave === p.chave);
    if (i >= 0) st.lista[i] = p; else st.lista.push(p);
    render();
  }

  async function carregarProjetos(op = {}) {
    if (st.carregando) { if (op.forcar) st.pendente = true; return; }
    st.carregando = true;
    if (op.botao) render();
    try {
      const d = await obter('/repos/projetos');
      st.lista = Array.isArray(d.projetos) ? d.projetos.filter(valido) : [];
      if (typeof d.pastaClones === 'string') st.pastaClones = d.pastaClones;
      if (d.github && typeof d.github === 'object') aplicarGithub(d.github);
      st.erroLista = null;
      st.lidoEm = Date.now();
      if (st.repos == null && !st.reposCarregando && !st.reposErro && podeGithub()) carregarRepos(false, true);
    } catch (e) {
      st.erroLista = e;
      if (op.botao || st.lista) { if (op.botao) toast(e.message, { tipo: 'erro' }); }
    } finally {
      st.carregando = false;
      render();
      if (st.pendente) { st.pendente = false; carregarProjetos(); }
    }
  }
  let seqRepos = 0;
  async function carregarRepos(forcar, silencioso) {
    const meu = ++seqRepos;
    st.reposCarregando = true;
    if (!silencioso) render();
    try {
      const d = await obter('/repos/github' + (forcar ? '?forcar=1' : ''));
      if (meu !== seqRepos) return false;
      st.repos = Array.isArray(d.repos) ? d.repos.filter(validoRepo) : [];
      st.reposLido = num(d.lidoEm) || Date.now();
      st.reposErro = null;
      st.reposVelho = false;
      if (str(d.login)) st.github.login = d.login;
      return true;
    } catch (e) {
      if (meu !== seqRepos) return false;
      st.reposErro = e;
      if (e.codigo === 'sem-github') aplicarGithub(Object.assign({}, st.github, { conectado: false }));
      else if (e.codigo === 'expirado') aplicarGithub(Object.assign({}, st.github, { expirado: true }));
      else if (e.codigo === 'permissao') abrirPermissoes(e.dados.faltando, true);
      return false;
    } finally {
      if (meu === seqRepos) st.reposCarregando = false;
      render();
    }
  }

  // ───────────────────────────── montagem ─────────────────────────────
  function montar(el, api) {
    if (st.montado) { retomar(); return; }
    if (!(el instanceof HTMLElement)) return;
    st.el = el;
    st.api = api || window.GerenciadorAPI || null;
    st.montado = true;
    el.classList.add('rp-vista');
    construir();
    if (st.api && typeof st.api.on === 'function') {
      st.api.on('repos', aoEventoRepos);
      st.api.on('perfil', aoPerfil);
      st.api.on('conexao', aoConexao);
    }
    document.addEventListener('keydown', teclaGlobal, true);
    document.addEventListener('pointerdown', foraDoPopover, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && st.ativo && Date.now() - st.lidoEm > MS_STATUS) carregarProjetos(); });
    addEventListener('resize', posicionarPop);
    const rolar = el.closest('#rolar') || el.parentElement;
    if (rolar) rolar.addEventListener('scroll', posicionarPop, { passive: true, capture: true }); // captura: com abas, quem rola é o painel da aba
    retomar();
  }
  function retomar() {
    if (!st.montado) return;
    st.ativo = true;
    clearInterval(ui.tStatus); clearInterval(ui.tRel);
    ui.tStatus = setInterval(() => { if (st.ativo && !document.hidden) carregarProjetos(); }, MS_STATUS);
    ui.tRel = setInterval(() => { if (st.ativo && !document.hidden) atualizarRel(); }, MS_REL);
    render();
    carregarProjetos({ forcar: true });
    if (st.aba === 'github' && podeGithub() && (st.repos == null || st.reposVelho) && !st.reposCarregando) carregarRepos(false);
  }
  function pausar() {
    if (!st.montado) return;
    st.ativo = false;
    clearInterval(ui.tStatus); clearInterval(ui.tRel);
    fecharPopover(false);
    for (let i = 0; pilha.length && i < 10; i++) pilha[pilha.length - 1].cancelar();
    if (ui.toasts) ui.toasts.replaceChildren();
  }

  function construir() {
    ui.resumo = h('p', { class: 'rp-resumo' });
    ui.bAdicionar = h('button', { type: 'button', class: 'btn btn-orbita rp-b-adicionar', title: 'Adicionar uma pasta que já existe', 'aria-label': 'Adicionar pasta', onclick: dialogoAdicionar },
      icone('pastaMais', 15), h('span', { class: 'rp-rot', text: 'Adicionar pasta' }));
    const cab = h('header', { class: 'rp-cab' },
      h('div', { class: 'rp-cab-txt' }, h('h1', { text: 'Repositórios' }), ui.resumo),
      h('div', { class: 'rp-cab-acoes' }, ui.bAdicionar));

    ui.nProj = h('span', { class: 'n' });
    ui.nGh = h('span', { class: 'n' });
    ui.abaProj = h('button', { type: 'button', 'aria-pressed': 'true', 'data-foco': 'aba:projetos', onclick: () => trocarAba('projetos') }, h('span', { class: 'rot', 'data-t': 'Projetos', text: 'Projetos' }), ui.nProj);
    ui.abaGh = h('button', { type: 'button', 'aria-pressed': 'false', 'data-foco': 'aba:github', onclick: () => trocarAba('github') }, h('span', { class: 'rot', 'data-t': 'GitHub', text: 'GitHub' }), ui.nGh);
    ui.busca = h('input', { type: 'search', class: 'rp-busca-campo', placeholder: 'Filtrar projetos', 'aria-label': 'Filtrar projetos', autocomplete: 'off', spellcheck: 'false' });
    ui.busca.addEventListener('input', aoBuscar);
    ui.buscaRot = h('label', { class: 'rp-busca', title: 'Buscar' }, icone('busca', 14), ui.busca);
    ui.bAtualizar = h('button', { type: 'button', class: 'btn-icone rp-b-atualizar', 'aria-label': 'Atualizar', onclick: () => (st.aba === 'projetos' ? carregarProjetos({ forcar: true, botao: true }) : carregarRepos(true)) }, icone('buscar'));
    const barra = h('div', { class: 'rp-barra' },
      h('div', { class: 'seg-filtro rp-abas', role: 'group', 'aria-label': 'Ver' }, ui.abaProj, ui.abaGh),
      h('div', { class: 'rp-barra-fim' }, ui.buscaRot, ui.bAtualizar));
    ui.faixa = h('div', { class: 'rp-faixa' });
    ui.paneProj = h('section', { class: 'rp-pane', 'aria-label': 'Projetos' });
    ui.paneGh = h('section', { class: 'rp-pane', 'aria-label': 'Repositórios do GitHub', hidden: true });
    st.el.replaceChildren(h('div', { class: 'rp-raiz' }, cab, barra, ui.faixa, ui.paneProj, ui.paneGh));
    ui.toasts = h('div', { class: 'rp-toasts', 'aria-live': 'polite' });
    document.body.append(ui.toasts);
  }

  // ───────────────────────────── eventos ─────────────────────────────
  let tLista = 0;
  function aoEventoRepos(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.tipo === 'projeto' && valido(ev.projeto)) aplicarProjeto(ev.projeto);
    else if (ev.tipo === 'progresso' && ev.op === 'clonar') progressoClone(ev);
    else if (ev.tipo === 'lista') { clearTimeout(tLista); tLista = setTimeout(() => carregarProjetos({ forcar: true }), 250); }
  }
  function aoPerfil(p) {
    if (!p || typeof p !== 'object') return;
    const gh = p.github && typeof p.github === 'object' ? p.github : null;
    if (aplicarGithub({ conectado: !!gh, login: gh ? str(gh.login) : '', expirado: !!(gh && gh.expirado) })) {
      carregarProjetos({ forcar: true });
      if (st.aba === 'github' && podeGithub()) carregarRepos(false);
      render();
    }
  }
  function aoConexao(estado) {
    const antes = st.conexao;
    st.conexao = estado;
    if (estado === 'vivo' && antes !== 'vivo') carregarProjetos({ forcar: true });
    render();
  }
  function aoBuscar() {
    const v = ui.busca.value;
    ui.buscaRot.classList.toggle('tem', !!v);
    if (st.aba === 'projetos') st.buscaProj = v; else { st.busca = v; st.limite = MAX_REPOS; }
    clearTimeout(ui.tBusca);
    ui.tBusca = setTimeout(render, 60);
  }
  function trocarAba(aba) {
    if (st.aba === aba) return;
    st.aba = aba;
    fecharPopover(false);
    ui.busca.value = aba === 'projetos' ? st.buscaProj : st.busca;
    ui.buscaRot.classList.toggle('tem', !!ui.busca.value);
    if (aba === 'github' && podeGithub() && (st.repos == null || st.reposVelho) && !st.reposCarregando) carregarRepos(false);
    render();
  }

  // Teclado: diálogo e popover primeiro (Esc fecha só eles); na vista, "/" busca e os atalhos de uma
  // letra da página não chegam à lista escondida. Nada disso quando se digita num campo.
  function camadaDaPagina() { return !!document.querySelector('.camada:not([hidden]), #perfil-pop:not([hidden]), .menu-flut'); }
  function teclaGlobal(e) {
    if (!st.ativo || e.isComposing) return;
    const alvo = e.target;
    const dlg = pilha[pilha.length - 1];
    if (dlg) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dlg.cancelar(); return; }
      if (e.key === 'Tab') prender(e, dlg.raiz);
      if (!digitando(alvo)) e.stopPropagation();
      return;
    }
    const pop = ui.pop;
    if (pop) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharPopover(true); return; }
      if (pop.tecla && pop.tecla(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Tab') { e.preventDefault(); fecharPopover(true); return; }
      if (!digitando(alvo)) e.stopPropagation();
      return;
    }
    if (camadaDaPagina()) return;
    if (digitando(alvo)) {
      if (e.key === 'Escape' && alvo === ui.busca && ui.busca.value) { e.preventDefault(); e.stopPropagation(); ui.busca.value = ''; aoBuscar(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault(); e.stopPropagation();
      if (!ui.buscaRot.hidden) { ui.busca.focus(); ui.busca.select(); }
      return;
    }
    if (BLOQUEAR.has(e.key)) e.stopPropagation();
  }
  function focaveis(raiz) {
    return [...raiz.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
  }
  function prender(e, raiz) {
    const f = focaveis(raiz);
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  }

  // ───────────────────────────── desenho ─────────────────────────────
  function render() {
    if (!st.montado || !st.ativo) return;
    const f = focoChave();
    renderCab();
    renderBarra();
    renderFaixa();
    ui.paneProj.hidden = st.aba !== 'projetos';
    ui.paneGh.hidden = st.aba !== 'github';
    if (st.aba === 'projetos') renderProjetos(); else renderGithub();
    restaurarFoco(f);
  }
  function renderCab() {
    const partes = [];
    if (st.lista) {
      const n = st.lista.length, v = st.lista.filter((p) => p.repo).length;
      partes.push(h('span', null, h('b', { text: String(n) }), n === 1 ? ' projeto' : ' projetos'));
      partes.push(h('span', null, h('b', { text: String(v) }), v === 1 ? ' vinculado' : ' vinculados'));
    }
    if (st.github.conectado && st.github.login) partes.push(h('span', { class: st.github.expirado ? 'aviso' : null, text: '@' + st.github.login + (st.github.expirado ? ' · token expirado' : '') }));
    else if (st.githubConhecido) partes.push(h('span', { text: 'GitHub não conectado' }));
    const sig = partes.map((x) => x.textContent).join('|');
    if (ui.resumo._sig !== sig) { ui.resumo._sig = sig; ui.resumo.replaceChildren(...partes); }
  }
  function renderBarra() {
    ui.abaProj.setAttribute('aria-pressed', String(st.aba === 'projetos'));
    ui.abaGh.setAttribute('aria-pressed', String(st.aba === 'github'));
    txt(ui.nProj, st.lista ? String(st.lista.length) : '');
    txt(ui.nGh, st.repos && podeGithub() ? String(st.repos.length) : '');
    const ph = st.aba === 'projetos' ? 'Filtrar projetos' : 'Buscar repositórios';
    if (ui.busca.placeholder !== ph) { ui.busca.placeholder = ph; ui.busca.setAttribute('aria-label', ph); }
    const semGh = st.aba === 'github' && !podeGithub();
    ui.buscaRot.hidden = semGh || (st.aba === 'projetos' && !(st.lista && st.lista.length));
    ui.bAtualizar.hidden = semGh;
    const car = st.aba === 'projetos' ? st.carregando : st.reposCarregando;
    ui.bAtualizar.setAttribute('aria-busy', String(!!car));
    ui.bAtualizar.title = st.aba === 'projetos'
      ? 'Atualizar o status' + (st.lidoEm ? ' (lido ' + rel(st.lidoEm) + ')' : '')
      : 'Atualizar a lista do GitHub' + (st.reposLido ? ' (lida ' + rel(st.reposLido) + ')' : '');
  }
  function renderFaixa() {
    const nos = [];
    if (st.conexao && st.conexao !== 'vivo') {
      nos.push(memo('fx-conexao', '', () => h('div', { class: 'rp-banner aviso', role: 'status' }, icone('alerta', 15),
        h('span', null, h('b', { text: 'Sem conexão com o servidor.' }), ' Os dados podem estar desatualizados; reconectando sozinho.'))));
    }
    if (st.aba === 'projetos' && st.githubConhecido && st.lista && !podeGithub()) {
      const exp = st.github.expirado;
      nos.push(memo('fx-gh', exp, () => h('div', { class: 'rp-banner' + (exp ? ' aviso' : '') }, icone(exp ? 'alerta' : 'github', 15),
        h('span', { text: exp ? 'O token do GitHub expirou ou foi revogado. O status local continua aqui; para buscar, enviar e receber, conecte um token novo.' : 'O GitHub não está conectado. O status local continua aqui; para vincular, enviar e receber, conecte a conta.' }),
        h('button', { type: 'button', class: 'btn p', onclick: abrirPerfil }, exp ? 'Reconectar' : 'Conectar o GitHub'))));
    }
    reconciliar(ui.faixa, nos);
  }

  function vazio(o) {
    return h('div', { class: 'rp-vazio' },
      h('span', { class: 'rp-quad grande' + (o.tom ? ' ' + o.tom : '') }, icone(o.ico, 20)),
      h('h2', { text: o.titulo }),
      o.texto ? h('p', { text: o.texto }) : null,
      o.acoes && o.acoes.length ? h('div', { class: 'rp-vazio-acoes' }, ...o.acoes) : null);
  }
  function estadoErro(e, tentar) {
    return vazio({ ico: 'alerta', tom: 'perigo', titulo: e.codigo === 'permissao' ? 'O token não deixa listar os repositórios' : 'Não deu para carregar', texto: e.message,
      acoes: [h('button', { type: 'button', class: 'btn', onclick: tentar }, icone('buscar', 14), 'Tentar de novo')] });
  }
  function esqueleto(n) {
    return h('div', { class: 'rp-esq-lista', 'aria-busy': 'true', 'aria-label': 'Carregando' },
      ...Array.from({ length: n }, (_, i) => h('div', { class: 'rp-esq' }, h('i', { class: 'q' }), h('span', null, h('i', { class: 'l1', style: 'width:' + (34 - i * 5) + '%' }), h('i', { class: 'l2' })), h('i', { class: 'p' }))));
  }

  // ── Projetos ──
  function grupoDe(p) {
    if (p.bloqueado || p.existe === false) return 'outros';
    const s = p.status;
    if (p.git && s) {
      if (s.operacao || temConflito(s) || s.atras > 0 || s.alteracoes > 0 || s.adiante > 0 || (s.destacado && !s.branch && !s.destacadoEm)) return 'atencao';
      if ((p.repo || p.remoto) && !s.upstream && !s.semCommits) return 'atencao';
    }
    if (p.git && !s && p.erro) return 'atencao';
    if (!p.git || (!p.repo && !p.remoto)) return 'semrepo';
    return 'emdia';
  }
  function pesoDe(p) {
    const s = p.status || {};
    if (s.operacao || temConflito(s) || (p.erro && !p.status)) return 0;
    if (s.atras > 0) return 1;
    if (s.alteracoes > 0) return 2;
    if (s.adiante > 0) return 3;
    return 4;
  }
  const mapaFixo = () => new Map((st.lista || []).map((p) => [p.chave, { g: grupoDe(p), w: pesoDe(p) }]));
  function ordenar(lista) {
    const itens = lista.map((p) => ({ p, g: grupoDe(p), w: pesoDe(p) }));
    if (st.fixo) for (const it of itens) { const f = st.fixo.get(it.p.chave); if (f) { it.g = f.g; it.w = f.w; } }
    itens.sort((a, b) => GRUPOS.indexOf(a.g) - GRUPOS.indexOf(b.g) || a.w - b.w || nomeDe(a.p).localeCompare(nomeDe(b.p), 'pt-BR', { sensitivity: 'base' }));
    return itens;
  }
  function filtrarProjetos(lista, q) {
    const termos = norm(q).split(/\s+/).filter(Boolean);
    if (!termos.length) return lista;
    return lista.filter((p) => {
      const alvo = norm([p.nome, p.pasta, p.repo && p.repo.completo, p.status && p.status.branch].filter(Boolean).join(' '));
      return termos.every((t) => alvo.includes(t));
    });
  }
  function renderProjetos() {
    const pane = ui.paneProj;
    if (st.lista == null) {
      reconciliar(pane, [st.erroLista ? memo('pj-erro', st.erroLista.message, () => estadoErro(st.erroLista, () => carregarProjetos({ forcar: true, botao: true }))) : memo('pj-esq', '', () => esqueleto(4))]);
      return;
    }
    if (!st.lista.length) {
      reconciliar(pane, [memo('pj-vazio', podeGithub(), () => vazio({ ico: 'pasta', titulo: 'Nenhum projeto ainda',
        texto: 'Os projetos aparecem aqui quando uma sessão do Claude roda numa pasta. Você também pode adicionar uma pasta ou clonar um repositório do GitHub.',
        acoes: [h('button', { type: 'button', class: 'btn', onclick: dialogoAdicionar }, icone('pastaMais', 14), 'Adicionar pasta'),
          podeGithub() ? h('button', { type: 'button', class: 'btn', onclick: () => trocarAba('github') }, icone('clonar', 14), 'Clonar do GitHub') : null] }))]);
      return;
    }
    const lista = filtrarProjetos(st.lista, st.buscaProj);
    if (!lista.length) {
      reconciliar(pane, [memo('pj-nada', st.buscaProj, () => vazio({ ico: 'busca', titulo: 'Nada encontrado', texto: 'Nenhum projeto com "' + st.buscaProj.trim() + '".',
        acoes: [h('button', { type: 'button', class: 'btn', onclick: () => { ui.busca.value = ''; aoBuscar(); ui.busca.focus(); } }, 'Limpar busca')] }))]);
      return;
    }
    const porGrupo = new Map();
    for (const it of ordenar(lista)) { if (!porGrupo.has(it.g)) porGrupo.set(it.g, []); porGrupo.get(it.g).push(it.p); }
    const nos = [];
    for (const g of GRUPOS) {
      const ps = porGrupo.get(g);
      if (!ps) continue;
      if (porGrupo.size > 1) nos.push(memo('sec-' + g, ps.length, () => h('div', { class: 'rp-sec' + (g === 'atencao' ? ' atencao' : ''), role: 'heading', 'aria-level': '2' }, h('span', { text: NOME_GRUPO[g] }), h('span', { class: 'n', text: String(ps.length) }))));
      for (const p of ps) { const c = cartao(p.chave); pintarCartao(c, p); nos.push(c.el); }
    }
    reconciliar(pane, nos);
    const vivos = new Set(st.lista.map((p) => p.chave));
    for (const k of [...ui.cartoes.keys()]) if (!vivos.has(k)) ui.cartoes.delete(k);
    if (st.aberto && !vivos.has(st.aberto)) { st.aberto = null; st.fixo = null; }
  }

  function cartao(chave) {
    let c = ui.cartoes.get(chave);
    if (c) return c;
    c = { chave, idDet: novoId('det'), det: null, sig: null, p: null };
    c.av = h('span', { class: 'rp-av', 'aria-hidden': 'true' });
    c.nome = h('span', { class: 'rp-nome' });
    c.cam = h('span', { class: 'rp-cam' });
    c.abrir = h('button', { type: 'button', class: 'rp-abrir', 'aria-expanded': 'false', 'aria-controls': c.idDet }, c.nome, c.cam);
    c.vinc = h('span', { class: 'rp-vinc' });
    c.estado = h('span', { class: 'rp-estado' });
    c.quando = h('span', { class: 'rp-quando' });
    c.seta = h('span', { class: 'rp-seta', 'aria-hidden': 'true' }, icone('chevron', 14));
    c.linha = h('div', { class: 'rp-linha' }, c.av, c.abrir, c.vinc, c.estado, c.quando, c.seta);
    c.linha.addEventListener('click', (e) => clicarLinha(e, c));
    c.el = h('div', { class: 'rp-card' }, c.linha);
    ui.cartoes.set(chave, c);
    return c;
  }
  function clicarLinha(e, c) {
    const p = c.p;
    if (!p || p.bloqueado || p.existe === false) return;
    const alvo = e.target;
    if (alvo.closest('a, input, label, textarea') || (alvo.closest('button') && !alvo.closest('.rp-abrir'))) return;
    if (!alvo.closest('.rp-abrir')) {
      const sel = getSelection();
      if (sel && String(sel).length && c.linha.contains(sel.anchorNode)) return;
    }
    alternarProjeto(p.chave);
  }
  function alternarProjeto(chave) {
    if (st.aberto === chave) { st.aberto = null; st.fixo = null; render(); return; }
    st.aberto = chave;
    st.fixo = mapaFixo();
    render();
    const c = ui.cartoes.get(chave);
    if (c) requestAnimationFrame(() => c.el.scrollIntoView({ block: 'nearest', behavior: reduzido() ? 'auto' : 'smooth' }));
    aoAbrirProjeto(chave);
  }
  // Ao abrir: busca no GitHub (no máximo 1 a cada 3 min por pasta; o servidor também limita) ou status fresco.
  function aoAbrirProjeto(chave) {
    const p = projeto(chave);
    if (!p || !p.git || st.ocupado.has(chave)) return;
    if (p.repo && podeGithub() && Date.now() - (st.conferido.get(chave) || 0) > MS_CONFERIR) {
      st.conferido.set(chave, Date.now());
      executar(chave, 'conferir', async () => {
        const d = await pedir('/repos/buscar', { pasta: p.pasta });
        if (d && d.projeto) aplicarProjeto(d.projeto);
      }, (e) => {
        if (e.codigo === 'permissao') {
          abrirPermissoes(e.dados.faltando, true);
          st.avisos.set(chave, { tom: 'info', titulo: 'Não deu para buscar no GitHub', texto: e.message, acao: { rot: 'Ver permissões', fn: irParaPermissoes } });
        } else if (e.codigo === 'expirado') aplicarGithub(Object.assign({}, st.github, { expirado: true }));
        return true;
      });
    } else {
      obter('/repos/projeto?pasta=' + encodeURIComponent(p.pasta)).then((d) => aplicarProjeto(d.projeto)).catch(() => {});
    }
  }

  function reposPorNome() {
    const m = new Map();
    if (st.repos) for (const r of st.repos) m.set(r.completo.toLowerCase(), r);
    return m;
  }
  function pil(o) {
    return h('span', { class: 'rp-pil' + (o.tom ? ' ' + o.tom : ''), title: o.titulo || null },
      o.ponto ? h('i', { class: 'rp-ponto' }) : o.ico ? icone(o.ico, 12) : null,
      o.n != null ? h('b', { text: String(o.n) }) : null,
      o.rot ? h('span', { text: o.rot }) : null,
      o.ext ? h('span', { class: 'rp-pil-ext', text: o.ext }) : null);
  }
  function chipBranch(s) {
    const nome = s.branch || s.destacado || '—';
    const t = s.branch ? 'Branch ' + s.branch + (s.upstream ? ' · segue ' + s.upstream : ' · sem par no GitHub') : s.destacado ? 'HEAD destacado em ' + s.destacado + (s.destacadoEm ? ' (o commit já está em ' + s.destacadoEm + ')' : '') : '';
    return h('span', { class: 'rp-branch' + (!s.branch && s.destacado ? ' destacado' : ''), title: t }, icone('branch', 12), h('span', { text: nome }));
  }
  function conteudoVinc(p, s, info) {
    if (p.bloqueado) {
      const subs = (p.subrepos || []).map((x) => String(x).split(/[\\/]/).pop());
      return [h('span', { class: 'rp-nota' }, icone('cadeado', 13), h('span', { text: subs.length ? 'O git fica nas subpastas: ' + subs.join(', ') : 'Contém outros projetos; fica fora do git' }))];
    }
    if (p.existe === false) return [h('span', { class: 'rp-nota' }, icone('alerta', 13), h('span', { text: 'Pasta não encontrada' }))];
    const out = [];
    if (p.repo) {
      const priv = info ? info.visibilidade !== 'publico' : false;
      out.push(h('span', { class: 'rp-repo', title: 'github.com/' + p.repo.completo + (info ? ' · ' + (VIS[info.visibilidade] || '') : '') }, icone(priv ? 'cadeado' : 'repo', 13), h('span', { class: 'rp-repo-nome', text: p.repo.completo })));
    } else if (p.remoto && p.remoto.url) {
      out.push(h('span', { class: 'rp-repo outro', title: 'origin: ' + p.remoto.url }, icone('link', 13), h('span', { class: 'rp-repo-nome', text: remotoCurto(p.remoto.url) })));
    } else out.push(h('span', { class: 'rp-semrepo', text: p.git ? 'Sem repositório' : 'Sem git' }));
    if (p.git && s) out.push(chipBranch(s));
    return out;
  }
  function conteudoEstado(p, s, op) {
    const out = [];
    if (op && op !== 'conferir') out.push(h('span', { class: 'rp-pil' }, gira(), h('span', { text: OPS[op] || 'Trabalhando…' })));
    if (p.existe === false) {
      if (podeRemover(p)) out.push(h('button', { type: 'button', class: 'btn p contorno', onclick: () => acaoRemover(p.chave) }, 'Tirar da lista'));
      return out;
    }
    if (p.bloqueado) return out;
    if (!p.git || !s) { if (p.erro) out.push(pil({ tom: 'erro', ico: 'alerta', rot: 'Erro ao ler', titulo: p.erro })); return out; }
    const antes = out.length;
    if (s.operacao) out.push(pil({ tom: 'erro', ico: 'alerta', rot: (NOME_OPERACAO[s.operacao] || s.operacao) + ' em andamento', titulo: 'Há um ' + s.operacao + ' em andamento; resolva no editor.' }));
    else if (temConflito(s)) out.push(pil({ tom: 'erro', ico: 'alerta', rot: 'Conflito', titulo: 'Há arquivos em conflito' }));
    if (s.alteracoes > 0) out.push(pil({ tom: 'alt', ponto: true, n: s.alteracoes, ext: s.alteracoes === 1 ? 'alteração' : 'alterações', titulo: plural(s.alteracoes, 'alteração não commitada', 'alterações não commitadas') }));
    if (s.adiante > 0) out.push(pil({ tom: 'sobe', ico: 'sobe', n: s.adiante, titulo: plural(s.adiante, 'commit para enviar', 'commits para enviar') }));
    if (s.atras > 0) out.push(pil({ tom: 'desce', ico: 'desce', n: s.atras, titulo: plural(s.atras, 'commit para receber', 'commits para receber') + ' do GitHub' }));
    if (s.semCommits) out.push(pil({ rot: 'Sem commits', titulo: 'O repositório ainda não tem nenhum commit' }));
    else if ((p.repo || p.remoto) && !s.upstream && s.branch) out.push(pil({ ico: 'nuvem', rot: 'Só local', titulo: 'O branch ' + s.branch + ' ainda não existe no GitHub' }));
    if (!s.branch && s.destacado && !s.destacadoEm) out.push(pil({ tom: 'alt', rot: 'Sem branch', titulo: 'HEAD destacado em ' + s.destacado }));
    if (p.erro) out.push(pil({ tom: 'erro', ico: 'alerta', rot: 'Erro', titulo: p.erro }));
    if (out.length === antes) {
      out.push(p.repo || p.remoto
        ? pil({ tom: 'ok', ico: 'check', rot: 'Em dia', titulo: 'Sem alterações e igual ao GitHub' + (s.buscadoEm ? ' (última busca ' + rel(s.buscadoEm) + ')' : ' (ainda não buscou)') })
        : pil({ ico: 'check', rot: 'Limpo', titulo: 'Sem alterações' }));
    }
    return out;
  }
  function pintarCartao(c, p) {
    c.p = p;
    const s = p.status || null;
    const op = st.ocupado.get(p.chave) || '';
    const aberto = st.aberto === p.chave;
    const inativo = !!p.bloqueado || p.existe === false;
    const info = p.repo ? reposPorNome().get(String(p.repo.completo).toLowerCase()) : null;
    const sig = JSON.stringify([p.nome, p.pasta, p.existe, p.bloqueado, p.git, p.origem, p.repo && p.repo.completo, p.remoto && p.remoto.url, p.erro || '',
      s && [s.branch, s.destacado, s.upstream, s.adiante, s.atras, s.semCommits, s.alteracoes, s.operacao, s.buscadoEm, temConflito(s)], op, aberto, info && info.visibilidade]);
    if (c.sig !== sig) {
      c.sig = sig;
      c.el.className = 'rp-card' + (aberto ? ' aberto' : '') + (inativo ? ' inativo' : '') + (op ? ' ocupado' : '');
      c.el.setAttribute('aria-busy', op ? 'true' : 'false');
      txt(c.av, letra(nomeDe(p)));
      txt(c.nome, nomeDe(p));
      txt(c.cam, caminhoCurto(p.pasta));
      c.abrir.title = p.pasta;
      c.abrir.disabled = inativo;
      c.abrir.setAttribute('aria-expanded', String(aberto));
      c.vinc.replaceChildren(...conteudoVinc(p, s, info));
      c.estado.replaceChildren(...conteudoEstado(p, s, op));
      if (op === 'conferir') { txt(c.quando, 'conferindo…'); delete c.quando.dataset.rpT; c.quando.removeAttribute('title'); }
      else if (p.git && s && !inativo) setRel(c.quando, s.buscadoEm, 'conferido ', 'Última busca no GitHub: ', p.repo ? 'não conferido' : '');
      else setRel(c.quando, 0);
      c.seta.hidden = inativo;
    }
    if (aberto && !inativo) pintarDet(c, p);
    else if (c.det) c.det.raiz.hidden = true;
  }

  // ── Detalhe (acordeão) ──
  function construirDet(c) {
    const d = {};
    const chave = c.chave;
    d.raiz = h('div', { class: 'rp-det', id: c.idDet });
    d.bBranch = h('button', { type: 'button', class: 'btn p rp-b-branch', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => { if (!inerte(d.bBranch)) abrirBranches(c); } });
    d.bReceber = h('button', { type: 'button', class: 'btn p', onclick: () => { if (!inerte(d.bReceber)) acaoPull(chave); } });
    d.bEnviar = h('button', { type: 'button', class: 'btn p', onclick: () => { if (!inerte(d.bEnviar)) acaoPush(chave); } });
    d.bBuscar = h('button', { type: 'button', class: 'btn p', onclick: () => { if (!inerte(d.bBuscar)) acaoBuscar(chave); } });
    d.bGithub = h('a', { class: 'btn-icone rp-b-gh', target: '_blank', rel: 'noopener noreferrer', title: 'Abrir no GitHub', 'aria-label': 'Abrir no GitHub' }, icone('externo'));
    d.bMais = h('button', { type: 'button', class: 'btn-icone', title: 'Mais ações', 'aria-label': 'Mais ações', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => { if (!inerte(d.bMais)) menuProjeto(c); } }, icone('mais'));
    d.sync = h('div', { class: 'rp-sync' }, d.bReceber, d.bEnviar, d.bBuscar);
    d.barra = h('div', { class: 'rp-acoes' }, d.bBranch, d.sync, h('span', { class: 'rp-espaco' }), d.bGithub, d.bMais);
    d.aviso = h('div', { class: 'rp-aviso-slot' });
    // Sem vínculo
    d.svTexto = h('p');
    d.svVinc = h('button', { type: 'button', class: 'btn p', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => { if (!inerte(d.svVinc)) abrirVincular(d.svVinc, chave); } }, icone('link', 14), h('span', { text: 'Vincular repositório' }), icone('baixo', 12));
    d.svCriar = h('button', { type: 'button', class: 'btn p', onclick: () => { if (!inerte(d.svCriar)) dialogoCriar(chave); } }, icone('github', 14), h('span', { text: 'Criar no GitHub' }));
    d.svConectar = h('button', { type: 'button', class: 'btn p', onclick: abrirPerfil }, icone('github', 14), h('span', { text: 'Conectar o GitHub' }));
    d.semvinc = h('div', { class: 'rp-semvinc' }, icone('info', 15), d.svTexto, h('div', { class: 'rp-semvinc-acoes' }, d.svVinc, d.svCriar, d.svConectar));
    // Arquivos
    d.todos = h('input', { type: 'checkbox', class: 'rp-caixa', 'aria-label': 'Marcar todos os arquivos' });
    d.todos.addEventListener('change', () => {
      const p = projeto(chave);
      if (!p) return;
      st.desmarcados.set(chave, d.todos.checked ? new Set() : new Set(arquivosDe(p).map((a) => a.caminho)));
      pintarArquivos(c, p);
    });
    d.nArq = h('span', { class: 'n' });
    d.lista = h('div', { class: 'rp-arq-lista', role: 'group', 'aria-label': 'Arquivos alterados' });
    d.lista.addEventListener('change', (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.dataset.caminho) return;
      const fora = st.desmarcados.get(chave) || new Set();
      if (cb.checked) fora.delete(cb.dataset.caminho); else fora.add(cb.dataset.caminho);
      st.desmarcados.set(chave, fora);
      const p = projeto(chave);
      if (p) pintarArquivos(c, p);
    });
    d.corte = h('p', { class: 'rp-corte', hidden: true });
    d.arqs = h('div', { class: 'rp-arqs' },
      h('div', { class: 'rp-arq-cab' }, h('label', { class: 'rp-arq-todos' }, d.todos, h('span', { text: 'Alterações' }), d.nArq), h('span', { class: 'rp-arq-dica', text: 'Marque o que entra no commit' })),
      d.lista, d.corte);
    d.msg = h('textarea', { class: 'rp-msg', rows: '1', placeholder: 'Mensagem do commit', 'aria-label': 'Mensagem do commit', maxlength: '5000', spellcheck: 'true' });
    d.msg.addEventListener('input', () => { crescer(d.msg); pintarCommit(c); });
    d.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); acaoCommit(chave); } });
    d.bCommit = h('button', { type: 'button', class: 'btn solido rp-b-commit', onclick: () => { if (!inerte(d.bCommit)) acaoCommit(chave); else if (!d.msg.value.trim()) d.msg.focus(); } });
    d.commit = h('div', { class: 'rp-commit' }, d.msg, d.bCommit);
    d.limpo = h('div', { class: 'rp-limpo' }, icone('check', 14), h('span', { text: 'Nada para commitar: sem alterações.' }));
    d.raiz.append(d.barra, d.aviso, d.semvinc, d.arqs, d.commit, d.limpo);
    c.el.append(d.raiz);
    c.det = d;
    return d;
  }
  function crescer(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px'; }
  function pintarDet(c, p) {
    const d = c.det || construirDet(c);
    d.raiz.hidden = false;
    const s = p.status;
    const op = st.ocupado.get(p.chave) || '';
    const git = !!(p.git && s);
    d.barra.hidden = !git;
    if (git) {
      const remoto = !!(p.repo || p.remoto);
      const rotB = s.branch || (s.destacado ? s.destacado + ' · destacado' : 'sem branch');
      rotular(d.bBranch, { ico: 'branch', rot: rotB, fim: 'baixo', gira: op === 'branch', aria: 'Branch atual: ' + rotB + '. Trocar ou criar branch', titulo: s.upstream ? 'Branch ' + rotB + ' · segue ' + s.upstream : 'Trocar ou criar branch' });
      desab(d.bBranch, !!op);
      d.sync.hidden = !remoto;
      if (remoto) {
        rotular(d.bReceber, { ico: 'desce', rot: 'Receber', n: s.atras || 0, tom: 'desce', gira: op === 'pull' || op === 'mesclar', aria: s.atras ? 'Receber ' + plural(s.atras, 'commit', 'commits') + ' do GitHub' : 'Receber do GitHub',
          titulo: !s.upstream ? 'Este branch ainda não existe no GitHub' : s.atras ? 'Receber ' + plural(s.atras, 'commit', 'commits') + ' de ' + s.upstream : 'Receber de ' + s.upstream + ' (busca e avança, sem merge)' });
        desab(d.bReceber, !!op || !s.upstream);
        const nada = s.semCommits || !s.branch || (s.upstream && !s.adiante);
        rotular(d.bEnviar, { ico: 'sobe', rot: 'Enviar', n: s.adiante || 0, tom: 'sobe', gira: op === 'push', aria: s.adiante ? 'Enviar ' + plural(s.adiante, 'commit', 'commits') + ' para o GitHub' : 'Enviar para o GitHub',
          titulo: s.semCommits ? 'Ainda não há commits' : !s.branch ? 'Troque para um branch antes de enviar' : !s.upstream ? 'Enviar e criar o branch ' + s.branch + ' no GitHub' : s.adiante ? 'Enviar ' + plural(s.adiante, 'commit', 'commits') + ' para ' + s.upstream : 'Nada para enviar' });
        desab(d.bEnviar, !!op || nada);
        rotular(d.bBuscar, { ico: 'buscar', rot: 'Buscar', gira: op === 'buscar' || op === 'conferir', aria: 'Buscar novidades no GitHub', titulo: 'Buscar novidades no GitHub (git fetch)' + (s.buscadoEm ? ' · última ' + rel(s.buscadoEm) : '') });
        desab(d.bBuscar, !!op);
      }
      const url = urlRepo(p.repo);
      d.bGithub.hidden = !url;
      if (url) d.bGithub.href = url + (s.branch ? '/tree/' + s.branch.split('/').map(encodeURIComponent).join('/') : '');
      desab(d.bMais, !!op);
    }
    // Sem vínculo
    const sv = !p.repo;
    d.semvinc.hidden = !sv;
    if (sv) {
      const fora = !!(p.remoto && !p.remoto.github);
      txt(d.svTexto, !p.git
        ? 'Esta pasta ainda não usa git. Vincule a um repositório do GitHub (os arquivos não mudam; o que for diferente aparece como alteração) ou crie um repositório novo com o que está aqui.'
        : fora ? 'O origin aponta para fora do GitHub (' + remotoCurto(p.remoto.url) + '). Vincular troca o origin por um repositório do GitHub, com confirmação.'
          : 'Este repositório ainda não tem um origin no GitHub. Vincule a um que já existe ou crie um novo com o que está aqui.');
      d.svVinc.hidden = !podeGithub();
      d.svCriar.hidden = !podeGithub() || fora;
      d.svConectar.hidden = podeGithub();
      txt(d.svConectar.lastChild, st.github.expirado ? 'Reconectar o GitHub' : 'Conectar o GitHub');
      desab(d.svVinc, !!op);
      desab(d.svCriar, !!op);
    }
    pintarAviso(c, p);
    pintarArquivos(c, p);
  }
  function linhaArq(a) {
    const partes = a.caminho.split('/');
    const nome = partes.pop();
    const dir = partes.join('/');
    const cb = h('input', { type: 'checkbox', class: 'rp-caixa', 'data-caminho': a.caminho, 'aria-label': 'Incluir ' + a.caminho });
    return h('label', { class: 'rp-arq' + (a.tipo === 'apagado' ? ' apagado' : ''), title: (a.de ? a.de + ' → ' : '') + a.caminho + ' · ' + (NOME_TIPO[a.tipo] || a.tipo) + (a.preparado ? ' · preparado' : '') },
      cb,
      h('span', { class: 'rp-letra t-' + (LETRA[a.tipo] ? a.tipo : 'nao-rastreado'), text: LETRA[a.tipo] || '?' }),
      h('span', { class: 'rp-arq-nome', text: nome }),
      a.de ? h('span', { class: 'rp-arq-dir', text: '← ' + a.de }) : dir ? h('span', { class: 'rp-arq-dir', text: dir }) : null,
      a.preparado ? h('span', { class: 'rp-prep', 'aria-label': 'preparado' }) : null);
  }
  function pintarArquivos(c, p) {
    const d = c.det, s = p.status;
    const arqs = arquivosDe(p);
    const mostra = !!(p.git && s && (arqs.length || s.alteracoes > 0));
    d.arqs.hidden = !mostra;
    d.commit.hidden = !mostra;
    d.limpo.hidden = !(p.git && s && !mostra);
    if (!mostra) return;
    const fora = st.desmarcados.get(p.chave) || new Set();
    for (const k of [...fora]) if (!arqs.some((a) => a.caminho === k)) fora.delete(k);
    const sig = JSON.stringify([arqs.map((a) => [a.caminho, a.tipo, !!a.preparado, a.de || '']), !!s.truncado]);
    if (d.lista._sig !== sig) {
      d.lista._sig = sig;
      const a0 = document.activeElement;
      const focado = a0 && d.lista.contains(a0) ? a0.dataset.caminho : null;
      d.lista.replaceChildren(...arqs.map(linhaArq));
      if (focado) { const alvo = [...d.lista.querySelectorAll('input')].find((x) => x.dataset.caminho === focado); if (alvo) alvo.focus({ preventScroll: true }); }
      txt(d.corte, s.truncado ? 'Mostrando os primeiros ' + arqs.length + ' arquivos. Com todos marcados, o commit leva também os que não aparecem.' : '');
      d.corte.hidden = !s.truncado;
    }
    for (const cb of d.lista.querySelectorAll('input.rp-caixa')) cb.checked = !fora.has(cb.dataset.caminho);
    const n = arqs.length, sel = arqs.filter((a) => !fora.has(a.caminho)).length;
    d.todos.checked = n > 0 && sel === n;
    d.todos.indeterminate = sel > 0 && sel < n;
    txt(d.nArq, s.truncado ? n + '+' : String(Math.max(n, s.alteracoes || 0)));
    pintarCommit(c, p);
  }
  function selecao(p) {
    const arqs = arquivosDe(p);
    const fora = st.desmarcados.get(p.chave) || new Set();
    const sel = arqs.filter((a) => !fora.has(a.caminho));
    return { arqs, sel, todos: sel.length === arqs.length };
  }
  function pintarCommit(c, p) {
    p = p || projeto(c.chave);
    const d = c.det;
    if (!d || !p) return;
    const { arqs, sel, todos } = selecao(p);
    const tem = d.msg.value.trim().length > 0;
    const op = st.ocupado.get(p.chave) || '';
    rotular(d.bCommit, { ico: 'commit', rot: todos ? 'Commit' : 'Commit ' + sel.length + ' de ' + arqs.length, gira: op === 'commit',
      aria: todos ? 'Fazer commit de todas as alterações' : 'Fazer commit de ' + sel.length + ' de ' + arqs.length + ' arquivos',
      titulo: !tem ? 'Escreva a mensagem do commit' : !sel.length ? 'Marque ao menos um arquivo' : (todos ? 'Commit de todas as alterações' : 'Commit só dos arquivos marcados') });
    desab(d.bCommit, !!op || !tem || (!sel.length && arqs.length > 0));
    d.msg.readOnly = op === 'commit';
  }
  function pintarAviso(c, p) {
    const d = c.det, a = st.avisos.get(p.chave);
    const sig = a ? JSON.stringify([a.titulo, a.texto, a.arquivos, a.saida, a.tom, a.acao && a.acao.rot]) : '';
    if (d.aviso._sig === sig) return;
    d.aviso._sig = sig;
    if (!a) { d.aviso.replaceChildren(); return; }
    const x = h('button', { type: 'button', class: 'btn-icone rp-x', title: 'Dispensar', 'aria-label': 'Dispensar aviso', onclick: () => { st.avisos.delete(p.chave); render(); } }, icone('x', 14));
    const corpo = h('div', { class: 'rp-aviso-txt' },
      h('b', { text: a.titulo }),
      a.texto ? h('p', { text: a.texto }) : null,
      a.arquivos && a.arquivos.length ? h('ul', null, ...a.arquivos.slice(0, 50).map((f) => h('li', { text: String(f), title: String(f) }))) : null,
      a.saida ? h('pre', { text: a.saida }) : null,
      a.acao ? h('div', { class: 'rp-aviso-acoes' }, h('button', { type: 'button', class: 'btn p', onclick: () => { st.avisos.delete(p.chave); a.acao.fn(); } }, a.acao.rot)) : null);
    d.aviso.replaceChildren(h('div', { class: 'rp-aviso' + (a.tom ? ' ' + a.tom : ''), role: 'alert' }, icone(a.tom === 'info' ? 'info' : 'alerta', 15), corpo, x));
  }

  // ── GitHub ──
  function renderGithub() {
    const pane = ui.paneGh;
    if (!podeGithub()) {
      const exp = st.github.expirado;
      reconciliar(pane, [memo('gh-conectar', exp, () => vazio({ ico: exp ? 'alerta' : 'github', tom: exp ? 'aviso' : '',
        titulo: exp ? 'Reconecte o GitHub' : 'Conecte o GitHub',
        texto: exp ? 'O GitHub recusou o token guardado: ele expirou ou foi revogado. Conecte um token novo para listar, clonar e enviar.' : 'Para listar, clonar, enviar e criar repositórios, o Orbit usa a conta do GitHub vinculada ao seu perfil.',
        acoes: [h('button', { type: 'button', class: 'btn solido', onclick: abrirPerfil }, icone('github', 15), exp ? 'Reconectar o GitHub' : 'Conectar o GitHub')] }))]);
      return;
    }
    if (st.repos == null && !st.reposCarregando && !st.reposErro) queueMicrotask(() => { if (st.repos == null && !st.reposCarregando) carregarRepos(false); });
    const perm = cartaoPermissoes();
    const corpo = st.repos == null
      ? (st.reposErro ? memo('gh-erro', st.reposErro.message, () => estadoErro(st.reposErro, () => carregarRepos(true))) : memo('gh-esq', '', () => esqueleto(5)))
      : listaRepos();
    reconciliar(pane, st.perm.destaque ? [perm, corpo] : [corpo, perm]);
  }
  function vinculosPorRepo() {
    const m = new Map();
    if (!st.lista) return m;
    for (const p of st.lista) if (p.repo && p.repo.completo) {
      const k = String(p.repo.completo).toLowerCase();
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return m;
  }
  function reposFiltrados() {
    const termos = norm(st.busca).split(/\s+/).filter(Boolean);
    return st.repos.filter((r) => (st.vis === 'todos' || (st.vis === 'publicos' ? r.visibilidade === 'publico' : r.visibilidade !== 'publico'))
      && (!termos.length || termos.every((t) => norm(r.completo + ' ' + str(r.descricao) + ' ' + str(r.linguagem)).includes(t))));
  }
  function listaRepos() {
    const todos = st.repos;
    const vincs = vinculosPorRepo();
    const filtrados = reposFiltrados();
    const sig = JSON.stringify([st.vis, st.busca, st.limite, st.reposLido, todos.length, filtrados.map((r) => r.id || r.completo).slice(0, st.limite),
      [...vincs.entries()].map(([k, v]) => k + ':' + v.map(nomeDe).join(',')), [...st.clones.entries()].map(([k, c]) => k + ':' + c.estado), st.github.login]);
    const m = ui.memo.get('gh-lista');
    if (m && m.sig === sig) { atualizarRodape(m.no); return m.no; }
    ui.progs.clear();
    const nPub = todos.filter((r) => r.visibilidade === 'publico').length;
    const seg = h('div', { class: 'seg-filtro rp-vis-seg', role: 'group', 'aria-label': 'Visibilidade' },
      ...[['todos', 'Todos', todos.length], ['publicos', 'Públicos', nPub], ['privados', 'Privados', todos.length - nPub]].map(([v, rot, n]) =>
        h('button', { type: 'button', 'aria-pressed': String(st.vis === v), 'data-foco': 'vis:' + v, onclick: () => { st.vis = v; st.limite = MAX_REPOS; render(); } },
          h('span', { class: 'rot', 'data-t': rot, text: rot }), h('span', { class: 'n' + (n ? '' : ' zero'), text: String(n) }))));
    const info = h('span', { class: 'rp-gh-info' });
    const topo = h('div', { class: 'rp-gh-topo' }, seg, info);
    let corpo;
    if (!filtrados.length) {
      corpo = st.busca.trim()
        ? vazio({ ico: 'busca', titulo: 'Nada encontrado', texto: 'Nenhum repositório com "' + st.busca.trim() + '".', acoes: [h('button', { type: 'button', class: 'btn', onclick: () => { ui.busca.value = ''; aoBuscar(); ui.busca.focus(); } }, 'Limpar busca')] })
        : st.vis !== 'todos' ? vazio({ ico: 'repo', titulo: st.vis === 'publicos' ? 'Nenhum repositório público' : 'Nenhum repositório privado', texto: 'Troque o filtro para ver os outros.' })
          : vazio({ ico: 'repo', titulo: 'Nenhum repositório na conta', texto: 'Crie um a partir de um projeto (aba Projetos) ou no próprio GitHub.' });
    } else {
      const linhas = filtrados.slice(0, st.limite).map((r) => linhaRepo(r, vincs.get(r.completo.toLowerCase()) || []));
      corpo = h('div', { class: 'rp-painel', role: 'list', 'aria-label': 'Repositórios' }, ...linhas);
      if (filtrados.length > st.limite) {
        corpo.append(h('div', { class: 'rp-painel-pe' }, h('button', { type: 'button', class: 'btn p', 'data-foco': 'mais-repos', onclick: () => { st.limite += 100; render(); } }, 'Mostrar mais (' + (filtrados.length - st.limite) + ')')));
      }
    }
    const no = h('div', { class: 'rp-gh' }, topo, corpo);
    no._info = info;
    no._n = filtrados.length;
    atualizarRodape(no);
    ui.memo.set('gh-lista', { sig, no });
    return no;
  }
  function atualizarRodape(no) {
    const n = no._n;
    txt(no._info, (n === st.repos.length ? plural(n, 'repositório', 'repositórios') : n + ' de ' + st.repos.length) + (st.reposLido ? ' · lida ' + rel(st.reposLido) : ''));
  }
  function linhaRepo(r, vincs) {
    const k = r.completo.toLowerCase();
    const priv = r.visibilidade !== 'publico';
    const ehDono = st.github.login && r.dono.toLowerCase() === st.github.login.toLowerCase();
    const clone = st.clones.get(k);
    const ico = r.arquivado ? 'arquivado' : r.fork ? 'fork' : priv ? 'cadeado' : 'repo';
    const l1 = h('div', { class: 'rp-r-l1' },
      h('span', { class: 'rp-r-nome', title: r.completo }, ehDono ? null : h('span', { class: 'rp-r-dono', text: r.dono + '/' }), r.nome),
      h('span', { class: 'rp-vis' + (priv ? ' priv' : ''), text: VIS[r.visibilidade] || 'Privado' }),
      r.arquivado ? h('span', { class: 'rp-vis', text: 'Arquivado' }) : null,
      r.fork ? h('span', { class: 'rp-vis', text: 'Fork' }) : null,
      r.podeEnviar === false ? h('span', { class: 'rp-vis', text: 'Só leitura', title: 'Você não tem permissão de escrita neste repositório' }) : null);
    const desc = h('span', { class: 'rp-r-desc' + (r.descricao ? '' : ' vazia'), text: r.descricao || 'Sem descrição', title: r.descricao || null });
    const lado = h('div', { class: 'rp-r-lado' },
      vincs.length ? h('span', { class: 'rp-selo-vinc', title: 'Vinculado a ' + vincs.map((p) => nomeDe(p) + ' (' + p.pasta + ')').join(', ') }, icone('link', 12),
        h('span', { text: vincs.length === 1 ? 'Vinculado a ' + nomeDe(vincs[0]) : 'Vinculado a ' + vincs.length + ' projetos' })) : null,
      h('span', { class: 'rp-r-meta' },
        r.branchPadrao ? h('span', { class: 'rp-branch', title: 'Branch padrão: ' + r.branchPadrao }, icone('branch', 12), h('span', { text: r.branchPadrao })) : null,
        r.linguagem ? h('span', { class: 'rp-r-ling', text: r.linguagem }) : null,
        r.atualizado ? relEl(r.atualizado, 'atualizado ', 'Último push: ') : null));
    const acoes = h('div', { class: 'rp-r-acoes' });
    if (clone && clone.estado === 'andando') {
      const i = h('i');
      const trilho = h('span', { class: 'rp-trilho' }, i);
      const pct = h('span', { class: 'rp-prog-pct' });
      acoes.append(h('button', { type: 'button', class: 'rp-prog', title: 'Ver o clone', 'aria-label': 'Clonando ' + r.completo + '; ver o progresso', 'data-foco': 'prog:' + k, onclick: () => dialogoClonar(r) }, trilho, pct));
      ui.progs.set(k, { i, pct, trilho });
      pintarProgressoLinha(clone);
    } else if (clone && clone.estado === 'ok' && clone.projeto) {
      acoes.append(h('button', { type: 'button', class: 'btn p', 'data-foco': 'ver:' + k, 'aria-label': 'Ver o projeto clonado', onclick: () => verProjeto(clone.projeto.chave) }, icone('pasta', 14), h('span', { class: 'rp-rot', text: 'Ver projeto' })));
    } else {
      acoes.append(h('button', { type: 'button', class: 'btn p rp-b-clonar', title: 'Clonar para uma pasta deste computador', 'aria-label': 'Clonar ' + r.completo, 'data-foco': 'clonar:' + k, onclick: () => dialogoClonar(r) }, icone('clonar', 14), h('span', { class: 'rp-rot', text: 'Clonar' })));
    }
    const mais = h('button', { type: 'button', class: 'btn-icone', title: 'Mais ações', 'aria-label': 'Mais ações para ' + r.completo, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-foco': 'mais:' + k }, icone('mais'));
    mais.addEventListener('click', () => menuRepo(mais, r, vincs));
    acoes.append(mais);
    return h('div', { class: 'rp-r' + (r.arquivado ? ' arquivado' : ''), role: 'listitem' },
      h('span', { class: 'rp-r-ico', title: r.arquivado ? 'Arquivado' : r.fork ? 'Fork' : VIS[r.visibilidade] || '' }, icone(ico, 15)),
      h('div', { class: 'rp-r-txt' }, l1, desc), lado, acoes);
  }
  function menuRepo(gatilho, r, vincs) {
    const url = urlRepo(r);
    menuPop(gatilho, [
      { ico: 'link', rot: 'Vincular a um projeto…', fn: () => abrirVincularProjeto(gatilho, r) },
      vincs.length === 1 ? { ico: 'pasta', rot: 'Ver projeto ' + nomeDe(vincs[0]), fn: () => verProjeto(vincs[0].chave) } : null,
      url ? { ico: 'externo', rot: 'Abrir no GitHub', fn: () => abrirUrl(url) } : null,
    ]);
  }

  // ── Permissões do token ──
  const PERMS = [
    { k: ['metadata', 'metadata:read', 'repository access', 'repositorios'], para: 'Listar os repositórios, privados inclusive', perm: [['Repository access: All repositories'], ' (ou os escolhidos) · ', ['Metadata: Read'], ' (automática)'] },
    { k: ['contents:read'], para: 'Buscar (↓), receber e clonar privados', perm: [['Contents: Read']] },
    { k: ['contents:write', 'contents'], para: 'Enviar (o commit é local)', perm: [['Contents: Read and write']] },
    { k: ['administration:write', 'administration', 'administration:read'], para: 'Criar repositório pelo Orbit', perm: [['Administration: Read and write'], ' (só se for usar)'] },
  ];
  function abrirPermissoes(faltando, destaque) {
    st.perm.faltando = Array.isArray(faltando) ? faltando.filter((f) => typeof f === 'string') : [];
    st.perm.aberto = true;
    if (destaque) st.perm.destaque = true;
  }
  function irParaPermissoes() {
    st.perm.aberto = true;
    st.perm.destaque = true;
    trocarAba('github');
    render();
    requestAnimationFrame(() => { if (ui.perm) ui.perm.el.scrollIntoView({ block: 'nearest', behavior: reduzido() ? 'auto' : 'smooth' }); });
  }
  function urlNovoToken() {
    return URL_TOKENS + '/new?name=Orbit&description=' + encodeURIComponent(DESC_TOKEN) + (st.github.login ? '&target_name=' + encodeURIComponent(st.github.login) : '') + '&expires_in=90&contents=write&administration=write';
  }
  function cartaoPermissoes() {
    if (!ui.perm) {
      const p = {};
      p.falta = h('span', { class: 'rp-pil alt', hidden: true });
      p.cab = h('button', { type: 'button', class: 'rp-perm-cab', 'aria-expanded': 'false' },
        h('span', { class: 'rp-quad' }, icone('escudo', 15)),
        h('span', { class: 'rp-perm-tit' }, h('b', { text: 'Permissões do token' }), h('small', { text: 'O que o Orbit precisa no GitHub (token fine-grained)' })),
        p.falta, h('span', { class: 'rp-seta' }, icone('chevron', 14)));
      p.cab.addEventListener('click', () => { st.perm.aberto = !st.perm.aberto; if (!st.perm.aberto) st.perm.destaque = false; render(); });
      p.tab = h('div', { class: 'rp-perm-tab' });
      p.extra = h('p', { class: 'rp-perm-extra', hidden: true });
      p.novo = h('a', { class: 'btn p solido', target: '_blank', rel: 'noopener noreferrer' }, 'Criar token com as permissões marcadas', icone('externo', 13));
      p.conferir = h('button', { type: 'button', class: 'btn p', 'data-foco': 'perm-conferir' }, 'Conferir de novo');
      p.conferir.addEventListener('click', async () => {
        if (inerte(p.conferir)) return;
        botaoGira(p.conferir, true, 'Conferindo…');
        const ok = await carregarRepos(true);
        botaoGira(p.conferir, false, 'Conferir de novo');
        if (ok) { st.perm.faltando = []; st.perm.destaque = false; render(); toast('Conferido. Se trocou o token, tente a ação de novo.', { tipo: 'ok' }); }
        else if (st.reposErro) toast(st.reposErro.message, { tipo: 'erro' });
      });
      p.corpo = h('div', { class: 'rp-perm-corpo', hidden: true }, p.tab, p.extra,
        h('p', { class: 'rp-perm-nota' }, icone('info', 14), h('span', { text: 'Em "Repository access", escolha All repositories (o GitHub não deixa marcar isso pelo link). Depois, conecte o token novo pelo botão do perfil.' })),
        h('div', { class: 'rp-perm-acoes' }, p.novo,
          h('a', { class: 'btn p', href: URL_TOKENS, target: '_blank', rel: 'noopener noreferrer' }, 'Editar token atual', icone('externo', 13)),
          p.conferir,
          h('button', { type: 'button', class: 'btn p contorno', onclick: abrirPerfil }, icone('github', 13), 'Conectar token novo')));
      p.el = h('div', { class: 'rp-perm' }, p.cab, p.corpo);
      ui.perm = p;
    }
    const p = ui.perm;
    const falt = st.perm.faltando.map((f) => f.toLowerCase().trim());
    const usados = new Set();
    const sig = JSON.stringify([falt, st.perm.aberto, st.perm.destaque, st.github.login]);
    if (p._sig !== sig) {
      p._sig = sig;
      p.el.classList.toggle('aberto', st.perm.aberto);
      p.el.classList.toggle('destaque', st.perm.destaque && falt.length > 0);
      p.cab.setAttribute('aria-expanded', String(st.perm.aberto));
      p.corpo.hidden = !st.perm.aberto;
      p.novo.href = urlNovoToken();
      const linhas = [h('div', { class: 'rp-perm-l cab', 'aria-hidden': 'true' }, h('span', { text: 'Para' }), h('span', { text: 'Permissão' }), h('span'))];
      let nFalta = 0;
      for (const l of PERMS) {
        const falta = l.k.some((k) => falt.includes(k));
        if (falta) { nFalta++; for (const k of l.k) if (falt.includes(k)) usados.add(k); }
        linhas.push(h('div', { class: 'rp-perm-l' + (falta ? ' falta' : '') }, h('span', { text: l.para }),
          h('span', { class: 'perm' }, ...l.perm.map((x) => (Array.isArray(x) ? h('b', { text: x[0] }) : x))),
          falta ? h('span', { class: 'rp-pil alt', text: 'Falta' }) : h('span')));
      }
      p.tab.replaceChildren(...linhas);
      const resto = falt.filter((f) => !usados.has(f));
      txt(p.extra, resto.length ? 'O GitHub também pediu: ' + resto.join(', ') + '.' : '');
      p.extra.hidden = !resto.length;
      const total = nFalta + resto.length;
      p.falta.hidden = !total;
      txt(p.falta, total ? (total === 1 ? 'Falta 1' : 'Faltam ' + total) : '');
    }
    return p.el;
  }

  // ───────────────────────────── ações ─────────────────────────────
  async function executar(chave, op, fn, aoErro) {
    if (st.ocupado.has(chave)) { if (op !== 'conferir') toast(ERROS.ocupado, { tipo: 'info' }); return; }
    st.ocupado.set(chave, op);
    render();
    try { await fn(); }
    catch (e) { if (!(aoErro && aoErro(e))) tratarErro(e, chave); }
    finally { st.ocupado.delete(chave); render(); }
  }
  const limparAviso = (chave) => st.avisos.delete(chave);
  function avisoDe(e, chave) {
    const d = e.dados || {};
    const arqs = Array.isArray(d.arquivos) ? d.arquivos.filter((x) => typeof x === 'string') : null;
    switch (e.codigo) {
      case 'divergiu': return { titulo: 'Os históricos divergiram', texto: e.message + ' Mesclar junta os dois num commit de merge (com confirmação).', acao: { rot: 'Mesclar…', fn: () => acaoPull(chave, true) } };
      case 'rejeitado': return { titulo: 'O GitHub tem commits que você ainda não tem', texto: e.message, acao: { rot: 'Receber', fn: () => acaoPull(chave) } };
      case 'sobrescreveria': return { titulo: 'O git recusou: nada mudou', texto: e.message, arquivos: arqs };
      case 'conflito': return { titulo: 'A mesclagem daria conflito: nada mudou', texto: e.message, arquivos: arqs };
      case 'sujo': return { titulo: 'Faça commit antes de mesclar', texto: e.message };
      case 'hook': return { titulo: 'Um hook do repositório recusou o commit', saida: str(d.erro) || e.message };
      case 'operacao': return { titulo: 'Há uma operação do git em andamento', texto: e.message };
      case 'parcial': return { titulo: 'Criado em parte', texto: e.message };
      case 'sem-upstream': return { titulo: 'O branch não existe no GitHub', texto: e.message, acao: { rot: 'Enviar', fn: () => acaoPush(chave) } };
      case 'destacado': return { titulo: 'Sem branch', texto: e.message };
      case 'nada': return { tom: 'info', titulo: 'Nada a fazer', texto: e.message };
      default: return null;
    }
  }
  function tratarErro(e, chave) {
    if (!(e instanceof ErroRepo)) { console.warn('repos', e); toast('Algo deu errado: ' + ((e && e.message) || e), { tipo: 'erro' }); return; }
    const d = e.dados || {};
    if (valido(d.projeto)) aplicarProjeto(d.projeto);
    if (e.codigo === 'permissao') { abrirPermissoes(d.faltando, true); toast(e.message, { tipo: 'erro', acao: { rot: 'Ver permissões', fn: irParaPermissoes } }); render(); return; }
    if (e.codigo === 'sem-github') { aplicarGithub(Object.assign({}, st.github, { conectado: false })); toast(e.message, { tipo: 'erro', acao: { rot: 'Conectar', fn: abrirPerfil } }); render(); return; }
    if (e.codigo === 'expirado') { aplicarGithub(Object.assign({}, st.github, { expirado: true })); toast(e.message, { tipo: 'erro', acao: { rot: 'Reconectar', fn: abrirPerfil } }); render(); return; }
    const aviso = chave ? avisoDe(e, chave) : null;
    if (aviso && st.aberto === chave) { st.avisos.set(chave, aviso); render(); return; }
    toast(e.message, { tipo: 'erro', acao: aviso && aviso.acao ? { rot: aviso.acao.rot, fn: () => { verProjeto(chave); aviso.acao.fn(); } } : null });
  }

  function acaoCommit(chave) {
    const p = projeto(chave), c = ui.cartoes.get(chave);
    if (!p || !c || !c.det || st.ocupado.has(chave)) return;
    const msg = c.det.msg.value.trim();
    if (!msg) { c.det.msg.focus(); return; }
    const { sel, todos } = selecao(p);
    if (!todos && !sel.length) return;
    const corpo = { pasta: p.pasta, mensagem: msg };
    if (!todos) corpo.arquivos = [...new Set(sel.flatMap((a) => (a.de ? [a.de, a.caminho] : [a.caminho])))];
    executar(chave, 'commit', async () => {
      const d = await pedir('/repos/commit', corpo);
      if (!d) return;
      c.det.msg.value = '';
      crescer(c.det.msg);
      st.desmarcados.delete(chave);
      limparAviso(chave);
      if (d.projeto) aplicarProjeto(d.projeto);
      toast('Commit feito: ' + primeiraLinha(msg), { tipo: 'ok' });
    });
  }
  function acaoPush(chave) {
    const p = projeto(chave);
    if (!p) return;
    executar(chave, 'push', async () => {
      const d = await pedir('/repos/push', { pasta: p.pasta });
      if (!d) return;
      limparAviso(chave);
      if (d.projeto) aplicarProjeto(d.projeto);
      const s = (d.projeto && d.projeto.status) || p.status || {};
      toast(s.upstream ? 'Enviado para ' + s.upstream : 'Enviado para o GitHub', { tipo: 'ok' });
    });
  }
  function acaoPull(chave, mesclar) {
    const p = projeto(chave);
    if (!p) return;
    executar(chave, mesclar ? 'mesclar' : 'pull', async () => {
      const d = await pedir('/repos/pull', mesclar ? { pasta: p.pasta, mesclar: true } : { pasta: p.pasta });
      if (!d) return;
      limparAviso(chave);
      if (d.projeto) aplicarProjeto(d.projeto);
      const s = (d.projeto && d.projeto.status) || p.status || {};
      toast((mesclar ? 'Mesclado. ' : '') + 'Em dia com ' + (s.upstream || 'o GitHub') + (s.adiante ? '; ' + plural(s.adiante, 'commit', 'commits') + ' para enviar' : ''), { tipo: 'ok' });
    });
  }
  function acaoBuscar(chave) {
    const p = projeto(chave);
    if (!p) return;
    st.conferido.set(chave, Date.now());
    executar(chave, 'buscar', async () => {
      const d = await pedir('/repos/buscar', { pasta: p.pasta });
      if (!d) return;
      if (d.projeto) aplicarProjeto(d.projeto);
      const s = d.projeto && d.projeto.status;
      toast(s && s.atras ? plural(s.atras, 'commit novo', 'commits novos') + ' no GitHub' : 'Nada novo no GitHub', { tipo: 'ok' });
    });
  }
  function acaoBranch(chave, nome, criar) {
    const p = projeto(chave);
    if (!p) return;
    executar(chave, 'branch', async () => {
      const d = await pedir('/repos/branch', criar ? { pasta: p.pasta, nome, criar: true } : { pasta: p.pasta, nome });
      if (!d) return;
      limparAviso(chave);
      if (d.projeto) aplicarProjeto(d.projeto);
      toast(criar ? 'Branch ' + nome + ' criado' : 'Agora em ' + nome, { tipo: 'ok' });
    });
  }
  function acaoVincular(chave, completo) {
    const p = projeto(chave);
    if (!p) return;
    executar(chave, 'vincular', async () => {
      const d = await pedir('/repos/vincular', { pasta: p.pasta, repo: completo });
      if (!d) return;
      limparAviso(chave);
      if (d.projeto) aplicarProjeto(d.projeto);
      st.reposVelho = true;
      toast(nomeDe(p) + ' vinculado a ' + completo, { tipo: 'ok', acao: st.aba !== 'projetos' ? { rot: 'Ver projeto', fn: () => verProjeto(chave) } : null });
    });
  }
  function acaoDesvincular(chave) {
    const p = projeto(chave);
    if (!p) return;
    executar(chave, 'desvincular', async () => {
      const d = await pedir('/repos/desvincular', { pasta: p.pasta });
      if (!d) return;
      limparAviso(chave);
      if (d.projeto) aplicarProjeto(d.projeto);
      st.reposVelho = true;
      toast('Desvinculado. O histórico local continua na pasta.', { tipo: 'ok' });
    });
  }
  function acaoRemover(chave) {
    const p = projeto(chave);
    if (!p) return;
    executar(chave, 'remover', async () => {
      const d = await pedir('/repos/remover', { pasta: p.pasta });
      if (!d) return;
      st.lista = st.lista.filter((x) => x.chave !== chave);
      if (st.aberto === chave) { st.aberto = null; st.fixo = null; }
      carregarProjetos({ forcar: true });
      toast('Tirado da lista. A pasta continua no disco.', { tipo: 'ok', acao: p.existe !== false ? { rot: 'Desfazer', fn: () => readicionar(p.pasta) } : null });
    });
  }
  async function readicionar(pasta) {
    try { const d = await pedir('/repos/adicionar', { pasta }); if (d && d.projeto) aplicarProjeto(d.projeto); carregarProjetos({ forcar: true }); }
    catch (e) { tratarErro(e, null); }
  }
  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); toast('Caminho copiado', { tipo: 'ok', ms: 2200 }); }
    catch { toast('Não deu para copiar o caminho.', { tipo: 'erro' }); }
  }
  function verProjeto(chave) {
    st.buscaProj = '';
    if (st.aba !== 'projetos') { st.aba = 'projetos'; fecharPopover(false); }
    ui.busca.value = '';
    ui.buscaRot.classList.remove('tem');
    const abrir = st.aberto !== chave;
    if (abrir) { st.aberto = chave; st.fixo = mapaFixo(); }
    render();
    const c = ui.cartoes.get(chave);
    if (c) {
      c.abrir.focus({ preventScroll: true });
      c.el.scrollIntoView({ block: 'nearest', behavior: reduzido() ? 'auto' : 'smooth' });
      if (abrir) aoAbrirProjeto(chave);
    }
  }
  function menuProjeto(c) {
    const p = c.p;
    if (!p) return;
    menuPop(c.det.bMais, [
      { ico: 'copiar', rot: 'Copiar caminho', fn: () => copiar(p.pasta) },
      p.repo || p.remoto ? { ico: 'desvincular', rot: 'Desvincular', perigo: true, fn: () => acaoDesvincular(p.chave) } : null,
      podeRemover(p) ? { ico: 'tirar', rot: 'Tirar da lista', fn: () => acaoRemover(p.chave) } : null,
    ]);
  }

  // ───────────────────────────── popovers ─────────────────────────────
  function abrirPopover(gatilho, cfg) {
    const mesmo = ui.pop && ui.pop.gatilho === gatilho;
    fecharPopover(false);
    if (mesmo) { gatilho.focus({ preventScroll: true }); return null; }
    gatilho.scrollIntoView({ block: 'nearest' });
    const el = h('div', { class: 'rp-pop' + (cfg.classe ? ' ' + cfg.classe : ''), role: cfg.papel || 'dialog', 'aria-label': cfg.rotulo || null, tabindex: '-1' });
    const pop = { el, gatilho, alinhar: cfg.alinhar || 'inicio', tecla: null, foco: null, lado: null };
    ui.pop = pop;
    document.body.append(el);
    gatilho.setAttribute('aria-expanded', 'true');
    cfg.montar(pop);
    posicionarPop();
    (pop.foco || el).focus({ preventScroll: true });
    return pop;
  }
  function fecharPopover(devolver) {
    const p = ui.pop;
    if (!p) return;
    ui.pop = null;
    p.el.remove();
    if (p.gatilho.isConnected) {
      p.gatilho.setAttribute('aria-expanded', 'false');
      if (devolver) p.gatilho.focus({ preventScroll: true });
    }
  }
  function foraDoPopover(e) {
    const p = ui.pop;
    if (p && !p.el.contains(e.target) && !p.gatilho.contains(e.target)) fecharPopover(false);
  }
  // Abaixo do gatilho (ou acima, se não couber), ancorado pela borda perto dele: a lista muda de
  // altura enquanto se digita e a borda ancorada fica parada.
  function posicionarPop() {
    const p = ui.pop;
    if (!p) return;
    if (!p.gatilho.isConnected) { fecharPopover(false); return; }
    const r = p.gatilho.getBoundingClientRect();
    const m = 12, vw = innerWidth, vh = innerHeight, s = p.el.style;
    if ((!r.width && !r.height) || r.bottom < 0 || r.top > vh) { fecharPopover(false); return; }
    const w = p.el.offsetWidth;
    const x = p.alinhar === 'fim' ? r.right - w : r.left;
    s.left = Math.round(Math.max(m, Math.min(x, vw - w - m))) + 'px';
    const abaixo = vh - r.bottom - 6 - m, acima = r.top - 6 - m;
    if (!p.lado) p.lado = abaixo >= Math.min(300, p.el.scrollHeight) || abaixo >= acima ? 'baixo' : 'cima';
    if (p.lado === 'baixo') Object.assign(s, { top: Math.round(r.bottom + 6) + 'px', bottom: 'auto', maxHeight: Math.max(140, abaixo) + 'px' });
    else Object.assign(s, { top: 'auto', bottom: Math.round(vh - r.top + 6) + 'px', maxHeight: Math.max(140, acima) + 'px' });
    p.el.classList.toggle('acima', p.lado === 'cima');
  }
  const msgPop = (t, acao) => h('div', { class: 'rp-pop-msg' }, h('span', { text: t }), acao || null);
  const carregandoPop = () => h('div', { class: 'rp-pop-msg' }, gira(), h('span', { text: 'Carregando…' }));
  function comboPop(pop, cfg) {
    const idLista = novoId('lista');
    const campo = h('input', { type: 'text', class: 'rp-pop-campo', placeholder: cfg.placeholder, 'aria-label': cfg.rotulo, role: 'combobox', 'aria-expanded': 'true', 'aria-controls': idLista, 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' });
    const lista = h('div', { class: 'rp-pop-lista', id: idLista, role: 'listbox', 'aria-label': cfg.rotulo });
    pop.el.append(h('label', { class: 'rp-pop-topo' }, icone('busca', 14), campo), lista);
    let itens = [], ativo = -1;
    function marcar(i, rolar) {
      if (itens[ativo]) { itens[ativo].el.classList.remove('ativo'); itens[ativo].el.setAttribute('aria-selected', 'false'); }
      ativo = itens.length ? (i + itens.length) % itens.length : -1;
      const it = itens[ativo];
      if (it) {
        it.el.classList.add('ativo');
        it.el.setAttribute('aria-selected', 'true');
        campo.setAttribute('aria-activedescendant', it.el.id);
        if (rolar) it.el.scrollIntoView({ block: 'nearest' });
      } else campo.removeAttribute('aria-activedescendant');
    }
    function escolher(it) { if (!it) return; fecharPopover(true); if (it.fn) it.fn(); }
    function pintar() {
      const nos = [];
      itens = [];
      ativo = -1;
      for (const o of cfg.opcoes(campo.value.trim())) {
        if (o.rot) { nos.push(h('div', { class: 'rp-pop-rot', role: 'presentation', text: o.rot })); continue; }
        if (o.no) { nos.push(o.no); continue; }
        const el = h('div', { id: novoId('op'), class: 'rp-op' + (o.atual ? ' atual' : '') + (o.tom ? ' ' + o.tom : ''), role: 'option', 'aria-selected': 'false', title: o.titulo || o.texto },
          o.ico ? icone(o.ico, 14) : null, h('span', { class: 'rp-op-rot', text: o.texto }), o.sub ? h('span', { class: 'rp-op-sub', text: o.sub }) : null);
        const it = { el, fn: o.fn };
        const i = itens.length;
        el.addEventListener('mousedown', (e) => e.preventDefault());
        el.addEventListener('mousemove', () => { if (ativo !== i) marcar(i, false); });
        el.addEventListener('click', () => escolher(it));
        itens.push(it);
        nos.push(el);
      }
      lista.replaceChildren(...nos);
      marcar(0, false);
      posicionarPop();
    }
    campo.addEventListener('input', pintar);
    pop.tecla = (e) => {
      if (e.key === 'ArrowDown') { marcar(ativo + 1, true); return true; }
      if (e.key === 'ArrowUp') { marcar(ativo - 1, true); return true; }
      if (e.key === 'Enter') { escolher(itens[ativo]); return true; }
      return false;
    };
    pintar();
    pop.foco = campo;
    return { repintar: () => { if (ui.pop === pop) pintar(); } };
  }
  function menuPop(gatilho, itens) {
    const lista = itens.filter(Boolean);
    abrirPopover(gatilho, { papel: 'menu', classe: 'rp-menu', alinhar: 'fim', rotulo: 'Ações', montar(pop) {
      const bs = lista.map((it) => h('button', { type: 'button', role: 'menuitem', class: 'rp-op' + (it.perigo ? ' perigo' : ''), onclick: () => { fecharPopover(true); it.fn(); } },
        icone(it.ico, 14), h('span', { class: 'rp-op-rot', text: it.rot })));
      pop.el.append(...bs);
      pop.tecla = (e) => {
        const i = bs.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { bs[(i + 1) % bs.length].focus(); return true; }
        if (e.key === 'ArrowUp') { bs[(i - 1 + bs.length) % bs.length].focus(); return true; }
        if (e.key === 'Home') { bs[0].focus(); return true; }
        if (e.key === 'End') { bs[bs.length - 1].focus(); return true; }
        return false;
      };
      pop.foco = bs[0];
    } });
  }
  function abrirVincular(gatilho, chave) {
    abrirPopover(gatilho, { classe: 'rp-combo', rotulo: 'Vincular repositório', montar(pop) {
      const combo = comboPop(pop, { placeholder: 'Buscar repositório…', rotulo: 'Repositórios do GitHub', opcoes(q) {
        if (!podeGithub()) return [{ no: msgPop('Conecte o GitHub para ver seus repositórios.', h('button', { type: 'button', class: 'btn p', onclick: () => { fecharPopover(false); abrirPerfil(); } }, 'Conectar o GitHub')) }];
        if (st.repos == null) return [{ no: st.reposErro ? msgPop(st.reposErro.message) : carregandoPop() }];
        const termos = norm(q).split(/\s+/).filter(Boolean);
        const r = st.repos.filter((x) => !termos.length || termos.every((t) => norm(x.completo + ' ' + str(x.descricao)).includes(t))).slice(0, 60);
        if (!r.length) return [{ no: msgPop(q ? 'Nenhum repositório com "' + q + '".' : 'Nenhum repositório na conta.') }];
        return r.map((x) => ({ ico: x.visibilidade !== 'publico' ? 'cadeado' : 'repo', texto: x.completo, sub: x.atualizado ? rel(x.atualizado) : '', titulo: x.completo + (x.descricao ? ' — ' + x.descricao : ''), fn: () => acaoVincular(chave, x.completo) }));
      } });
      if (st.repos == null && podeGithub()) carregarRepos(false, true).then(combo.repintar);
    } });
  }
  function abrirVincularProjeto(gatilho, r) {
    abrirPopover(gatilho, { classe: 'rp-combo', rotulo: 'Vincular a um projeto', alinhar: 'fim', montar(pop) {
      comboPop(pop, { placeholder: 'Vincular ' + r.nome + ' a…', rotulo: 'Projetos sem repositório', opcoes(q) {
        const livres = (st.lista || []).filter((p) => p.existe !== false && !p.bloqueado && !p.repo);
        if (!livres.length) return [{ no: msgPop('Todos os projetos já têm repositório.', h('button', { type: 'button', class: 'btn p', onclick: () => { fecharPopover(false); dialogoAdicionar(); } }, 'Adicionar pasta')) }];
        const l = filtrarProjetos(livres, q);
        if (!l.length) return [{ no: msgPop('Nenhum projeto com "' + q + '".') }];
        return l.map((p) => ({ ico: 'pasta', texto: nomeDe(p), sub: caminhoCurto(p.pasta), titulo: p.pasta, fn: () => acaoVincular(p.chave, r.completo) }));
      } });
    } });
  }
  function abrirBranches(c) {
    const p = c.p;
    let dados = null, erro = null;
    abrirPopover(c.det.bBranch, { classe: 'rp-combo', rotulo: 'Branches', montar(pop) {
      const combo = comboPop(pop, { placeholder: 'Trocar ou criar branch…', rotulo: 'Branches', opcoes(q) {
        if (erro) return [{ no: msgPop(erro) }];
        if (!dados) return [{ no: carregandoPop() }];
        const qn = norm(q);
        const loc = dados.locais.filter((b) => !qn || norm(b.nome).includes(qn));
        const rem = dados.remotos.filter((b) => !qn || norm(b.nome).includes(qn));
        const out = [];
        if (loc.length) {
          out.push({ rot: 'Neste computador' });
          for (const b of loc) {
            const atual = b.nome === dados.atual;
            const sub = [b.adiante ? '↑' + b.adiante : '', b.atras ? '↓' + b.atras : ''].filter(Boolean).join(' ') || (b.upstream ? '' : 'só local') || (b.data ? rel(b.data) : '');
            out.push({ ico: atual ? 'check' : 'branch', texto: b.nome, sub: atual ? 'atual' : sub, atual, titulo: b.nome + (b.upstream ? ' · segue ' + b.upstream : ''), fn: atual ? null : () => acaoBranch(p.chave, b.nome) });
          }
        }
        if (rem.length) {
          out.push({ rot: 'No GitHub' });
          for (const b of rem) out.push({ ico: 'nuvem', texto: b.nome, sub: b.data ? rel(b.data) : '', fn: () => acaoBranch(p.chave, b.nome) });
        }
        const novo = q.trim().replace(/\s+/g, '-');
        if (novo && !dados.locais.some((b) => b.nome === novo) && !dados.remotos.some((b) => b.nome === novo)) {
          out.push({ ico: 'mais1', texto: 'Criar branch "' + novo + '"', sub: 'a partir de ' + (dados.atual || 'HEAD'), tom: 'criar', fn: () => acaoBranch(p.chave, novo, true) });
        }
        if (!out.length) out.push({ no: msgPop('Nenhum branch.') });
        return out;
      } });
      obter('/repos/branches?pasta=' + encodeURIComponent(p.pasta)).then((d) => {
        const arr = (v) => (Array.isArray(v) ? v.filter((b) => b && typeof b.nome === 'string') : []);
        dados = { atual: str(d.atual), locais: arr(d.locais), remotos: arr(d.remotos) };
        combo.repintar();
      }).catch((e) => { erro = e.message; combo.repintar(); });
    } });
  }

  // ───────────────────────────── diálogos ─────────────────────────────
  function focarPrimeiro(raiz) { const f = focaveis(raiz); (f[0] || raiz).focus({ preventScroll: true }); }
  function criarDialogo(cfg) {
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    fecharPopover(false);
    const idT = novoId('dlg');
    const corpo = h('div', { class: 'rp-modal-corpo' });
    const pe = h('div', { class: 'rp-modal-pe' });
    const raiz = h(cfg.form ? 'form' : 'div', { class: 'rp-modal', role: cfg.alerta ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': idT, novalidate: cfg.form ? true : null, tabindex: '-1' },
      h('div', { class: 'rp-modal-cab' },
        h('span', { class: 'rp-quad' + (cfg.tom ? ' ' + cfg.tom : '') }, icone(cfg.icone || 'info', 16)),
        h('div', { class: 'rp-modal-tit' }, h('h2', { id: idT, text: cfg.titulo, title: cfg.titulo }), cfg.sub ? h('p', { text: cfg.sub, title: cfg.sub }) : null)),
      corpo, pe);
    const camada = h('div', { class: 'rp-camada' }, raiz);
    const dlg = { raiz, corpo, pe, camada, fechado: false };
    dlg.fechar = () => {
      if (dlg.fechado) return;
      dlg.fechado = true;
      camada.remove();
      const i = pilha.indexOf(dlg);
      if (i >= 0) pilha.splice(i, 1);
      const topo = pilha[pilha.length - 1];
      if (topo) topo.camada.hidden = false;
      if (anterior && anterior.isConnected && (!topo || topo.raiz.contains(anterior))) anterior.focus({ preventScroll: true });
      else if (topo) focarPrimeiro(topo.raiz);
    };
    dlg.cancelar = () => (cfg.aoCancelar ? cfg.aoCancelar() : dlg.fechar());
    camada.addEventListener('mousedown', (e) => { if (e.target === camada) dlg.cancelar(); });
    const topo = pilha[pilha.length - 1];
    if (topo) topo.camada.hidden = true;
    pilha.push(dlg);
    document.body.append(camada);
    return dlg;
  }
  function listaItens(itens) {
    return h('ul', { class: 'rp-itens' }, ...itens.map((t) => {
      const m = /^([0-9a-f]{7,40})\s+(.*)$/.exec(t);
      return m ? h('li', { title: t }, h('span', { class: 'sha', text: m[1] }), h('span', { class: 't', text: m[2] })) : h('li', { title: t }, h('span', { class: 't', text: t }));
    }));
  }
  // Diálogo do 409 { codigo:'confirmar' }: título, mensagem, itens e o verbo do servidor. Com perigo,
  // o foco começa em Cancelar.
  function confirmar(d) {
    return new Promise((resolve) => {
      let feito = false;
      const perigo = !!d.perigo;
      const dlg = criarDialogo({ titulo: str(d.titulo) || 'Confirmar?', icone: perigo ? 'alerta' : 'info', tom: perigo ? 'perigo' : '', alerta: true, aoCancelar: () => fim(false) });
      function fim(v) { if (feito) return; feito = true; dlg.fechar(); resolve(v); }
      const nao = h('button', { type: 'button', class: 'btn', onclick: () => fim(false) }, 'Cancelar');
      const sim = h('button', { type: 'button', class: 'btn ' + (perigo ? 'perigo' : 'solido') + ' rp-b-confirmar', onclick: () => fim(true) }, str(d.botao) || 'Confirmar');
      if (str(d.mensagem)) dlg.corpo.append(h('p', { class: 'rp-modal-msg', text: d.mensagem }));
      const itens = Array.isArray(d.itens) ? d.itens.filter((x) => typeof x === 'string') : [];
      if (itens.length) dlg.corpo.append(listaItens(itens));
      if (!dlg.corpo.childNodes.length) dlg.corpo.hidden = true;
      dlg.pe.append(nao, sim);
      (perigo ? nao : sim).focus({ preventScroll: true });
    });
  }
  function campoL(rot, campo, ...extra) { return h('label', { class: 'rp-campo-l' }, h('span', { text: rot }), campo, ...extra); }
  function erroCampo() { return h('p', { class: 'rp-erro-campo', role: 'alert', hidden: true }); }
  function mostrarErro(el, campo, msg, acao) {
    el.replaceChildren(...(msg ? [h('span', { text: msg }), acao || null].filter(Boolean) : []));
    el.hidden = !msg;
    if (campo) campo.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  const linkPerm = (dlg) => h('button', { type: 'button', class: 'rp-link', onclick: () => { dlg.fechar(); irParaPermissoes(); } }, 'Ver permissões do token');

  function dialogoAdicionar() {
    const dlg = criarDialogo({ titulo: 'Adicionar pasta', sub: 'Uma pasta que já existe neste computador', icone: 'pastaMais', form: true });
    const campo = h('input', { class: 'rp-campo mono', type: 'text', placeholder: juntar(st.pastaClones || (MAC ? '/Users/voce/Projetos' : 'D:\\Projetos'), 'minha-pasta'), autocomplete: 'off', spellcheck: 'false' });
    const erro = erroCampo();
    const ok = h('button', { type: 'submit', class: 'btn solido' }, 'Adicionar');
    dlg.corpo.append(h('p', { class: 'rp-modal-msg', text: 'Cole o caminho completo. O Orbit só passa a mostrar o status dela; nada muda nos arquivos.' }), campoL('Caminho da pasta', campo), erro);
    dlg.pe.append(h('button', { type: 'button', class: 'btn', onclick: () => dlg.cancelar() }, 'Cancelar'), ok);
    let enviando = false;
    dlg.raiz.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (enviando) return;
      const pasta = limparCaminho(campo.value);
      if (!pasta) { mostrarErro(erro, campo, 'Cole o caminho da pasta.'); campo.focus(); return; }
      enviando = true;
      botaoGira(ok, true, 'Adicionando…');
      try {
        const d = await pedir('/repos/adicionar', { pasta });
        if (dlg.fechado) return;
        dlg.fechar();
        if (d && valido(d.projeto)) { aplicarProjeto(d.projeto); verProjeto(d.projeto.chave); }
        carregarProjetos({ forcar: true });
        toast('Pasta adicionada: ' + (d && d.projeto ? nomeDe(d.projeto) : pasta), { tipo: 'ok' });
      } catch (err) {
        if (dlg.fechado) return;
        mostrarErro(erro, campo, err.message);
        campo.focus();
        campo.select();
      } finally {
        enviando = false;
        if (!dlg.fechado) botaoGira(ok, false, 'Adicionar');
      }
    });
    campo.focus();
  }

  function dialogoCriar(chave) {
    const p = projeto(chave);
    if (!p) return;
    const login = st.github.login || 'sua-conta';
    const dlg = criarDialogo({ titulo: 'Criar no GitHub', sub: nomeDe(p) + ' · ' + caminhoCurto(p.pasta), icone: 'github', form: true });
    const cNome = h('input', { class: 'rp-campo', type: 'text', maxlength: '100', autocomplete: 'off', spellcheck: 'false' });
    cNome.value = nomeSugerido(nomeDe(p));
    const eNome = erroCampo();
    const cDesc = h('input', { class: 'rp-campo', type: 'text', maxlength: '350', placeholder: 'Opcional', autocomplete: 'off' });
    const idPriv = novoId('priv');
    const cPriv = h('input', { type: 'checkbox', class: 'chave', id: idPriv });
    cPriv.checked = true;
    const visTxt = h('small');
    const previa = h('code');
    const eGeral = erroCampo();
    const atualizar = () => {
      const t = 'github.com/' + login + '/' + (cNome.value.trim() || '…');
      txt(previa, t);
      previa.title = t;
      txt(visTxt, cPriv.checked ? 'Só você (e quem você convidar) vê.' : 'Qualquer pessoa vê.');
    };
    cNome.addEventListener('input', atualizar);
    cPriv.addEventListener('change', atualizar);
    atualizar();
    const ok = h('button', { type: 'submit', class: 'btn solido' }, 'Continuar');
    dlg.corpo.append(
      campoL('Nome do repositório', cNome, eNome),
      campoL('Descrição', cDesc),
      h('label', { class: 'rp-chave-l', for: idPriv }, h('span', null, h('b', { text: 'Privado' }), visTxt), cPriv),
      h('div', { class: 'rp-previa' }, h('span', { text: 'Vai criar' }), previa),
      h('p', { class: 'rp-modal-nota', text: 'O Orbit inicia o git se precisar, faz o primeiro commit com os arquivos da pasta e envia. Antes, mostra o que vai acontecer.' }),
      eGeral);
    dlg.pe.append(h('button', { type: 'button', class: 'btn', onclick: () => dlg.cancelar() }, 'Cancelar'), ok);
    dlg.raiz.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (inerte(ok)) return;
      const nome = cNome.value.trim();
      if (!RE_NOME.test(nome) || nome === '.' || nome === '..') { mostrarErro(eNome, cNome, 'Use só letras, números, hífen, ponto ou sublinhado (até 100).'); cNome.focus(); return; }
      mostrarErro(eNome, cNome, '');
      mostrarErro(eGeral, null, '');
      const corpo = { pasta: p.pasta, nome, privado: cPriv.checked };
      if (cDesc.value.trim()) corpo.descricao = cDesc.value.trim();
      botaoGira(ok, true, 'Criando…');
      await executar(chave, 'criar', async () => {
        const d = await pedir('/repos/criar', corpo);
        if (!d) return;
        dlg.fechar();
        if (d.projeto) aplicarProjeto(d.projeto);
        st.reposVelho = true;
        st.repos = null;
        toast('Criado no GitHub: ' + (d.projeto && d.projeto.repo ? d.projeto.repo.completo : login + '/' + nome), { tipo: 'ok' });
      }, (err) => {
        if (dlg.fechado) return false;
        if (err.codigo === 'parcial') { dlg.fechar(); return false; }
        if (err.codigo === 'nome-em-uso') { mostrarErro(eNome, cNome, err.message); cNome.focus(); cNome.select(); return true; }
        if (err.codigo === 'permissao') { abrirPermissoes(err.dados.faltando, true); mostrarErro(eGeral, null, err.message, linkPerm(dlg)); return true; }
        if (err.codigo === 'expirado' || err.codigo === 'sem-github') return false;
        mostrarErro(eGeral, null, err.message);
        return true;
      });
      if (!dlg.fechado) botaoGira(ok, false, 'Continuar');
    });
    cNome.focus();
    cNome.select();
  }

  // ── Clonar (progresso pelo SSE; o diálogo pode fechar e reabrir pela linha) ──
  const nomeFase = (f) => { for (const [re, t] of FASES) if (re.test(f)) return t; return f || 'Clonando…'; };
  function pintarProgressoLinha(clone) {
    const g = ui.progs.get(clone.completo.toLowerCase());
    if (!g) return;
    g.trilho.classList.toggle('indef', clone.pct == null);
    g.i.style.width = clone.pct == null ? '' : clone.pct + '%';
    txt(g.pct, clone.pct == null ? 'clonando…' : clone.pct + '%');
  }
  function progressoClone(ev) {
    const alvo = normCaminho(ev.pasta);
    const andando = [...st.clones.values()].filter((c) => c.estado === 'andando');
    const clone = andando.find((c) => c.chave === alvo) || (andando.length === 1 ? andando[0] : null);
    if (!clone) return;
    clone.fase = str(ev.fase);
    if (typeof ev.pct === 'number' && isFinite(ev.pct)) clone.pct = Math.max(0, Math.min(100, Math.round(ev.pct)));
    pintarProgressoLinha(clone);
    if (clone.vista) clone.vista.progresso();
  }
  function dialogoClonar(r) {
    const k = r.completo.toLowerCase();
    const dlg = criarDialogo({ titulo: 'Clonar ' + r.nome, sub: r.completo, icone: 'clonar', form: true,
      aoCancelar: () => { const c = st.clones.get(k); if (c && c.vista === vista) c.vista = null; dlg.fechar(); } });
    let fase = 'form';
    const cDest = h('input', { class: 'rp-campo mono', type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const cNome = h('input', { class: 'rp-campo mono', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '200' });
    const eNome = erroCampo(), eGeral = erroCampo();
    const previa = h('code');
    const atualizar = () => { const c = juntar(limparCaminho(cDest.value) || st.pastaClones, cNome.value.trim() || r.nome); txt(previa, c); previa.title = c; };
    cDest.addEventListener('input', atualizar);
    cNome.addEventListener('input', atualizar);
    const barraI = h('i'), barra = h('span', { class: 'rp-trilho grande' }, barraI);
    const faseTxt = h('span'), pctTxt = h('b');
    const vista = {
      progresso() {
        const c = st.clones.get(k);
        if (!c || fase !== 'andando') return;
        barra.classList.toggle('indef', c.pct == null);
        barraI.style.width = c.pct == null ? '' : c.pct + '%';
        txt(faseTxt, nomeFase(c.fase));
        txt(pctTxt, c.pct == null ? '' : c.pct + '%');
      },
      feito(c) {
        fase = 'feito';
        dlg.corpo.replaceChildren(h('div', { class: 'rp-feito' }, h('span', { class: 'rp-quad ok' }, icone('check', 16)),
          h('p', null, 'Clonado em ', h('code', { text: c.caminho, title: c.caminho }), '.')));
        const ver = h('button', { type: 'button', class: 'btn solido', onclick: () => { dlg.fechar(); if (c.projeto) verProjeto(c.projeto.chave); } }, 'Ver projeto');
        dlg.pe.replaceChildren(...[h('button', { type: 'button', class: 'btn', onclick: () => dlg.cancelar() }, 'Fechar'), c.projeto ? ver : null].filter(Boolean));
        (c.projeto ? ver : dlg.pe.firstChild).focus({ preventScroll: true });
      },
      falhou(err, c) {
        mostrarForm(c);
        if (err.codigo === 'existe') { mostrarErro(eNome, cNome, err.message); cNome.focus(); cNome.select(); }
        else {
          if (err.codigo === 'permissao') abrirPermissoes(err.dados.faltando, true);
          mostrarErro(eGeral, null, err.message, err.codigo === 'permissao' ? linkPerm(dlg) : null);
        }
      },
    };
    const ok = h('button', { type: 'submit', class: 'btn solido' }, icone('clonar', 14), 'Clonar');
    function mostrarForm(c) {
      fase = 'form';
      cDest.value = c ? c.destino : st.pastaClones;
      cNome.value = c ? c.nomePasta : r.nome;
      atualizar();
      mostrarErro(eNome, cNome, '');
      mostrarErro(eGeral, null, '');
      dlg.corpo.replaceChildren(...[campoL('Pasta de destino', cDest), campoL('Nome da pasta', cNome, eNome),
        h('div', { class: 'rp-previa' }, h('span', { text: 'Caminho final' }), previa),
        r.visibilidade !== 'publico' ? h('p', { class: 'rp-modal-nota', text: 'Repositório privado: o token precisa de Contents: Read.' }) : null, eGeral].filter(Boolean));
      dlg.pe.replaceChildren(h('button', { type: 'button', class: 'btn', onclick: () => dlg.cancelar() }, 'Cancelar'), ok);
    }
    function mostrarAndando() {
      fase = 'andando';
      dlg.corpo.replaceChildren(h('div', { class: 'rp-andando' }, barra, h('div', { class: 'rp-andando-l' }, faseTxt, pctTxt)),
        h('p', { class: 'rp-modal-nota', text: 'Pode fechar: o clone continua e o projeto aparece na lista quando terminar.' }));
      const fechar = h('button', { type: 'button', class: 'btn', onclick: () => dlg.cancelar() }, 'Fechar');
      dlg.pe.replaceChildren(fechar);
      vista.progresso();
      fechar.focus({ preventScroll: true });
    }
    dlg.raiz.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (fase !== 'form') return;
      const destino = limparCaminho(cDest.value);
      const nomePasta = cNome.value.trim();
      if (!nomePasta || /[\\/:*?"<>|]/.test(nomePasta) || nomePasta === '.' || nomePasta === '..') { mostrarErro(eNome, cNome, 'Use um nome de pasta sem \\ / : * ? " < > |.'); cNome.focus(); return; }
      const caminho = juntar(destino || st.pastaClones, nomePasta);
      const clone = { completo: r.completo, caminho, chave: normCaminho(caminho), destino: destino || st.pastaClones, nomePasta, fase: '', pct: null, estado: 'andando', vista, projeto: null };
      st.clones.set(k, clone);
      mostrarAndando();
      render();
      const corpo = { repo: r.completo, nomePasta };
      if (destino) corpo.destino = destino;
      try {
        const d = await pedir('/repos/clonar', corpo);
        if (!d) throw new ErroRepo('Clone cancelado.', 0, {});
        clone.estado = 'ok';
        clone.projeto = valido(d.projeto) ? d.projeto : null;
        if (destino) st.pastaClones = destino;
        if (clone.projeto) aplicarProjeto(clone.projeto);
        carregarProjetos({ forcar: true });
        if (clone.vista) clone.vista.feito(clone);
        else toast('Clonado em ' + caminho, { tipo: 'ok', acao: clone.projeto ? { rot: 'Ver projeto', fn: () => verProjeto(clone.projeto.chave) } : null });
      } catch (err) {
        st.clones.delete(k);
        if (clone.vista) clone.vista.falhou(err, clone);
        else tratarErro(err, null);
      }
      render();
    });
    const ja = st.clones.get(k);
    if (ja && ja.estado === 'andando') { ja.vista = vista; mostrarAndando(); }
    else if (ja && ja.estado === 'ok') vista.feito(ja);
    else { mostrarForm(null); cNome.focus(); cNome.select(); }
  }

  // ───────────────────────────── toasts ─────────────────────────────
  function toast(texto, op = {}) {
    if (!ui.toasts || !st.ativo) return;
    const tipo = op.tipo || 'ok';
    const t = h('div', { class: 'rp-toast ' + tipo, role: tipo === 'erro' ? 'alert' : 'status' });
    let timer = 0;
    const fechar = () => {
      if (!t.isConnected || t.classList.contains('saindo')) return;
      clearTimeout(timer);
      t.classList.add('saindo');
      setTimeout(() => t.remove(), reduzido() ? 0 : 160);
    };
    t.append(...[h('span', { class: 'rp-toast-ico' }, icone(tipo === 'erro' ? 'alerta' : tipo === 'info' ? 'info' : 'check', 15)),
      h('span', { class: 'rp-toast-txt', text: texto, title: texto }),
      op.acao ? h('button', { type: 'button', class: 'btn p', onclick: () => { fechar(); op.acao.fn(); } }, op.acao.rot) : null,
      h('button', { type: 'button', class: 'btn-icone rp-toast-x', 'aria-label': 'Fechar aviso', onclick: fechar }, icone('x', 14))].filter(Boolean));
    ui.toasts.append(t);
    while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
    const ms = op.ms || (tipo === 'erro' ? 9000 : op.acao ? 7000 : 4000);
    timer = setTimeout(fechar, ms);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { clearTimeout(timer); timer = setTimeout(fechar, 2500); });
  }

  window.Repos = Object.freeze({ montar, pausar, retomar });
})();
