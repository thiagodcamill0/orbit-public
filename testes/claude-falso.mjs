// Imita o claude.exe 2.1.300 em `-p --input-format stream-json --output-format stream-json`
// para os testes do controle (ORBIT_CLAUDE_BIN=testes/claude-falso.mjs). Escreve um transcript
// jsonl realista em ORBIT_PROJETOS_DIR/<proj>/<id>.jsonl e o registro em GERENCIADOR_SESSOES_DIR.
// FALSO_MODO (lista com vírgulas): falha_inicio, mudo, compact_erro, ignora_eof, sem_eco,
// rate_limit (1ª volta emite o rate_limit_event da 2.1.300, 32% e 56%), rate_limit_parcial (só five_hour).
// FALSO_LOG: arquivo onde cada execução anexa {argv, cwd, envClaude}.
// Na mensagem: DEMORA espera FALSO_DEMORA_MS; DEMORA:<ms> espera <ms> (rodada 6: reinício no meio da volta);
// PERMISSAO pede permissão do Write; com CANCELA, cancela o pedido sozinho (control_cancel_request).
// Rodada 6, etapa 2: --session-id (sessão nova; o transcript nasce na 1ª mensagem, na pasta com o cwd
// trocado por "-"), --no-session-persistence (sem transcript: a sonda dos modelos), --model/--effort/
// --permission-mode, e os pedidos initialize (models), set_model, apply_flag_settings (esforço inválido
// é ignorado em silêncio, como no real), get_settings ({applied:{model, effort}}), generate_session_title
// (grava ai-title) e rename_session (grava custom-title). FALSO_MODO sem_titulo: generate_session_title
// falha (o Orbit cai no rename_session). A pasta da sessão nova pode ter falso-modo.txt antes de criar.
// Rodada 6, etapa 3 (formatos vistos no 2.1.300 real): --include-partial-messages (stream_event message_start →
// content_block_start text → content_block_delta text_delta… → a `assistant` do bloco, com o uuid da entrada do
// transcript → content_block_stop → message_delta → message_stop); LONGA na mensagem: resposta de 40 pedaços a
// cada 50 ms. interrupt: a volta acaba com result error_during_execution, "[Request interrupted by user]" no
// transcript e control_cancel_request dos pedidos abertos. set_permission_mode: system/status {permissionMode}.
// PERMISSAO traz permission_suggestions (addRules + setMode acceptEdits) e devolve no tool_result o que recebeu;
// PERGUNTA: AskUserQuestion (uma simples e uma múltipla), o tool_result traz as answers; PLANO: ExitPlanMode
// {plan}; aprovado → modo default (ou o do setMode recebido). TAREFAS / TAREFAS_FIM: background_tasks_changed
// (com uma tarefa ambient) e a lista vazia. O result traz modelUsage[modelo].contextWindow (200000) e a resposta
// usage com input 10 + cache_read 1000 + cache_creation 500. Compactação automática (20/10): <cwd>/falso-ctx.txt troca o
// cache_read da próxima resposta (é apagado ao ser lido), e o pre_tokens da compactação passa a ser esse contexto.
// Rodada 6, etapa 4: CRON na mensagem emite um tool_use CronCreate (CRON_FIM, um CronDelete); o --resume do
// acordar retoma o transcript (o argv vai no FALSO_LOG com --model/--effort/--permission-mode).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// get_skills_dialog (17/10): as linhas do /skills como o 2.1.300 real, lidas de <cwd>/.claude/skills (project) e
// de FALSO_SKILLS_PESSOAIS (user), com o skillOverrides do <cwd>/.claude/settings.json. Nome repetido: a pessoal
// vence (advertised), como no real. FALSO_SKILLS_PLUGIN=nome acrescenta uma de plugin travada.
function skillsDoDialogo() {
  const ler = (dir, source) => {
    let n = [];
    try { n = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return n.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'synced' && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
      .map((d) => {
        const t = fs.readFileSync(path.join(dir, d.name, 'SKILL.md'), 'utf8');
        return { name: d.name, display_name: d.name, description: (/^description:\s*(.*)$/m.exec(t) || [])[1] || '', source, tokens: 10, state: 'on', advertised: true, handles: {} };
      });
  };
  let ov = {};
  try { ov = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude', 'settings.json'), 'utf8')).skillOverrides || {}; } catch {}
  const proj = ler(path.join(process.cwd(), '.claude', 'skills'), 'project');
  const pess = process.env.FALSO_SKILLS_PESSOAIS ? ler(process.env.FALSO_SKILLS_PESSOAIS, 'user') : [];
  for (const p of proj) if (pess.some((u) => u.name === p.name)) p.advertised = false;
  const l = [...proj, ...pess];
  if (process.env.FALSO_SKILLS_PLUGIN) l.push({ name: process.env.FALSO_SKILLS_PLUGIN, display_name: process.env.FALSO_SKILLS_PLUGIN, description: 'Plugin falso', source: 'plugin', tokens: 5, state: 'on', locked_by: 'plugin', advertised: true, handles: {} });
  for (const s of l) if (ov[s.name] && !s.locked_by) { s.state = ov[s.name]; if (s.state === 'off' || s.state === 'user-invocable-only') s.advertised = false; }
  return l;
}

// mcp_status (17/10): como o 2.1.300 real, lê os .mcp.json da pasta e das de cima (project) e o
// <GERENCIADOR_CASA>/.claude.json (user e local), respeitando o disabledMcpjsonServers do --settings e do
// .claude/settings.json (o rejeitado some da lista) e o disabledMcpServers do projeto (status disabled). Conecta
// quem tem todas as ${VAR} no env; senão, failed "Missing environment variables". URL com "falha" → failed. O 1º
// mcp_status responde "pending" (conectando) para o Orbit esperar. FALSO_LOG_MCP: cada execução anexa
// {argv, conectaria: [nomes], env: {VAR: tamanho}}.
function servidoresMcp() {
  const lerJ = (a) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch { return null; } };
  let flag = {};
  const iS = process.argv.indexOf('--settings');
  if (iS >= 0) try { flag = JSON.parse(process.argv[iS + 1]); } catch {}
  const proj = lerJ(path.join(process.cwd(), '.claude', 'settings.json')) || {};
  const rejeitados = new Set([...(flag.disabledMcpjsonServers || []), ...(proj.disabledMcpjsonServers || [])]);
  const l = [];
  const vistos = new Set();
  let d = process.cwd();
  for (;;) {
    const j = lerJ(path.join(d, '.mcp.json'));
    for (const [name, config] of Object.entries(j?.mcpServers || {})) if (!rejeitados.has(name) && !vistos.has(name)) { vistos.add(name); l.push({ name, config, scope: 'project' }); }
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  const cj = process.env.GERENCIADOR_CASA ? lerJ(path.join(process.env.GERENCIADOR_CASA, '.claude.json')) || {} : {};
  const alvo = process.cwd().replace(/\\/g, '/').toLowerCase();
  const pj = Object.entries(cj.projects || {}).find(([k]) => k.replace(/\\/g, '/').toLowerCase() === alvo)?.[1] || {};
  for (const [name, config] of Object.entries(pj.mcpServers || {})) l.push({ name, config, scope: 'local' });
  for (const [name, config] of Object.entries(cj.mcpServers || {})) l.push({ name, config, scope: 'user' });
  if (process.env.FALSO_MCP_PLUGIN) l.push({ name: process.env.FALSO_MCP_PLUGIN, config: { type: 'stdio', command: 'node', args: ['plugin.js'] }, scope: 'plugin' });
  const desligados = new Set(pj.disabledMcpServers || []);
  return l.map((s) => {
    const vars = [...JSON.stringify(s.config).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    const faltam = vars.filter((v) => !(v in process.env));
    if (desligados.has(s.name)) return { ...s, status: 'disabled' };
    if (faltam.length) return { ...s, status: 'failed', error: 'Missing environment variables: ' + faltam.join(', ') };
    if (/falha/.test(String(s.config.url || ''))) return { ...s, status: 'failed', error: 'getaddrinfo ENOTFOUND falha.invalid' };
    return { ...s, status: 'connected', vars };
  });
}
let mcpPedidos = 0;
if (process.env.FALSO_LOG_MCP) {
  const l = servidoresMcp();
  const env = {};
  for (const s of l) for (const v of s.vars || []) env[v] = String(process.env[v]).length;
  fs.appendFileSync(process.env.FALSO_LOG_MCP, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), conectaria: l.filter((s) => s.status === 'connected').map((s) => s.name), env }) + '\n');
}

