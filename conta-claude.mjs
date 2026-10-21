// Orbit — plano e conta do Claude logados nesta máquina (cabeçalho do card Uso do plano, 17/10).
// Só leitura e só campos sem segredo: o oauthAccount do ~/.claude.json (e-mail, tipo da organização e o nível
// de limite, como "default_claude_max_5x") e, no Windows e no Linux, o subscriptionType e o rateLimitTier do
// ~/.claude/.credentials.json (os tokens do mesmo arquivo nunca são lidos para fora daqui). No Mac as credenciais
// ficam no Keychain e o ~/.claude.json basta. O que não der para ler fica null: a página omite.
// O ~/.claude.json pode ter vários MB (histórico dos projetos): a leitura só se repete quando o mtime muda.

//
// Gerenciar a conta (19/10, menu de perfil): criarContaClaude roda o `claude auth status|login|logout` oficial.
// O login vale para este usuário do sistema inteiro (terminal, VS Code e Orbit). Antes de sair, as instâncias do
// Orbit podem dormir (controle.pausarConta) e voltam sozinhas quando a conta volta a ficar logada.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const NOMES = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

// "max" + "default_claude_max_20x" → "Max 20x"; "claude_pro" → "Pro"; sem nada conhecido → null.
export function nomeDoPlano({ assinatura, nivel, tipoOrg } = {}) {
  const base = (v) => String(v || '').toLowerCase().replace(/^claude_/, '');
  let tipo = base(assinatura);
  if (!NOMES[tipo]) tipo = base(tipoOrg);
  const mult = /(\d+)x\b/i.exec(String(nivel || ''));
  if (!NOMES[tipo]) {
    const m = /claude_(max|pro|team|enterprise)/i.exec(String(nivel || ''));
    tipo = m ? m[1].toLowerCase() : '';
  }
  if (!NOMES[tipo]) return null;
  return NOMES[tipo] + (tipo === 'max' && mult ? ' ' + mult[1] + 'x' : '');
}

let cache = { chave: '', valor: null };

function lerJson(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; }
}
function mtime(arq) {
  try { return fs.statSync(arq).mtimeMs; } catch { return 0; }
}

// { plano: 'Max 5x' | null, conta: 'email' | null }
export function lerContaClaude({ home = process.env.GERENCIADOR_CLAUDE_HOME || os.homedir() } = {}) {
  const arqConfig = path.join(home, '.claude.json');
  const arqCred = path.join(home, '.claude', '.credentials.json');
  const chave = [home, mtime(arqConfig), mtime(arqCred)].join('|');
  if (cache.chave === chave && cache.valor) return cache.valor;
  const conta = lerJson(arqConfig)?.oauthAccount;
  const cred = lerJson(arqCred)?.claudeAiOauth;
  const o = conta && typeof conta === 'object' ? conta : {};
  const c = cred && typeof cred === 'object' ? cred : {};
  const email = typeof o.emailAddress === 'string' && o.emailAddress.includes('@') ? o.emailAddress.trim() : null;
  const valor = {
    plano: nomeDoPlano({ assinatura: c.subscriptionType, nivel: c.rateLimitTier || o.organizationRateLimitTier || o.userRateLimitTier, tipoOrg: o.organizationType }),
    conta: email,
  };
  cache = { chave, valor };
  return valor;
}

// ───────────────────────────── gerenciar a conta (19/10) ─────────────────────────────

const MS_STATUS = 15e3; // o status lido vale 15 s (o menu reabre sem rodar o claude de novo)
const MS_SAIR = 30e3;
const MS_LOGIN = 10 * 60e3; // sem terminar no navegador em 10 min, o Orbit desiste
const MS_VIGIA = 5e3; // mtime do ~/.claude.json e do .credentials.json (login pelo terminal ou VS Code)
const MAX_SAIDA = 16 * 1024;
const ATIVOS = new Set(['trabalhando', 'aguardando']);

