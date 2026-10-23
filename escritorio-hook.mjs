// Orbit — hook PreToolUse SÍNCRONO dos escritórios (contrato da Etapa 1, §6 e §11 F1).
// Entra pelo `configuracao` (--settings) de cada instância de escritório, com matcher
// "Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit|Agent|Task|mcp__.*". Lê o evento no stdin e decide:
//   - a cada ferramenta do matcher: GET /escritorios/:id/status; "pausada" → deny "Escritório pausado";
//   - Bash|PowerShell|Monitor e mcp__*: ação externa (escritorio-externas.mjs) → "ask" ("Ação externa: ...");
//     código que a trava não enxerga → "ask" ("Ação externa possível: executa código");
//     erro, tempo esgotado ou servidor fora → "ask" (falha fechada: "Ação externa: a trava não conseguiu avaliar");
//   - Write|Edit|MultiEdit|NotebookEdit: só pergunta ("ask") quando o alvo é .claude/settings*, .mcp.json,
//     escritorio-*.mjs ou membro.mjs (arquivos que sustentam a trava); o resto passa;
//   - Agent|Task → só o orquestrador cria convidados, e só até o limite do escritório
//     (GET /escritorios/convidados?sessao=<session_id>); servidor mudo ou permitido:false → "deny";
//   - o resto → sai 0 sem imprimir nada.
// Env: ORBIT_ESCRITORIO, ORBIT_EXECUCAO, ORBIT_PAPEL ('orquestrador' ou o id do membro), ORBIT_PORTA (padrão
// 47821), ORBIT_EXTERNAS (JSON com os extras, texto literal: lista ou { extras: [...] }).
// Nunca trava: no máximo 3 s no total. Ao estourar, a última barreira imprime a decisão de falha do ramo
// (ask no Bash/PowerShell/Monitor/MCP, deny no Agent/Task) e sai.

import http from 'node:http';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classificar, ehExecucao, ehFerramentaDeEscrita, ehFerramentaDeShell, FALHA_AVALIAR } from './escritorio-externas.mjs';

const MS_TOTAL = 2800;
const MS_STDIN = 1200;
const MS_SERVIDOR = 1800;
const MS_STATUS = 1200;

function lerStdin() {
  return new Promise((resolve) => {
    const partes = [];
    let feito = false;
    const fim = () => { if (!feito) { feito = true; resolve(Buffer.concat(partes).toString('utf8')); } };
    process.stdin.on('data', (c) => partes.push(c));
    process.stdin.on('end', fim);
    process.stdin.on('error', fim);
    setTimeout(fim, MS_STDIN).unref();
  });
}

export function extrasDoEnv(env = process.env) {
  try {
    const j = JSON.parse(env.ORBIT_EXTERNAS || '[]');
    const l = Array.isArray(j) ? j : j?.extras;
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

const saida = (decisao, motivo) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decisao, permissionDecisionReason: motivo } });

const limiteAtingido = (n) => `Limite de convidados do escritório atingido (${Number.isFinite(n) ? n : 0}).`;
const motivoAsk = (c) => (ehExecucao(c.descricao) ? `Ação externa possível: ${c.descricao}` : `Ação externa: ${c.descricao}`);

// GET em JSON no servidor do Orbit; devolve o objeto ou null (sem resposta, erro, lento, status != 200, JSON inválido).
function consultar(porta, caminho, ms) {
  return new Promise((resolve) => {
    let feito = false;
    const fim = (v) => { if (!feito) { feito = true; resolve(v); } };
    try {
      const req = http.get({ host: '127.0.0.1', port: porta, path: caminho, timeout: ms }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return fim(null);
          try { fim(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { fim(null); }
        });
        res.on('error', () => fim(null));
      });
      req.on('error', () => fim(null));
      req.on('timeout', () => { req.destroy(); fim(null); });
      setTimeout(() => { req.destroy(); fim(null); }, ms + 100).unref();
    } catch {
      fim(null);
    }
  });
}

const consultarConvidados = (porta, sessao) => consultar(porta, `/escritorios/convidados?sessao=${encodeURIComponent(sessao)}`, MS_SERVIDOR);
const consultarStatus = (porta, id) => consultar(porta, `/escritorios/${encodeURIComponent(id)}/status`, MS_STATUS);

const ehAgente = (tool) => /^(Agent|Task)$/.test(tool);
const ehMcp = (tool) => /^mcp__/i.test(tool);

// Decisão de falha do ramo (tempo esgotado ou exceção). '' = sem decisão (ferramenta que a trava não cobre).
export function decisaoDeFalha(ev) {
  const tool = String(ev?.tool_name || '');
  if (ehAgente(tool)) return saida('deny', limiteAtingido(NaN));
  if (ehFerramentaDeShell(tool) || ehMcp(tool)) return saida('ask', `Ação externa: ${FALHA_AVALIAR}`);
  return '';
}

// Devolve o JSON do hook (texto) ou '' quando não há decisão. `env` só nos testes.
export async function avaliar(ev, env = process.env) {
  if (!ev || typeof ev !== 'object') return '';
  const tool = String(ev.tool_name || '');
  const agente = ehAgente(tool);
  const shell = ehFerramentaDeShell(tool) || ehMcp(tool);
  const escrita = ehFerramentaDeEscrita(tool);
  if (!agente && !shell && !escrita) return '';
  try {
    const porta = Number(env.ORBIT_PORTA) || 47821;
    const id = String(env.ORBIT_ESCRITORIO || '');
    const pStatus = id ? consultarStatus(porta, id) : Promise.resolve({ status: '' });
    const pConv = agente && env.ORBIT_PAPEL === 'orquestrador' ? consultarConvidados(porta, String(ev.session_id || '')) : Promise.resolve(null);
    const [st, r] = await Promise.all([pStatus, pConv]);

    if (st && st.status === 'pausada') return saida('deny', 'Escritório pausado: aguarde a liberação.');

    if (agente) {
      if (env.ORBIT_PAPEL !== 'orquestrador') return saida('deny', 'Membros do escritório não podem criar convidados.');
      if (!r || r.permitido !== true) return saida('deny', limiteAtingido(Number(r?.limite)));
      return '';
    }

    const c = classificar(tool, ev.tool_input, extrasDoEnv(env), { porta });
    if (c.externa) return saida('ask', motivoAsk(c));
    if (shell && !st) return saida('ask', `Ação externa: ${FALHA_AVALIAR}`); // servidor fora: não dá para confirmar a pausa
    return '';
  } catch {
    return decisaoDeFalha(ev);
  }
}

const real = (f) => String(f || '').replace(/\\/g, '/').toLowerCase();
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  let padrao = '';
  const escrever = (s) => { try { if (s) writeSync(1, s + '\n'); } catch {} };
  // última barreira: nunca passa de 3 s e, estourando, imprime a decisão de falha do ramo
  setTimeout(() => { escrever(padrao); process.exit(0); }, MS_TOTAL).unref();
  try {
    const bruto = await lerStdin();
    const ev = JSON.parse(bruto);
    padrao = decisaoDeFalha(ev);
    escrever(await avaliar(ev));
  } catch {
    escrever(padrao);
  }
  process.exit(0);
}
