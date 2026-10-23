#!/usr/bin/env node
// Imita o `codex app-server` (codex-cli 0.163, JSON-RPC por stdio, uma mensagem por linha, sem "jsonrpc") para os
// testes do Orbit; nunca é o codex real. Só entende a LISTA FECHADA do Orbit: initialize (+ initialized), thread/start,
// thread/resume, thread/list, thread/read, turn/start, turn/interrupt, thread/compact/start, model/list, account/read,
// account/rateLimits/read. Qualquer outro método responde erro -32601 E fica registrado como fora_da_lista.
// CODEX_HOME (obrigatório, o falso nunca usa ~/.codex): grava aqui sessions/AAAA/MM/DD/rollout-<ts>-<uuid>.jsonl
// (session_meta, turn_context, event_msg task_started/item_completed/token_count/task_complete/turn_aborted, response_item)
// e falso-log.jsonl, com uma linha por método recebido ({dir:'recebido', method, id, fora_da_lista?}) e por resposta
// do cliente a um pedido do servidor ({dir:'resposta-do-cliente', method, result|error}).
// CODEX_FALSO_ATRASO_MS: pausa entre os passos de um turno (padrão 5).
// Roteiro pelo texto da mensagem do usuário em turn/start:
//   (nada)      deltas item/agentMessage/delta + item/completed + thread/tokenUsage/updated + turn/completed
//   [comando]   pede item/commandExecution/requestApproval; accept* executa, decline segue, cancel interrompe
//   [arquivo]   idem com item/fileChange/requestApproval
//   [arquivo-em:<caminho>] item/started (fileChange com o caminho, relativo ao cwd ou absoluto) + item/fileChange/requestApproval
//   C1: também responde config/read, mcpServerStatus/list e thread/unsubscribe (ver falsoConfig: CODEX_HOME/falso-config.json)
//   [pergunta]  pede item/tool/requestUserInput e devolve a resposta no texto do agente
//   [permissao] item/permissions/requestApproval (escrever no projeto); [permissao-ampla] pede a raiz do disco; [permissao-fora] pede uma pasta vizinha;
//   [raiz] fileChange com grantRoot fora do projeto; [legado] execCommandApproval (protocolo antigo): o texto final traz a resposta do cliente
//   [dois]      dois pedidos de comando abertos ao mesmo tempo
//   Interromper com um pedido aberto manda serverRequest/resolved (CODEX_FALSO_SEM_RESOLVIDO=1 não manda).
//   [demorar]   turno longo até turn/interrupt (ou 60 s)
//   [proibido]  manda item/tool/call (fora da lista do Orbit) e registra o que o cliente respondeu
//   [elicitacao] manda mcpServer/elicitation/request (fora da lista) e devolve a resposta no texto; [push] = [comando] com `git push origin main`
//   O log 'recebido' de thread/start|resume e turn/start leva também approvalPolicy, sandbox, sandboxPolicy, developerInstructions,
//   config e disabledPluginIds quando vierem (testes do escritório).
//   [morrer]    o processo sai (código 3) antes de responder o turn/start
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const HOME = process.env.CODEX_HOME;
if (!HOME) { process.stderr.write('codex-falso: defina CODEX_HOME (o falso não usa ~/.codex)\n'); process.exit(2); }
const ATRASO = Number(process.env.CODEX_FALSO_ATRASO_MS ?? 5);
const VERSAO = '0.163.0-falso';
const JANELA = 258400;
const MODELO_PADRAO = 'gpt-5-codex';

const agora = () => new Date().toISOString();
const seg = () => Math.floor(Date.now() / 1000);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

// Registro do que o falso recebeu e do que o cliente respondeu (os testes provam a lista fechada por aqui).
function registrar(obj) {
  try { fs.mkdirSync(HOME, { recursive: true }); fs.appendFileSync(path.join(HOME, 'falso-log.jsonl'), JSON.stringify({ ts: agora(), ...obj }) + '\n'); } catch {}
}

