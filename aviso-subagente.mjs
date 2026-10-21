// Orbit — aviso ao subagente que passou do limite de contexto, e ao líder dele (camada 2).
// Hook SÍNCRONO de PostToolUse, à parte do hook.mjs. Os do hook.mjs são assíncronos, e a saída de um hook
// assíncrono vai para a sessão principal, não para o subagente; a de um síncrono fica só no subagente que
// rodou a ferramenta. Vale para qualquer projeto: é opcional e só entra no settings global com a permissão do
// usuário (node instalar.mjs --aviso-subagente; o assistente da primeira vez pergunta).
// - Evento de um subagente (agent_id): lê o fim do transcript dele, soma o contexto da última resposta e, acima
//   do limite (config.instancias.autoCompactar.limite, o mesmo da compactação automática), devolve UMA vez o
//   aviso como additionalContext. A entrega fica marcada em <dados>/avisos-subagentes/<agent_id>: o servidor só
//   avisa o líder pela conversa (camada 3) quando a marca não aparece.
// - Evento do líder (sem agent_id) com a resposta da ferramenta Agent/Task trazendo "PRECISA_SUBSTITUIR": explica
//   ao líder o que fazer (encerrar o subagente e criar outro a partir do arquivo de progresso), mesmo sem a skill
//   liderar-time instalada.
// Os arquivos de progresso ficam em <dados>/progresso/<nome da pasta do projeto>/, nunca no projeto do usuário.
// Nunca falha: erro → sai 0 calado.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const DADOS = path.resolve(process.env.GERENCIADOR_DADOS || PASTA);
export const PASTA_AVISOS = path.join(DADOS, 'avisos-subagentes');
export const PASTA_PROGRESSO = path.join(DADOS, 'progresso');
const FERRAMENTAS_AGENTE = new Set(['Agent', 'Task']);

// Pasta de progresso de um projeto: <dados>/progresso/<nome da pasta do projeto> (só caracteres seguros).
export function nomeDoProjeto(cwd) {
  const n = path.basename(path.resolve(String(cwd || ''))).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '');
  return n.slice(0, 80) || 'projeto';
}
export const pastaDeProgresso = (cwd, dados = DADOS) => path.join(dados, 'progresso', nomeDoProjeto(cwd));
// Os mesmos números do controle.mjs (AUTO_COMPACTAR_PADRAO.limite, LIMITE_AUTO_MIN/MAX; o teste confere).
// Cópia aqui para o hook não carregar o controle.mjs a cada ferramenta.
export const LIMITE_PADRAO = 140000;
export const LIMITE_MIN = 20000;
export const LIMITE_MAX = 2000000;
const CAUDA = 256 * 1024;

function lerStdin() {
  return new Promise((resolve) => {
    const partes = [];
    const fim = () => resolve(Buffer.concat(partes).toString('utf8'));
    process.stdin.on('data', (c) => partes.push(c));
    process.stdin.on('end', fim);
    process.stdin.on('error', fim);
    setTimeout(fim, 2000).unref();
  });
}

export function limiteDaConfig(dados = DADOS) {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(dados, 'config.json'), 'utf8'))?.instancias?.autoCompactar?.limite;
    return Number.isInteger(l) && l >= LIMITE_MIN && l <= LIMITE_MAX ? l : LIMITE_PADRAO;
  } catch {
    return LIMITE_PADRAO;
  }
}

export function arquivoDoSubagente(ev) {
  if (typeof ev.agent_transcript_path === 'string' && /\.jsonl$/i.test(ev.agent_transcript_path)) return ev.agent_transcript_path;
  if (typeof ev.transcript_path !== 'string' || !/\.jsonl$/i.test(ev.transcript_path)) return '';
  return path.join(ev.transcript_path.replace(/\.jsonl$/i, ''), 'subagents', `agent-${ev.agent_id}.jsonl`);
}

// Contexto da última resposta do modelo no fim do arquivo (entrada + cache lido + cache gravado).
export function contextoDaCauda(texto) {
  const linhas = texto.split('\n');
  for (let i = linhas.length - 1; i >= 0; i--) {
    const l = linhas[i];
    if (!l.includes('"type":"assistant"') || !l.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const u = e?.message?.usage;
    if (!u || e.message.model === '<synthetic>') continue;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tokens > 0) return tokens;
  }
  return 0;
}

