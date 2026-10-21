// Orbit — acesso remoto pelo celular (iPhone via `tailscale serve`, uso pessoal).
// Tudo o que chega na porta remota (config.remoto.porta, só 127.0.0.1) passa por atender() antes do roteamento
// comum do servidor.mjs: Host/Origin/Content-Type/Tailscale-User-Login, cabeçalhos de segurança, rotas públicas,
// cookie do aparelho e a LISTA DE ROTAS PERMITIDAS (o resto é 403 bloqueado_no_celular, inclusive rotas de
// módulos futuros). Na 47821 ficam só as rotas de gestão (rotaLocal).
//
// Aparelhos em <DADOS>/remoto.json: { aparelhos: [{ id, nome, hash (sha256 hex do token), criadoEm, ultimoAcesso,
// push }] }. O token (32 bytes base64url) só existe no cookie __Host-orbit do aparelho; aqui só o hash, comparado
// em tempo constante. Chave VAPID: privada no cofre (perfil.criarCofreTexto), pública em remoto-vapid.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { criarPush } from './push.mjs';
import { criarTailscale } from './tailscale.mjs';

const COOKIE = '__Host-orbit';
const VALIDADE_MS = 90 * 864e5; // 90 dias sem uso → expira
const TOQUE_MS = 60e3; // ultimoAcesso gravado no máximo 1x/min
// Prazos (os testes encurtam por ORBIT_REMOTO_*_MS, que só valem com DADOS fora da pasta do Orbit: ver criarRemoto).
const PADRAO = {
  PEDIDO_MS: 2 * 60e3, // pedido de pareamento
  BLOQUEIO_MS: 10 * 60e3, // 5 erros no mesmo pedido
  BLOQUEIO_GLOBAL_MS: 60 * 60e3, // 10 erros na janela (dobra a cada reincidência)
  JANELA_MS: 60 * 60e3, // janela deslizante dos erros
  RENOVAR_MS: 864e5, // o cookie é reemitido no máximo 1x/dia
};
const MAX_ERROS = 5; // por pedido
const MAX_ERROS_JANELA = 10; // por chave (login do Tailscale), na janela
const MAX_APARELHOS = 20;
const MAX_CORPO = 256 * 1024;
const MAX_CORPO_GRANDE = 25 * 1024 * 1024; // mensagem / nova instância com imagens (o controle confere o limite real)
const MS_DETECCAO = 15e3;

export const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const CABECALHOS = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const MODOS_OK = ['default', 'acceptEdits', 'plan', 'auto']; // nunca bypassPermissions
// Serviços de Web Push aceitos na assinatura (o servidor só faz POST para eles: nada de URL arbitrária). Hosts
// exatos (só o WNS tem subdomínios por região), porta padrão e sem usuário/senha na URL.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com']);
const pushHostOk = (h) => PUSH_HOSTS.has(h) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(h);

// Rotas com cookie (fora /remoto/*). Sessão: só as ações permitidas.
const GET_FIXAS = new Set(['/estado', '/uso', '/modelos', '/fluxo', '/instancias']);
const SESSAO_GET = new Set(['', 'conversa', 'conversa/fluxo', 'acoes', 'comandos', 'imagem']);
const SESSAO_POST = new Set(['mensagem', 'permissao', 'parar', 'modelo', 'esforco', 'modo']);
// Arquivos da pasta mobile/ (o Orbit no celular), servidos pelas rotas fixas abaixo: nada mais dela sai.
const MOBILE = {
  '/m': ['index.html', 'text/html; charset=utf-8'],
  '/m/mobile.css': ['mobile.css', 'text/css; charset=utf-8'],
  '/m/mobile.js': ['mobile.js', 'text/javascript; charset=utf-8'],
  '/m/widgets.js': ['widgets.js', 'text/javascript; charset=utf-8'],
  '/m/widgets.css': ['widgets.css', 'text/css; charset=utf-8'],
  '/manifest-m.webmanifest': ['manifest-m.webmanifest', 'application/manifest+json; charset=utf-8'],
};
const RE_SESSAO = /^\/sessao\/([^/]+)(?:\/(conversa\/fluxo|[a-z]+))?$/;
// De assets/: só a base visual comum (comum/base.css e base.js, a mesma do PC), os sprites dos agentes, as fontes e os ícones do PWA.
const RE_ASSET = /^\/assets\/(?:comum\/base\.(?:css|js)|comum\/widgets\.js|sprites\/sprite-[\w-]+\.(?:gif|png)|pwa\/(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*|[\w@-][\w.@-]*\.woff2)$/;

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest();
// Comparação em tempo constante de dois textos quaisquer (pelo hash, que tem tamanho fixo).
const igual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const limparNome = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '') || 'Celular';

