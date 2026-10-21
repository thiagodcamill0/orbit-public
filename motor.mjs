// Orbit — motor de instâncias (rodada 6, etapa 1). Rodada 6.
// Processo próprio, destacado do servidor, que segura os claude.exe do Orbit: reiniciar ou derrubar o
// servidor não mata mais as instâncias. Fala JSON por linha num pipe local, com o token do
// <DADOS>/motor.json. Não conhece rota, sessão do Orbit nem regra de negócio: só processos e o mínimo
// do stream-json para o servidor se reconstruir depois de reiniciar (o `estado` de cada instância).
// Os claude.exe são filhos NÃO destacados: no Windows ficam no job do libuv deste processo e morrem junto
// com ele. No Mac/Linux não há job: o motor mata a árvore deles ao sair (sinal ou fim normal); morto à força
// (SIGKILL), os filhos ficam sem o stdin e saem sozinhos.
// Sem dependências. Quem sobe: o controle.mjs (node motor.mjs, detached). Ambiente:
//   GERENCIADOR_DADOS       pasta de dados (padrão: a pasta deste arquivo); uma instância por pasta
//   ORBIT_MOTOR_OCIOSO_MS   sai sozinho sem processos vivos e sem cliente por esse tempo (padrão 10 min)
//   ORBIT_MOTOR_MAX         processos vivos ao mesmo tempo (padrão 5)

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathAmpliado, pastaLocal, matarArvore as matarArvorePlat } from './plataforma.mjs';

export const VERSAO = '1';
const ARQ_ESTE = fileURLToPath(import.meta.url);
const PASTA = path.dirname(ARQ_ESTE);
const MAX_LINHAS = 2000; // por instância: as últimas 2000 linhas ou 8 MB, o que vier antes
const MAX_BYTES = 8 * 1024 * 1024;
const GUARDA_MORTA = 10 * 60e3; // a instância morta fica 10 min no listar
const ESPERA_CLOSE = 2000; // depois do exit, espera o stdout fechar até 2 s antes do `saiu`

// Pipe do motor de uma pasta de dados: \\.\pipe\orbit-motor-<sha1(DADOS), 12 hex>.
// No Windows o caminho vai em minúsculas antes do hash (D:\ e d:\ são a mesma pasta).
// Mac/Linux: socket na pasta local do Orbit (plataforma.pastaLocal: privada do usuário e fixa, sem depender
// do TMPDIR, que muda entre o launchd e o Terminal): <pastaLocal>/motor-<hash>.sock. O caminho de um socket
// cabe em 104 bytes (macOS); passou de 100, vai para a pasta temporária. `o = { so, home, env, tmp }` só nos testes.
// Pasta de dados que não é a do Orbit (testes: GERENCIADOR_DADOS numa pasta temporária): o socket fica na
// própria pasta de dados (ou, longo demais, na temporária), nunca na pasta local real. No Mac o arquivo do
// socket fica no disco se o motor for morto à força, e o de um teste não pode sujar a pasta do usuário.
// `o.pasta` (a pasta do Orbit) só nos testes.
export function pipeDoMotor(dados, o = {}) {
  const so = o.so || process.platform;
  const p = so === 'win32' ? path.win32 : path.posix;
  const d = p.resolve(dados);
  const h = crypto.createHash('sha1').update(so === 'win32' ? d.toLowerCase() : d).digest('hex').slice(0, 12);
  if (so === 'win32') return `\\\\.\\pipe\\orbit-motor-${h}`;
  const doOrbit = d === p.resolve(o.pasta || PASTA);
  const s = doOrbit ? p.join(pastaLocal(o), `motor-${h}.sock`) : p.join(d, `motor-${h}.sock`);
  return Buffer.byteLength(s) <= 100 ? s : p.join(o.tmp || os.tmpdir(), `orbit-motor-${h}.sock`);
}

