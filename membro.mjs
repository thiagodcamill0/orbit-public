#!/usr/bin/env node
// Orbit — CLI para o ORQUESTRADOR de um escritório falar com os membros, pelo Bash.
//   node membro.mjs enviar <membro> "<tarefa>"
//   node membro.mjs esperar <membro> [--max segundos]
//   node membro.mjs estado [<membro>]
//   node membro.mjs lista
// Fala com http://127.0.0.1:${ORBIT_PORTA || 47821}. Usa ORBIT_ESCRITORIO (id do escritório) e
// ORBIT_SESSAO ou CLAUDE_CODE_HOST_SESSION_ID (a sessão do orquestrador, enviada em x-orbit-sessao).
// Só Node, sem dependências. Saída: 0 ok; 1 erro de uso/servidor; 2 o membro deu erro/foi interrompido;
// 3 o membro espera aprovação no Orbit; 4 tempo esgotado; 5 escritório pausado.
// A saída padrão é curta de propósito (resumo ≤300 e status) para poupar o contexto do orquestrador.
const PORTA = Number(process.env.ORBIT_PORTA) || 47821;
const BASE = `http://127.0.0.1:${PORTA}`;
const MAX_PADRAO_S = 600;
const INTERVALO_MS = Number(process.env.ORBIT_ESPERA_MS) > 0 ? Number(process.env.ORBIT_ESPERA_MS) : 1000;
const RESUMO_MAX = 300;
const FIM_RUIM = new Set(['erro', 'interrompida']);

class Falha extends Error { constructor(msg, codigo = 1) { super(msg); this.codigo = codigo; } }

const curto = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > RESUMO_MAX ? s.slice(0, RESUMO_MAX - 1) + '…' : s;
};

function escritorioId() {
  const id = process.env.ORBIT_ESCRITORIO;
  if (!id) throw new Falha('Sem ORBIT_ESCRITORIO: este comando só funciona dentro de uma sessão de orquestrador de escritório.');
  return id;
}

// O Orbit põe ORBIT_SESSAO no env da instância (o envLimpo tira CLAUDE_*); a outra serve de reserva.
const sessaoLider = () => process.env.ORBIT_SESSAO || process.env.CLAUDE_CODE_HOST_SESSION_ID;