function responder(res, codigo, corpo, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(corpo));
}

export function criarRemoto(deps) {
  const {
    dados, // pasta de dados (remoto.json, remoto-vapid.json)
    pasta, // pasta do Orbit (mobile/, pwa/)
    config, // () => config.remoto (já saneada pelo servidor)
    mudarConfig, // (patch) => Promise: mescla em config.remoto, grava, abre/fecha a porta
    difundirLocal, // (tipo, dados): SSE só para a página do PC
    nativa, // (id) => a sessão é uma instância criada pelo Orbit?
    projetos, // () => [{pasta, nome}] cadastrados
    lerCorpo, // (req, limite) => Promise<string>
    lerJSONCorpo, // (req) => Promise<obj> (rotas da 47821)
    cofre, // cofre de texto para a chave privada VAPID
    executarTailscale, // opcional: executor injetado (testes); sem ele, a CLI de verdade
    permitirHttp = false, // SÓ testes: aceita endpoint de push http://127.0.0.1 (servidor falso); produção nunca liga
    log = () => {},
    agora = () => Date.now(),
  } = deps;
  const ARQ = path.join(dados, 'remoto.json');
  // P2-7: os ajustes de teste (ORBIT_REMOTO_<nome>) só valem com a pasta de dados fora da pasta do Orbit.
  const deTeste = path.resolve(dados) !== path.resolve(pasta);
  const prazo = (nome) => (deTeste && Number(process.env[`ORBIT_REMOTO_${nome}`])) || PADRAO[nome];
  const PEDIDO_MS = prazo('PEDIDO_MS');
  const BLOQUEIO_MS = prazo('BLOQUEIO_MS');
  const BLOQUEIO_GLOBAL_MS = prazo('BLOQUEIO_GLOBAL_MS');
  const JANELA_MS = prazo('JANELA_MS');
  const RENOVAR_MS = prazo('RENOVAR_MS');
  const push = cofre ? criarPush({ cofre, arquivoChaves: path.join(dados, 'remoto-vapid.json'), log: (...a) => log(...a), permitirHttp }) : null;
  const ts = criarTailscale(executarTailscale ? { executar: executarTailscale } : {});

  // ───────── aparelhos ─────────
  let aparelhos = [];
  try {
    const j = JSON.parse(fs.readFileSync(ARQ, 'utf8').replace(/^﻿/, ''));
    aparelhos = (Array.isArray(j?.aparelhos) ? j.aparelhos : [])
      .filter((a) => a && typeof a.id === 'string' && /^[0-9a-f]{64}$/.test(a.hash))
      .map((a) => ({ id: a.id, nome: limparNome(a.nome), hash: a.hash, criadoEm: Number(a.criadoEm) || 0, ultimoAcesso: Number(a.ultimoAcesso) || 0, cookieEm: Number(a.cookieEm) || 0, push: assinaturaValida(a.push) }));
  } catch (e) {
    if (e.code !== 'ENOENT') log('remoto: remoto.json ilegível, começando sem aparelhos', e?.message || e);
  }
  function gravar() {
    try {
      fs.mkdirSync(dados, { recursive: true });
      const tmp = `${ARQ}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ aparelhos }, null, 1));
      fs.renameSync(tmp, ARQ);
    } catch (e) {
      log('remoto: não gravei o remoto.json', e?.message || e);
    }
  }
  const publicoAparelho = (a) => ({ id: a.id, nome: a.nome, criadoEm: a.criadoEm, ultimoAcesso: a.ultimoAcesso, push: !!a.push });
  function podarExpirados() {
    const t = agora();
    const antes = aparelhos.length;
    aparelhos = aparelhos.filter((a) => {
      if (t - (a.ultimoAcesso || a.criadoEm) <= VALIDADE_MS) return true;
      derrubar(a.id);
      log('remoto', `aparelho expirado (90 dias sem uso): ${a.nome} [${a.id}]`);
      return false;
    });
    if (aparelhos.length !== antes) gravar();
  }

  // ───────── conexões por aparelho (revogar fecha na hora, inclusive os SSE) ─────────
  const conexoes = new Map(); // id → Set<ServerResponse>
  function acompanhar(id, res) {
    let s = conexoes.get(id);
    if (!s) conexoes.set(id, (s = new Set()));
    s.add(res);
    res.on('close', () => {
      s.delete(res);
      if (!s.size && conexoes.get(id) === s) conexoes.delete(id);
    });
  }
  function derrubar(id, exceto = null) {
    for (const r of conexoes.get(id) || []) {
      if (r === exceto) continue;
      try { r.end(); } catch {}
      try { r.socket?.destroy(); } catch {}
    }
  }
  function revogar(id, exceto = null) {
    const i = aparelhos.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const [a] = aparelhos.splice(i, 1);
    gravar();
    derrubar(id, exceto);
    log('remoto', `aparelho revogado: ${a.nome} [${a.id}]`);
    avisar();
    return true;
  }

  // ───────── cookie ─────────
  const cookie = (token) => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${VALIDADE_MS / 1000}`;
  const cookieApagar = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  function tokenDoCookie(req) {
    for (const parte of String(req.headers.cookie || '').split(';')) {
      const i = parte.indexOf('=');
      if (i > 0 && parte.slice(0, i).trim() === COOKIE) return parte.slice(i + 1).trim();
    }
    return '';
  }
  // → { a: aparelho, renovar: set-cookie a reemitir (mesmo token, Max-Age cheio) ou '' } | null. O cookie é
  // reemitido no máximo 1x/dia (cookieEm): os 90 dias contam do último uso, não da emissão.
  function autenticarCookie(req) {
    const token = tokenDoCookie(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const h = sha256(token);
    let achado = null;
    for (const a of aparelhos) if (crypto.timingSafeEqual(Buffer.from(a.hash, 'hex'), h)) achado = a; // percorre todos
    if (!achado) return null;
    const t = agora();
    if (t - (achado.ultimoAcesso || achado.criadoEm) > VALIDADE_MS) {
      podarExpirados();
      avisar();
      return null;
    }
    let mudou = false;
    if (t - achado.ultimoAcesso >= TOQUE_MS) {
      achado.ultimoAcesso = t;
      mudou = true;
    }
    let renovar = '';
    if (t - (achado.cookieEm || achado.criadoEm) >= RENOVAR_MS) {
      achado.cookieEm = t;
      renovar = cookie(token);
      mudou = true;
    }
    if (mudou) gravar();
    return { a: achado, renovar };
  }
  const autenticar = (req) => autenticarCookie(req)?.a || null;

  // ───────── pareamento ─────────
  // Revisão P2-1/P2-2: tudo por chave = login do Tailscale (minúsculo; '' sem cabeçalho, só quando não há dono).
  // Por chave: erros na janela deslizante (JANELA_MS); 10 → bloqueio de BLOQUEIO_GLOBAL_MS × 2^nível (o nível sobe
  // a cada bloqueio e zera no pareamento bem-sucedido). 5 erros no mesmo pedido → bloqueio de BLOQUEIO_MS.
  let pedido = null; // { id, nome, codigo, expiraEm, erros, chave }
  let tmPedido = null;
  const porChave = new Map(); // chave → { erros: [t], bloqueadoAte, nivel }
  function daChave(k) {
    let e = porChave.get(k);
    if (!e) porChave.set(k, (e = { erros: [], bloqueadoAte: 0, nivel: 0 }));
    return e;
  }
  const bloqueioDe = (k) => porChave.get(k)?.bloqueadoAte || 0;
  // Para a página do PC: o maior bloqueio em vigor.
  const bloqueadoAteMaior = () => Math.max(0, ...[...porChave.values()].map((e) => e.bloqueadoAte));
  function pedidoValido() {
    if (pedido && pedido.expiraEm <= agora()) pedido = null;
    return pedido;
  }
  function agendarExpiracao() {
    clearTimeout(tmPedido);
    if (!pedido) return;
    tmPedido = setTimeout(() => {
      if (pedido && pedido.expiraEm <= agora()) {
        pedido = null;
        avisar();
      }
    }, Math.max(0, pedido.expiraEm - agora()) + 50);
    tmPedido.unref?.();
  }
  function parearPedir(res, corpo, chave) {
    const t = agora();
    if (bloqueioDe(chave) > t) return responder(res, 429, { erro: 'bloqueado', ate: bloqueioDe(chave) });
    if (pedidoValido()) return responder(res, 409, { erro: 'pedido_pendente' });
    if (aparelhos.length >= MAX_APARELHOS) return responder(res, 409, { erro: 'limite_aparelhos' });
    pedido = {
      id: crypto.randomBytes(16).toString('base64url'),
      nome: limparNome(corpo.nome),
      codigo: String(crypto.randomInt(0, 1e6)).padStart(6, '0'),
      expiraEm: t + PEDIDO_MS,
      erros: 0,
      chave,
    };
    agendarExpiracao();
    log('remoto', `pedido de pareamento: ${pedido.nome}`);
    avisar();
    return responder(res, 200, { pedido: pedido.id, expiraEm: pedido.expiraEm });
  }
  function parearConfirmar(res, corpo, chave) {
    const t = agora();
    if (bloqueioDe(chave) > t) return responder(res, 429, { erro: 'bloqueado', ate: bloqueioDe(chave) });
    const p = pedidoValido();
    // Só quem pediu (a mesma chave) confirma o pedido.
    if (!p || p.chave !== chave || typeof corpo.pedido !== 'string' || !igual(corpo.pedido, p.id)) return responder(res, 410, { erro: 'expirado' });
    const cod = typeof corpo.codigo === 'string' ? corpo.codigo.trim() : '';
    if (!/^\d{6}$/.test(cod) || !igual(cod, p.codigo)) {
      p.erros++;
      const e = daChave(chave);
      e.erros = e.erros.filter((x) => t - x < JANELA_MS);
      e.erros.push(t);
      let bloqueio = 0;
      if (e.erros.length >= MAX_ERROS_JANELA) {
        bloqueio = BLOQUEIO_GLOBAL_MS * 2 ** e.nivel;
        e.nivel++;
        e.erros = [];
        log('remoto', `pareamento bloqueado: ${MAX_ERROS_JANELA} códigos errados na janela (${Math.round(bloqueio / 60e3)} min)`);
      } else if (p.erros >= MAX_ERROS) {
        bloqueio = BLOQUEIO_MS;
        log('remoto', `pareamento bloqueado: ${MAX_ERROS} códigos errados`);
      }
      if (bloqueio) {
        pedido = null;
        clearTimeout(tmPedido);
        e.bloqueadoAte = t + bloqueio;
        avisar();
        return responder(res, 429, { erro: 'bloqueado', ate: e.bloqueadoAte });
      }
      return responder(res, 400, { erro: 'codigo_errado', restantes: MAX_ERROS - p.erros });
    }
    pedido = null;
    clearTimeout(tmPedido);
    const e = porChave.get(chave);
    if (e) e.nivel = 0;
    const token = crypto.randomBytes(32).toString('base64url');
    const a = { id: crypto.randomBytes(9).toString('base64url'), nome: p.nome, hash: sha256(token).toString('hex'), criadoEm: t, ultimoAcesso: t, cookieEm: t, push: null };
    aparelhos.push(a);
    gravar();
    log('remoto', `aparelho pareado: ${a.nome} [${a.id}]`);
    avisar();
    return responder(res, 200, { ok: true, aparelho: { id: a.id, nome: a.nome } }, { 'set-cookie': cookie(token) });
  }

  // ───────── push ─────────
  function assinaturaValida(s) {
    if (!s || typeof s !== 'object') return null;
    let u;
    try { u = new URL(String(s.endpoint || '')); } catch { return null; }
    const aceito = (u.protocol === 'https:' && pushHostOk(u.hostname) && u.port === '' && !u.username && !u.password) || (permitirHttp && u.protocol === 'http:' && u.hostname === '127.0.0.1');
    if (!aceito || String(s.endpoint).length > 2048) return null;
    const p256dh = String(s.keys?.p256dh || '');
    const auth = String(s.keys?.auth || '');
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) return null;
    return { endpoint: u.href, keys: { p256dh, auth } };
  }
  async function enviarPara(a, payload, opcoes = {}) {
    if (!push || !a.push) return { status: 0 };
    const r = await push.enviar(a.push, payload, opcoes);
    if (r.status === 404 || r.status === 410) {
      a.push = null; // assinatura morta: apaga
      gravar();
      log('remoto', `assinatura de push removida (${r.status}): ${a.nome} [${a.id}]`);
      avisar();
    }
    return r;
  }
  // Gatilho (servidor.mjs): instância nativa precisa do usuário ou terminou a volta. Nunca texto do agente.
  function notificar({ id, projeto }, tipo) {
    const c = config();
    if (!push || !c.ativo || !c.notificar?.[tipo]) return;
    const titulo = `Orbit · ${projeto || 'Orbit'} · ${tipo === 'precisa' ? 'precisa de você' : 'terminou'}`;
    const payload = { titulo, corpo: '', url: `/m#s=${encodeURIComponent(id)}`, tag: `s-${id}` };
    for (const a of aparelhos) if (a.push) enviarPara(a, payload, { ttl: tipo === 'precisa' ? 3600 : 900, urgencia: 'high' }).catch(() => {});
  }

  // ───────── Tailscale ─────────
  const vazio = { instalado: false, logado: false, host: '', dono: '', serve: false };
  let det = null;
  let detEm = 0;
  let detectando = null;
  function detectar(forcar = false) {
    if (!forcar && det && agora() - detEm < MS_DETECCAO) return Promise.resolve(det);
    detectando ||= ts.detectar(config().porta)
      .then(async (d) => {
        det = d;
        detEm = agora();
        // Preenche host e dono só quando vazios (o manual vale).
        const c = config();
        const patch = {};
        if (!c.host && d.host) patch.host = d.host;
        if (!c.dono && d.dono) patch.dono = d.dono;
        if (Object.keys(patch).length) await mudarConfig(patch);
        return d;
      })
      .catch((e) => {
        log('remoto: tailscale', e?.message || e);
        return det || vazio;
      })
      .finally(() => (detectando = null));
    return detectando;
  }

  // ───────── estado (só na 47821) ─────────
  // `seq` cresce a cada estado gerado (também entre reinícios): a página descarta o que chegar mais velho que o que já
  // mostra (uma resposta de POST atrasada não apaga um pedido de pareamento que o SSE acabou de trazer).
  let seqEstado = Date.now() * 1000;
  function estado() {
    const c = config();
    const p = pedidoValido();
    return {
      seq: ++seqEstado,
      ativo: !!c.ativo,
      porta: c.porta,
      host: c.host,
      endereco: c.host ? `https://${c.host}/m` : '',
      tailscale: { ...(det || vazio) },
      aparelhos: aparelhos.map(publicoAparelho),
      pedido: p ? { id: p.id, nome: p.nome, codigo: p.codigo, expiraEm: p.expiraEm } : null,
      bloqueadoAte: bloqueadoAteMaior() > agora() ? bloqueadoAteMaior() : 0,
      opcoes: { criarInstancias: !!c.criarInstancias, notificar: { ...c.notificar } },
    };
  }
  const avisar = () => {
    try { difundirLocal('remoto', estado()); } catch {}
  };

  // Rotas de gestão na 47821 (o servidor já conferiu Host, Origin e x-gerenciador). true = respondeu.
  async function rotaLocal(req, res, rota) {
    if (!rota.startsWith('/remoto/')) return false;
    if (req.method === 'GET') {
      if (rota !== '/remoto/estado') return false;
      podarExpirados();
      await detectar();
      responder(res, 200, estado());
      return true;
    }
    if (req.method !== 'POST') return false;
    const b = await lerJSONCorpo(req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      responder(res, 400, { erro: 'corpo inválido' });
      return true;
    }
    if (rota === '/remoto/config') {
      const patch = {};
      for (const k of ['ativo', 'criarInstancias', 'notificar', 'host', 'dono']) if (k in b) patch[k] = b[k];
      const ligando = b.ativo === true && !config().ativo;
      await mudarConfig(patch);
      if (!config().ativo) desligado();
      if (ligando) await detectar(true);
      log('remoto', `config: ${Object.keys(patch).join(', ') || '(nada)'}${'ativo' in patch ? ` ativo=${config().ativo}` : ''}`);
      avisar();
      responder(res, 200, estado());
      return true;
    }
    if (rota === '/remoto/revogar') {
      if (b.todos === true) {
        for (const a of [...aparelhos]) revogar(a.id);
        responder(res, 200, { ok: true, ...estado() });
      } else if (typeof b.id === 'string' && revogar(b.id)) responder(res, 200, { ok: true, ...estado() });
      else responder(res, 404, { erro: 'aparelho não encontrado' });
      return true;
    }
    if (rota === '/remoto/parear/recusar') {
      const p = pedidoValido();
      if (p && (b.pedido === undefined || (typeof b.pedido === 'string' && igual(b.pedido, p.id)))) {
        pedido = null;
        clearTimeout(tmPedido);
        log('remoto', `pedido de pareamento recusado: ${p.nome}`);
        avisar();
      }
      responder(res, 200, { ok: true, ...estado() });
      return true;
    }
    if (rota === '/remoto/tailscale/serve') {
      if (typeof b.ligar !== 'boolean') {
        responder(res, 400, { erro: 'ligar deve ser booleano' });
        return true;
      }
      const r = b.ligar ? await ts.ligarServe(config().porta) : await ts.desligarServe();
      log('remoto', `tailscale serve ${b.ligar ? 'ligar' : 'desligar'}: ${r.ok ? 'ok' : r.erro}`);
      await detectar(true);
      avisar();
      responder(res, r.ok ? 200 : 502, { ...r, tailscale: { ...(det || vazio) } });
      return true;
    }
    return false;
  }

  // A porta remota fechou (desligado): o pedido pendente cai.
  function desligado() {
    if (pedido) {
      pedido = null;
      clearTimeout(tmPedido);
      avisar();
    }
  }

  // ───────── porta remota ─────────
  async function servirArquivo(res, arquivo, tipo, trocar, comInline = false) {
    let txt;
    try { txt = await fsp.readFile(arquivo, 'utf8'); } catch { return responder(res, 404, { erro: 'não encontrado' }); }
    if (trocar) txt = trocar(txt);
    const extra = comInline ? { 'content-security-policy': cspComHashes(txt) } : {};
    res.writeHead(200, { 'content-type': tipo, 'cache-control': 'no-cache', ...extra });
    res.end(txt);
  }
  // Só a tela offline (estática, sem dado): libera os <style>/<script> inline DELA pelo hash exato de cada bloco
  // (nada de 'unsafe-inline'; atributos inline continuam barrados). O resto da CSP é o mesmo.
  function cspComHashes(html) {
    const hashes = (tag) => [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))]
      .map((m) => ` 'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`).join('');
    return CSP.replace("style-src 'self'", `style-src 'self'${hashes('style')}`).replace("script-src 'self'", `script-src 'self'${hashes('script')}`);
  }

  function pastaCadastrada(bruta) {
    if (typeof bruta !== 'string' || !bruta.trim()) return false;
    const norm = (p) => {
      const r = path.resolve(p).replace(/[\\/]+$/, '');
      return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
    };
    const alvo = norm(bruta.trim());
    return projetos().some((p) => typeof p.pasta === 'string' && norm(p.pasta) === alvo);
  }

  // Tudo da porta remota passa aqui. Devolve null quando já respondeu; { aparelho } quando o pedido segue para o
  // roteamento comum (aparelho null = rota pública de arquivo: /sw.js e /assets/ da lista).
  async function atender(req, res, rota) {
    for (const [k, v] of Object.entries(CABECALHOS)) res.setHeader(k, v);
    const c = config();
    const host = String(req.headers.host || '').toLowerCase().replace(/:443$/, '');
    if (!c.host || host !== c.host) return responder(res, 403, { erro: 'host não permitido' }), null;
    // Revisão P2-3: com dono definido, o Tailscale-User-Login é obrigatório e igual (nó com tag não manda o
    // cabeçalho: fica de fora). A chave do pareamento é esse login.
    const login = req.headers['tailscale-user-login'];
    const chave = login === undefined ? '' : String(login).trim().toLowerCase();
    if (c.dono && chave !== c.dono.trim().toLowerCase()) return responder(res, 403, { erro: 'usuario_nao_permitido' }), null;
    const m = req.method;
    if (m !== 'GET' && m !== 'POST') return responder(res, 405, { erro: 'método não permitido' }), null;
    // Revisão P2-6: ts.net é sufixo público, então outro nó da tailnet é "same-site" e o cookie Strict vai junto.
    // GET vindo de outro site só como navegação de topo para as páginas (/, /m, /offline.html).
    if (m === 'GET') {
      const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (sfs === 'cross-site' || sfs === 'same-site') {
        const topo = req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
        if (!topo || !['/', '/m', '/offline.html'].includes(rota)) return responder(res, 403, { erro: 'origem não permitida' }), null;
      }
    }
    if (m === 'POST') {
      if (req.headers.origin !== `https://${c.host}`) return responder(res, 403, { erro: 'origem não permitida' }), null;
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return responder(res, 415, { erro: 'corpo_deve_ser_json' }), null;
    }
    const lerJSON = async (limite) => {
      const bruto = await lerCorpo(req, limite);
      let b;
      try { b = bruto.trim() ? JSON.parse(bruto) : {}; } catch { b = null; }
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        const e = new Error('corpo inválido');
        e.status = 400;
        throw e;
      }
      req._corpoBruto = bruto; // o roteamento comum relê daqui (servidor.lerCorpo)
      return b;
    };

    // Públicas (sem cookie).
    if (m === 'GET') {
      if (rota === '/') {
        res.writeHead(302, { location: '/m', 'cache-control': 'no-store' });
        res.end();
        return null;
      }
      if (Object.hasOwn(MOBILE, rota)) return await servirArquivo(res, path.join(pasta, 'mobile', MOBILE[rota][0]), MOBILE[rota][1]), null;
      // A tela offline do PC traz a pasta do Orbit; no celular sai sem ela.
      if (rota === '/offline.html') return await servirArquivo(res, path.join(pasta, 'pwa', 'offline.html'), 'text/html; charset=utf-8', (t) => t.replaceAll('__PASTA__', '').replaceAll('__PORTA__', ''), true), null;
      if (rota === '/sw.js' || RE_ASSET.test(rota)) return { aparelho: null };
    } else if (rota === '/remoto/parear/pedir' || rota === '/remoto/parear/confirmar') {
      const b = await lerJSON(4096);
      return (rota === '/remoto/parear/pedir' ? parearPedir(res, b, chave) : parearConfirmar(res, b, chave)), null;
    }

    const au = autenticarCookie(req);
    if (!au) return responder(res, 401, { erro: 'nao_pareado' }), null;
    const { a } = au;
    if (au.renovar) res.setHeader('set-cookie', au.renovar); // o /remoto/sair sobrescreve (apaga o cookie)
    acompanhar(a.id, res);
    res._remoto = a.id; // o /fluxo e o difundir sabem que o cliente é remoto (e de qual aparelho)
    const b = m === 'POST' ? await lerJSON(rota === '/instancias' || /\/mensagem$/.test(rota) ? MAX_CORPO_GRANDE : MAX_CORPO) : null;

    // /remoto/* do aparelho.
    if (m === 'GET' && rota === '/remoto/eu') {
      let vapidPublica = null;
      if (push) try { vapidPublica = await push.chavePublica(); } catch (e) { log('remoto: chave VAPID', e?.message || e); }
      return responder(res, 200, { aparelho: { id: a.id, nome: a.nome }, opcoes: { criarInstancias: !!c.criarInstancias }, vapidPublica }), null;
    }
    if (m === 'GET' && rota === '/remoto/projetos' && c.criarInstancias) {
      return responder(res, 200, projetos().map((p) => ({ pasta: p.pasta, nome: p.nome }))), null;
    }
    if (m === 'POST' && rota === '/remoto/sair') {
      log('remoto', `${a.nome} [${a.id}] sair`);
      responder(res, 200, { ok: true }, { 'set-cookie': cookieApagar });
      revogar(a.id, res);
      return null;
    }
    if (m === 'POST' && rota === '/remoto/push/assinar') {
      const s = assinaturaValida(b.assinatura);
      if (!s) return responder(res, 400, { erro: 'assinatura_invalida' }), null;
      a.push = s;
      gravar();
      log('remoto', `${a.nome} [${a.id}] push assinar`);
      avisar();
      return responder(res, 200, { ok: true }), null;
    }
    if (m === 'POST' && rota === '/remoto/push/cancelar') {
      a.push = null;
      gravar();
      log('remoto', `${a.nome} [${a.id}] push cancelar`);
      avisar();
      return responder(res, 200, { ok: true }), null;
    }
    if (m === 'POST' && rota === '/remoto/push/teste') {
      if (!a.push) return responder(res, 409, { erro: 'sem_assinatura' }), null;
      const r = await enviarPara(a, { titulo: 'Orbit · teste', corpo: '', url: '/m', tag: 'teste' }, { ttl: 60, urgencia: 'high' });
      log('remoto', `${a.nome} [${a.id}] push teste: ${r.status}`);
      return responder(res, 200, { ok: r.status >= 200 && r.status < 300, status: r.status }), null;
    }

    // Lista permitida. O padrão é negar.
    const ms = RE_SESSAO.exec(rota);
    let sid = null;
    let acao = '';
    let ok = false;
    if (m === 'GET' && GET_FIXAS.has(rota)) ok = true;
    else if (m === 'POST' && rota === '/instancias') ok = !!c.criarInstancias;
    else if (ms) {
      acao = ms[2] || '';
      ok = m === 'GET' ? SESSAO_GET.has(acao) : SESSAO_POST.has(acao);
    }
    if (!ok) return responder(res, 403, { erro: 'bloqueado_no_celular' }), null;
    if (ms) {
      try { sid = decodeURIComponent(ms[1]); } catch { return responder(res, 400, { erro: 'id inválido' }), null; }
      if (!nativa(sid)) return responder(res, 404, { erro: 'sessão não encontrada' }), null;
      if (acao === 'modo' && !MODOS_OK.includes(b.modo)) return responder(res, 403, { erro: 'modo_nao_permitido' }), null;
    }
    if (m === 'POST' && rota === '/instancias') {
      if (!pastaCadastrada(b.pasta) || (b.cwd !== undefined && !pastaCadastrada(b.cwd))) return responder(res, 403, { erro: 'pasta_nao_permitida' }), null;
      if (b.permissao != null && b.permissao !== '' && !MODOS_OK.includes(b.permissao)) return responder(res, 403, { erro: 'modo_nao_permitido' }), null;
    }
    // Ações remotas no log: aparelho, ação e sessão (nunca o conteúdo).
    if (m === 'POST') log('remoto', `${a.nome} [${a.id}] ${sid ? `${acao} sessão ${sid}` : `nova instância em ${b.pasta}`}`);
    return { aparelho: a };
  }

  // Desliga tudo (fim do servidor).
  function fechar() {
    clearTimeout(tmPedido);
    for (const id of [...conexoes.keys()]) derrubar(id);
  }

  podarExpirados();
  return { atender, rotaLocal, notificar, detectar, desligado, fechar, estado, autenticar };
}
