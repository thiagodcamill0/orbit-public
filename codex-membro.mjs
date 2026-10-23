#!/usr/bin/env node
// Orbit — CLI para o líder (uma sessão do Claude) usar o Codex como MEMBRO do time, pelo Bash.
//   node codex-membro.mjs criar --pasta <p> [--nome n] [--modelo m] [--esforco e] [--avisar] "<texto>"
//   node codex-membro.mjs enviar <id> "<texto>"
//   node codex-membro.mjs esperar <id> [--max segundos]
//   node codex-membro.mjs estado <id>
// Fala com http://127.0.0.1:${GERENCIADOR_PORTA || 47821}. O líder (pai) é process.env.ORBIT_SESSAO (ou CLAUDE_CODE_HOST_SESSION_ID).
// Só Node, sem dependências. Saída: 0 ok; 1 erro de uso/servidor; 2 o membro deu erro/foi interrompido;
// 3 o membro espera uma permissão no Orbit; 4 tempo esgotado.
const PORTA = Number(process.env.GERENCIADOR_PORTA) || 47821;
const BASE = `http://127.0.0.1:${PORTA}`;
const MAX_PADRAO_S = 600;
const FIM_RUIM = new Set(['erro', 'interrompida']);

class Falha extends Error { constructor(msg, codigo = 1) { super(msg); this.codigo = codigo; } }