const enviar = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {} };
const notificar = (method, params) => enviar({ method, params });

// Pedidos do servidor ao cliente: resolve {result} ou {error}.
const aguardando = new Map();
let idServidor = 1000;
function pedirAoCliente(method, params) {
  const id = ++idServidor;
  const pr = new Promise((resolve) => { aguardando.set(id, { method, resolve }); enviar({ id, method, params }); });
  pr.id = id;
  return pr;
}

// ---- Rollouts ----
const threads = new Map(); // id → thread

function novoRollout(thread) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dir = path.join(HOME, 'sessions', String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), p2(d.getUTCDate()));
  fs.mkdirSync(dir, { recursive: true });
  const ts = d.toISOString().slice(0, 19).replace(/:/g, '-');
  thread.path = path.join(dir, `rollout-${ts}-${thread.id}.jsonl`);
  thread.ordinal = 0;
}
function gravar(thread, type, payload) {
  if (!thread.path) return;
  try { fs.appendFileSync(thread.path, JSON.stringify({ timestamp: agora(), ordinal: thread.ordinal++, type, payload }) + '\n'); } catch {}
}
const evento = (thread, tipo, resto = {}) => gravar(thread, 'event_msg', { type: tipo, ...resto });

function usoZerado() { return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }; }
const limites = { primary: 12, secondary: 5 };
function rateLimitsRollout() {
  const t = seg();
  return { primary: { used_percent: limites.primary, window_minutes: 300, resets_at: t + 3600 }, secondary: { used_percent: limites.secondary, window_minutes: 10080, resets_at: t + 86400 }, plan_type: 'plus' };
}
function rateLimitsApi() {
  const t = seg();
  return { limitId: 'codex', planType: 'plus', primary: { usedPercent: limites.primary, windowDurationMins: 300, resetsAt: t + 3600 }, secondary: { usedPercent: limites.secondary, windowDurationMins: 10080, resetsAt: t + 86400 } };
}

// Objeto Thread do esquema v2 (turns só quando pedido).
function paraThread(t, comTurnos = false) {
  return {
    id: t.id, sessionId: t.id, cliVersion: VERSAO, createdAt: t.criadoEm, updatedAt: t.atualizadoEm, cwd: t.cwd, ephemeral: false,
    modelProvider: 'openai', model: t.model, reasoningEffort: t.effort, name: null, originator: 'orbit', preview: t.preview || '',
    projectId: null, path: t.path || null, source: 'appServer', status: { type: t.turnoAtual ? 'active' : 'idle', ...(t.turnoAtual ? { activeFlags: [] } : {}) },
    turns: comTurnos ? t.turnos.map(paraTurno) : [],
  };
}
const paraTurno = (u) => ({ id: u.id, items: u.items, status: u.status, startedAt: u.inicio, completedAt: u.fim ?? null, durationMs: u.duracao ?? null, error: null });

function criarThread({ cwd, model, effort, id = crypto.randomUUID() }) {
  const t = { id, cwd: cwd || process.cwd(), model: model || MODELO_PADRAO, effort: effort || 'medium', criadoEm: seg(), atualizadoEm: seg(), preview: '', turnos: [], tokens: usoZerado(), turnoAtual: null, aprovacao: 'on-request', sandbox: 'workspace-write', nItens: 0 };
  threads.set(id, t);
  novoRollout(t);
  gravar(t, 'session_meta', { id, session_id: id, cwd: t.cwd, originator: 'orbit', cli_version: VERSAO, source: 'exec', thread_source: 'user', model_provider: 'openai' });
  evento(t, 'thread_settings_applied', { thread_settings: { model: t.model, reasoning_effort: t.effort, approval_policy: t.aprovacao, cwd: t.cwd } });
  return t;
}

