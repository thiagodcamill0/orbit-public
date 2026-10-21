// Testes do controle das instâncias (controle.mjs, rodada 5).
// Rodar:  node --test testes/controle.test.mjs
// Sobe um servidor próprio na porta 47822 (nunca 47821), com dados, registro de sessões e pasta de
// projetos falsos dentro de GERENCIADOR_DADOS. O claude.exe é o testes/claude-falso.mjs; o canal é
// um servidor de pipe falso que exige auth. Nada do ~/.claude real é tocado.
// Rodada 6: os processos passam pelo motor.mjs do teste (DADOS/motor.json); o after() mata o motor.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Regra do time: a preferida se estiver livre, senão a próxima livre de 47822–47826 (nunca a 47821).
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
const WIN = process.platform === 'win32';
// Mac: a pasta temporária (/var/folders/…) é link para /private/var/…, e o process.cwd() do claude (e do
// claude-falso) devolve o caminho real. No Windows, o caminho como sempre foi.
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const BASE = realDe(path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes')));
const DADOS = path.join(BASE, `controle-${Date.now()}`);
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const LOG = path.join(DADOS, 'falso.log');
for (const d of [SESSOES, PROJETOS]) fs.mkdirSync(d, { recursive: true });

const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: '250',
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: SESSOES,
  ORBIT_PROJETOS_DIR: PROJETOS,
  // Mac: o socket do motor fica em ~/Library/Application Support/Orbit; o HOME do teste o tira da pasta real.
  ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_REGISTRO: '200',
  ORBIT_MS_VIGIA: '100',
  ORBIT_MS_CANAL: '1500',
  ORBIT_MS_INICIO: '2500',
  ORBIT_MS_DEVOLVER: '1500',
  ORBIT_MS_MODELOS_INICIO: '300', // etapa 2: a sonda dos modelos (claude-falso) logo depois de subir
  FALSO_LOG: LOG,
  FALSO_DEMORA_MS: '1200',
  CLAUDECODE: '1', // tem de sumir no processo do Orbit
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

// ───────── HTTP / SSE ─────────

function pedir(metodo, rota, corpo, { cabecalho = true } = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = {};
    if (cabecalho) headers['x-gerenciador'] = '1';
    if (dados !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(dados);
    }
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try {
          json = JSON.parse(texto);
        } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve({ status: 'reset' }) : reject(e)));
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c = {}, o) => pedir('POST', r, c, o);
const rs = (id, resto = '') => `/sessao/${encodeURIComponent(id)}${resto}`;
const controleDe = async (id) => (await get(rs(id))).json?.sessao?.controle;

function sse(rota) {
  const eventos = [];
  const ouvintes = new Set();
  let req;
  const pronto = new Promise((ok, ko) => {
    req = http.get({ host: '127.0.0.1', port: PORTA, path: rota }, (res) => {
      ok(res.statusCode);
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const tipo = /^event: (.*)$/m.exec(bloco)?.[1];
          const dado = /^data: (.*)$/m.exec(bloco)?.[1];
          if (!tipo) continue;
          const ev = { tipo, dados: dado ? JSON.parse(dado) : null };
          eventos.push(ev);
          for (const f of ouvintes) f(ev);
        }
      });
    });
    req.on('error', ko);
  });
  return {
    eventos,
    pronto,
    esperar(pred, ms = 5000, rotulo = 'evento') {
      const ja = eventos.find(pred);
      if (ja) return Promise.resolve(ja);
      return new Promise((ok, ko) => {
        const t = setTimeout(() => (ouvintes.delete(f), ko(new Error(`sem ${rotulo} em ${ms} ms`))), ms);
        const f = (ev) => pred(ev) && (clearTimeout(t), ouvintes.delete(f), ok(ev));
        ouvintes.add(f);
      });
    },
    fechar: () => req.destroy(),
  };
}

async function esperarQue(cond, ms = 5000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(50);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}

// ───────── servidor ─────────

let proc;
let fluxo;
async function subir(extra = {}) {
  // A porta tem de estar livre: nunca falar com o servidor de outra sessão (nem derrubá-lo).
  const antes = await get('/saude').catch(() => ({}));
  if (antes.status) throw new Error(`porta ${PORTA} ocupada por outro servidor; use GERENCIADOR_PORTA=<livre> (47822–47826, conferida antes)`);
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: { ...ENV, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  const meu = proc;
  await esperarQue(async () => {
    if (meu.exitCode != null) throw new Error(`o servidor do teste saiu (código ${meu.exitCode}); a porta ${PORTA} foi tomada?`);
    const r = await get('/saude').catch(() => ({}));
    return r.status === 200 && r.json?.pid === meu.pid;
  }, 8000, 'servidor do teste no ar');
  fluxo = sse('/fluxo');
  await fluxo.pronto;
}
// /desligar só para o processo que o próprio teste criou (o /saude devolve o pid).
async function desligarMeu() {
  const r = await get('/saude').catch(() => ({}));
  if (!proc || r.json?.pid !== proc.pid) throw new Error(`o servidor na porta ${PORTA} não é o do teste; não desligo`);
  return post('/desligar');
}
// Rodada 6: reinicia o servidor (pelo /desligar ou derrubado à força); o motor e os processos seguem.
async function reiniciar({ duro = false, extra } = {}) {
  fluxo?.fechar();
  const velho = proc;
  if (duro) velho.kill();
  else await desligarMeu();
  await esperarQue(async () => velho.exitCode != null || velho.signalCode != null, 5000, 'servidor saiu');
  await subir(extra);
}
// Motor de instâncias do teste (DADOS/motor.json, nunca o da produção): matar com /T leva os filhos.
// Mac: o mesmo pela árvore (plataforma.matarArvore: SIGKILL nos descendentes e no pid).
async function matarMotorDoTeste(pid) {
  if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else await matarArvore(pid);
}
const ARQ_MOTOR = path.join(DADOS, 'motor.json');
const motorDoTeste = () => {
  try {
    return JSON.parse(fs.readFileSync(ARQ_MOTOR, 'utf8'));
  } catch {
    return null;
  }
};
const filhos = new Set();
after(async () => {
  fluxo?.fechar();
  if (proc && proc.exitCode == null) await desligarMeu().catch(() => {});
  await espera(300);
  try {
    proc?.kill();
  } catch {}
  const m = motorDoTeste();
  if (m?.pid && vivo(m.pid)) try { await matarMotorDoTeste(m.pid); } catch {}
  for (const c of filhos) try { c.kill(); } catch {}
  for (const s of pipes) try { s.close(); } catch {}
});

// Ação: espera o estado final pelo SSE `acao` do /fluxo.
const acaoFinal = (id, ms = 8000) => fluxo.esperar((e) => e.tipo === 'acao' && e.dados.id === id && e.dados.estado !== 'em_andamento', ms, `fim da ação ${id}`).then((e) => e.dados);

// ───────── sessões e transcripts falsos ─────────

let tsBase = Date.parse('2026-10-15T10:00:00Z');
function linha(o) {
  return JSON.stringify({ parentUuid: null, isSidechain: false, timestamp: new Date((tsBase += 1000)).toISOString(), sessionId: 'x', cwd: 'C:\\x', ...o }) + '\n';
}
const u = (texto, o = {}) => linha({ type: 'user', uuid: uuid(), message: { role: 'user', content: texto }, ...o });
const a = (content, o = {}) => linha({ type: 'assistant', uuid: uuid(), message: { model: 'claude-teste-9', role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content }, ...o });

let nSessao = 0;
async function criarSessao({ linhas = '', modo = '', semTranscript = false } = {}) {
  const id = uuid();
  const nome = `proj${++nSessao}`;
  const cwd = path.join(DADOS, 'cwd', nome);
  fs.mkdirSync(cwd, { recursive: true });
  const pasta = path.join(PROJETOS, nome);
  fs.mkdirSync(pasta, { recursive: true });
  const transcript = path.join(pasta, `${id}.jsonl`);
  if (!semTranscript) fs.writeFileSync(transcript, linhas.replaceAll('"cwd":"C:\\\\x"', JSON.stringify({ cwd }).slice(1, -1)));
  if (modo) fs.writeFileSync(path.join(pasta, 'falso-modo.txt'), modo);
  for (const nomeEv of ['SessionStart', 'Stop'])
    await post('/evento', { session_id: id, hook_event_name: nomeEv, transcript_path: transcript, cwd, ts: Date.now() });
  return { id, transcript, cwd, pasta };
}

// O procStart como o Claude Code grava: Windows, FILETIME; Mac, o `ps -o lstart=` com LC_ALL=C e TZ=UTC.
function inicioDoProcesso(pid) {
  if (!WIN) return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', windowsHide: true }).trim();
}
const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Servidor de pipe que imita o messagingSocket: exige {"type":"auth","token"} na 1ª linha;
// grava no transcript (queue-operation + par) quando a mensagem é para a sessão certa.
const pipes = new Set();
function pipeFalso(token, transcript, sessionId) {
  // Mac: socket Unix (o real fica em /tmp/cc-socks/<pid>.sock), na pasta temporária, curto (sun_path ≤ 104).
  const nome = `cc-msg-teste-${crypto.randomBytes(8).toString('hex')}`;
  const caminho = WIN ? `\\\\.\\pipe\\LOCAL\\${nome}` : path.join(os.tmpdir(), `${nome}.sock`);
  const st = { caminho, recebidas: [], authFalhou: 0, gravar: true };
  const srv = net.createServer((c) => {
    let buf = '';
    let autenticado = false;
    c.setEncoding('utf8');
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const j = JSON.parse(l);
        if (!autenticado) {
          if (j.type !== 'auth' || j.token !== token) {
            st.authFalhou++;
            return c.destroy();
          }
          autenticado = true;
          continue;
        }
        st.recebidas.push(j);
        if (st.gravar && j.session_id === sessionId) {
          const texto = j.message.content;
          fs.appendFileSync(transcript, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), sessionId, content: texto }) + '\n');
          fs.appendFileSync(
            transcript,
            u(`Another Claude session sent a message:\n${texto}\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.`, { isMeta: true, origin: { kind: 'peer', from: 'unknown' } }),
          );
        }
      }
    });
    c.on('error', () => {});
  });
  srv.listen(caminho);
  pipes.add(srv);
  return st;
}

// Processo vivo qualquer (faz o papel do claude do VS Code) + registro e .key dele.
function processoDoVsCode(sessionId, { status = 'idle', socket = '', token = 'tok-secreto-123', procStart } = {}) {
  const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
  filhos.add(filho);
  const pid = filho.pid;
  const reg = { pid, sessionId, cwd: 'C:\\x', startedAt: Date.now(), procStart: procStart ?? inicioDoProcesso(pid), kind: 'interactive', entrypoint: 'claude-vscode', status, messagingSocketPath: socket, updatedAt: Date.now(), statusUpdatedAt: Date.now() };
  const arqReg = path.join(SESSOES, `${pid}.json`);
  fs.writeFileSync(arqReg, JSON.stringify(reg));
  const hash = crypto.createHash('sha256').update(socket).digest('hex');
  const arqKey = path.join(SESSOES, `${pid}.${hash}.key`);
  // Formato do .key de cada sistema (Mac: visto no ~/.claude/sessions real, 2.1.301).
  if (socket) fs.writeFileSync(arqKey, JSON.stringify(WIN ? { peerToken: token, procStartFt: reg.procStart, pidDomain: 'win32:pc' } : { peerToken: token, procStart: reg.procStart, pidDomain: 'darwin' }));
  return { pid, filho, reg, arqReg, arqKey, mudar: (o) => fs.writeFileSync(arqReg, JSON.stringify({ ...reg, ...o })) };
}