async function chamar(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(BASE + caminho, {
      method: metodo,
      headers: { 'x-gerenciador': '1', ...(corpo ? { 'content-type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Falha(`Não consegui falar com o Orbit em ${BASE}. Ele está aberto?`);
  }
  let dados = null;
  try { dados = await r.json(); } catch { /* sem corpo JSON */ }
  if (r.ok) return dados;
  const erro = dados?.erro ? String(dados.erro) : `erro ${r.status}`;
  if (r.status === 404 && !/sess[ãa]o/i.test(erro)) throw new Falha('Codex desligado no Orbit (ligue em Configurações > Codex).');
  throw new Falha(erro);
}

function lerArgs(argv) {
  const opc = {}, pos = [];
  const comValor = new Set(['pasta', 'nome', 'modelo', 'esforco', 'max']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (comValor.has(k)) {
        if (i + 1 >= argv.length) throw new Falha(`Falta o valor de --${k}.`);
        opc[k] = argv[++i];
      } else if (k === 'avisar') opc.avisar = true;
      else throw new Falha(`Opção desconhecida: ${a}`);
    } else pos.push(a);
  }
  return { opc, pos };
}

async function textoDe(pos) {
  let t = pos.join(' ');
  if (t === '-') { // texto pelo stdin
    const partes = [];
    for await (const p of process.stdin) partes.push(p);
    t = Buffer.concat(partes).toString('utf8');
  }
  return t;
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const resumo = (s) => ({
  id: s.id, status: s.status, pai: s.pai || null, ocupada: !!s.controle?.ocupada, processo: s.controle?.processo || null,
  modelo: s.modelo || '', motivo: s.status === 'erro' || s.status === 'interrompida' || s.status === 'aguardando' ? (s.detalhe || s.registro?.waitingFor || '') : '',
  resposta: s.ultimaResposta || '', subagentes: s.subagentes || 0,
});

async function achar(id) {
  if (!id) throw new Falha('Informe o id do membro.');
  const e = await chamar('GET', '/estado');
  const s = (e?.sessoes || []).find((x) => x.id === id);
  if (!s || s.provedor !== 'codex') throw new Falha('Membro não encontrado (o id é de uma sessão do Codex?).');
  return s;
}

async function criar(argv) {
  const { opc, pos } = lerArgs(argv);
  const pai = process.env.ORBIT_SESSAO || process.env.CLAUDE_CODE_HOST_SESSION_ID;
  if (!pai) throw new Falha('Sem ORBIT_SESSAO nem CLAUDE_CODE_HOST_SESSION_ID: só uma sessão do Claude pode ser líder de um membro Codex.');
  if (!opc.pasta) throw new Falha('Informe a pasta com --pasta <caminho>.');
  const texto = await textoDe(pos);
  const corpo = { pasta: opc.pasta, pai };
  for (const k of ['nome', 'modelo', 'esforco']) if (opc[k]) corpo[k] = opc[k];
  if (opc.avisar) corpo.avisarLider = true;
  if (texto.trim()) corpo.texto = texto;
  const r = await chamar('POST', '/codex/instancias', corpo);
  console.log(`Membro Codex criado. id: ${r.sessao}`);
}

async function enviar(argv) {
  const { pos } = lerArgs(argv);
  const [id, ...resto] = pos;
  if (!id) throw new Falha('Informe o id do membro.');
  const texto = await textoDe(resto);
  if (!texto.trim()) throw new Falha('Informe o texto a enviar.');
  await chamar('POST', `/codex/sessao/${encodeURIComponent(id)}/mensagem`, { texto });
  console.log('Mensagem enviada.');
}

async function esperar(argv) {
  const { opc, pos } = lerArgs(argv);
  const id = pos[0];
  const max = opc.max == null ? MAX_PADRAO_S : Number(opc.max);
  if (!Number.isFinite(max) || max <= 0) throw new Falha('--max deve ser um número de segundos maior que zero.');
  const limite = Date.now() + max * 1000;
  for (;;) {
    const r = resumo(await achar(id));
    if (r.status === 'aguardando' && !r.ocupada) {
      console.error(`O membro espera uma permissão no Orbit${r.motivo ? ': ' + r.motivo : ''}.`);
      process.exitCode = 3; return;
    }
    if (!r.ocupada && r.status !== 'trabalhando') {
      if (FIM_RUIM.has(r.status)) { console.error(`O membro ${r.status === 'erro' ? 'deu erro' : 'foi interrompido'}${r.motivo ? ': ' + r.motivo : '.'}`); process.exitCode = 2; return; }
      console.log(r.resposta || '(o membro não deixou resposta)');
      return;
    }
    if (Date.now() >= limite) throw new Falha(`O membro ainda trabalha após ${max} s.`, 4);
    await pausa(1000);
  }
}

async function estado(argv) {
  const { pos } = lerArgs(argv);
  const r = resumo(await achar(pos[0]));
  console.log(`status: ${r.status}${r.ocupada ? ' (ocupado)' : ''}`);
  console.log(`líder: ${r.pai || '-'}`);
  if (r.modelo) console.log(`modelo: ${r.modelo}`);
  if (r.subagentes) console.log(`subagentes ativos: ${r.subagentes}`);
  if (r.motivo) console.log(`motivo: ${r.motivo}`);
  if (r.resposta) console.log(`resposta: ${r.resposta}`);
}

const AJUDA = `Uso:
  codex-membro.mjs criar --pasta <p> [--nome n] [--modelo m] [--esforco e] [--avisar] "<texto>"
  codex-membro.mjs enviar <id> "<texto>"
  codex-membro.mjs esperar <id> [--max segundos]
  codex-membro.mjs estado <id>
Use "-" no lugar do texto para ler do stdin. Porta: GERENCIADOR_PORTA (padrão 47821).`;

const [cmd, ...resto] = process.argv.slice(2);
try {
  if (cmd === 'criar') await criar(resto);
  else if (cmd === 'enviar') await enviar(resto);
  else if (cmd === 'esperar') await esperar(resto);
  else if (cmd === 'estado') await estado(resto);
  else { console.error(cmd ? `Comando desconhecido: ${cmd}\n${AJUDA}` : AJUDA); process.exitCode = 1; }
} catch (e) {
  console.error(e instanceof Falha ? e.message : `Erro: ${e?.message || e}`);
  process.exitCode = e instanceof Falha ? e.codigo : 1;
}
