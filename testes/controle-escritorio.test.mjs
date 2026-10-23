// Testes da §5 do contrato dos escritórios (controle.mjs, 21/10): campos novos do criarInstancia, modo sempre
// default, teto próprio fora do MAX_PROCESSOS, ouvirResultado, pedido `externa` e os exports novos.
// Rodar:  node --test testes/controle-escritorio.test.mjs
// O controle roda neste processo (criarControle com deps falsas, sem motor: ORBIT_MOTOR=0). O claude é o
// testes/claude-falso.mjs atrás de um envoltório temporário (na pasta de dados do teste) que: anota o argv, as
// variáveis ORBIT_* e as respostas de controle; põe total_cost_usd/usage no `result`; e, na mensagem com
// EXTERNA/MOTIVO, troca a palavra por PERMISSAO (o falso pede o Write) e põe decision_reason no can_use_tool.
// Um HTTP mínimo (porta 47822–47826, nunca 47821) responde /saude e delega as rotas ao controle.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47823);
const WIN = process.platform === 'win32';
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const DADOS = realDe(path.join(os.tmpdir(), 'gerenciador-testes', `escritorio-${Date.now()}`));
const PASTA = realDe(path.join(DADOS, 'proj'));
const LOG = path.join(DADOS, 'envolto.log');
const ARQ_INST = path.join(DADOS, 'instancias.json');
const ENVOLTO = path.join(DADOS, 'claude-envolto.mjs');
for (const d of ['sessoes', 'projetos']) fs.mkdirSync(path.join(DADOS, d), { recursive: true });

fs.writeFileSync(
  ENVOLTO,
  `import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
const argv = process.argv.slice(2);
const opc = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : '');
const sessao = opc('--session-id') || opc('--resume');
const anotar = (o) => fs.appendFileSync(process.env.ENVOLTO_LOG, JSON.stringify({ sessao, ...o }) + '\\n');
anotar({ argv, orbit: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ORBIT_'))) });
const ch = spawn(process.execPath, [process.env.ENVOLTO_FALSO, ...argv], { stdio: ['pipe', 'pipe', 'inherit'] });
let motivo = null;
let amplas = false;
let custo = 0;
const ent = readline.createInterface({ input: process.stdin });
ent.on('line', (l) => {
  if (l.includes('"control_response"')) anotar({ resposta: JSON.parse(l).response });
  if (l.includes('"type":"user"')) {
    if (l.includes('EXTERNA')) motivo = ['Ação externa: git push', 'hook'];
    else if (l.includes('MOTIVO')) motivo = ['Regra do projeto', 'rule'];
    if (l.includes('AMPLAS')) amplas = true;
    l = l.replace(/EXTERNA|MOTIVO|AMPLAS/g, 'PERMISSAO');
  }
  ch.stdin.write(l + '\\n');
});
ent.on('close', () => ch.stdin.end());
readline.createInterface({ input: ch.stdout }).on('line', (l) => {
  let j;
  try { j = JSON.parse(l); } catch { return process.stdout.write(l + '\\n'); }
  if (j.type === 'result') Object.assign(j, { total_cost_usd: (custo += 0.25), usage: { input_tokens: 10, output_tokens: 3 } });
  if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool' && amplas) {
    amplas = false;
    const R = (ruleContent, destination) => ({ type: 'addRules', behavior: 'allow', destination, rules: [{ toolName: 'Bash', ruleContent }] });
    j.request.permission_suggestions = [R('node:*', 'localSettings'), R('npm test', 'projectSettings'), { type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'npx:*' }, { toolName: 'Bash', ruleContent: 'git status' }] }, R('python*:*', 'localSettings'), R('npm run:*', 'localSettings'), R('*', 'localSettings'), { type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  }
  if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool' && motivo) {
    [j.request.decision_reason, j.request.decision_reason_type] = motivo;
    motivo = null;
  }
  process.stdout.write(JSON.stringify(j) + '\\n');
});
ch.on('close', (c) => { process.exitCode = c ?? 0; process.stdin.destroy(); });
`,
);

