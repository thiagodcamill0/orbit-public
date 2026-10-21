// Subagente acima do limite de contexto (20/10): aviso direto ao subagente (camada 2, aviso-subagente.mjs) e
// aviso de reserva ao líder (camada 3, servidor.mjs + controle.avisarLider).
// Rodar:  node --test testes/subagente-limite.test.mjs
// Sobe um servidor próprio numa porta livre de 47822–47826 (nunca a 47821), com dados, registro de sessões e
// projetos falsos numa pasta temporária; o claude.exe é o testes/claude-falso.mjs (o líder). Não toca no
// ~/.claude/settings.json nem no claude real.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';
import { AUTO_COMPACTAR_PADRAO, LIMITE_AUTO_MIN, LIMITE_AUTO_MAX } from '../controle.mjs';
import { avaliar, contextoDaCauda, limiteDaConfig, nomeDoProjeto, pastaDeProgresso, textoDoAvisoLider, LIMITE_PADRAO, LIMITE_MIN, LIMITE_MAX } from '../aviso-subagente.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const BASE = realDe(path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes')));
const DADOS = path.join(BASE, `subagente-limite-${Date.now()}`);
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
for (const d of [SESSOES, PROJETOS]) fs.mkdirSync(d, { recursive: true });

const linha = (o) => JSON.stringify(o) + '\n';
const resposta = (tokens, modelo = 'claude-sonnet-5-5') => linha({ type: 'assistant', isSidechain: true, uuid: 'a' + tokens, timestamp: new Date().toISOString(),
  message: { id: 'm' + tokens, role: 'assistant', model: modelo, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 4, cache_read_input_tokens: tokens - 1004, cache_creation_input_tokens: 1000 } } });
// Transcript principal + o do subagente, como o Claude Code grava (<principal sem .jsonl>/subagents/agent-<id>.jsonl).
function transcripts(base, id, aid, tokens) {
  const principal = path.join(base, `${id}.jsonl`);
  if (!fs.existsSync(principal)) fs.writeFileSync(principal, linha({ type: 'user', message: { role: 'user', content: 'oi' }, uuid: 'p1' }));
  const pasta = path.join(base, id, 'subagents');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `agent-${aid}.jsonl`), linha({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Faça X.' } }) + resposta(tokens));
  return principal;
}

// ───────── camada 2: o hook ─────────

test('aviso-subagente: os números do limite são os do controle.mjs', () => {
  assert.deepEqual([LIMITE_PADRAO, LIMITE_MIN, LIMITE_MAX], [AUTO_COMPACTAR_PADRAO.limite, LIMITE_AUTO_MIN, LIMITE_AUTO_MAX]);
});

test('aviso-subagente: progresso em <dados>/progresso/<nome da pasta do projeto>, nunca no projeto', () => {
  const proj = path.join(DADOS, 'Meu App');
  assert.equal(nomeDoProjeto(proj), 'Meu App');
  assert.equal(nomeDoProjeto(proj + path.sep), 'Meu App');
  assert.equal(pastaDeProgresso(proj, DADOS), path.join(DADOS, 'progresso', 'Meu App'));
  assert.equal(nomeDoProjeto(''), nomeDoProjeto(process.cwd()));
  assert.ok(!/[<>:"/\\|?*]/.test(nomeDoProjeto('x/a:b')));
});

test('aviso-subagente: o líder que recebe PRECISA_SUBSTITUIR do Agent ganha as instruções', () => {
  const d = path.join(DADOS, 'lider');
  fs.mkdirSync(d, { recursive: true });
  const arq = path.join(DADOS, 'progresso', 'app', 'tela.md');
  const ev = (o) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Agent', ...o });
  const resp = { content: [{ type: 'text', text: `Parei.\nPRECISA_SUBSTITUIR: ${arq}\nFalta a tela 2.` }] };
  const j = JSON.parse(avaliar(ev({ tool_response: resp }), { dados: d }));
  const t = j.hookSpecificOutput.additionalContext;
  assert.match(t, /^Aviso do Orbit: o subagente que acabou de responder passou do limite de 140 mil tokens/);
  assert.ok(t.includes(arq), t);
  assert.match(t, /crie um subagente novo/);
  assert.match(t, /apague o arquivo de progresso/);
  assert.equal(textoDoAvisoLider('', 140000).includes('o resumo que ele deixou na resposta'), true);
  assert.equal(avaliar(ev({ tool_response: { content: [{ type: 'text', text: 'Tudo pronto.' }] } }), { dados: d }), '', 'resposta comum: nada');
  assert.equal(avaliar(ev({ tool_name: 'Bash', tool_response: resp }), { dados: d }), '', 'outra ferramenta: nada');
  assert.equal(avaliar(ev({ tool_name: 'Task', tool_response: resp }), { dados: d }) !== '', true, 'Task (nome antigo) vale');
});

test('aviso-subagente: contexto da última resposta no fim do transcript', () => {
  assert.equal(contextoDaCauda(resposta(1000) + resposta(150000) + linha({ type: 'user', message: { content: 'x' } })), 150000);
  assert.equal(contextoDaCauda(resposta(150000) + resposta(9, '<synthetic>')), 150000);
  assert.equal(contextoDaCauda('{"type":"assistant",corta'), 0);
});

test('aviso-subagente: limite da config (o da compactação automática), com reserva de 140 mil', () => {
  const d = path.join(DADOS, 'cfg');
  fs.mkdirSync(d, { recursive: true });
  assert.equal(limiteDaConfig(d), 140000);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ instancias: { autoCompactar: { limite: 90000 } } }));
  assert.equal(limiteDaConfig(d), 90000);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ instancias: { autoCompactar: { limite: 5 } } }));
  assert.equal(limiteDaConfig(d), 140000);
  fs.writeFileSync(path.join(d, 'config.json'), '{ quebrado');
  assert.equal(limiteDaConfig(d), 140000);
});

