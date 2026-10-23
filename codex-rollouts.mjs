// Monitoramento do Codex por rollouts (somente leitura): CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl.
// Parte pura: resumirRollout(estadoAnterior, linhasNovas) acumula linhas JSONL num resumo da sessão.
// Parte com disco: criarMonitorRollouts({ home, aoMudar, aoUso, ... }) varre só os dias recentes, lê só os bytes novos
// de cada arquivo e avisa quando o resumo muda. NUNCA escreve em `home`.
import fsReal from 'node:fs';
import path from 'node:path';

export const LIMITE_PRIMEIRA = 300;
export const LIMITE_PEDIDO = 300;
export const LIMITE_RESPOSTA = 1000;
export const INATIVO_PADRAO_MS = 30 * 60 * 1000;

const corta = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const norm = (t) => String(t ?? '').replace(/[_\s-]/g, '').toLowerCase();
const ehObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const nomeDaPasta = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || s; };

// ---- Texto de mensagens ----
function textoDe(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return '';
  return conteudo.map((c) => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : ''))).filter(Boolean).join('\n');
}
const BLOCOS_INJETADOS = /^\s*<([A-Za-z_][\w-]*)>[\s\S]*?<\/\1>\s*/;
const CABECALHOS_INJETADOS = /^\s*(# Files mentioned by the user|# AGENTS\.md|# Context from my IDE|<app-context>|<environment_context>|<user_instructions>|<permissions|<collaboration_mode|<turn_aborted>|<user_shell_command>|<subagent_notification>)/i;
// Devolve a parte "real" do que o usuário escreveu (sem blocos que o app/CLI injeta), ou '' se não sobrar nada.
export function textoReal(texto) {
  let t = String(texto ?? '');
  const marca = t.match(/##\s*My request for Codex:?\s*/i);
  if (marca) t = t.slice(marca.index + marca[0].length);
  for (let i = 0; i < 20; i++) { const n = t.replace(BLOCOS_INJETADOS, ''); if (n === t) break; t = n; }
  t = t.trim();
  if (!t || CABECALHOS_INJETADOS.test(t)) return '';
  return t;
}

function paraMs(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x < 1e11 ? x * 1000 : x;
  if (typeof x === 'string') { const n = Date.parse(x); return Number.isFinite(n) ? n : null; }
  return null;
}

// ---- Origem (session_meta.source) ----
// Esquema (SessionSource): "cli"|"vscode"|"exec"|"appServer"|"unknown", {custom}, {subAgent: "review"|"compact"|"memory_consolidation"
// | {thread_spawn:{parent_thread_id, depth, agent_nickname, agent_role}} | {other: "..."}}. No rollout a chave vem como
// `subagent`; aceitamos as variantes. O revisor interno aparece como tipo `guardian`.
export function lerFonte(source, meta = {}) {
  if (typeof source === 'string') return { fonte: source, subagente: meta.thread_source === 'subagent' ? { tipo: 'subagent' } : null };
  if (!ehObj(source)) return { fonte: null, subagente: null };
  const chave = Object.keys(source).find((k) => norm(k) === 'subagent');
  if (chave === undefined) return { fonte: ehObj(source) && source.custom ? String(source.custom) : 'custom', subagente: null };
  const v = source[chave];
  let sub;
  if (typeof v === 'string') sub = { tipo: v };
  else if (ehObj(v)) {
    const ts = Object.keys(v).find((k) => norm(k) === 'threadspawn');
    if (ts !== undefined) {
      const d = ehObj(v[ts]) ? v[ts] : {};
      sub = { tipo: 'thread_spawn' };
      if (d.parent_thread_id) sub.pai = String(d.parent_thread_id);
      if (d.agent_nickname) sub.apelido = String(d.agent_nickname);
      if (d.agent_role) sub.papel = String(d.agent_role);
    } else if (typeof v.other === 'string') sub = { tipo: v.other };
    else sub = { tipo: Object.keys(v)[0] || 'subagent' };
  } else sub = { tipo: 'subagent' };
  if (!sub.pai && meta.parent_thread_id) sub.pai = String(meta.parent_thread_id);
  return { fonte: 'subagent', subagente: sub };
}
export const ehGuardian = (resumo) => !!resumo?.subagente && /guardian/i.test(String(resumo.subagente.tipo));

// ---- Resumo ----
export function resumoVazio() {
  return {
    id: null, cwd: null, projeto: null, originador: null, fonte: null, subagente: null, inicio: null, atividade: null,
    status: 'nova', motivo: null, turnoAtivo: null, primeira: null, pedido: null, ultimaResposta: null,
    modelo: null, esforco: null, aprovacao: null, sandbox: null, contexto: null, uso: null,
    contadores: { turnos: 0, ferramentas: 0 }, ultimaFerramenta: null,
  };
}

function parsear(l) {
  if (ehObj(l)) return l;
  if (typeof l !== 'string') return null;
  const s = l.trim();
  if (!s || s[0] !== '{') return null;
  // Filtro barato: só interpreta o que o resumo usa (response_item só de mensagens do usuário).
  if (s.includes('"response_item"') && !s.includes('"role":"user"') && !s.includes('"role": "user"')) return null;
  try { const o = JSON.parse(s); return ehObj(o) ? o : null; } catch { return null; }
}

function limite(r) {
  if (!ehObj(r)) return null;
  const pct = Number(r.used_percent ?? r.usedPercent);
  if (!Number.isFinite(pct)) return null;
  const min = Number(r.window_minutes ?? r.windowMinutes ?? r.windowDurationMins);
  const renova = paraMs(r.resets_at ?? r.resetsAt);
  return { pct, janelaMin: Number.isFinite(min) ? min : null, renova };
}

function definirUsuario(r, texto) {
  const t = textoReal(texto);
  if (!t) return;
  if (!r.primeira) r.primeira = corta(t, LIMITE_PRIMEIRA);
  r.pedido = corta(t, LIMITE_PEDIDO);
}

function alvoDoComando(c) {
  if (Array.isArray(c)) {
    const a = c.map(String);
    if (a.length >= 3 && /^-(l?c|command)$/i.test(a[a.length - 2])) return a[a.length - 1];
    return a.join(' ');
  }
  return typeof c === 'string' ? c : '';
}

function aplicarItem(r, item, ts) {
  if (!ehObj(item)) return;
  const t = norm(item.type);
  if (t === 'usermessage') definirUsuario(r, textoDe(item.content ?? item.text));
  else if (t === 'agentmessage') {
    if (norm(item.phase) === 'commentary') return;
    const x = textoDe(item.content) || (typeof item.text === 'string' ? item.text : '');
    if (x.trim()) r.ultimaResposta = corta(x, LIMITE_RESPOSTA);
  } else if (t === 'commandexecution' || t === 'filechange' || t === 'mcptoolcall') {
    r.contadores.ferramentas++;
    let nome, alvo = '';
    if (t === 'commandexecution') { nome = 'CommandExecution'; alvo = alvoDoComando(item.command); }
    else if (t === 'filechange') {
      nome = 'FileChange';
      const c = Array.isArray(item.changes) ? item.changes[0] : null;
      alvo = c && (c.path || c.file) ? String(c.path || c.file) : '';
    } else {
      nome = item.tool ? (item.server ? `${item.server}/${item.tool}` : String(item.tool)) : 'McpToolCall';
      alvo = item.server ? String(item.server) : '';
    }
    r.ultimaFerramenta = { nome, alvo: corta(alvo, 200), ts };
  }
}

function aplicarEvento(r, p, ts) {
  const tipo = norm(p.type);
  switch (tipo) {
    case 'taskstarted': case 'turnstarted':
      r.status = 'trabalhando'; r.motivo = null; r.turnoAtivo = p.turn_id ?? p.turnId ?? null; r.contadores.turnos++;
      if (Number(p.model_context_window) > 0) r.contexto = { tokens: r.contexto?.tokens ?? null, ocupado: r.contexto?.ocupado ?? null, janela: Number(p.model_context_window), pct: r.contexto?.pct ?? null };
      break;
    case 'taskcomplete': case 'turncomplete': case 'turncompleted':
      r.status = 'concluida'; r.motivo = null; r.turnoAtivo = null;
      if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) r.ultimaResposta = corta(p.last_agent_message, LIMITE_RESPOSTA);
      break;
    case 'turnaborted':
      r.status = 'interrompida'; r.motivo = p.reason ? String(p.reason) : 'interrompida'; r.turnoAtivo = null;
      break;
    case 'error': case 'streamerror': case 'turnfailed':
      if (tipo === 'streamerror') break; // erro transitório de rede: o Codex tenta de novo
      r.status = 'erro'; r.motivo = corta(p.message ?? p.error?.message ?? 'erro', 300); r.turnoAtivo = null;
      break;
    case 'itemcompleted': aplicarItem(r, p.item, ts); break;
    case 'usermessage': definirUsuario(r, typeof p.message === 'string' ? p.message : textoDe(p.content)); break;
    case 'threadsettingsapplied': {
      const s = p.thread_settings ?? {};
      if (s.model) r.modelo = String(s.model);
      if (s.reasoning_effort) r.esforco = String(s.reasoning_effort);
      if (typeof s.approval_policy === 'string') r.aprovacao = s.approval_policy;
      if (s.cwd && !r.cwd) { r.cwd = String(s.cwd); r.projeto = nomeDaPasta(r.cwd); }
      break;
    }
    case 'tokencount': {
      const info = p.info;
      if (ehObj(info)) {
        const ult = info.last_token_usage ?? {};
        const janela = Number(info.model_context_window) || r.contexto?.janela || null;
        const tokens = Number(ult.input_tokens);
        // tokens = o que a última chamada mandou ao modelo (input, inclui o cache) = o que ocupa a janela agora;
        // ocupado = total − raciocínio (o que a próxima chamada herda).
        const total = Number(ult.total_tokens), rac = Number(ult.reasoning_output_tokens) || 0;
        if (Number.isFinite(tokens)) {
          r.contexto = { tokens, ocupado: Number.isFinite(total) ? Math.max(0, total - rac) : null, janela, pct: janela ? Math.min(100, Math.round((tokens / janela) * 100)) : null };
        }
      }
      const rl = p.rate_limits;
      if (ehObj(rl)) {
        const primario = limite(rl.primary), secundario = limite(rl.secondary);
        if (primario || secundario) r.uso = { primario, secundario, plano: rl.plan_type ?? rl.planType ?? null, ts };
      }
      break;
    }
    default: break;
  }
}

function aplicarContexto(r, p) {
  if (p.model) r.modelo = String(p.model);
  if (p.effort || p.reasoning_effort) r.esforco = String(p.effort || p.reasoning_effort);
  if (typeof p.approval_policy === 'string') r.aprovacao = p.approval_policy;
  else if (ehObj(p.approval_policy)) r.aprovacao = Object.keys(p.approval_policy)[0] ?? null;
  const sp = p.sandbox_policy;
  if (typeof sp === 'string') r.sandbox = sp; else if (ehObj(sp) && sp.type) r.sandbox = String(sp.type);
  if (p.cwd && !r.cwd) { r.cwd = String(p.cwd); r.projeto = nomeDaPasta(r.cwd); }
}

// Puro: não altera `estadoAnterior`; devolve um resumo novo. `linhasNovas`: strings JSONL (ou objetos já lidos).
export function resumirRollout(estadoAnterior, linhasNovas) {
  const r = estadoAnterior ? structuredClone(estadoAnterior) : resumoVazio();
  for (const l of Array.isArray(linhasNovas) ? linhasNovas : []) {
    let o; try { o = parsear(l); } catch { o = null; }
    if (!o) continue;
    try {
      const ts = paraMs(o.timestamp);
      if (ts !== null && (r.atividade === null || ts > r.atividade)) r.atividade = ts;
      const p = o.payload;
      if (!ehObj(p)) continue;
      if (o.type === 'session_meta') {
        if (p.id || p.session_id) r.id = String(p.id || p.session_id);
        if (p.cwd) { r.cwd = String(p.cwd); r.projeto = nomeDaPasta(r.cwd); }
        if (p.originator) r.originador = String(p.originator);
        const f = lerFonte(p.source, p); r.fonte = f.fonte; r.subagente = f.subagente;
        if (r.inicio === null) r.inicio = paraMs(p.timestamp) ?? ts;
      } else if (o.type === 'turn_context') aplicarContexto(r, p);
      else if (o.type === 'event_msg') aplicarEvento(r, p, ts);
      else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') definirUsuario(r, textoDe(p.content));
      if (r.inicio === null && ts !== null) r.inicio = ts;
    } catch { /* linha estranha: ignora */ }
  }
  return r;
}

// Regra de inatividade (pura): 'trabalhando' sem escrita há mais de inativoMs vira 'interrompida'.
export function aplicarInatividade(resumo, { agora, ultimaEscrita, inativoMs = INATIVO_PADRAO_MS }) {
  if (resumo.status !== 'trabalhando') return resumo;
  const ref = Number.isFinite(ultimaEscrita) ? ultimaEscrita : resumo.atividade;
  if (!Number.isFinite(ref) || agora - ref <= inativoMs) return resumo;
  return { ...resumo, status: 'interrompida', motivo: `sem atividade há ${Math.round((agora - ref) / 60000)} min`, turnoAtivo: null };
}

// ---- Monitor ----
const p2 = (n) => String(n).padStart(2, '0');
// Pastas AAAA/MM/DD (hora local e UTC, porque o Codex real usa a local e o falso a UTC) dos dias que cobrem [agora − horas, agora].
export function diasParaVarrer(agoraMs, horas) {
  const dias = new Set();
  const ini = agoraMs - horas * 3600000;
  for (let t = ini; ; t += 6 * 3600000) {
    const x = Math.min(t, agoraMs), d = new Date(x);
    dias.add(`${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`);
    dias.add(`${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`);
    if (x >= agoraMs) break;
  }
  return [...dias];
}

const TAM_BLOCO = 1024 * 1024;
const TAM_MAX_LINHA = 16 * 1024 * 1024;
const ROLLOUT = /^rollout-.*\.jsonl$/;
const idDoNome = (nome) => nome.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;

export function criarMonitorRollouts({ home, aoMudar, aoUso, intervaloMs = 2000, horas = 24, inativoMs = INATIVO_PADRAO_MS, fs = fsReal, agora = Date.now } = {}) {
  if (!home) throw new Error('criarMonitorRollouts: home é obrigatório');
  const raiz = path.join(home, 'sessions');
  const arquivos = new Map(); // caminho → { offset, resto:Buffer, estado, ignorar, ultimoJson, mtimeMs, tam }
  let ultimoUso = null, ultimoUsoJson = null, parado = false, timer = null, varrendo = false;

  function lerNovos(caminho, a, tam) {
    if (tam < a.offset) { a.offset = 0; a.resto = Buffer.alloc(0); a.estado = null; a.ignorar = false; }
    if (tam === a.offset) return false;
    let fd;
    try { fd = fs.openSync(caminho, 'r'); } catch { return false; }
    let mudou = false;
    try {
      const buf = Buffer.alloc(TAM_BLOCO);
      while (a.offset < tam && !a.ignorar) {
        const n = fs.readSync(fd, buf, 0, Math.min(TAM_BLOCO, tam - a.offset), a.offset);
        if (n <= 0) break;
        a.offset += n;
        const junto = a.resto.length ? Buffer.concat([a.resto, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        const fim = junto.lastIndexOf(0x0a);
        if (fim < 0) { a.resto = junto.length > TAM_MAX_LINHA ? Buffer.alloc(0) : junto; continue; }
        a.resto = Buffer.from(junto.subarray(fim + 1));
        const linhas = junto.subarray(0, fim).toString('utf8').split('\n');
        a.estado = resumirRollout(a.estado, linhas); mudou = true;
        if (ehGuardian(a.estado)) a.ignorar = true;
      }
    } catch { /* arquivo sumiu ou ilegível: tenta no próximo ciclo */ } finally { try { fs.closeSync(fd); } catch {} }
    return mudou;
  }

  function varrer() {
    if (parado || varrendo) return;
    varrendo = true;
    try {
      const t = agora();
      const corte = t - horas * 3600000;
      const vistos = new Set();
      for (const dia of diasParaVarrer(t, horas)) {
        const dir = path.join(raiz, ...dia.split('/'));
        let nomes; try { nomes = fs.readdirSync(dir); } catch { continue; }
        for (const nome of nomes) {
          if (!ROLLOUT.test(nome)) continue;
          const caminho = path.join(dir, nome);
          if (vistos.has(caminho)) continue;
          vistos.add(caminho);
          let st; try { st = fs.statSync(caminho); } catch { continue; }
          if (!st.isFile()) continue;
          let a = arquivos.get(caminho);
          if (!a) {
            if (st.mtimeMs < corte) continue;
            a = { offset: 0, resto: Buffer.alloc(0), estado: null, ignorar: false, ultimoJson: null, mtimeMs: st.mtimeMs };
            arquivos.set(caminho, a);
          }
          a.mtimeMs = st.mtimeMs;
          lerNovos(caminho, a, st.size);
        }
      }
      for (const c of [...arquivos.keys()]) if (!vistos.has(c)) arquivos.delete(c);

      for (const [caminho, a] of arquivos) {
        if (a.ignorar || !a.estado) continue;
        let r = { ...a.estado, arquivo: caminho };
        if (!r.id) r.id = idDoNome(path.basename(caminho));
        r = aplicarInatividade(r, { agora: t, ultimaEscrita: a.mtimeMs, inativoMs });
        const j = JSON.stringify(r);
        if (j !== a.ultimoJson) { a.ultimoJson = j; try { aoMudar?.(JSON.parse(j)); } catch {} }
        const u = a.estado.uso;
        if (u && (!ultimoUso || (u.ts ?? 0) >= (ultimoUso.ts ?? 0))) {
          const uj = JSON.stringify(u);
          if (uj !== ultimoUsoJson) { ultimoUso = u; ultimoUsoJson = uj; try { aoUso?.(JSON.parse(uj)); } catch {} }
        }
      }
    } finally { varrendo = false; }
  }

  timer = setInterval(() => { try { varrer(); } catch {} }, intervaloMs);
  timer.unref?.();
  const primeiro = setTimeout(() => { try { varrer(); } catch {} }, 0);
  primeiro.unref?.();

  return {
    varrer,
    resumos: () => [...arquivos].filter(([, a]) => a.estado && !a.ignorar).map(([c, a]) => aplicarInatividade({ ...structuredClone(a.estado), arquivo: c, id: a.estado.id || idDoNome(path.basename(c)) }, { agora: agora(), ultimaEscrita: a.mtimeMs, inativoMs })),
    parar() { parado = true; clearInterval(timer); clearTimeout(primeiro); },
  };
}
