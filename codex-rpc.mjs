// Cliente JSON-RPC do `codex app-server` por stdio (uma mensagem JSON por linha, SEM o campo "jsonrpc":
// o esquema JSONRPCRequest/Response/Error do codex-cli 0.163 só tem id, method, params, result, error).
// LISTA FECHADA (decisão 2026-10-21 Codex no Orbit): `pedir` recusa localmente, sem enviar nada, qualquer
// método fora de METODOS_PERMITIDOS; pedido do servidor fora de PEDIDOS_DO_SERVIDOR_ACEITOS recebe erro
// -32601 sem chamar `aoPedir`. Não lê ~/.codex: o chamador passa CODEX_HOME no env.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Pedidos do cliente ao servidor (o `initialized` é notificação e sai só no handshake).
export const METODOS_PERMITIDOS = Object.freeze([
  'initialize', 'thread/start', 'thread/resume', 'thread/list', 'thread/read', 'turn/start',
  'turn/interrupt', 'thread/compact/start', 'model/list', 'account/read', 'account/rateLimits/read',
  // C1 (escritórios, falha fechada): só leitura da config efetiva e do estado dos MCP do thread; unsubscribe descarrega
  // o thread recusado. Usados só no modo escritório; o Codex comum não os chama.
  'config/read', 'mcpServerStatus/list', 'thread/unsubscribe',
]);
// Pedidos do servidor que o usuário responde (os dois últimos são os nomes antigos, v1).
export const PEDIDOS_DO_SERVIDOR_ACEITOS = Object.freeze([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'execCommandApproval', 'applyPatchApproval',
]);
// B1a (escritórios): pedidos FORA da lista que um thread de escritório recebe recusados por `aoForaDaLista` (resposta de
// recusa válida, não -32601). Sem `aoForaDaLista`, ou se ele devolver undefined, seguem com -32601 como os outros.
export const PEDIDOS_SO_RECUSA = Object.freeze(['item/tool/call', 'mcpServer/elicitation/request']);

// `aoPedir` devolve isto quando o servidor já resolveu o pedido por conta própria (serverRequest/resolved, fim do turno):
// nada é escrito de volta.
export const SEM_RESPOSTA = Symbol('sem-resposta');

export const TIMEOUT_PADRAO_MS = 30000;
const ERRO_METODO = -32601, ERRO_INTERNO = -32603;