Object.assign(process.env, {
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: ENVOLTO,
  ORBIT_MOTOR: '0',
  ORBIT_MODELOS: '0',
  ORBIT_MOTOR_MAX: '2',
  ORBIT_MS_INICIO: '5000',
  ENVOLTO_FALSO: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ENVOLTO_LOG: LOG,
  FALSO_DEMORA_MS: '1500',
});
delete process.env.ORBIT_CLAUDE_ARGS;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;

const mod = await import('../controle.mjs');
const sessoes = new Map();
const controle = mod.criarControle({
  sessao: (id) => sessoes.get(id),
  sessoes: () => sessoes.values(),
  difundir: () => {},
  difundirSessao: () => {},
  lerJSONCorpo: (req) =>
    new Promise((ok, ko) => {
      let t = '';
      req.setEncoding('utf8');
      req.on('data', (d) => (t += d));
      req.on('end', () => {
        try {
          ok(JSON.parse(t || '{}'));
        } catch (e) {
          ko(e);
        }
      });
    }),
  log: () => {},
  lerConfig: () => ({}),
  criarSessao: (o) => sessoes.set(o.id, { id: o.id, cwd: o.cwd, apelido: o.apelido, transcript: o.transcript, status: 'parada' }),
  mcpProtecao: async () => ({ bloquear: ['srv-pendente'], env: {} }), // o --settings do escritório tem de mesclar com este
  tetoEscritorios: 2,
});

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
  if (url.pathname === '/saude') return res.end(JSON.stringify({ pid: process.pid }));
  if (req.headers['x-remoto'] === '1') res._remoto = true;
  try {
    if (!(await controle.rota(req, res, url.pathname, url))) res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(e.message);
  }
});
await new Promise((r) => servidor.listen(PORTA, '127.0.0.1', r));

after(async () => {
  const pids = [...controle._procs.values()].map((p) => p.pid).filter(Boolean);
  controle.encerrarTudo();
  await espera(800);
  for (const pid of pids) await Promise.resolve(matarArvore(pid)).catch(() => {});
  await new Promise((r) => servidor.close(r));
  await espera(300);
  fs.rmSync(DADOS, { recursive: true, force: true });
});

// ───────── utilidades ─────────
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function aguardar(fn, ms = 10000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fim) throw new Error(`tempo esgotado esperando ${rotulo}`);
    await espera(50);
  }
}
const linhas = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lancamentos = (id) => linhas().filter((l) => l.sessao === id && l.argv);
const respostas = (id) => linhas().filter((l) => l.sessao === id && l.resposta);
const opc = (argv, n) => argv[argv.indexOf(n) + 1];
const pronta = (id) => aguardar(() => {
  const e = controle.estado(id);
  return e.processo === 'vivo' && !e.ocupada && !e.permissao;
}, 10000, `a instância ${id} pronta`);
function post(rota, corpo, cab = {}) {
  return new Promise((ok, ko) => {
    const d = JSON.stringify(corpo);
    const q = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), 'x-gerenciador': '1', ...cab } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => ok({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    q.on('error', ko);
    q.end(d);
  });
}
const getJ = (rota) => new Promise((ok, ko) => http.get({ host: '127.0.0.1', port: PORTA, path: rota }, (res) => {
  let t = '';
  res.on('data', (c) => (t += c));
  res.on('end', () => ok(JSON.parse(t)));
}).on('error', ko));

const ESC = { id: 'esc-teste', execucao: 'exec-1', papel: 'orquestrador', papelNome: 'Orquestrador' };
const CONF = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Agent|Task|mcp__.*', hooks: [{ type: 'command', command: 'node "x/escritorio-hook.mjs"' }] }] } };
let orq; // a instância de escritório (orquestrador)
let comum; // uma instância comum, para comparar

// ───────── testes ─────────