// Acha o thread na memória ou, depois de um reinício do falso, pelo rollout em disco.
function arquivosDeRollout() {
  const r = [];
  const andar = (d, n) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (e.isDirectory() && n < 3) andar(path.join(d, e.name), n + 1); else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) r.push(path.join(d, e.name)); }
  };
  andar(path.join(HOME, 'sessions'), 0);
  return r;
}
function carregarDoArquivo(arq) {
  try {
    const linhas = fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const meta = linhas.find((l) => l.type === 'session_meta')?.payload;
    if (!meta) return null;
    if (threads.has(meta.id)) return threads.get(meta.id);
    const ctx = [...linhas].reverse().find((l) => l.type === 'turn_context')?.payload;
    const prim = linhas.find((l) => l.payload?.item?.type === 'UserMessage')?.payload.item.content?.[0]?.text || '';
    const t = { id: meta.id, cwd: meta.cwd, model: ctx?.model || MODELO_PADRAO, effort: ctx?.effort || 'medium', criadoEm: Math.floor(Date.parse(linhas[0].timestamp) / 1000), atualizadoEm: Math.floor(Date.parse(linhas.at(-1).timestamp) / 1000), preview: prim, turnos: [], tokens: usoZerado(), turnoAtual: null, aprovacao: 'on-request', sandbox: 'workspace-write', nItens: 0, path: arq, ordinal: linhas.length };
    threads.set(t.id, t);
    return t;
  } catch { return null; }
}
const achar = (id) => threads.get(id) || arquivosDeRollout().filter((a) => a.endsWith(`-${id}.jsonl`)).map(carregarDoArquivo).find(Boolean) || null;

// ---- Turnos ----
function sandboxPolicy(t) {
  if (t.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (t.sandbox === 'read-only') return { type: 'readOnly' };
  return { type: 'workspaceWrite', writableRoots: [t.cwd] };
}
function textoDoInput(input) {
  return (Array.isArray(input) ? input : []).filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
}
const idItem = (t) => `item-${++t.nItens}`;

// Espera ms ou a interrupção do turno; devolve true se foi interrompido.
async function esperar(u, ms) {
  if (u.interrompido) return true;
  await Promise.race([dorme(ms), u.sinal]);
  return u.interrompido;
}
// Espera a resposta do cliente a um pedido do servidor ou a interrupção; null se interrompido.
async function pedirComInterrupcao(u, method, params) {
  const pr = pedirAoCliente(method, params);
  const r = await Promise.race([pr, u.sinal.then(() => null)]);
  if (r === null) { // interrompido com o pedido aberto: o app-server real avisa que o pedido foi resolvido
    aguardando.delete(pr.id);
    if (!process.env.CODEX_FALSO_SEM_RESOLVIDO) notificar('serverRequest/resolved', { threadId: params.threadId || params.conversationId, requestId: pr.id });
  }
  return r;
}

function gastar(t, texto, resposta) {
  const input = 800 + texto.length * 2, output = 40 + resposta.length;
  const ult = { input_tokens: input, cached_input_tokens: Math.floor(input / 2), output_tokens: output, reasoning_output_tokens: 10, total_tokens: input + output };
  for (const k of Object.keys(ult)) t.tokens[k] += ult[k];
  // o contexto cresce a cada turno; ult guarda o consumo do turno
  t.ultimo = ult;
  limites.primary = Math.min(100, limites.primary + 1);
}
function infoTokens(t) {
  return { total_token_usage: { ...t.tokens }, last_token_usage: { ...(t.ultimo || usoZerado()) }, model_context_window: JANELA };
}
function avisarTokens(t, u) {
  const b = (x) => ({ inputTokens: x.input_tokens, cachedInputTokens: x.cached_input_tokens, outputTokens: x.output_tokens, reasoningOutputTokens: x.reasoning_output_tokens, totalTokens: x.total_tokens });
  notificar('thread/tokenUsage/updated', { threadId: t.id, turnId: u.id, tokenUsage: { total: b(t.tokens), last: b(t.ultimo || usoZerado()), modelContextWindow: JANELA } });
  evento(t, 'token_count', { info: infoTokens(t), rate_limits: rateLimitsRollout() });
  notificar('account/rateLimits/updated', { rateLimits: rateLimitsApi() }); // o app-server real avisa o uso depois de cada chamada
}

function itemAgente(t, texto) { return { type: 'agentMessage', id: idItem(t), text: texto, phase: 'final_answer' }; }
function concluirItem(t, u, item, tipoRollout, extra = {}) {
  u.items.push(item);
  notificar('item/completed', { threadId: t.id, turnId: u.id, item, completedAtMs: Date.now() });
  evento(t, 'item_completed', { item: { type: tipoRollout, id: item.id, ...extra } });
}

async function falarAgente(t, u, texto, fase = 'final_answer') {
  const id = idItem(t);
  notificar('item/started', { threadId: t.id, turnId: u.id, item: { type: 'agentMessage', id, text: '' }, startedAtMs: Date.now() });
  const pedacos = texto.match(/.{1,12}/gs) || [];
  for (const p of pedacos) {
    if (await esperar(u, ATRASO)) return false;
    notificar('item/agentMessage/delta', { threadId: t.id, turnId: u.id, itemId: id, delta: p });
  }
  const item = { type: 'agentMessage', id, text: texto, phase: fase };
  concluirItem(t, u, item, 'AgentMessage', { phase: fase, content: [{ type: 'Text', text: texto }] });
  gravar(t, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texto }] });
  if (fase !== 'commentary') u.ultimaResposta = texto;
  return true;
}

