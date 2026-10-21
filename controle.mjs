// Orbit — controle das instâncias (rodada 5). Rodada 5.
// Três partes, sem dependências:
//  1. Conversa: lê o transcript (~/.claude/projects/<proj>/<id>.jsonl) em itens normalizados,
//     do fim para trás em blocos (cursor = offset de byte) e, ao vivo, pela cauda (SSE por sessão).
//  2. Canal: manda mensagem para uma sessão viva pelo pipe dela (auth com o peerToken do .key),
//     confirmada quando a entrada aparece no transcript.
//  3. Processos do Orbit: retoma a sessão em `claude -p` stream-json (assumir), e por ele manda
//     mensagem como o usuário, compacta, limpa, responde permissões (protocolo de controle do SDK)
//     e devolve. Cada ação vira uma `Acao` difundida no /fluxo (evento `acao`).
//     Rodada 6 (etapa 1): os processos moram no motor.mjs (processo destacado). Reiniciar o servidor
//     não os mata; na subida, o controle adota as instâncias vivas. Sem o motor, spawn direto.
//     Rodada 6 (etapa 2): instância nova nativa (POST /instancias, --session-id), modelo e esforço ao
//     vivo (set_model / apply_flag_settings, conferidos por get_settings), GET /modelos (initialize de
//     uma sonda curta, sem hooks, guardado em <DADOS>/modelos.json) e título (generate_session_title).
//     Rodada 6 (etapa 3): conversa completa. Parar (interrupt), modo de permissão (set_permission_mode),
//     pedidos tipados (ferramenta, pergunta do AskUserQuestion, plano do ExitPlanMode) com as sugestões
//     do claude, tarefas em segundo plano, texto ao vivo (--include-partial-messages → SSE `parcial`) e o
//     contexto (usage da última resposta + modelUsage[m].contextWindow do result).
// O servidor.mjs só encaixa: criarControle(deps), rota(), estado(s) no publico(), encerrarTudo().

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { binarioClaude, atualizarBinario } from './binario.mjs';
import { VERSAO as VERSAO_MOTOR } from './motor.mjs';
import { pathAmpliado, matarArvore } from './plataforma.mjs';
import { pastaDeProgresso } from './aviso-subagente.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const DADOS = path.resolve(process.env.GERENCIADOR_DADOS || PASTA); // a mesma regra do servidor.mjs
const SESSOES_DIR = path.resolve(process.env.GERENCIADOR_SESSOES_DIR || path.join(os.homedir(), '.claude', 'sessions'));
const PROJETOS_DIR = path.resolve(process.env.ORBIT_PROJETOS_DIR || path.join(os.homedir(), '.claude', 'projects'));
const ms = (nome, padrao) => Number(process.env[nome]) || padrao;
const MS_CANAL = ms('ORBIT_MS_CANAL', 60e3); // mensagem pelo canal precisa aparecer no transcript
const MS_MENSAGEM = ms('ORBIT_MS_MENSAGEM', 5 * 60e3); // mensagem pelo Orbit: eco do user
const MS_COMPACTAR = ms('ORBIT_MS_COMPACTAR', 5 * 60e3);
const MS_LIMPAR = ms('ORBIT_MS_LIMPAR', 60e3);
const MS_INICIO = ms('ORBIT_MS_INICIO', 60e3); // assumir: o processo precisa responder ao initialize
const MS_DEVOLVER = ms('ORBIT_MS_DEVOLVER', 10e3);
const MS_REGISTRO = ms('ORBIT_MS_REGISTRO', 3000);
const MS_VIGIA = ms('ORBIT_MS_VIGIA', 500);
const MS_MOTOR = ms('ORBIT_MS_MOTOR', 8000); // subir o motor e conectar; depois disso, spawn direto
const USAR_MOTOR = process.env.ORBIT_MOTOR !== '0'; // ORBIT_MOTOR=0 desliga o motor (spawn direto)
const ARQ_MOTOR = path.resolve(process.env.ORBIT_MOTOR_ARQ || path.join(PASTA, 'motor.mjs'));
const MS_PING = 25e3;
// Etapa 2: modelos (sonda na subida + 30 s e a cada 6 h). Servidores de teste (dados próprios) só sondam
// quando apontam um binário (ORBIT_CLAUDE_BIN): sem isso, a sonda rodaria o claude.exe de verdade.
const MS_MODELOS_INICIO = ms('ORBIT_MS_MODELOS_INICIO', 30e3);
const MS_MODELOS_CICLO = ms('ORBIT_MS_MODELOS_CICLO', 6 * 3600e3);
const MS_SONDA = ms('ORBIT_MS_SONDA', 60e3);
const MS_SONDA_MCP = ms('ORBIT_MS_SONDA_MCP', 15e3);
const MS_AJUSTE = ms('ORBIT_MS_AJUSTE', 15e3); // set_model, apply_flag_settings, get_settings
const MS_TITULO = ms('ORBIT_MS_TITULO', 60e3);
const MS_PARAR = ms('ORBIT_MS_PARAR', 30e3); // depois do interrupt, o `result` da volta tem de chegar
const MS_PARCIAL = 100; // etapa 3: no máximo ~10 eventos `parcial` por segundo por sessão
const MAX_MOTIVO = 2000; // mensagem do negar
const MAX_MAPA_PARCIAIS = 300;
const SONDAR = process.env.ORBIT_MODELOS !== '0' && (!process.env.GERENCIADOR_DADOS || !!process.env.ORBIT_CLAUDE_BIN);
const ARQ_MODELOS = path.join(DADOS, 'modelos.json');
// `auto` (16/10): aceito pelo --permission-mode e pelo set_permission_mode da 2.1.300 (testado). Só vale
// para as instâncias do Orbit: vai no argv / protocolo de controle, nada global muda.
const PERMISSOES = ['default', 'acceptEdits', 'plan', 'auto'];
const MAX_NOME = 60;
const MAX_SKILLS = 300; // allowlist de skills da Nova instância
// Lista de skills guardada (registro ou meta do motor): só nomes de texto; qualquer outra coisa = todas.
const listaSkills = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, MAX_SKILLS) : null);
const MAX_PROCESSOS = Number(process.env.ORBIT_MOTOR_MAX) || 5; // etapa 4: conta só os processos vivos
// Etapa 4: ciclo de vida. ORBIT_DORMIR_MS sobrepõe config.instancias.dormirApos (minutos) nos testes.
const ARQ_INSTANCIAS = path.join(DADOS, 'instancias.json');
const MS_FECHAR_DORMIR = 5000; // dormir: stdin.end; sem sair em 5 s, matar
const MS_MEMORIA = ms('ORBIT_MS_MEMORIA', 30e3); // um tasklist para todos os processos
const MS_TIQUE_DORMIR = ms('ORBIT_MS_TIQUE_DORMIR', 1000);
const AGENDA = new Set(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger']); // tool_use que agenda: não dorme
const MEMORIA_DIFERENCA = 5 * 1024 * 1024;
const MAX_ACOES = 20;
const MAX_TEXTO = 20000;
const MAX_FOCO = 500;
// Compactação automática (20/10): config.instancias.autoCompactar {ativo, limite, foco}; cada instância pode
// sobrepor o `ativo` (instancias.json: autoCompactar true/false; sem o campo, vale a config). Só compacta com a
// instância parada: sem volta, permissão aberta, subagente, tarefa em segundo plano nem outra ação, e com
// MS_AUTO_QUIETO sem nenhuma linha no stdout (a mensagem na fila começa a volta seguinte nesse intervalo).
export const AUTO_COMPACTAR_PADRAO = Object.freeze({
  ativo: true,
  limite: 140000,
  foco: 'Preserve o pedido original do usuário e as demandas principais, as decisões tomadas, o que já foi feito, o que falta fazer, os arquivos alterados, os arquivos de progresso em uso e qualquer restrição ou preferência do usuário.',
});
export const LIMITE_AUTO_MIN = 20000;
export const LIMITE_AUTO_MAX = 2000000;
const MS_AUTO_QUIETO = ms('ORBIT_MS_AUTO_QUIETO', 3000);
const MS_TIQUE_AUTO = ms('ORBIT_MS_TIQUE_AUTO', 1000);
const MS_AUTO_RECUO = ms('ORBIT_MS_AUTO_RECUO', 10 * 60e3); // depois de uma falha, só tenta de novo passado isso
const MS_AGENTE_PARADO = 15 * 60e3; // subagente "ativo" sem atividade há mais que isso: SubagentStop perdido, não segura
const MAX_AUTO_HIST = 10;
// Arquivos de progresso: relidos depois da compactação automática. Ficam na pasta de dados
// (<dados>/progresso/<nome da pasta do projeto>/, a regra do aviso-subagente.mjs), nunca no projeto do usuário.
export { PASTA_PROGRESSO } from './aviso-subagente.mjs';
const MAX_RESULTADO = 2000;
const MAX_SAIDA = 8000; // saída de comando local (o /context passa de 2000)
const MAX_COMANDOS = 300;
const LIMITE_PADRAO = 150;
const LIMITE_MAX = 500;
const BLOCO = 256 * 1024;
const MAX_CAUDA = 32 * 1024 * 1024; // a linha de uma mensagem com imagens (base64) cabe inteira
// Imagens anexadas (16/10): vão ao claude como blocos `image` (base64) no stdin stream-json, sem arquivo
// em disco. O transcript guarda os blocos; o histórico os lê de lá (GET /sessao/:id/imagem?o=&i=).
const TIPOS_IMAGEM = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']); // os que a API aceita
const MAX_IMAGENS = 10;
const MAX_IMAGEM = 5 * 1024 * 1024; // base64 por imagem: o limite da API
const MAX_IMAGENS_TOTAL = 24 * 1024 * 1024; // base64 somado por mensagem
const MAX_CORPO_IMAGENS = MAX_IMAGENS_TOTAL + 1024 * 1024;
const RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_LINHA_IMAGEM = 40 * 1024 * 1024; // GET /imagem: a linha do transcript lida até aqui
const MAX_CACHE_FERR = 3000;

// ───────────────────────── utilidades ─────────────────────────

function encurtar(t, max) {
  const s = String(t ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function erroHttp(status, erro, codigo) {
  const e = new Error(erro);
  e.status = status;
  e.codigo = codigo;
  return e;
}

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const dormir = (t) => new Promise((r) => setTimeout(r, t));

function textoDe(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

// Env do processo filho: sem nada CLAUDE*/CLAUDECODE herdado (entrypoint, token, sessão-mãe) nem do
// VS Code (VSCODE_*, ELECTRON_*, TERM_PROGRAM*: o claude não deve achar que roda dentro do editor), e
// sem auto-update (a cópia do Orbit é atualizada pelo binario.mjs; nada global muda).
export function envLimpo(env = process.env) {
  const o = {};
  for (const k in env) if (!/^(CLAUDE|VSCODE_|ELECTRON_|TERM_PROGRAM)/i.test(k)) o[k] = env[k];
  o.DISABLE_AUTOUPDATER = '1';
  // Mac/Linux: o launchd sobe o Orbit com PATH mínimo; o claude e as ferramentas dele precisam do
  // Homebrew e do ~/.local/bin. No Windows o env segue como era (lá a variável é "Path").
  if (process.platform !== 'win32') o.PATH = pathAmpliado({ env });
  return o;
}

// ───────────────────────── 1. conversa ─────────────────────────

// Estado por arquivo de transcript: ferramentas vistas (para casar o tool_result pelo tool_use_id)
// e resultados vistos antes do tool_use (leitura de trás para frente).
const arquivos = new Map();
function arquivoDe(caminho) {
  let a = arquivos.get(caminho);
  if (!a) {
    a = { ferramentas: new Map(), resultados: new Map(), ultCompact: null };
    arquivos.set(caminho, a);
    if (arquivos.size > 30) arquivos.delete(arquivos.keys().next().value);
  }
  return a;
}
function guardar(mapa, k, v) {
  mapa.delete(k);
  mapa.set(k, v);
  if (mapa.size > MAX_CACHE_FERR) mapa.delete(mapa.keys().next().value);
}

function resumoFerramenta(nome, e) {
  if (!e || typeof e !== 'object') return '';
  const v =
    e.command ?? e.file_path ?? e.notebook_path ?? e.path ?? e.pattern ?? e.url ?? e.query ?? e.description ?? e.prompt ?? e.skill ?? e.subject ??
    Object.values(e).find((x) => typeof x === 'string');
  return encurtar(String(v ?? '').replace(/\s+/g, ' ').trim(), 200);
}

const RE_CMD = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const RE_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const RE_LOCAL = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const RE_INTERROMPIDO = /^\s*\[Request interrupted by user/;

function semEmbrulhoDoPar(t) {
  return String(t)
    .replace(/^\s*Another Claude session sent a message:\s*\n?/, '')
    .replace(/\n+This came from another Claude session[\s\S]*$/, '')
    .trim();
}

function textoDoUsuario(it, txt, uid, ts, arq, out) {
  if (RE_INTERROMPIDO.test(txt)) return out.push({ id: uid, ts, tipo: 'interrupcao' });
  if (RE_LOCAL.test(txt)) return; // avisos de comando local: fora da conversa
  const cmd = RE_CMD.exec(txt);
  if (cmd) {
    let nome = cmd[1].trim();
    if (nome && nome[0] !== '/') nome = '/' + nome;
    const args = (RE_ARGS.exec(txt)?.[1] || '').trim();
    if (nome === '/clear') return out.push({ id: uid, ts, tipo: 'limpeza' });
    if (nome === '/compact' && args && arq.ultCompact && !arq.ultCompact.foco) {
      arq.ultCompact.foco = encurtar(args, MAX_FOCO);
      if (it === 'cauda') out.push({ ...arq.ultCompact });
    }
    return out.push({ id: uid, ts, tipo: 'comando', texto: (nome + ' ' + args).trim() });
  }
  out.push({ id: uid, ts, tipo: 'usuario', texto: txt });
}

function registrarResultado(arq, b, modo, out) {
  const id = String(b.tool_use_id || '');
  if (!id) return;
  const r = { texto: encurtar(textoDe(b.content), MAX_RESULTADO), erro: !!b.is_error };
  guardar(arq.resultados, id, r);
  const it = arq.ferramentas.get(id);
  if (!it) return;
  it.resultado = r;
  if (modo === 'cauda') out.push({ ...it }); // o mesmo item, agora com o resultado
}

// Uma entrada do transcript → zero ou mais itens. modo 'pagina' (leitura para trás) ou 'cauda' (ao vivo).
// Imagens de um content do usuário → referências {o, i, tipo} (o = offset da linha no transcript).
function imagensDe(c, off) {
  if (!Array.isArray(c) || off == null) return [];
  const r = [];
  c.forEach((b, i) => {
    const t = b?.type === 'image' && b.source?.type === 'base64' ? String(b.source.media_type || '') : '';
    if (TIPOS_IMAGEM.has(t)) r.push({ o: off, i, tipo: t });
  });
  return r;
}

// off: offset da linha no transcript (as imagens do usuário viram referências para GET /imagem).
export function normalizar(e, arq, modo = 'pagina', off = null) {
  const out = [];
  if (!e || typeof e !== 'object' || e.isSidechain) return out;
  const ts = Date.parse(e.timestamp) || 0;
  const uid = String(e.uuid || e.id || `${e.type}-${ts}`);
  if (e.type === 'system') {
    if (e.subtype === 'compact_boundary') {
      const m = e.compact_metadata || e.compactMetadata || {};
      const it = { id: uid, ts, tipo: 'compactacao' };
      const pre = Number(m.pre_tokens ?? m.preTokens);
      const pos = Number(m.post_tokens ?? m.postTokens);
      if (pre) it.pre = pre;
      if (pos) it.pos = pos;
      arq.ultCompact = it;
      out.push(it);
    } else if (e.subtype === 'local_command') {
      // Saída de um comando local (/context, /usage, /model…): vai direto ao usuário, como no terminal.
      const bruto = String(e.content ?? '');
      const erro = /<local-command-stderr>/.test(bruto);
      const t = bruto.replace(/<\/?local-command-(stdout|stderr)>/g, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (t) out.push({ id: uid, ts, tipo: 'saida', texto: encurtar(t, MAX_SAIDA), ...(erro ? { erro: true } : {}) });
    } else if (e.level === 'error') {
      out.push({ id: uid, ts, tipo: 'erro', texto: encurtar(textoDe(e.content) || e.subtype || 'erro', 2000) });
    }
    return out;
  }
  if (e.type === 'user') {
    if (e.isCompactSummary) return out;
    const c = e.message?.content;
    if (e.isMeta) {
      if (e.origin?.kind === 'peer') out.push({ id: uid, ts, tipo: 'par', texto: semEmbrulhoDoPar(textoDe(c)) });
      return out;
    }
    if (Array.isArray(c)) {
      for (const b of c) if (b?.type === 'tool_result') registrarResultado(arq, b, modo, out);
      const txt = textoDe(c);
      const imgs = imagensDe(c, off);
      if (txt) textoDoUsuario(modo, txt, uid, ts, arq, out);
      else if (imgs.length) out.push({ id: uid, ts, tipo: 'usuario', texto: '' });
      else if (c.some((b) => b?.type === 'image')) out.push({ id: uid, ts, tipo: 'usuario', texto: '[imagem]' }); // sem offset
      const it = out[out.length - 1];
      if (imgs.length && it?.id === uid && it.tipo === 'usuario') it.imagens = imgs;
    } else if (typeof c === 'string' && c) textoDoUsuario(modo, c, uid, ts, arq, out);
    return out;
  }
  if (e.type === 'assistant') {
    const c = e.message?.content;
    if (e.isApiErrorMessage) {
      out.push({ id: uid, ts, tipo: 'erro', texto: encurtar(textoDe(c) || 'Erro da API', 2000) });
      return out;
    }
    const blocos = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const varios = blocos.length > 1;
    blocos.forEach((b, i) => {
      const id = varios ? `${uid}:${i}` : uid;
      if (b?.type === 'text' && String(b.text || '').trim()) out.push({ id, ts, tipo: 'assistente', texto: String(b.text) });
      else if (b?.type === 'thinking') out.push({ id, ts, tipo: 'pensamento', texto: String(b.thinking || '') });
      else if (b?.type === 'redacted_thinking') out.push({ id, ts, tipo: 'pensamento', texto: '' });
      else if (b?.type === 'tool_use') {
        const fid = String(b.id || id);
        const it = { id: fid, ts, tipo: 'ferramenta', nome: String(b.name || ''), resumo: resumoFerramenta(b.name, b.input) };
        const r = arq.resultados.get(fid);
        if (r) it.resultado = r;
        guardar(arq.ferramentas, fid, it);
        out.push(it);
      }
    });
  }
  return out;
}

// Mesmo id → uma vez, na posição da primeira, com a versão mais nova.
function juntar(itens) {
  const pos = new Map();
  const out = [];
  for (const it of itens) {
    if (pos.has(it.id)) out[pos.get(it.id)] = it;
    else {
      pos.set(it.id, out.length);
      out.push(it);
    }
  }
  return out;
}

function linhas(buf, base) {
  const r = [];
  let ini = 0;
  for (;;) {
    const nl = buf.indexOf(10, ini);
    if (nl < 0) break;
    if (nl > ini) {
      try {
        r.push({ off: base + ini, e: JSON.parse(buf.toString('utf8', ini, nl)) });
      } catch {}
    }
    ini = nl + 1;
  }
  return r;
}

// Fim das linhas completas (a última pode estar sendo escrita).
async function fimCompleto(caminho) {
  let fh;
  try {
    fh = await fsp.open(caminho, 'r');
    const tam = (await fh.stat()).size;
    let fim = tam;
    while (fim > 0) {
      const ini = Math.max(0, fim - 64 * 1024);
      const b = Buffer.alloc(fim - ini);
      await fh.read(b, 0, b.length, ini);
      const nl = b.lastIndexOf(10);
      if (nl >= 0) return ini + nl + 1;
      fim = ini;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// Página da conversa: os últimos `limite` itens antes do byte `antes` (null = fim do arquivo).
export async function lerConversa(caminho, antes = null, limite = LIMITE_PADRAO) {
  const arq = arquivoDe(caminho);
  let fh;
  try {
    fh = await fsp.open(caminho, 'r');
  } catch {
    return { itens: [], cursorAntigo: null, cursorNovo: 0 };
  }
  try {
    const tam = (await fh.stat()).size;
    const fimArquivo = antes == null ? await fimCompleto(caminho) : Math.min(antes, tam);
    let fim = fimArquivo;
    let carry = Buffer.alloc(0);
    const grupos = []; // [{off, itens}] do mais antigo para o mais novo
    let total = 0;
    while (fim > 0 && total < limite) {
      const ini = Math.max(0, fim - BLOCO);
      const buf = Buffer.alloc(fim - ini);
      await fh.read(buf, 0, buf.length, ini);
      const dados = carry.length ? Buffer.concat([buf, carry]) : buf;
      let corte = 0;
      if (ini > 0) {
        const nl = dados.indexOf(10);
        if (nl < 0) {
          carry = dados;
          fim = ini;
          continue;
        }
        corte = nl + 1;
      }
      // Linhas completas do bloco, em ordem; a última pode não ter \n se for o fim do intervalo.
      let corpo = dados.subarray(corte);
      if (corpo.length && corpo[corpo.length - 1] !== 10) corpo = Buffer.concat([corpo, Buffer.from('\n')]);
      const doBloco = [];
      for (const { off, e } of linhas(corpo, ini + corte)) {
        const itens = normalizar(e, arq, 'pagina', off);
        if (itens.length) doBloco.push({ off, itens });
      }
      grupos.unshift(...doBloco);
      total += doBloco.reduce((n, g) => n + g.itens.length, 0);
      carry = Buffer.from(dados.subarray(0, corte));
      fim = ini;
    }
    // Mantém os grupos (linhas) do fim até juntar o limite.
    let n = 0;
    let k = grupos.length;
    while (k > 0 && n < limite) n += grupos[--k].itens.length;
    const mantidos = grupos.slice(k);
    const temAntes = k > 0 || fim > 0;
    const cursorAntigo = mantidos.length ? (temAntes && mantidos[0].off > 0 ? String(mantidos[0].off) : null) : temAntes ? String(fim) : null;
    return { itens: juntar(mantidos.flatMap((g) => g.itens)), cursorAntigo, cursorNovo: fimArquivo };
  } finally {
    await fh.close().catch(() => {});
  }
}

// Uma imagem do usuário no transcript: a linha que começa no byte `off`, bloco `i` do content.
export async function lerImagem(caminho, off, i) {
  let fh;
  try {
    fh = await fsp.open(caminho, 'r');
    const tam = (await fh.stat()).size;
    if (off >= tam) return null;
    const partes = [];
    let pos = off;
    let fim = -1;
    while (pos < tam && pos - off < MAX_LINHA_IMAGEM) {
      const b = Buffer.alloc(Math.min(1024 * 1024, tam - pos));
      const { bytesRead } = await fh.read(b, 0, b.length, pos);
      if (!bytesRead) break;
      const nl = b.subarray(0, bytesRead).indexOf(10);
      partes.push(b.subarray(0, nl < 0 ? bytesRead : nl));
      if (nl >= 0) {
        fim = pos + nl;
        break;
      }
      pos += bytesRead;
    }
    if (fim < 0) return null;
    let e;
    try {
      e = JSON.parse(Buffer.concat(partes).toString('utf8'));
    } catch {
      return null; // o offset não é o começo de uma linha
    }
    const b = e?.type === 'user' && Array.isArray(e.message?.content) ? e.message.content[i] : null;
    const tipo = b?.type === 'image' && b.source?.type === 'base64' ? String(b.source.media_type || '') : '';
    if (!TIPOS_IMAGEM.has(tipo) || typeof b.source.data !== 'string') return null;
    return { tipo, dados: Buffer.from(b.source.data, 'base64') };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// Imagens do corpo do POST (mensagem e nova instância): [{tipo, dados (base64)}] → blocos `image` da API.
function blocosDeImagens(lista) {
  if (lista == null) return [];
  if (!Array.isArray(lista)) throw erroHttp(400, 'imagens deve ser uma lista.');
  if (lista.length > MAX_IMAGENS) throw erroHttp(400, `Mande até ${MAX_IMAGENS} imagens por mensagem.`);
  let total = 0;
  return lista.map((x, n) => {
    const tipo = String(x?.tipo || '').toLowerCase();
    const dados = typeof x?.dados === 'string' ? x.dados : '';
    if (!TIPOS_IMAGEM.has(tipo)) throw erroHttp(400, `Imagem ${n + 1}: formato não aceito. Use PNG, JPEG, GIF ou WebP.`);
    if (!dados || dados.length % 4 || !RE_BASE64.test(dados)) throw erroHttp(400, `Imagem ${n + 1}: dados inválidos.`);
    if (dados.length > MAX_IMAGEM) throw erroHttp(400, `Imagem ${n + 1}: passa de ${MAX_IMAGEM / 1024 / 1024} MB.`);
    if ((total += dados.length) > MAX_IMAGENS_TOTAL) throw erroHttp(400, `As imagens somam mais de ${MAX_IMAGENS_TOTAL / 1024 / 1024} MB.`);
    return { type: 'image', source: { type: 'base64', media_type: tipo, data: dados } };
  });
}
const contarImagens = (c) => (Array.isArray(c) ? c.filter((b) => b?.type === 'image').length : 0);

// Leitura incremental para frente, por offset (SSE e confirmações).
class Cauda {
  constructor(caminho, offset) {
    this.caminho = caminho;
    this.offset = offset;
    this.pular = false;
    this.lendo = false;
  }
  async ler() {
    if (this.lendo) return { entradas: [] };
    this.lendo = true;
    let fh;
    try {
      let st;
      try {
        st = await fsp.stat(this.caminho);
      } catch {
        return { entradas: [], sumiu: true };
      }
      if (st.size < this.offset) return { entradas: [], encolheu: true, tam: st.size };
      if (st.size === this.offset) return { entradas: [] };
      const n = Math.min(st.size - this.offset, MAX_CAUDA);
      const buf = Buffer.alloc(n);
      fh = await fsp.open(this.caminho, 'r');
      await fh.read(buf, 0, n, this.offset);
      const nl = buf.lastIndexOf(10);
      if (nl < 0) {
        if (n === MAX_CAUDA) {
          this.offset += n; // linha gigante (blob): pula até o próximo \n
          this.pular = true;
        }
        return { entradas: [] };
      }
      let ini = 0;
      if (this.pular) {
        ini = buf.indexOf(10) + 1;
        this.pular = false;
      }
      const entradas = linhas(buf.subarray(ini, nl + 1), this.offset + ini);
      this.offset += nl + 1;
      return { entradas };
    } catch {
      return { entradas: [] };
    } finally {
      this.lendo = false;
      await fh?.close().catch(() => {});
    }
  }
}

// Modelo e cwd da sessão, do fim do transcript.
async function dadosDoTranscript(caminho) {
  const r = { modelo: '', cwd: '' };
  let fh;
  try {
    fh = await fsp.open(caminho, 'r');
    const tam = (await fh.stat()).size;
    const ini = Math.max(0, tam - 1024 * 1024);
    const b = Buffer.alloc(tam - ini);
    await fh.read(b, 0, b.length, ini);
    const ls = linhas(b, ini).reverse();
    for (const { e } of ls) {
      if (!r.cwd && typeof e.cwd === 'string' && e.cwd) r.cwd = e.cwd;
      const m = e.type === 'assistant' && e.message?.model;
      if (!r.modelo && typeof m === 'string' && m && m[0] !== '<') r.modelo = m;
      if (r.modelo && r.cwd) break;
    }
  } catch {
  } finally {
    await fh?.close().catch(() => {});
  }
  return r;
}

// ───────────────────────── registro de processos (~/.claude/sessions) ─────────────────────────

async function lerRegistros() {
  let nomes;
  try {
    nomes = await fsp.readdir(SESSOES_DIR);
  } catch {
    return [];
  }
  const chaves = new Set(nomes.filter((n) => /^\d+\..+\.key$/.test(n)).map((n) => n.split('.')[0]));
  const lidos = await Promise.all(
    nomes
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const r = JSON.parse(await fsp.readFile(path.join(SESSOES_DIR, n), 'utf8'));
          const pid = Number(r.pid);
          if (!r || typeof r.sessionId !== 'string' || !Number.isInteger(pid) || pid <= 0) return null;
          return {
            pid,
            sessionId: r.sessionId,
            status: typeof r.status === 'string' ? r.status : '',
            socket: typeof r.messagingSocketPath === 'string' ? r.messagingSocketPath : '',
            procStart: r.procStart != null ? String(r.procStart) : '',
            startedAt: Number(r.startedAt) || null,
            cwd: typeof r.cwd === 'string' ? r.cwd : '',
            temChave: chaves.has(String(pid)),
            vivo: vivo(pid),
          };
        } catch {
          return null;
        }
      }),
  );
  return lidos.filter(Boolean);
}

async function tokenDoCanal(reg) {
  const nomes = await fsp.readdir(SESSOES_DIR);
  const hash = crypto.createHash('sha256').update(reg.socket).digest('hex');
  const exato = `${reg.pid}.${hash}.key`;
  const nome = nomes.includes(exato) ? exato : nomes.find((n) => n.startsWith(`${reg.pid}.`) && n.endsWith('.key'));
  if (!nome) throw new Error('chave do canal não encontrada');
  const k = JSON.parse(await fsp.readFile(path.join(SESSOES_DIR, nome), 'utf8'));
  if (!k?.peerToken) throw new Error('chave do canal sem token');
  return String(k.peerToken);
}

// Início do processo no formato do procStart que o Claude Code grava no registro, ou null.
//  - Windows: FILETIME (o número do registro, ex. "134366098495981063").
//  - Mac/Linux: o Claude Code grava a saída de `ps -o lstart= -p <pid>` rodado com LC_ALL=C e TZ=UTC,
//    sem espaços nas pontas (ex. "Thu Oct 16 14:03:22 2026"). Fonte: o próprio binário 2.1.300 (a função
//    que monta o procStart do <pid>.json; fora do Windows ela roda esse ps). Aqui roda o mesmo comando.
// Sem resposta (ps falhou, processo sumiu, saída estranha) → null, e quem chama bloqueia (falha segura).
// `o = { so, execFile }` só para os testes simularem o Mac.
export function inicioDoProcesso(pid, o = {}) {
  const so = o.so || process.platform;
  const rodar = o.execFile || execFile;
  if (so === 'win32') {
    return new Promise((resolve) => {
      rodar(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
        { windowsHide: true, timeout: 15000 },
        (err, out) => resolve(err ? null : String(out).trim() || null),
      );
    });
  }
  if (!(Number(pid) > 0)) return Promise.resolve(null);
  const ps = so === 'darwin' ? '/bin/ps' : 'ps';
  const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC', PATH: pathAmpliado({ so }) };
  return new Promise((resolve) => {
    rodar(ps, ['-o', 'lstart=', '-p', String(Number(pid))], { timeout: 15000, env }, (err, out) => resolve(err ? null : inicioPeloPs(out)));
  });
}

// Saída do `ps -A -o pid=,rss=` (Mac/Linux) → Map pid → bytes.
export function memoriaPosix(out) {
  const mem = new Map();
  for (const l of String(out ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(l);
    if (m) mem.set(Number(m[1]), Number(m[2]) * 1024);
  }
  return mem;
}

// Pasta da instância nova: caminho completo do sistema. No Windows, "\x" e "/x" (raiz do disco atual)
// não valem; no Mac/Linux todo caminho completo começa com "/".
export function pastaAbsolutaValida(bruta, so = process.platform) {
  const p = so === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(bruta)) return false;
  return so !== 'win32' || !/^[\\/](?![\\/])/.test(bruta);
}
export const exemploPasta = (so = process.platform) => (so === 'win32' ? 'D:\\Projetos\\app' : so === 'darwin' ? '/Users/voce/Projetos/app' : '/home/voce/projetos/app');

// Saída do `ps -o lstart=` → o texto do procStart (uma linha, sem espaços nas pontas) ou null.
export function inicioPeloPs(out) {
  const s = String(out ?? '').trim();
  return s && !/[\r\n]/.test(s) ? s : null;
}

const MESES = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "Thu Oct 16 14:03:22 2026" (lstart em LC_ALL=C, TZ=UTC) → ms desde 1970, ou null.
function msDoLstart(s) {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(String(s).trim().replace(/\s+/g, ' '));
  if (!m || !(m[1] in MESES)) return null;
  const t = Date.UTC(+m[6], MESES[m[1]], +m[2], +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? t : null;
}

// O início gravado no registro (a) bate com o lido agora (b)? Número com número: FILETIME, 1 s de folga
// (Windows, como sempre foi). Texto com texto: o lstart do ps, igual (fora espaços repetidos) ou a até 1 s.
// Formatos diferentes, vazio ou ilegível → false (bloqueia).
export function mesmoInicio(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (!x || !y) return false;
  const num = /^\d+$/;
  if (num.test(x) && num.test(y)) {
    const d = BigInt(x) - BigInt(y);
    return (d < 0n ? -d : d) <= 10000000n; // 1 s de folga
  }
  if (num.test(x) || num.test(y)) return false;
  if (x.replace(/\s+/g, ' ') === y.replace(/\s+/g, ' ')) return true;
  const ta = msDoLstart(x);
  const tb = msDoLstart(y);
  return ta !== null && tb !== null && Math.abs(ta - tb) <= 1000;
}

async function esperarSair(pid, t) {
  const fim = Date.now() + t;
  while (Date.now() < fim) {
    if (!vivo(pid)) return true;
    await dormir(100);
  }
  return !vivo(pid);
}

// ───────────────────────── binário do claude ─────────────────────────
// Etapa 0 da migração sem VS Code: o binário vem da cópia própria do Orbit (binario.mjs).

export { binarioClaude };

const ehObjeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Conexões MCP (17/10): junta as listas ao JSON do --settings que já houver (um --settings só por processo).
export function comSettings(args, extra) {
  const a = [...args];
  const i = a.indexOf('--settings');
  if (i >= 0 && i + 1 < a.length) {
    try {
      const j = JSON.parse(a[i + 1]);
      if (ehObjeto(j)) {
        for (const [k, v] of Object.entries(extra)) j[k] = Array.isArray(v) ? [...new Set([...(Array.isArray(j[k]) ? j[k] : []), ...v])] : v;
        a[i + 1] = JSON.stringify(j);
        return a;
      }
    } catch {}
  }
  a.push('--settings', JSON.stringify(extra));
  return a;
}

function argsExtras() {
  try {
    const a = JSON.parse(process.env.ORBIT_CLAUDE_ARGS || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// Orientação de terminal das instâncias abertas pelo Orbit (só elas: vai no --append-system-prompt do
// processo, nunca no ~/.claude). 79% dos comandos dos agentes começavam com `cd "<pasta>"; …`, e esse formato
// sempre pede permissão; o caminho no próprio comando roda sem pedir (testado na 2.1.300 em 15/10). O mesmo
// Com --append-system-prompt no ORBIT_CLAUDE_ARGS, vale o de lá.
export const ORIENTACAO_TERMINAL = [
  'Comandos de terminal (Bash e PowerShell): o diretório de trabalho já é a pasta desta sessão.',
  'Não comece comandos com cd, Set-Location ou Push-Location (nem "cd pasta && …" ou "cd pasta; …"): esse formato sempre pede permissão ao usuário.',
  'Use o caminho no próprio comando: cat sub/a.txt, Get-Content sub/a.txt, ls sub, node testes/x.mjs, git log -- sub.',
  'Para git no repositório desta pasta, rode git direto; para git em outra pasta, use git -C <pasta> em vez de cd.',
  // Separador: 23 dos 98 pedidos da linha de base (15/10) eram `Get-Content a; "-----"; Get-Content b`.
  "No PowerShell, não use texto solto como separador entre comandos (\"-----\" ou '-----' sozinho): isso pede permissão; use Write-Output '-----'.",
].join(' ');

function argsOrientacao(extras) {
  return extras.includes('--append-system-prompt') ? [] : ['--append-system-prompt', ORIENTACAO_TERMINAL];
}

// ───────────────────────── modelos (rodada 6, etapa 2) ─────────────────────────
// `models` do initialize (value, resolvedModel, displayName, description, supportsEffort,
// supportedEffortLevels) → [{valor, modelo, nome, descricao, esforcos}]. Sem esforço: esforcos [].

export function normalizarModelos(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  const out = [];
  for (const m of lista) {
    const valor = typeof m?.value === 'string' ? m.value.trim().slice(0, 100) : '';
    if (!valor || vistos.has(valor)) continue;
    vistos.add(valor);
    const niveis = m.supportsEffort === false || !Array.isArray(m.supportedEffortLevels) ? [] : m.supportedEffortLevels.filter((x) => typeof x === 'string' && /^[\w-]{1,20}$/.test(x));
    out.push({
      valor,
      modelo: typeof m.resolvedModel === 'string' && m.resolvedModel ? m.resolvedModel.slice(0, 100) : valor,
      nome: encurtar(m.displayName || valor, 80),
      descricao: encurtar(m.description || '', 300),
      esforcos: niveis,
    });
  }
  return out;
}

function lerModelosSalvos() {
  try {
    const j = JSON.parse(fs.readFileSync(ARQ_MODELOS, 'utf8'));
    return Array.isArray(j?.modelos) && j.modelos.length ? { modelos: j.modelos, atualizado: Number(j.atualizado) || 0 } : null;
  } catch {
    return null;
  }
}

// Pasta do transcript de uma sessão nova: o claude troca tudo o que não é letra ou dígito por "-"
// (testado na 2.1.300). Caminho longo leva hash no nome: aí fica vazio e o controle procura depois.
function transcriptNovo(cwd, id) {
  const nome = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return nome.length <= 200 ? path.join(PROJETOS_DIR, nome, `${id}.jsonl`) : '';
}

// ───────────────────────── pedidos do claude (rodada 6, etapa 3) ─────────────────────────
// can_use_tool → controle.permissao tipado. As sugestões vêm de permission_suggestions (formato do
// PermissionUpdate do SDK: setMode {mode}, addRules/replaceRules {rules:[{toolName, ruleContent?}],
// behavior}, addDirectories {directories}, com destination). O `indice` é a posição na lista crua; o que
// não faz sentido oferecer (bypassPermissions, regras de negar, remoções) fica de fora.

const DESTINO = { session: 'nesta sessão', cliArg: 'nesta sessão', localSettings: 'neste projeto (só nesta máquina)', projectSettings: 'neste projeto', userSettings: 'em todos os projetos' };

export function rotuloSugestao(sg, tipo = 'ferramenta') {
  if (!sg || typeof sg !== 'object') return null;
  const onde = DESTINO[sg.destination] || 'nesta sessão';
  const verbo = tipo === 'plano' ? 'Aprovar' : 'Permitir';
  if (sg.type === 'setMode') {
    if (sg.mode === 'acceptEdits') return `${verbo} e aceitar edições ${onde}`;
    if (sg.mode === 'default') return `${verbo} e voltar ao modo padrão`;
    if (sg.mode === 'plan') return `${verbo} e passar ao modo planejar`;
    return null;
  }
  if ((sg.type === 'addRules' || sg.type === 'replaceRules') && sg.behavior === 'allow' && Array.isArray(sg.rules) && sg.rules.length) {
    const regras = sg.rules.map((r) => (r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r?.toolName || ''))).filter(Boolean);
    if (!regras.length) return null;
    // Só comandos de terminal: "Permitir sempre: git diff *" (a regra que vai para o arquivo).
    if (sg.rules.every((r) => TERMINAIS.has(r?.toolName) && r.ruleContent))
      return encurtar(`Permitir sempre: ${sg.rules.map((r) => r.ruleContent).join(', ')} ${onde}`, 200);
    return encurtar(`Permitir sempre ${regras.join(', ')} ${onde}`, 200);
  }
  if (sg.type === 'addDirectories' && Array.isArray(sg.directories) && sg.directories.length)
    return encurtar(`${verbo} e liberar ${sg.directories.join(', ')} ${onde}`, 200);
  return null;
}

// ── "Permitir sempre" de comando de terminal: uma regra reutilizável no lugar do comando exato ──
// O claude sugere a regra do comando inteiro (Bash(npm test -- x)). Para comando de execução (npm test,
// node script.mjs, cargo build…), o Orbit troca por um prefixo com " *" (Bash(npm test *), que também vale
// para o comando sem argumentos; testado na 2.1.300). Comando de leitura nunca é ampliado: o claude já roda
// sozinho a leitura simples, e só pede quando viu algo incomum (git diff --output=x), que é justamente o
// que a regra ampla liberaria (testado em 15/10). Comando que altera, apaga, instala, publica ou reinicia
// também fica exato, e com operador de shell (|, &&, ;, >, $()…) idem. A regra vai para o projeto, nunca
// para o usuário (userSettings vira localSettings).
const TERMINAIS = new Set(['Bash', 'PowerShell']);
// Comandos de leitura (Bash e PowerShell, sem diferença de maiúsculas): ficam exatos. Os cmdlets
// (Verbo-Substantivo) e o git ficam exatos pela regra deles.
const SO_LEITURA = new Set(('ls dir cat type head tail wc pwd which where whoami hostname grep egrep fgrep rg tree du df file stat diff cmp '
  + 'uniq date uname realpath dirname basename readlink nl od xxd md5sum sha1sum sha256sum cksum echo printf jq yq sort cut tr less more '
  + 'column fd gci gc gi gl gcm gps gsv gp sls rvpa measure').split(' '));
// Subcomando de leitura de uma ferramenta de execução (npm ls, cargo tree, pip list…): também fica exato.
const VERBOS_LEITURA = new Set('ls list view show info outdated tree search why explain version help status log diff audit doctor whoami env'.split(' '));
// Comandos que mudam o sistema: nunca ganham regra mais ampla.
const ARRISCADOS = new Set(('rm rmdir del erase rd mv move cp copy dd chmod chown chgrp ln kill killall pkill taskkill shutdown reboot sudo su '
  + 'format mkfs sed awk tee truncate shred find xargs curl wget ssh scp rsync reg sc schtasks net netsh icacls takeown attrib mklink '
  + 'powershell pwsh cmd bash sh zsh wsl env start explorer code mkdir md touch install '
  // apelidos do PowerShell para cmdlets que alteram (Remove-Item, New-Item, Stop-Process, Invoke-WebRequest…)
  + 'ri rni ren mi cpi ni ac clc spps saps iwr irm iex icm sv sp').split(' '));
// Interpretadores: a regra ampla vai até o script (node testes/x.mjs *) ou o módulo (python -m pytest *).
const INTERPRETES = new Set('node python python3 py deno tsx ts-node'.split(' '));
// Segundo termo que altera, instala, publica ou liga/desliga: fica exato (npm install x, cargo publish, docker run…).
const VERBOS_ARRISCADOS = new Set(('install i add remove rm uninstall un delete del publish push deploy release upgrade update up down reset clean '
  + 'prune kill stop start restart run exec apply destroy drop migrate fix login logout set config init create link unlink rebuild '
  + 'ci dedupe pack unpublish').split(' '));
const PALAVRA = /^[A-Za-z0-9_@][\w.@:+-]*$/;
const CAMINHO = /^[\w.@~+-][\w.@~+\/\\-]*$/;

// ruleContent → { regra, ampla, base, leitura? }: `regra` é o que vai para o arquivo, `base` o comando que ela
// libera, `leitura` marca o comando de leitura que ficou exato. O prefixo que o próprio claude sugere
// (git diff:*) passa como veio: o Orbit não o estreita.
export function ampliarComando(conteudo) {
  const bruto = String(conteudo || '').trim();
  if (!bruto) return { regra: bruto, ampla: false };
  // Prefixo antigo (git diff:*) → git diff *; regra que já tem curinga fica como veio.
  const antigo = /^(.*\S):\*$/.exec(bruto);
  if (antigo) return { regra: `${antigo[1]} *`, ampla: true, base: antigo[1] };
  if (/ \*$/.test(bruto) && !bruto.slice(0, -2).includes('*')) return { regra: bruto, ampla: true, base: bruto.slice(0, -2) };
  const exato = { regra: bruto, ampla: false };
  if (bruto.includes('*') || /[|&;<>`$(){}\n\r"']/.test(bruto)) return exato;
  const t = bruto.split(/\s+/);
  if (/=/.test(t[0])) return exato; // VAR=x comando
  const cmd = path.basename(t[0]).toLowerCase().replace(/\.exe$/, '');
  const prefixo = (n) => {
    const base = t.slice(0, n).join(' ');
    return { regra: `${base} *`, ampla: true, base };
  };
  const leitura = { ...exato, leitura: true };
  if (ARRISCADOS.has(cmd)) return exato;
  if (SO_LEITURA.has(cmd)) return leitura;
  // gh, docker e kubectl misturam leitura e ação remota no mesmo subcomando (gh pr view / gh pr merge): exatos.
  if (cmd === 'gh' || cmd === 'docker' || cmd === 'kubectl') return exato;
  if (cmd === 'git') return t[1] && /^(status|diff|log|show|blame|rev-parse|ls-files|ls-tree|describe|shortlog|grep|cat-file|show-ref|whatchanged)$/i.test(t[1]) ? leitura : exato;
  // Cmdlet do PowerShell (Verbo-Substantivo): os que leem já rodam sozinhos; os que alteram ficam exatos.
  if (/^[a-z]+-[a-z]/.test(cmd)) return /^(get|test|resolve|select|measure|compare)-/.test(cmd) ? leitura : exato;
  if (INTERPRETES.has(cmd)) {
    if (t[1] === '-m' && t[2] && PALAVRA.test(t[2])) return prefixo(3);
    return t[1] && !t[1].startsWith('-') && CAMINHO.test(t[1]) ? prefixo(2) : exato;
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && t[1] === 'run') {
    return t[2] && PALAVRA.test(t[2]) && !VERBOS_ARRISCADOS.has(t[2].toLowerCase()) && !/deploy|publish|release|start|stop|prod/i.test(t[2]) ? prefixo(3) : exato;
  }
  // Ferramenta com subcomando de execução (npm test, cargo build, go vet): até o subcomando, se ele não for
  // arriscado nem de leitura.
  const sub = t[1]?.toLowerCase();
  if (sub && VERBOS_LEITURA.has(sub)) return leitura;
  if (sub && PALAVRA.test(t[1]) && !t[1].startsWith('-') && !VERBOS_ARRISCADOS.has(sub)) return prefixo(2);
  return exato;
}

// git diff/log/show * (só aparece quando o próprio claude sugere o prefixo, git diff:*) também gravaria
// arquivo com --output: junto vai a negação (Bash(git diff *--output*)), no mesmo destino. Negar vence o
// allow (testado na 2.1.300). Não pega a forma com aspas (--"output"); essa só o claude pega sem a regra ampla.
const GRAVA_ARQUIVO = /^git (diff|log|show) \*$/;

// Sugestão crua addRules (allow) de Bash/PowerShell → a mesma sugestão com as regras amplas, no projeto,
// e o texto do que ela libera. Outras sugestões passam iguais (libera: null). As atualizações que vão
// junto (a negação do --output) ficam em _junto; atualizacoesDe() as solta na resposta.
export function ampliarSugestao(sg) {
  if (!sg || sg.type !== 'addRules' || sg.behavior !== 'allow' || !Array.isArray(sg.rules) || !sg.rules.length) return { sg, libera: null };
  if (!sg.rules.every((r) => TERMINAIS.has(r?.toolName) && typeof r.ruleContent === 'string' && r.ruleContent.trim())) return { sg, libera: null };
  const vistas = new Set();
  const rules = [];
  const partes = [];
  for (const r of sg.rules) {
    const a = ampliarComando(r.ruleContent);
    if (vistas.has(r.toolName + '\0' + a.regra)) continue;
    vistas.add(r.toolName + '\0' + a.regra);
    rules.push({ toolName: r.toolName, ruleContent: a.regra });
    const grava = a.ampla && GRAVA_ARQUIVO.test(a.regra);
    partes.push(a.ampla ? `${a.base} com qualquer argumento${grava ? ' (menos --output, que grava arquivo: fica bloqueado)' : ''}` : a.leitura ? `só ${a.regra} (comando de leitura: o Orbit não amplia; as variações simples o Claude Code já roda sozinho)` : `só ${a.regra} (variações seguem pedindo)`);
  }
  const destination = sg.destination === 'userSettings' ? 'localSettings' : sg.destination;
  const nova = { ...sg, rules, destination };
  const negar = rules.filter((r) => GRAVA_ARQUIVO.test(r.ruleContent)).map((r) => ({ toolName: r.toolName, ruleContent: r.ruleContent.replace(/ \*$/, ' *--output*') }));
  if (negar.length) nova._junto = [{ type: 'addRules', rules: negar, behavior: 'deny', destination }];
  return { sg: nova, libera: encurtar(`Libera ${partes.join('; ')}, ${DESTINO[destination] || 'nesta sessão'}.`, 300) };
}

// Sugestão escolhida → a lista do updatedPermissions (ela e o que vai junto).
export function atualizacoesDe(sg) {
  if (!sg || typeof sg !== 'object') return [];
  const { _junto, ...s } = sg;
  return [s, ...(Array.isArray(_junto) ? _junto : [])];
}

// Sugestões cruas → [{indice, rotulo, modo?, libera?}]. No plano sem "aceitar edições", o Orbit acrescenta a de
// sempre do Claude Code (setMode acceptEdits na sessão), no fim da lista crua. A regra de terminal já vem
// ampliada na lista crua (é ela que volta no updatedPermissions).
export function sugestoesDe(cruas, tipo) {
  const l = (Array.isArray(cruas) ? cruas.slice(0, 10) : []).map((s) => ampliarSugestao(s));
  if (tipo === 'plano' && !l.some(({ sg: s }) => s?.type === 'setMode' && s.mode === 'acceptEdits')) l.push({ sg: { type: 'setMode', mode: 'acceptEdits', destination: 'session' }, libera: null });
  const sugestoes = [];
  l.forEach(({ sg: s, libera }, indice) => {
    const rotulo = rotuloSugestao(s, tipo);
    if (!rotulo) return;
    const o = { indice, rotulo };
    if (s.type === 'setMode') o.modo = s.mode;
    if (libera) o.libera = libera;
    sugestoes.push(o);
  });
  return { cruas: l.map(({ sg: s }) => s), sugestoes };
}

// AskUserQuestion: questions [{question, header, multiSelect, options:[{label, description}]}].
export function perguntasDe(entrada) {
  const qs = Array.isArray(entrada?.questions) ? entrada.questions : [];
  return qs
    .filter((q) => q && typeof q.question === 'string')
    .map((q) => ({
      pergunta: q.question,
      cabecalho: typeof q.header === 'string' ? q.header : '',
      multipla: q.multiSelect === true,
      opcoes: (Array.isArray(q.options) ? q.options : []).map((o) => ({ rotulo: String(o?.label ?? ''), descricao: typeof o?.description === 'string' ? o.description : '' })),
    }));
}

// ───────────────────────── motor de instâncias (rodada 6) ─────────────────────────
// Cliente do pipe do motor.mjs: JSON por linha, 1ª linha {op:'auth', token} (token do motor.json),
// pedidos com `req` casados com a resposta, eventos {ev} entregues a aoEvento. Um cliente por vez:
// se outro conectar, o motor manda {ev:'substituido'} e fecha esta conexão.

function lerInfoMotor() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8'));
    return j && typeof j.pipe === 'string' && typeof j.token === 'string' && Number(j.pid) > 0 ? j : null;
  } catch {
    return null;
  }
}

// O /saude da porta deste servidor responde com o pid deste processo? (espera até ms)
async function portaEhNossa(ms = 30e3) {
  const porta = Number(process.env.GERENCIADOR_PORTA || 47821);
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const pid = await new Promise((r) => {
      const q = http.get({ host: '127.0.0.1', port: porta, path: '/saude', timeout: 2000 }, (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (t += d));
        res.on('end', () => {
          try {
            r(Number(JSON.parse(t).pid));
          } catch {
            r(0);
          }
        });
      });
      q.on('timeout', () => q.destroy());
      q.on('error', () => r(0));
    });
    if (pid === process.pid) return true;
    await dormir(150);
  }
  return false;
}

function clienteMotor({ log, aoEvento, aoCair }) {
  let sock = null;
  let garantindo = null;
  let fechando = false;
  let trocando = false; // trocando o motor de versão antiga: a queda da conexão é esperada
  let ultimoSpawn = 0;
  let n = 0;
  const pendentes = new Map(); // req → {ok, falha, tm}

  function receber(j) {
    const p = j.req != null ? pendentes.get(j.req) : null;
    if (p) {
      pendentes.delete(j.req);
      clearTimeout(p.tm);
      if (j.ok) p.ok(j);
      else p.falha(Object.assign(new Error(String(j.erro || 'erro no motor')), { codigo: j.codigo }));
    } else if (j.ev) aoEvento(j);
  }

  // Conecta e autentica; resolve {versao, pid} ou null.
  function abrir(info) {
    return new Promise((resolve) => {
      let ok = false;
      let substituido = false;
      let buf = '';
      const c = net.connect(info.pipe);
      const tm = setTimeout(() => (c.destroy(), resolve(null)), 3000);
      c.setEncoding('utf8');
      c.on('connect', () => c.write(JSON.stringify({ op: 'auth', token: info.token, req: 'auth' }) + '\n'));
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let j;
          try {
            j = JSON.parse(l);
          } catch {
            continue;
          }
          if (!ok) {
            if (j.req === 'auth' && j.ok) {
              ok = true;
              clearTimeout(tm);
              sock = c;
              resolve({ versao: j.versao, pid: j.pid });
            }
            continue;
          }
          if (j.ev === 'substituido') substituido = true;
          else receber(j);
        }
      });
      c.on('error', () => {});
      c.on('close', () => {
        clearTimeout(tm);
        if (!ok) return resolve(null);
        if (sock !== c) return;
        sock = null;
        for (const p of pendentes.values()) {
          clearTimeout(p.tm);
          p.falha(new Error('a conexão com o motor caiu'));
        }
        pendentes.clear();
        if (!fechando && !trocando) aoCair(substituido);
      });
    });
  }

  function lancarMotor() {
    ultimoSpawn = Date.now();
    try {
      // Destacado: fora do job do libuv do servidor (o servidor pode morrer sem levar o motor).
      const envMotor = { ...process.env, GERENCIADOR_DADOS: DADOS };
      if (process.platform !== 'win32') envMotor.PATH = pathAmpliado();
      const m = spawn(process.execPath, [ARQ_MOTOR], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(ARQ_MOTOR), env: envMotor });
      m.on('error', (e) => log('motor', `não subiu: ${e.message}`));
      m.unref();
    } catch (e) {
      log('motor', `não subiu: ${e.message}`);
    }
  }

  async function conectarExistente() {
    const info = lerInfoMotor();
    return info && vivo(Number(info.pid)) ? abrir(info) : null;
  }

  async function subirEConectar() {
    lancarMotor();
    const fim = Date.now() + MS_MOTOR;
    while (Date.now() < fim) {
      await dormir(100);
      const r = await conectarExistente();
      if (r) return r;
      if (Date.now() - ultimoSpawn > 2500) lancarMotor(); // o anterior pode ter saído (pipe ainda ocupado)
    }
    return null;
  }

  // Garante a conexão. subir=false: só conecta num motor que já está vivo (subida do servidor).
  function garantir(subir = true) {
    if (sock) return Promise.resolve(true);
    if (fechando) return Promise.resolve(false);
    return (garantindo ||= (async () => {
      let r = await conectarExistente();
      if (!r && !subir) return false;
      if (!r) r = await subirEConectar();
      if (!r) return false;
      if (r.versao !== VERSAO_MOTOR) {
        // Motor de outra versão: troca só se não segura nenhum processo.
        const lista = await pedir('listar').catch(() => null);
        if (lista && !lista.instancias.some((i) => i.vivo)) {
          log('motor', `trocando o motor v${r.versao} pelo v${VERSAO_MOTOR}`);
          trocando = true;
          try {
            await pedir('sair').catch(() => {});
            const fim = Date.now() + 3000;
            while (sock && Date.now() < fim) await dormir(50);
            while (vivo(Number(r.pid)) && Date.now() < fim) await dormir(50);
          } finally {
            trocando = false;
          }
          if (sock) return true;
          r = await subirEConectar();
          if (!r) return false;
        } else log('motor', `motor v${r.versao} (esperado v${VERSAO_MOTOR}) com processos vivos; segue com ele`);
      }
      return !!sock;
    })().finally(() => (garantindo = null)));
  }

  function pedir(op, dados = {}, t = 10e3) {
    return new Promise((ok, falha) => {
      if (!sock) return falha(new Error('sem conexão com o motor'));
      const req = String(++n);
      const tm = setTimeout(() => (pendentes.delete(req), falha(new Error('o motor não respondeu'))), t);
      pendentes.set(req, { ok, falha, tm });
      sock.write(JSON.stringify({ ...dados, op, req }) + '\n');
    });
  }

  return {
    garantir,
    pedir,
    enviar: (op, dados) => pedir(op, dados).catch((e) => log('motor', `${op}: ${e.message}`)),
    conectado: () => !!sock,
    fechar() {
      fechando = true;
      try {
        sock?.end();
      } catch {}
    },
  };
}

// ───────────────────────── o controle ─────────────────────────

export function criarControle(deps) {
  const { sessao: obterSessao, sessoes: todasSessoes, difundir, difundirSessao, lerJSONCorpo, log = () => {}, aplicarUso } = deps;
  // Adoção das instâncias do motor na subida (ver o setTimeout perto do fim): até ela acabar, as rotas POST
  // esperam (no máximo 10 s; o /saude desta porta pode levar até 30 s) e o estado não chama de "dormindo"
  // a instância que segue viva no motor.
  let adocaoPendente = true;
  let fimAdocao;
  const adocao = new Promise((r) => (fimAdocao = r));
  const esperarAdocao = () => Promise.race([adocao, dormir(10e3)]);
  // Etapa 2 (opcionais): ignorarSessao(id, ms) põe a sonda no filtro do registro do servidor (o mesmo da
  // sonda do uso); criarSessao({id, cwd, apelido, transcript}) põe a sessão nova na lista (origem 'orbit');
  // gravarNovaInstancia(o) grava config.novaInstancia.
  const { ignorarSessao, criarSessao, gravarNovaInstancia } = deps;
  const { lerConfig } = deps; // etapa 4 (opcional): config.instancias.dormirApos
  // Conexões MCP (17/10, opcional): mcpProtecao(cwd) → {bloquear, env} (mcp.mjs). Os servidores do .mcp.json ainda
  // não aprovados no Orbit vão no disabledMcpjsonServers do --settings (o headless os conectaria sem perguntar,
  // testado no 2.1.300) e as chaves do cofre vão no env. Se a proteção falhar, a instância sobe sem nenhum MCP
  // (--strict-mcp-config). Sem a dependência (testes do controle), tudo como antes.
  const { mcpProtecao } = deps;
  let modelos = lerModelosSalvos(); // {modelos, atualizado} | null
  let comandosConhecidos = null; // [{nome, descricao, args}] do último initialize (vale para quem está dormindo)
  let sondando = null;

  const procs = new Map(); // sessionId atual → processo do Orbit
  const acoes = new Map(); // sessionId → [Acao] (últimas 20)
  const fluxos = new Set(); // SSE de conversa
  let registros = []; // última leitura do registro
  const porPid = new Map(); // pid → {sessionId, procStart}
  const achados = new Map(); // sessionId → transcript encontrado na pasta de projetos
  const procuraEm = new Map(); // sessionId → quando procurar de novo
  const existe = new Map(); // caminho → {ok, ate}
  const assinaturas = new Map(); // sessionId → JSON do controle difundido
  const instancias = new Map(); // chave no motor (sessionId do lançamento) → processo do Orbit
  const motor = clienteMotor({ log, aoEvento: eventoDoMotor, aoCair: (s) => motorCaiu(s).catch((e) => log('motor', e.message)) });

  // ───────── etapa 4: registro das instâncias (<DADOS>/instancias.json) ─────────
  // { [sessao]: { cwd, transcript, modelo, esforco, modoPermissao, origem, apelido?, processo, dormiu?,
  //   interrompida?, ultimaAtividade, agendamentos, ocupada } }. A instância dormindo é só o registro (sem
  // processo em procs) e continua `orbit`; acorda com --resume na primeira ação.
  const regs = new Map();
  let regsTm = null;
  try {
    const j = JSON.parse(fs.readFileSync(ARQ_INSTANCIAS, 'utf8'));
    for (const [k, v] of Object.entries(j && typeof j === 'object' ? j : {})) if (v && typeof v === 'object' && typeof v.cwd === 'string') regs.set(k, v);
  } catch {}
  function gravarRegs() {
    clearTimeout(regsTm);
    regsTm = null;
    try {
      const tmp = `${ARQ_INSTANCIAS}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(regs), null, 1));
      fs.renameSync(tmp, ARQ_INSTANCIAS);
    } catch (e) {
      log('controle', `não gravei ${ARQ_INSTANCIAS}: ${e.message}`);
    }
  }
  // Gravação atômica a cada mudança, juntando as que vêm no mesmo instante (a atividade muda a cada linha).
  const salvarRegs = () => (regsTm ||= setTimeout(gravarRegs, 250));
  const iso = (t) => new Date(t || Date.now()).toISOString();

  // Processo vivo → registro (chamado a cada mudança do processo).
  function sincronizar(p) {
    if (p.devolvendo || p.semRegistro || p.saiu) return;
    const r = regs.get(p.id) || {};
    Object.assign(r, {
      cwd: p.cwd,
      transcript: p.transcript,
      modelo: p.ajustes.modelo || acharModelo(p.modelo)?.valor || p.modelo || '',
      esforco: p.ajustes.esforco || '',
      modoPermissao: p.ajustes.modoPermissao || 'default',
      origem: p.origem,
      processo: p.iniciando ? 'iniciando' : 'vivo',
      ultimaAtividade: iso(p.atividade),
      agendamentos: p.agendamentos,
      ocupada: !!p.ocupada,
    });
    // Skills: a allowlist escolhida na Nova instância (sem ela = todas). Volta no initialize do acordar.
    if (Array.isArray(p.skills)) r.skills = p.skills;
    else delete r.skills;
    const ap = obterSessao(p.id)?.apelido;
    if (ap) r.apelido = ap;
    delete r.dormiu;
    if (p.interrompida) r.interrompida = true;
    else delete r.interrompida;
    regs.set(p.id, r);
    salvarRegs();
  }
  // POST /remover (pelo servidor): apaga o registro; com processo vivo, fecha.
  function esquecer(id) {
    const p = procs.get(id);
    if (p) {
      p.semRegistro = true;
      fecharProcesso(p, MS_FECHAR_DORMIR).catch(() => {});
    }
    if (regs.delete(id)) {
      salvarRegs();
      difundirInstancias();
    }
  }
  // Para o servidor: a sessão é uma instância do Orbit (viva ou dormindo)? Aí o fim do processo não a encerra.
  const dormindo = (id) => regs.has(id) && !procs.get(id)?.devolvendo;

  // ── dormir ──
  function dormirMs() {
    const e = Number(process.env.ORBIT_DORMIR_MS);
    if (e > 0) return e;
    const m = Number(lerConfig?.()?.instancias?.dormirApos ?? 30);
    return Number.isFinite(m) && m > 0 ? m * 60e3 : 0;
  }
  // Modo de permissão das novas instâncias sem modo no pedido (config.instancias.modoPadrao, padrão auto).
  function modoPadrao() {
    const m = lerConfig?.()?.instancias?.modoPadrao;
    return PERMISSOES.includes(m) ? m : 'auto';
  }
  const acaoEmAndamento = (id) => (acoes.get(id) || []).some((a) => a.estado === 'em_andamento');
  // A regra do ocioso, sem o tempo (também a do limite). Na dúvida, não dorme.
  function elegivel(p) {
    if (p.saiu || p.iniciando || p.motivoDormir || p.devolvendo || p.ocupada || p.permissoes.length || p.tarefas.length || p.agendamentos > 0) return false;
    if (acaoEmAndamento(p.id) || acordando.has(p.id)) return false;
    return !!p.transcript && fs.existsSync(p.transcript); // sem transcript, o --resume não teria o que retomar
  }
  // Dormir: fechar (stdin.end); sem sair em 5 s, matar. O aoFim grava processo:'dormindo' com o motivo.
  async function adormecer(p, motivo) {
    if (p.saiu) return;
    p.motivoDormir = motivo;
    log('controle', `a instância ${p.id} vai dormir (${motivo})`);
    await fecharProcesso(p, MS_FECHAR_DORMIR);
  }
  function tiqueDormir() {
    const t = dormirMs();
    if (!t) return;
    const agora = Date.now();
    for (const p of procs.values()) if (agora - p.atividade >= t && elegivel(p)) adormecer(p, 'ocioso').catch((e) => log('controle', `dormir: ${e.message}`));
  }

  // ── limite (só os vivos) ──
  const ocupadas = () => [...procs.values()].map((p) => obterSessao(p.id)?.apelido || obterSessao(p.id)?.titulo || p.id.slice(0, 8));
  function erroLimite() {
    return erroHttp(409, `O Orbit já tem ${MAX_PROCESSOS} instâncias vivas, todas ocupadas (${encurtar(ocupadas().join(', '), 300)}). Espere uma terminar ou encerre uma.`, 'limite');
  }
  // Antes do 202: no limite, precisa haver uma elegível para dormir.
  function checarVaga() {
    if (procs.size >= MAX_PROCESSOS && ![...procs.values()].some(elegivel)) throw erroLimite();
  }
  // No limite: faz dormir a elegível com a atividade mais antiga (motivo 'limite').
  async function liberarVaga() {
    if (procs.size < MAX_PROCESSOS) return;
    const alvo = [...procs.values()].filter(elegivel).sort((a, b) => a.atividade - b.atividade)[0];
    if (!alvo) throw erroLimite();
    await adormecer(alvo, 'limite');
    if (procs.size >= MAX_PROCESSOS) throw erroLimite();
  }

  // ── acordar (--resume com o modelo, o esforço e o modo do registro) ──
  const acordando = new Map(); // sessao → promessa do processo (duas ações seguidas acordam uma vez só)
  function acordar(id) {
    const vivo = procs.get(id);
    if (vivo && !vivo.acordando) return Promise.resolve(vivo);
    let pr = acordando.get(id);
    if (pr) return pr;
    pr = (async () => {
      const r = regs.get(id);
      if (!r) throw erroHttp(409, 'A sessão não está no Orbit.', 'nao_assumida');
      await liberarVaga();
      const { cmd, pre } = binarioClaude();
      const args = [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--resume', id];
      if (r.modelo && r.modelo !== 'default') args.push('--model', r.modelo);
      if (r.esforco) args.push('--effort', r.esforco);
      args.push('--permission-mode', PERMISSOES.includes(r.modoPermissao) ? r.modoPermissao : 'default', ...argsExtras(), ...argsOrientacao(argsExtras()));
      const p = novoProcesso({ id, cwd: r.cwd, transcript: r.transcript, modelo: acharModelo(r.modelo)?.modelo || r.modelo });
      p.origem = r.origem === 'orbit' ? 'orbit' : 'assumir';
      p.ajustes = { modelo: r.modelo || '', esforco: r.esforco || '', modoPermissao: r.modoPermissao || 'default' };
      p.skills = listaSkills(r.skills);
      p.acordando = true;
      p.interrompida = !!r.interrompida;
      p.dormiuAntes = r.dormiu;
      p.titulado = true; // o título já foi pedido na 1ª vida
      log('controle', `acordando a instância ${id} (--resume)`);
      await subirProcesso(p, cmd, args); // initialize; depois o get_settings grava o modelo e o esforço efetivos
      p.acordando = false;
      sincronizar(p);
      avisar(id);
      return p;
    })().finally(() => acordando.delete(id));
    acordando.set(id, pr);
    return pr;
  }
  // Ação com a instância dormindo: "Retomando a instância…" até o initialize, depois a ação segue normal.
  function acordarE(id, a, fazer) {
    etapa(a, 'Retomando a instância…');
    acordar(id)
      .then((p) => fazer(p))
      .catch((e) => falhar(a, e.codigo === 'limite' ? e.message : `O Orbit não conseguiu retomar a instância (${e.message}).`));
  }

  // ── memória: um tasklist /fo csv /nh a cada 30 s, mapeado pelo pid ──
  // Mac/Linux: `ps -A -o pid=,rss=` (rss em KB), lido por memoriaPosix.
  function lerMemoria() {
    if (!procs.size) return;
    const win = process.platform === 'win32';
    const [cmd, args] = win ? ['tasklist', ['/fo', 'csv', '/nh']] : [process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-A', '-o', 'pid=,rss=']];
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return log('controle', `${win ? 'tasklist' : 'ps'}: ${err.message}`);
      let mem = new Map();
      if (!win) mem = memoriaPosix(out);
      else for (const l of String(out).split(/\r?\n/)) {
        const c = [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        if (c.length >= 5) mem.set(Number(c[1]), Number(c[c.length - 1].replace(/\D/g, '')) * 1024);
      }
      for (const p of procs.values()) {
        const v = mem.get(p.pid);
        if (!v) continue;
        const antes = p.memoria || 0;
        p.memoria = v;
        if (Math.abs(v - antes) > MEMORIA_DIFERENCA) avisar(p.id);
      }
      difundirInstancias();
    });
  }

  // ── GET /instancias e SSE `instancias` ──
  function resumoInstancias() {
    let memoria = 0;
    for (const p of procs.values()) memoria += p.memoria || 0;
    const dormindoN = [...regs.keys()].filter((k) => !procs.has(k)).length;
    return { max: MAX_PROCESSOS, vivas: procs.size, dormindo: dormindoN, memoria, dormirApos: Number(lerConfig?.()?.instancias?.dormirApos ?? 30) };
  }
  let ultimoResumo = '';
  function difundirInstancias() {
    const r = resumoInstancias();
    const j = JSON.stringify(r);
    if (j === ultimoResumo) return;
    ultimoResumo = j;
    difundir('instancias', r);
  }

  // ── subida: reinício do PC (ou do motor) ──
  // Registros vivo/iniciando que o motor não tem → dormindo/reinicio (+ interrompida se estavam ocupados).
  // Registro sem transcript é descartado. Nenhuma instância é relançada sozinha.
  function depoisDaAdocao() {
    let mudou = false;
    for (const [id, r] of [...regs]) {
      if (procs.has(id)) continue;
      if (!r.transcript || !fs.existsSync(r.transcript)) {
        log('controle', `registro da instância ${id} descartado: o transcript não existe`);
        regs.delete(id);
        mudou = true;
        continue;
      }
      if (r.processo === 'vivo' || r.processo === 'iniciando') {
        r.processo = 'dormindo';
        r.dormiu = { motivo: 'reinicio', em: iso() };
        if (r.ocupada) r.interrompida = true;
        r.ocupada = false;
        r.agendamentos = 0; // tarefas e agendamentos de antes se perdem
        mudou = true;
      }
      achados.set(id, r.transcript);
    }
    if (mudou) salvarRegs();
    for (const id of regs.keys()) avisar(id);
    difundirInstancias();
  }

  const avisar = (id) => {
    const s = obterSessao(id);
    if (s) difundirSessao(s);
  };

  // ── Acao ──
  function novaAcao(sessao, tipo, via) {
    const a = { id: crypto.randomUUID(), sessao, tipo, estado: 'em_andamento', via, inicio: Date.now() };
    const p = procs.get(sessao);
    if (p) p.atividade = Date.now(); // etapa 4: ação conta como atividade
    const l = acoes.get(sessao) || [];
    l.push(a);
    if (l.length > MAX_ACOES) l.splice(0, l.length - MAX_ACOES);
    acoes.set(sessao, l);
    difundir('acao', a);
    return a;
  }
  function etapa(a, t) {
    if (a.estado !== 'em_andamento') return;
    a.etapa = t;
    difundir('acao', a);
  }
  function concluir(a, resultado) {
    if (a.estado !== 'em_andamento') return;
    a.estado = 'sucesso';
    a.fim = Date.now();
    delete a.etapa;
    if (resultado) a.resultado = resultado;
    difundir('acao', a);
  }
  function falhar(a, erro) {
    if (a.estado !== 'em_andamento') return;
    a.estado = 'erro';
    a.fim = Date.now();
    a.erro = String(erro);
    difundir('acao', a);
  }

  // ── transcript da sessão ──
  function existeCache(c) {
    const x = existe.get(c);
    if (x && x.ate > Date.now()) return x.ok;
    const ok = fs.existsSync(c);
    existe.set(c, { ok, ate: Date.now() + 10e3 });
    return ok;
  }
  function transcriptConhecido(id, s = obterSessao(id)) {
    const p = procs.get(id);
    if (p?.transcript) return p.transcript;
    if (s?._transcript && existeCache(s._transcript)) return s._transcript;
    return achados.get(id) || '';
  }
  async function procurarTranscript(id) {
    if (!/^[\w-]{1,100}$/.test(id)) return '';
    let dirs = [];
    try {
      dirs = await fsp.readdir(PROJETOS_DIR);
    } catch {
      return '';
    }
    for (const d of dirs) {
      const c = path.join(PROJETOS_DIR, d, `${id}.jsonl`);
      try {
        await fsp.access(c);
        achados.set(id, c);
        // Sessão sem transcript pelo hook (só o registro, ou instância do Orbit sem hooks): o servidor
        // passa a ler dela título, contexto, modelo e esforço (etapa 2: Sessao.modelo para todas).
        const s = obterSessao(id);
        if (s && (!s._transcript || !existeCache(s._transcript))) {
          s._transcript = c;
          s._mtime = 0;
        }
        return c;
      } catch {}
    }
    return '';
  }
  async function acharTranscript(id) {
    return transcriptConhecido(id) || (await procurarTranscript(id));
  }

  // ── registro ──
  const regsDe = (id) => registros.filter((r) => r.sessionId === id && r.vivo && !ehDoOrbit(r.pid));
  const ehDoOrbit = (pid) => [...procs.values()].some((p) => p.pid === pid);
  function regVivo(id) {
    const l = regsDe(id);
    return l.find((r) => r.socket && r.temChave) || l[0] || null;
  }

  async function lerRegistro() {
    registros = await lerRegistros();
    // Mesmo processo com outra sessionId: /clear (no VS Code ou no terminal) → o fluxo segue o id novo.
    for (const r of registros) {
      if (!r.vivo) continue;
      const antes = porPid.get(r.pid);
      if (antes && antes.procStart === r.procStart && antes.sessionId !== r.sessionId) reiniciarFluxos(antes.sessionId, r.sessionId, 'limpeza');
      porPid.set(r.pid, { sessionId: r.sessionId, procStart: r.procStart });
    }
    for (const pid of porPid.keys()) if (!registros.some((r) => r.pid === pid && r.vivo)) porPid.delete(pid);
    // Etapa 4: instância dormindo aberta em outro lugar (VS Code, terminal) → o Orbit larga o registro:
    // nunca dois processos na mesma sessão. Ela volta a ser uma sessão monitorada comum, com Assumir.
    for (const id of [...regs.keys()]) {
      if (procs.has(id) || acordando.has(id)) continue;
      const outro = registros.find((r) => r.sessionId === id && r.vivo && !ehDoOrbit(r.pid));
      if (!outro) continue;
      log('controle', `a instância ${id} (dormindo) foi aberta pelo pid ${outro.pid}; o Orbit larga o controle`);
      regs.delete(id);
      salvarRegs();
      avisar(id);
      difundirInstancias();
    }
    // Transcript das sessões que não vieram pelos hooks (só do registro).
    const agora = Date.now();
    for (const s of todasSessoes()) {
      if (transcriptConhecido(s.id, s) || (procuraEm.get(s.id) || 0) > agora) continue;
      procuraEm.set(s.id, agora + 60e3);
      await procurarTranscript(s.id);
    }
    difundirMudancas();
  }

  // Só o que vem do registro/processos (o resto já é difundido pelo servidor quando a sessão muda).
  function difundirMudancas() {
    const cheio = procs.size >= MAX_PROCESSOS;
    for (const s of todasSessoes()) {
      const r = regVivo(s.id);
      const j = JSON.stringify([r?.pid, r?.status, !!(r?.socket && r?.temChave), !!transcriptConhecido(s.id, s), cheio]);
      if (assinaturas.get(s.id) === j) continue;
      const tinha = assinaturas.has(s.id);
      assinaturas.set(s.id, j);
      if (tinha && !procs.has(s.id)) difundirSessao(s);
    }
  }

  // ── Sessao.controle ──
  function estado(s) {
    const id = s.id;
    const p = procs.get(id);
    if (p) {
      // Etapa 4: acordando, o motivo é "Retomando" (o front bloqueia o envio só com "Iniciando", o da criação).
      const motivo = p.acordando ? 'Retomando no Orbit' : p.iniciando ? 'Iniciando no Orbit' : 'Já está no Orbit';
      const o = { modo: 'orbit', podeAssumir: false, motivo, pid: p.pid || undefined, desde: p.desde, ocupada: !!p.ocupada || (!!p.iniciando && !p.acordando) };
      o.processo = p.iniciando ? 'iniciando' : 'vivo';
      if (p.memoria) o.memoria = p.memoria;
      o.ultimaAtividade = iso(p.atividade);
      if (p.interrompida) o.interrompida = true;
      // Etapa 2: o modelo (o `valor` escolhido), o esforço efetivo e o modo de permissão.
      if (p.ajustes.modelo) o.modelo = p.ajustes.modelo;
      if (p.ajustes.esforco) o.esforco = p.ajustes.esforco;
      if (p.ajustes.modoPermissao) o.modoPermissao = p.ajustes.modoPermissao;
      if (Array.isArray(p.skills)) o.skills = p.skills;
      if (p.permissoes.length) {
        // Etapa 3: o primeiro da fila, tipado; pendentes = o tamanho da fila.
        const q = p.permissoes[0];
        o.permissao = { id: q.id, ferramenta: q.ferramenta, resumo: q.resumo, entrada: q.entradaPublica, tipo: q.tipo };
        if (q.sugestoes.length) o.permissao.sugestoes = q.sugestoes;
        if (q.perguntas) o.permissao.perguntas = q.perguntas;
        if (q.plano != null) o.permissao.plano = q.plano;
        o.pendentes = p.permissoes.length;
      }
      if (p.tarefas.length) o.tarefas = p.tarefas;
      o.autoCompactar = infoAuto(id, p); // 20/10
      return o;
    }
    // Etapa 4: dormindo (só o registro): continua orbit; a primeira ação acorda.
    const rg = regs.get(id);
    // Logo depois da subida, antes da adoção: a que estava viva no motor ainda não voltou para o procs.
    // Não é "dormindo" (a ação espera a adoção, não acorda outro processo).
    if (rg && adocaoPendente && (rg.processo === 'vivo' || rg.processo === 'iniciando')) {
      return { modo: 'orbit', podeAssumir: false, motivo: 'Retomando o controle da instância', ocupada: !!rg.ocupada, processo: rg.processo, ultimaAtividade: rg.ultimaAtividade };
    }
    if (rg) {
      const o = { modo: 'orbit', podeAssumir: false, motivo: 'Dormindo no Orbit', ocupada: false, processo: 'dormindo', ultimaAtividade: rg.ultimaAtividade };
      if (rg.dormiu) o.dormiu = rg.dormiu;
      if (rg.interrompida) o.interrompida = true;
      if (rg.modelo) o.modelo = rg.modelo;
      if (rg.esforco) o.esforco = rg.esforco;
      if (rg.modoPermissao) o.modoPermissao = rg.modoPermissao;
      if (Array.isArray(rg.skills)) o.skills = rg.skills;
      o.autoCompactar = infoAuto(id, null); // 20/10
      return o;
    }
    const r = regVivo(id);
    const o = { modo: r && r.socket && r.temChave ? 'canal' : 'nenhum', podeAssumir: true };
    if (r) {
      o.pid = r.pid;
      if (r.startedAt) o.desde = r.startedAt;
    }
    const motivo = motivoParaNaoAssumir(s, r);
    if (motivo) {
      o.podeAssumir = false;
      o.motivo = motivo.erro;
    }
    return o;
  }

  function motivoParaNaoAssumir(s, r = regVivo(s.id)) {
    if (procs.has(s.id)) return { codigo: 'ja_assumida', erro: 'A sessão já está no Orbit' };
    if (!transcriptConhecido(s.id, s)) return { codigo: 'sem_transcript', erro: 'Sem o transcript da sessão, não dá para retomar' };
    if (r ? r.status === 'busy' : s.vivo && (s.status === 'trabalhando' || s.status === 'aguardando'))
      return { codigo: 'trabalhando', erro: 'A sessão está trabalhando; espere ela parar para assumir' };
    if (r && s.status === 'aguardando') return { codigo: 'trabalhando', erro: 'A sessão está esperando uma resposta; espere ela parar para assumir' };
    if (regs.has(s.id)) return { codigo: 'ja_assumida', erro: 'A sessão já está no Orbit (dormindo)' };
    if (procs.size >= MAX_PROCESSOS && ![...procs.values()].some(elegivel)) return { codigo: 'limite', erro: `O Orbit já tem ${MAX_PROCESSOS} instâncias vivas e ocupadas; espere uma terminar ou encerre uma` };
    return null;
  }

  // ── processo antigo (no VS Code/terminal) ──
  // Isolado de propósito: o Mestre pode trocar esta etapa. Só encerra se o pid e o início do
  // processo baterem com o registro e o status for idle.
  async function encerrarProcessoAntigo(sessao) {
    registros = await lerRegistros();
    const l = regsDe(sessao.id);
    if (!l.length) return { encerrado: false };
    for (const r of l) {
      if (r.status !== 'idle') throw new Error('A sessão está trabalhando; nada foi encerrado. Espere ela parar e tente de novo.');
      const inicio = await inicioDoProcesso(r.pid);
      if (!r.procStart || !inicio || !mesmoInicio(r.procStart, inicio))
        throw new Error(`O processo ${r.pid} não confere com o registro da sessão (pid reaproveitado?); nada foi encerrado.`);
    }
    for (const r of l) {
      await matarArvore(r.pid);
      if (!(await esperarSair(r.pid, 10e3))) throw new Error(`Não consegui encerrar o processo ${r.pid} da sessão. Feche a sessão no VS Code e tente de novo.`);
      // O processo morto não apaga o próprio registro; apaga para o monitoramento não confundir pids.
      await fsp.rm(path.join(SESSOES_DIR, `${r.pid}.json`), { force: true }).catch(() => {});
      for (const n of await fsp.readdir(SESSOES_DIR).catch(() => []))
        if (n.startsWith(`${r.pid}.`) && n.endsWith('.key')) await fsp.rm(path.join(SESSOES_DIR, n), { force: true }).catch(() => {});
    }
    registros = await lerRegistros();
    return { encerrado: true, pids: l.map((r) => r.pid) };
  }

  // ── processo do Orbit ──
  function escrever(p, obj) {
    if (p.saiu || !p.io?.gravavel()) throw new Error('o processo do Orbit não está aceitando entrada');
    p.io.escrever(JSON.stringify(obj));
  }

  function pedirControle(p, request, t) {
    const request_id = 'orbit-' + crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const tm = setTimeout(() => {
        p.controles.delete(request_id);
        reject(new Error('o processo não respondeu a tempo'));
      }, t);
      p.controles.set(request_id, {
        ok: (r) => (clearTimeout(tm), resolve(r)),
        falha: (e) => (clearTimeout(tm), reject(e)),
      });
      try {
        escrever(p, { type: 'control_request', request_id, request });
      } catch (e) {
        p.controles.delete(request_id);
        clearTimeout(tm);
        reject(e);
      }
    });
  }

  // Espera uma mensagem do stdout que resolva a ação; também falha se o processo sair ou der timeout.
  function acompanhar(p, a, t, aoMsg, msgTimeout) {
    return new Promise((resolve) => {
      const fim = (ok) => {
        clearTimeout(tm);
        p.ouvintes.delete(ouvinte);
        p.aoSair.delete(saiu);
        resolve(ok);
      };
      const tm = setTimeout(() => {
        falhar(a, msgTimeout);
        fim(false);
      }, t);
      const ouvinte = (j) => {
        const r = aoMsg(j);
        if (r === true) fim(true);
        else if (r === false) fim(false);
      };
      const saiu = (det) => {
        falhar(a, `O processo do Orbit terminou antes de concluir${det ? ` (${det})` : ''}.`);
        fim(false);
      };
      p.ouvintes.add(ouvinte);
      p.aoSair.add(saiu);
    });
  }

  // Celular: origem da sessão para o remoto (ver `origem`, no retorno). Declarada aqui (içada) porque o
  // reiniciarFluxos também consulta.
  function origemDe(id) {
    const p = procs.get(id);
    if (p) return p.devolvendo ? null : p.origem || null;
    return regs.get(id)?.origem || null;
  }

  function reiniciarFluxos(de, para, motivo) {
    for (const f of fluxos) {
      if (f.id !== de) continue;
      // Celular (revisão P1-1): o fluxo remoto só acompanha a troca de id se o id novo for nativo; senão
      // (ex.: /clear do VS Code numa sessão que já foi nativa) avisa e fecha, sem mudar de sessão.
      if (f.res?._remoto && origemDe(para) !== 'orbit') {
        enviarSSE(f, 'reinicio', { motivo });
        try { f.res.end(); } catch {}
        fluxos.delete(f);
        continue;
      }
      enviarSSE(f, 'reinicio', { motivo, novaSessao: para });
      f.id = para;
      f.cauda = null; // o próximo tique acha o transcript novo e lê desde o começo
      f.desdeZero = true;
    }
  }

  function trocarId(p, novo) {
    const velho = p.id;
    if (!novo || novo === velho) return;
    p.id = novo;
    p.transcript = path.join(path.dirname(p.transcript), `${novo}.jsonl`);
    procs.delete(velho);
    procs.set(novo, p);
    achados.set(novo, p.transcript);
    // Etapa 4: o registro acompanha a sessionId nova; os agendamentos zeram no /clear.
    const rg = regs.get(velho);
    if (rg) {
      regs.delete(velho);
      regs.set(novo, rg);
    }
    p.agendamentos = 0;
    atualizarMeta(p);
    reiniciarFluxos(velho, novo, 'limpeza');
    avisar(velho);
    avisar(novo);
  }

  function aoMensagem(p, j) {
    let mudou = false;
    // Etapa 3 (antes da cadeia abaixo, que segue igual): texto ao vivo, modo de permissão e tarefas.
    if (j.type === 'stream_event' || j.type === 'assistant') aoTextoAoVivo(p, j);
    if (j.type === 'system' && (j.subtype === 'init' || j.subtype === 'status') && typeof j.permissionMode === 'string' && j.permissionMode && j.permissionMode !== p.ajustes.modoPermissao) {
      p.ajustes.modoPermissao = j.permissionMode; // a aprovação do plano ou a sugestão "aceitar edições" troca o modo
      atualizarMeta(p);
      mudou = true;
    }
    if (j.type === 'system' && j.subtype === 'background_tasks_changed') {
      // ambient: tarefas que não são atividade (vigias etc.); o claude pede para não mostrá-las.
      const t = (Array.isArray(j.tasks) ? j.tasks : [])
        .filter((x) => x && typeof x === 'object' && !x.ambient)
        .slice(0, 20)
        .map((x) => ({ id: String(x.task_id ?? ''), tipo: String(x.task_type ?? ''), descricao: encurtar(String(x.description ?? '').replace(/\s+/g, ' ').trim(), 200) }));
      if (JSON.stringify(t) !== JSON.stringify(p.tarefas)) {
        p.tarefas = t;
        atualizarMeta(p);
        mudou = true;
      }
    }
    // Etapa 4: agendamentos (CronCreate/ScheduleWakeup/RemoteTrigger, menos CronDelete) seguram a instância
    // acordada. Conta também os de subagentes: na dúvida, não dorme.
    if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b?.type !== 'tool_use') continue;
        if (AGENDA.has(b.name)) p.agendamentos++;
        else if (b.name === 'CronDelete' && p.agendamentos > 0) p.agendamentos--;
      }
    }
    if (j.type === 'result') {
      soltarParciais(p); // volta interrompida: o último texto ao vivo vai antes de esquecer os blocos abertos
      p.parciais.clear();
      contextoDoResult(p, j);
      marcarAutoCompactar(p);
    }
    if (j.type === 'control_response') {
      const r = j.response || {};
      const c = p.controles.get(r.request_id);
      if (c) {
        p.controles.delete(r.request_id);
        if (r.subtype === 'error') c.falha(new Error(String(r.error || 'erro no processo')));
        else c.ok(r.response || {});
      } else if (p.adotada && r.request_id) {
        // Pedido feito pelo servidor anterior: quem esperava a resposta morreu com ele.
        log('controle', `resposta de ${r.request_id} ignorada: o servidor reiniciou`);
        if (p.iniciando && r.subtype === 'success') {
          p.iniciando = false; // o initialize de antes do reinício respondeu
          mudou = true;
        }
      }
    } else if (j.type === 'control_request') {
      const q = j.request || {};
      if (q.subtype === 'can_use_tool') {
        const primeira = !p.permissoes.length;
        const perm = permissaoDe(j);
        p.permissoes.push(perm);
        mudou = true;
        // Celular: o headless (-p) não dispara PermissionRequest/Notification, então a pergunta pendente só aparece aqui.
        // Um aviso por transição (só o 1º pedido da fila); o servidor ignora se a sessão já estava `aguardando`.
        if (primeira) try { deps.aoPrecisar?.(p.id, { tipo: perm.tipo, resumo: perm.resumo }); } catch (e) { log('controle', `aoPrecisar: ${e.message}`); }
      } else {
        try {
          escrever(p, { type: 'control_response', response: { subtype: 'error', request_id: j.request_id, error: `pedido não suportado pelo Orbit: ${q.subtype}` } });
        } catch {}
      }
    } else if (j.type === 'control_cancel_request') {
      const n = p.permissoes.length;
      p.permissoes = p.permissoes.filter((x) => x.id !== String(j.request_id));
      mudou = n !== p.permissoes.length;
    } else if (j.type === 'conversation_reset') {
      p.resetando = true;
    } else if (j.type === 'rate_limit_event') {
      usoDoStream(j);
    } else if ((j.type === 'system' && j.subtype === 'init') || j.type === 'result') {
      if (p.resetando && j.session_id && j.session_id !== p.id) {
        p.resetando = false;
        trocarId(p, j.session_id);
      }
      if (j.type === 'system' && j.model && j.model !== p.modelo) {
        p.modelo = j.model;
        atualizarMeta(p);
      }
      if (j.type === 'result' && p.ocupada) {
        p.ocupada = false;
        mudou = true;
      }
      // Etapa 2: o headless não gera título; depois da 1ª volta da instância criada pelo Orbit, pede.
      if (j.type === 'result' && p.pedidoTitulo && !p.titulado) {
        p.titulado = true;
        atualizarMeta(p);
        titular(p).catch((e) => log('controle', `título: ${e.message}`));
      }
    } else if ((j.type === 'assistant' || j.type === 'stream_event' || (j.type === 'user' && !j.isSynthetic)) && !p.ocupada) {
      // Volta iniciada por fora (ex.: mensagem pelo canal). O eco do user (20/10) também: a mensagem que estava na
      // fila começa a volta seguinte logo depois do result, antes do 1º stream_event.
      p.ocupada = true;
      mudou = true;
    }
    for (const f of [...p.ouvintes]) {
      try {
        f(j);
      } catch (e) {
        log('controle', e.message);
      }
    }
    // Etapa 4: a `interrompida` some na próxima volta; toda linha conta como atividade.
    if (p.ocupada && p.interrompida) {
      p.interrompida = false;
      mudou = true;
    }
    p.atividade = Date.now();
    sincronizar(p);
    if (mudou) avisar(p.id);
  }

  // Uso do plano vindo do stream (rate_limit_event, depois da 1ª chamada à API): vai pelo mesmo caminho
  // do POST /uso (aplicarUso no servidor: normaliza, guarda, SSE `uso`, vale a leitura mais nova).
  // Janela ausente ou sem utilization não vai.
  function usoDoStream(j) {
    const w = j.rate_limit_info?.unifiedWindows;
    if (!aplicarUso || !w || typeof w !== 'object') return;
    const rate_limits = {};
    for (const k of ['five_hour', 'seven_day']) {
      const u = Number(w[k]?.utilization);
      if (w[k]?.utilization == null || !Number.isFinite(u)) continue;
      rate_limits[k] = { used_percentage: u * 100, resets_at: w[k].resetsAt };
    }
    if (!Object.keys(rate_limits).length) return;
    try {
      aplicarUso({ ts: Date.now(), session_id: j.session_id, rate_limits }, Date.now());
    } catch (e) {
      log('controle', `uso do plano: ${e.message}`);
    }
  }

  // ── texto ao vivo (etapa 3) ──
  // Com --include-partial-messages (testado na 2.1.300): stream_event message_start {message.id} →
  // content_block_start {index, content_block.type:'text'} → content_block_delta text_delta… → a mensagem
  // `assistant` desse bloco (um bloco por mensagem, com o mesmo uuid da entrada do transcript) → content_block_stop.
  // O uuid só existe no fim do bloco; durante a escrita o parcial usa o id provisório "<message.id>:<index>".
  // Quando a `assistant` chega, o controle guarda uuid → id provisório, e o SSE da conversa entrega o item
  // final com o id do parcial (o front troca um pelo outro). Subagentes (parent_tool_use_id) ficam de fora,
  // como no transcript (isSidechain).
  function aoTextoAoVivo(p, j) {
    if (j.parent_tool_use_id) return;
    if (j.type === 'assistant') {
      const m = j.message || {};
      if (typeof m.model === 'string' && m.model !== '<synthetic>' && m.usage && typeof m.usage === 'object') p.ultUso = { usage: m.usage, modelo: m.model };
      const blocos = Array.isArray(m.content) ? m.content : [];
      if (!p.parciais.size || !blocos.length) return;
      const abertos = [...p.parciais.entries()].filter(([, x]) => !m.id || x.msg === m.id);
      const uid = String(j.uuid || '');
      // O id do item final, como o normalizar() monta: uuid da entrada, com ":i" quando há vários blocos.
      blocos.forEach((b, i) => {
        if (b?.type !== 'text') return;
        const ab = abertos.shift();
        if (!ab) return;
        const [chave, x] = ab;
        p.parciais.delete(chave);
        p.parcPend.delete(x);
        if (uid) mapearParcial(p, blocos.length > 1 ? `${uid}:${i}` : uid, x.id);
      });
      return;
    }
    const ev = j.event || {};
    if (ev.type === 'message_start') {
      soltarParciais(p);
      p.parciais.clear();
      p.parcMsg = String(ev.message?.id || `m${Date.now()}`);
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
      const x = { id: `${p.parcMsg || 'm'}:${ev.index}`, msg: p.parcMsg, texto: String(ev.content_block.text || '') };
      p.parciais.set(ev.index, x);
      if (x.texto) agendarParcial(p, x);
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const x = p.parciais.get(ev.index);
      if (!x) return;
      x.texto += String(ev.delta.text || '');
      agendarParcial(p, x);
    }
  }
  function mapearParcial(p, final, provisorio) {
    p.idsParciais.set(final, provisorio);
    if (p.idsParciais.size > MAX_MAPA_PARCIAIS) p.idsParciais.delete(p.idsParciais.keys().next().value);
  }
  // No máximo um envio a cada MS_PARCIAL por sessão (o primeiro sai na hora); `texto` é o acumulado.
  function agendarParcial(p, x) {
    p.parcPend.add(x);
    if (p.parcTimer || p.saiu) return;
    p.parcTimer = setTimeout(() => soltarParciais(p), Math.max(0, p.parcUlt + MS_PARCIAL - Date.now()));
  }
  function soltarParciais(p) {
    clearTimeout(p.parcTimer);
    p.parcTimer = null;
    if (!p.parcPend.size) return;
    p.parcUlt = Date.now();
    for (const x of p.parcPend) for (const f of fluxos) if (f.id === p.id) enviarSSE(f, 'parcial', { id: x.id, texto: x.texto });
    p.parcPend.clear();
  }
  // Itens do transcript a caminho do SSE da conversa: o `assistente` final ganha o id do seu parcial. Reserva:
  // se a entrada chegou ao transcript antes da mensagem do stdout, casa pelo texto com um bloco aberto.
  function idsDosParciais(id, itens) {
    const p = procs.get(id);
    if (!p) return;
    for (const it of itens) {
      if (it.tipo !== 'assistente') continue;
      let prov = p.idsParciais.get(it.id);
      if (!prov && p.parciais.size) {
        const ab = [...p.parciais.entries()].find(([, x]) => x.texto.trim() && x.texto.trim() === String(it.texto).trim());
        if (ab) {
          p.parciais.delete(ab[0]);
          p.parcPend.delete(ab[1]);
          mapearParcial(p, it.id, (prov = ab[1].id));
        }
      }
      if (prov) it.id = prov;
    }
  }

  // Contexto da instância do Orbit (sem status line no headless): tokens da última resposta (input +
  // cache_read + cache_creation, a mesma conta do analisarTranscript) e a janela do modelo
  // (result.modelUsage[modelo].contextWindow). Vai pelo mesmo caminho da status line (aplicarUso:
  // context_window → Sessao.contexto {tokens, modelo, janela, pct}, salva e difunde).
  function contextoDoResult(p, j) {
    const u = p.ultUso;
    const mu = j.modelUsage && typeof j.modelUsage === 'object' ? j.modelUsage : null;
    if (!u || !mu || !aplicarUso) return;
    const chaves = Object.keys(mu);
    const chave = mu[u.modelo] ? u.modelo : chaves.find((k) => k.startsWith(u.modelo) || u.modelo.startsWith(k)) || (chaves.length === 1 ? chaves[0] : '');
    const janela = Number(mu[chave]?.contextWindow);
    const x = u.usage;
    const tokens = (Number(x.input_tokens) || 0) + (Number(x.cache_read_input_tokens) || 0) + (Number(x.cache_creation_input_tokens) || 0);
    if (!(janela > 0) || !(tokens > 0)) return;
    p.ctxTokens = tokens; // compactação automática (20/10)
    p.ctxJanela = janela;
    const s = obterSessao(p.id);
    if (!s) return;
    if (s.contexto && s.contexto.modelo !== u.modelo) s.contexto = { ...s.contexto, modelo: u.modelo }; // o aplicarUso mantém o modelo que já houver
    try {
      aplicarUso({ ts: Date.now(), session_id: p.id, context_window: { context_window_size: janela, total_input_tokens: tokens }, model: { id: u.modelo } }, Date.now());
    } catch (e) {
      log('controle', `contexto: ${e.message}`);
    }
  }

  // Depois de compactar (pelo botão ou sozinha): o usage guardado é de antes; o contexto passa a ser o post_tokens
  // da fronteira (sem ele, desconhecido até a próxima resposta). Sem isso, o result da própria compactação ou de um
  // comando local repetiria o número velho e a automática dispararia de novo.
  function contextoDepoisDeCompactar(p, pos) {
    p.ultUso = null;
    p.ctxTokens = pos > 0 ? pos : 0;
    if (!(pos > 0) || !(p.ctxJanela > 0) || !aplicarUso) return;
    const s = obterSessao(p.id);
    if (!s) return;
    try {
      aplicarUso({ ts: Date.now(), session_id: p.id, context_window: { context_window_size: p.ctxJanela, total_input_tokens: pos }, ...(s.contexto?.modelo ? { model: { id: s.contexto.modelo } } : {}) }, Date.now());
    } catch (e) {
      log('controle', `contexto: ${e.message}`);
    }
  }

  // ── compactação automática (20/10) ──
  function cfgAuto() {
    const c = lerConfig?.()?.instancias?.autoCompactar;
    const o = c && typeof c === 'object' ? c : {};
    const limite = Number.isInteger(o.limite) && o.limite >= LIMITE_AUTO_MIN && o.limite <= LIMITE_AUTO_MAX ? o.limite : AUTO_COMPACTAR_PADRAO.limite;
    const foco = typeof o.foco === 'string' && o.foco.trim() ? encurtar(o.foco.replace(/\s+/g, ' ').trim(), MAX_FOCO) : AUTO_COMPACTAR_PADRAO.foco;
    return { ativo: o.ativo !== false, limite, foco };
  }
  // A da instância (instancias.json) vale sobre a da config.
  function autoLigada(id, cfg = cfgAuto()) {
    const v = regs.get(id)?.autoCompactar;
    return typeof v === 'boolean' ? v : cfg.ativo;
  }
  // Subagentes vivos pelos hooks (Sessao.agentes); os de segundo plano também aparecem nas tarefas.
  function agentesAtivos(id) {
    const agora = Date.now();
    return (obterSessao(id)?.agentes || []).filter(
      (a) => a && (a.status === 'trabalhando' || a.status === 'aguardando') && agora - (Number(a.atividade) || Number(a.inicio) || 0) < MS_AGENTE_PARADO,
    ).length;
  }
  // Por que ainda não dá para compactar (null = pode agora). O texto aparece na página.
  function esperaAuto(p) {
    if (p.saiu || p.iniciando || p.acordando || p.devolvendo || p.motivoDormir) return 'a instância não está pronta';
    if (p.permissoes.length) return 'o pedido de permissão ser respondido';
    if (p.ocupada) return 'a resposta em andamento terminar';
    if (agentesAtivos(p.id)) return 'os subagentes terminarem';
    if (p.tarefas.length) return 'as tarefas em segundo plano terminarem';
    if (acaoEmAndamento(p.id)) return 'a ação em andamento terminar';
    if (Date.now() - p.atividade < MS_AUTO_QUIETO) return 'a resposta em andamento terminar';
    return null;
  }
  // No fim de cada volta (result): passou do limite → fica pendente; o tique compacta quando a instância estiver parada.
  function marcarAutoCompactar(p) {
    if (p.autoCompactando || !(p.ctxTokens > 0)) return;
    const cfg = cfgAuto();
    if (!autoLigada(p.id, cfg) || p.ctxTokens <= cfg.limite) return;
    if (p.autoFalhou && Date.now() - p.autoFalhou < MS_AUTO_RECUO) return;
    // Resumo que já sai acima do limite: só tenta de novo depois de o contexto crescer de verdade (sem laço).
    const ult = ultimaAuto(p.id);
    if (ult?.depois > cfg.limite && p.ctxTokens < ult.depois + LIMITE_AUTO_MIN) return;
    if (!p.autoPendente) {
      p.autoPendente = { tokens: p.ctxTokens, desde: Date.now() };
      avisar(p.id);
    } else p.autoPendente.tokens = p.ctxTokens;
  }
  function tiqueAuto() {
    for (const p of procs.values()) if (p.autoPendente) tentarAutoCompactar(p);
  }
  function tentarAutoCompactar(p) {
    const pend = p.autoPendente;
    if (!pend || p.autoCompactando || p.saiu) return;
    const cfg = cfgAuto();
    if (!autoLigada(p.id, cfg) || !(p.ctxTokens > cfg.limite)) {
      p.autoPendente = null; // desligada nesse meio-tempo, ou o contexto já baixou (compactação pelo botão)
      return avisar(p.id);
    }
    const motivo = esperaAuto(p);
    if (motivo) {
      if (pend.esperando !== motivo) {
        pend.esperando = motivo;
        avisar(p.id);
      }
      return;
    }
    p.autoPendente = null;
    const antes = p.ctxTokens;
    const a = novaAcao(p.id, 'compactar', 'auto');
    p.autoCompactando = { inicio: Date.now(), antes };
    log('controle', `compactação automática de ${p.id} (${antes} tokens > ${cfg.limite})`);
    compactar(p, cfg.foco, a, (fronteira) => fimAutoCompactar(p, fronteira, antes));
    avisar(p.id);
  }
  function ultimaAuto(id) {
    const l = regs.get(id)?.autoCompactacoes;
    return Array.isArray(l) && l.length ? l[l.length - 1] : null;
  }
  function fimAutoCompactar(p, fronteira, antes) {
    const inicio = p.autoCompactando?.inicio || Date.now();
    p.autoCompactando = null;
    if (!fronteira) {
      p.autoFalhou = Date.now();
      avisar(p.id);
      return;
    }
    p.autoFalhou = 0;
    const reg = { inicio, quando: Date.now(), antes: fronteira.pre || antes, ...(fronteira.pos ? { depois: fronteira.pos } : {}) };
    const r = regs.get(p.id);
    if (r) {
      r.autoCompactacoes = [...(Array.isArray(r.autoCompactacoes) ? r.autoCompactacoes : []), reg].slice(-MAX_AUTO_HIST);
      salvarRegs();
    }
    avisar(p.id);
    reler(p).catch((e) => log('controle', `progresso: ${e.message}`));
  }
  // Arquivos de progresso do projeto da instância (<dados>/progresso/<projeto>), até dois níveis, sem ocultos.
  // Caminho completo: o agente lê fora da pasta do projeto.
  async function arquivosDeProgresso(cwd) {
    if (!cwd) return [];
    const raiz = pastaDeProgresso(cwd, DADOS);
    const achados = [];
    const andar = async (dir, nivel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.') || achados.length >= 20) continue;
        const c = path.join(dir, e.name);
        if (e.isFile()) achados.push(c.replace(/\\/g, '/'));
        else if (e.isDirectory() && nivel < 2) await andar(c, nivel + 1);
      }
    };
    if (cwd) await andar(raiz, 1);
    return achados.sort();
  }
  // Depois da compactação automática: com arquivos de progresso, o agente os relê antes de continuar.
  async function reler(p) {
    const lista = await arquivosDeProgresso(p.cwd);
    if (!lista.length || p.saiu) return;
    const texto = [
      '[Orbit] A conversa acabou de ser compactada automaticamente.',
      `Antes de continuar, releia os arquivos de progresso: ${lista.join(', ')}.`,
      'Não comece nada novo por causa desta mensagem: se havia trabalho em andamento, siga dele; se a última resposta esperava o usuário, só confirme em uma linha que releu e aguarde.',
    ].join(' ');
    mensagemOrbit(p, texto, 'next', novaAcao(p.id, 'mensagem', 'auto'));
  }
  // Sessao.controle.autoCompactar: ligada, limite, a escolha da instância (se houver), pendente e a última.
  function infoAuto(id, p) {
    const cfg = cfgAuto();
    const o = { ligada: autoLigada(id, cfg), limite: cfg.limite };
    const v = regs.get(id)?.autoCompactar;
    if (typeof v === 'boolean') o.propria = v;
    if (p?.autoPendente) o.pendente = { tokens: p.autoPendente.tokens, ...(p.autoPendente.esperando ? { esperando: p.autoPendente.esperando } : {}) };
    if (p?.autoCompactando) o.compactando = { desde: p.autoCompactando.inicio, antes: p.autoCompactando.antes };
    const u = ultimaAuto(id);
    if (u) o.ultima = { quando: u.quando, antes: u.antes, ...(u.depois ? { depois: u.depois } : {}) };
    return o;
  }
  // Itens `compactacao` da conversa que foram automáticos: os do histórico da instância e o que está acontecendo.
  function marcarAuto(id, itens) {
    const l = regs.get(id)?.autoCompactacoes;
    const agora = procs.get(id)?.autoCompactando;
    if (!(Array.isArray(l) && l.length) && !agora) return itens;
    for (const it of itens) {
      if (it.tipo !== 'compactacao' || !it.ts) continue;
      const r = (l || []).find((x) => it.ts >= x.inicio - 5000 && it.ts <= x.quando + 60e3);
      if (r || (agora && it.ts >= agora.inicio - 5000)) it.auto = true;
    }
    return itens;
  }

  function entradaPublica(e) {
    const o = {};
    for (const [k, v] of Object.entries(e).slice(0, 30)) o[k] = typeof v === 'string' ? encurtar(v, 2000) : JSON.stringify(v ?? null).length > 2000 ? encurtar(JSON.stringify(v), 2000) : v;
    return o;
  }

  async function lancar(s, transcript) {
    const dados = await dadosDoTranscript(transcript);
    const cwd = dados.cwd || s.cwd;
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`a pasta da sessão não existe (${cwd || 'desconhecida'})`);
    const { cmd, pre } = binarioClaude();
    // O --resume mantém o modelo (testado na 2.1.300), mas o settings do usuário pode trocar o padrão:
    // passa o modelo da última resposta para garantir.
    const args = [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--resume', s.id];
    if (dados.modelo) args.push('--model', dados.modelo);
    args.push(...argsExtras(), ...argsOrientacao(argsExtras()));
    const p = novoProcesso({ id: s.id, cwd, transcript, modelo: dados.modelo });
    return subirProcesso(p, cmd, args);
  }

  // Etapa 2: sessão nova (--session-id) com modelo, esforço e modo de permissão escolhidos. Só monta o
  // processo; quem sobe é o subirProcesso (o criarInstancia põe em procs antes, para a sessão já
  // nascer em modo orbit no /fluxo).
  function prepararNova(o) {
    const { cmd, pre } = binarioClaude();
    const args = [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--session-id', o.id];
    if (o.modelo) args.push('--model', o.modelo.valor);
    if (o.esforco) args.push('--effort', o.esforco);
    args.push('--permission-mode', o.permissao, ...argsExtras(), ...argsOrientacao(argsExtras()));
    const p = novoProcesso({ id: o.id, cwd: o.pasta, transcript: o.transcript, modelo: o.modelo?.modelo || '' });
    p.origem = 'orbit';
    p.ajustes = { modelo: o.modelo?.valor || '', esforco: o.esforco || '', modoPermissao: o.permissao };
    p.skills = Array.isArray(o.skills) ? o.skills : null;
    return { p, cmd, args };
  }

  async function subirProcesso(p, cmd, args) {
    procs.set(p.id, p); // já conta no limite e bloqueia um segundo assumir enquanto o motor sobe
    avisar(p.id);
    try {
      p.io = await abrirProcesso(p, cmd, args, p.cwd);
      p.pid = p.io.pid;
      if (!p.pid) throw new Error('não foi possível iniciar o claude');
      avisar(p.id);
      // Com stdin stream-json o system/init só sai na primeira mensagem; o initialize do protocolo
      // de controle confirma que a sessão retomou e está pronta.
      // Skills (17/10, testado no 2.1.300): `skills` no initialize é a allowlist da sessão principal; o Skill tool
      // recusa as de fora ("not in this session's skills allowlist"). Não fica no transcript: vai a cada subida.
      const r = await pedirControle(p, { subtype: 'initialize', ...(Array.isArray(p.skills) ? { skills: p.skills } : {}) }, MS_INICIO);
      // De graça: o initialize traz a lista de modelos da conta e o modo de permissão.
      atualizarModelos(r?.models, false);
      guardarComandos(p, r?.commands);
      if (!p.ajustes.modoPermissao && typeof r?.current_permission_mode === 'string') p.ajustes.modoPermissao = r.current_permission_mode;
    } catch (e) {
      p.falhouInicio = true; // etapa 4: o aoFim decide o registro (criar/assumir: some; acordar: segue dormindo)
      p.io?.matar();
      p.aoFim(null, e);
      throw e;
    }
    p.iniciando = false;
    sincronizar(p);
    difundirInstancias();
    avisar(p.id);
    // Modelo e esforço efetivos (get_settings), sem esperar: o processo já está pronto.
    ajustesEfetivos(p).catch((e) => log('controle', `get_settings: ${e.message}`));
    return p;
  }

  // Comandos com barra que o processo aceita (o initialize traz [{name, description, argumentHint}]).
  function guardarComandos(p, lista) {
    if (!Array.isArray(lista)) return;
    const l = [];
    for (const c of lista.slice(0, MAX_COMANDOS)) {
      const nome = typeof c?.name === 'string' ? c.name.trim().replace(/^\//, '') : '';
      if (!nome || /\s/.test(nome)) continue;
      l.push({ nome, descricao: encurtar(String(c.description || '').replace(/\s+/g, ' ').trim(), 300), args: encurtar(String(c.argumentHint || '').trim(), 160) });
    }
    p.comandos = l;
    comandosConhecidos = l;
  }

  // ── modelo e esforço (etapa 2) ──
  function acharModelo(v) {
    const l = modelos?.modelos || [];
    if (!v) return null;
    return l.find((m) => m.valor === v) || l.find((m) => m.modelo === v && m.valor !== 'default') || l.find((m) => m.modelo === v) || null;
  }
  function exigirModelos() {
    if (modelos) return;
    sondarModelos('pedido');
    throw erroHttp(503, 'Ainda não li a lista de modelos desta conta; tente de novo em alguns segundos.');
  }

  // Lê o efetivo por get_settings ({applied: {model, effort}}) e guarda em p.ajustes. `m` é o modelo
  // escolhido: se o efetivo for ele, devolve o `valor` (o que o seletor mostra); senão, o id efetivo.
  async function ajustesEfetivos(p, m = acharModelo(p.ajustes.modelo)) {
    const st = await pedirControle(p, { subtype: 'get_settings' }, MS_AJUSTE);
    const ap = st?.applied && typeof st.applied === 'object' ? st.applied : {};
    const ef = typeof ap.model === 'string' ? ap.model : '';
    if (ef) {
      if (m && (ef === m.modelo || ef === m.valor)) p.ajustes.modelo = m.valor;
      else p.ajustes.modelo = acharModelo(ef)?.valor || ef;
      p.modelo = acharModelo(ef)?.modelo || ef; // o --model de um próximo assumir
    }
    p.ajustes.esforco = typeof ap.effort === 'string' ? ap.effort : '';
    atualizarMeta(p);
    avisar(p.id);
    return { modelo: p.ajustes.modelo || null, esforco: p.ajustes.esforco || null };
  }

  async function trocarModelo(p, b) {
    const v = typeof b.modelo === 'string' ? b.modelo.trim() : '';
    if (!v) throw erroHttp(400, 'Escolha o modelo.');
    exigirModelos();
    const m = acharModelo(v);
    if (!m) throw erroHttp(400, `Modelo desconhecido: ${encurtar(v, 100)}.`);
    try {
      await pedirControle(p, { subtype: 'set_model', model: m.valor }, MS_AJUSTE);
    } catch (e) {
      throw erroHttp(400, `O Claude Code recusou o modelo ${m.nome}: ${e.message}`);
    }
    p.ajustes.modelo = m.valor;
    return ajustesEfetivos(p, m);
  }

  // Esforço inválido volta `success` e é ignorado em silêncio pelo claude: valida antes, pelo modelo atual.
  async function trocarEsforco(p, b) {
    const e = typeof b.esforco === 'string' ? b.esforco.trim() : '';
    exigirModelos();
    const m = acharModelo(p.ajustes.modelo) || acharModelo(p.modelo) || acharModelo('default');
    if (!m) throw erroHttp(400, 'Não sei qual é o modelo desta sessão para validar o esforço.');
    if (!m.esforcos.length) throw erroHttp(400, `${m.nome} não tem nível de esforço.`);
    if (!m.esforcos.includes(e)) throw erroHttp(400, `${m.nome} não aceita o esforço "${encurtar(e, 20) || '(vazio)'}". Use: ${m.esforcos.join(', ')}.`);
    try {
      await pedirControle(p, { subtype: 'apply_flag_settings', settings: { effortLevel: e } }, MS_AJUSTE);
    } catch (x) {
      throw erroHttp(400, `O Claude Code recusou o esforço: ${x.message}`);
    }
    return ajustesEfetivos(p, m);
  }

  // Título (testado na 2.1.300): generate_session_title {description, persist:true} gera e grava um
  // `ai-title` no transcript; se falhar, rename_session {title} grava um `custom-title` com o 1º pedido.
  async function titular(p) {
    if (p.transcript && !fs.existsSync(p.transcript)) {
      const c = await procurarTranscript(p.id); // caminho previsto errado (nome longo com hash)
      if (c) {
        p.transcript = c;
        atualizarMeta(p);
      }
    }
    const pedido = p.pedidoTitulo;
    try {
      const r = await pedirControle(p, { subtype: 'generate_session_title', description: pedido.slice(0, 4000), persist: true }, MS_TITULO);
      if (typeof r?.title === 'string' && r.title.trim()) return log('controle', `título da sessão ${p.id}: ${encurtar(r.title, 80)}`);
      log('controle', `generate_session_title sem título na sessão ${p.id}; usando rename_session`);
    } catch (e) {
      log('controle', `generate_session_title falhou na sessão ${p.id} (${e.message}); usando rename_session`);
    }
    if (p.saiu) return;
    await pedirControle(p, { subtype: 'rename_session', title: encurtar(pedido.replace(/\s+/g, ' ').trim(), MAX_NOME) }, MS_AJUSTE);
  }

  // ── modelos: sonda curta (initialize), guardada em <DADOS>/modelos.json ──
  // salvarSempre: a sonda grava sempre (atualizado); o initialize dos lançamentos só quando a lista muda.
  function atualizarModelos(lista, salvarSempre = true) {
    const norm = normalizarModelos(lista);
    if (!norm.length) return false;
    const mudou = JSON.stringify(norm) !== JSON.stringify(modelos?.modelos);
    if (!mudou && !salvarSempre) return true;
    modelos = { modelos: norm, atualizado: Date.now() };
    try {
      const tmp = `${ARQ_MODELOS}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(modelos, null, 1));
      fs.renameSync(tmp, ARQ_MODELOS);
    } catch (e) {
      log('modelos', `não gravei ${ARQ_MODELOS}: ${e.message}`);
    }
    return true;
  }

  // Processo curto (direto, fora do motor e do limite): só o initialize, sem hooks e sem transcript.
  // O pid dele entra no registro (~/.claude/sessions) com a sessionId da sonda: o servidor a ignora.
  function sondarModelos(motivo) {
    if (!SONDAR) return Promise.resolve(false);
    return (sondando ||= (async () => {
      const { cmd, pre } = binarioClaude();
      const sid = crypto.randomUUID();
      ignorarSessao?.(sid, MS_SONDA + 2 * 60e3);
      const args = [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid, '--no-session-persistence', '--strict-mcp-config', ...argsExtras(), '--settings', JSON.stringify({ disableAllHooks: true })];
      const r = await new Promise((resolve, reject) => {
        const ch = spawn(cmd, args, { cwd: DADOS, env: envLimpo(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        let err = '';
        let feito = false;
        const fim = (e, v) => {
          if (feito) return;
          feito = true;
          clearTimeout(tm);
          try {
            ch.stdin.end();
          } catch {}
          setTimeout(() => ch.exitCode == null && ch.pid && matarArvore(ch.pid), 5000).unref?.();
          if (e) reject(e);
          else resolve(v);
        };
        const tm = setTimeout(() => fim(new Error('a sonda não respondeu ao initialize')), MS_SONDA);
        ch.stdout.setEncoding('utf8');
        ch.stdout.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let j;
            try {
              j = JSON.parse(l);
            } catch {
              continue;
            }
            if (j.type !== 'control_response' || j.response?.request_id !== 'orbit-modelos') continue;
            if (j.response.subtype === 'error') fim(new Error(String(j.response.error || 'erro no initialize')));
            else fim(null, j.response.response || {});
          }
        });
        ch.stderr.setEncoding('utf8');
        ch.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
        ch.stdin.on('error', () => {});
        ch.on('error', (e) => fim(e));
        ch.on('exit', (c) => fim(new Error(`a sonda saiu antes de responder (código ${c})${err.trim() ? `: ${encurtar(err.trim().split('\n').pop(), 200)}` : ''}`)));
        ch.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'orbit-modelos', request: { subtype: 'initialize' } }) + '\n');
      });
      if (!atualizarModelos(r.models)) throw new Error('o initialize não trouxe modelos');
      log('modelos', `${modelos.modelos.length} modelos lidos (${motivo})`);
      return true;
    })()
      .catch((e) => (log('modelos', `a sonda falhou: ${e.message}`), false))
      .finally(() => (sondando = null)));
  }

  // Skills (17/10): o menu /skills do claude visto na pasta do projeto (get_skills_dialog, sem gastar tokens).
  // Processo curto como o dos modelos, com cwd na pasta (é dela que saem as skills do projeto e o
  // .claude/settings.json), sem hooks, sem MCP (--strict-mcp-config) e sem transcript. Devolve as linhas
  // [{name, display_name, description, source, tokens, state, locked_by?, advertised, handles}].
  function sondarSkills(pasta) {
    if (!SONDAR) return Promise.reject(new Error('sonda desligada neste servidor'));
    const { cmd, pre } = binarioClaude();
    const sid = crypto.randomUUID();
    ignorarSessao?.(sid, MS_SONDA + 2 * 60e3);
    const args = [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid, '--no-session-persistence', '--strict-mcp-config', ...argsExtras(), '--settings', JSON.stringify({ disableAllHooks: true })];
    return new Promise((resolve, reject) => {
      const ch = spawn(cmd, args, { cwd: pasta, env: envLimpo(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      let err = '';
      let feito = false;
      const fim = (e, v) => {
        if (feito) return;
        feito = true;
        clearTimeout(tm);
        try {
          ch.stdin.end();
        } catch {}
        setTimeout(() => ch.exitCode == null && ch.pid && matarArvore(ch.pid), 5000).unref?.();
        if (e) reject(e);
        else resolve(v);
      };
      const tm = setTimeout(() => fim(new Error('a sonda das skills não respondeu')), MS_SONDA);
      const pedir = (rid, request) => ch.stdin.write(JSON.stringify({ type: 'control_request', request_id: rid, request }) + '\n');
      ch.stdout.setEncoding('utf8');
      ch.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let j;
          try {
            j = JSON.parse(l);
          } catch {
            continue;
          }
          if (j.type !== 'control_response') continue;
          const rid = j.response?.request_id;
          if (j.response?.subtype === 'error') {
            fim(new Error(String(j.response.error || 'erro na sonda das skills')));
          } else if (rid === 'orbit-skills-init') {
            pedir('orbit-skills', { subtype: 'get_skills_dialog' });
          } else if (rid === 'orbit-skills') {
            const lista = j.response.response?.skills;
            if (!Array.isArray(lista)) fim(new Error('o get_skills_dialog não trouxe a lista'));
            else fim(null, lista);
          }
        }
      });
      ch.stderr.setEncoding('utf8');
      ch.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
      ch.stdin.on('error', () => {});
      ch.on('error', (e) => fim(e));
      ch.on('exit', (c) => fim(new Error(`a sonda das skills saiu antes de responder (código ${c})${err.trim() ? `: ${encurtar(err.trim().split('\n').pop(), 200)}` : ''}`)));
      pedir('orbit-skills-init', { subtype: 'initialize' });
    });
  }

  // Conexões MCP (17/10): mcp_status na pasta do projeto, sem gastar tokens. Processo curto como o das skills, com
  // a mesma proteção das instâncias (os pendentes ficam de fora e as chaves vão no env): a sonda sobe de verdade os
  // servidores aprovados e espera eles saírem de "pending" (conectando), até MS_SONDA_MCP. Devolve
  // [{name, status, error?, config, scope}].
  function sondarMcp(pasta, prot = {}) {
    if (!SONDAR) return Promise.reject(new Error('sonda desligada neste servidor'));
    const { cmd, pre } = binarioClaude();
    const sid = crypto.randomUUID();
    ignorarSessao?.(sid, MS_SONDA + 2 * 60e3);
    const bloquear = Array.isArray(prot.bloquear) ? prot.bloquear : [];
    const args = [...pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid, '--no-session-persistence', ...argsExtras(), '--settings', JSON.stringify({ disableAllHooks: true, ...(bloquear.length ? { disabledMcpjsonServers: bloquear } : {}) })];
    return new Promise((resolve, reject) => {
      const ch = spawn(cmd, args, { cwd: pasta, env: { ...envLimpo(), ...(prot.env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      let err = '';
      let feito = false;
      let ultima = null;
      let proxima = null;
      const inicio = Date.now();
      const fim = (e, v) => {
        if (feito) return;
        feito = true;
        clearTimeout(tm);
        clearTimeout(proxima);
        try {
          ch.stdin.end();
        } catch {}
        setTimeout(() => ch.exitCode == null && ch.pid && matarArvore(ch.pid), 3000).unref?.();
        if (e) reject(e);
        else resolve(v);
      };
      // Passou do prazo com a lista já lida: devolve o que tem (quem segue em "pending" fica assim).
      const tm = setTimeout(() => (ultima ? fim(null, ultima) : fim(new Error('a sonda dos MCP não respondeu'))), MS_SONDA_MCP);
      const pedir = (rid, request) => ch.stdin.write(JSON.stringify({ type: 'control_request', request_id: rid, request }) + '\n');
      ch.stdout.setEncoding('utf8');
      ch.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let j;
          try {
            j = JSON.parse(l);
          } catch {
            continue;
          }
          if (j.type !== 'control_response') continue;
          const rid = j.response?.request_id;
          if (j.response?.subtype === 'error') {
            fim(new Error(String(j.response.error || 'erro na sonda dos MCP')));
          } else if (rid === 'orbit-mcp-init') {
            pedir('orbit-mcp', { subtype: 'mcp_status' });
          } else if (rid === 'orbit-mcp') {
            const lista = j.response.response?.mcpServers;
            if (!Array.isArray(lista)) {
              fim(new Error('o mcp_status não trouxe a lista'));
              continue;
            }
            ultima = lista;
            if (!lista.some((s) => s?.status === 'pending') || Date.now() - inicio > MS_SONDA_MCP - 800) fim(null, lista);
            else proxima = setTimeout(() => pedir('orbit-mcp', { subtype: 'mcp_status' }), 600);
          }
        }
      });
      ch.stderr.setEncoding('utf8');
      ch.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
      ch.stdin.on('error', () => {});
      ch.on('error', (e) => fim(e));
      ch.on('exit', (c) => fim(new Error(`a sonda dos MCP saiu antes de responder (código ${c})${err.trim() ? `: ${encurtar(err.trim().split('\n').pop(), 200)}` : ''}`)));
      pedir('orbit-mcp-init', { subtype: 'initialize' });
    });
  }

  // ── POST /instancias ──
  async function criarInstancia(b) {
    const bruta = typeof b.pasta === 'string' ? b.pasta.trim() : '';
    if (!bruta) throw erroHttp(400, 'Escolha a pasta da instância.');
    if (!pastaAbsolutaValida(bruta)) throw erroHttp(400, `Use o caminho completo da pasta, como ${exemploPasta()}.`);
    let pasta = path.resolve(bruta);
    let st;
    try {
      st = await fsp.stat(pasta);
    } catch {
      throw erroHttp(400, `A pasta "${pasta}" não existe.`);
    }
    if (!st.isDirectory()) throw erroHttp(400, `"${pasta}" não é uma pasta.`);
    // Mac/Linux: o claude grava o cwd real (process.cwd() resolve links, como /tmp → /private/tmp) e a pasta
    // do transcript sai dele; com a pasta real aqui, o cwd e o transcript previstos batem com os do processo.
    // No Windows, a pasta como veio (o cwd do processo também não resolve junções).
    if (process.platform !== 'win32') pasta = await fsp.realpath(pasta).catch(() => pasta);
    if (b.modelo != null && typeof b.modelo !== 'string') throw erroHttp(400, 'O modelo deve ser texto.');
    if (b.esforco != null && typeof b.esforco !== 'string') throw erroHttp(400, 'O esforço deve ser texto.');
    const valor = (b.modelo || '').trim();
    const esforco = (b.esforco || '').trim();
    let modelo = null;
    if (valor || esforco) {
      exigirModelos();
      if (valor && !(modelo = acharModelo(valor))) throw erroHttp(400, `Modelo desconhecido: ${encurtar(valor, 100)}.`);
      // Sem modelo, o esforço vale para o padrão da conta (o `default` do initialize).
      const alvo = modelo || acharModelo('default');
      if (esforco && alvo) {
        if (!alvo.esforcos.length) throw erroHttp(400, `${alvo.nome} não tem nível de esforço.`);
        if (!alvo.esforcos.includes(esforco)) throw erroHttp(400, `${alvo.nome} não aceita o esforço "${encurtar(esforco, 20)}". Use: ${alvo.esforcos.join(', ')}.`);
      }
    }
    const permissao = b.permissao == null || b.permissao === '' ? modoPadrao() : b.permissao;
    if (!PERMISSOES.includes(permissao)) throw erroHttp(400, `Modo de permissão inválido: ${encurtar(String(permissao), 40)}. Use: ${PERMISSOES.join(', ')}.`);
    if (b.nome != null && typeof b.nome !== 'string') throw erroHttp(400, 'O nome deve ser texto.');
    const nome = (b.nome || '').replace(/\s+/g, ' ').trim();
    if (nome.length > MAX_NOME) throw erroHttp(400, `O nome pode ter até ${MAX_NOME} caracteres.`);
    if (b.texto != null && typeof b.texto !== 'string') throw erroHttp(400, 'A 1ª mensagem deve ser texto.');
    const texto = b.texto || '';
    if (texto.length > MAX_TEXTO) throw erroHttp(400, `A 1ª mensagem pode ter até ${MAX_TEXTO} caracteres.`);
    const imagens = blocosDeImagens(b.imagens);
    if (b.skills != null && !Array.isArray(b.skills)) throw erroHttp(400, 'As skills devem ser uma lista de nomes.');
    if (Array.isArray(b.skills) && (b.skills.length > MAX_SKILLS || b.skills.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200 || /[\s\u0000-\u001f]/.test(x.trim())))) {
      throw erroHttp(400, `Lista de skills inválida (até ${MAX_SKILLS} nomes, sem espaços).`);
    }
    const skills = Array.isArray(b.skills) ? [...new Set(b.skills.map((x) => x.trim()))] : null;
    if (!criarSessao) throw erroHttp(501, 'Este servidor não sabe criar instâncias.');
    await liberarVaga(); // etapa 4: no limite, faz dormir a elegível mais antiga; sem nenhuma, 409 limite

    const id = crypto.randomUUID();
    const transcript = transcriptNovo(pasta, id);
    const { p, cmd, args } = prepararNova({ id, pasta, transcript, modelo, esforco, permissao, skills });
    procs.set(id, p); // a sessão já nasce em modo orbit ("Iniciando no Orbit") e conta no limite
    criarSessao({ id, cwd: pasta, apelido: nome, transcript });
    const a = novaAcao(id, 'criar', 'orbit');
    etapa(a, 'Iniciando');
    (async () => {
      try {
        await subirProcesso(p, cmd, args);
      } catch (e) {
        return falhar(a, `O Orbit não conseguiu iniciar a instância (${e.message}).`);
      }
      concluir(a);
      try {
        gravarNovaInstancia?.({ pasta, modelo: modelo?.valor || null, esforco: esforco || null, permissao });
      } catch (e) {
        log('controle', `config.novaInstancia: ${e.message}`);
      }
      if (texto.trim() || imagens.length) mensagemOrbit(p, texto, undefined, undefined, imagens);
    })().catch((e) => falhar(a, e.message));
    return { acao: a, sessao: id };
  }

  // Objeto do processo do Orbit. O resto do código não sabe se ele mora no motor ou é filho direto:
  // fala só com p.io (gravavel, escrever, fechar, matar) e recebe por p.aoLinha/aoStderr/aoFim.
  function novoProcesso(o) {
    const p = {
      id: o.id,
      chave: o.chave || o.id, // id da instância no motor (a sessionId de quando foi lançada)
      pid: o.pid || 0,
      desde: o.desde || Date.now(),
      io: null,
      cwd: o.cwd,
      transcript: o.transcript,
      modelo: o.modelo || '',
      origem: 'assumir', // 'orbit': criada pelo Orbit (POST /instancias)
      ajustes: { modelo: '', esforco: '', modoPermissao: '' }, // etapa 2: controle.modelo/esforco/modoPermissao
      skills: null, // allowlist de skills da Nova instância (null = todas)
      pedidoTitulo: '', // 1º pedido da instância criada pelo Orbit (vira o título depois da 1ª volta)
      titulado: false,
      iniciando: true,
      ocupada: false,
      resetando: false,
      saiu: false,
      permissoes: [],
      // Etapa 3: tarefas em segundo plano, texto ao vivo (blocos abertos por índice, uuid final → id do
      // parcial, envios pendentes) e o usage da última resposta (contexto).
      tarefas: [],
      parciais: new Map(),
      parcMsg: '',
      idsParciais: new Map(),
      parcPend: new Set(),
      parcTimer: null,
      parcUlt: 0,
      ultUso: null,
      // Etapa 4: última atividade (ms), agendamentos vistos no stream, memória (tasklist), a volta que o
      // processo anterior deixou interrompida, por que vai dormir e se está acordando (--resume do registro).
      atividade: Date.now(),
      agendamentos: 0,
      memoria: 0,
      interrompida: false,
      motivoDormir: '',
      acordando: false,
      controles: new Map(),
      ouvintes: new Set(),
      aoSair: new Set(),
      stderr: '',
      seq: 0, // última linha do motor já vista
    };
    p.aoLinha = (l) => {
      const t = String(l).trim();
      if (!t) return;
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        return;
      }
      aoMensagem(p, j);
    };
    p.aoStderr = (d) => (p.stderr = (p.stderr + d).slice(-2000));
    p.aoFim = (codigo, erro) => {
      if (p.saiu) return;
      p.saiu = true;
      if (instancias.get(p.chave) === p) instancias.delete(p.chave);
      if (procs.get(p.id) === p) procs.delete(p.id);
      const det = erro ? erro.message : [codigo != null ? `código ${codigo}` : '', encurtar(p.stderr.trim().split('\n').pop() || '', 200)].filter(Boolean).join(': ');
      // Etapa 4: o registro. Devolver (assumida), remover e falha ao criar/assumir: some. Falha ao acordar:
      // segue dormindo como antes. O resto dorme: com o motivo pedido, ou 'saiu' (morreu sozinho; se estava
      // ocupada, interrompida).
      const rg = regs.get(p.id);
      if (rg && !procs.has(p.id)) {
        if (p.devolvendo || p.semRegistro || (p.falhouInicio && !p.acordando)) regs.delete(p.id);
        else {
          rg.processo = 'dormindo';
          if (p.falhouInicio && p.acordando) {
            if (p.dormiuAntes) rg.dormiu = p.dormiuAntes;
          } else {
            rg.dormiu = { motivo: p.motivoDormir || 'saiu', em: iso() };
            if (!p.motivoDormir) {
              log('controle', `o processo da instância ${p.id} terminou sozinho (${det || 'sem detalhe'})`);
              if (p.ocupada) rg.interrompida = true;
            }
          }
          rg.ocupada = false;
          rg.agendamentos = 0; // os agendamentos morrem com o processo
          rg.ultimaAtividade = iso(p.atividade);
        }
        salvarRegs();
        difundirInstancias();
      }
      for (const c of p.controles.values()) c.falha(new Error(det || 'o processo terminou'));
      p.controles.clear();
      for (const f of [...p.aoSair]) f(det);
      p.permissoes = [];
      p.tarefas = [];
      clearTimeout(p.parcTimer);
      p.parcPend.clear();
      avisar(p.id);
    };
    return p;
  }

  // Pelo motor; se ele não subir, spawn direto como na rodada 5 (registrado no log).
  async function blindarMcp(args, cwd) {
    if (typeof mcpProtecao !== 'function') return { args, env: envLimpo() };
    try {
      const r = await mcpProtecao(cwd);
      const bloquear = Array.isArray(r?.bloquear) ? r.bloquear : [];
      if (bloquear.length) log('mcp', `${bloquear.length} servidor(es) do .mcp.json esperando aprovação ficam de fora em ${cwd}: ${bloquear.join(', ')}`);
      return { args: bloquear.length ? comSettings(args, { disabledMcpjsonServers: bloquear }) : args, env: { ...envLimpo(), ...(r?.env || {}) } };
    } catch (e) {
      log('mcp', `sem a proteção dos MCP (${e?.message || e}): a instância sobe sem nenhum servidor MCP`);
      return { args: args.includes('--strict-mcp-config') ? args : [...args, '--strict-mcp-config'], env: envLimpo() };
    }
  }

  async function abrirProcesso(p, cmd, argsBase, cwd) {
    const { args, env } = await blindarMcp(argsBase, cwd);
    if (USAR_MOTOR) {
      if (await motor.garantir()) {
        for (let tentativa = 0; ; tentativa++) {
          const io = fachadaMotor(p);
          p.lancando = true;
          try {
            const r = await motor.pedir('lancar', { id: p.chave, cmd, args, cwd, env, meta: metaDe(p) }, 15e3);
            io.pid = Number(r.pid);
            p.lancando = false;
            return io;
          } catch (e) {
            p.lancando = false;
            if (instancias.get(p.chave) === p) instancias.delete(p.chave);
            // Mesmo id ainda vivo no motor (ex.: a instância antiga mudou de sessão no /clear): outra chave.
            if (e.codigo === 'existe' && tentativa === 0) {
              p.chave = `${p.id}~${Date.now().toString(36)}`;
              continue;
            }
            throw e;
          }
        }
      }
      log('motor', 'o motor de instâncias não subiu; lançando direto (o processo morre junto com o servidor)');
    }
    return fachadaDireta(p, cmd, args, cwd, env);
  }

  // Instância no motor: escrever/fechar/matar viram pedidos; linha/stderr/saiu chegam por eventoDoMotor.
  function fachadaMotor(p) {
    let fechado = false;
    instancias.set(p.chave, p); // antes do lancar: os eventos podem chegar logo depois da resposta
    return {
      via: 'motor',
      pid: p.pid,
      gravavel: () => !fechado && motor.conectado(),
      escrever: (l) => motor.enviar('escrever', { id: p.chave, linha: l }),
      fechar: () => {
        fechado = true;
        motor.enviar('fechar', { id: p.chave });
      },
      matar: () => (motor.conectado() ? motor.pedir('matar', { id: p.chave }, 20e3).catch(() => matarArvore(p.pid)) : matarArvore(p.pid)),
    };
  }

  // Sem motor: filho direto do servidor (fica no job do libuv e morre com ele, como na rodada 5).
  function fachadaDireta(p, cmd, args, cwd, env = envLimpo()) {
    const ch = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    ch.stdout.setEncoding('utf8');
    ch.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        p.aoLinha(l);
      }
    });
    ch.stderr.setEncoding('utf8');
    ch.stderr.on('data', (d) => p.aoStderr(d));
    ch.stdin.on('error', () => {});
    ch.on('exit', (c) => p.aoFim(c));
    ch.on('error', (e) => p.aoFim(null, e));
    return {
      via: 'direto',
      pid: ch.pid,
      gravavel: () => ch.stdin.writable,
      escrever: (l) => ch.stdin.write(l + '\n'),
      fechar: () => {
        try {
          ch.stdin.end();
        } catch {}
      },
      matar: () => (ch.pid ? matarArvore(ch.pid) : Promise.resolve()),
    };
  }

  // meta opaco guardado no motor: o que o próximo servidor precisa para adotar a instância.
  const metaDe = (p) => ({
    sessao: p.id,
    cwd: p.cwd,
    transcript: p.transcript,
    modelo: p.modelo,
    origem: p.origem,
    ajustes: p.ajustes,
    skills: p.skills,
    pedidoTitulo: encurtar(p.pedidoTitulo, 4000),
    titulado: p.titulado,
    tarefas: p.tarefas, // etapa 3: o próximo servidor mostra as tarefas até o próximo background_tasks_changed
  });
  function atualizarMeta(p) {
    sincronizar(p); // etapa 4: o registro acompanha o meta
    if (p.io?.via === 'motor' && !p.saiu) motor.enviar('meta', { id: p.chave, meta: metaDe(p) });
  }

  function eventoDoMotor(j) {
    const p = instancias.get(j.id);
    if (!p) return;
    if (j.ev === 'linha') {
      if (!(j.seq > p.seq)) return; // repetida (assinar depois de reconectar)
      p.seq = j.seq;
      p.aoLinha(j.linha);
    } else if (j.ev === 'stderr') p.aoStderr(String(j.texto ?? ''));
    else if (j.ev === 'saiu') p.aoFim(j.codigo ?? null);
  }

  // Conexão nova com o motor (subida do servidor ou reconexão): reassina as instâncias conhecidas desde
  // a última linha vista e adota as vivas que este servidor não conhece.
  async function reconciliar() {
    const { instancias: lista = [] } = await motor.pedir('listar');
    for (const p of [...instancias.values()]) {
      // Lançamento em andamento: o `lancar` foi depois do `listar` (a lista ainda não a tem); não é "sumiu".
      if (p.lancando) continue;
      const i = lista.find((x) => x.id === p.chave);
      if (!i || !i.vivo) p.aoFim(i?.codigo ?? null, i ? null : new Error('a instância sumiu do motor'));
      else motor.enviar('assinar', { id: p.chave, desde: p.seq });
    }
    for (const i of lista) if (i.vivo && !instancias.has(i.id)) adotar(i);
  }

  // Instância viva de antes do reinício → processo do Orbit em modo orbit, sem ação do usuário.
  // A Acao que estava em andamento no servidor anterior se perde.
  function adotar(i) {
    const m = i.meta && typeof i.meta === 'object' ? i.meta : {};
    const e = i.estado && typeof i.estado === 'object' ? i.estado : {};
    const id = String(e.sessao || m.sessao || i.id);
    if (procs.has(id)) return log('motor', `instância ${i.id} não adotada: a sessão ${id} já tem processo no Orbit`);
    const transcript = m.transcript ? path.join(path.dirname(m.transcript), `${id}.jsonl`) : '';
    const p = novoProcesso({ id, chave: i.id, pid: Number(i.pid), desde: Number(i.desde) || Date.now(), cwd: m.cwd, transcript, modelo: m.modelo });
    p.adotada = true;
    p.seq = Number(i.seq) || 0;
    if (m.origem === 'orbit') p.origem = 'orbit';
    if (m.ajustes && typeof m.ajustes === 'object') for (const k of Object.keys(p.ajustes)) if (typeof m.ajustes[k] === 'string') p.ajustes[k] = m.ajustes[k];
    if (typeof m.pedidoTitulo === 'string') p.pedidoTitulo = m.pedidoTitulo;
    p.skills = listaSkills(m.skills ?? regs.get(id)?.skills);
    p.titulado = !!m.titulado;
    if (Array.isArray(m.tarefas)) p.tarefas = m.tarefas.filter((t) => t && typeof t.id === 'string').slice(0, 20);
    // Etapa 4: o registro de antes do reinício (agendamentos, interrompida e a última atividade).
    const rg = regs.get(id);
    if (rg) {
      p.agendamentos = Number(rg.agendamentos) || 0;
      p.interrompida = !!rg.interrompida;
      p.atividade = Date.parse(rg.ultimaAtividade) || Date.now();
    }
    p.ocupada = !!e.ocupada;
    p.iniciando = !e.iniciado;
    for (const q of Array.isArray(e.permissoes) ? e.permissoes : []) if (q?.request?.subtype === 'can_use_tool') p.permissoes.push(permissaoDe(q));
    p.io = fachadaMotor(p);
    p.io.pid = p.pid;
    procs.set(id, p);
    if (transcript) achados.set(id, transcript);
    motor.enviar('assinar', { id: i.id, desde: p.seq });
    if (id !== m.sessao) atualizarMeta(p); // o /clear aconteceu com o servidor fora
    else sincronizar(p); // etapa 4: a adotada ganha registro já (sem esperar atividade), para o reinício do PC
    if (p.iniciando) {
      // Reiniciou no meio do initialize: a resposta chega pela assinatura; sem ela, encerra.
      setTimeout(() => {
        if (!p.iniciando || p.saiu) return;
        log('motor', `instância ${i.id} adotada sem responder ao initialize; encerrando`);
        p.io.matar();
      }, MS_INICIO).unref?.();
    }
    log('motor', `adotada a sessão ${id} (pid ${p.pid}${p.ocupada ? ', ocupada' : ''}${p.permissoes.length ? `, ${p.permissoes.length} permissão pendente` : ''})`);
    avisar(id);
    // Lançada antes da etapa 2 (meta sem ajustes): o modelo e o esforço efetivos vêm do get_settings.
    if (!p.iniciando && !p.ajustes.modelo) ajustesEfetivos(p).catch((e) => log('controle', `get_settings: ${e.message}`));
  }

  // A conexão com o motor caiu sem o servidor pedir.
  async function motorCaiu(substituido) {
    const nossas = [...instancias.values()];
    if (substituido) {
      log('motor', 'outro servidor assumiu o motor; as instâncias saem do controle deste');
      for (const p of nossas) p.aoFim(null, new Error('outro servidor do Orbit assumiu a instância'));
      return;
    }
    log('motor', 'a conexão com o motor caiu; reconectando');
    for (let k = 0; k < 10 && !(await motor.garantir(false)); k++) await dormir(300);
    if (!motor.conectado()) {
      // Os claude são filhos do motor: no Windows morrem junto (job do libuv); no Mac/Linux o motor os mata
      // ao sair e, se ele foi morto à força, eles saem quando o stdin (pipe do motor) fecha.
      log('motor', 'o motor não voltou; as instâncias dele terminaram');
      for (const p of nossas) p.aoFim(null, new Error('o motor de instâncias terminou'));
      return;
    }
    await reconciliar();
  }

  function permissaoDe(j) {
    const q = j.request || {};
    const entrada = q.input && typeof q.input === 'object' ? q.input : {};
    const ferramenta = String(q.tool_name || '');
    // Etapa 3: tipo, sugestões (permission_suggestions), perguntas (AskUserQuestion) e plano (ExitPlanMode).
    const tipo = ferramenta === 'AskUserQuestion' ? 'pergunta' : ferramenta === 'ExitPlanMode' ? 'plano' : 'ferramenta';
    const { cruas, sugestoes } = sugestoesDe(q.permission_suggestions, tipo);
    const r = {
      id: String(j.request_id),
      ferramenta,
      resumo: encurtar(q.description || resumoFerramenta(q.tool_name, entrada), 300),
      entrada,
      entradaPublica: entradaPublica(entrada),
      tipo,
      sugestoes,
      cruas,
    };
    if (tipo === 'pergunta') r.perguntas = perguntasDe(entrada);
    if (tipo === 'plano') r.plano = typeof entrada.plan === 'string' ? encurtar(entrada.plan, 100000) : '';
    return r;
  }

  async function assumir(s, a) {
    let encerrou = false;
    try {
      await liberarVaga(); // etapa 4: no limite, dorme a elegível mais antiga (antes de mexer no processo antigo)
      etapa(a, 'Encerrando o processo antigo');
      encerrou = (await encerrarProcessoAntigo(s)).encerrado;
    } catch (e) {
      return falhar(a, e.message);
    }
    etapa(a, 'Iniciando no Orbit');
    try {
      const transcript = await acharTranscript(s.id);
      if (!transcript) throw new Error('transcript não encontrado');
      await lancar(s, transcript);
      concluir(a);
    } catch (e) {
      falhar(
        a,
        encerrou
          ? `O processo antigo da sessão foi encerrado, mas o Orbit não conseguiu retomá-la (${e.message}). Reabra a sessão no VS Code pelo botão Abrir.`
          : `O Orbit não conseguiu retomar a sessão (${e.message}).`,
      );
    }
  }

  async function fecharProcesso(p, t = MS_DEVOLVER, a) {
    if (p.saiu) return;
    const saiu = new Promise((r) => p.aoSair.add(r));
    p.io.fechar();
    const ok = await Promise.race([saiu.then(() => true), dormir(t).then(() => false)]);
    if (ok || p.saiu) return;
    if (a) etapa(a, 'Encerrando à força');
    await p.io.matar();
    await Promise.race([saiu, dormir(5000)]);
  }

  // ── ações ──
  // a: a Acao já criada quando a instância precisou acordar antes (etapa 4).
  // imagens: blocos `image` já validados (blocosDeImagens); vão antes do texto, no mesmo content.
  // 20/10 (camada 3): uma linha ao líder de um subagente acima do limite de contexto, quando o aviso direto
  // (aviso-subagente.mjs) não chegou. Só instância do Orbit pronta; ocupada, a mensagem entra na fila da volta.
  function avisarLider(id, texto) {
    const p = procs.get(id);
    if (!p || p.saiu || p.iniciando || p.acordando || typeof texto !== 'string' || !texto.trim()) return false;
    mensagemOrbit(p, texto.replace(/\s+/g, ' ').trim());
    return true;
  }

  function mensagemOrbit(p, texto, prioridade, a = novaAcao(p.id, 'mensagem', 'orbit'), imagens = []) {
    etapa(a, 'Enviando');
    const estavaOcupada = p.ocupada;
    const alvo = texto.trim();
    const nImg = imagens.length;
    if (p.origem === 'orbit' && !p.pedidoTitulo && !p.titulado && alvo && alvo[0] !== '/') {
      p.pedidoTitulo = alvo; // o 1º pedido: vira o título depois da 1ª volta
      atualizarMeta(p);
    }
    // Comando com barra: o eco vem como <command-name>/x</command-name> (comandos de prompt) ou não vem
    // (comandos locais, que só soltam o result). Na fila de uma volta, vale o result depois do fim dela.
    const barra = alvo[0] === '/' ? alvo.split(/\s/)[0] : '';
    let fimDaVolta = !estavaOcupada;
    (async () => {
      if (prioridade === 'now' && p.ocupada) await pedirControle(p, { subtype: 'interrupt' }, 15e3).catch(() => {});
      const pronto = acompanhar(
        p,
        a,
        MS_MENSAGEM,
        (j) => {
          if (j.type === 'user' && !j.isSynthetic) {
            const t = textoDe(j.message?.content).trim();
            if (t === alvo && contarImagens(j.message?.content) === nImg) return concluir(a), true;
            const cmd = barra && RE_CMD.exec(t);
            if (cmd && '/' + cmd[1].trim().replace(/^\//, '') === barra) return concluir(a), true;
          }
          if (j.type === 'result') {
            if (fimDaVolta) return concluir(a), true; // comando sem eco
            if (barra) fimDaVolta = true;
          }
        },
        'Não confirmada pela sessão.',
      );
      try {
        const content = nImg ? [...imagens, ...(alvo ? [{ type: 'text', text: texto }] : [])] : texto;
        escrever(p, { type: 'user', message: { role: 'user', content } });
        p.ocupada = true;
        avisar(p.id);
      } catch (e) {
        falhar(a, `Não deu para escrever no processo: ${e.message}`);
      }
      await pronto;
    })();
    return a;
  }

  function mensagemCanal(s, reg, texto, prioridade, transcript) {
    const a = novaAcao(s.id, 'mensagem', 'canal');
    etapa(a, 'Enviando');
    (async () => {
      const cauda = new Cauda(transcript, await fimCompleto(transcript));
      const trecho = texto.trim().slice(0, 200);
      try {
        const token = await tokenDoCanal(reg);
        const msg = { type: 'user', message: { role: 'user', content: texto }, priority: prioridade || 'next', session_id: s.id };
        await new Promise((resolve, reject) => {
          const c = net.connect(reg.socket);
          const tm = setTimeout(() => (c.destroy(), reject(new Error('o canal não respondeu'))), 10e3);
          c.on('connect', () => c.end(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify(msg) + '\n'));
          c.on('error', (e) => (clearTimeout(tm), reject(e)));
          c.on('close', () => (clearTimeout(tm), resolve()));
        });
      } catch (e) {
        return falhar(a, `Não deu para enviar pelo canal: ${e.message}. Veja se a sessão continua aberta.`);
      }
      etapa(a, 'Esperando a sessão confirmar');
      const fim = Date.now() + MS_CANAL;
      while (Date.now() < fim) {
        const { entradas } = await cauda.ler();
        for (const { e } of entradas) {
          const t =
            e.type === 'queue-operation' ? String(e.content ?? '') : e.type === 'user' && e.origin?.kind === 'peer' ? textoDe(e.message?.content) : '';
          if (t && t.includes(trecho)) return concluir(a);
        }
        await dormir(MS_VIGIA);
      }
      falhar(a, 'Não confirmada pela sessão.');
    })().catch((e) => falhar(a, e.message));
    return a;
  }

  // aoFim (20/10, compactação automática): recebe {pre, pos} da fronteira, ou null se falhou.
  function compactar(p, foco, a = novaAcao(p.id, 'compactar', 'orbit'), aoFim = null) {
    etapa(a, 'Enviando /compact');
    let viuFronteira = null;
    let outraVolta = false;
    const pronto = acompanhar(
      p,
      a,
      MS_COMPACTAR,
      (j) => {
        if (j.type === 'system' && j.subtype === 'status' && j.status === 'compacting') etapa(a, 'Compactando');
        if (j.type === 'system' && j.subtype === 'compact_boundary') {
          const m = j.compact_metadata || {};
          viuFronteira = { pre: Number(m.pre_tokens) || undefined, pos: Number(m.post_tokens) || undefined };
        }
        // A compactação não fala: resposta do assistente antes da fronteira é de uma volta que já estava na fila
        // (o /compact roda depois dela). O result dessa volta não é o nosso.
        if (!viuFronteira && !j.parent_tool_use_id && (j.type === 'assistant' || (j.type === 'stream_event' && j.event?.type === 'message_start'))) outraVolta = true;
        if (j.type === 'result') {
          if (j.is_error) return falhar(a, `A compactação falhou: ${encurtar(j.result || (j.errors || []).join('; ') || j.subtype, 300)}`), false;
          if (viuFronteira) {
            contextoDepoisDeCompactar(p, viuFronteira.pos);
            return concluir(a, viuFronteira), true;
          }
          if (outraVolta) {
            outraVolta = false;
            etapa(a, 'Esperando a volta em andamento terminar');
            return;
          }
          return falhar(a, `A sessão não compactou${j.result ? `: ${encurtar(j.result, 300)}` : ''}.`), false;
        }
      },
      'A compactação não terminou em 5 min.',
    );
    if (aoFim) pronto.then((ok) => aoFim(ok ? viuFronteira : null)).catch(() => aoFim(null));
    try {
      escrever(p, { type: 'user', message: { role: 'user', content: ('/compact ' + (foco || '')).trim() } });
      p.ocupada = true;
      avisar(p.id);
    } catch (e) {
      falhar(a, `Não deu para escrever no processo: ${e.message}`);
    }
    pronto.then(() => {});
    return a;
  }

  function limpar(p, a = novaAcao(p.id, 'limpar', 'orbit')) {
    etapa(a, 'Limpando');
    const velho = p.id;
    let resetou = false;
    acompanhar(
      p,
      a,
      MS_LIMPAR,
      (j) => {
        if (j.type === 'conversation_reset') resetou = true;
        if (p.id !== velho) return concluir(a, { novaSessao: p.id }), true;
        if (j.type === 'result' && !resetou) return falhar(a, `A sessão não foi limpa${j.result ? `: ${encurtar(j.result, 300)}` : ''}.`), false;
      },
      'A limpeza não terminou a tempo.',
    );
    try {
      escrever(p, { type: 'user', message: { role: 'user', content: '/clear' } });
      p.ocupada = true;
      avisar(p.id);
    } catch (e) {
      falhar(a, `Não deu para escrever no processo: ${e.message}`);
    }
    return a;
  }

  function devolver(p) {
    const a = novaAcao(p.id, 'devolver', 'orbit');
    p.devolvendo = true; // etapa 4: larga o controle (o registro some quando o processo sair)
    etapa(a, 'Fechando o processo');
    fecharProcesso(p, MS_DEVOLVER, a)
      .then(() => (p.saiu ? concluir(a) : falhar(a, `O processo ${p.pid} não terminou.`)))
      .catch((e) => falhar(a, e.message));
    return a;
  }

  // Etapa 3: b = {id, decisao, sugestao?, respostas?, mensagem?}.
  //  - permitir + sugestao → allow com updatedPermissions [a sugestão crua] (o claude aplica a regra ou o modo);
  //  - pergunta: permitir + respostas → allow com updatedInput {...entrada, answers} (testado na 2.1.300; na
  //    múltipla escolha o claude aceita o texto com os rótulos unidos por ", " ou uma lista);
  //  - plano: permitir aprova (sugestao opcional, ex.: aceitar edições); negar + mensagem = continuar planejando;
  //  - negar → deny com a mensagem (ou a padrão).
  // remoto (celular): "Permitir sempre" vale só para a sessão (revisão P2-5): a regra nunca vai para o
  // settings do usuário/projeto/local.
  function permissao(p, b, remoto = false) {
    const id = b.id;
    const i = p.permissoes.findIndex((x) => x.id === id);
    if (i < 0) throw erroHttp(404, 'pedido de permissão não encontrado (já respondido?)');
    const q = p.permissoes[i];
    if (b.mensagem != null && (typeof b.mensagem !== 'string' || b.mensagem.length > MAX_MOTIVO)) throw erroHttp(400, `mensagem deve ser texto de até ${MAX_MOTIVO} caracteres`);
    const mensagem = (b.mensagem || '').trim();
    let resposta;
    if (b.decisao === 'negar') {
      const padrao = q.tipo === 'pergunta' ? 'O usuário preferiu não responder pelo Orbit.' : q.tipo === 'plano' ? 'O usuário quer continuar planejando.' : 'O usuário negou pelo Orbit.';
      resposta = { behavior: 'deny', message: mensagem || padrao };
    } else {
      resposta = { behavior: 'allow', updatedInput: q.entrada };
      if (b.sugestao != null) {
        const sg = Number.isInteger(b.sugestao) && q.sugestoes.some((s) => s.indice === b.sugestao) ? q.cruas[b.sugestao] : null;
        if (!sg) throw erroHttp(400, `Sugestão inexistente: ${encurtar(String(b.sugestao), 20)}.`);
        resposta.updatedPermissions = remoto ? atualizacoesDe(sg).map((u) => ({ ...u, destination: 'session' })) : atualizacoesDe(sg);
      }
      if (q.tipo === 'pergunta') resposta.updatedInput = { ...q.entrada, answers: respostasDe(q, b.respostas) };
    }
    escrever(p, { type: 'control_response', response: { subtype: 'success', request_id: id, response: resposta } });
    p.permissoes.splice(i, 1);
    if (!p.permissoes.length) try { deps.aoLiberar?.(p.id); } catch (e) { log('controle', `aoLiberar: ${e.message}`); }
    // O claude avisa a troca de modo por system/status; adianta aqui para o seletor não piscar.
    const modo = resposta.updatedPermissions?.find((s) => s.type === 'setMode' && (s.destination === 'session' || s.destination === 'cliArg'))?.mode;
    if (modo && PERMISSOES.includes(modo)) {
      p.ajustes.modoPermissao = modo;
      atualizarMeta(p);
    }
    avisar(p.id);
  }

  // {pergunta: rótulo | texto livre | [rótulos] (só múltipla)} → answers do AskUserQuestion. Toda pergunta
  // precisa de resposta; chaves que não são perguntas ficam de fora (o claude recusaria).
  function respostasDe(q, r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw erroHttp(400, 'Mande as respostas: { respostas: { pergunta: resposta } }.');
    const answers = {};
    const faltam = [];
    for (const pg of q.perguntas || []) {
      let v = r[pg.pergunta];
      if (Array.isArray(v) && pg.multipla) v = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => encurtar(x.trim(), MAX_MOTIVO));
      else if (typeof v === 'string') v = encurtar(v.trim(), MAX_MOTIVO);
      else v = '';
      if (!v.length) faltam.push(pg.pergunta);
      else answers[pg.pergunta] = v;
    }
    if (faltam.length) throw erroHttp(400, `Falta responder: ${encurtar(faltam.join(' · '), 300)}`);
    return answers;
  }

  // POST /parar: interrupt; a Acao conclui no `result` da volta. Pedidos de permissão que estavam abertos e
  // que o claude não cancelar somem junto (a volta deles acabou).
  function parar(p) {
    const a = novaAcao(p.id, 'parar', 'orbit');
    etapa(a, 'Interrompendo');
    const abertos = new Set(p.permissoes.map((x) => x.id));
    acompanhar(
      p,
      a,
      MS_PARAR,
      (j) => {
        if (j.type !== 'result') return;
        const n = p.permissoes.length;
        p.permissoes = p.permissoes.filter((x) => !abertos.has(x.id));
        if (n !== p.permissoes.length) avisar(p.id);
        return concluir(a), true;
      },
      'A volta não parou a tempo.',
    ).then(() => {});
    pedirControle(p, { subtype: 'interrupt' }, MS_AJUSTE).catch((e) => falhar(a, `O Claude Code não aceitou a interrupção: ${e.message}`));
    return a;
  }

  // POST /modo: set_permission_mode (success sem corpo); o efetivo segue pelo system/status do claude.
  async function trocarModo(p, b) {
    const modo = typeof b.modo === 'string' ? b.modo : '';
    if (!PERMISSOES.includes(modo)) throw erroHttp(400, `Modo de permissão inválido: ${encurtar(modo || '(vazio)', 40)}. Use: ${PERMISSOES.join(', ')}.`);
    try {
      await pedirControle(p, { subtype: 'set_permission_mode', mode: modo }, MS_AJUSTE);
    } catch (e) {
      throw erroHttp(400, `O Claude Code recusou o modo: ${e.message}`);
    }
    p.ajustes.modoPermissao = modo;
    atualizarMeta(p);
    avisar(p.id);
    return { modo };
  }

  // ── SSE da conversa ──
  function enviarSSE(f, tipo, dados) {
    try {
      f.res.write(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`);
    } catch {
      fluxos.delete(f);
    }
  }

  async function tiqueFluxos() {
    for (const f of fluxos) {
      if (f.ocupado) continue;
      f.ocupado = true;
      try {
        if (!f.cauda) {
          const c = await acharTranscript(f.id);
          if (!c) continue;
          f.cauda = new Cauda(c, f.desdeZero ? 0 : await fimCompleto(c));
          f.desdeZero = false;
        }
        const r = await f.cauda.ler();
        if (r.encolheu) {
          enviarSSE(f, 'reinicio', { motivo: 'arquivo' });
          f.cauda.offset = await fimCompleto(f.cauda.caminho);
          continue;
        }
        if (!r.entradas.length) continue;
        const arq = arquivoDe(f.cauda.caminho);
        const itens = r.entradas.flatMap(({ e, off }) => normalizar(e, arq, 'cauda', off));
        idsDosParciais(f.id, itens); // etapa 3: o item final substitui o parcial (mesmo id)
        marcarAuto(f.id, itens); // 20/10: compactação automática
        if (itens.length) enviarSSE(f, 'itens', { itens });
      } catch (e) {
        log('fluxo', e.message);
      } finally {
        f.ocupado = false;
      }
    }
  }

  async function abrirFluxo(req, res, id, desde) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const f = { res, id, cauda: null, ocupado: true, desdeZero: false };
    fluxos.add(f);
    const sair = () => fluxos.delete(f);
    req.on('close', sair);
    res.on('error', sair);
    try {
      const c = await acharTranscript(id);
      // Sessão nova (etapa 2): o arquivo ainda não existe; quando aparecer, tudo nele é novo.
      if (!c) f.desdeZero = true;
      else f.cauda = new Cauda(c, desde != null ? Math.min(desde, (await fsp.stat(c).catch(() => ({ size: 0 }))).size) : await fimCompleto(c));
    } catch {}
    f.ocupado = false;
  }

  const timers = [
    setInterval(() => lerRegistro().catch((e) => log('controle registro', e.message)), MS_REGISTRO),
    setInterval(() => fluxos.size && tiqueFluxos(), MS_VIGIA),
    setInterval(() => {
      for (const f of fluxos)
        try {
          f.res.write(': ping\n\n');
        } catch {}
    }, MS_PING),
  ];
  // Cópia própria do claude.exe (binario.mjs): na subida e a cada hora. Servidores de teste (dados no
  // scratchpad ou binário falso) não copiam, a não ser que apontem um ORBIT_BIN_DIR próprio.
  const testando = (process.env.GERENCIADOR_DADOS || process.env.ORBIT_CLAUDE_BIN) && !process.env.ORBIT_BIN_DIR;
  if (!testando) {
    const atualizar = () => atualizarBinario(log).catch((e) => log('binário', e.message));
    timers.push(setInterval(atualizar, 60 * 60e3));
    setTimeout(atualizar, 5000).unref?.();
  }
  // Etapa 2: modelos na subida (+30 s) e a cada 6 h.
  if (SONDAR) {
    timers.push(setInterval(() => sondarModelos('a cada 6 h'), MS_MODELOS_CICLO));
    setTimeout(() => sondarModelos('subida'), MS_MODELOS_INICIO).unref?.();
  }
  for (const t of timers) t.unref?.();
  setTimeout(() => lerRegistro().catch(() => {}), 200).unref?.();
  // Subida do servidor: se o motor.json aponta para um motor vivo, conecta e adota as instâncias dele.
  // Só depois que ESTE processo ganhou a porta: um segundo servidor na mesma pasta (corrida do hook)
  // sai com EADDRINUSE, mas antes tomaria a conexão do motor do servidor de verdade.
  // Etapa 4: depois da adoção (ou sem motor vivo: reinício do PC), os registros que ficaram sem processo
  // dormem com motivo 'reinicio'. Também só com a porta ganha: o servidor que perdeu a corrida não mexe no
  // instancias.json.
  // O servidor só faz o listen depois de outros import() (o setTimeout abaixo roda antes dele): enquanto a
  // adoção não acaba, o HTTP já responde. Nessa janela, as rotas POST esperam (adocaoPendente/esperarAdocao):
  // sem isso, um POST /instancias caía no meio do reconciliar e uma ação numa sessão viva no motor a
  // "acordava" com um segundo processo.
  setTimeout(async () => {
    let nossa = false;
    try {
      if (!(await portaEhNossa())) return;
      nossa = true;
      const info = lerInfoMotor();
      if (USAR_MOTOR && info && vivo(Number(info.pid)) && (await motor.garantir(false))) await reconciliar();
    } catch (e) {
      log('motor', `adoção: ${e.message}`);
    } finally {
      if (nossa) depoisDaAdocao();
      adocaoPendente = false;
      fimAdocao();
    }
  }, 0);
  timers.push(setInterval(tiqueDormir, MS_TIQUE_DORMIR), setInterval(lerMemoria, MS_MEMORIA), setInterval(tiqueAuto, MS_TIQUE_AUTO));
  for (const t of timers) t.unref?.();

  // ── rotas ──
  const RE_ROTA = /^\/sessao\/([^/]+)\/(conversa|conversa\/fluxo|acoes|comandos|mensagem|compactar|limpar|assumir|devolver|permissao|modelo|esforco|parar|modo|encerrar|retomar|imagem|autocompactar)$/;
  const GETS = new Set(['conversa', 'conversa/fluxo', 'acoes', 'comandos', 'imagem']);

  function exigirOrbit(id) {
    const p = procs.get(id);
    if (!p) throw erroHttp(409, 'A sessão não está no Orbit. Assuma no Orbit para fazer isso sem abrir o VS Code.', 'nao_assumida');
    if (p.iniciando) throw erroHttp(409, 'O Orbit ainda está iniciando a sessão.', 'ocupada');
    return p;
  }
  function exigirLivre(p) {
    if (p.ocupada || p.permissoes.length) throw erroHttp(409, 'A sessão está trabalhando; espere a volta terminar.', 'ocupada');
  }
  // limite: o da mensagem e da nova instância cresce por causa das imagens (o padrão do servidor é 256 KB).
  async function corpo(req, limite) {
    const b = await lerJSONCorpo(req, limite).catch((e) => {
      throw e.status === 413 && limite ? erroHttp(413, 'As imagens passam do tamanho que o Orbit aceita. Mande menos imagens por vez.') : e;
    });
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw erroHttp(400, 'corpo inválido');
    return b;
  }

  // Etapa 2: GET /modelos e POST /instancias.
  async function rotaGeral(req, res, caminho) {
    // Etapa 4: GET /instancias → {max, vivas, dormindo, memoria, dormirApos}; POST /instancias cria.
    if (caminho === '/instancias' && req.method === 'GET') return responder(res, 200, resumoInstancias());
    const ehGet = caminho === '/modelos';
    if ((req.method === 'GET') !== ehGet) return responder(res, 405, { erro: 'método não permitido' });
    try {
      if (ehGet) {
        if (!modelos) {
          sondarModelos('pedido');
          return responder(res, 503, { erro: 'Os modelos ainda não foram lidos. Tente de novo em alguns segundos.' });
        }
        return responder(res, 200, modelos);
      }
      responder(res, 202, await criarInstancia(await corpo(req, MAX_CORPO_IMAGENS)));
    } catch (e) {
      if (!e.status) throw e;
      responder(res, e.status, e.codigo ? { erro: e.message, codigo: e.codigo } : { erro: e.message });
    }
  }

  async function rota(req, res, caminho, url) {
    // Logo depois da subida: ação só depois da adoção das instâncias do motor (no máximo MS_ADOCAO).
    if (req.method !== 'GET' && adocaoPendente && (caminho === '/instancias' || RE_ROTA.test(caminho))) await esperarAdocao();
    if (caminho === '/modelos' || caminho === '/instancias') {
      await rotaGeral(req, res, caminho);
      return true;
    }
    const m = RE_ROTA.exec(caminho);
    if (!m) return false;
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      responder(res, 400, { erro: 'id inválido' });
      return true;
    }
    const acao = m[2];
    const ehGet = GETS.has(acao);
    if ((req.method === 'GET') !== ehGet) {
      responder(res, 405, { erro: 'método não permitido' });
      return true;
    }
    // Celular (revisão P1-1): o remoto só alcança instâncias nativas vivas no controle. Nunca o canal do VS Code
    // (mensagem sem processo nem registro) nem uma nativa devolvida/reaberta fora do Orbit.
    if (res._remoto && origemDe(id) !== 'orbit') {
      responder(res, 404, { erro: 'sessão não encontrada' });
      return true;
    }
    const s = obterSessao(id);
    if (!s && !procs.has(id) && !regs.has(id)) {
      responder(res, 404, { erro: 'sessão não encontrada' });
      return true;
    }
    try {
      await tratar(req, res, url, id, s || { id, cwd: procs.get(id)?.cwd || regs.get(id)?.cwd }, acao);
    } catch (e) {
      if (!e.status) throw e;
      responder(res, e.status, e.codigo ? { erro: e.message, codigo: e.codigo } : { erro: e.message });
    }
    return true;
  }

  async function tratar(req, res, url, id, s, acao) {
    if (acao === 'conversa') {
      const q = url.searchParams;
      let limite = LIMITE_PADRAO;
      if (q.has('limite')) {
        limite = Number(q.get('limite'));
        if (!Number.isInteger(limite) || limite < 1) throw erroHttp(400, 'limite inválido');
        limite = Math.min(limite, LIMITE_MAX);
      }
      let antes = null;
      if (q.has('antes') && q.get('antes') !== '') {
        antes = Number(q.get('antes'));
        if (!Number.isInteger(antes) || antes < 0) throw erroHttp(400, 'cursor inválido');
      }
      const c = await acharTranscript(id);
      if (!c) return responder(res, 200, { itens: [], cursorAntigo: null });
      const conv = await lerConversa(c, antes, limite);
      marcarAuto(id, conv.itens || []); // 20/10: compactação automática
      return responder(res, 200, conv);
    }
    if (acao === 'conversa/fluxo') {
      const d = url.searchParams.get('desde');
      const desde = d != null && /^\d+$/.test(d) ? Number(d) : null;
      return abrirFluxo(req, res, id, desde);
    }
    if (acao === 'acoes') return responder(res, 200, (acoes.get(id) || []).slice(-MAX_ACOES));
    // Dormindo (sem processo): a lista do último processo que subiu; null = ainda nenhum subiu.
    if (acao === 'comandos') return responder(res, 200, { comandos: procs.get(id)?.comandos || comandosConhecidos || null });

    if (acao === 'imagem') {
      const q = url.searchParams;
      const o = Number(q.get('o'));
      const i = Number(q.get('i'));
      if (!q.get('o') || !Number.isInteger(o) || o < 0 || !q.get('i') || !Number.isInteger(i) || i < 0 || i > 1000) throw erroHttp(400, 'referência de imagem inválida');
      const c = await acharTranscript(id);
      const img = c && (await lerImagem(c, o, i));
      if (!img) throw erroHttp(404, 'imagem não encontrada');
      res.writeHead(200, { 'content-type': img.tipo, 'content-length': img.dados.length, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(img.dados);
    }

    const b = await corpo(req, acao === 'mensagem' ? MAX_CORPO_IMAGENS : undefined);
    if (acao === 'mensagem') {
      const texto = typeof b.texto === 'string' ? b.texto : '';
      const imagens = blocosDeImagens(b.imagens);
      if ((!texto.trim() && !imagens.length) || texto.length > MAX_TEXTO) throw erroHttp(400, `texto deve ter de 1 a ${MAX_TEXTO} caracteres`);
      if (b.prioridade !== undefined && b.prioridade !== 'next' && b.prioridade !== 'now') throw erroHttp(400, "prioridade deve ser 'next' ou 'now'");
      const p = procs.get(id);
      if (p && !p.acordando) {
        if (p.iniciando) throw erroHttp(409, 'O Orbit ainda está iniciando a sessão.', 'ocupada');
        return responder(res, 202, { acao: mensagemOrbit(p, texto, b.prioridade, undefined, imagens) });
      }
      // Etapa 4: dormindo (ou acordando) → acorda e manda.
      if (p || regs.has(id)) {
        if (!p) checarVaga();
        const a = novaAcao(id, 'mensagem', 'orbit');
        acordarE(id, a, (q) => mensagemOrbit(q, texto, b.prioridade, a, imagens));
        return responder(res, 202, { acao: a });
      }
      // O canal (sessão aberta no VS Code) só leva texto: imagens exigem a sessão no Orbit.
      if (imagens.length) throw erroHttp(409, 'Imagens só vão para sessões no Orbit. Assuma a sessão no Orbit para enviar imagens.', 'nao_assumida');
      registros = await lerRegistros();
      const r = regVivo(id);
      if (!r || !r.socket || !r.temChave) throw erroHttp(409, 'Sem processo vivo nem canal: assuma no Orbit para conversar.', 'nao_assumida');
      const t = await acharTranscript(id);
      if (!t) throw erroHttp(409, 'Sem o transcript da sessão, não dá para confirmar a entrega.', 'sem_transcript');
      return responder(res, 202, { acao: mensagemCanal(s, r, texto, b.prioridade, t) });
    }
    if (acao === 'compactar') {
      if (b.foco !== undefined && b.foco !== null && (typeof b.foco !== 'string' || b.foco.length > MAX_FOCO)) throw erroHttp(400, `foco deve ser texto de até ${MAX_FOCO} caracteres`);
      const foco = String(b.foco || '').replace(/\s+/g, ' ').trim();
      if (adormecida(id)) return responder(res, 202, { acao: acordarPara(id, 'compactar', (q, a) => compactar(q, foco, a)) });
      const p = exigirOrbit(id);
      exigirLivre(p);
      return responder(res, 202, { acao: compactar(p, foco) });
    }
    // 20/10: compactação automática desta instância: true/false sobrepõe a config; null volta a seguir a config.
    if (acao === 'autocompactar') {
      if (b.ativo !== true && b.ativo !== false && b.ativo !== null) throw erroHttp(400, 'ativo deve ser true, false ou null');
      const rg = regs.get(id);
      if (!rg) throw erroHttp(409, 'A compactação automática vale só para instâncias do Orbit. Assuma a sessão no Orbit primeiro.', 'nao_assumida');
      if (b.ativo === null) delete rg.autoCompactar;
      else rg.autoCompactar = b.ativo;
      salvarRegs();
      const p = procs.get(id);
      if (p && !p.acordando) {
        if (autoLigada(id)) marcarAutoCompactar(p);
        else p.autoPendente = null;
      }
      avisar(id);
      return responder(res, 200, { autoCompactar: infoAuto(id, p) });
    }
    if (acao === 'limpar') {
      if (b.confirmar !== true) throw erroHttp(400, 'limpar exige {confirmar: true}');
      if (adormecida(id)) return responder(res, 202, { acao: acordarPara(id, 'limpar', (q, a) => limpar(q, a)) });
      const p = exigirOrbit(id);
      exigirLivre(p);
      return responder(res, 202, { acao: limpar(p) });
    }
    // Etapa 4: encerrar (dormir com motivo 'manual') e retomar.
    if (acao === 'encerrar') return responder(res, 202, { acao: encerrar(id, b.forcar === true, 'encerrar') });
    if (acao === 'retomar') {
      const p = procs.get(id);
      if (p && !p.acordando) throw erroHttp(409, 'A instância já está viva.', 'viva');
      if (!p && !regs.has(id)) throw erroHttp(409, 'A sessão não está no Orbit.', 'nao_assumida');
      if (p) throw erroHttp(409, 'A instância já está acordando.', 'viva');
      checarVaga();
      const a = novaAcao(id, 'retomar', 'orbit');
      acordarE(id, a, () => concluir(a));
      return responder(res, 202, { acao: a });
    }
    if (acao === 'assumir') {
      registros = await lerRegistros();
      if (!transcriptConhecido(id, s)) await procurarTranscript(id);
      const motivo = motivoParaNaoAssumir(s);
      if (motivo) throw erroHttp(409, motivo.erro, motivo.codigo);
      const a = novaAcao(id, 'assumir', 'orbit');
      responder(res, 202, { acao: a });
      assumir(s, a).catch((e) => falhar(a, e.message));
      return;
    }
    if (acao === 'devolver') {
      const p = procs.get(id);
      const rg = regs.get(id);
      // Etapa 4: na instância criada pelo Orbit, Devolver = encerrar (dorme; continua do Orbit).
      if ((p?.origem || rg?.origem) === 'orbit') return responder(res, 202, { acao: encerrar(id, b.forcar === true, 'devolver') });
      if (!p && rg) {
        // Assumida e dormindo: só larga o registro (não há processo para fechar).
        regs.delete(id);
        salvarRegs();
        const a = novaAcao(id, 'devolver', 'orbit');
        concluir(a);
        avisar(id);
        difundirInstancias();
        return responder(res, 202, { acao: a });
      }
      if (!p) throw erroHttp(409, 'A sessão não está no Orbit.', 'nao_assumida');
      if (p.iniciando) throw erroHttp(409, 'O Orbit ainda está iniciando a sessão.', 'ocupada');
      exigirLivre(p);
      return responder(res, 202, { acao: devolver(p) });
    }
    if (acao === 'permissao') {
      if (typeof b.id !== 'string' || !b.id) throw erroHttp(400, 'id ausente');
      if (b.decisao !== 'permitir' && b.decisao !== 'negar') throw erroHttp(400, "decisao deve ser 'permitir' ou 'negar'");
      const p = procs.get(id);
      if (!p && regs.has(id)) throw erroHttp(404, 'pedido de permissão não encontrado (a instância está dormindo)');
      if (!p) throw erroHttp(409, 'A sessão não está no Orbit.', 'nao_assumida');
      permissao(p, b, !!res._remoto);
      return responder(res, 200, { ok: true });
    }
    // Etapa 3: parar a volta e trocar o modo de permissão.
    if (acao === 'parar') {
      const p = procs.get(id);
      if (!p && !regs.has(id)) throw erroHttp(409, 'O Orbit não controla esta sessão; pare a volta pelo VS Code.', 'nao_assumida');
      if (!p || p.iniciando || (!p.ocupada && !p.permissoes.length)) throw erroHttp(409, 'A sessão já está parada: não há volta em andamento.', 'parada');
      return responder(res, 202, { acao: parar(p) });
    }
    // Etapa 4: dormindo, modo/modelo/esforço validam, vão para o registro e valem ao acordar (pendente).
    if (!procs.has(id) && regs.has(id) && (acao === 'modo' || acao === 'modelo' || acao === 'esforco')) return responder(res, 200, ajustePendente(id, acao, b));
    if (acao === 'modo') return responder(res, 200, await trocarModo(exigirOrbit(id), b));
    // Etapa 2: valem a partir da próxima resposta, inclusive com a volta em andamento (sem exigirLivre).
    if (acao === 'modelo') return responder(res, 200, await trocarModelo(exigirOrbit(id), b));
    if (acao === 'esforco') return responder(res, 200, await trocarEsforco(exigirOrbit(id), b));
  }

  // ── etapa 4: ações com a instância dormindo ──
  const adormecida = (id) => (!procs.has(id) && regs.has(id)) || !!procs.get(id)?.acordando;
  // Acorda e faz (compactar, limpar): a sessão recém-acordada está livre.
  function acordarPara(id, tipo, fazer) {
    if (!procs.has(id)) checarVaga();
    const a = novaAcao(id, tipo, 'orbit');
    acordarE(id, a, (q) => {
      if (q.ocupada || q.permissoes.length) return falhar(a, 'A sessão está trabalhando; espere a volta terminar.');
      fazer(q, a);
    });
    return a;
  }
  function ajustePendente(id, acao, b) {
    const rg = regs.get(id);
    if (acao === 'modo') {
      const modo = typeof b.modo === 'string' ? b.modo : '';
      if (!PERMISSOES.includes(modo)) throw erroHttp(400, `Modo de permissão inválido: ${encurtar(modo || '(vazio)', 40)}. Use: ${PERMISSOES.join(', ')}.`);
      rg.modoPermissao = modo;
    } else {
      exigirModelos();
      if (acao === 'modelo') {
        const v = typeof b.modelo === 'string' ? b.modelo.trim() : '';
        if (!v) throw erroHttp(400, 'Escolha o modelo.');
        const m = acharModelo(v);
        if (!m) throw erroHttp(400, `Modelo desconhecido: ${encurtar(v, 100)}.`);
        rg.modelo = m.valor;
        if (rg.esforco && !m.esforcos.includes(rg.esforco)) rg.esforco = ''; // o claude ignoraria; vale o padrão do modelo
      } else {
        const e = typeof b.esforco === 'string' ? b.esforco.trim() : '';
        const m = acharModelo(rg.modelo) || acharModelo('default');
        if (!m) throw erroHttp(400, 'Não sei qual é o modelo desta sessão para validar o esforço.');
        if (!m.esforcos.length) throw erroHttp(400, `${m.nome} não tem nível de esforço.`);
        if (!m.esforcos.includes(e)) throw erroHttp(400, `${m.nome} não aceita o esforço "${encurtar(e, 20) || '(vazio)'}". Use: ${m.esforcos.join(', ')}.`);
        rg.esforco = e;
      }
    }
    salvarRegs();
    avisar(id);
    return acao === 'modo' ? { modo: rg.modoPermissao, pendente: true } : { modelo: rg.modelo || null, esforco: rg.esforco || null, pendente: true };
  }
  // POST /encerrar (e Devolver da instância criada pelo Orbit): dorme com motivo 'manual'. Ocupada (volta,
  // tarefa ou permissão) → 409 sem `forcar`; com `forcar`, interrupt e depois fechar.
  function encerrar(id, forcar, rotulo) {
    const p = procs.get(id);
    if (!p && regs.has(id)) throw erroHttp(409, 'A instância já está dormindo.', 'dormindo');
    if (!p) throw erroHttp(409, 'A sessão não está no Orbit.', 'nao_assumida');
    if (p.iniciando) throw erroHttp(409, 'O Orbit ainda está iniciando a instância.', 'ocupada');
    const motivos = [p.ocupada || p.permissoes.length ? 'respondendo' : '', p.tarefas.length ? 'com tarefas em segundo plano' : ''].filter(Boolean);
    if (motivos.length && !forcar) throw erroHttp(409, `A instância está ${motivos.join(' e ')}. Confirme para interromper e encerrar.`, 'ocupada');
    const a = novaAcao(id, 'encerrar', 'orbit');
    const emVolta = p.ocupada || p.permissoes.length;
    etapa(a, emVolta ? 'Interrompendo a resposta' : 'Fechando o processo');
    (async () => {
      if (emVolta) {
        await interromperEsperar(p);
        etapa(a, 'Fechando o processo');
      }
      await adormecer(p, 'manual');
      if (p.saiu) concluir(a);
      else falhar(a, `O processo ${p.pid} não terminou.`);
    })().catch((e) => falhar(a, e.message));
    return a;
  }
  // Interrompe a volta e espera o result (no máximo 10 s).
  async function interromperEsperar(p) {
    const fim = new Promise((r) => {
      const ouvir = (j) => j.type === 'result' && (p.ouvintes.delete(ouvir), r());
      p.ouvintes.add(ouvir);
      setTimeout(() => (p.ouvintes.delete(ouvir), r()), 10e3).unref?.();
    });
    await pedirControle(p, { subtype: 'interrupt' }, MS_AJUSTE).catch(() => {});
    await fim;
  }

  // ── conta do Claude (19/10): antes de sair ou trocar de conta ──
  // As vivas, para o aviso do menu de perfil (ocupada = respondendo, pedindo permissão ou com tarefas).
  function vivasConta() {
    return [...procs.values()].filter((p) => !p.saiu).map((p) => ({ id: p.id, ocupada: !!(p.ocupada || p.permissoes.length || p.tarefas.length || p.iniciando) }));
  }
  // Dormindo pela troca de conta: voltam sozinhas depois do novo login (o motivo fica no instancias.json).
  const pausadasConta = () => [...regs.entries()].filter(([id, r]) => !procs.has(id) && r.dormiu?.motivo === 'conta').map(([id]) => id);
  // Todas as vivas dormem (motivo 'conta'); a que está respondendo é interrompida antes. Espera a que está
  // iniciando ou acordando (no máximo msMax). Devolve as que dormiram e as que não.
  async function pausarConta(msMax = 20e3) {
    const alvos = [...procs.values()].filter((p) => !p.saiu);
    const fim = Date.now() + msMax;
    await Promise.all(alvos.map(async (p) => {
      while ((p.iniciando || p.acordando) && !p.saiu && Date.now() < fim) await dormir(200);
      if (p.saiu) return;
      if (p.ocupada || p.permissoes.length) await interromperEsperar(p);
      await adormecer(p, 'conta');
    }));
    if (alvos.length) log('controle', `conta do Claude: ${alvos.filter((p) => p.saiu).length} de ${alvos.length} instância(s) pausada(s)`);
    return { pausadas: alvos.filter((p) => p.saiu).map((p) => p.id), falharam: alvos.filter((p) => !p.saiu).map((p) => p.id) };
  }
  // Depois do novo login: acorda as pausadas pela conta (cada uma vira uma ação 'retomar'); sem vaga, fica dormindo.
  function retomarConta() {
    const ids = [];
    for (const id of pausadasConta()) {
      try {
        checarVaga();
        const a = novaAcao(id, 'retomar', 'orbit');
        acordarE(id, a, () => concluir(a));
        ids.push(id);
      } catch (e) {
        log('controle', `conta do Claude: a instância ${id} segue dormindo (${e.message})`);
      }
    }
    return ids;
  }

  // Desligar o servidor: os processos do motor seguem vivos (só a conexão fecha; o próximo servidor os
  // adota). Os filhos diretos (sem motor) recebem EOF no stdin, como antes (o claude -p sai sozinho).
  // O Devolver continua fechando o processo de verdade.
  function encerrarTudo() {
    if (regsTm) gravarRegs(); // etapa 4: o instancias.json sai em dia
    for (const p of procs.values()) if (p.io?.via === 'direto') p.io.fechar();
    motor.fechar();
    for (const f of fluxos)
      try {
        f.res.end();
      } catch {}
  }

  // Reinício pelas Configurações (reinicio.mjs): o que um desligamento agora interromperia. As do motor
  // seguem vivas, menos a que ainda não respondeu ao initialize (a adotada nesse estado é encerrada) e as
  // ações que mexem em processo (assumir, devolver, criar…). A mensagem em curso não conta: ela já foi
  // entregue ao processo, e só o acompanhamento se perde.
  function bloqueiosReinicio() {
    const r = { motor: 0, direto: 0, iniciando: 0, acoes: [] };
    for (const p of procs.values()) {
      if (p.saiu) continue;
      if (p.io?.via === 'direto') r.direto++;
      else if (p.io?.via === 'motor') {
        r.motor++;
        if (p.iniciando) r.iniciando++;
      } else r.iniciando++; // ainda subindo (sem io)
    }
    for (const l of acoes.values()) for (const a of l) if (a.estado === 'em_andamento' && a.tipo !== 'mensagem') r.acoes.push(a.tipo);
    return r;
  }

  // Celular (remoto.mjs): 'orbit' (criada pelo Orbit: POST /instancias, persistido no instancias.json),
  // 'assumir' (assumida do VS Code/terminal) ou null (o controle não conhece a sessão, ou está devolvendo).
  // Com processo, vale só ele (o registro antigo não ressuscita a marca); sem processo, o registro (dormindo).
  const origem = origemDe;
  return { rota, estado, origem, avisarLider, encerrarTudo, encerrarProcessoAntigo, esquecer, dormindo, bloqueiosReinicio, sondarSkills, sondarMcp, vivasConta, pausadasConta, pausarConta, retomarConta, _procs: procs };
}