// Saída do `claude auth status --json` → o que a página pode ver (sem orgId nem caminhos).
export function statusDe(j, plano) {
  if (!j || typeof j !== 'object') return null;
  const email = typeof j.email === 'string' && j.email.includes('@') ? j.email.trim() : null;
  return {
    logado: j.loggedIn === true,
    metodo: typeof j.authMethod === 'string' ? j.authMethod : null,
    email,
    org: typeof j.orgName === 'string' && j.orgName.trim() ? j.orgName.trim() : null,
    plano: j.loggedIn === true ? plano || nomeDoPlano({ assinatura: j.subscriptionType }) : null,
  };
}

// Endereço da página de login na saída do `claude auth login` (para "Abrir de novo"); só https.
export function urlDoLogin(txt) {
  const m = /https:\/\/[^\s"'<>]+/.exec(String(txt || ''));
  return m ? m[0].replace(/[).,;]+$/, '') : null;
}

function rodar(comando, args, { env, timeout }) {
  return new Promise((resolve) => {
    let saida = '';
    let p;
    try {
      const { cmd, pre } = comando();
      p = spawn(cmd, [...pre, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ codigo: null, saida: '', erro: e.message });
    }
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
    const juntar = (b) => { if (saida.length < MAX_SAIDA) saida += b; };
    p.stdout.on('data', juntar);
    p.stderr.on('data', juntar);
    p.on('error', (e) => { clearTimeout(t); resolve({ codigo: null, saida, erro: e.message }); });
    p.on('close', (codigo) => { clearTimeout(t); resolve({ codigo, saida }); });
  });
}