async function rodarTurno(t, u, texto) {
  const cid = t.id;
  notificar('turn/started', { threadId: cid, turn: paraTurno(u) });
  gravar(t, 'turn_context', { turn_id: u.id, cwd: t.cwd, approval_policy: t.aprovacao, sandbox_policy: { type: t.sandbox, writable_roots: [t.cwd] }, model: t.model, effort: t.effort });
  evento(t, 'task_started', { turn_id: u.id, model_context_window: JANELA });
  const user = { type: 'userMessage', id: idItem(t), content: [{ type: 'text', text: texto, text_elements: [] }] };
  concluirItem(t, u, user, 'UserMessage', { content: [{ type: 'text', text: texto }] });
  gravar(t, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: texto }] });
  if (!t.preview) t.preview = texto;

  let resposta = 'Feito (resposta do Codex falso).';
  let seguiu = true;
  if (texto.includes('[demorar]')) {
    seguiu = await falarAgente(t, u, 'Trabalhando…', 'commentary') && !(await esperar(u, 60000));
    if (seguiu) resposta = 'Demorou, mas terminou.';
  } else if (texto.includes('[comando]') || texto.includes('[push]')) {
    const itemId = idItem(t);
    const r = await pedirComInterrupcao(u, 'item/commandExecution/requestApproval', { threadId: cid, turnId: u.id, itemId, startedAtMs: Date.now(), command: texto.includes('[push]') ? 'git push origin main' : 'echo orbit', cwd: t.cwd, reason: 'Rodar um comando de teste' });
    if (!r) seguiu = false;
    else {
      const dec = r.result?.decision;
      const ok = dec === 'accept' || dec === 'acceptForSession' || (dec && typeof dec === 'object');
      if (dec === 'cancel') seguiu = false;
      else {
        const item = { type: 'commandExecution', id: itemId, command: 'echo orbit', commandActions: [], cwd: t.cwd, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'orbit\n' : null, exitCode: ok ? 0 : null, durationMs: 3 };
        concluirItem(t, u, item, 'CommandExecution', { command: ['bash', '-lc', 'echo orbit'], status: item.status, exit_code: item.exitCode });
        resposta = ok ? 'Comando executado.' : 'Comando recusado.';
      }
    }
  } else if (texto.includes('[arquivo-em:')) { // C1: item/started (fileChange com changes) antes do pedido; caminho relativo ao cwd ou absoluto
    const alvo = path.resolve(t.cwd || '.', /\[arquivo-em:([^\]]+)\]/.exec(texto)[1].trim());
    const itemId = idItem(t);
    const item = { type: 'fileChange', id: itemId, changes: [{ path: alvo, kind: { type: 'update', move_path: null }, diff: '+orbit\n' }], status: 'inProgress' };
    notificar('item/started', { threadId: t.id, turnId: u.id, item, startedAtMs: Date.now() });
    const r = await pedirComInterrupcao(u, 'item/fileChange/requestApproval', { threadId: cid, turnId: u.id, itemId, startedAtMs: Date.now(), reason: 'Editar um arquivo' });
    if (!r || r.result?.decision === 'cancel') seguiu = false;
    else {
      const ok = r.result?.decision === 'accept' || r.result?.decision === 'acceptForSession';
      concluirItem(t, u, { ...item, status: ok ? 'completed' : 'declined' }, 'FileChange', { changes: item.changes, status: ok ? 'completed' : 'declined' });
      resposta = ok ? 'Arquivo gravado.' : 'Arquivo recusado.';
    }
  } else if (texto.includes('[arquivo]')) {
    const itemId = idItem(t);
    const r = await pedirComInterrupcao(u, 'item/fileChange/requestApproval', { threadId: cid, turnId: u.id, itemId, startedAtMs: Date.now(), reason: 'Gravar um arquivo de teste' });
    if (!r) seguiu = false;
    else {
      const dec = r.result?.decision;
      if (dec === 'cancel') seguiu = false;
      else {
        const ok = dec === 'accept' || dec === 'acceptForSession';
        const item = { type: 'fileChange', id: itemId, changes: [{ path: path.join(t.cwd, 'falso.txt'), kind: { type: 'add' }, diff: '+orbit\n' }], status: ok ? 'completed' : 'declined' };
        concluirItem(t, u, item, 'FileChange', { changes: item.changes, status: item.status });
        resposta = ok ? 'Arquivo gravado.' : 'Arquivo recusado.';
      }
    }
  } else if (texto.includes('[pergunta]')) {
    const r = await pedirComInterrupcao(u, 'item/tool/requestUserInput', { threadId: cid, turnId: u.id, itemId: idItem(t), isBlocking: true,
      questions: [{ id: 'q1', header: 'Cor', question: 'Qual cor?', isOther: true, isSecret: false, options: [{ label: 'azul', description: 'Azul' }, { label: 'verde', description: 'Verde' }] }] });
    if (!r) seguiu = false;
    else resposta = r.error ? `Pergunta sem resposta (${r.error.code}).` : `Resposta recebida: ${r.result?.answers?.q1?.answers?.join(', ') ?? '(vazia)'}.`;
  } else if (texto.includes('[dois]')) { // dois pedidos de comando ao mesmo tempo (fila de 2)
    const rs = await Promise.all([1, 2].map((n) => pedirComInterrupcao(u, 'item/commandExecution/requestApproval', { threadId: cid, turnId: u.id, itemId: idItem(t), startedAtMs: Date.now(), command: `echo ${n}`, cwd: t.cwd })));
    if (rs.some((r) => !r)) seguiu = false; else resposta = `Decisões: ${rs.map((r) => r.result?.decision).join(',')}`;
  } else if (texto.includes('[permissao-ampla]') || texto.includes('[permissao-fora]') || texto.includes('[permissao]') || texto.includes('[legado]') || texto.includes('[raiz]')) {
    // Cenários da etapa 3: o texto do agente devolve o que o cliente respondeu (JSON) para os testes conferirem.
    let r;
    if (texto.includes('[permissao-fora]')) r = await pedirComInterrupcao(u, 'item/permissions/requestApproval', { threadId: cid, turnId: u.id, itemId: idItem(t), startedAtMs: Date.now(), cwd: t.cwd, reason: 'Gravar fora', permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: path.resolve(t.cwd || '.', '..', 'fora-do-projeto') } }] } } });
    else if (texto.includes('[permissao-ampla]')) r = await pedirComInterrupcao(u, 'item/permissions/requestApproval', { threadId: cid, turnId: u.id, itemId: idItem(t), startedAtMs: Date.now(), cwd: t.cwd, reason: 'Acesso a tudo', permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'root' } } }] } } });
    else if (texto.includes('[permissao]')) r = await pedirComInterrupcao(u, 'item/permissions/requestApproval', { threadId: cid, turnId: u.id, itemId: idItem(t), startedAtMs: Date.now(), cwd: t.cwd, reason: 'Gravar no projeto', permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'project_roots', subpath: null } } }] } } });
    else if (texto.includes('[raiz]')) r = await pedirComInterrupcao(u, 'item/fileChange/requestApproval', { threadId: cid, turnId: u.id, itemId: idItem(t), startedAtMs: Date.now(), reason: 'Gravar fora', grantRoot: path.join(path.dirname(t.cwd), 'fora-do-projeto') });
    else r = await pedirComInterrupcao(u, 'execCommandApproval', { conversationId: cid, callId: idItem(t), command: ['echo', 'legado'], cwd: t.cwd, parsedCmd: [], reason: 'Comando do protocolo antigo' });
    if (!r) seguiu = false;
    else resposta = `Resposta: ${JSON.stringify(r.error ? { error: r.error.code } : r.result)}`;
  } else if (texto.includes('[proibido]')) {
    const r = await pedirComInterrupcao(u, 'item/tool/call', { threadId: cid, turnId: u.id, callId: 'call-1', tool: 'qualquer', arguments: {} });
    if (!r) seguiu = false;
    else resposta = r.error ? `Pedido fora da lista recusado (${r.error.code}).` : r.result?.success === false ? 'Pedido fora da lista recusado (success:false).' : 'Pedido fora da lista foi ACEITO (errado).';
  } else if (texto.includes('[elicitacao]')) {
    const r = await pedirComInterrupcao(u, 'mcpServer/elicitation/request', { threadId: cid, turnId: u.id, serverName: 'falso-mcp', mode: 'form', message: 'Confirma?', requestedSchema: { type: 'object', properties: {} } });
    if (!r) seguiu = false;
    else resposta = `Elicitação: ${JSON.stringify(r.error ? { error: r.error.code } : r.result)}`;
  }

  if (seguiu) seguiu = await falarAgente(t, u, resposta);
  const fim = Date.now();
  u.fim = seg(); u.duracao = fim - u.inicioMs;
  if (!seguiu || u.interrompido) {
    u.status = 'interrupted';
    evento(t, 'turn_aborted', { turn_id: u.id, reason: 'interrupted' });
  } else {
    u.status = 'completed';
    gastar(t, texto, u.ultimaResposta || resposta);
    avisarTokens(t, u);
    evento(t, 'task_complete', { turn_id: u.id, last_agent_message: u.ultimaResposta || resposta, duration_ms: u.duracao });
  }
  t.turnoAtual = null; t.atualizadoEm = seg();
  notificar('turn/completed', { threadId: cid, turn: paraTurno(u) });
}