const argv = process.argv.slice(2);
const opc = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

// `auth status|login|logout` (19/10, conta do Claude no menu de perfil), como o 2.1.272 real. O estado fica em
// FALSO_AUTH ({loggedIn, email, subscriptionType, orgName}); FALSO_LOG_AUTH anexa cada argv. O login escreve a URL,
// espera FALSO_AUTH_LOGIN_MS (padrão 800) e entra com o --email (ou nova@exemplo.com). FALSO_AUTH_MODO:
// login_falha (sai com 1 sem entrar), login_espera (só sai quando morto), logout_falha (sai com 1 sem sair); ou o
// campo `modo` do próprio FALSO_AUTH (o teste troca sem reiniciar o servidor).
if (argv[0] === 'auth') {
  const arq = process.env.FALSO_AUTH;
  const ler = () => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return { loggedIn: false }; } };
  const modo = String(process.env.FALSO_AUTH_MODO || ler().modo || ''); // o campo `modo` do FALSO_AUTH também vale
  const gravar = (o) => fs.writeFileSync(arq, JSON.stringify(o));
  if (process.env.FALSO_LOG_AUTH) fs.appendFileSync(process.env.FALSO_LOG_AUTH, JSON.stringify({ argv, pid: process.pid, em: Date.now() }) + '\n');
  const sub = argv[1];
  if (sub === 'status') {
    const a = ler();
    process.stdout.write(JSON.stringify(a.loggedIn
      ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: a.email, orgId: 'org-falso', orgName: a.orgName || "Falso's Organization", subscriptionType: a.subscriptionType || 'max' }
      : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, null, 2) + '\n');
    process.exit(0);
  }
  if (sub === 'logout') {
    if (modo.includes('logout_falha')) { process.stderr.write('Failed to log out\n'); process.exit(1); }
    gravar({ loggedIn: false });
    process.stdout.write('Successfully logged out from your Anthropic account.\n');
    process.exit(0);
  }
  if (sub === 'login') {
    process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&client_id=falso&state=abc\n');
    process.stdin.resume();
    if (!modo.includes('login_espera')) {
      setTimeout(() => {
        if (modo.includes('login_falha')) { process.stderr.write('Login failed\n'); process.exit(1); }
        gravar({ loggedIn: true, email: opc('--email') || 'nova@exemplo.com', subscriptionType: 'pro', orgName: 'Nova Org' });
        process.stdout.write('Login successful.\n');
        process.exit(0);
      }, Number(process.env.FALSO_AUTH_LOGIN_MS) || 800);
    }
  }
  await new Promise(() => {}); // o resto do arquivo é o modo stream-json
}
const MODO =new Set(String(process.env.FALSO_MODO || '').split(',').filter(Boolean));
const PROJETOS = process.env.ORBIT_PROJETOS_DIR;
const SESSOES = process.env.GERENCIADOR_SESSOES_DIR;
const DEMORA = Number(process.env.FALSO_DEMORA_MS) || 1500;
const replay = argv.includes('--replay-user-messages');
// Comandos como os do initialize da 2.1.300 (o último, com espaço no nome, o Orbit descarta).
const COMANDOS = [
  { name: 'context', description: 'Show current context usage', argumentHint: '' },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
  { name: 'nome ruim', description: 'x', argumentHint: '' },
];
// Modelos como os do initialize da 2.1.300 (formato real, valores falsos): um sem xhigh, um sem esforço.
const NIVEIS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELOS = [
  { value: 'default', resolvedModel: 'claude-falso-1', displayName: 'Default (recommended)', description: 'Falso 1', supportsEffort: true, supportedEffortLevels: NIVEIS },
  { value: 'haiku', resolvedModel: 'claude-falso-haiku-5', displayName: 'Haiku Falso 5', description: 'Rápido', supportsEffort: true, supportedEffortLevels: NIVEIS },
  { value: 'claude-velho-4-6', resolvedModel: 'claude-velho-4-6', displayName: 'Velho 4.6', description: 'Sem xhigh', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Sem esforço', supportsEffort: false },
];
const doModelo = (v) => MODELOS.find((m) => m.value === v || m.resolvedModel === v);
let modelo = doModelo(opc('--model'))?.resolvedModel || opc('--model') || 'claude-falso-1';
let esforco = opc('--effort') || 'high';
const comEsforco = () => doModelo(modelo)?.supportsEffort !== false;
let modoPermissao = opc('--permission-mode') || 'default';
const parciais = argv.includes('--include-partial-messages');

if (process.env.FALSO_LOG)
  fs.appendFileSync(process.env.FALSO_LOG, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, envClaude: Object.keys(process.env).filter((k) => /^CLAUDE/i.test(k)) }) + '\n');