test('aviso-subagente: só subagente, só acima do limite, uma vez só; marca a entrega', () => {
  const d = path.join(DADOS, 'hook1');
  fs.mkdirSync(d, { recursive: true });
  const principal = transcripts(d, 'sess', 'ag1', 150000);
  transcripts(d, 'sess', 'ag2', 120000);
  const ev = (o) => ({ hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: principal, tool_name: 'Bash', ...o });
  assert.equal(avaliar(ev({}), { dados: d }), '', 'sessão principal: nada');
  assert.equal(avaliar(ev({ agent_id: 'ag2' }), { dados: d }), '', 'abaixo do limite: nada');
  assert.equal(avaliar(ev({ agent_id: '../fora' }), { dados: d }), '', 'id estranho: nada');
  assert.equal(avaliar(ev({ agent_id: 'ag1', hook_event_name: 'PreToolUse' }), { dados: d }), '', 'só PostToolUse');
  const s = avaliar(ev({ agent_id: 'ag1' }), { dados: d });
  const j = JSON.parse(s);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(j.hookSpecificOutput.additionalContext, /^Aviso do Orbit: o seu contexto está em 150 mil tokens, acima do limite de 140 mil por subagente\./);
  assert.match(j.hookSpecificOutput.additionalContext, /PRECISA_SUBSTITUIR: <caminho do arquivo de progresso>/);
  assert.match(j.hookSpecificOutput.additionalContext, /não crie pastas/);
  const marca = JSON.parse(fs.readFileSync(path.join(d, 'avisos-subagentes', 'ag1'), 'utf8'));
  assert.deepEqual([marca.sessao, marca.tokens, marca.limite], ['sess', 150000, 140000]);
  assert.equal(avaliar(ev({ agent_id: 'ag1' }), { dados: d }), '', 'segunda vez: nada');
  // Limite mais baixo na config: o de 120 mil passa a receber.
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ instancias: { autoCompactar: { limite: 100000 } } }));
  assert.match(avaliar(ev({ agent_id: 'ag2' }), { dados: d }), /120 mil tokens, acima do limite de 100 mil/);
  // agent_transcript_path, quando vem, vale.
  const outro = path.join(d, 'outro.jsonl');
  fs.writeFileSync(outro, resposta(200000));
  assert.match(avaliar(ev({ agent_id: 'ag3', transcript_path: '/nao/existe.jsonl', agent_transcript_path: outro }), { dados: d }), /200 mil/);
});