// ---- Métodos ----
const MODELOS = [
  { id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', description: 'Modelo falso padrão', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', description: 'Modelo falso geral', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'] },
  { id: 'gpt-5-mini', model: 'gpt-5-mini', displayName: 'GPT-5 Mini', description: 'Modelo falso rápido', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium'] },
].map((m) => ({ ...m, supportedReasoningEfforts: m.supportedReasoningEfforts.map((e) => ({ reasoningEffort: e, description: `Esforço ${e}` })) }));

function erroRpc(id, code, message) { enviar({ id, error: { code, message } }); }

function respostaDeThread(t, p) {
  return { approvalPolicy: t.aprovacao, approvalsReviewer: 'user', cwd: t.cwd, model: t.model, modelProvider: 'openai', reasoningEffort: t.effort, sandbox: sandboxPolicy(t), thread: paraThread(t, p) };
}
function aplicarConfig(t, p) {
  if (p.model) t.model = p.model;
  if (typeof p.approvalPolicy === 'string') t.aprovacao = p.approvalPolicy;
  if (typeof p.sandbox === 'string') t.sandbox = p.sandbox;
  if (p.cwd) t.cwd = p.cwd;
  if (p.config && typeof p.config === 'object') t.override = p.config;
}
// C1: CODEX_HOME/falso-config.json (opcional, relido a cada pedido) simula a config efetiva e os MCP do Codex real:
// { efetivo:{...} (config/read), servidores:['nome', ...] (MCP configurados: no thread ficam 'disabled' só se o override
//   do thread/start|resume trouxer mcp_servers.<nome>.enabled=false; senão 'connected'), falharConfig, falharStatus }.
function falsoConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'falso-config.json'), 'utf8')) || {}; } catch { return {}; }
}

