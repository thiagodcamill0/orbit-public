// Orbit — música tocando (widget no pé da lateral), pelos controles de mídia do sistema. Sem conta nem app
// de desenvolvedor: lê o que o próprio sistema já mostra e manda play/pause, próxima e anterior.
//
// Rotas (o servidor.mjs só encaixa: criarMidia(deps) e rota()):
//   GET  /midia               { ativo, suportado, midia: null | { id, titulo, artista, album, app, spotify, estado,
//                               lembranca, capa, controles: { play, prox, ant } } }
//   GET  /midia/capa?v=<id>   capa da música atual ou da última (guardada aqui)
//   POST /midia/comando       { acao: 'alternar' | 'proxima' | 'anterior' }
//   POST /midia/ativo         { ativo } liga ou desliga o widget (e a leitura)
// Toda mudança vai também pelo /fluxo (evento `midia`), para as outras abas.
//
// Fontes:
//  - Windows: midia.ps1, um PowerShell que fica vivo e lê os controles de mídia do Windows (Spotify, navegadores,
//    qualquer player que apareça no painel das teclas de volume). Só o que está tocando (Spotify na frente);
//    pausado, só a música que já estava na tela.
//  - Mac: por enquanto nenhuma (16/10): "indisponível neste sistema", sem erro e sem processo; o widget some.
//    (O macOS 15.4+ fechou o "Tocando agora" geral; a leitura por AppleScript no Spotify, nunca testada, saiu.)
//  - Testes: ORBIT_MIDIA_FALSO=<arquivo.json> (estado lido do arquivo, comandos anotados em <arquivo>.comandos).
// A leitura só roda com o widget ligado e alguma página do Orbit aberta. Sem player, fica a última música
// (guardada em midia.json, na pasta de dados), pausada; o play dela abre o app do Spotify, se ela veio de lá.
//
// Substitui a integração pela Web API do Spotify (16/10): ao subir, apaga o acesso antigo (spotify.token/.json).

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SO, pastaLocal } from './plataforma.mjs';

const PASTA_ORBIT = path.dirname(fileURLToPath(import.meta.url));
const FALSO = process.env.ORBIT_MIDIA_FALSO || '';
const MS_CONFERIR = 3000; // liga/desliga a fonte conforme o widget e as páginas abertas
const MS_SEM_OUVINTE = 60e3; // sem página aberta por 1 min: a fonte para
const MS_ABRIR_SPOTIFY = 20e3; // depois de abrir o Spotify, espera a sessão aparecer para dar play
const MS_DEPOIS_DO_PULO = 2500; // depois de próxima/anterior pelo widget, aceita a música nova mesmo pausada
const MAX_TEXTO = 200;
const MAX_CAPA = 1024 * 1024;
const ACOES = new Set(['alternar', 'proxima', 'anterior']);

// ───────────────────────── utilidades ─────────────────────────