test('exports novos: criarInstancia, enviarMensagem, interromper, encerrar, ouvirResultado (e estado por id)', () => {
  for (const f of ['criarInstancia', 'enviarMensagem', 'interromper', 'encerrar', 'ouvirResultado', 'estado', 'rota', 'avisarLider']) assert.equal(typeof controle[f], 'function', f);
  assert.equal(typeof mod.ajustesEscritorio, 'function');
  assert.equal(typeof mod.comAnexo, 'function');
  // Validação dos campos novos: env só ORBIT_*, configuracao objeto, anexo ≤ 20000, escritorio com id/execucao/papel.
  assert.throws(() => mod.ajustesEscritorio({ ambiente: { PATH: 'x' } }), (e) => e.status === 400);
  assert.throws(() => mod.ajustesEscritorio({ configuracao: [1] }), (e) => e.status === 400);
  assert.throws(() => mod.ajustesEscritorio({ anexoSistema: 'x'.repeat(20001) }), (e) => e.status === 400);
  assert.throws(() => mod.ajustesEscritorio({ escritorio: { id: 'a' } }), (e) => e.status === 400);
  assert.deepEqual(mod.ajustesEscritorio({ ambiente: { ORBIT_PAPEL: 'dev', ORBIT_N: 3 } }), { ambiente: { ORBIT_PAPEL: 'dev', ORBIT_N: '3' } });
  // Um --append-system-prompt só: o anexo entra no que já houver.
  assert.deepEqual(mod.comAnexo(['-p', '--append-system-prompt', 'A'], 'B'), ['-p', '--append-system-prompt', 'A\n\nB']);
  assert.deepEqual(mod.comAnexo(['-p'], 'B'), ['-p', '--append-system-prompt', 'B']);
  assert.throws(() => controle.ouvirResultado('x'), TypeError);
});

test('criarInstancia com escritório: flags, --settings mesclado, env ORBIT_*, modo sempre default, estado.escritorio', async () => {
  const r = await controle.criarInstancia({
    pasta: PASTA,
    nome: 'Orquestrador',
    permissao: 'auto', // ignorado: escritório é sempre default
    pai: 'sessao-pai-1',
    anexoSistema: 'Você é o orquestrador do escritório de teste.',
    configuracao: CONF,
    ambiente: { ORBIT_ESCRITORIO: 'esc-teste', ORBIT_PAPEL: 'orquestrador', ORBIT_EXTERNAS: '[]' },
    escritorio: ESC,
  });
  orq = r.sessao;
  await pronta(orq);
  const [l] = lancamentos(orq);
  assert.ok(l, 'o envoltório anotou o lançamento');
  assert.equal(opc(l.argv, '--permission-mode'), 'default');
  assert.equal(l.argv.filter((a) => a === '--append-system-prompt').length, 1, 'um --append-system-prompt só');
  const anexo = opc(l.argv, '--append-system-prompt');
  assert.ok(anexo.startsWith(mod.ORIENTACAO_TERMINAL), 'a orientação de terminal continua');
  assert.ok(anexo.endsWith('Você é o orquestrador do escritório de teste.'));
  assert.equal(l.argv.filter((a) => a === '--settings').length, 1, 'um --settings só');
  const st = JSON.parse(opc(l.argv, '--settings'));
  assert.deepEqual(st.hooks, CONF.hooks);
  assert.deepEqual(st.disabledMcpjsonServers, ['srv-pendente'], 'mesclado com a proteção dos MCP');
  assert.equal(l.orbit.ORBIT_ESCRITORIO, 'esc-teste');
  assert.equal(l.orbit.ORBIT_PAPEL, 'orquestrador');
  assert.equal(l.orbit.ORBIT_SESSAO, orq, 'criação: ORBIT_SESSAO = id da sessão (o envLimpo tira CLAUDE_CODE_HOST_SESSION_ID)');
  const e = controle.estado(orq);
  assert.deepEqual(e.escritorio, ESC);
  assert.equal(e.pai, 'sessao-pai-1');
  assert.equal(e.modoPermissao, 'default');
  // A rota de modo recusa (o modo fica sempre default).
  const m = await post(`/sessao/${orq}/modo`, { modo: 'auto' });
  assert.equal(m.status, 409);
  assert.equal(m.json.codigo, 'escritorio');

  // A comum segue como antes: modo pedido, sem anexo extra nem env ORBIT_ESCRITORIO, sem `escritorio` no estado.
  comum = (await controle.criarInstancia({ pasta: PASTA, permissao: 'auto' })).sessao;
  await pronta(comum);
  const [lc] = lancamentos(comum);
  assert.equal(opc(lc.argv, '--permission-mode'), 'auto');
  assert.equal(opc(lc.argv, '--append-system-prompt'), mod.ORIENTACAO_TERMINAL);
  assert.equal(JSON.parse(opc(lc.argv, '--settings')).hooks, undefined);
  assert.equal(lc.orbit.ORBIT_ESCRITORIO, undefined);
  assert.equal(lc.orbit.ORBIT_SESSAO, comum, 'toda instância leva ORBIT_SESSAO, também a comum');
  assert.equal(controle.estado(comum).escritorio, undefined);
});