let inicializado = false;

const metodos = {
  'thread/start': (p) => {
    const t = criarThread({ cwd: p.cwd, model: p.model });
    aplicarConfig(t, p);
    const r = respostaDeThread(t, false);
    setTimeout(() => notificar('thread/started', { thread: paraThread(t) }), 0);
    return r;
  },
  'thread/resume': (p, id) => {
    const t = achar(p.threadId);
    if (!t) return erroRpc(id, -32600, `thread não encontrada: ${p.threadId}`);
    aplicarConfig(t, p);
    return respostaDeThread(t, false);
  },
  'thread/list': (p) => {
    const todos = arquivosDeRollout().map(carregarDoArquivo).filter(Boolean);
    for (const t of threads.values()) if (!todos.includes(t)) todos.push(t);
    let l = todos.sort((a, b) => b.atualizadoEm - a.atualizadoEm);
    if (typeof p.cwd === 'string') l = l.filter((t) => t.cwd === p.cwd);
    if (p.limit) l = l.slice(0, p.limit);
    return { data: l.map((t) => paraThread(t)), nextCursor: null };
  },
  'thread/read': (p, id) => {
    const t = achar(p.threadId);
    if (!t) return erroRpc(id, -32600, `thread não encontrada: ${p.threadId}`);
    return { thread: paraThread(t, !!p.includeTurns) };
  },
  'turn/start': (p, id) => {
    const t = achar(p.threadId);
    if (!t) return erroRpc(id, -32600, `thread não encontrada: ${p.threadId}`);
    if (t.turnoAtual) return erroRpc(id, -32600, 'já há um turno em andamento');
    const texto = textoDoInput(p.input);
    if (texto.includes('[morrer]')) process.exit(3);
    if (p.model) t.model = p.model;
    if (p.effort) t.effort = p.effort;
    if (p.cwd) t.cwd = p.cwd;
    let acordar; const sinal = new Promise((r) => { acordar = r; });
    const u = { id: crypto.randomUUID(), items: [], status: 'inProgress', inicio: seg(), inicioMs: Date.now(), interrompido: false, sinal, acordar };
    t.turnos.push(u); t.turnoAtual = u;
    setTimeout(() => { rodarTurno(t, u, texto).catch((e) => { process.stderr.write(`codex-falso: ${e.stack}\n`); }); }, ATRASO);
    return { turn: paraTurno(u) };
  },
  'turn/interrupt': (p, id) => {
    const t = achar(p.threadId);
    const u = t?.turnoAtual;
    if (!u || u.id !== p.turnId) return erroRpc(id, -32600, 'turno não está em andamento');
    u.interrompido = true; u.acordar();
    return {};
  },
  'thread/compact/start': (p, id) => {
    const t = achar(p.threadId);
    if (!t) return erroRpc(id, -32600, `thread não encontrada: ${p.threadId}`);
    const turnoId = t.turnos.at(-1)?.id || crypto.randomUUID();
    setTimeout(() => {
      for (const k of Object.keys(t.tokens)) t.tokens[k] = Math.floor(t.tokens[k] * 0.1);
      t.ultimo = usoZerado();
      gravar(t, 'compacted', { message: '' });
      notificar('thread/compacted', { threadId: t.id, turnId: turnoId });
      avisarTokens(t, { id: turnoId });
    }, ATRASO);
    return {};
  },
  'model/list': () => ({ data: MODELOS, nextCursor: null }),
  'account/read': () => ({ account: { type: 'chatgpt', email: 'falso@example.com', planType: 'plus' }, requiresOpenaiAuth: false }),
  'account/rateLimits/read': () => ({ rateLimits: rateLimitsApi(), rateLimitsByLimitId: null }),
  'config/read': (p, id) => {
    const f = falsoConfig();
    if (f.falharConfig) return erroRpc(id, -32603, 'config/read indisponível (falso)');
    return { config: f.efetivo && typeof f.efetivo === 'object' ? f.efetivo : {}, origins: {} };
  },
  'mcpServerStatus/list': (p, id) => {
    const f = falsoConfig();
    if (f.falharStatus) return erroRpc(id, -32603, 'mcpServerStatus/list indisponível (falso)');
    const t = p.threadId ? achar(p.threadId) : null;
    const desl = (n) => t?.override?.mcp_servers?.[n]?.enabled === false;
    const data = (Array.isArray(f.servidores) ? f.servidores : []).map((n) => ({ name: n, pluginId: null, authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [], runtimeStatus: desl(n) ? 'disabled' : 'connected' }));
    return { data, nextCursor: null };
  },
  'thread/unsubscribe': (p) => ({ status: achar(p.threadId) ? 'unsubscribed' : 'notLoaded' }),
};