let id = opc('--resume');
let arquivo = '';
if (id && PROJETOS) {
  for (const d of fs.readdirSync(PROJETOS)) {
    const c = path.join(PROJETOS, d, `${id}.jsonl`);
    if (fs.existsSync(c)) arquivo = c;
  }
} else if (opc('--session-id')) {
  id = opc('--session-id');
  if (!argv.includes('--no-session-persistence') && PROJETOS) arquivo = path.join(PROJETOS, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  else arquivo = null; // sem transcript
}
if (arquivo === '') {
  process.stderr.write(`No conversation found with session ID: ${id}\n`);
  process.exit(1);
}
// Modo por projeto (cada teste usa uma pasta): <pasta do transcript>/falso-modo.txt
try {
  if (arquivo) for (const m of fs.readFileSync(path.join(path.dirname(arquivo), 'falso-modo.txt'), 'utf8').split(/[,\s]+/)) if (m) MODO.add(m);
} catch {}
// Transcript da sessão nova: a pasta e o arquivo nascem na 1ª escrita (como no real).
const anexar = (arq, l) => {
  if (!arq) return;
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.appendFileSync(arq, l);
};
if (MODO.has('falha_inicio')) {
  process.stderr.write('Error: falha simulada ao iniciar\n');
  process.exit(1);
}

const uuid = () => crypto.randomUUID();
const agora = () => new Date().toISOString();
let ultimo = null;
function gravar(o, arq = arquivo) {
  const e = { parentUuid: ultimo, isSidechain: false, ...o, timestamp: agora(), sessionId: id, cwd: process.cwd(), version: '2.1.300' };
  if (e.uuid) ultimo = e.uuid;
  anexar(arq, JSON.stringify(e) + '\n');
  return e;
}
const ruido = () => {
  anexar(arquivo, JSON.stringify({ type: 'attachment', attachment: { type: 'date', date: '2026-10-15' }, uuid: uuid(), sessionId: id }) + '\n');
  anexar(arquivo, JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] }, sessionId: id }) + '\n');
};
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: o.session_id ?? id, uuid: o.uuid ?? uuid() }) + '\n');