test('teto próprio dos escritórios, separado do MAX_PROCESSOS', async () => {
  // MAX_PROCESSOS = 2 (ORBIT_MOTOR_MAX): 1 comum + 1 escritório vivos; a 2ª comum ainda cabe.
  const c2 = (await controle.criarInstancia({ pasta: PASTA })).sessao;
  await pronta(c2);
  const membro = (await controle.criarInstancia({ pasta: PASTA, escritorio: { ...ESC, papel: 'dev', papelNome: 'Dev' }, pai: orq })).sessao;
  await pronta(membro);
  let res = await getJ('/instancias');
  assert.equal(res.max, 2);
  assert.equal(res.vivas, 2, 'as de escritório não contam no max');
  assert.equal(res.escritorios, 2);
  assert.equal(res.tetoEscritorios, 2);
  // Teto (tetoEscritorios: 2) cheio → 429; a comum não é afetada pelas do escritório.
  await assert.rejects(controle.criarInstancia({ pasta: PASTA, escritorio: { ...ESC, papel: 'qa' } }), (e) => e.status === 429 && e.codigo === 'limite_escritorio');
  // Encerrar o membro abre a vaga do teto.
  controle.encerrar(membro, true);
  await aguardar(() => controle.estado(membro).processo === 'dormindo', 10000, 'o membro dormir');
  res = await getJ('/instancias');
  assert.equal(res.escritorios, 1);
  assert.equal(controle.estado(membro).escritorio.papel, 'dev', 'dormindo, o registro guarda o escritório');
  assert.equal(controle.estado(membro).pai, orq, 'o membro leva o pai (o orquestrador)');
  const orq2 = (await controle.criarInstancia({ pasta: PASTA, escritorio: { ...ESC, id: 'esc-2' } })).sessao; // orquestrador: sem pai
  await pronta(orq2);
  assert.ok(!controle.estado(orq2).pai, 'o orquestrador é criado sem pai');
  controle.encerrar(orq2, true);
  await aguardar(() => controle.estado(orq2).processo === 'dormindo', 10000, 'o orquestrador 2 dormir');
  controle.encerrar(c2, true);
  await aguardar(() => controle.estado(c2).processo === 'dormindo', 10000, 'a comum dormir');
});

test('ouvirResultado recebe custoUsd, usage, modelUsage, texto e erro a cada result', async () => {
  const ouvidos = [];
  const parar = controle.ouvirResultado((id, r) => ouvidos.push({ id, ...r }));
  try {
    const a = controle.enviarMensagem(orq, 'olá');
    assert.equal(a.tipo, 'mensagem');
    const r = await aguardar(() => ouvidos.find((o) => o.id === orq), 10000, 'o result');
    assert.equal(typeof r.custoUsd, 'number');
    assert.ok(r.custoUsd > 0);
    assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 3 });
    assert.equal(typeof r.modelUsage, 'object');
    assert.equal(typeof r.texto, 'string');
    assert.ok(r.texto.length > 0 && r.texto.length <= 2000);
    assert.equal(r.erro, false);
    // Acumulado na sessão: a volta seguinte traz um total maior.
    await pronta(orq);
    controle.enviarMensagem(orq, 'de novo');
    const r2 = await aguardar(() => ouvidos.filter((o) => o.id === orq)[1], 10000, 'o 2º result');
    assert.ok(r2.custoUsd > r.custoUsd);
  } finally {
    parar();
  }
  await pronta(orq);
  assert.throws(() => controle.enviarMensagem(orq, ''), (e) => e.status === 400);
  assert.throws(() => controle.enviarMensagem('nao-existe', 'oi'), (e) => e.status === 409);
});

