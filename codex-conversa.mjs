// Conversa de uma sessão do Codex lida do rollout (somente leitura), no MESMO formato de itens do Claude
// (controle.mjs: lerConversa/normalizar): { id, ts, tipo: usuario|assistente|pensamento|ferramenta|interrupcao|erro|compactacao, ... }.
// Fonte: event_msg item_completed (UserMessage, AgentMessage, Reasoning, CommandExecution, FileChange, McpToolCall),
// turn_aborted, error e compactação. Os response_item repetem as mesmas mensagens e são ignorados.
import fsp from 'node:fs/promises';
import { textoReal } from './codex-rollouts.mjs';

export const LIMITE_PADRAO = 150;
export const LIMITE_MAX = 500;
const BLOCO = 512 * 1024;
const MAX_RESULTADO = 2000;
const INTERESSA = /"(item_completed|turn_aborted|context_compacted|compacted|error|turn_failed)"/;

const norm = (t) => String(t ?? '').replace(/[_\s-]/g, '').toLowerCase();
const ehObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const corta = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cortaBloco = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function textoDe(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

function comando(c) {
  if (Array.isArray(c)) {
    const a = c.map(String);
    if (a.length >= 3 && /^-(l?c|command)$/i.test(a[a.length - 2])) return a[a.length - 1];
    return a.join(' ');
  }
  return typeof c === 'string' ? c : '';
}

function resultadoDe(item, falhou) {
  const saida = item.aggregated_output ?? item.aggregatedOutput ?? item.output ?? item.stdout ?? '';
  const texto = typeof saida === 'string' ? saida : textoDe(saida);
  if (!texto && !falhou) return undefined;
  return { texto: cortaBloco(texto, MAX_RESULTADO), erro: !!falhou };
}

// Uma linha do rollout → zero ou mais itens. `off` = offset da linha (id estável quando o item não traz id).
export function normalizarLinha(o, off = 0) {
  const out = [];
  if (!ehObj(o) || !ehObj(o.payload)) return out;
  const ts = Date.parse(o.timestamp) || 0;
  const p = o.payload;
  if (o.type === 'compacted') { out.push({ id: `L${off}`, ts, tipo: 'compactacao' }); return out; }
  if (o.type !== 'event_msg') return out;
  const tipo = norm(p.type);
  if (tipo === 'turnaborted') { out.push({ id: `L${off}`, ts, tipo: 'interrupcao' }); return out; }
  if (tipo === 'contextcompacted') { out.push({ id: `L${off}`, ts, tipo: 'compactacao' }); return out; }
  if (tipo === 'error' || tipo === 'turnfailed') {
    out.push({ id: `L${off}`, ts, tipo: 'erro', texto: corta(p.message ?? p.error?.message ?? 'erro', 2000) });
    return out;
  }
  if (tipo !== 'itemcompleted' || !ehObj(p.item)) return out;
  const item = p.item;
  const id = String(item.id || `L${off}`);
  const t = norm(item.type);
  if (t === 'usermessage') {
    const txt = textoReal(textoDe(item.content ?? item.text));
    if (txt) out.push({ id, ts, tipo: 'usuario', texto: txt });
  } else if (t === 'agentmessage') {
    const txt = textoDe(item.content) || (typeof item.text === 'string' ? item.text : '');
    if (txt.trim()) out.push({ id, ts, tipo: 'assistente', texto: txt });
  } else if (t === 'reasoning') {
    const txt = textoDe(item.summary) || textoDe(item.content) || (typeof item.text === 'string' ? item.text : '');
    out.push({ id, ts, tipo: 'pensamento', texto: txt });
  } else if (t === 'commandexecution') {
    const code = item.exit_code ?? item.exitCode;
    const falhou = (Number.isFinite(Number(code)) && code !== null && Number(code) !== 0) || /fail|declin/i.test(String(item.status || ''));
    const it = { id, ts, tipo: 'ferramenta', nome: 'CommandExecution', resumo: corta(comando(item.command), 200) };
    const r = resultadoDe(item, falhou); if (r) it.resultado = r;
    out.push(it);
  } else if (t === 'filechange') {
    const c0 = Array.isArray(item.changes) ? item.changes[0] : null;
    const n = Array.isArray(item.changes) ? item.changes.length : 0;
    const alvo = c0 && (c0.path || c0.file) ? String(c0.path || c0.file) : '';
    const it = { id, ts, tipo: 'ferramenta', nome: 'FileChange', resumo: corta(n > 1 ? `${alvo} (+${n - 1})` : alvo, 200) };
    const falhou = /fail|declin/i.test(String(item.status || ''));
    if (falhou) it.resultado = { texto: String(item.status), erro: true };
    out.push(it);
  } else if (t === 'mcptoolcall') {
    const nome = item.tool ? (item.server ? `${item.server}/${item.tool}` : String(item.tool)) : 'McpToolCall';
    const it = { id, ts, tipo: 'ferramenta', nome, resumo: corta(item.server ? String(item.server) : '', 200) };
    const r = resultadoDe(item, /fail|error/i.test(String(item.status || ''))); if (r) it.resultado = r;
    out.push(it);
  }
  return out;
}

async function fimCompleto(fh, tam) {
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
}

// Página: os últimos `limite` itens antes do byte `antes` (null = fim do arquivo). { itens, cursorAntigo, cursorNovo }.
export async function lerConversaCodex(caminho, antes = null, limite = LIMITE_PADRAO) {
  let fh;
  try { fh = await fsp.open(caminho, 'r'); } catch { return { itens: [], cursorAntigo: null, cursorNovo: 0 }; }
  try {
    const tam = (await fh.stat()).size;
    const fimArq = antes == null ? await fimCompleto(fh, tam) : Math.min(antes, tam);
    let pos = fimArq, buf = Buffer.alloc(0), grupos = [], inicioCompleto = 0;
    for (;;) {
      const ini = Math.max(0, pos - BLOCO);
      const b = Buffer.alloc(pos - ini);
      if (b.length) await fh.read(b, 0, b.length, ini);
      buf = Buffer.concat([b, buf]);
      pos = ini;
      let corte = 0;
      if (pos > 0) { const nl = buf.indexOf(10); if (nl < 0) continue; corte = nl + 1; }
      inicioCompleto = pos + corte;
      grupos = [];
      let total = 0, i = corte;
      while (i < buf.length) {
        let nl = buf.indexOf(10, i); if (nl < 0) nl = buf.length;
        if (nl > i) {
          const s = buf.toString('utf8', i, nl);
          if (INTERESSA.test(s)) {
            let o = null; try { o = JSON.parse(s); } catch {}
            const itens = o ? normalizarLinha(o, pos + i) : [];
            if (itens.length) { grupos.push({ off: pos + i, itens }); total += itens.length; }
          }
        }
        i = nl + 1;
      }
      if (total >= limite || pos === 0) break;
    }
    let n = 0, k = grupos.length;
    while (k > 0 && n < limite) n += grupos[--k].itens.length;
    const mantidos = grupos.slice(k);
    const temAntes = k > 0 || inicioCompleto > 0;
    const cursorAntigo = mantidos.length ? (temAntes && mantidos[0].off > 0 ? String(mantidos[0].off) : null) : temAntes ? String(inicioCompleto) : null;
    return { itens: mantidos.flatMap((g) => g.itens), cursorAntigo, cursorNovo: fimArq };
  } finally { await fh.close().catch(() => {}); }
}