// deps: comando() → {cmd, pre} (binario.mjs), env() (envLimpo), controle (vivasConta, pausadasConta, pausarConta,
// retomarConta, estado), sessoes() (as do hook), difundir, log, home.
export function criarContaClaude(deps) {
  const { comando, env = () => process.env, controle, sessoes = () => [], difundir = () => {}, log = () => {} } = deps;
  const home = () => deps.home || process.env.GERENCIADOR_CLAUDE_HOME || os.homedir();
  let st = null; // último status lido
  let lidoEm = 0;
  let lendo = null;
  let saindo = null;
  let login = null; // { proc, desde, url, saida, cancelado, expirou }
  let falhaLogin = '';
  let retomadas = 0;

  function lerStatus(forcar) {
    if (!forcar && st && Date.now() - lidoEm < MS_STATUS) return Promise.resolve(st);
    if (lendo) return lendo;
    lendo = (async () => {
      const r = await rodar(comando, ['auth', 'status', '--json'], { env: env(), timeout: 15e3 });
      let j = null;
      try { j = JSON.parse(r.saida.slice(r.saida.indexOf('{'))); } catch {}
      // O plano com o multiplicador ("Max 5x") só vem dos arquivos; vale se for a mesma conta.
      const arq = lerContaClaude({ home: home() });
      const novo = statusDe(j, j && arq.conta && arq.conta === j.email ? arq.plano : null);
      if (!novo) log('conta', `claude auth status não respondeu (${r.erro || 'código ' + r.codigo})`);
      const antes = st;
      st = novo || st;
      lidoEm = Date.now();
      if (novo && antes && !antes.logado && novo.logado) aoEntrar();
      return st;
    })().finally(() => (lendo = null));
    return lendo;
  }

  // Voltou a ficar logado (pelo Orbit, pelo terminal ou pelo VS Code): as pausadas pela conta acordam.
  function aoEntrar() {
    falhaLogin = '';
    try {
      const ids = controle?.retomarConta?.() || [];
      retomadas = ids.length;
      if (ids.length) log('conta', `novo login: retomando ${ids.length} instância(s) pausada(s)`);
    } catch (e) {
      log('conta', 'retomar as pausadas:', e.message);
    }
  }

  const nomeSessao = (s) => s.apelido || s.titulo || s.nome || s.projeto || String(s.id || '').slice(0, 8);
  // O que acontece com as sessões: as do Orbit (vivas; o Orbit pode pausar) e as de fora em andamento.
  function emAndamento() {
    const vivas = controle?.vivasConta?.() || [];
    const idsOrbit = new Set(vivas.map((v) => v.id));
    const nomes = new Map();
    const fora = [];
    for (const s of sessoes()) {
      if (!s || !s.id || s.pai) continue;
      nomes.set(s.id, nomeSessao(s));
      let orbit = idsOrbit.has(s.id);
      if (!orbit) try { orbit = controle?.estado?.(s)?.modo === 'orbit'; } catch {}
      if (!orbit && ATIVOS.has(s.status)) fora.push(nomeSessao(s));
    }
    return {
      orbit: vivas.map((v) => ({ nome: nomes.get(v.id) || v.id.slice(0, 8), ocupada: v.ocupada })),
      fora,
    };
  }

  async function publico(forcar) {
    const s = await lerStatus(forcar);
    return {
      ...(s || { logado: null, metodo: null, email: null, org: null, plano: null }),
      entrando: login ? { desde: login.desde, url: login.url } : null,
      saindo: !!saindo,
      falha: falhaLogin || null,
      retomadas,
      pausadas: controle?.pausadasConta?.().length || 0,
      emAndamento: emAndamento(),
    };
  }
  async function avisar() {
    try { difundir('contaClaudeAuth', await publico(false)); } catch {}
  }

  function entrar(email) {
    if (login) return;
    falhaLogin = '';
    retomadas = 0;
    const args = ['auth', 'login'];
    if (typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email.trim())) args.push('--email', email.trim());
    let proc;
    try {
      const { cmd, pre } = comando();
      // stdin aberto: o claude pode esperar um código colado; fechar o stdin encerraria o login.
      proc = spawn(cmd, [...pre, ...args], { env: env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      falhaLogin = `Não deu para abrir o login do Claude (${e.message}).`;
      return;
    }
    const l = { proc, desde: Date.now(), url: null, saida: '', cancelado: false, expirou: false };
    login = l;
    log('conta', 'login do Claude aberto (claude auth login)');
    const juntar = (b) => {
      if (l.saida.length < MAX_SAIDA) l.saida += b;
      const u = !l.url && urlDoLogin(l.saida);
      if (u) { l.url = u; avisar(); }
    };
    proc.stdout.on('data', juntar);
    proc.stderr.on('data', juntar);
    proc.stdin.on('error', () => {});
    const prazo = setTimeout(() => { l.expirou = true; try { proc.kill(); } catch {} }, MS_LOGIN);
    // Enquanto o navegador não termina, confere o status (o processo pode demorar a sair depois do login).
    const vigia = setInterval(() => lerStatus(true).then((s) => { if (s?.logado) try { proc.kill(); } catch {} }).catch(() => {}), 3000);
    let acabou = false;
    const fim = async (codigo, erro) => {
      if (acabou) return;
      acabou = true;
      clearTimeout(prazo);
      clearInterval(vigia);
      const s = await lerStatus(true).catch(() => null);
      if (login === l) login = null;
      if (!s?.logado) {
        falhaLogin = l.cancelado ? '' : l.expirou ? 'O login não terminou em 10 minutos. Tente de novo.'
          : erro ? `O login do Claude falhou (${erro}).` : 'O login não foi concluído. Tente de novo.';
        log('conta', `login do Claude não concluído (${l.cancelado ? 'cancelado' : l.expirou ? 'prazo' : erro || 'código ' + codigo})`);
      } else log('conta', 'login do Claude concluído');
      difundir('contaClaude', lerContaClaude({ home: home() }));
      avisar();
    };
    proc.on('error', (e) => fim(null, e.message));
    proc.on('close', (codigo) => fim(codigo));
  }

  function cancelarEntrar() {
    if (!login) return false;
    login.cancelado = true;
    try { login.proc.kill(); } catch {}
    return true;
  }

  // Sair: com `pausar`, as instâncias vivas do Orbit dormem antes; com `entrar`, o login abre logo depois (trocar).
  async function sair({ pausar, entrar: depois, email } = {}) {
    let pausa = { pausadas: [], falharam: [] };
    if (pausar && controle?.pausarConta) pausa = await controle.pausarConta();
    const r = await rodar(comando, ['auth', 'logout'], { env: env(), timeout: MS_SAIR });
    const s = await lerStatus(true);
    if (s?.logado) {
      const det = String(r.erro || r.saida || '').trim().split('\n').pop().slice(0, 200);
      throw Object.assign(new Error('O Claude não saiu da conta' + (det ? ': ' + det : '.')), { status: 502 });
    }
    log('conta', `saiu da conta do Claude${pausa.pausadas.length ? ` (${pausa.pausadas.length} instância(s) pausada(s))` : ''}`);
    retomadas = 0;
    difundir('contaClaude', lerContaClaude({ home: home() }));
    if (depois) entrar(email);
    return pausa;
  }

  // Login ou logout fora do Orbit (terminal, VS Code): o mtime muda, o status é relido e a página avisada.
  let marca = '';
  let ultimaConta = JSON.stringify(lerContaClaude({ home: home() }));
  function vigiar() {
    const h = home();
    const m = [mtime(path.join(h, '.claude.json')), mtime(path.join(h, '.claude', '.credentials.json'))].join('|');
    if (m === marca) return;
    const primeira = !marca;
    marca = m;
    if (primeira) return;
    const c = JSON.stringify(lerContaClaude({ home: h }));
    if (c !== ultimaConta) { ultimaConta = c; difundir('contaClaude', JSON.parse(c)); }
    if (!login && !saindo) lerStatus(true).then(() => avisar()).catch(() => {});
  }
  vigiar();
  const timer = setInterval(vigiar, MS_VIGIA);
  timer.unref?.();
  // Subiu já logado com instâncias pausadas pela conta (o servidor reiniciou no meio): elas voltam.
  const inicio = setTimeout(() => {
    if (!controle?.pausadasConta?.().length) return;
    lerStatus(true).then((s) => { if (s?.logado) aoEntrar(); }).catch(() => {});
  }, 3000);
  inicio.unref?.();

  function responder(res, status, corpo) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(corpo));
  }

  // GET /conta/claude[?agora] · POST /conta/claude/sair {pausar, entrar, email} · /entrar {email} · /entrar/cancelar
  async function rota(req, res, caminho, lerCorpo) {
    if (caminho !== '/conta/claude' && !caminho.startsWith('/conta/claude/')) return false;
    try {
      if (req.method === 'GET') {
        if (caminho !== '/conta/claude') return false;
        responder(res, 200, await publico(new URL(req.url, 'http://x').searchParams.has('agora')));
        return true;
      }
      const b = (await lerCorpo(req).catch(() => null)) || {};
      if (caminho === '/conta/claude/sair') {
        if (saindo) { responder(res, 409, { erro: 'O Orbit já está saindo da conta.' }); return true; }
        if (login) { responder(res, 409, { erro: 'Há um login em andamento. Cancele antes de sair.' }); return true; }
        saindo = sair({ pausar: b.pausar === true, entrar: b.entrar === true, email: b.email });
        avisar();
        try {
          const pausa = await saindo;
          saindo = null;
          responder(res, 200, { ...(await publico(false)), pausa: { pausadas: pausa.pausadas.length, falharam: pausa.falharam.length } });
        } catch (e) {
          saindo = null;
          responder(res, e.status || 500, { erro: e.message });
        }
        avisar();
        return true;
      }
      if (caminho === '/conta/claude/entrar') {
        if (saindo) { responder(res, 409, { erro: 'Espere o Orbit terminar de sair da conta.' }); return true; }
        const s = await lerStatus(true);
        if (s?.logado) { responder(res, 409, { erro: 'Já há uma conta logada. Para trocar, use "Trocar de conta".' }); return true; }
        entrar(b.email);
        responder(res, 202, await publico(false));
        avisar();
        return true;
      }
      if (caminho === '/conta/claude/entrar/cancelar') {
        cancelarEntrar();
        responder(res, 200, await publico(false));
        return true;
      }
      responder(res, 404, { erro: 'não encontrado' });
    } catch (e) {
      log('conta', 'rota:', e.message);
      responder(res, 500, { erro: e.message });
    }
    return true;
  }

  return { rota, status: publico, fechar: () => { clearInterval(timer); clearTimeout(inicio); cancelarEntrar(); } };
}