test('permissão: motivo/tipoMotivo; "Ação externa" de hook vira externa e ignora "permitir sempre" (PC e celular)', async () => {
  for (const remoto of [false, true]) {
    controle.enviarMensagem(orq, 'EXTERNA agora');
    const e = await aguardar(() => controle.estado(orq).permissao, 10000, 'o pedido externo');
    assert.equal(e.externa, true);
    assert.equal(e.tipoMotivo, 'hook');
    assert.ok(e.motivo.startsWith('Ação externa'));
    assert.equal(e.sugestoes, undefined, 'sem "permitir sempre" nem regra');
    const antes = respostas(orq).length;
    const r = await post(`/sessao/${orq}/permissao`, { id: e.id, decisao: 'permitir', sugestao: 0 }, remoto ? { 'x-remoto': '1' } : {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const resp = await aguardar(() => respostas(orq).slice(antes).find((x) => x.resposta.request_id === e.id), 5000, 'a resposta ao claude');
    assert.equal(resp.resposta.response.behavior, 'allow');
    assert.equal(resp.resposta.response.updatedPermissions, undefined, 'só esta vez');
    await pronta(orq);
  }
  // Motivo que não é ação externa: guarda motivo/tipo, sem `externa`. No escritório, a sugestão de modo some.
  controle.enviarMensagem(orq, 'MOTIVO agora');
  const e = await aguardar(() => controle.estado(orq).permissao, 10000, 'o pedido com motivo');
  assert.equal(e.externa, undefined);
  assert.equal(e.motivo, 'Regra do projeto');
  assert.equal(e.tipoMotivo, 'rule');
  assert.ok(e.sugestoes.length >= 1);
  assert.ok(e.sugestoes.every((s) => !s.modo), 'escritório: sem sugestão de trocar o modo');
  await post(`/sessao/${orq}/permissao`, { id: e.id, decisao: 'negar' });
  await pronta(orq);
  // Na comum, tudo como antes (com a sugestão de modo e sem motivo).
  controle.enviarMensagem(comum, 'PERMISSAO');
  const c = await aguardar(() => controle.estado(comum).permissao, 10000, 'o pedido da comum');
  assert.equal(c.externa, undefined);
  assert.equal(c.motivo, undefined);
  assert.ok(c.sugestoes.some((s) => s.modo === 'acceptEdits'));
  await post(`/sessao/${comum}/permissao`, { id: c.id, decisao: 'negar' });
  await pronta(comum);
});

test('interromper e acordar: parada → null; em volta → Acao parar; dormindo acorda com as mesmas flags', async () => {
  assert.equal(controle.interromper(orq), null);
  assert.equal(controle.interromper('nao-existe'), null);
  controle.enviarMensagem(orq, 'DEMORA');
  await aguardar(() => controle.estado(orq).ocupada, 5000, 'a volta começar');
  const a = controle.interromper(orq);
  assert.equal(a?.tipo, 'parar');
  await pronta(orq);
  // Dorme e acorda pelo enviarMensagem: o --resume leva de novo o modo default, o anexo, o --settings e o env.
  controle.encerrar(orq, true);
  await aguardar(() => controle.estado(orq).processo === 'dormindo', 10000, 'o orquestrador dormir');
  controle.enviarMensagem(orq, 'acorda');
  await aguardar(() => lancamentos(orq).length >= 2, 10000, 'o 2º lançamento');
  await pronta(orq);
  const l = lancamentos(orq)[1];
  assert.equal(opc(l.argv, '--resume'), orq);
  assert.equal(opc(l.argv, '--permission-mode'), 'default');
  assert.ok(opc(l.argv, '--append-system-prompt').endsWith('Você é o orquestrador do escritório de teste.'));
  assert.deepEqual(JSON.parse(opc(l.argv, '--settings')).hooks, CONF.hooks);
  assert.equal(l.orbit.ORBIT_ESCRITORIO, 'esc-teste');
  assert.equal(l.orbit.ORBIT_SESSAO, orq, 'acordar (--resume): ORBIT_SESSAO continua = id da sessão');
  assert.deepEqual(controle.estado(orq).escritorio, ESC);
});

// ───────── F3 (21/10): sugestões, geração, orçamento, registro e adormecer/listarEscritorio ─────────

test('F3 (a) regraAmplaDeTerminal e sugestaoEscritorio: tudo vira session, regra ampla some', () => {
  for (const c of ['node:*', 'node *', 'python*:*', 'python3:*', 'python *', 'npx:*', 'npm run:*', 'pnpm run *', 'bash:*', 'pwsh:*', 'powershell:*', 'curl:*', '*', '']) assert.equal(mod.regraAmplaDeTerminal(c), true, c);
  for (const c of ['npm test', 'npm test *', 'git status', 'node scripts/x.mjs *', 'npm run build *', 'node']) assert.equal(mod.regraAmplaDeTerminal(c), false, c);
  assert.equal(mod.sugestaoEscritorio({ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'node:*' }] }), null);
  const mista = mod.sugestaoEscritorio({ type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'npx:*' }, { toolName: 'Bash', ruleContent: 'git status' }] });
  assert.deepEqual(mista.rules, [{ toolName: 'Bash', ruleContent: 'git status' }]);
  assert.equal(mista.destination, 'session');
  assert.equal(mod.sugestaoEscritorio({ type: 'addRules', behavior: 'allow', destination: 'projectSettings', rules: [{ toolName: 'Write', ruleContent: 'notas/**' }] }).destination, 'session');
  assert.equal(mod.sugestaoEscritorio({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), null);
});