// Conversa rica: todos os tipos de item e todas as exclusões do contrato.
function conversaRica() {
  const t1 = 'toolu_um';
  const t2 = 'toolu_dois';
  return [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Olá' }) + '\n',
    u('Olá, tudo bem?'),
    linha({ type: 'attachment', uuid: uuid(), attachment: { type: 'date' } }),
    a([{ type: 'thinking', thinking: 'pensando…', signature: 's' }]),
    a('Tudo! Vou ler o arquivo.'),
    a([{ type: 'tool_use', id: t1, name: 'Read', input: { file_path: 'C:\\x\\a.txt' } }]),
    u([{ type: 'tool_result', tool_use_id: t1, content: [{ type: 'text', text: 'conteúdo do arquivo' }] }]),
    a([
      { type: 'text', text: 'Agora rodo um comando.' },
      { type: 'tool_use', id: t2, name: 'Bash', input: { command: 'ls -la', description: 'lista' } },
    ]),
    u([{ type: 'tool_result', tool_use_id: t2, content: 'falhou', is_error: true }]),
    a('resposta de subagente', { isSidechain: true }),
    JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: 'b'.repeat(300 * 1024) }] } }) + '\n',
    JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }) + '\n',
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }) + '\n',
    JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }) + '\n',
    JSON.stringify({ type: 'atis-latch', atis: '' }) + '\n',
    linha({ type: 'system', subtype: 'compact_boundary', uuid: uuid(), content: 'Conversation compacted', compact_metadata: { trigger: 'manual', pre_tokens: 5000, post_tokens: 700 } }),
    u('This session is being continued from a previous conversation...', { isCompactSummary: true }),
    u('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
    u('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>só o backend</command-args>'),
    u('<local-command-stdout>Compacted </local-command-stdout>'),
    u('Another Claude session sent a message:\nPergunta do colega\n\nThis came from another Claude session — not typed by your user.', { isMeta: true, origin: { kind: 'peer', from: 'x' } }),
    u('<system-reminder>meta qualquer</system-reminder>', { isMeta: true }),
    u([{ type: 'text', text: '[Request interrupted by user]' }]),
    linha({ type: 'system', subtype: 'api_error', level: 'error', uuid: uuid(), content: 'API Error: 529 overloaded' }),
    u('<command-name>/model</command-name>\n<command-args>opus</command-args>'),
    a('Fim.'),
  ].join('');
}

await subir();

// ───────── conversa ─────────

test('conversa: itens normalizados na ordem do arquivo, exclusões e tool_result casado pelo tool_use_id', async () => {
  const s = await criarSessao({ linhas: conversaRica() });
  const r = await get(rs(s.id, '/conversa'));
  assert.equal(r.status, 200);
  assert.equal(r.json.cursorAntigo, null);
  const it = r.json.itens;
  assert.deepEqual(
    it.map((x) => x.tipo),
    ['usuario', 'pensamento', 'assistente', 'ferramenta', 'assistente', 'ferramenta', 'compactacao', 'comando', 'par', 'interrupcao', 'erro', 'comando', 'assistente'],
  );
  assert.equal(it[0].texto, 'Olá, tudo bem?');
  assert.equal(it[1].texto, 'pensando…');
  assert.deepEqual(it[3], { id: 'toolu_um', ts: it[3].ts, tipo: 'ferramenta', nome: 'Read', resumo: 'C:\\x\\a.txt', resultado: { texto: 'conteúdo do arquivo', erro: false } });
  assert.equal(it[5].id, 'toolu_dois');
  assert.equal(it[5].resumo, 'ls -la');
  assert.deepEqual(it[5].resultado, { texto: 'falhou', erro: true });
  assert.match(it[4].id, /:0$/); // vários blocos na mesma entrada → ids distintos
  assert.equal(it[6].pre, 5000);
  assert.equal(it[6].pos, 700);
  assert.equal(it[6].foco, 'só o backend');
  assert.equal(it[7].texto, '/compact só o backend');
  assert.equal(it[8].texto, 'Pergunta do colega');
  assert.equal(it[10].texto, 'API Error: 529 overloaded');
  assert.equal(it[11].texto, '/model opus');
  assert.ok(it.every((x) => x.id && typeof x.ts === 'number' && x.ts > 0));
  const tudo = JSON.stringify(it);
  for (const fora of ['subagente', 'continued from', 'Caveat', 'Compacted', 'meta qualquer', 'bbbb']) assert.ok(!tudo.includes(fora), `vazou: ${fora}`);
  // 404, 405 e parâmetros inválidos
  assert.equal((await get(rs('nao-existe', '/conversa'))).status, 404);
  assert.equal((await get(rs(s.id, '/conversa?antes=abc'))).status, 400);
  assert.equal((await get(rs(s.id, '/conversa?limite=0'))).status, 400);
  assert.equal((await post(rs(s.id, '/conversa'))).status, 405);
  assert.equal((await get(rs(s.id, '/assumir'))).status, 405);
});

test('conversa: carga do fim em blocos e cursor por offset até o começo (ferramenta casada entre páginas)', async () => {
  let linhas = '';
  const N = 700;
  for (let i = 0; i < N; i++) {
    if (i === N - 151) {
      linhas += a([{ type: 'tool_use', id: 'toolu_cruza', name: 'Grep', input: { pattern: 'abc' } }]);
      linhas += u([{ type: 'tool_result', tool_use_id: 'toolu_cruza', content: 'achou' }]);
      continue;
    }
    linhas += i % 2 ? a(`resposta ${i}`) : u(`pergunta ${i}`);
    if (i % 50 === 0) linhas += JSON.stringify({ type: 'api-request-blob', blob: 'z'.repeat(400 * 1024) }) + '\n';
  }
  const s = await criarSessao({ linhas });
  const paginas = [];
  let cursor = '';
  for (let n = 0; n < 20; n++) {
    const r = await get(rs(s.id, `/conversa?limite=150${cursor ? `&antes=${cursor}` : ''}`));
    assert.equal(r.status, 200);
    paginas.unshift(r.json.itens);
    if (!r.json.cursorAntigo) break;
    assert.equal(r.json.itens.length, 150);
    cursor = r.json.cursorAntigo;
  }
  const todos = paginas.flat();
  assert.equal(todos.length, N);
  assert.equal(new Set(todos.map((x) => x.id)).size, N);
  assert.equal(todos[0].texto, 'pergunta 0');
  assert.equal(todos.at(-1).texto, `resposta ${N - 1}`);
  const f = todos.find((x) => x.id === 'toolu_cruza');
  assert.equal(paginas.at(-2).includes(f), true, 'a ferramenta deveria estar na segunda página do fim');
  assert.deepEqual(f.resultado, { texto: 'achou', erro: false });
  // Sem antes: só o fim; linha incompleta no fim (sendo escrita) não entra.
  fs.appendFileSync(s.transcript, u('incompleta').slice(0, 40));
  const fim = await get(rs(s.id, '/conversa?limite=2'));
  assert.deepEqual(fim.json.itens.map((x) => x.texto), [`pergunta ${N - 2}`, `resposta ${N - 1}`]);
});

test('fluxo da conversa (SSE): itens novos, ferramenta reenviada com o mesmo id, linha partida, arquivo encolheu', async () => {
  const s = await criarSessao({ linhas: u('início') });
  const f = sse(rs(s.id, '/conversa/fluxo'));
  assert.equal(await f.pronto, 200);
  await espera(300);
  fs.appendFileSync(s.transcript, u('nova pergunta') + a([{ type: 'tool_use', id: 'toolu_vivo', name: 'Bash', input: { command: 'npm test' } }]));
  const e1 = await f.esperar((e) => e.tipo === 'itens' && e.dados.itens.some((x) => x.id === 'toolu_vivo'), 4000, 'itens');
  assert.deepEqual(e1.dados.itens.map((x) => x.tipo), ['usuario', 'ferramenta']);
  assert.equal(e1.dados.itens[1].resultado, undefined);
  const l = u([{ type: 'tool_result', tool_use_id: 'toolu_vivo', content: 'ok 12 testes' }]);
  fs.appendFileSync(s.transcript, l.slice(0, 30));
  await espera(400);
  fs.appendFileSync(s.transcript, l.slice(30));
  const e2 = await f.esperar((e) => e.tipo === 'itens' && e.dados.itens.some((x) => x.id === 'toolu_vivo' && x.resultado), 4000, 'resultado');
  assert.deepEqual(e2.dados.itens, [{ ...e1.dados.itens[1], resultado: { texto: 'ok 12 testes', erro: false } }]);
  assert.ok(!f.eventos.some((e) => e.tipo === 'itens' && e.dados.itens.some((x) => x.texto === 'início')), 'o fluxo começa no fim');
  fs.writeFileSync(s.transcript, u('reescrito'));
  const e3 = await f.esperar((e) => e.tipo === 'reinicio', 4000, 'reinicio');
  assert.deepEqual(e3.dados, { motivo: 'arquivo' });
  // ?desde= retoma de um offset conhecido (o cursorNovo do GET)
  const g = await get(rs(s.id, '/conversa'));
  fs.appendFileSync(s.transcript, a('depois do GET'));
  const f2 = sse(rs(s.id, `/conversa/fluxo?desde=${g.json.cursorNovo}`));
  const e4 = await f2.esperar((e) => e.tipo === 'itens', 4000, 'itens desde');
  assert.deepEqual(e4.dados.itens.map((x) => x.texto), ['depois do GET']);
  f.fechar();
  f2.fechar();
});

// ───────── canal ─────────

test('canal: auth com o .key, priority e session_id do alvo, sucesso só quando aparece no transcript; token nunca na API', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  const pipe = pipeFalso('tok-secreto-123', s.transcript, s.id);
  const vs = processoDoVsCode(s.id, { socket: pipe.caminho });
  const c = await esperarQue(async () => ((await controleDe(s.id))?.modo === 'canal' ? controleDe(s.id) : null), 4000, 'modo canal');
  assert.equal(c.pid, vs.pid);
  assert.equal(c.podeAssumir, true);
  assert.ok(!(await get('/estado')).texto.includes('tok-secreto-123'), 'o token vazou na API');

  const r = await post(rs(s.id, '/mensagem'), { texto: 'Faça o deploy', prioridade: 'now' });
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.via, 'canal');
  assert.equal(r.json.acao.tipo, 'mensagem');
  assert.equal(r.json.acao.estado, 'em_andamento');
  const fim = await acaoFinal(r.json.acao.id);
  assert.equal(fim.estado, 'sucesso', fim.erro);
  assert.deepEqual(pipe.recebidas[0], { type: 'user', message: { role: 'user', content: 'Faça o deploy' }, priority: 'now', session_id: s.id });
  const conv = await get(rs(s.id, '/conversa'));
  assert.deepEqual(conv.json.itens.at(-1).tipo, 'par');
  assert.equal(conv.json.itens.at(-1).texto, 'Faça o deploy');
  assert.ok(fluxo.eventos.some((e) => e.tipo === 'acao' && e.dados.id === r.json.acao.id && e.dados.etapa === 'Esperando a sessão confirmar'));

  // Sem eco no transcript → erro depois do prazo (aqui 1,5 s).
  pipe.gravar = false;
  const r2 = await post(rs(s.id, '/mensagem'), { texto: 'ninguém vai ver' });
  const f2 = await acaoFinal(r2.json.acao.id);
  assert.equal(f2.estado, 'erro');
  assert.equal(f2.erro, 'Não confirmada pela sessão.');
  assert.equal(pipe.recebidas.at(-1).priority, 'next');
  // Token errado → o pipe derruba; também acaba em erro.
  pipe.gravar = true;
  fs.writeFileSync(vs.arqKey, JSON.stringify({ peerToken: 'errado' }));
  const r3 = await post(rs(s.id, '/mensagem'), { texto: 'com token errado' });
  assert.equal((await acaoFinal(r3.json.acao.id)).estado, 'erro');
  assert.equal(pipe.authFalhou, 1);

  // Validação e 409 fora do modo orbit.
  assert.equal((await post(rs(s.id, '/mensagem'), { texto: '' })).status, 400);
  assert.equal((await post(rs(s.id, '/mensagem'), { texto: 'x'.repeat(20001) })).status, 400);
  assert.equal((await post(rs(s.id, '/mensagem'), { texto: 'x', prioridade: 'later' })).status, 400);
  assert.equal((await post(rs(s.id, '/mensagem'), { texto: 'x' }, { cabecalho: false })).status, 403);
  for (const [rota, corpo] of [['/compactar', {}], ['/limpar', { confirmar: true }], ['/devolver', {}]]) {
    const x = await post(rs(s.id, rota), corpo);
    assert.equal(x.status, 409, rota);
    assert.equal(x.json.codigo, 'nao_assumida', rota);
  }
  const acs = (await get(rs(s.id, '/acoes'))).json;
  assert.deepEqual(acs.map((x) => x.estado), ['sucesso', 'erro', 'erro']);
  vs.filho.kill();
});