// Versão do Orbit para o clientInfo (package.json ao lado; sem ele, 0.0.0).
function versaoDoOrbit() {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

function erro(mensagem, codigo, extra) {
  return Object.assign(new Error(mensagem), { codigo }, extra);
}

// Sobe o processo, faz o handshake (initialize + initialized) e devolve o cliente.
// opcoes: exe, args, env (junto ao process.env), cwd, aoNotificar(method, params), aoPedir(method, params) → Promise<result>,
// aoForaDaLista(method, params, id) → result|undefined (só PEDIDOS_SO_RECUSA, síncrono; B1a escritórios),
// aoSair({codigo, sinal}), log(tipo, dado), timeoutMs (por pedido), timeoutInicioMs (handshake), versao.
export async function abrirCodex(opcoes = {}) {
  const { exe, args = ['app-server'], env = {}, cwd, aoNotificar, aoPedir, aoForaDaLista, aoSair, log = () => {},
    timeoutMs = TIMEOUT_PADRAO_MS, timeoutInicioMs = timeoutMs, versao = versaoDoOrbit() } = opcoes;
  if (!exe) throw erro('abrirCodex: falta o caminho do executável (exe)', 'SEM_EXE');

  const filho = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const pendentes = new Map(); // id → {resolve, reject, timer, method}
  let proximoId = 1, saiu = false, fechando = false, resultadoSaida = null, bufOut = '', bufErr = '';
  let avisarSaida; const saida = new Promise((r) => { avisarSaida = r; });

  const escrever = (obj) => {
    if (saiu || !filho.stdin.writable) return false;
    try { filho.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  };
  filho.stdin.on('error', () => {}); // EPIPE quando o processo já saiu: o 'exit' trata os pendentes

  // Limpa todos os pendentes quando o processo sai (ou falha ao subir).
  const rejeitarPendentes = (motivo) => {
    for (const [id, p] of pendentes) { clearTimeout(p.timer); pendentes.delete(id); p.reject(erro(motivo, 'CODEX_SAIU', { method: p.method })); }
  };

  const tratarPedidoDoServidor = async (msg) => {
    const { id, method, params } = msg;
    if (!PEDIDOS_DO_SERVIDOR_ACEITOS.includes(method)) {
      log('pedido-recusado', { method });
      if (PEDIDOS_SO_RECUSA.includes(method) && typeof aoForaDaLista === 'function') {
        let r; try { r = aoForaDaLista(method, params, id); } catch { r = undefined; }
        if (r !== undefined) { escrever({ id, result: r }); return; }
      }
      escrever({ id, error: { code: ERRO_METODO, message: `Método fora da lista do Orbit: ${method}` } });
      return;
    }
    if (typeof aoPedir !== 'function') { escrever({ id, error: { code: ERRO_METODO, message: `Sem tratador para ${method}` } }); return; }
    try {
      const result = await aoPedir(method, params, id);
      if (result === SEM_RESPOSTA) return;
      escrever({ id, result: result === undefined ? {} : result });
    } catch (e) {
      const code = Number.isInteger(e?.code) ? e.code : ERRO_INTERNO;
      escrever({ id, error: { code, message: String(e?.message || e) } });
    }
  };

  const tratarMensagem = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.method !== undefined && msg.id !== undefined) { tratarPedidoDoServidor(msg); return; }
    if (msg.method !== undefined) { try { aoNotificar?.(msg.method, msg.params); } catch (e) { log('erro-no-tratador', String(e?.message || e)); } return; }
    if (msg.id === undefined) return;
    const p = pendentes.get(msg.id);
    if (!p) { log('resposta-sem-pedido', { id: msg.id }); return; }
    clearTimeout(p.timer); pendentes.delete(msg.id);
    if (msg.error) p.reject(erro(msg.error.message || 'erro do servidor', msg.error.code, { dados: msg.error.data, method: p.method }));
    else p.resolve(msg.result);
  };

  filho.stdout.setEncoding('utf8');
  filho.stdout.on('data', (d) => {
    bufOut += d;
    let i;
    while ((i = bufOut.indexOf('\n')) >= 0) {
      const linha = bufOut.slice(0, i).replace(/\r$/, ''); bufOut = bufOut.slice(i + 1);
      if (!linha.trim()) continue;
      let msg; try { msg = JSON.parse(linha); } catch { log('linha-invalida', linha.slice(0, 200)); continue; }
      tratarMensagem(msg);
    }
  });
  filho.stderr.setEncoding('utf8');
  filho.stderr.on('data', (d) => {
    bufErr += d;
    let i;
    while ((i = bufErr.indexOf('\n')) >= 0) { const l = bufErr.slice(0, i).replace(/\r$/, ''); bufErr = bufErr.slice(i + 1); if (l.trim()) log('stderr', l); }
  });

  const terminou = (codigo, sinal) => {
    if (saiu) return;
    saiu = true; resultadoSaida = { codigo, sinal };
    rejeitarPendentes(`O Codex saiu (${sinal || codigo})`);
    try { aoSair?.(resultadoSaida); } catch {}
    avisarSaida(resultadoSaida);
  };
  filho.on('exit', (codigo, sinal) => terminou(codigo, sinal));
  filho.on('close', (codigo, sinal) => terminou(codigo, sinal));

  // Falha ao subir (exe inexistente etc.): o evento 'error' vem antes de qualquer saída.
  const falhaAoSubir = new Promise((_, rej) => filho.once('error', (e) => { rej(erro(`Não consegui iniciar o Codex: ${e.message}`, 'SPAWN', { causa: e })); terminou(null, 'erro'); }));
  falhaAoSubir.catch(() => {});

  // Pedido com timeout; recusa local fora da lista, antes de qualquer escrita.
  const pedir = (method, params, { timeoutMs: tm = timeoutMs } = {}) => {
    if (!METODOS_PERMITIDOS.includes(method)) return Promise.reject(erro(`Método fora da lista fechada: ${method}`, 'FORA_DA_LISTA', { method }));
    if (saiu || fechando) return Promise.reject(erro('O Codex não está rodando', 'CODEX_SAIU', { method }));
    return new Promise((resolve, reject) => {
      const id = proximoId++;
      const timer = setTimeout(() => { pendentes.delete(id); reject(erro(`Tempo esgotado em ${method} (${tm} ms)`, 'TIMEOUT', { method })); }, tm);
      pendentes.set(id, { resolve, reject, timer, method });
      const obj = { id, method };
      if (params !== undefined) obj.params = params;
      if (!escrever(obj)) { clearTimeout(timer); pendentes.delete(id); reject(erro('O Codex não está rodando', 'CODEX_SAIU', { method })); }
    });
  };

  // Encerra: fecha o stdin (o app-server sai sozinho no EOF) e mata se não sair em `graca` ms.
  const fechar = async ({ graca = 1500 } = {}) => {
    if (saiu) return resultadoSaida;
    fechando = true;
    rejeitarPendentes('O cliente foi fechado');
    try { filho.stdin.end(); } catch {}
    const t = setTimeout(() => { try { filho.kill(); } catch {} }, graca);
    const r = await saida;
    clearTimeout(t);
    return r;
  };

  // Handshake: initialize (com clientInfo) e depois a notificação initialized.
  const cliente = { pedir, fechar, saida, get pid() { return filho.pid; }, get saiu() { return saiu; }, info: null };
  try {
    cliente.info = await Promise.race([
      pedir('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: versao } }, { timeoutMs: timeoutInicioMs }),
      falhaAoSubir,
    ]);
    escrever({ method: 'initialized' });
  } catch (e) {
    await fechar({ graca: 300 }).catch(() => {});
    throw e;
  }
  return cliente;
}