test('aviso-subagente como processo: JSON no stdout para o subagente e para o líder; sempre sai 0; qualquer projeto', () => {
  const d = path.join(DADOS, 'hook2');
  fs.mkdirSync(d, { recursive: true });
  const principal = transcripts(d, 'sess', 'ag9', 160000);
  const rodar = (ev, bruto, projeto = path.join(DADOS, 'outro-projeto')) => {
    const env = { ...process.env, GERENCIADOR_DADOS: d, CLAUDE_PROJECT_DIR: projeto };
    if (projeto === null) delete env.CLAUDE_PROJECT_DIR;
    return spawnSync(process.execPath, [path.join(RAIZ, 'aviso-subagente.mjs')], { input: bruto ?? JSON.stringify(ev), encoding: 'utf8', env });
  };
  // Líder (sem agent_id) recebendo a resposta do Agent com PRECISA_SUBSTITUIR, mesmo sem CLAUDE_PROJECT_DIR.
  const lider = { hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: principal, tool_name: 'Agent', tool_response: { content: [{ type: 'text', text: 'PRECISA_SUBSTITUIR: C:\\dados\\progresso\\app\\x.md' }] } };
  let r = rodar(lider, undefined, null);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('C:\\dados\\progresso\\app\\x.md'), r.stdout);
  r = rodar({ hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: principal, tool_name: 'Bash' });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  r = rodar(null, '{ quebrado "agent_id"');
  assert.deepEqual([r.status, r.stdout], [0, '']);
  r = rodar({ hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: principal, agent_id: 'ag9', tool_name: 'Bash' });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /160 mil tokens/);
  r = rodar({ hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: principal, agent_id: 'ag9', tool_name: 'Bash' });
  assert.deepEqual([r.status, r.stdout], [0, '']);
});

// ───────── camada 3: o servidor avisa o líder ─────────

const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: '250',
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: SESSOES,
  ORBIT_PROJETOS_DIR: PROJETOS,
  ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_REGISTRO: '200',
  ORBIT_MS_VIGIA: '100',
  ORBIT_MS_INICIO: '2500',
  ORBIT_MS_MODELOS_INICIO: '300',
  ORBIT_MS_AVISO_FOLGA: '300',
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c = {}) => pedir('POST', r, c);
async function esperarQue(cond, ms = 8000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(80);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}