function registro(status) {
  if (!SESSOES) return;
  try {
    fs.writeFileSync(
      path.join(SESSOES, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), startedAt: Date.now(), kind: 'sdk-cli', entrypoint: 'sdk-cli', status, updatedAt: Date.now(), statusUpdatedAt: Date.now() }),
    );
  } catch {}
}
const sairLimpo = () => {
  try {
    if (SESSOES) fs.rmSync(path.join(SESSOES, `${process.pid}.json`), { force: true });
  } catch {}
};
process.on('exit', sairLimpo);
registro('idle');

let iniciou = false;
let emitiuUso = false;
const init = () => out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: modelo, permissionMode: modoPermissao, tools: ['Write'], slash_commands: ['compact', 'clear'] });
const resultado = (texto, erro = false) =>
  out({ type: 'result', subtype: erro ? 'error_during_execution' : 'success', is_error: erro, result: texto, duration_ms: 5, num_turns: 1, modelUsage: { [modelo]: { inputTokens: 10, outputTokens: 3, contextWindow: 200000, maxOutputTokens: 64000 } } });
const dormir = (t) => new Promise((r) => setTimeout(r, t));
const permissoes = new Map();
const USO = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 3 };
let ultCtx = 0;
function uso() {
  let u = USO;
  try {
    const arq = path.join(process.cwd(), 'falso-ctx.txt');
    const n = Number(fs.readFileSync(arq, 'utf8').trim());
    fs.rmSync(arq, { force: true });
    if (n > 0) u = { ...USO, cache_read_input_tokens: n };
  } catch {}
  ultCtx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  return u;
}