function lerCauda(arq) {
  const fd = fs.openSync(arq, 'r');
  try {
    const tam = fs.fstatSync(fd).size;
    const n = Math.min(tam, CAUDA);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, tam - n);
    const t = buf.toString('utf8');
    return n < tam ? t.slice(t.indexOf('\n') + 1) : t;
  } finally {
    fs.closeSync(fd);
  }
}

const mil = (n) => Math.round(n / 1000);

export function textoDoAviso(tokens, limite) {
  return (
    `Aviso do Orbit: o seu contexto está em ${mil(tokens)} mil tokens, acima do limite de ${mil(limite)} mil por subagente. ` +
    'Não comece nada novo. Agora: 1) atualize o arquivo de progresso que o líder indicou (objetivo, critério de pronto, feito, falta, decisões); ' +
    'se ele não indicou nenhum, não crie pastas: ponha esse resumo na própria resposta; 2) encerre devolvendo ao líder, em até 5 linhas, a linha ' +
    '"PRECISA_SUBSTITUIR: <caminho do arquivo de progresso>" e o que falta. O líder cria um subagente novo a partir desse arquivo.'
  );
}

// O que o líder faz quando um subagente devolve "PRECISA_SUBSTITUIR: <arquivo>".
export function textoDoAvisoLider(arquivo, limite) {
  const arq = arquivo ? `o arquivo de progresso ${arquivo}` : 'o resumo que ele deixou na resposta';
  return (
    `Aviso do Orbit: o subagente que acabou de responder passou do limite de ${mil(limite)} mil tokens de contexto e pediu para ser substituído. ` +
    `Não continue com ele (nada de SendMessage para ele): crie um subagente novo, com a mesma tarefa, e peça que leia só ${arq} antes de continuar, ` +
    'sem reler a conversa nem o código já analisado. Quando a tarefa terminar, apague o arquivo de progresso.'
  );
}

// Resposta da ferramenta Agent/Task com "PRECISA_SUBSTITUIR": o texto para o líder (ou '').
export function avaliarLider(ev, o = {}) {
  if (!FERRAMENTAS_AGENTE.has(ev.tool_name) || ev.agent_id) return '';
  let txt = '';
  try { txt = typeof ev.tool_response === 'string' ? ev.tool_response : JSON.stringify(ev.tool_response ?? ''); } catch { return ''; }
  const m = /PRECISA_SUBSTITUIR:?\s*([^\n"<>|]*)/.exec(txt.replace(/\\n/g, '\n'));
  if (!m) return '';
  const arquivo = m[1].replace(/\\\\/g, '\\').trim().replace(/[.,;]+$/, '').slice(0, 400);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: textoDoAvisoLider(arquivo, limiteDaConfig(o.dados || DADOS)) } });
}

// Devolve o JSON do hook (texto) ou '' quando não há nada a dizer. `o.dados` só nos testes.
export function avaliar(ev, o = {}) {
  if (!ev || typeof ev !== 'object' || ev.hook_event_name !== 'PostToolUse') return '';
  if (!ev.agent_id) return avaliarLider(ev, o);
  if (typeof ev.agent_id !== 'string' || !/^[\w-]{1,100}$/.test(ev.agent_id)) return '';
  const dados = o.dados || DADOS;
  const pasta = path.join(dados, 'avisos-subagentes');
  const marca = path.join(pasta, ev.agent_id);
  if (fs.existsSync(marca)) return ''; // já avisado: uma vez só
  const arq = arquivoDoSubagente(ev);
  if (!arq) return '';
  const tokens = contextoDaCauda(lerCauda(arq));
  const limite = limiteDaConfig(dados);
  if (!(tokens > limite)) return '';
  fs.mkdirSync(pasta, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(marca, 'wx'); // outro hook paralelo já marcou: ele avisa
  } catch {
    return '';
  }
  try {
    fs.writeSync(fd, JSON.stringify({ ts: Date.now(), sessao: String(ev.session_id || '').slice(0, 100), tokens, limite }));
  } finally {
    fs.closeSync(fd);
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: textoDoAviso(tokens, limite) } });
}

const real = (f) => {
  try { return fs.realpathSync(f).toLowerCase(); } catch { return path.resolve(f).toLowerCase(); }
};

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    const bruto = await lerStdin();
    // Atalho: sem agent_id nem PRECISA_SUBSTITUIR no texto, nem faz o parse (a grande maioria das chamadas).
    if (bruto.includes('"agent_id"') || bruto.includes('PRECISA_SUBSTITUIR')) {
      const saida = avaliar(JSON.parse(bruto));
      if (saida) process.stdout.write(saida + '\n');
    }
  } catch {}
  process.exit(0);
}