// Estado mínimo pelo que SAI do processo (stdout).
function observarSaida(e, inits, j) {
  if (!j || typeof j !== 'object') return;
  if (j.type === 'assistant' || j.type === 'stream_event') e.ocupada = true;
  else if (j.type === 'result') {
    e.ocupada = false;
    if (j.session_id) e.sessao = String(j.session_id);
  } else if (j.type === 'system' && j.subtype === 'init') {
    if (j.session_id) e.sessao = String(j.session_id);
  } else if (j.type === 'control_response') {
    const r = j.response || {};
    if (inits.has(r.request_id)) {
      inits.delete(r.request_id);
      if (r.subtype === 'success') e.iniciado = true;
    }
  } else if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') e.permissoes.push(j);
  else if (j.type === 'control_cancel_request') e.permissoes = e.permissoes.filter((q) => q.request_id !== j.request_id);
}

// Estado mínimo pelo que o cliente ESCREVE (stdin).
function observarEntrada(e, inits, j) {
  if (!j || typeof j !== 'object') return;
  if (j.type === 'user') e.ocupada = true;
  else if (j.type === 'control_response') {
    const id = j.response?.request_id;
    e.permissoes = e.permissoes.filter((q) => q.request_id !== id);
  } else if (j.type === 'control_request' && j.request?.subtype === 'initialize' && !e.iniciado) inits.add(j.request_id);
}

// Windows: taskkill /T /F; Mac/Linux: SIGKILL nos descendentes e no pid (plataforma.mjs).
function matarArvore(pid, feito) {
  matarArvorePlat(pid).then(feito, feito);
}