function encurtar(t, max = MAX_TEXTO) {
  const s = String(t ?? '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function erroHttp(status, erro) {
  const e = new Error(erro);
  e.status = status;
  return e;
}

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function tipoDaImagem(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return '';
}

const ehSpotify = (app) => /spotify/i.test(app || '');

// Nome curto do app, para o title do widget ("Spotify", "Brave", "msedge" → "Edge").
function nomeDoApp(app) {
  const a = String(app || '');
  if (ehSpotify(a)) return 'Spotify';
  const base = a.split('!').pop().split('\\').pop().replace(/\.exe$/i, '').replace(/_[a-z0-9]{13}$/i, '');
  const nomes = { msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi' };
  return nomes[base.toLowerCase()] || encurtar(base.split('.').pop(), 40);
}

// Estado bruto de qualquer fonte → { app, estado, titulo, artista, album, play, prox, ant, capa: Buffer | null }.
function normalizar(b) {
  if (!b || b.nenhum) return null;
  const titulo = encurtar(b.titulo);
  if (!titulo) return null;
  let capa = null;
  if (Buffer.isBuffer(b.capa)) capa = b.capa;
  else if (typeof b.capa === 'string' && b.capa) capa = Buffer.from(b.capa, 'base64');
  if (capa && (capa.length > MAX_CAPA || !tipoDaImagem(capa))) capa = null;
  return {
    app: encurtar(b.app, 300),
    estado: b.estado === 'tocando' ? 'tocando' : 'pausado',
    titulo,
    artista: encurtar(b.artista),
    album: encurtar(b.album),
    play: b.play !== false,
    prox: !!b.prox,
    ant: !!b.ant,
    capa,
  };
}

// ───────────────────────── fontes ─────────────────────────

// Windows: o midia.ps1 vivo, falando por linhas (base64 de JSON na saída, "acao<TAB>app" na entrada).
function fonteWindows({ log }) {
  const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let proc = null;
  let quer = false;
  let aoMudar = () => {};
  let espera = 2000;
  let religar = null;
  let erroLogado = '';
  let fixo = ''; // reenviado a cada vez que o leitor sobe

  function subir() {
    let script;
    try { script = fs.readFileSync(path.join(PASTA_ORBIT, 'midia.ps1'), 'utf8'); } catch (e) { log('midia: midia.ps1 não abriu:', e?.message || e); return; }
    const p = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc = p;
    if (fixo) { try { p.stdin.write(`fixar\t${fixo}\n`); } catch {} }
    let buf = '';
    const inicio = Date.now();
    p.stdout.setEncoding('ascii');
    p.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const linha = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!linha) continue;
        let j;
        try { j = JSON.parse(Buffer.from(linha, 'base64').toString('utf8')); } catch { continue; }
        if (j && typeof j.erro === 'string') {
          if (j.erro !== erroLogado) { erroLogado = j.erro; log('midia: leitura do Windows falhou:', encurtar(j.erro, 160)); }
          continue;
        }
        if (erroLogado) { erroLogado = ''; log('midia: leitura do Windows voltou'); }
        espera = 2000;
        aoMudar(j);
      }
    });
    p.stdin.on('error', () => {});
    p.on('error', (e) => log('midia: PowerShell não abriu:', e?.message || e));
    p.on('exit', (codigo) => {
      if (proc === p) proc = null;
      if (!quer) return;
      // Caiu sozinho: avisa uma vez e sobe de novo, cada vez mais devagar.
      if (Date.now() - inicio < 10e3) espera = Math.min(60e3, espera * 2);
      log('midia: o leitor do Windows saiu (' + codigo + '); de novo em', Math.round(espera / 1000), 's');
      aoMudar({ nenhum: true });
      religar = setTimeout(() => { religar = null; if (quer && !proc) subir(); }, espera);
      religar.unref?.();
    });
  }

  return {
    iniciar(fn) {
      aoMudar = fn;
      quer = true;
      if (!proc && !religar) subir();
    },
    parar() {
      quer = false;
      clearTimeout(religar);
      religar = null;
      if (proc) { try { proc.stdin.end(); } catch {} const p = proc; setTimeout(() => { try { p.kill(); } catch {} }, 3000).unref?.(); }
      proc = null;
    },
    comando(acao, app) {
      if (acao === 'fixar') fixo = String(app || '').replace(/[\t\r\n]/g, '');
      if (!proc) return false;
      try { proc.stdin.write(`${acao}\t${String(app || '').replace(/[\t\r\n]/g, '')}\n`); return true; } catch { return false; }
    },
  };
}

// Testes: o estado vem de um arquivo JSON; os comandos vão, um por linha, para <arquivo>.comandos.
function fonteFalsa(arquivo) {
  let timer = null;
  let aoMudar = () => {};
  let ultimo = '';
  function ler() {
    let b = { nenhum: true };
    try { b = JSON.parse(fs.readFileSync(arquivo, 'utf8')) || { nenhum: true }; } catch {}
    if (b.capaArquivo) { try { b.capa = fs.readFileSync(b.capaArquivo); } catch {} delete b.capaArquivo; }
    const sig = JSON.stringify({ ...b, capa: b.capa ? b.capa.length : 0 });
    if (sig !== ultimo) { ultimo = sig; aoMudar(b); }
  }
  return {
    iniciar(fn) { aoMudar = fn; if (!timer) { ler(); timer = setInterval(ler, 200); timer.unref?.(); } },
    parar() { clearInterval(timer); timer = null; ultimo = ''; },
    comando(acao, app) { fs.appendFileSync(arquivo + '.comandos', `${acao}\t${app || ''}\n`); return true; },
  };
}

// ───────────────────────── módulo ─────────────────────────