// interrupt: marca a volta como interrompida e acorda quem espera (dormir/permissão).
let interrompida = false;
const acordar = new Set();
const esperarOuParar = (t) =>
  new Promise((r) => {
    const fim = () => (clearTimeout(tm), acordar.delete(fim), r());
    const tm = setTimeout(fim, t);
    acordar.add(fim);
  });
function interromper() {
  interrompida = true;
  for (const [rid, r] of permissoes) {
    out({ type: 'control_cancel_request', request_id: rid });
    r({ behavior: 'deny', message: 'interrompido' });
  }
  permissoes.clear();
  for (const f of [...acordar]) f();
}
class Interrompida extends Error {}
const conferir = () => {
  if (interrompida) throw new Interrompida();
};

// Resposta de texto: com --include-partial-messages, os stream_event antes da `assistant` (como no real).
async function responder(texto, { pedacos = 3, intervalo = 0 } = {}) {
  const msg = 'msg_falso_' + crypto.randomBytes(6).toString('hex');
  const se = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null });
  if (parciais) {
    se({ type: 'message_start', message: { id: msg, model: modelo, role: 'assistant', content: [] } });
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pensando' } });
    se({ type: 'content_block_stop', index: 0 });
    se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    const partes = texto.match(new RegExp(`[\\s\\S]{1,${Math.max(1, Math.ceil(texto.length / pedacos))}}`, 'g')) || [texto];
    for (const t of partes) {
      conferir();
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } });
      if (intervalo) await esperarOuParar(intervalo);
    }
    conferir();
  } else if (intervalo) {
    await esperarOuParar(intervalo * pedacos);
    conferir();
  }
  gravar({ type: 'assistant', ...(comEsforco() ? { effort: esforco } : {}), message: { id: msg, model: modelo, role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }] }, uuid: uuid() });
  const a = gravar({ type: 'assistant', ...(comEsforco() ? { effort: esforco } : {}), message: { id: msg, model: modelo, role: 'assistant', content: [{ type: 'text', text: texto }], usage: uso() }, uuid: uuid() });
  out({ type: 'assistant', message: a.message, parent_tool_use_id: null, uuid: a.uuid });
  if (parciais) {
    se({ type: 'content_block_stop', index: 1 });
    se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    se({ type: 'message_stop' });
  }
  return a;
}

// Pedido can_use_tool genérico; devolve a resposta do Orbit (ou deny, se interrompido).
async function pedirFerramenta(nome, entrada, extra = {}, cancelar = false) {
  const tuid = 'toolu_' + crypto.randomBytes(8).toString('hex');
  const a1 = gravar({ type: 'assistant', ...(comEsforco() ? { effort: esforco } : {}), message: { model: modelo, role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: nome, input: entrada }] }, uuid: uuid() });
  out({ type: 'assistant', message: a1.message, parent_tool_use_id: null, uuid: a1.uuid });
  const rid = uuid();
  const resp = new Promise((r) => permissoes.set(rid, r));
  out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: nome, display_name: nome, input: entrada, tool_use_id: tuid, ...extra } });
  // CANCELA: o próprio claude desiste do pedido (control_cancel_request) e segue como negado.
  if (cancelar)
    setTimeout(() => {
      out({ type: 'control_cancel_request', request_id: rid });
      permissoes.get(rid)?.({ behavior: 'deny', message: 'cancelado' });
      permissoes.delete(rid);
    }, 300);
  const r = await resp;
  conferir();
  return { r, tuid, ok: r?.behavior === 'allow' };
}
const resultadoFerramenta = (tuid, ok, texto) => gravar({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: texto, is_error: !ok }] }, uuid: uuid() });
function trocarModo(m) {
  modoPermissao = m;
  out({ type: 'system', subtype: 'status', status: null, permissionMode: m });
}