test('F3 (a) pedido de permissão: no escritório só sobra regra não ampla, e a resposta vai com destination session', async () => {
  controle.enviarMensagem(orq, 'AMPLAS agora');
  const e = await aguardar(() => controle.estado(orq).permissao, 10000, 'o pedido com sugestões amplas');
  const rotulos = e.sugestoes.map((x) => x.rotulo).join(' | ');
  assert.equal(e.sugestoes.length, 2, rotulos); // npm test e git status; as amplas e o setMode sumiram
  assert.ok(e.sugestoes.every((x) => !x.modo && /npm test|git status/.test(x.rotulo) && !/node|python|npx|npm run/.test(x.rotulo.replace(/npm test/g, ''))), rotulos);
  const antes = respostas(orq).length;
  const r = await post('/sessao/' + orq + '/permissao', { id: e.id, decisao: 'permitir', sugestao: e.sugestoes[0].indice });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const resp = await aguardar(() => respostas(orq).slice(antes).find((x) => x.resposta.request_id === e.id), 5000, 'a resposta ao claude');
  const ups = resp.resposta.response.updatedPermissions;
  assert.ok(Array.isArray(ups) && ups.length >= 1);
  for (const u of ups) assert.equal(u.destination, 'session', JSON.stringify(u));
  assert.ok(!/node:|npx|python|npm run:/.test(JSON.stringify(ups)), JSON.stringify(ups));
  await pronta(orq);
  // A comum segue como antes: mantém as sugestões amplas e a de trocar o modo.
  controle.enviarMensagem(comum, 'AMPLAS agora');
  const c = await aguardar(() => controle.estado(comum).permissao, 10000, 'o pedido da comum');
  assert.ok(c.sugestoes.length > e.sugestoes.length, 'a comum mantém as sugestões amplas');
  assert.ok(c.sugestoes.some((x) => /node/.test(x.rotulo)));
  assert.ok(c.sugestoes.some((x) => x.modo === 'acceptEdits'));
  await post('/sessao/' + comum + '/permissao', { id: c.id, decisao: 'negar' });
  await pronta(comum);
});

test('F3 (b)(e) geracao muda a cada processo; adormecer(id) fecha e a próxima mensagem acorda com --resume; listarEscritorio', async () => {
  const vistos = [];
  const parar = controle.ouvirResultado((id, r) => id === orq && vistos.push(r.geracao));
  try {
    await pronta(orq);
    controle.enviarMensagem(orq, 'volta A');
    await aguardar(() => vistos.length >= 1, 10000, 'o result A');
    await pronta(orq);
    controle.enviarMensagem(orq, 'volta B');
    await aguardar(() => vistos.length >= 2, 10000, 'o result B');
    assert.equal(typeof vistos[0], 'string');
    assert.ok(vistos[0], 'geracao preenchida');
    assert.equal(vistos[0], vistos[1], 'mesmo processo, mesma geração');
    await pronta(orq);
    const antes = lancamentos(orq).length;
    assert.equal(await controle.adormecer(orq), true);
    assert.equal(controle.estado(orq).processo, 'dormindo');
    assert.equal(controle.estado(orq).dormiu.motivo, 'escritorio');
    assert.equal(await controle.adormecer(orq), true, 'dormindo: nada a fazer');
    assert.equal(await controle.adormecer('nao-existe'), true);
    const lista = controle.listarEscritorio();
    assert.deepEqual(lista.find((x) => x.id === orq), { id: orq, escritorio: ESC, processo: 'dormindo' });
    assert.ok(!lista.some((x) => x.id === comum), 'instância comum não entra');
    assert.ok(lista.every((x) => x.escritorio && x.escritorio.id && ['vivo', 'iniciando', 'dormindo'].includes(x.processo)));
    controle.enviarMensagem(orq, 'volta C');
    await aguardar(() => vistos.length >= 3, 10000, 'o result C (processo novo)');
    assert.equal(lancamentos(orq).length, antes + 1);
    assert.equal(opc(lancamentos(orq).at(-1).argv, '--resume'), orq);
    assert.notEqual(vistos[2], vistos[1], 'processo novo, geração nova');
    await pronta(orq);
    assert.equal(controle.listarEscritorio().find((x) => x.id === orq).processo, 'vivo');
  } finally {
    parar();
  }
});