function principal() {
  const DADOS = path.resolve(process.env.GERENCIADOR_DADOS || PASTA);
  const PIPE = pipeDoMotor(DADOS);
  const ARQ = path.join(DADOS, 'motor.json');
  const LOG = path.join(DADOS, 'logs', 'motor.log');
  const OCIOSO = Number(process.env.ORBIT_MOTOR_OCIOSO_MS) || 10 * 60e3;
  const MAX_VIVOS = Number(process.env.ORBIT_MOTOR_MAX) || 5;
  const token = crypto.randomBytes(32).toString('hex');
  const desde = Date.now();
  const insts = new Map(); // id → instância
  let cliente = null; // um cliente autenticado por vez
  let tmOcioso = null;

  // logs/motor.log (2 MB + .1): o motor roda sem console.
  function log(...a) {
    const linha = [new Date().toISOString(), process.pid, ...a.map((x) => (x instanceof Error ? x.stack : String(x)))].join(' ');
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      if ((fs.statSync(LOG, { throwIfNoEntry: false })?.size || 0) > 2 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1');
      fs.appendFileSync(LOG, linha + '\n');
    } catch {}
  }

  const vivos = () => [...insts.values()].filter((i) => i.vivo).length;
  const enviar = (con, o) => {
    try {
      con.c.write(JSON.stringify(o) + '\n');
    } catch {}
  };
  const responder = (con, j, ok, extra = {}) => enviar(con, ok ? { req: String(j.req ?? ''), ok: true, ...extra } : { req: String(j.req ?? ''), ok: false, ...extra });
  const igual = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const atual = (inst) => insts.get(inst.id) === inst; // a instância não foi trocada por outra de mesmo id

  function sair(motivo) {
    log('saindo', motivo);
    try {
      if (JSON.parse(fs.readFileSync(ARQ, 'utf8')).pid === process.pid) fs.rmSync(ARQ, { force: true });
    } catch {}
    try {
      srv.close();
    } catch {}
    setTimeout(() => process.exit(0), 100);
  }

  function revisarOcioso() {
    const ocioso = !cliente && vivos() === 0;
    if (ocioso && !tmOcioso) {
      tmOcioso = setTimeout(() => {
        tmOcioso = null;
        if (!cliente && vivos() === 0) sair('ocioso');
      }, OCIOSO);
    } else if (!ocioso && tmOcioso) {
      clearTimeout(tmOcioso);
      tmOcioso = null;
    }
  }

  function publica(i) {
    const o = { id: i.id, pid: i.pid, desde: i.desde, vivo: i.vivo, seq: i.seq, meta: i.meta, estado: i.estado };
    if (!i.vivo) {
      o.codigo = i.codigo;
      if (i.sinal) o.sinal = i.sinal;
    }
    return o;
  }

  function linha(inst, l) {
    const seq = ++inst.seq;
    const bytes = Buffer.byteLength(l);
    inst.linhas.push({ seq, linha: l, bytes });
    inst.bytes += bytes;
    while (inst.linhas.length > MAX_LINHAS || (inst.bytes > MAX_BYTES && inst.linhas.length > 1)) inst.bytes -= inst.linhas.shift().bytes;
    try {
      observarSaida(inst.estado, inst.inits, JSON.parse(l));
    } catch {}
    if (atual(inst) && cliente?.assinadas.has(inst.id)) enviar(cliente, { ev: 'linha', id: inst.id, seq, linha: l });
  }

  async function lancar(con, j) {
    const id = String(j.id ?? '');
    if (!id || id.length > 200) return responder(con, j, false, { erro: 'id inválido' });
    if (typeof j.cmd !== 'string' || !j.cmd) return responder(con, j, false, { erro: 'cmd inválido' });
    const velha = insts.get(id);
    if (velha?.vivo) return responder(con, j, false, { erro: 'já existe uma instância viva com esse id', codigo: 'existe' });
    if (vivos() >= MAX_VIVOS) return responder(con, j, false, { erro: `o motor já tem ${MAX_VIVOS} processos vivos`, codigo: 'limite' });
    const args = Array.isArray(j.args) ? j.args.map(String) : [];
    let env = j.env && typeof j.env === 'object' ? j.env : process.env;
    // Mac/Linux: PATH com o Homebrew e o ~/.local/bin (o controle já manda assim; vale também para outro cliente).
    if (process.platform !== 'win32') env = { ...env, PATH: pathAmpliado({ env }) };
    let ch;
    try {
      ch = spawn(j.cmd, args, { cwd: typeof j.cwd === 'string' && j.cwd ? j.cwd : undefined, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return responder(con, j, false, { erro: e.message });
    }
    const falhou = new Promise((r) => ch.once('error', (e) => r(e.message)));
    ch.on('error', (e) => log('processo', id, e.message));
    if (!ch.pid) {
      const erro = await Promise.race([falhou, new Promise((r) => setTimeout(() => r('não foi possível iniciar o processo'), 2000))]);
      return responder(con, j, false, { erro });
    }
    const inst = {
      id,
      pid: ch.pid,
      desde: Date.now(),
      vivo: true,
      fim: false,
      codigo: undefined,
      sinal: undefined,
      morreuEm: 0,
      seq: 0,
      linhas: [],
      bytes: 0,
      meta: j.meta ?? null,
      estado: { ocupada: false, sessao: null, iniciado: false, permissoes: [] },
      inits: new Set(),
      ch,
    };
    insts.set(id, inst);
    con.assinadas.add(id);
    let buf = '';
    ch.stdout.setEncoding('utf8');
    ch.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, k).replace(/\r$/, '');
        buf = buf.slice(k + 1);
        if (l.trim()) linha(inst, l);
      }
    });
    ch.stderr.setEncoding('utf8');
    ch.stderr.on('data', (d) => {
      if (atual(inst) && cliente?.assinadas.has(id)) enviar(cliente, { ev: 'stderr', id, texto: d });
    });
    ch.stdin.on('error', () => {});
    const emitirSaiu = () => {
      if (inst.fim) return;
      inst.fim = true;
      if (buf.trim()) linha(inst, buf.replace(/\r$/, ''));
      buf = '';
      if (atual(inst) && cliente) enviar(cliente, { ev: 'saiu', id, codigo: inst.codigo ?? null, sinal: inst.sinal ?? null });
    };
    ch.on('exit', (codigo, sinal) => {
      inst.vivo = false;
      inst.codigo = codigo;
      inst.sinal = sinal;
      inst.morreuEm = Date.now();
      log('saiu', id, `pid ${inst.pid}`, `código ${codigo}`, sinal || '');
      revisarOcioso();
      setTimeout(emitirSaiu, ESPERA_CLOSE).unref();
    });
    ch.on('close', () => {
      if (!inst.vivo) emitirSaiu();
    });
    log('lançou', id, `pid ${ch.pid}`);
    revisarOcioso();
    responder(con, j, true, { pid: ch.pid });
  }

  async function tratar(con, j) {
    if (cliente !== con) return; // conexão já substituída
    const op = j?.op;
    if (op === 'listar') return responder(con, j, true, { instancias: [...insts.values()].map(publica) });
    if (op === 'lancar') return lancar(con, j);
    if (op === 'sair') {
      if (vivos() > 0) return responder(con, j, false, { erro: 'há processos vivos' });
      responder(con, j, true);
      return sair('pedido do cliente');
    }
    const inst = insts.get(String(j?.id ?? ''));
    if (!inst) return responder(con, j, false, { erro: 'instância não encontrada' });
    if (op === 'escrever') {
      let l = typeof j.linha === 'string' ? j.linha : JSON.stringify(j.linha ?? null);
      l = l.replace(/[\r\n]+$/, '');
      if (!inst.vivo || !inst.ch.stdin.writable) return responder(con, j, false, { erro: 'o processo não está aceitando entrada' });
      try {
        observarEntrada(inst.estado, inst.inits, JSON.parse(l));
      } catch {}
      inst.ch.stdin.write(l + '\n');
      return responder(con, j, true);
    }
    if (op === 'fechar') {
      try {
        inst.ch.stdin.end();
      } catch {}
      return responder(con, j, true);
    }
    if (op === 'matar') {
      if (!inst.vivo) return responder(con, j, true);
      // Não segura a fila: o taskkill pode levar segundos.
      matarArvore(inst.pid, () => responder(con, j, true));
      return;
    }
    if (op === 'meta') {
      inst.meta = j.meta ?? null;
      return responder(con, j, true);
    }
    if (op === 'assinar') {
      const desde = Number(j.desde) || 0;
      con.assinadas.add(inst.id);
      responder(con, j, true, { seq: inst.seq, primeira: inst.linhas[0]?.seq ?? null });
      for (const l of inst.linhas) if (l.seq > desde) enviar(con, { ev: 'linha', id: inst.id, seq: l.seq, linha: l.linha });
      if (inst.fim) enviar(con, { ev: 'saiu', id: inst.id, codigo: inst.codigo ?? null, sinal: inst.sinal ?? null });
      return;
    }
    responder(con, j, false, { erro: `pedido desconhecido: ${op}` });
  }

  function conexao(c) {
    const con = { c, auth: false, assinadas: new Set(), fila: Promise.resolve() };
    let buf = '';
    c.setEncoding('utf8');
    const tm = setTimeout(() => c.destroy(), 5000); // sem auth em 5 s, fecha
    c.on('data', (d) => {
      buf += d;
      if (!con.auth && buf.length > 64 * 1024) return c.destroy();
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (!l) continue;
        let j;
        try {
          j = JSON.parse(l);
        } catch {
          continue;
        }
        if (!con.auth) {
          if (j?.op !== 'auth' || !igual(j.token, token)) {
            log('auth recusada');
            return c.destroy();
          }
          clearTimeout(tm);
          con.auth = true;
          // A conexão nova derruba a antiga: um servidor reiniciado assume na hora.
          if (cliente && cliente !== con) {
            enviar(cliente, { ev: 'substituido' });
            cliente.c.end();
            log('cliente substituído');
          }
          cliente = con;
          responder(con, j, true, { versao: VERSAO, pid: process.pid });
          revisarOcioso();
          continue;
        }
        con.fila = con.fila.then(() => tratar(con, j)).catch((e) => (log('pedido', e), responder(con, j, false, { erro: e.message })));
      }
    });
    c.on('error', () => {});
    c.on('close', () => {
      clearTimeout(tm);
      if (cliente === con) {
        cliente = null;
        revisarOcioso();
      }
    });
  }

  const srv = net.createServer(conexao);
  const WIN = process.platform === 'win32';
  let tentouLimpar = false;
  // Mac/Linux: só quem escutou apaga o arquivo do socket ao sair, e só se ainda for o mesmo arquivo (inode): entre
  // o srv.close() do sair() e o exit, um motor novo pode ter escutado no mesmo caminho.
  let escutando = false;
  let inoSocket = null;
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !WIN && !tentouLimpar) {
      // Mac/Linux: o arquivo do socket fica no disco se o motor anterior foi morto à força. Atende? Há um
      // motor nesta pasta de dados (sai com 0). Recusa? O arquivo é velho: apaga e escuta de novo, uma vez.
      tentouLimpar = true;
      const t = net.connect(PIPE);
      t.once('connect', () => (t.destroy(), process.exit(0)));
      t.once('error', () => {
        try {
          fs.rmSync(PIPE, { force: true });
        } catch {}
        log('socket velho apagado', PIPE);
        srv.listen(PIPE, aoEscutar);
      });
      return;
    }
    if (e.code === 'EADDRINUSE') process.exit(0); // já há um motor nesta pasta de dados
    log('pipe', e);
    process.exit(1);
  });
  if (!WIN) {
    try {
      fs.mkdirSync(path.dirname(PIPE), { recursive: true, mode: 0o700 });
    } catch {}
  }
  srv.listen(PIPE, aoEscutar);
  function aoEscutar() {
    escutando = true;
    if (!WIN) {
      try {
        inoSocket = fs.statSync(PIPE).ino;
      } catch {}
      try {
        fs.chmodSync(PIPE, 0o600); // só o usuário conecta (o token continua exigido)
      } catch {}
    }
    try {
      fs.mkdirSync(DADOS, { recursive: true });
      const tmp = `${ARQ}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, pipe: PIPE, token, versao: VERSAO, desde }));
      fs.renameSync(tmp, ARQ);
    } catch (e) {
      log('motor.json', e);
      process.exit(1);
    }
    log(`motor v${VERSAO} no ar`, PIPE, `(dados em ${DADOS})`);
    revisarOcioso();
  }
  // Instâncias mortas saem do listar depois de 10 min.
  setInterval(() => {
    const agora = Date.now();
    for (const [id, i] of insts) if (!i.vivo && i.fim && agora - i.morreuEm > GUARDA_MORTA) insts.delete(id);
  }, 60e3).unref();

  // Mac/Linux: sem o job do Windows, os filhos sobreviveriam ao motor. Num sinal, mata a árvore de cada
  // um e sai; no fim do processo (qualquer motivo que deixe rodar código), SIGKILL nos que restarem.
  if (!WIN) {
    const pidsVivos = () => [...insts.values()].filter((i) => i.vivo).map((i) => i.pid);
    process.on('exit', () => {
      for (const pid of pidsVivos()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      // O srv.close() do sair() já apaga o socket; aqui, as outras saídas (erro, exit direto).
      if (escutando && inoSocket != null) {
        try {
          if (fs.statSync(PIPE).ino === inoSocket) fs.rmSync(PIPE, { force: true });
        } catch {}
      }
    });
    for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
      process.on(s, () => {
        log('sinal', s);
        Promise.all(pidsVivos().map((pid) => matarArvorePlat(pid))).finally(() => sair(s));
      });
    }
  }

  process.on('uncaughtException', (e) => log('uncaughtException', e));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e));
}

// Só roda como processo (node motor.mjs); importado, expõe VERSAO e pipeDoMotor.
// Mac/Linux: compara o caminho real (o import.meta.url já vem sem link simbólico; o argv não).
function caminhoReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
const chamado = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (chamado && (process.platform === 'win32' ? chamado.toLowerCase() === ARQ_ESTE.toLowerCase() : caminhoReal(chamado) === caminhoReal(ARQ_ESTE))) principal();