let proc;
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(async () => {
  const r = await get('/saude').catch(() => ({}));
  if (proc && r.json?.pid === proc.pid) await post('/desligar').catch(() => {});
  await espera(300);
  try { proc?.kill(); } catch {}
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch {}
  if (m?.pid && vivo(m.pid)) {
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else await matarArvore(m.pid);
    } catch {}
  }
  await espera(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

const transcriptDe = (cwd, id) => path.join(PROJETOS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const lerTranscript = (cwd, id) => { try { return fs.readFileSync(transcriptDe(cwd, id), 'utf8'); } catch { return ''; } };
// Mensagens do usuário (o Orbit) no transcript do líder com o aviso.
const avisosNoLider = (cwd, id) => lerTranscript(cwd, id).split('\n').filter((l) => l.includes('[Orbit] O subagente'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e?.type === 'user' && typeof e.message?.content === 'string')
  .map((e) => e.message.content);

test('servidor: sem o aviso direto, uma linha ao líder (instância do Orbit); com ele, ou abaixo do limite, nada', async () => {
  if ((await get('/saude').catch(() => ({}))).status) throw new Error(`porta ${PORTA} ocupada por outro servidor`);
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  await esperarQue(async () => (await get('/saude').catch(() => ({}))).json?.pid === proc.pid, 8000, 'servidor do teste no ar');

  const cwd = path.join(DADOS, 'cwd', 'lider');
  fs.mkdirSync(cwd, { recursive: true });
  const r = await post('/instancias', { pasta: cwd, texto: 'Monte o time' });
  assert.equal(r.status, 202, r.texto);
  const id = r.json.sessao;
  await esperarQue(() => lerTranscript(cwd, id).includes('"type":"assistant"'), 10000, '1ª volta do líder');
  await esperarQue(async () => (await get(`/sessao/${id}`)).json?.sessao?.controle?.ocupada === false, 8000, 'líder livre');

  const principal = transcriptDe(cwd, id);
  const base = path.dirname(principal);
  transcripts(base, id, 'semaviso', 150000);
  transcripts(base, id, 'comaviso', 150000);
  transcripts(base, id, 'pequeno', 100000);
  fs.mkdirSync(path.join(DADOS, 'avisos-subagentes'), { recursive: true });
  fs.writeFileSync(path.join(DADOS, 'avisos-subagentes', 'comaviso'), '{}'); // a camada 2 já avisou este

  const ev = (o) => post('/evento', { session_id: id, transcript_path: principal, cwd, ts: Date.now(), ...o });
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tA', tool_input: { description: 'Interface mobile', subagent_type: 'general-purpose' } });
  for (const aid of ['semaviso', 'comaviso', 'pequeno']) await ev({ hook_event_name: 'SubagentStart', agent_id: aid, agent_type: 'general-purpose' });
  await espera(900); // o tique lê os transcripts dos subagentes e marca quem passou do limite

  // Uma ferramenta só depois de passar do limite ainda não basta (o aviso direto pode vir na próxima).
  for (const aid of ['semaviso', 'comaviso', 'pequeno']) await ev({ hook_event_name: 'PostToolUse', agent_id: aid, tool_name: 'Bash', tool_use_id: `${aid}-1` });
  await espera(900);
  assert.equal(avisosNoLider(cwd, id).length, 0, 'uma ferramenta só não avisa o líder');

  for (const aid of ['semaviso', 'comaviso', 'pequeno']) await ev({ hook_event_name: 'PostToolUse', agent_id: aid, tool_name: 'Bash', tool_use_id: `${aid}-2` });
  const [texto] = await esperarQue(() => { const l = avisosNoLider(cwd, id); return l.length ? l : null; }, 8000, 'aviso ao líder');
  assert.ok(!texto.includes('\n'), 'uma linha só');
  assert.match(texto, /^\[Orbit\] O subagente "Interface mobile" \(semaviso\) está com 150 mil tokens de contexto, acima do limite de 140 mil, e o aviso direto não chegou a ele: peça que atualize o arquivo de progresso e pare, depois encerre-o e crie outro a partir desse arquivo\.$/);

  // Mais ferramentas: nada de novo (um aviso por subagente); o que foi avisado direto e o pequeno, nunca.
  for (let i = 3; i < 6; i++) for (const aid of ['semaviso', 'comaviso', 'pequeno']) await ev({ hook_event_name: 'PostToolUse', agent_id: aid, tool_name: 'Bash', tool_use_id: `${aid}-${i}` });
  await espera(1200);
  const todos = avisosNoLider(cwd, id);
  assert.equal(todos.length, 1, JSON.stringify(todos));
  assert.ok(!todos[0].includes('comaviso') && !todos[0].includes('pequeno'));

  // Outro projeto (fora da pasta do Orbit): também vale (o aviso é para qualquer projeto).
  const cwdFora = path.join(DADOS, 'fora', 'lider');
  fs.mkdirSync(cwdFora, { recursive: true });
  const r2 = await post('/instancias', { pasta: cwdFora, texto: 'Monte o time' });
  assert.equal(r2.status, 202, r2.texto);
  const id2 = r2.json.sessao;
  await esperarQue(() => lerTranscript(cwdFora, id2).includes('"type":"assistant"'), 10000, '1ª volta do líder de fora');
  await esperarQue(async () => (await get(`/sessao/${id2}`)).json?.sessao?.controle?.ocupada === false, 8000, 'líder de fora livre');
  const principal2 = transcriptDe(cwdFora, id2);
  transcripts(path.dirname(principal2), id2, 'fora1', 150000);
  const ev2 = (o) => post('/evento', { session_id: id2, transcript_path: principal2, cwd: cwdFora, ts: Date.now(), ...o });
  await ev2({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tB', tool_input: { description: 'Outro projeto', subagent_type: 'general-purpose' } });
  await ev2({ hook_event_name: 'SubagentStart', agent_id: 'fora1', agent_type: 'general-purpose' });
  await espera(900);
  for (let i = 1; i < 6; i++) await ev2({ hook_event_name: 'PostToolUse', agent_id: 'fora1', tool_name: 'Bash', tool_use_id: `fora1-${i}` });
  const fora = await esperarQue(() => { const l = avisosNoLider(cwdFora, id2); return l.length ? l : null; }, 8000, 'aviso ao líder de outro projeto');
  assert.equal(fora.length, 1);
  assert.match(fora[0], /"Outro projeto" \(fora1\)/);
  assert.equal(avisosNoLider(cwd, id).length, 1);
});