test('F3 (c)(d) orcamentoUsd vira --max-budget-usd (criar e acordar) e o escritório é gravado no instancias.json', async () => {
  for (const ruim of [0, -1, 'x', NaN, Infinity]) assert.throws(() => mod.ajustesEscritorio({ orcamentoUsd: ruim }), (e) => e.status === 400, String(ruim));
  assert.equal(mod.ajustesEscritorio({ orcamentoUsd: 1.23456789 }).orcamentoUsd, 1.2346);
  assert.equal(mod.ajustesEscritorio({}).orcamentoUsd, undefined);
  const lerReg = (id) => {
    try {
      return JSON.parse(fs.readFileSync(ARQ_INST, 'utf8'))[id];
    } catch {
      return null;
    }
  };
  const id = (await controle.criarInstancia({ pasta: PASTA, nome: 'Com teto', escritorio: { ...ESC, id: 'esc-orc', papel: 'dev', papelNome: 'Dev' }, pai: orq, orcamentoUsd: 1.5, ambiente: { ORBIT_PAPEL: 'dev' } })).sessao;
  // (d) já no registro, sem esperar a volta: escritório, pai, ambiente e orçamento
  const reg = await aguardar(() => lerReg(id), 5000, 'o registro no instancias.json');
  assert.equal(reg.escritorio.id, 'esc-orc');
  assert.equal(reg.escritorio.papel, 'dev');
  assert.equal(reg.pai, orq);
  assert.equal(reg.orcamentoUsd, 1.5);
  assert.equal(reg.ambiente.ORBIT_PAPEL, 'dev');
  await pronta(id);
  const [l] = lancamentos(id);
  assert.equal(opc(l.argv, '--max-budget-usd'), '1.5');
  assert.equal(l.argv.filter((a) => a === '--max-budget-usd').length, 1);
  // sem orçamento (as outras instâncias): sem a flag
  assert.equal(lancamentos(orq)[0].argv.includes('--max-budget-usd'), false);
  assert.equal(lancamentos(comum)[0].argv.includes('--max-budget-usd'), false);
  // dormindo e acordando (o --resume precisa de uma volta já feita): a flag, o escritório e o pai voltam
  const feito = new Promise((ok) => {
    const parar = controle.ouvirResultado((i) => i === id && (parar(), ok()));
  });
  controle.enviarMensagem(id, 'primeira volta');
  await feito;
  await pronta(id);
  await controle.adormecer(id);
  await aguardar(() => lerReg(id)?.processo === 'dormindo', 5000, 'o registro dormindo');
  assert.equal(lerReg(id).escritorio.id, 'esc-orc');
  controle.enviarMensagem(id, 'acorda com teto');
  await aguardar(() => lancamentos(id).length >= 2, 10000, 'o 2º lançamento');
  await pronta(id);
  const l2 = lancamentos(id)[1];
  assert.equal(opc(l2.argv, '--resume'), id);
  assert.equal(opc(l2.argv, '--max-budget-usd'), '1.5');
  assert.equal(l2.orbit.ORBIT_PAPEL, 'dev');
  assert.equal(controle.estado(id).escritorio.id, 'esc-orc');
  assert.equal(controle.estado(id).pai, orq);
  await controle.adormecer(id);
});