test('assumir com o processo do VS Code: trabalhando → 409; pid/procStart que não confere → erro sem matar; idle → encerra e assume', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  const pipe = pipeFalso('tok', s.transcript, s.id);
  const vs = processoDoVsCode(s.id, { socket: pipe.caminho, token: 'tok', status: 'busy' });
  await esperarQue(async () => (await controleDe(s.id))?.motivo?.includes('trabalhando'), 4000, 'motivo trabalhando');
  const c = await controleDe(s.id);
  assert.equal(c.podeAssumir, false);
  const r1 = await post(rs(s.id, '/assumir'));
  assert.equal(r1.status, 409);
  assert.equal(r1.json.codigo, 'trabalhando');

  vs.mudar({ status: 'idle', procStart: '123456789' });
  await esperarQue(async () => (await controleDe(s.id))?.podeAssumir, 4000, 'pode assumir');
  const r2 = await post(rs(s.id, '/assumir'));
  assert.equal(r2.status, 202);
  const f2 = await acaoFinal(r2.json.acao.id, 20000);
  assert.equal(f2.estado, 'erro');
  assert.match(f2.erro, /não confere/);
  assert.ok(vivo(vs.pid), 'matou um processo que não conferia');

  vs.mudar({ status: 'idle' });
  const r3 = await post(rs(s.id, '/assumir'));
  assert.equal(r3.status, 202);
  const f3 = await acaoFinal(r3.json.acao.id, 20000);
  assert.equal(f3.estado, 'sucesso', f3.erro);
  assert.ok(!vivo(vs.pid), 'o processo antigo continua vivo');
  assert.ok(!fs.existsSync(vs.arqReg) && !fs.existsSync(vs.arqKey), 'registro do processo morto ficou');
  const etapas = fluxo.eventos.filter((e) => e.tipo === 'acao' && e.dados.id === r3.json.acao.id).map((e) => e.dados.etapa);
  assert.ok(etapas.includes('Encerrando o processo antigo') && etapas.includes('Iniciando no Orbit'), JSON.stringify(etapas));
  const c3 = await controleDe(s.id);
  assert.equal(c3.modo, 'orbit');
  assert.notEqual(c3.pid, vs.pid);
  assert.equal((await post(rs(s.id, '/devolver'))).status, 202);
  await esperarQue(async () => (await controleDe(s.id))?.modo !== 'orbit', 5000, 'devolvida');
});

// ───────── processo do Orbit ─────────

test('orbit: assumir → mensagem → permissão → compactar → limpar (segue o id novo) → devolver', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  let c = await controleDe(s.id);
  assert.equal(c.modo, 'nenhum');
  assert.equal(c.podeAssumir, true);
  assert.equal((await post(rs(s.id, '/mensagem'), { texto: 'x' })).json.codigo, 'nao_assumida');

  const r = await post(rs(s.id, '/assumir'));
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.tipo, 'assumir');
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  c = await controleDe(s.id);
  assert.equal(c.modo, 'orbit');
  assert.equal(c.podeAssumir, false);
  assert.equal(c.ocupada, false);
  assert.ok(c.pid > 0 && c.desde > 0);
  const execucao = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.pid === c.pid);
  for (const arg of ['-p', '--replay-user-messages', '--verbose']) assert.ok(execucao.argv.includes(arg), arg);
  const par = (n) => execucao.argv[execucao.argv.indexOf(n) + 1];
  assert.equal(par('--resume'), s.id);
  assert.equal(par('--permission-prompt-tool'), 'stdio');
  assert.equal(par('--input-format'), 'stream-json');
  assert.equal(par('--output-format'), 'stream-json');
  assert.equal(par('--model'), 'claude-teste-9');
  // Orientação de terminal (sem cd) só pelo processo do Orbit.
  assert.match(par('--append-system-prompt'), /Não comece comandos com cd/);
  assert.deepEqual(execucao.envClaude, []);
  assert.equal(path.resolve(execucao.cwd).toLowerCase(), path.resolve(s.cwd).toLowerCase());
  const ja = await post(rs(s.id, '/assumir'));
  assert.equal(ja.status, 409);
  assert.equal(ja.json.codigo, 'ja_assumida');

  const conversa = sse(rs(s.id, '/conversa/fluxo'));
  await conversa.pronto;
  await espera(200);
  const m = await post(rs(s.id, '/mensagem'), { texto: 'olá orbit' });
  assert.equal(m.json.acao.via, 'orbit');
  assert.equal((await acaoFinal(m.json.acao.id)).estado, 'sucesso');
  const e = await conversa.esperar((x) => x.tipo === 'itens' && x.dados.itens.some((i) => i.texto === 'Resposta: olá orbit'), 4000, 'resposta');
  assert.ok(conversa.eventos.flatMap((x) => x.dados?.itens || []).some((i) => i.tipo === 'usuario' && i.texto === 'olá orbit'));
  assert.ok(e);

  // Ocupada: compactar/limpar/devolver → 409; mensagem entra na fila.
  const lenta = await post(rs(s.id, '/mensagem'), { texto: 'DEMORA um pouco' });
  await esperarQue(async () => (await controleDe(s.id)).ocupada, 2000, 'ocupada');
  for (const [rota, corpo] of [['/compactar', {}], ['/limpar', { confirmar: true }], ['/devolver', {}]]) {
    const x = await post(rs(s.id, rota), corpo);
    assert.equal(x.status, 409, rota);
    assert.equal(x.json.codigo, 'ocupada', rota);
  }
  assert.equal((await acaoFinal(lenta.json.acao.id)).estado, 'sucesso');
  await esperarQue(async () => !(await controleDe(s.id)).ocupada, 3000, 'livre');

  // Permissão pelo protocolo de controle: pendente no controle, permitir e negar.
  for (const decisao of ['permitir', 'negar']) {
    const p = await post(rs(s.id, '/mensagem'), { texto: `PERMISSAO ${decisao}` });
    const pend = await esperarQue(async () => (await controleDe(s.id)).permissao, 4000, 'permissão pendente');
    assert.equal(pend.ferramenta, 'Write');
    assert.equal(pend.resumo, 'a.txt');
    assert.match(pend.entrada.file_path, /a\.txt$/);
    assert.equal((await post(rs(s.id, '/compactar'))).json.codigo, 'ocupada');
    assert.equal((await post(rs(s.id, '/permissao'), { id: 'outro', decisao })).status, 404);
    assert.equal((await post(rs(s.id, '/permissao'), { id: pend.id, decisao: 'talvez' })).status, 400);
    assert.equal((await post(rs(s.id, '/permissao'), { id: pend.id, decisao })).status, 200);
    assert.equal((await acaoFinal(p.json.acao.id)).estado, 'sucesso');
    const ferr = await conversa.esperar((x) => x.tipo === 'itens' && x.dados.itens.some((i) => i.tipo === 'ferramenta' && i.resultado && !conversa.vistas?.has(i.id)), 4000, 'resultado da ferramenta');
    const item = ferr.dados.itens.find((i) => i.tipo === 'ferramenta');
    (conversa.vistas ||= new Set()).add(item.id);
    assert.equal(item.resultado.erro, decisao === 'negar');
    await esperarQue(async () => !(await controleDe(s.id)).ocupada && !(await controleDe(s.id)).permissao, 3000, 'livre');
  }

  // Compactar com foco.
  assert.equal((await post(rs(s.id, '/compactar'), { foco: 'x'.repeat(501) })).status, 400);
  const k = await post(rs(s.id, '/compactar'), { foco: 'foco do teste' });
  assert.equal(k.status, 202);
  const kf = await acaoFinal(k.json.acao.id);
  assert.equal(kf.estado, 'sucesso', kf.erro);
  assert.deepEqual(kf.resultado, { pre: 29864, pos: 1146 });
  const comp = (await get(rs(s.id, '/conversa'))).json.itens.filter((i) => i.tipo === 'compactacao' || i.tipo === 'comando');
  assert.deepEqual(comp.map((i) => [i.tipo, i.foco || i.texto]), [['compactacao', 'foco do teste'], ['comando', '/compact foco do teste']]);
  assert.ok(fluxo.eventos.some((x) => x.tipo === 'acao' && x.dados.id === k.json.acao.id && x.dados.etapa === 'Compactando'));

  // Limpar: confirmação obrigatória; o controle e o fluxo passam para o id novo.
  assert.equal((await post(rs(s.id, '/limpar'), {})).status, 400);
  const l = await post(rs(s.id, '/limpar'), { confirmar: true });
  const lf = await acaoFinal(l.json.acao.id);
  assert.equal(lf.estado, 'sucesso', lf.erro);
  const novo = lf.resultado.novaSessao;
  assert.ok(novo && novo !== s.id);
  const re = await conversa.esperar((x) => x.tipo === 'reinicio', 3000, 'reinicio');
  assert.deepEqual(re.dados, { motivo: 'limpeza', novaSessao: novo });
  await conversa.esperar((x) => x.tipo === 'itens' && x.dados.itens.some((i) => i.tipo === 'limpeza'), 3000, 'item limpeza');
  assert.notEqual((await controleDe(s.id)).modo, 'orbit');
  const conv = await get(rs(novo, '/conversa'));
  assert.equal(conv.status, 200);
  assert.deepEqual(conv.json.itens.map((i) => i.tipo), ['limpeza']);
  const m2 = await post(rs(novo, '/mensagem'), { texto: 'depois do clear' });
  assert.equal((await acaoFinal(m2.json.acao.id)).estado, 'sucesso');
  await conversa.esperar((x) => x.tipo === 'itens' && x.dados.itens.some((i) => i.texto === 'Resposta: depois do clear'), 3000, 'resposta no id novo');

  // Devolver.
  const pid = (await esperarQue(async () => {
    const r = await post(rs(novo, '/devolver'));
    return r.status === 202 ? r : null;
  }, 3000, 'devolver')).json;
  const df = await acaoFinal(pid.acao.id);
  assert.equal(df.estado, 'sucesso', df.erro);
  assert.ok([404, 409].includes((await post(rs(novo, '/devolver'))).status)); // 409 se o servidor já viu o id novo pelo registro
  assert.equal((await post(rs(s.id, '/devolver'))).json.codigo, 'nao_assumida');
  const acs = (await get(rs(s.id, '/acoes'))).json;
  assert.deepEqual(acs.map((x) => x.tipo), ['assumir', 'mensagem', 'mensagem', 'mensagem', 'mensagem', 'compactar', 'limpar']);
  assert.ok(acs.every((x) => x.estado === 'sucesso' && x.fim >= x.inicio));
  conversa.fechar();
});

test('comandos com barra: lista do initialize, comando local entregue (sem eco) e a saída na conversa', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  assert.equal((await get(rs(s.id, '/comandos'))).status, 200);
  const r = await post(rs(s.id, '/assumir'));
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  const l = (await get(rs(s.id, '/comandos'))).json.comandos;
  assert.deepEqual(l.map((c) => c.nome), ['context', 'compact']); // "nome ruim" (com espaço) fica de fora
  assert.equal(l[1].args, '<optional custom summarization instructions>');
  assert.equal((await post(rs(s.id, '/comandos'))).status, 405);

  const conversa = sse(rs(s.id, '/conversa/fluxo'));
  await conversa.pronto;
  await espera(200);
  const m = await post(rs(s.id, '/mensagem'), { texto: '/context' });
  assert.equal((await acaoFinal(m.json.acao.id)).estado, 'sucesso'); // sem eco: confirma pelo result
  const itens = () => conversa.eventos.flatMap((x) => x.dados?.itens || []);
  await conversa.esperar(() => itens().some((i) => i.tipo === 'saida'), 4000, 'saída');
  assert.ok(itens().some((i) => i.tipo === 'comando' && i.texto === '/context'));
  const sai = itens().find((i) => i.tipo === 'saida');
  assert.equal(sai.texto, '## Context Usage\n\n**Tokens:** 1.2k / 1m (0%)');
  assert.ok(!itens().some((i) => i.tipo === 'usuario' && /local-command|Caveat/.test(i.texto)));
  // Na fila de uma volta: confirma no result depois do fim dela.
  const lenta = await post(rs(s.id, '/mensagem'), { texto: 'DEMORA um pouco' });
  await esperarQue(async () => (await controleDe(s.id)).ocupada, 2000, 'ocupada');
  const fila = await post(rs(s.id, '/mensagem'), { texto: '/usage' });
  assert.equal((await acaoFinal(lenta.json.acao.id)).estado, 'sucesso');
  assert.equal((await acaoFinal(fila.json.acao.id)).estado, 'sucesso');
  // A página: a saída também vem no GET.
  const g = (await get(rs(s.id, '/conversa'))).json.itens;
  assert.ok(g.some((i) => i.tipo === 'saida' && i.texto === 'Current session: 5% used'));
  conversa.fechar?.();
  await acaoFinal((await post(rs(s.id, '/devolver'))).json.acao.id);
});