// Campos de segurança do thread/start|resume|turn/start que os testes de escritório conferem (só os presentes).
function paramsSeguranca(p) {
  const o = {};
  for (const k of ['approvalPolicy', 'sandbox', 'sandboxPolicy', 'developerInstructions', 'config', 'disabledPluginIds']) if (p && p[k] !== undefined) o[k] = p[k];
  return o;
}
function tratar(msg) {
  // resposta do cliente a um pedido do servidor
  if (msg.method === undefined && msg.id !== undefined) {
    const a = aguardando.get(msg.id);
    if (!a) return;
    aguardando.delete(msg.id);
    registrar({ dir: 'resposta-do-cliente', method: a.method, ...(msg.error ? { error: msg.error } : { result: msg.result }) });
    a.resolve(msg.error ? { error: msg.error } : { result: msg.result });
    return;
  }
  registrar({ dir: 'recebido', method: msg.method, ...(msg.id !== undefined ? { id: msg.id } : {}), ...(['thread/start', 'thread/resume', 'turn/start'].includes(msg.method) ? { model: msg.params?.model, effort: msg.params?.effort, ...paramsSeguranca(msg.params) } : {}), ...(Object.hasOwn(metodos, msg.method) || msg.method === 'initialize' || msg.method === 'initialized' ? {} : { fora_da_lista: true }) });
  if (msg.method === 'initialized') return;
  if (msg.id === undefined) return; // notificação desconhecida: ignora
  if (msg.method === 'initialize') {
    if (inicializado) return erroRpc(msg.id, -32600, 'Already initialized');
    inicializado = true;
    return enviar({ id: msg.id, result: { userAgent: `orbit/${VERSAO}`, codexHome: HOME, platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform } });
  }
  if (!Object.hasOwn(metodos, msg.method)) return erroRpc(msg.id, -32601, `Método desconhecido: ${msg.method}`);
  if (!inicializado) return erroRpc(msg.id, -32002, 'Not initialized');
  try {
    const r = metodos[msg.method](msg.params || {}, msg.id);
    if (r !== undefined) enviar({ id: msg.id, result: r });
  } catch (e) { erroRpc(msg.id, -32603, String(e?.message || e)); }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (linha) => {
  if (!linha.trim()) return;
  let msg; try { msg = JSON.parse(linha); } catch { return; }
  tratar(msg);
});
// EOF no stdin: o app-server real encerra; o falso também, deixando a saída escoar.
rl.on('close', () => { setTimeout(() => process.exit(0), 20); });