async function chamar(metodo, caminho, corpo) {
  const cab = { 'x-gerenciador': '1' };
  const sessao = sessaoLider();
  if (sessao) cab['x-orbit-sessao'] = sessao;
  if (corpo) cab['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch(BASE + caminho, {
      method: metodo,
      headers: cab,
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
  if (r.status === 403) throw new Falha(`Recusado (403): só o orquestrador da execução atual pode falar com os membros. ${dados?.erro ? erro : 'Confira se há uma execução em andamento e se esta é a sessão do orquestrador.'}`);
  throw new Falha(erro);
}

function lerArgs(argv) {
  const opc = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-') pos.push(a);
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'max') {
        if (i + 1 >= argv.length) throw new Falha('Falta o valor de --max.');
        opc.max = argv[++i];
      } else throw new Falha(`Opção desconhecida: ${a}`);
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
const rotaMembro = (esc, membro, fim) => `/escritorios/${encodeURIComponent(esc)}/membro/${encodeURIComponent(membro)}/${fim}`;
const exigirMembro = (membro) => { if (!membro) throw new Falha('Informe o id do membro (veja "lista").'); return membro; };

async function enviar(argv) {
  const esc = escritorioId();
  const { pos } = lerArgs(argv);
  const [membro, ...resto] = pos;
  exigirMembro(membro);
  const texto = await textoDe(resto);
  if (!texto.trim()) throw new Falha('Informe a tarefa a enviar.');
  if (!sessaoLider()) throw new Falha('Sem ORBIT_SESSAO nem CLAUDE_CODE_HOST_SESSION_ID: só a sessão do orquestrador pode enviar tarefas.');
  await chamar('POST', rotaMembro(esc, membro, 'enviar'), { tarefa: texto });
  console.log(`Tarefa enviada ao membro ${membro}.`);
}

async function esperar(argv) {
  const esc = escritorioId();
  const { opc, pos } = lerArgs(argv);
  const membro = exigirMembro(pos[0]);
  const max = opc.max == null ? MAX_PADRAO_S : Number(opc.max);
  if (!Number.isFinite(max) || max <= 0) throw new Falha('--max deve ser um número de segundos maior que zero.');
  const limite = Date.now() + max * 1000;
  for (;;) {
    const e = await chamar('GET', rotaMembro(esc, membro, 'estado'));
    const status = String(e?.status || '');
    const resumo = curto(e?.resumo);
    if (status === 'concluida') {
      console.log(`status: concluida\n${resumo || '(o membro não deixou resumo)'}`);
      return;
    }
    if (FIM_RUIM.has(status)) {
      console.error(`O membro ${membro} ${status === 'erro' ? 'deu erro' : 'foi interrompido'}${resumo ? ': ' + resumo : '.'}`);
      process.exitCode = 2; return;
    }
    if (status === 'aguardando') {
      console.error(`O membro ${membro} espera uma aprovação no Orbit${resumo ? ': ' + resumo : '.'}`);
      process.exitCode = 3; return;
    }
    let pausado = status === 'pausada';
    if (!pausado) {
      const d = await chamar('GET', `/escritorios/${encodeURIComponent(esc)}`);
      pausado = d?.execucao?.status === 'pausada';
    }
    if (pausado) {
      console.error('O escritório está pausado (orçamento ou pausa manual). Libere no Orbit para continuar.');
      process.exitCode = 5; return;
    }
    if (Date.now() >= limite) throw new Falha(`O membro ${membro} ainda trabalha após ${max} s.`, 4);
    await pausa(Math.min(INTERVALO_MS, Math.max(10, limite - Date.now())));
  }
}

async function estado(argv) {
  const esc = escritorioId();
  const { pos } = lerArgs(argv);
  if (pos[0]) {
    const e = await chamar('GET', rotaMembro(esc, pos[0], 'estado'));
    console.log(`status: ${e?.status || '-'}`);
    if (e?.resumo) console.log(`resumo: ${curto(e.resumo)}`);
    return;
  }
  const d = await chamar('GET', `/escritorios/${encodeURIComponent(esc)}`);
  const x = d?.execucao;
  console.log(`escritório: ${d?.escritorio?.nome || esc}`);
  console.log(`execução: ${x?.status || 'ociosa'}${x?.motivoPausa ? ` (${x.motivoPausa})` : ''}`);
  if (x?.custo) console.log(`custo: US$ ${Number(x.custo.execucaoUsd || 0).toFixed(2)} na execução, US$ ${Number(x.custo.diaUsd || 0).toFixed(2)} no dia`);
  for (const m of d?.escritorio?.membros || []) {
    const ativo = x?.membros?.[m.id];
    if (!ativo) { console.log(`${m.id}: sem tarefa nesta execução`); continue; }
    const e = await chamar('GET', rotaMembro(esc, m.id, 'estado'));
    console.log(`${m.id}: ${e?.status || '-'}${e?.resumo ? ' — ' + curto(e.resumo) : ''}`);
  }
}

async function lista() {
  const esc = escritorioId();
  const d = await chamar('GET', `/escritorios/${encodeURIComponent(esc)}`);
  const ms = d?.escritorio?.membros || [];
  if (!ms.length) { console.log('(o escritório não tem membros)'); return; }
  for (const m of ms) console.log(`${m.id} — ${m.papel || m.nome || m.id}${m.nome && m.papel && m.nome !== m.papel ? ` (${m.nome})` : ''}`);
}

const AJUDA = `Uso:
  membro.mjs enviar <membro> "<tarefa>"
  membro.mjs esperar <membro> [--max segundos]
  membro.mjs estado [<membro>]
  membro.mjs lista
Use "-" no lugar da tarefa para ler do stdin. Porta: ORBIT_PORTA (padrão 47821). Escritório: ORBIT_ESCRITORIO.
Saída: 0 ok; 1 erro; 2 membro com erro/interrompido; 3 membro aguarda aprovação; 4 tempo esgotado; 5 escritório pausado.`;

const [cmd, ...resto] = process.argv.slice(2);
try {
  if (cmd === 'enviar') await enviar(resto);
  else if (cmd === 'esperar') await esperar(resto);
  else if (cmd === 'estado') await estado(resto);
  else if (cmd === 'lista') await lista();
  else { console.error(cmd ? `Comando desconhecido: ${cmd}\n${AJUDA}` : AJUDA); process.exitCode = 1; }
} catch (e) {
  console.error(e instanceof Falha ? e.message : `Erro: ${e?.message || e}`);
  process.exitCode = e instanceof Falha ? e.codigo : 1;
}