export function criarMidia(deps) {
  // `so` existe para os testes simularem o Mac.
  const { lerJSONCorpo, difundir = () => {}, log = () => {}, dados, ouvintes = () => 1, so = SO } = deps;
  const ARQ = path.join(dados, 'midia.json');
  const PASTA_LOCAL = path.resolve(process.env.ORBIT_PERFIL_DIR || pastaLocal({ so }));
  // Só o Windows tem fonte (fora a falsa dos testes). Sem fonte, nenhum processo sobe.
  const fonte = FALSO ? fonteFalsa(FALSO) : so === 'win32' ? fonteWindows({ log }) : null;
  // Abrir o Spotify a partir da última música: no Windows pelo spotify:.
  const podeAbrirSpotify = !!fonte;

  let ativo = true;
  let ultima = null; // { id, app, titulo, artista, album, capa: Buffer | null }
  try {
    const salvo = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    ativo = salvo.ativo !== false;
    const u = salvo.ultima;
    if (u && typeof u.titulo === 'string' && u.titulo) {
      ultima = { id: String(u.id || ''), app: encurtar(u.app, 300), titulo: encurtar(u.titulo), artista: encurtar(u.artista), album: encurtar(u.album), capa: null };
      if (typeof u.capa === 'string' && u.capa) {
        const b = Buffer.from(u.capa, 'base64');
        if (tipoDaImagem(b)) ultima.capa = b;
      }
    }
  } catch {}

  // Fim da integração pela Web API do Spotify: apaga o acesso guardado (e herda a chave ligada/desligada).
  const ANTIGOS = [path.join(PASTA_LOCAL, 'spotify.token'), path.join(PASTA_LOCAL, 'spotify.json')];
  if (ANTIGOS.some((a) => fs.existsSync(a))) {
    try {
      const velho = JSON.parse(fs.readFileSync(ANTIGOS[1], 'utf8'));
      if (!fs.existsSync(ARQ) && velho && velho.ativo === false) ativo = false;
    } catch {}
    for (const a of ANTIGOS) { try { fs.rmSync(a, { force: true }); } catch {} }
    log('midia: apaguei o acesso antigo da Web API do Spotify (spotify.token e spotify.json)');
  }

  let atual = null; // normalizar() + id, da sessão viva
  let abrindoAte = 0; // abriu o Spotify pela última música: dá play quando a sessão aparecer

  const idDe = (m) => crypto.createHash('sha1').update(`${m.app}|${m.titulo}|${m.artista}|${m.album}`).digest('hex').slice(0, 16);

  function publico() {
    let midia = null;
    if (ativo && atual) {
      midia = {
        id: atual.id, titulo: atual.titulo, artista: atual.artista, album: atual.album, app: nomeDoApp(atual.app), spotify: ehSpotify(atual.app),
        estado: atual.estado, lembranca: false, capa: atual.capa ? `/midia/capa?v=${atual.id}` : null,
        controles: { play: atual.play, prox: atual.prox, ant: atual.ant },
      };
    } else if (ativo && ultima) {
      const sp = ehSpotify(ultima.app);
      midia = {
        id: ultima.id, titulo: ultima.titulo, artista: ultima.artista, album: ultima.album, app: nomeDoApp(ultima.app), spotify: sp,
        estado: 'pausado', lembranca: true, capa: ultima.capa ? `/midia/capa?v=${ultima.id}` : null,
        controles: { play: sp && podeAbrirSpotify, prox: false, ant: false },
      };
    }
    return { ativo, suportado: !!fonte, midia };
  }

  let ultimoSig = '';
  function avisar(sempre) {
    const p = publico();
    const sig = JSON.stringify(p);
    if (!sempre && sig === ultimoSig) return;
    ultimoSig = sig;
    difundir('midia', p);
  }

  let gravando = null;
  function salvar() {
    // Uma gravação de cada vez; a última mudança sempre chega ao disco.
    if (gravando) { gravando.de_novo = true; return; }
    gravando = { de_novo: false };
    const corpo = JSON.stringify({ ativo, ultima: ultima && { ...ultima, capa: ultima.capa ? ultima.capa.toString('base64') : '' } }, null, 2);
    const tmp = `${ARQ}.${process.pid}.tmp`;
    fsp.writeFile(tmp, corpo).then(() => fsp.rename(tmp, ARQ)).catch((e) => log('midia: gravar midia.json:', e?.message || e)).finally(() => {
      const outra = gravando.de_novo;
      gravando = null;
      if (outra) salvar();
    });
  }

  // Só o que está tocando entra na tela. Pausado, só a música que já estava nela (o widget fica nela, pausado):
  // outra aba ou player pausado nunca entra (no navegador, o Windows informa o mesmo app para todas as abas).
  // Exceção: logo depois de próxima/anterior pelo widget, a música nova entra mesmo pausada.
  let puloAte = 0;
  function receber(bruto) {
    const m = normalizar(bruto);
    if (m) {
      m.id = idDe(m);
      // A mesma música sem capa nesta leitura (o navegador manda depois): fica a que já havia.
      if (!m.capa && atual && atual.id === m.id && atual.capa) m.capa = atual.capa;
      if (!m.capa && ultima && ultima.id === m.id && ultima.capa) m.capa = ultima.capa;
    }
    if (m && m.estado !== 'tocando') {
      const naTela = atual || ultima;
      const pulou = atual && m.app === atual.app && Date.now() < puloAte;
      if (!pulou && (!naTela || naTela.id !== m.id)) {
        // Fica a que estava na tela, pausada (ou a última música, se nenhuma sessão está na tela).
        exibir(atual && { ...atual, estado: 'pausado' });
        return;
      }
    }
    exibir(m);
  }

  function exibir(m) {
    if (!m) {
      atual = null;
    } else {
      atual = m;
      const trocou = !ultima || ultima.id !== m.id || (!ultima.capa && m.capa);
      if (trocou) {
        ultima = { id: m.id, app: m.app, titulo: m.titulo, artista: m.artista, album: m.album, capa: m.capa };
        salvar();
      }
      if (abrindoAte && Date.now() < abrindoAte && ehSpotify(m.app) && m.estado === 'pausado') {
        abrindoAte = 0;
        fonte.comando('tocar', m.app);
      }
    }
    avisar();
  }

  // A fonte começa sabendo qual app está na tela, para mostrar a sessão dele pausada (e não outra).
  function ligarFonte() {
    rodando = true;
    fonte.iniciar(receber);
    const app = (atual || ultima)?.app;
    if (app) fonte.comando('fixar', app);
  }

  // Liga a fonte só com o widget ligado e alguma página aberta; desliga 1 min depois da última página.
  let rodando = false;
  let semOuvinteDesde = 0;
  function conferir() {
    if (!fonte) return;
    const ha = ouvintes() > 0;
    if (ha) semOuvinteDesde = 0;
    else if (!semOuvinteDesde) semOuvinteDesde = Date.now();
    const quer = ativo && (ha || Date.now() - semOuvinteDesde < MS_SEM_OUVINTE);
    if (quer && !rodando) ligarFonte();
    else if (!quer && rodando) { rodando = false; fonte.parar(); atual = null; }
  }
  const timer = setInterval(conferir, MS_CONFERIR);
  timer.unref?.();
  setTimeout(conferir, 500).unref?.();

  function comando(acao) {
    if (!ACOES.has(acao)) throw erroHttp(400, 'Ação inválida.');
    if (!fonte) throw erroHttp(501, 'A música tocando está indisponível neste sistema.');
    if (!ativo) throw erroHttp(409, 'O widget está desligado.');
    if (!rodando) ligarFonte();
    if (atual) {
      if (acao !== 'alternar') puloAte = Date.now() + MS_DEPOIS_DO_PULO;
      fonte.comando(acao, atual.app);
    } else if (acao === 'alternar' && ultima && ehSpotify(ultima.app) && podeAbrirSpotify) {
      // Sem player aberto: abre o app do Spotify e dá play quando a sessão dele aparecer.
      abrindoAte = Date.now() + MS_ABRIR_SPOTIFY;
      fonte.comando('abrir-spotify', '');
    } else {
      throw erroHttp(409, 'Nenhum player aberto agora.');
    }
    return publico();
  }

  function definirAtivo(v) {
    if (typeof v !== 'boolean') throw erroHttp(400, 'ativo precisa ser true ou false');
    ativo = v;
    salvar();
    conferir();
    avisar(true);
    return publico();
  }

  async function rota(req, res, caminho, url) {
    if (caminho !== '/midia' && !caminho.startsWith('/midia/')) return false;
    if (req.method === 'GET') {
      if (caminho === '/midia') {
        semOuvinteDesde = 0;
        conferir();
        responder(res, 200, publico());
        return true;
      }
      if (caminho === '/midia/capa') {
        const v = url?.searchParams.get('v');
        const m = [atual, ultima].find((x) => x && x.id === v && x.capa);
        if (!ativo || !m) {
          responder(res, 404, { erro: 'sem capa' });
          return true;
        }
        // A URL muda (?v=) a cada música.
        res.writeHead(200, { 'content-type': tipoDaImagem(m.capa), 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        res.end(m.capa);
        return true;
      }
      return false;
    }
    if (req.method !== 'POST') return false;
    if (caminho === '/midia/comando') {
      const b = await lerJSONCorpo(req);
      responder(res, 200, comando(b?.acao));
      return true;
    }
    if (caminho === '/midia/ativo') {
      const b = await lerJSONCorpo(req);
      responder(res, 200, definirAtivo(b?.ativo));
      return true;
    }
    return false;
  }

  return { rota, publico, parar: () => { clearInterval(timer); if (rodando) fonte.parar(); } };
}