// conteudo: o content da mensagem como chegou (com blocos image, eco e transcript levam o array).
async function volta(texto, conteudo = texto) {
  if (!iniciou) {
    iniciou = true;
    init();
  }
  registro('busy');
  anexar(arquivo, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: agora(), sessionId: id, content: texto }) + '\n');
  // Comando local, como na 2.1.300: sem eco no stream; a saída vai ao transcript como system/local_command
  // e ao stream como assistant + result.
  const local = /^\/(context|usage)$/.exec(texto.trim());
  if (local) {
    const saida = local[1] === 'context' ? '## Context Usage\n\n**Tokens:** 1.2k / 1m (0%)' : 'Current session: 5% used';
    gravar({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' }, uuid: uuid() });
    gravar({ type: 'user', message: { role: 'user', content: `<command-name>/${local[1]}</command-name>\n            <command-message>${local[1]}</command-message>\n            <command-args></command-args>` }, uuid: uuid() });
    gravar({ type: 'system', subtype: 'local_command', content: `<local-command-stdout>${saida}</local-command-stdout>`, level: 'info', uuid: uuid() });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: saida }] } });
    resultado(saida);
    registro('idle');
    return;
  }
  if (replay && !MODO.has('sem_eco')) out({ type: 'user', message: { role: 'user', content: conteudo }, parent_tool_use_id: null, isReplay: true });

  if (/^\/compact\b/.test(texto)) {
    const foco = texto.slice(8).trim();
    out({ type: 'system', subtype: 'status', status: 'compacting' });
    await dormir(100);
    if (MODO.has('compact_erro')) {
      out({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' });
      resultado('Error: falha simulada na compactação', true);
      registro('idle');
      return;
    }
    const pre = ultCtx > 100000 ? ultCtx : 29864;
    const b = gravar({ parentUuid: null, logicalParentUuid: ultimo, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info', uuid: uuid(), compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: 1146 } });
    gravar({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' }, uuid: uuid() });
    gravar({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' }, uuid: uuid() });
    gravar({ type: 'user', message: { role: 'user', content: `<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>${foco}</command-args>` }, uuid: uuid() });
    gravar({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, uuid: uuid() });
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
    init();
    out({ type: 'system', subtype: 'compact_boundary', uuid: b.uuid, compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: 1146 } });
    resultado('');
    registro('idle');
    return;
  }
  if (texto.trim() === '/clear') {
    const novo = uuid();
    out({ type: 'conversation_reset', new_conversation_id: uuid(), trigger: 'clear', timestamp: agora() });
    id = novo;
    arquivo = path.join(path.dirname(arquivo), `${novo}.jsonl`);
    ultimo = null;
    anexar(arquivo, JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id }) + '\n');
    gravar({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' }, uuid: uuid() });
    gravar({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' }, uuid: uuid() });
    gravar({ type: 'system', subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>', level: 'info', uuid: uuid() });
    registro('idle');
    init();
    resultado('');
    return;
  }
  gravar({ type: 'user', message: { role: 'user', content: conteudo }, uuid: uuid() });
  ruido();
  // Uso do plano: sai uma vez, depois da 1ª chamada à API (sonda 15/10). Formato bruto da 2.1.300.
  if ((MODO.has('rate_limit') || MODO.has('rate_limit_parcial')) && !emitiuUso) {
    emitiuUso = true;
    const cinco = { utilization: 0.32, resetsAt: 1792067400 };
    const sete = MODO.has('rate_limit_parcial') ? { resetsAt: 1792062000 } : { utilization: 0.56, resetsAt: 1792062000 };
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792067400, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { five_hour: cinco, seven_day: sete } } });
  }
  interrompida = false;
  try {
    if (texto.includes('TAREFAS_FIM')) out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    else if (texto.includes('TAREFAS'))
      out({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'b1', task_type: 'local_bash', description: 'sleep 30   (em segundo plano)' },
          { task_id: 'a1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Explore: onde fica o SSE' },
          { task_id: 'w1', task_type: 'monitor', description: 'vigia interna', ambient: true },
        ],
      });
    // Etapa 4: CRON agenda (tool_use CronCreate, sem permissão); CRON_FIM desfaz (CronDelete).
    for (const [marca, nome] of [['CRON_FIM', 'CronDelete'], ['CRON', 'CronCreate']]) {
      if (!texto.includes(marca)) continue;
      const tuid = 'toolu_' + crypto.randomBytes(8).toString('hex');
      const e = gravar({ type: 'assistant', message: { model: modelo, role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: nome, input: { cron: '*/5 * * * *', prompt: 'ver' } }] }, uuid: uuid() });
      out({ type: 'assistant', message: e.message, parent_tool_use_id: null, uuid: e.uuid });
      resultadoFerramenta(tuid, true, 'ok');
      break;
    }
    if (texto.includes('DEMORA')) {
      await esperarOuParar(Number(/DEMORA:(\d+)/.exec(texto)?.[1]) || DEMORA);
      conferir();
    }
    if (texto.includes('PERMISSAO')) {
      const entrada = { file_path: path.join(process.cwd(), 'a.txt'), content: 'oi' };
      const sugestoes = [
        // GLOBAL: a sugestão "em todos os projetos" (userSettings), como o Claude Code oferece.
        { type: 'addRules', rules: [{ toolName: 'Write', ruleContent: 'a.txt' }], behavior: 'allow', destination: texto.includes('GLOBAL') ? 'userSettings' : 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ];
      const { r, tuid, ok } = await pedirFerramenta('Write', entrada, { description: 'a.txt', permission_suggestions: sugestoes }, texto.includes('CANCELA'));
      const modo = (r?.updatedPermissions || []).find((s) => s.type === 'setMode')?.mode;
      if (modo) trocarModo(modo);
      resultadoFerramenta(tuid, ok, ok ? `File created successfully${r.updatedPermissions ? ' updatedPermissions=' + JSON.stringify(r.updatedPermissions) : ''}` : r?.message || 'negado');
      const t = ok ? 'Feito.' : 'Não tive permissão.';
      await responder(t);
      resultado(t);
      registro('idle');
      return;
    }
    if (texto.includes('PERGUNTA')) {
      const entrada = {
        questions: [
          { question: 'Qual cor?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: 'fria' }, { label: 'Vermelho', description: 'quente' }] },
          { question: 'Quais frutas?', header: 'Frutas', multiSelect: true, options: [{ label: 'Maçã', description: '' }, { label: 'Uva', description: 'roxa' }, { label: 'Pera', description: '' }] },
        ],
      };
      const { r, tuid, ok } = await pedirFerramenta('AskUserQuestion', entrada);
      resultadoFerramenta(tuid, ok, ok ? `User has answered your questions: ${JSON.stringify(r.updatedInput?.answers ?? null)}` : r?.message || 'negado');
      const t = ok ? 'Obrigado pelas respostas.' : 'Tudo bem, sem resposta.';
      await responder(t);
      resultado(t);
      registro('idle');
      return;
    }
    if (texto.includes('PLANO')) {
      const { r, tuid, ok } = await pedirFerramenta('ExitPlanMode', { plan: '# Plano\n\n1. Ler\n2. Escrever' });
      if (ok) trocarModo((r?.updatedPermissions || []).find((s) => s.type === 'setMode')?.mode || 'default');
      resultadoFerramenta(tuid, ok, ok ? `User has approved your plan${r.updatedPermissions ? ' updatedPermissions=' + JSON.stringify(r.updatedPermissions) : ''}` : r?.message || 'negado');
      const t = ok ? 'Plano aprovado, mãos à obra.' : 'Continuo planejando.';
      await responder(t);
      resultado(t);
      registro('idle');
      return;
    }
    const longa = texto.includes('LONGA');
    await responder(longa ? Array.from({ length: 40 }, (_, i) => `parte ${i + 1}. `).join('') : `Resposta: ${texto}`, longa ? { pedacos: 40, intervalo: 50 } : {});
    // SINTETICO: depois da resposta, uma entrada `<synthetic>` (como as do claude em erro/interrupção).
    if (texto.includes('SINTETICO')) gravar({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] }, uuid: uuid() });
    resultado(longa ? 'longa' : `Resposta: ${texto}`);
  } catch (e) {
    if (!(e instanceof Interrompida)) throw e;
    gravar({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: uuid() });
    resultado('', true);
  } finally {
    interrompida = false;
    registro('idle');
  }
}

let fila = Promise.resolve();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.type === 'control_request') {
      if (MODO.has('mudo')) continue;
      const q = j.request || {};
      const ok = (response = {}) => out({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response } });
      const erro = (e, codigo) => out({ type: 'control_response', response: { subtype: 'error', request_id: j.request_id, error: e, ...(codigo ? { error_code: codigo } : {}) } });
      if (q.subtype === 'initialize') {
        // Skills (17/10): a allowlist do initialize vai para o FALSO_LOG_INIT (o teste confere o que o Orbit mandou).
        if (process.env.FALSO_LOG_INIT) fs.appendFileSync(process.env.FALSO_LOG_INIT, JSON.stringify({ argv, pid: process.pid, skills: q.skills ?? null }) + '\n');
        ok({ commands: COMANDOS, models: MODELOS, pid: process.pid, current_permission_mode: modoPermissao });
      } else if (q.subtype === 'get_skills_dialog') ok({ skills: skillsDoDialogo() });
      else if (q.subtype === 'mcp_status') {
        const l = servidoresMcp().map(({ vars, ...s }) => s);
        ok({ mcpServers: mcpPedidos++ === 0 ? l.map((s) => (s.status === 'disabled' ? s : { ...s, status: 'pending', error: undefined })) : l });
      }
      else if (q.subtype === 'set_model') {
        const m = doModelo(q.model);
        if (!m) erro(`Model '${q.model}' not found`, 'catalog_unknown');
        else {
          modelo = m.resolvedModel;
          ok();
        }
      } else if (q.subtype === 'apply_flag_settings') {
        const e = q.settings?.effortLevel;
        if (NIVEIS.includes(e)) esforco = e; // inválido: success e ignorado em silêncio (como no real)
        ok();
      } else if (q.subtype === 'get_settings') ok({ effective: { model: 'opus' }, applied: { model: modelo, effort: comEsforco() ? esforco : null } });
      else if (q.subtype === 'generate_session_title') {
        if (MODO.has('sem_titulo')) erro('generate_session_title não disponível');
        else {
          const title = 'Título: ' + String(q.description || '').slice(0, 30);
          if (q.persist) anexar(arquivo, JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }) + '\n');
          ok({ title });
        }
      } else if (q.subtype === 'rename_session') {
        anexar(arquivo, JSON.stringify({ type: 'custom-title', customTitle: String(q.title), sessionId: id }) + '\n');
        out({ type: 'system', subtype: 'session_title_changed', title: String(q.title) });
        ok();
      } else if (q.subtype === 'interrupt') {
        ok();
        interromper();
      } else if (q.subtype === 'set_permission_mode') {
        if (!['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'].includes(q.mode)) erro('Invalid permission mode');
        else {
          ok();
          trocarModo(q.mode);
        }
      } else ok();
      continue;
    }
    if (j.type === 'control_response') {
      const r = permissoes.get(j.response?.request_id);
      if (r) {
        permissoes.delete(j.response.request_id);
        r(j.response.response);
      }
      continue;
    }
    if (j.type === 'user') {
      const t = typeof j.message?.content === 'string' ? j.message.content : (j.message?.content || []).map((b) => b.text || '').join('\n');
      fila = fila.then(() => volta(t, j.message?.content ?? t)).catch((e) => process.stderr.write(String(e?.stack || e) + '\n'));
    }
  }
});
process.stdin.on('end', () => {
  if (MODO.has('ignora_eof')) {
    setInterval(() => {}, 1e6);
    return;
  }
  fila.then(() => process.exit(0));
});