test('Acao com erro: falha ao iniciar, sem resposta (timeout), compactação com erro, processo que morre, devolver à força', async () => {
  const s1 = await criarSessao({ linhas: u('oi') + a('olá'), modo: 'falha_inicio' });
  const r1 = await post(rs(s1.id, '/assumir'));
  const f1 = await acaoFinal(r1.json.acao.id);
  assert.equal(f1.estado, 'erro');
  assert.match(f1.erro, /^O Orbit não conseguiu retomar a sessão \(.*falha simulada/);
  assert.equal((await controleDe(s1.id)).modo, 'nenhum');

  const s2 = await criarSessao({ linhas: u('oi') + a('olá'), modo: 'mudo' });
  const r2 = await post(rs(s2.id, '/assumir'));
  const c2 = await esperarQue(async () => ((await controleDe(s2.id)).modo === 'orbit' ? controleDe(s2.id) : null), 3000, 'iniciando');
  assert.equal(c2.ocupada, true);
  assert.equal(c2.motivo, 'Iniciando no Orbit');
  assert.equal((await post(rs(s2.id, '/compactar'))).json.codigo, 'ocupada'); // ainda iniciando
  const f2 = await acaoFinal(r2.json.acao.id);
  assert.equal(f2.estado, 'erro');
  assert.match(f2.erro, /não respondeu a tempo/);
  await esperarQue(async () => (await controleDe(s2.id)).modo === 'nenhum', 3000, 'volta a nenhum');

  const s3 = await criarSessao({ linhas: u('oi') + a('olá'), modo: 'compact_erro,sem_eco' });
  assert.equal((await acaoFinal((await post(rs(s3.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  const k = await post(rs(s3.id, '/compactar'));
  const kf = await acaoFinal(k.json.acao.id);
  assert.equal(kf.estado, 'erro');
  assert.match(kf.erro, /^A compactação falhou: Error: falha simulada/);
  // O processo morre no meio de uma volta (sem eco, a mensagem só confirma no result): a ação falha e, desde a
  // etapa 4, a instância dorme com motivo 'saiu' e interrompida (antes: saía do modo orbit).
  const m = await post(rs(s3.id, '/mensagem'), { texto: 'DEMORA e morre' });
  await espera(300);
  process.kill((await controleDe(s3.id)).pid);
  const mf = await acaoFinal(m.json.acao.id);
  assert.equal(mf.estado, 'erro');
  assert.match(mf.erro, /O processo do Orbit terminou antes de concluir/);
  const c3 = await esperarQue(async () => {
    const x = await controleDe(s3.id);
    return x?.processo === 'dormindo' ? x : null;
  }, 3000, 'dormindo (saiu)');
  assert.deepEqual([c3.modo, c3.dormiu.motivo, c3.interrompida], ['orbit', 'saiu', true]);
  assert.equal((await acaoFinal((await post(rs(s3.id, '/devolver'))).json.acao.id)).estado, 'sucesso'); // assumida dormindo: larga
  assert.equal((await controleDe(s3.id)).modo, 'nenhum');

  const s4 = await criarSessao({ linhas: u('oi') + a('olá'), modo: 'ignora_eof' });
  assert.equal((await acaoFinal((await post(rs(s4.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  const pid4 = (await controleDe(s4.id)).pid;
  const d = await post(rs(s4.id, '/devolver'));
  const df = await acaoFinal(d.json.acao.id, 10000);
  assert.equal(df.estado, 'sucesso', df.erro);
  assert.ok(fluxo.eventos.some((x) => x.tipo === 'acao' && x.dados.id === d.json.acao.id && x.dados.etapa === 'Encerrando à força'));
  assert.ok(!vivo(pid4));

  const s5 = await criarSessao({ semTranscript: true });
  const r5 = await post(rs(s5.id, '/assumir'));
  assert.equal(r5.status, 409);
  assert.equal(r5.json.codigo, 'sem_transcript');
  assert.equal((await controleDe(s5.id)).podeAssumir, false);
  assert.equal((await get(rs(s5.id, '/conversa'))).json.cursorAntigo, null);
});

// ───────── rodada 6: uso do plano pelo stream ─────────

test('uso do plano pelo stream: rate_limit_event → GET /uso e SSE uso com 32% e 56%; janela sem utilization não vai', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá'), modo: 'rate_limit' });
  assert.equal((await acaoFinal((await post(rs(s.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  const m = await post(rs(s.id, '/mensagem'), { texto: 'gasta a API' });
  assert.equal((await acaoFinal(m.json.acao.id)).estado, 'sucesso');
  const ev = await fluxo.esperar((e) => e.tipo === 'uso' && e.dados?.cincoHoras?.pct === 32, 4000, 'SSE uso');
  assert.deepEqual(ev.dados.cincoHoras, { pct: 32, renova: 1792067400 * 1000 });
  assert.deepEqual(ev.dados.semanal, { pct: 56, renova: 1792062000 * 1000 });
  assert.ok(ev.dados.atualizado > 0);
  const r = await get('/uso');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.cincoHoras, r.json.semanal], [ev.dados.cincoHoras, ev.dados.semanal]);
  await esperarQue(async () => !(await controleDe(s.id)).ocupada, 3000, 'livre'); // etapa 3: o eco chega antes do fim da volta
  assert.equal((await acaoFinal((await post(rs(s.id, '/devolver'))).json.acao.id)).estado, 'sucesso');

  // seven_day sem utilization: só a janela de 5 h vai (a semanal fica sem leitura).
  const s2 = await criarSessao({ linhas: u('oi') + a('olá'), modo: 'rate_limit_parcial' });
  assert.equal((await acaoFinal((await post(rs(s2.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  const m2 = await post(rs(s2.id, '/mensagem'), { texto: 'gasta de novo' });
  assert.equal((await acaoFinal(m2.json.acao.id)).estado, 'sucesso');
  const ev2 = await fluxo.esperar((e) => e.tipo === 'uso' && e.dados?.cincoHoras?.pct === 32 && e.dados.semanal === null, 4000, 'SSE uso parcial');
  assert.deepEqual(ev2.dados.cincoHoras, { pct: 32, renova: 1792067400 * 1000 });
  assert.equal((await get('/uso')).json.semanal, null);
  await esperarQue(async () => !(await controleDe(s2.id)).ocupada, 3000, 'livre');
  assert.equal((await acaoFinal((await post(rs(s2.id, '/devolver'))).json.acao.id)).estado, 'sucesso');
});

// ───────── rodada 6: motor de instâncias ─────────

test('reinício do servidor no meio de uma volta lenta: a sessão segue orbit (adotada), a volta termina e ocupada volta a false', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  assert.equal((await acaoFinal((await post(rs(s.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  const pid = (await controleDe(s.id)).pid;
  assert.ok(motorDoTeste()?.pid > 0, 'o lançamento não passou pelo motor');
  const m = await post(rs(s.id, '/mensagem'), { texto: 'DEMORA:4000 durante o reinício' });
  assert.equal(m.status, 202);
  await esperarQue(async () => (await controleDe(s.id)).ocupada, 2000, 'ocupada');

  await reiniciar();
  assert.ok(vivo(pid), 'o processo morreu com o servidor');
  const c = await esperarQue(async () => {
    const x = await controleDe(s.id);
    // Antes da adoção a sessão já é orbit ("Retomando o controle", sem pid); adotada, tem o pid do processo.
    return x?.modo === 'orbit' && x.pid ? x : null;
  }, 4000, 'adotada em modo orbit');
  assert.equal(c.pid, pid);
  assert.equal(c.ocupada, true, 'ocupada não foi reconstruída');
  assert.equal(c.podeAssumir, false);
  assert.equal((await post(rs(s.id, '/compactar'))).json.codigo, 'ocupada');
  await esperarQue(async () => (await controleDe(s.id)).ocupada === false, 8000, 'fim da volta depois do reinício');
  assert.ok((await get(rs(s.id, '/conversa'))).json.itens.some((i) => i.texto === 'Resposta: DEMORA:4000 durante o reinício'));
  assert.deepEqual((await get(rs(s.id, '/acoes'))).json, []); // a Acao de antes do reinício se perde (documentado)
  assert.match(fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8'), /adotada a sessão/);

  // Um segundo servidor na mesma pasta (corrida do hook) sai pela porta ocupada sem tomar o motor.
  const outro = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: 'ignore' });
  await esperarQue(async () => outro.exitCode != null, 8000, 'segundo servidor saiu');
  await espera(300);
  assert.ok(!fs.readFileSync(path.join(DADOS, 'logs', 'motor.log'), 'utf8').includes('cliente substituído'), 'o segundo servidor tomou o motor');

  // Adotada: mensagem, compactar e devolver seguem pelo motor.
  const m2 = await post(rs(s.id, '/mensagem'), { texto: 'depois do reinício' });
  assert.equal((await acaoFinal(m2.json.acao.id)).estado, 'sucesso');
  await esperarQue(async () => !(await controleDe(s.id)).ocupada, 3000, 'livre');
  const k = await post(rs(s.id, '/compactar'), { foco: 'pós reinício' });
  const kf = await acaoFinal(k.json.acao.id);
  assert.equal(kf.estado, 'sucesso', kf.erro);
  const d = await post(rs(s.id, '/devolver'));
  assert.equal((await acaoFinal(d.json.acao.id)).estado, 'sucesso');
  assert.ok(!vivo(pid), 'o devolver não fechou o processo');
  await esperarQue(async () => (await controleDe(s.id)).modo !== 'orbit', 3000, 'devolvida');
});

test('permissão pendente antes do reinício (servidor derrubado à força) pode ser respondida depois', async () => {
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  assert.equal((await acaoFinal((await post(rs(s.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  const pid = (await controleDe(s.id)).pid;
  await post(rs(s.id, '/mensagem'), { texto: 'PERMISSAO no reinício' });
  const pend = await esperarQue(async () => (await controleDe(s.id)).permissao, 4000, 'permissão pendente');
  await espera(700); // o estado.json grava 500 ms depois da mudança; derrubado à força, não grava no fim

  await reiniciar({ duro: true });
  assert.ok(vivo(pid), 'o processo morreu com o servidor');
  const c = await esperarQue(async () => {
    const x = await controleDe(s.id);
    return x?.modo === 'orbit' && x.permissao ? x : null;
  }, 4000, 'adotada com a permissão pendente');
  assert.equal(c.pid, pid);
  assert.equal(c.ocupada, true);
  assert.deepEqual(c.permissao, pend);
  assert.equal((await post(rs(s.id, '/permissao'), { id: pend.id, decisao: 'permitir' })).status, 200);
  await esperarQue(async () => {
    const x = await controleDe(s.id);
    return !x.ocupada && !x.permissao;
  }, 4000, 'livre depois da permissão');
  const ferr = (await get(rs(s.id, '/conversa'))).json.itens.filter((i) => i.tipo === 'ferramenta');
  assert.deepEqual(ferr.at(-1).resultado, { texto: 'File created successfully', erro: false });
  const d = await post(rs(s.id, '/devolver'));
  assert.equal((await acaoFinal(d.json.acao.id)).estado, 'sucesso');
  assert.ok(!vivo(pid));
});

// ───────── rodada 6, etapa 2: instância nova, modelo e esforço ─────────

const execucoes = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const argDe = (argv, n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const pastaNova = (nome) => {
  const cwd = path.join(DADOS, 'cwd', nome);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
};
// Pasta do transcript da sessão nova (a mesma regra do claude: o que não é letra ou dígito vira "-").
const projetoDe = (cwd) => path.join(PROJETOS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const acaoDoTipo = (sessao, tipo, ms = 8000) =>
  fluxo.esperar((e) => e.tipo === 'acao' && e.dados.sessao === sessao && e.dados.tipo === tipo && e.dados.estado !== 'em_andamento', ms, `ação ${tipo}`).then((e) => e.dados);
const sessaoDe = async (id) => (await get(rs(id))).json?.sessao;

test('modelos: GET /modelos pela sonda (initialize sem hooks, sem transcript), em modelos.json; a sonda nunca vira sessão', async () => {
  // A sonda do servidor atual (a do anterior não vale: o filtro do registro é por processo do servidor).
  const pidServ = (await get('/saude')).json.pid;
  const lidos = new RegExp(`\\s${pidServ} modelos \\d+ modelos lidos`);
  await esperarQue(async () => lidos.test(fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8')), 6000, 'sonda do servidor atual');
  const r = await esperarQue(async () => {
    const x = await get('/modelos');
    return x.status === 200 ? x : null;
  }, 6000, 'GET /modelos 200');
  const ms = r.json.modelos;
  assert.ok(r.json.atualizado > 0);
  assert.deepEqual(ms.find((m) => m.valor === 'haiku'), { valor: 'haiku', modelo: 'claude-falso-haiku-5', nome: 'Haiku Falso 5', descricao: 'Rápido', esforcos: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(ms.find((m) => m.valor === 'claude-haiku-4-5-20251001').esforcos, []);
  assert.deepEqual(ms.find((m) => m.valor === 'claude-velho-4-6').esforcos, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DADOS, 'modelos.json'), 'utf8')).modelos, ms);
  const sonda = execucoes().filter((e) => e.argv.includes('--no-session-persistence')).at(-1); // a do servidor atual
  assert.ok(sonda, 'a sonda não rodou');
  assert.equal(argDe(sonda.argv, '--settings'), JSON.stringify({ disableAllHooks: true }));
  assert.ok(!sonda.argv.includes('--resume'));
  assert.ok(!sonda.argv.includes('--append-system-prompt'), 'a sonda de modelos não leva a orientação');
  assert.deepEqual(sonda.envClaude, []);
  // O registro com a sessionId da sonda (processo vivo) é ignorado; outro registro qualquer entra.
  const sid = argDe(sonda.argv, '--session-id');
  assert.match(sid, /^[0-9a-f-]{36}$/);
  processoDoVsCode(sid);
  const outro = uuid();
  processoDoVsCode(outro);
  await esperarQue(async () => (await get(rs(outro))).status === 200, 3000, 'registro comum vira sessão');
  await espera(600);
  assert.equal((await get(rs(sid))).status, 404, 'a sonda virou sessão');
  assert.ok(!(await get('/estado')).json.sessoes.some((s) => s.id === sid));
  assert.equal((await post('/remover', { id: outro })).status, 200);

  // Sessao.modelo/esforco para todas: da última resposta, pulando <synthetic>; effort ausente = sem esforço.
  const synth = linha({ type: 'assistant', uuid: uuid(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } });
  const s = await criarSessao({ linhas: u('oi') + a('olá', { effort: 'xhigh' }) + synth });
  const v = await esperarQue(async () => ((await sessaoDe(s.id))?.modelo ? sessaoDe(s.id) : null), 3000, 's.modelo');
  assert.equal(v.modelo, 'claude-teste-9');
  assert.equal(v.esforco, 'xhigh');
  assert.equal(v.origem, undefined); // origem só nas criadas pelo Orbit
  fs.appendFileSync(s.transcript, linha({ type: 'assistant', uuid: uuid(), message: { model: 'claude-haiku-4-5-20251001', role: 'assistant', content: [{ type: 'text', text: 'sem esforço' }] } }));
  const v2 = await esperarQue(async () => {
    const x = await sessaoDe(s.id);
    return x.modelo === 'claude-haiku-4-5-20251001' ? x : null;
  }, 3000, 's.modelo trocado');
  assert.equal(v2.esforco, undefined);
  // Sessão só do registro (sem hooks): o transcript é achado na pasta de projetos e vale igual.
  const id3 = uuid();
  fs.mkdirSync(path.join(PROJETOS, 'soregistro'), { recursive: true });
  fs.writeFileSync(path.join(PROJETOS, 'soregistro', `${id3}.jsonl`), u('oi') + a('olá', { effort: 'low' }));
  processoDoVsCode(id3);
  const v3 = await esperarQue(async () => ((await sessaoDe(id3))?.modelo ? sessaoDe(id3) : null), 4000, 's.modelo da sessão só do registro');
  assert.deepEqual([v3.modelo, v3.esforco], ['claude-teste-9', 'low']);
});

test('POST /instancias: validação (pasta, modelo, esforço); nasce nova/orbit/origem/apelido; criar → 1ª mensagem → título; config', async () => {
  const pasta = pastaNova('nova1');
  const arq = path.join(DADOS, 'um-arquivo.txt');
  fs.writeFileSync(arq, 'x');
  const ruins = [
    [{}, /pasta/],
    [{ pasta: 'relativa\\x' }, /caminho completo da pasta/],
    [{ pasta: path.join(DADOS, 'nao-existe') }, /pasta .* não existe/],
    [{ pasta: arq }, /não é uma pasta/],
    [{ pasta, modelo: 'nao-existe' }, /Modelo desconhecido/],
    [{ pasta, modelo: 'claude-velho-4-6', esforco: 'xhigh' }, /esforço "xhigh"\. Use: low, medium, high, max/],
    [{ pasta, modelo: 'claude-haiku-4-5-20251001', esforco: 'low' }, /Haiku 4\.5 não tem nível de esforço/],
    [{ pasta, esforco: 'turbo' }, /não aceita o esforço "turbo"/],
    [{ pasta, permissao: 'bypassPermissions' }, /permissão inválido/],
    [{ pasta, nome: 'n'.repeat(61) }, /nome pode ter até 60/],
  ];
  for (const [corpo, re] of ruins) {
    const r = await post('/instancias', corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.match(r.json.erro, re);
  }
  // Etapa 4: GET /instancias é o resumo do ciclo de vida (era 405).
  assert.deepEqual(Object.keys((await get('/instancias')).json).sort(), ['dormindo', 'dormirApos', 'max', 'memoria', 'vivas']);

  const texto = 'Explique o jsonl SINTETICO';
  const r = await post('/instancias', { pasta, modelo: 'haiku', esforco: 'low', permissao: 'plan', nome: 'Minha instância', texto });
  assert.equal(r.status, 202);
  const id = r.json.sessao;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(r.json.acao.tipo, 'criar');
  assert.equal(r.json.acao.etapa, 'Iniciando');
  const conversa = sse(rs(id, '/conversa/fluxo'));
  await conversa.pronto;
  const c0 = await get(rs(id, '/conversa')); // sem transcript ainda: vazio, nunca 404
  assert.equal(c0.status, 200);
  assert.deepEqual([c0.json.itens, c0.json.cursorAntigo], [[], null]);
  const ev = (await fluxo.esperar((e) => e.tipo === 'sessao' && e.dados.id === id, 3000, 'sessão nova no /fluxo')).dados;
  assert.equal(ev.status, 'nova');
  assert.equal(ev.origem, 'orbit');
  assert.equal(ev.apelido, 'Minha instância');
  assert.equal(ev.cwd, pasta);
  assert.equal(ev.controle.modo, 'orbit');
  assert.match(ev.controle.motivo, /Iniciando/);
  assert.deepEqual([ev.controle.modelo, ev.controle.esforco, ev.controle.modoPermissao], ['haiku', 'low', 'plan']);

  const criar = await acaoFinal(r.json.acao.id);
  assert.equal(criar.estado, 'sucesso', criar.erro);
  const msg = await acaoDoTipo(id, 'mensagem');
  assert.equal(msg.estado, 'sucesso', msg.erro);
  const exec = execucoes().find((e) => argDe(e.argv, '--session-id') === id);
  assert.ok(exec && !exec.argv.includes('--resume') && !exec.argv.includes('--no-session-persistence'));
  assert.deepEqual([argDe(exec.argv, '--model'), argDe(exec.argv, '--effort'), argDe(exec.argv, '--permission-mode')], ['haiku', 'low', 'plan']);
  assert.match(argDe(exec.argv, '--append-system-prompt'), /Não comece comandos com cd/);
  assert.equal(exec.cwd, pasta);
  // O SSE da conversa entrega o 1º pedido quando o arquivo aparece.
  await conversa.esperar((e) => e.tipo === 'itens' && e.dados.itens.some((i) => i.tipo === 'usuario' && i.texto === texto), 5000, 'pedido no SSE da conversa');
  conversa.fechar();
  // Título (generate_session_title → ai-title) e modelo/esforço da última resposta, sem o <synthetic>.
  const s = await esperarQue(async () => {
    const x = await sessaoDe(id);
    return x?.titulo && x.modelo ? x : null;
  }, 5000, 'título e modelo');
  assert.equal(s.titulo, `Título: ${texto}`);
  assert.deepEqual([s.modelo, s.esforco], ['claude-falso-haiku-5', 'low']);
  assert.ok(fs.readFileSync(path.join(projetoDe(pasta), `${id}.jsonl`), 'utf8').includes('"type":"ai-title"'));
  assert.deepEqual((await get('/config')).json.novaInstancia, { pasta, modelo: 'haiku', esforco: 'low', permissao: 'plan' });
  assert.equal((await acaoFinal((await post(rs(id, '/devolver'))).json.acao.id)).estado, 'sucesso');
});

test('modelo e esforço ao vivo (efetivo por get_settings), validação, 409, título por rename_session, adoção com os ajustes; falha ao criar', async () => {
  const pasta = pastaNova('nova2');
  fs.mkdirSync(projetoDe(pasta), { recursive: true });
  fs.writeFileSync(path.join(projetoDe(pasta), 'falso-modo.txt'), 'sem_titulo');
  const r = await post('/instancias', { pasta });
  assert.equal(r.status, 202);
  const id = r.json.sessao;
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  // Sem modelo escolhido: o efetivo vem do get_settings (o padrão do claude-falso: default/high).
  // Sem modo no pedido: o config.instancias.modoPadrao (padrão auto, 16/10).
  let c = await esperarQue(async () => {
    const x = await controleDe(id);
    return x?.esforco ? x : null;
  }, 3000, 'ajustes efetivos');
  assert.deepEqual([c.modelo, c.esforco, c.modoPermissao], ['default', 'high', 'auto']);
  assert.equal(argDe(execucoes().find((e) => argDe(e.argv, '--session-id') === id).argv, '--permission-mode'), 'auto');
  // config.instancias.modoPadrao: só os modos oferecidos; o dormirApos fica.
  assert.equal((await get('/config')).json.instancias.modoPadrao, 'auto');
  await post('/config', { instancias: { modoPadrao: 'bypassPermissions' } });
  assert.equal((await get('/config')).json.instancias.modoPadrao, 'auto');
  await post('/config', { instancias: { modoPadrao: 'plan' } });
  const { autoCompactar, ...inst } = (await get('/config')).json.instancias; // 20/10: compactação automática (autocompactar.test)
  assert.deepEqual(inst, { dormirApos: 30, modoPadrao: 'plan' });
  assert.equal(autoCompactar.limite, 140000);
  await post('/config', { instancias: { modoPadrao: 'auto' } });

  const esf = (e) => post(rs(id, '/esforco'), { esforco: e });
  const mod = (m) => post(rs(id, '/modelo'), { modelo: m });
  assert.match((await esf('turbo')).json.erro, /não aceita o esforço "turbo"/);
  assert.deepEqual((await esf('max')).json, { modelo: 'default', esforco: 'max' });
  assert.equal((await mod('nao-existe')).status, 400);
  assert.deepEqual((await mod('claude-velho-4-6')).json, { modelo: 'claude-velho-4-6', esforco: 'max' });
  const x1 = await esf('xhigh');
  assert.equal(x1.status, 400);
  assert.match(x1.json.erro, /Velho 4\.6 não aceita o esforço "xhigh"/);
  assert.deepEqual((await mod('claude-haiku-4-5-20251001')).json, { modelo: 'claude-haiku-4-5-20251001', esforco: null });
  assert.match((await esf('low')).json.erro, /Haiku 4\.5 não tem nível de esforço/);
  // Pelo id resolvido também vale; volta o valor.
  assert.deepEqual((await mod('claude-falso-haiku-5')).json, { modelo: 'haiku', esforco: 'max' });
  c = await controleDe(id);
  assert.deepEqual([c.modelo, c.esforco], ['haiku', 'max']);

  // A próxima resposta sai com o modelo e o esforço novos; o título cai no rename_session (1º pedido).
  const m = await post(rs(id, '/mensagem'), { texto: 'primeiro pedido   da instância' });
  assert.equal((await acaoFinal(m.json.acao.id)).estado, 'sucesso');
  const s = await esperarQue(async () => {
    const x = await sessaoDe(id);
    return x?.titulo && x.modelo ? x : null;
  }, 5000, 'título e modelo');
  assert.equal(s.titulo, 'primeiro pedido da instância');
  assert.deepEqual([s.modelo, s.esforco], ['claude-falso-haiku-5', 'max']);
  assert.match(fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8'), /generate_session_title falhou/);

  // Fora do Orbit: 409 nao_assumida.
  const fora = await criarSessao({ linhas: u('oi') + a('olá') });
  const f = await post(rs(fora.id, '/modelo'), { modelo: 'haiku' });
  assert.equal(f.status, 409);
  assert.equal(f.json.codigo, 'nao_assumida');

  // Reinício: adotada com os ajustes; a origem segue na sessão (estado.json).
  await espera(700);
  await reiniciar();
  c = await esperarQue(async () => {
    const x = await controleDe(id);
    return x?.modo === 'orbit' && x.pid ? x : null; // adotada (antes da adoção: orbit sem pid)
  }, 4000, 'adotada');
  assert.deepEqual([c.modelo, c.esforco, c.modoPermissao], ['haiku', 'max', 'auto']);
  assert.equal((await sessaoDe(id)).origem, 'orbit');
  assert.deepEqual((await esf('low')).json, { modelo: 'haiku', esforco: 'low' });
  assert.equal((await acaoFinal((await post(rs(id, '/devolver'))).json.acao.id)).estado, 'sucesso');

  // Falha ao iniciar: a Acao criar vira erro com o motivo.
  const pasta3 = pastaNova('nova3');
  fs.mkdirSync(projetoDe(pasta3), { recursive: true });
  fs.writeFileSync(path.join(projetoDe(pasta3), 'falso-modo.txt'), 'falha_inicio');
  const r3 = await post('/instancias', { pasta: pasta3, texto: 'não chega' });
  const f3 = await acaoFinal(r3.json.acao.id);
  assert.equal(f3.estado, 'erro');
  assert.match(f3.erro, /não conseguiu iniciar a instância/);
  await esperarQue(async () => (await controleDe(r3.json.sessao))?.modo !== 'orbit', 3000, 'fora do orbit');
});

// ───────── rodada 6, etapa 3: conversa completa ─────────

// Instância nova do Orbit, pronta (Acao criar com sucesso).
// Resposta binária (GET /imagem).
function bruto(rota) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORTA, path: rota, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, tipo: res.headers['content-type'], nosniff: res.headers['x-content-type-options'], buf: Buffer.concat(partes) }));
    }).on('error', reject);
  });
}

test('imagens (16/10): 1ª mensagem e mensagem com blocos image no stdin, validação, histórico com referências, GET /imagem; fora do Orbit → 409', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = { tipo: 'image/png', dados: png.toString('base64') };
  const pasta = pastaNova('imagens1');
  const ruins = [
    ['x', /lista/],
    [[{ tipo: 'image/svg+xml', dados: img.dados }], /formato não aceito/],
    [[{ tipo: 'image/png', dados: 'isso não é base64!' }], /dados inválidos/],
    [Array(11).fill(img), /até 10 imagens/],
    [[{ tipo: 'image/png', dados: 'A'.repeat(5 * 1024 * 1024 + 4) }], /passa de 5 MB/],
  ];
  for (const [imagens, re] of ruins) {
    const r = await post('/instancias', { pasta, imagens });
    assert.equal(r.status, 400, String(re));
    assert.match(r.json.erro, re);
  }

  // 1ª mensagem só com a imagem.
  const r = await post('/instancias', { pasta, imagens: [img] });
  assert.equal(r.status, 202, r.texto);
  const id = r.json.sessao;
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  const m1 = await acaoDoTipo(id, 'mensagem');
  assert.equal(m1.estado, 'sucesso', m1.erro);
  // Texto + 2 imagens; e uma imagem acima dos 256 KB do corpo padrão.
  const m2 = await post(rs(id, '/mensagem'), { texto: 'o que tem aqui?', imagens: [img, { tipo: 'image/jpeg', dados: img.dados }] });
  assert.equal(m2.status, 202, m2.texto);
  assert.equal((await acaoFinal(m2.json.acao.id)).estado, 'sucesso');
  const grande = { tipo: 'image/webp', dados: Buffer.alloc(600 * 1024, 7).toString('base64') };
  const m3 = await post(rs(id, '/mensagem'), { texto: 'grande', imagens: [grande] });
  assert.equal(m3.status, 202, m3.texto);
  assert.equal((await acaoFinal(m3.json.acao.id)).estado, 'sucesso');
  assert.equal((await post(rs(id, '/mensagem'), { texto: '  ', imagens: [] })).status, 400);

  // No stdin (e no transcript): os blocos image antes do texto, como a API espera.
  const users = fs.readFileSync(path.join(projetoDe(pasta), `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'image'));
  assert.deepEqual(users.map((e) => e.message.content.map((b) => b.type === 'image' ? b.source.media_type : b.text)),
    [['image/png'], ['image/png', 'image/jpeg', 'o que tem aqui?'], ['image/webp', 'grande']]);

  // Histórico: referências {o, i, tipo}, sem o base64; GET /imagem devolve os bytes com o tipo.
  const c = await get(rs(id, '/conversa'));
  assert.ok(!c.texto.includes(img.dados), 'o base64 não vai na conversa');
  const us = c.json.itens.filter((i) => i.tipo === 'usuario');
  assert.deepEqual(us.map((i) => [i.texto, (i.imagens || []).map((x) => x.tipo)]),
    [['', ['image/png']], ['o que tem aqui?', ['image/png', 'image/jpeg']], ['grande', ['image/webp']]]);
  const ref = us[1].imagens[1];
  const b = await bruto(rs(id, `/imagem?o=${ref.o}&i=${ref.i}`));
  assert.deepEqual([b.status, b.tipo, b.nosniff], [200, 'image/jpeg', 'nosniff']);
  assert.ok(b.buf.equals(png));
  const g = await bruto(rs(id, `/imagem?o=${us[2].imagens[0].o}&i=0`));
  assert.equal(g.buf.length, 600 * 1024);
  assert.equal((await bruto(rs(id, `/imagem?o=${ref.o + 1}&i=0`))).status, 404); // não é começo de linha
  assert.equal((await bruto(rs(id, `/imagem?o=${ref.o}&i=2`))).status, 404); // bloco de texto
  assert.equal((await bruto(rs(id, '/imagem?o=abc&i=0'))).status, 400);
  assert.equal((await bruto(rs(id, '/imagem?i=0'))).status, 400);
  assert.equal((await acaoFinal((await post(rs(id, '/devolver'))).json.acao.id)).estado, 'sucesso');

  // Sessão fora do Orbit (canal ou nenhum): imagens → 409, com o caminho de assumir.
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  const fora = await post(rs(s.id, '/mensagem'), { texto: 'veja', imagens: [img] });
  assert.deepEqual([fora.status, fora.json.codigo], [409, 'nao_assumida']);
  assert.match(fora.json.erro, /Imagens só vão para sessões no Orbit/);
});

async function instanciaPronta(nome) {
  const r = await post('/instancias', { pasta: pastaNova(nome) });
  assert.equal(r.status, 202);
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  return r.json.sessao;
}
// Pedido pendente com outro id que não o anterior (a fila anda).
const pedidoNovo = (id, antes = null) => esperarQue(async () => {
  const c = await controleDe(id);
  return c?.permissao && c.permissao.id !== antes ? c : null;
}, 4000, 'pedido pendente');
const livre = (id, ms = 4000) => esperarQue(async () => {
  const c = await controleDe(id);
  return c && !c.ocupada && !c.permissao ? c : null;
}, ms, 'sessão livre');
// tool_result mais recente do transcript da sessão.
function ultimoResultado(id) {
  const arq = fs.readdirSync(PROJETOS).map((d) => path.join(PROJETOS, d, `${id}.jsonl`)).find((c) => fs.existsSync(c));
  const rs = fs.readFileSync(arq, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((b) => b.type === 'tool_result');
  return rs.pop();
}

test('etapa 3: pedidos tipados (ferramenta com sugestões, pergunta com múltipla, plano), negar com mensagem, modo, tarefas e contexto', async () => {
  const id = await instanciaPronta('e3-pedidos');
  const exec = execucoes().find((e) => argDe(e.argv, '--session-id') === id);
  assert.ok(exec.argv.includes('--include-partial-messages'));

  // Ferramenta: sugestões em pt-BR (indice = posição na lista crua), sugestão inexistente → 400, aceitar edições.
  await post(rs(id, '/mensagem'), { texto: 'PERMISSAO com sugestão' });
  let c = await pedidoNovo(id);
  assert.equal(c.permissao.tipo, 'ferramenta');
  assert.equal(c.pendentes, 1);
  assert.equal(c.ocupada, true);
  assert.deepEqual(c.permissao.sugestoes, [
    { indice: 0, rotulo: 'Permitir sempre Write(a.txt) nesta sessão' },
    { indice: 1, rotulo: 'Permitir e aceitar edições nesta sessão', modo: 'acceptEdits' },
  ]);
  assert.equal((await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'permitir', sugestao: 7 })).status, 400);
  assert.equal((await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'permitir', sugestao: 1 })).status, 200);
  await livre(id);
  assert.match(ultimoResultado(id).content, /updatedPermissions=\[\{"type":"setMode","mode":"acceptEdits","destination":"session"\}\]/);
  assert.equal((await controleDe(id)).modoPermissao, 'acceptEdits');

  // Negar com mensagem: deny com o texto; mensagem longa demais → 400.
  await post(rs(id, '/mensagem'), { texto: 'PERMISSAO negar' });
  c = await pedidoNovo(id);
  assert.equal((await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'negar', mensagem: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'negar', mensagem: 'Não crie esse arquivo.' })).status, 200);
  await livre(id);
  assert.deepEqual([ultimoResultado(id).content, ultimoResultado(id).is_error], ['Não crie esse arquivo.', true]);

  // Modo: set_permission_mode; bypassPermissions não é oferecido; fora do Orbit → 409.
  assert.equal((await post(rs(id, '/modo'), { modo: 'bypassPermissions' })).status, 400);
  assert.deepEqual((await post(rs(id, '/modo'), { modo: 'plan' })).json, { modo: 'plan' });
  assert.equal((await controleDe(id)).modoPermissao, 'plan');
  assert.deepEqual((await post(rs(id, '/modo'), { modo: 'auto' })).json, { modo: 'auto' });
  assert.equal((await controleDe(id)).modoPermissao, 'auto');
  assert.deepEqual((await post(rs(id, '/modo'), { modo: 'plan' })).json, { modo: 'plan' });
  const fora =await criarSessao({ linhas: u('oi') + a('olá') });
  assert.equal((await post(rs(fora.id, '/modo'), { modo: 'plan' })).json.codigo, 'nao_assumida');

  // Plano: texto do plano, "Aprovar e aceitar edições" acrescentada; continuar planejando com comentário; aprovar.
  await post(rs(id, '/mensagem'), { texto: 'PLANO um' });
  c = await pedidoNovo(id);
  assert.equal(c.permissao.tipo, 'plano');
  assert.equal(c.permissao.plano, '# Plano\n\n1. Ler\n2. Escrever');
  assert.deepEqual(c.permissao.sugestoes, [{ indice: 0, rotulo: 'Aprovar e aceitar edições nesta sessão', modo: 'acceptEdits' }]);
  await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'negar', mensagem: 'Inclua testes.' });
  await livre(id);
  assert.equal(ultimoResultado(id).content, 'Inclua testes.');
  assert.equal((await controleDe(id)).modoPermissao, 'plan');
  await post(rs(id, '/mensagem'), { texto: 'PLANO dois' });
  c = await pedidoNovo(id);
  await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'permitir' });
  await livre(id);
  assert.equal(ultimoResultado(id).content, 'User has approved your plan');
  await esperarQue(async () => (await controleDe(id)).modoPermissao === 'default', 3000, 'modo default depois do plano');

  // Pergunta: perguntas normalizadas; respostas obrigatórias; múltipla como texto "A, B"; chave estranha fora.
  await post(rs(id, '/mensagem'), { texto: 'PERGUNTA um' });
  c = await pedidoNovo(id);
  assert.equal(c.permissao.tipo, 'pergunta');
  assert.deepEqual(c.permissao.perguntas[1], { pergunta: 'Quais frutas?', cabecalho: 'Frutas', multipla: true, opcoes: [{ rotulo: 'Maçã', descricao: '' }, { rotulo: 'Uva', descricao: 'roxa' }, { rotulo: 'Pera', descricao: '' }] });
  const pid = c.permissao.id;
  assert.equal((await post(rs(id, '/permissao'), { id: pid, decisao: 'permitir' })).status, 400);
  assert.match((await post(rs(id, '/permissao'), { id: pid, decisao: 'permitir', respostas: { 'Qual cor?': 'Azul' } })).json.erro, /Falta responder: Quais frutas\?/);
  assert.equal((await post(rs(id, '/permissao'), { id: pid, decisao: 'permitir', respostas: { 'Qual cor?': 'Azul', 'Quais frutas?': 'Maçã, Uva', estranha: 'x' } })).status, 200);
  await livre(id);
  assert.equal(ultimoResultado(id).content, 'User has answered your questions: {"Qual cor?":"Azul","Quais frutas?":"Maçã, Uva"}');
  await post(rs(id, '/mensagem'), { texto: 'PERGUNTA dois' });
  c = await pedidoNovo(id, pid);
  assert.equal((await post(rs(id, '/permissao'), { id: c.permissao.id, decisao: 'negar' })).status, 200);
  await livre(id);
  assert.equal(ultimoResultado(id).content, 'O usuário preferiu não responder pelo Orbit.');

  // Tarefas em segundo plano (sem as ambient), e a lista vazia some do controle.
  await post(rs(id, '/mensagem'), { texto: 'TAREFAS' });
  c = await esperarQue(async () => {
    const x = await controleDe(id);
    return x?.tarefas ? x : null;
  }, 3000, 'tarefas');
  assert.deepEqual(c.tarefas, [
    { id: 'b1', tipo: 'local_bash', descricao: 'sleep 30 (em segundo plano)' },
    { id: 'a1', tipo: 'local_agent', descricao: 'Explore: onde fica o SSE' },
  ]);
  await livre(id);
  await post(rs(id, '/mensagem'), { texto: 'TAREFAS_FIM' });
  await esperarQue(async () => !(await controleDe(id)).tarefas, 3000, 'tarefas vazias');

  // Contexto: usage da última resposta (10 + 1000 + 500) e a janela do modelUsage (200000).
  const s = await esperarQue(async () => {
    const x = await sessaoDe(id);
    return x?.contexto?.janela ? x : null;
  }, 3000, 'contexto');
  assert.deepEqual(s.contexto, { tokens: 1510, modelo: 'claude-falso-1', janela: 200000, pct: 1 });
  assert.equal((await acaoFinal((await post(rs(id, '/devolver'))).json.acao.id)).estado, 'sucesso');
});

test('etapa 3: texto ao vivo (parcial acumulado, ≤10/s, o final com o mesmo id) e parar (no meio da resposta e com permissão aberta)', async () => {
  const id = await instanciaPronta('e3-parar');
  assert.equal((await post(rs(id, '/parar'))).json.codigo, 'parada');
  const fora = await criarSessao({ linhas: u('oi') + a('olá') });
  assert.equal((await post(rs(fora.id, '/parar'))).json.codigo, 'nao_assumida');

  const conversa = sse(rs(id, '/conversa/fluxo'));
  await conversa.pronto;
  await espera(200);
  const t0 = Date.now();
  await post(rs(id, '/mensagem'), { texto: 'LONGA' });
  const final = await conversa.esperar((e) => e.tipo === 'itens' && e.dados.itens.some((i) => i.tipo === 'assistente' && i.texto.startsWith('parte 1.')), 8000, 'resposta longa final');
  const dur = (Date.now() - t0) / 1000;
  const parciais = conversa.eventos.filter((e) => e.tipo === 'parcial').map((e) => e.dados);
  const item = final.dados.itens.find((i) => i.tipo === 'assistente');
  assert.ok(parciais.length >= 5, `poucos parciais: ${parciais.length}`);
  assert.ok(parciais.length <= dur * 10 + 2, `${parciais.length} parciais em ${dur.toFixed(1)} s`);
  assert.ok(parciais.every((p) => p.id === item.id), 'o id do parcial não bate com o do item final');
  assert.ok(parciais.every((p, i) => i === 0 || p.texto.startsWith(parciais[i - 1].texto) && p.texto.length > parciais[i - 1].texto.length), 'o texto não é acumulado');
  assert.ok(item.texto.startsWith(parciais.at(-1).texto));
  assert.ok(item.texto.endsWith('parte 40. '));
  // A página (GET /conversa) segue com o uuid do transcript; só o SSE troca pelo id do parcial.
  await livre(id);

  // Parar no meio da resposta: Acao parar → sucesso no result; a volta acaba, interrupção na conversa.
  const n0 = conversa.eventos.length;
  await post(rs(id, '/mensagem'), { texto: 'LONGA de novo' });
  await conversa.esperar((e, i) => e.tipo === 'parcial' && conversa.eventos.indexOf(e) >= n0, 4000, 'parcial da 2ª volta');
  const r = await post(rs(id, '/parar'));
  assert.equal(r.status, 202);
  assert.deepEqual([r.json.acao.tipo, r.json.acao.etapa], ['parar', 'Interrompendo']);
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  await livre(id);
  await conversa.esperar((e) => e.tipo === 'itens' && e.dados.itens.some((i) => i.tipo === 'interrupcao'), 3000, 'interrupção na conversa');
  assert.ok(!conversa.eventos.slice(n0).some((e) => e.tipo === 'itens' && e.dados.itens.some((i) => i.tipo === 'assistente' && i.texto.endsWith('parte 40. '))));

  // Parar com permissão aberta: o pedido some e a sessão fica livre.
  await post(rs(id, '/mensagem'), { texto: 'PERMISSAO e parar' });
  await pedidoNovo(id);
  const r2 = await post(rs(id, '/parar'));
  assert.equal((await acaoFinal(r2.json.acao.id)).estado, 'sucesso');
  await livre(id);
  conversa.fechar();
  assert.equal((await acaoFinal((await post(rs(id, '/devolver'))).json.acao.id)).estado, 'sucesso');
});

// ───────── rodada 6, etapa 4: ciclo de vida ─────────

const regsDoTeste = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DADOS, 'instancias.json'), 'utf8'));
  } catch {
    return {};
  }
};
const resumes = (id) => execucoes().filter((e) => argDe(e.argv, '--resume') === id);
const processoDe = async (id, valor, ms = 6000) => esperarQue(async () => {
  const c = await controleDe(id);
  return c?.processo === valor ? c : null;
}, ms, `processo ${valor}`);
// Fica vivo por `ms` (mais que o ORBIT_DORMIR_MS do teste)?
async function seguraAcordada(id, ms, rotulo) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    assert.notEqual((await controleDe(id)).processo, 'dormindo', `dormiu com ${rotulo}`);
    await espera(150);
  }
}
async function criarPronta(nome, extra = {}) {
  const r = await post('/instancias', { pasta: pastaNova(nome), texto: `oi ${nome}`, ...extra });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const id = r.json.sessao;
  assert.equal((await acaoFinal(r.json.acao.id)).estado, 'sucesso');
  assert.equal((await acaoDoTipo(id, 'mensagem')).estado, 'sucesso');
  await livre(id);
  return id;
}

test('etapa 4: dorme por ociosidade (não com volta, permissão, tarefa ou agendamento), acorda com --resume e os ajustes pendentes, encerrar/retomar, memória', async () => {
  await reiniciar({ extra: { ORBIT_DORMIR_MS: '2500', ORBIT_MS_MEMORIA: '400', ORBIT_MS_TIQUE_DORMIR: '200' } });
  const id = await criarPronta('e4-dorme', { modelo: 'haiku', esforco: 'low' });

  // Viva: processo, memória (tasklist), última atividade; GET /instancias.
  let c = await esperarQue(async () => {
    const x = await controleDe(id);
    return x?.memoria > 0 ? x : null;
  }, 4000, 'memória');
  assert.equal(c.processo, 'vivo');
  assert.ok(c.memoria > 1e6 && !Number.isNaN(Date.parse(c.ultimaAtividade)));
  const pid = c.pid;
  const gi = (await get('/instancias')).json;
  assert.ok(gi.vivas >= 1 && gi.memoria > 0 && gi.max === 5 && gi.dormirApos === 30, JSON.stringify(gi));

  // Dorme sozinha: motivo ocioso, o pid some, o status não vira "encerrada", o registro fica.
  c = await processoDe(id, 'dormindo', 8000);
  assert.equal(c.modo, 'orbit');
  assert.equal(c.dormiu.motivo, 'ocioso');
  assert.ok(!Number.isNaN(Date.parse(c.dormiu.em)));
  assert.ok(!c.memoria && !c.pid);
  await esperarQue(async () => !vivo(pid), 3000, 'pid sumiu');
  assert.notEqual((await sessaoDe(id)).status, 'encerrada');
  await esperarQue(async () => regsDoTeste()[id]?.processo === 'dormindo', 2000, 'registro dormindo');
  assert.equal(regsDoTeste()[id].modelo, 'haiku');
  assert.ok((await get('/instancias')).json.dormindo >= 1);

  // Dormindo: modelo/esforço/modo pendentes; parar 409 parada; permissão 404; encerrar 409 dormindo.
  assert.deepEqual((await post(rs(id, '/modelo'), { modelo: 'claude-velho-4-6' })).json, { modelo: 'claude-velho-4-6', esforco: 'low', pendente: true });
  assert.equal((await post(rs(id, '/esforco'), { esforco: 'xhigh' })).status, 400);
  assert.deepEqual((await post(rs(id, '/esforco'), { esforco: 'max' })).json, { modelo: 'claude-velho-4-6', esforco: 'max', pendente: true });
  assert.deepEqual((await post(rs(id, '/modo'), { modo: 'acceptEdits' })).json, { modo: 'acceptEdits', pendente: true });
  c = await controleDe(id);
  assert.deepEqual([c.modelo, c.esforco, c.modoPermissao], ['claude-velho-4-6', 'max', 'acceptEdits']);
  assert.equal((await post(rs(id, '/parar'))).json.codigo, 'parada');
  assert.equal((await post(rs(id, '/permissao'), { id: 'x', decisao: 'permitir' })).status, 404);
  assert.equal((await post(rs(id, '/encerrar'))).json.codigo, 'dormindo');

  // Duas mensagens seguidas acordam uma vez só (--resume com os ajustes do registro); "Retomando".
  const antes = resumes(id).length;
  const m1 = await post(rs(id, '/mensagem'), { texto: 'primeira depois de dormir' });
  const m2 = await post(rs(id, '/mensagem'), { texto: 'segunda depois de dormir' });
  assert.deepEqual([m1.status, m2.status], [202, 202]);
  await fluxo.esperar((e) => e.tipo === 'acao' && e.dados.id === m1.json.acao.id && /Retomando a instância/.test(e.dados.etapa || ''), 3000, 'etapa Retomando');
  assert.equal((await acaoFinal(m1.json.acao.id)).estado, 'sucesso');
  assert.equal((await acaoFinal(m2.json.acao.id)).estado, 'sucesso');
  await esperarQue(async () => (await get(rs(id, '/conversa'))).json.itens.some((i) => i.texto === 'Resposta: segunda depois de dormir'), 4000, '2ª resposta');
  const rx = resumes(id);
  assert.equal(rx.length, antes + 1);
  const argv = rx.at(-1).argv;
  assert.deepEqual([argDe(argv, '--model'), argDe(argv, '--effort'), argDe(argv, '--permission-mode')], ['claude-velho-4-6', 'max', 'acceptEdits']);
  assert.match(argDe(argv, '--append-system-prompt'), /Não comece comandos com cd/);
  assert.ok(argv.includes('--include-partial-messages'));
  c = await livre(id);
  assert.equal(c.processo, 'vivo');
  assert.deepEqual([c.modelo, c.esforco], ['claude-velho-4-6', 'max']); // efetivos (get_settings)

  // Não dorme com volta, permissão, tarefa ou agendamento (cada um por mais que o ORBIT_DORMIR_MS).
  await post(rs(id, '/mensagem'), { texto: 'DEMORA:3500' });
  await seguraAcordada(id, 3200, 'volta');
  await livre(id);
  await post(rs(id, '/mensagem'), { texto: 'PERMISSAO segura' });
  const pd = await pedidoNovo(id);
  await seguraAcordada(id, 3000, 'permissão');
  await post(rs(id, '/permissao'), { id: pd.permissao.id, decisao: 'permitir' });
  await livre(id);
  await post(rs(id, '/mensagem'), { texto: 'TAREFAS' });
  await seguraAcordada(id, 3000, 'tarefa');
  await post(rs(id, '/mensagem'), { texto: 'CRON e TAREFAS_FIM' });
  await esperarQue(async () => !(await controleDe(id)).tarefas, 3000, 'sem tarefas');
  await seguraAcordada(id, 3000, 'agendamento');
  assert.equal(regsDoTeste()[id].agendamentos, 1);

  // Encerrar: ocupada → 409; com forcar, interrompe e dorme (manual). Retomar: viva → 409 viva.
  assert.equal((await post(rs(id, '/retomar'))).json.codigo, 'viva');
  await post(rs(id, '/mensagem'), { texto: 'DEMORA:5000' });
  await esperarQue(async () => (await controleDe(id)).ocupada, 2000, 'ocupada');
  const e1 = await post(rs(id, '/encerrar'));
  assert.deepEqual([e1.status, e1.json.codigo], [409, 'ocupada']);
  const e2 = await post(rs(id, '/encerrar'), { forcar: true });
  assert.equal(e2.json.acao.tipo, 'encerrar');
  assert.equal((await acaoFinal(e2.json.acao.id)).estado, 'sucesso');
  c = await processoDe(id, 'dormindo');
  assert.equal(c.dormiu.motivo, 'manual');
  assert.ok(!c.interrompida);

  // Retomar: 202 → sucesso no initialize; depois Devolver (origem orbit) = encerrar.
  const rt = await post(rs(id, '/retomar'));
  assert.equal(rt.json.acao.tipo, 'retomar');
  assert.equal((await acaoFinal(rt.json.acao.id)).estado, 'sucesso');
  assert.equal((await controleDe(id)).processo, 'vivo');
  const dv = await post(rs(id, '/devolver'));
  assert.equal(dv.json.acao.tipo, 'encerrar');
  assert.equal((await acaoFinal(dv.json.acao.id)).estado, 'sucesso');
  assert.equal((await processoDe(id, 'dormindo')).dormiu.motivo, 'manual');
});

test('etapa 4: limite só das vivas (dorme a elegível mais antiga; todas ocupadas → 409), reinício do PC (dormindo/reinicio + interrompida), aberta por outro pid', async () => {
  const extra = { ORBIT_MOTOR_MAX: '2' };
  await reiniciar({ extra });
  try {
    await semVivas();
    await limiteEReinicio(extra);
  } finally {
    // O motor que subiu neste teste herdou ORBIT_MOTOR_MAX=2: sai junto, e o próximo nasce com o padrão.
    fluxo?.fechar();
    const velho = proc;
    await desligarMeu().catch(() => velho.kill());
    await esperarQue(async () => velho.exitCode != null || velho.signalCode != null, 5000, 'servidor saiu');
    const m = motorDoTeste();
    if (m?.pid && vivo(m.pid)) await matarMotorDoTeste(m.pid);
    await subir();
  }
});

// Encerra (ou devolve) as instâncias vivas que outros testes deixaram (o limite do teste conta todas).
async function semVivas() {
  await espera(500); // adoção
  for (const s of (await get('/estado')).json.sessoes) {
    const c = s.controle;
    if (c?.modo !== 'orbit' || c.processo === 'dormindo') continue;
    const r = s.origem === 'orbit' ? await post(rs(s.id, '/encerrar'), { forcar: true }) : await post(rs(s.id, '/devolver'));
    if (r.json?.acao) await acaoFinal(r.json.acao.id, 10000);
  }
  assert.equal((await get('/instancias')).json.vivas, 0);
}

async function limiteEReinicio(extra) {
  const A = await criarPronta('e4-lim-a');
  const B = await criarPronta('e4-lim-b');
  // A é a mais antiga: criar a 3ª faz A dormir (motivo limite).
  await post(rs(B, '/mensagem'), { texto: 'atividade em B' });
  await livre(B);
  const C = await criarPronta('e4-lim-c');
  let c = await processoDe(A, 'dormindo');
  assert.equal(c.dormiu.motivo, 'limite');
  assert.equal((await controleDe(B)).processo, 'vivo');
  assert.deepEqual([(await get('/instancias')).json.vivas, (await get('/instancias')).json.max], [2, 2]);

  // Todas ocupadas: criar e retomar → 409 limite (o erro diz quais).
  for (const x of [B, C]) await post(rs(x, '/mensagem'), { texto: 'DEMORA:4000' });
  await esperarQue(async () => (await controleDe(B)).ocupada && (await controleDe(C)).ocupada, 2000, 'ocupadas');
  const r1 = await post('/instancias', { pasta: pastaNova('e4-lim-d') });
  assert.deepEqual([r1.status, r1.json.codigo], [409, 'limite']);
  assert.match(r1.json.erro, /ocupadas/);
  assert.equal((await post(rs(A, '/retomar'))).json.codigo, 'limite');
  assert.equal((await post(rs(A, '/mensagem'), { texto: 'x' })).json.codigo, 'limite');
  await livre(B, 10000);
  await livre(C, 10000);

  // Reinício do PC: B ocupada, servidor e motor mortos à força; na subida, B e C dormindo/reinicio, B interrompida.
  await post(rs(B, '/mensagem'), { texto: 'DEMORA:8000' });
  await esperarQue(async () => (await controleDe(B)).ocupada, 2000, 'B ocupada');
  await espera(600); // o instancias.json grava em até 250 ms
  fluxo.fechar();
  const velho = proc;
  velho.kill();
  await esperarQue(async () => velho.exitCode != null || velho.signalCode != null, 5000, 'servidor saiu');
  const m = motorDoTeste();
  await matarMotorDoTeste(m.pid);
  await esperarQue(async () => !vivo(m.pid), 5000, 'motor morto');
  await subir(extra);
  c = await processoDe(B, 'dormindo');
  assert.deepEqual([c.dormiu.motivo, c.interrompida], ['reinicio', true]);
  c = await controleDe(C);
  assert.deepEqual([c.processo, c.dormiu.motivo, !!c.interrompida], ['dormindo', 'reinicio', false]);
  assert.equal((await controleDe(A)).dormiu.motivo, 'limite');

  // A próxima volta acorda e a interrompida some.
  const mb = await post(rs(B, '/mensagem'), { texto: 'depois do reinício' });
  assert.equal((await acaoFinal(mb.json.acao.id)).estado, 'sucesso');
  c = await livre(B);
  assert.ok(!c.interrompida && c.processo === 'vivo');

  // C dormindo aberta no VS Code (outro pid no registro): o Orbit larga o controle.
  const vs = processoDoVsCode(C, { status: 'idle' });
  c = await esperarQue(async () => {
    const x = await controleDe(C);
    return x && x.modo !== 'orbit' ? x : null;
  }, 4000, 'controle largado');
  assert.ok(!c.processo);
  await esperarQue(async () => !regsDoTeste()[C], 2000, 'registro de C apagado');
  vs.filho.kill();
  fs.rmSync(vs.arqReg, { force: true });

  // Volta ao normal para os testes seguintes (limite 5, sem instâncias vivas).
  assert.equal((await acaoFinal((await post(rs(B, '/encerrar'))).json.acao.id)).estado, 'sucesso');
}

// Rodada 6: o desligar não fecha mais os processos (contrato, etapa 1); era "desligar fecha o stdin de todos".
test('limite de 5 processos; desligar não encerra os processos do motor, e matar o motor leva todos (sem órfãos)', async () => {
  const ss = [];
  for (let i = 0; i < 6; i++) ss.push(await criarSessao({ linhas: u('oi') + a('olá') }));
  for (const s of ss.slice(0, 5)) assert.equal((await acaoFinal((await post(rs(s.id, '/assumir'))).json.acao.id)).estado, 'sucesso');
  // Etapa 4: o limite só barra quando nenhuma viva pode dormir; aqui as 5 ficam ocupadas.
  for (const s of ss.slice(0, 5)) await post(rs(s.id, '/mensagem'), { texto: 'DEMORA:6000' });
  await esperarQue(async () => {
    for (const s of ss.slice(0, 5)) if (!(await controleDe(s.id)).ocupada) return false;
    return true;
  }, 3000, '5 ocupadas');
  const r = await post(rs(ss[5].id, '/assumir'));
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'limite');
  const ri = await post('/instancias', { pasta: pastaNova('nova-limite') }); // etapa 2: o mesmo limite
  assert.deepEqual([ri.status, ri.json.codigo], [409, 'limite']);
  await esperarQue(async () => (await controleDe(ss[5].id)).motivo?.includes('5'), 3000, 'motivo limite');
  const pids = [];
  for (const s of ss.slice(0, 5)) pids.push((await controleDe(s.id)).pid);
  await desligarMeu();
  await esperarQue(async () => proc.exitCode != null, 3000, 'servidor saiu');
  await espera(800);
  assert.ok(pids.every(vivo), 'o desligar encerrou processos do motor');
  const m = motorDoTeste();
  assert.ok(m && vivo(m.pid));
  process.kill(m.pid); // só o motor (sem /T): os filhos morrem pelo job dele
  await esperarQue(async () => pids.every((p) => !vivo(p)), 5000, 'processos encerrados com o motor');
});

test('sem motor (não sobe): cai no spawn direto, registra no log e o processo morre com o servidor, como antes', async () => {
  await subir({ ORBIT_MOTOR_ARQ: path.join(DADOS, 'motor-que-nao-existe.mjs'), ORBIT_MS_MOTOR: '1500' });
  const s = await criarSessao({ linhas: u('oi') + a('olá') });
  const f = await acaoFinal((await post(rs(s.id, '/assumir'))).json.acao.id, 10000);
  assert.equal(f.estado, 'sucesso', f.erro);
  const c = await controleDe(s.id);
  assert.equal(c.modo, 'orbit');
  assert.match(fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8'), /não subiu; lançando direto/);
  const m = await post(rs(s.id, '/mensagem'), { texto: 'direto' });
  assert.equal((await acaoFinal(m.json.acao.id)).estado, 'sucesso');
  await desligarMeu();
  await esperarQue(async () => !vivo(c.pid), 5000, 'processo direto encerrado com o servidor');
  await esperarQue(async () => proc.exitCode != null, 3000, 'servidor saiu');
});
