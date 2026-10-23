// Orbit — instâncias do Codex pelo `codex app-server` (etapa 2 do Codex no Orbit). Usado só por codex.mjs.
//   Um processo `codex app-server` COMPARTILHADO (sobe na 1ª instância ou ao acordar uma; exe de acharCodex, `.mjs` roda
//   com node; env herdado, CODEX_HOME incluso), vários threads por id. Notificações casadas por threadId.
//   Processo sumiu -> os threads ficam `dormindo`; a próxima mensagem sobe de novo e faz `thread/resume`.
//   Rotas (contrato): POST /codex/instancias, POST /codex/sessao/:id/(mensagem|parar|retomar|encerrar),
//   GET /codex/sessao/:id/conversa/fluxo (SSE itens|parcial|reinicio), GET /codex/sessao/:id/acoes.
//   Permissão FIXA nesta etapa: approvalPolicy 'on-request' + sandbox 'workspace-write' (nunca never/danger-full-access).
//   Etapa 3: pedidos de aprovação/pergunta do app-server entram na fila da sessão (`traduzirPedido`, POST .../permissao);
//   `recusar` só vale para pedidos que não são de uma instância do Orbit ou que não entendemos.
//   Só métodos da lista fechada de codex-rpc.mjs (o cliente recusa os outros localmente).
//   B1a (escritórios): `ponte` = API JS para outro módulo do servidor (sem HTTP): criar/enviar/interromper/encerrar/estado/
//   listarEscritorio/ouvirFim/vincular. Thread de escritório: approvalPolicy 'untrusted', sandbox sem rede, instruções no
//   start/resume, MCP/plugins/apps/web desligados por override, pedidos pelo classificar() (externa = sem "nesta sessão"),
//   pausado nega tudo, item/tool/call e elicitação MCP recusados. Vínculo {escritorio,execucao,papel} em deps.arquivoEscritorio.
//   C1: falha fechada no start/resume (config/read antes, mcpServerStatus/list depois; algo ligado ou sem como conferir =
//   thread/unsubscribe + 409), override montado por parser TOML, fileChange sensível = externa, permissao reconfere a pausa.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { abrirCodex, SEM_RESPOSTA } from './codex-rpc.mjs';
import { acharCodex } from './codex-exe.mjs';
import { normalizarLinha } from './codex-conversa.mjs';
import { classificar, FALHA_AVALIAR } from './escritorio-externas.mjs';

export const APROVACAO = 'on-request';
export const SANDBOX = 'workspace-write';
const MAX_TEXTO = 20000;
const MAX_NOME = 60;
const MS_FIM_TURNO = 15000;
const MS_PARCIAL = 60;
const MS_PING = 15000;
const MAX_ACOES = 50;
const RE_ROTA = /^\/codex\/sessao\/([^/]+)\/(mensagem|parar|retomar|encerrar|permissao|compactar|modelo|esforco|conversa\/fluxo|acoes)$/;
const POSTS = new Set(['mensagem', 'parar', 'retomar', 'encerrar', 'permissao', 'compactar', 'modelo', 'esforco']);
const MS_COMPACTAR = 120000; // sem thread/compacted (ou item contextCompaction) em 2 min: a Acao falha
const MAX_FOCO = 500;
const MAX_MOTIVO = 2000; // mensagem do negar (igual ao controle.mjs)

const corta = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function erroHttp(status, erro, codigo) { return Object.assign(new Error(erro), { status, codigo }); }
const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);

// Resposta segura a um pedido do servidor que não vai ao usuário: nega tudo, sem travar o turno.
export function recusar(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval': return { decision: { denied: { rejection: 'Recusado pelo Orbit.' } } }; // ReviewDecision do esquema
    case 'item/permissions/requestApproval': return { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput': return { answers: {} };
    default: throw Object.assign(new Error(`Sem tratador para ${method}`), { code: -32601 });
  }
}

// ───────── pedidos do servidor (etapa 3) → item do mesmo formato do Claude ─────────
// Devolve { ferramenta, resumo, entrada, tipo:'ferramenta'|'pergunta', sugestoes:[{indice, rotulo}], perguntas?,
// cruas:[resultado de cada sugestão], aprovar, negar(mensagem), responder?(respostas), bloquear?:motivo }.
// Regra de ouro: nada que amplie para acesso total. Sugestões só de "esta sessão" (cache do mesmo comando/arquivos),
// nunca emenda de política persistente; permissões extras só com scope 'turn'; raiz do disco/glob/desconhecido = bloquear.
const MAX_RESPOSTA = 2000;
const normCaminho = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
export function dentroDe(base, alvo) {
  if (!base || !alvo) return false;
  const r = path.relative(normCaminho(base), normCaminho(alvo));
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}
const sem = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

function lerPermissoes(perm, cwd) {
  const itens = [];
  let amplo = false, fora = false, foraArq = false; // foraArq: caminho de arquivo fora do projeto (a rede não conta)
  const fs = perm?.fileSystem;
  for (const e of Array.isArray(fs?.entries) ? fs.entries : []) {
    if (!e || e.access === 'deny') continue;
    const c = e.path;
    if (c?.type === 'path' && typeof c.path === 'string') { itens.push(`${e.access === 'write' ? 'escrever' : 'ler'} em ${c.path}`); if (!dentroDe(cwd, c.path)) fora = foraArq = true; }
    else if (c?.type === 'special' && c.value?.kind === 'project_roots') itens.push(`${e.access === 'write' ? 'escrever' : 'ler'} no projeto${c.value.subpath ? ` (${c.value.subpath})` : ''}`);
    else if (c?.type === 'special' && ['tmpdir', 'slash_tmp', 'minimal'].includes(c.value?.kind)) { itens.push(`${e.access === 'write' ? 'escrever' : 'ler'} em ${c.value.kind}`); fora = foraArq = true; }
    else amplo = true; // root, unknown, glob_pattern ou forma que não conhecemos
  }
  for (const [k, rot] of [['read', 'ler'], ['write', 'escrever']]) {
    for (const c of Array.isArray(fs?.[k]) ? fs[k] : []) { itens.push(`${rot} em ${c}`); if (typeof c !== 'string' || !dentroDe(cwd, c)) fora = foraArq = true; }
  }
  const rede = perm?.network?.enabled === true;
  if (rede) { itens.push('acesso à rede'); fora = true; }
  return { itens, amplo, fora, foraArq };
}

export function traduzirPedido(method, params, { cwd = '', item = null } = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const base = { sugestoes: [], cruas: [], tipo: 'ferramenta' };
  const negarFixo = (r) => () => r;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const rede = p.networkApprovalContext;
      const foraCwd = p.cwd && cwd && !dentroDe(cwd, p.cwd); // comando rodando fora da pasta do projeto: avisa e não oferece "nesta sessão"
      const resumo = (foraCwd ? 'FORA do projeto: ' : '') + (rede ? `Acesso à rede: ${corta(rede.host, 120)} (${corta(rede.protocol, 20)})` : corta(p.command || p.reason || 'Rodar um comando', 300));
      const q = { ...base, ferramenta: 'CommandExecution', resumo, entrada: sem({ command: corta(p.command, 2000), cwd: p.cwd, motivo: corta(p.reason, 500), rede: rede ? `${rede.host} (${rede.protocol})` : '' }), aprovar: { decision: 'accept' }, negar: negarFixo({ decision: 'decline' }) };
      // "Nesta sessão" = o cache de aprovação do mesmo comando (sem emenda de política, sem rede).
      if (!rede && !foraCwd && (p.kind === undefined || p.kind === 'command')) { q.sugestoes.push({ indice: 0, rotulo: 'Permitir este comando nesta sessão' }); q.cruas.push({ decision: 'acceptForSession' }); }
      return q;
    }
    case 'item/fileChange/requestApproval': {
      const arquivos = Array.isArray(item?.changes) ? item.changes.map((c) => String(c?.path || '')).filter(Boolean) : [];
      const q = { ...base, ferramenta: 'FileChange', resumo: corta(arquivos.length ? `Editar ${arquivos.slice(0, 3).join(', ')}${arquivos.length > 3 ? ` e mais ${arquivos.length - 3}` : ''}` : (p.reason || 'Gravar alterações em arquivos'), 300), entrada: sem({ arquivos: arquivos.slice(0, 20).join('\n'), motivo: corta(p.reason, 500), pastaPedida: p.grantRoot }), aprovar: { decision: 'accept' }, negar: negarFixo({ decision: 'decline' }) };
      if (p.grantRoot) { if (!dentroDe(cwd, p.grantRoot)) q.bloquear = `Pede gravar em ${p.grantRoot}, fora da pasta do projeto`; }
      else { q.sugestoes.push({ indice: 0, rotulo: 'Permitir edições nestes arquivos nesta sessão' }); q.cruas.push({ decision: 'acceptForSession' }); }
      return q;
    }
    case 'item/permissions/requestApproval': {
      const l = lerPermissoes(p.permissions, cwd);
      const perfil = sem({ fileSystem: p.permissions?.fileSystem, network: p.permissions?.network });
      const q = { ...base, ferramenta: 'Permissions', resumo: corta(`Permissão extra${l.fora ? ' FORA do projeto' : ''}: ${l.itens.join('; ') || 'sem detalhes'}${p.reason ? ` — ${p.reason}` : ''}`, 300), entrada: sem({ pedido: l.itens.join('\n'), motivo: corta(p.reason, 500), pasta: p.cwd, foraDoProjeto: l.fora ? 'sim' : '' }), aprovar: { permissions: perfil, scope: 'turn' }, negar: negarFixo({ permissions: {}, scope: 'turn' }) };
      if (l.amplo || !l.itens.length) q.bloquear = 'Pede acesso amplo (raiz do disco, padrão ou forma desconhecida)';
      // Decisão de 21/10: só a pasta do projeto. Arquivo fora dela é recusado sozinho (acesso além do projeto: pendente do usuário).
      else if (l.foraArq) q.bloquear = 'Pede acesso a arquivos fora da pasta do projeto';
      return q;
    }
    case 'item/tool/requestUserInput': {
      const qs = (Array.isArray(p.questions) ? p.questions : []).filter((x) => x && typeof x.question === 'string' && x.question && typeof x.id === 'string');
      if (!qs.length) throw new Error('pergunta sem perguntas');
      const perguntas = qs.map((x) => ({ pergunta: x.question, cabecalho: typeof x.header === 'string' ? x.header : '', multipla: false, opcoes: (Array.isArray(x.options) ? x.options : []).map((o) => ({ rotulo: String(o?.label ?? ''), descricao: typeof o?.description === 'string' ? o.description : '' })) }));
      return {
        ...base, ferramenta: 'request_user_input', tipo: 'pergunta', perguntas, resumo: corta(qs[0].question, 300),
        entrada: { questions: perguntas.map((x) => ({ question: x.pergunta, header: x.cabecalho, options: x.opcoes })) },
        aprovar: null, negar: negarFixo({ answers: {} }),
        responder(r) {
          if (!r || typeof r !== 'object' || Array.isArray(r)) throw erroHttp(400, 'Mande as respostas: { respostas: { pergunta: resposta } }.');
          const answers = {}, faltam = [];
          for (const x of qs) {
            let v = r[x.question];
            if (Array.isArray(v)) v = v.filter((y) => typeof y === 'string' && y.trim()).map((y) => y.trim().slice(0, MAX_RESPOSTA));
            else if (typeof v === 'string' && v.trim()) v = [v.trim().slice(0, MAX_RESPOSTA)];
            else v = [];
            if (v.length) answers[x.id] = { answers: v }; else faltam.push(x.question);
          }
          if (faltam.length) throw erroHttp(400, `Falta responder: ${corta(faltam.join(' · '), 300)}`);
          return { answers };
        },
      };
    }
    case 'execCommandApproval': {
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '');
      return { ...base, ferramenta: 'CommandExecution', resumo: corta(cmd || p.reason || 'Rodar um comando', 300), entrada: sem({ command: corta(cmd, 2000), cwd: p.cwd, motivo: corta(p.reason, 500) }), aprovar: { decision: 'approved' },
        negar: (m) => ({ decision: { denied: { rejection: m || 'Recusado pelo Orbit.' } } }), sugestoes: [{ indice: 0, rotulo: 'Permitir este comando nesta sessão' }], cruas: [{ decision: 'approved_for_session' }] };
    }
    case 'applyPatchApproval': {
      const arquivos = Object.keys(p.fileChanges && typeof p.fileChanges === 'object' ? p.fileChanges : {});
      const q = { ...base, ferramenta: 'FileChange', resumo: corta(arquivos.length ? `Editar ${arquivos.slice(0, 3).join(', ')}${arquivos.length > 3 ? ` e mais ${arquivos.length - 3}` : ''}` : (p.reason || 'Gravar alterações em arquivos'), 300), entrada: sem({ arquivos: arquivos.slice(0, 20).join('\n'), motivo: corta(p.reason, 500), pastaPedida: p.grantRoot }), aprovar: { decision: 'approved' }, negar: (m) => ({ decision: { denied: { rejection: m || 'Recusado pelo Orbit.' } } }) };
      if (p.grantRoot) { if (!dentroDe(cwd, p.grantRoot)) q.bloquear = `Pede gravar em ${p.grantRoot}, fora da pasta do projeto`; }
      else { q.sugestoes.push({ indice: 0, rotulo: 'Permitir edições nestes arquivos nesta sessão' }); q.cruas.push({ decision: 'approved_for_session' }); }
      return q;
    }
    default: throw Object.assign(new Error(`Sem tradução para ${method}`), { code: -32601 });
  }
}
const detalheDe = (q) => (q.tipo === 'pergunta' ? 'Fez uma pergunta' : `Aprovar ${corta(q.resumo, 120)}`);

// ───────── B1a: modo escritório ─────────
export const APROVACAO_ESCRITORIO = 'untrusted';
export const SANDBOX_TURNO_ESCRITORIO = Object.freeze({ type: 'workspaceWrite', networkAccess: false });
const MAX_INSTRUCOES = 60000;
const MAX_CAMPO_ESC = 100;
// C1: parser TOML 1.0 mínimo e correto (sem dependência): comentários, chaves nuas/entre aspas/pontilhadas, strings
// básicas e literais (também multilinha), números, booleanos, datas (como texto), arrays, tabelas inline, [tabela] e
// [[array de tabelas]]. Sintaxe inválida = lança (quem chama trata como "não deu para verificar").
const RE_CHAVE_NUA = /[A-Za-z0-9_-]+/y;
const RE_ESCALAR = /[^\s,\]}#]+/y;
const tem = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ehTabela = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const definir =(o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
export function lerToml(texto) {
  const s = String(texto ?? '').replace(/^﻿/, '');
  let i = 0;
  const raiz = {};
  let atual = raiz;
  const erro = (m) => { throw new Error(`TOML inválido (linha ${s.slice(0, i).split('\n').length}): ${m}`); };
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const comentario = () => { if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++; };
  const quebra = () => { if (s[i] === '\n') { i++; return true; } if (s[i] === '\r' && s[i + 1] === '\n') { i += 2; return true; } return false; };
  const wsnl = () => { for (;;) { ws(); comentario(); if (!quebra()) return; } };
  const fimLinha = () => { ws(); comentario(); if (i < s.length && !quebra()) erro('esperava fim de linha'); };
  function escape() {
    const c = s[i++];
    const m = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (tem(m, c)) return m[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8, h = s.slice(i, i + n);
      if (h.length !== n || !/^[0-9a-fA-F]+$/.test(h)) erro('escape unicode inválido');
      i += n; return String.fromCodePoint(parseInt(h, 16));
    }
    return erro('escape inválido');
  }
  function stringBasica() {
    let out = '';
    if (s.startsWith('"""', i)) {
      i += 3; quebra();
      for (;;) {
        if (i >= s.length) erro('string sem fim');
        if (s.startsWith('"""', i)) { let n = 3; while (s[i + n] === '"' && n < 5) n++; i += n; return out + '"'.repeat(n - 3); }
        const c = s[i++];
        if (c !== '\\') { out += c; continue; }
        let j = i; while (s[j] === ' ' || s[j] === '\t') j++;
        if (s[j] === '\n' || (s[j] === '\r' && s[j + 1] === '\n')) { i = j; while (/[ \t\r\n]/.test(s[i] || '')) i++; } else out += escape();
      }
    }
    i++;
    for (;;) {
      if (i >= s.length || s[i] === '\n') erro('string sem fim');
      const c = s[i++];
      if (c === '"') return out;
      out += c === '\\' ? escape() : c;
    }
  }
  function stringLiteral() {
    if (s.startsWith("'''", i)) {
      i += 3; quebra();
      const f = s.indexOf("'''", i); if (f < 0) erro('string sem fim');
      let n = 3; while (s[f + n] === "'" && n < 5) n++;
      const out = s.slice(i, f) + "'".repeat(n - 3); i = f + n; return out;
    }
    i++;
    const f = s.indexOf("'", i), nl = s.indexOf('\n', i);
    if (f < 0 || (nl >= 0 && nl < f)) erro('string sem fim');
    const out = s.slice(i, f); i = f + 1; return out;
  }
  function chave() {
    const partes = [];
    for (;;) {
      ws();
      if (s[i] === '"' || s[i] === "'") {
        if (s.startsWith('"""', i) || s.startsWith("'''", i)) erro('chave multilinha');
        partes.push(s[i] === '"' ? stringBasica() : stringLiteral());
      } else {
        RE_CHAVE_NUA.lastIndex = i;
        const m = RE_CHAVE_NUA.exec(s);
        if (!m) erro('chave inválida');
        partes.push(m[0]); i += m[0].length;
      }
      ws();
      if (s[i] !== '.') return partes;
      i++;
    }
  }
  // Desce pelas partes criando tabelas; num array de tabelas usa o último elemento.
  function descer(o, partes) {
    for (const k of partes) {
      if (!tem(o, k)) definir(o, k, {});
      let v = o[k];
      if (Array.isArray(v)) v = v[v.length - 1];
      if (!ehTabela(v)) erro(`"${k}" não é uma tabela`);
      o = v;
    }
    return o;
  }
  function atribuir(o, partes, v) {
    const alvo = descer(o, partes.slice(0, -1)), k = partes[partes.length - 1];
    if (tem(alvo, k)) erro(`chave repetida "${k}"`);
    definir(alvo, k, v);
  }
  function valor() {
    const c = s[i];
    if (c === '"') return stringBasica();
    if (c === "'") return stringLiteral();
    if (c === '[') {
      i++; const arr = [];
      for (;;) {
        wsnl();
        if (s[i] === ']') { i++; return arr; }
        arr.push(valor()); wsnl();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        erro('array mal formado');
      }
    }
    if (c === '{') {
      i++; const obj = {};
      wsnl(); if (s[i] === '}') { i++; return obj; }
      for (;;) {
        const k = chave();
        if (s[i] !== '=') erro('esperava "=" na tabela inline');
        i++; ws(); atribuir(obj, k, valor()); wsnl();
        if (s[i] === ',') { i++; wsnl(); continue; }
        if (s[i] === '}') { i++; return obj; }
        erro('tabela inline mal formada');
      }
    }
    RE_ESCALAR.lastIndex = i;
    const m = RE_ESCALAR.exec(s);
    if (!m) return erro('valor ausente');
    let t = m[0]; i += t.length;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t) && s[i] === ' ' && /^\d{2}:/.test(s.slice(i + 1, i + 4))) { // data e hora separadas por espaço
      RE_ESCALAR.lastIndex = i + 1; const h = RE_ESCALAR.exec(s); t += ' ' + h[0]; i += 1 + h[0].length;
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(t)) return t.endsWith('nan') ? NaN : t[0] === '-' ? -Infinity : Infinity;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(t)) return Number(t.replace(/_/g, ''));
    if (/^0x[0-9a-fA-F](_?[0-9a-fA-F])*$/.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7](_?[0-7])*$/.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01](_?[01])*$/.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 2);
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(t)) return Number(t.replace(/_/g, ''));
    if (/^(\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(:\d{2}(\.\d+)?)?)$/.test(t)) return t;
    return erro(`valor inválido "${corta(t, 30)}"`);
  }
  for (;;) {
    wsnl();
    if (i >= s.length) return raiz;
    if (s[i] === '[') {
      const dupla = s[i + 1] === '[';
      i += dupla ? 2 : 1;
      const k = chave();
      if (dupla ? !s.startsWith(']]', i) : s[i] !== ']') erro('cabeçalho de tabela mal formado');
      i += dupla ? 2 : 1;
      if (dupla) {
        const pai = descer(raiz, k.slice(0, -1)), u = k[k.length - 1];
        if (!tem(pai, u)) definir(pai, u, []);
        if (!Array.isArray(pai[u])) erro(`"${u}" não é um array de tabelas`);
        pai[u].push(atual = {});
      } else atual = descer(raiz, k);
      fimLinha();
      continue;
    }
    const k = chave();
    if (s[i] !== '=') erro('esperava "="');
    i++; ws();
    atribuir(atual, k, valor());
    fimLinha();
  }
}
// MCP, plugins e `notify` de um config.toml (raiz e todos os [profiles.*]); qualquer forma: [mcp_servers.x],
// [mcp_servers] + x = {…}, mcp_servers.x.command = …, [profiles.p.mcp_servers.x]. TOML inválido = lança.
export function nomesDoToml(texto) {
  const cfg = lerToml(texto);
  const mcp = new Set(), plugins = new Set();
  let notify = false;
  const ler = (c) => {
    if (!ehTabela(c)) return;
    if (ehTabela(c.mcp_servers)) Object.keys(c.mcp_servers).forEach((n) => mcp.add(n));
    if (ehTabela(c.plugins)) Object.keys(c.plugins).forEach((n) => plugins.add(n));
    if (notifyAtivo(c.notify)) notify = true;
  };
  ler(cfg);
  if (ehTabela(cfg.profiles)) Object.values(cfg.profiles).forEach(ler);
  return { mcp: [...mcp], plugins: [...plugins], notify };
}
export const notifyAtivo = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '' && v !== false);
// `.codex/config.toml` de projeto que o Codex lê para `cwd`: da pasta até a 1ª pasta-mãe com `.git` (a raiz do
// repositório); sem `.git` acima, só a da própria pasta. O config.toml do CODEX_HOME não entra (é lido à parte).
export function configsDeProjeto(cwd, home) {
  if (!cwd) return [];
  const daHome = home ? normCaminho(path.join(home, 'config.toml')) : '';
  const dirs = [];
  let d = path.resolve(cwd), raiz = null;
  for (;;) {
    dirs.push(d);
    if (fs.existsSync(path.join(d, '.git'))) { raiz = d; break; }
    const pai = path.dirname(d);
    if (pai === d) break;
    d = pai;
  }
  const usar = raiz ? dirs : [path.resolve(cwd)];
  return usar.map((x) => path.join(x, '.codex', 'config.toml')).filter((a) => normCaminho(a) !== daHome);
}
// Nomes dos MCP do mcpServerStatus/list de um thread que NÃO estão desligados (runtimeStatus ausente/null = ativo).
export function mcpAtivos(lista) {
  return (Array.isArray(lista) ? lista : []).filter((x) => !x || x.runtimeStatus !== 'disabled').map((x) => String(x?.name || x?.pluginId || '?'));
}
// `config` do thread/start|resume de escritório (overrides do config.toml; esquema 0.163, efeito real NÃO testado):
// cada MCP/plugin conhecido desligado, apps desligados, busca na web desligada, sandbox workspace-write sem rede.
export function overrideEscritorio({ mcp = [], plugins = [], notify = false } = {}) {
  const config = { web_search: 'disabled', sandbox_workspace_write: { network_access: false }, apps: { _default: { enabled: false } } };
  if (notify) config.notify = []; // melhor esforço: não dá para conferir por thread se o Codex honra este override
  if (mcp.length) config.mcp_servers = Object.fromEntries(mcp.map((n) => [n, { enabled: false }]));
  if (plugins.length) config.plugins = Object.fromEntries(plugins.map((n) => [n, { enabled: false }]));
  return config;
}
// Resposta de recusa válida (esquema) para os pedidos fora da lista num thread de escritório.
export function recusaForaDaLista(method) {
  if (method === 'item/tool/call') return { contentItems: [{ type: 'inputText', text: 'Recusado pelo Orbit: ferramenta não permitida em escritório.' }], success: false };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  return undefined;
}
// Pedido de um thread de escritório é ação externa? Devolve a descrição ou ''. Comando: classificar() como Bash e como
// PowerShell (o Codex no Windows usa o PowerShell); arquivo: classificar('Write') de cada um; rede = externa.
// C1 (P2-6): com `ctx.cwd`, FileChange sem arquivo identificado, fora do cwd, em `.codex/`, `.git/` ou no CODEX_HOME
// (`ctx.home`) também é externa (mexe na config/hooks do próprio Codex ou do git, ou fora do projeto).
export function arquivoSensivel(arquivo, { cwd, home } = {}) {
  const abs = path.resolve(cwd || '.', String(arquivo || ''));
  if (!cwd || !dentroDe(cwd, abs)) return `edição fora da pasta do projeto (${corta(arquivo, 120)})`;
  if (home && dentroDe(home, abs)) return `edição na configuração do Codex (${corta(arquivo, 120)})`;
  const partes = path.relative(path.resolve(cwd), abs).split(/[\\/]+/).map((x) => x.toLowerCase());
  if (partes.includes('.codex')) return `edição na configuração do Codex (${corta(arquivo, 120)})`;
  if (partes.includes('.git')) return `edição dentro de .git (${corta(arquivo, 120)})`;
  return '';
}
export function externaDoPedido(method, params, q, travas = {}, arquivos = [], ctx = null) {
  if (!q || q.tipo === 'pergunta') return '';
  const ex = Array.isArray(travas.extras) ? travas.extras : [];
  const op = { porta: travas.porta, raiz: travas.raiz };
  const p = params && typeof params === 'object' ? params : {};
  const um = (nome, entrada) => { const r = classificar(nome, entrada, ex, op); return r?.externa ? String(r.descricao || FALHA_AVALIAR) : ''; };
  if (q.ferramenta === 'CommandExecution') {
    if (p.networkApprovalContext) return 'acesso à rede';
    const cmd = Array.isArray(p.command) ? p.command.join(' ') : String(p.command ?? '');
    if (!cmd.trim()) return FALHA_AVALIAR;
    return um('Bash', { command: cmd }) || um('PowerShell', { command: cmd });
  }
  if (q.ferramenta === 'FileChange') {
    if (ctx) {
      if (!arquivos.length) return 'edição de arquivos não identificados';
      for (const a of arquivos) { const d = arquivoSensivel(a, ctx); if (d) return d; }
    }
    for (const a of arquivos) { const d = um('Write', { file_path: ctx?.cwd ? path.resolve(ctx.cwd, a) : a }); if (d) return d; }
    return '';
  }
  if (q.ferramenta === 'Permissions') return p.permissions?.network?.enabled === true ? 'acesso à rede' : '';
  return '';
}

// deps: { config: () => config.codex, log, sessaoCodex(id, campos), sessao(id), difundir(tipo, dados), difundirSessao(id),
//         removerSessao(id), lerJSONCorpo(req, limite), responder(res, codigo, corpo) }
// opcoes: { aoPedido?(threadId, method, params) -> Promise<result>|undefined }  (ponto de extensão da etapa 3)
//         etapa 4: validar?(modelo, esforco, modeloAtual) -> Promise<{modelo, esforco}> (400 se fora da lista do model/list),
//         aoConta?(method, params) (notificações sem thread: account/*)
export function criarInstancias(deps, opcoes = {}) {
  const { responder } = deps;
  const log = deps.log || (() => {});
  const threads = new Map(); // id -> registro do thread (memória)
  const acoes = new Map(); // id -> Acao[]
  const fluxos = new Map(); // id -> Set<{res}>
  let proc = null; // { cli, pronto, morto, estado, geracao }
  let parando = false;

  // ───────── B1a: vínculos de escritório (persistidos) e ouvintes de fim de turno ─────────
  const home = deps.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const arqVinculos = deps.arquivoEscritorio || null;
  const vinculos = carregarVinculos(); // threadId -> { escritorio, cwd, nome, modelo, esforco, pai, instrucoes, travas:{extras,porta,raiz}, criado }
  const ouvintesFim = new Set();
  const ouvintesUso = new Set(); // ouvirUso: cada thread/tokenUsage/updated de thread de escritório
  function carregarVinculos() {
    if (!arqVinculos) return new Map();
    try {
      const j = JSON.parse(fs.readFileSync(arqVinculos, 'utf8'));
      return new Map(Object.entries(j?.threads && typeof j.threads === 'object' ? j.threads : {}).filter(([, v]) => v?.escritorio?.id));
    } catch { return new Map(); }
  }
  function gravarVinculos() {
    if (!arqVinculos) return;
    try {
      fs.mkdirSync(path.dirname(arqVinculos), { recursive: true });
      const tmp = `${arqVinculos}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ versao: 1, threads: Object.fromEntries(vinculos) }, null, 1));
      fs.renameSync(tmp, arqVinculos);
    } catch (e) { log('codex', 'não gravei os vínculos de escritório:', e?.message || e); }
  }
  // ───────── C1 (P1-1): falha fechada do modo escritório ─────────
  const recusaMembro = (motivo, codigo) => erroHttp(409, `Membro Codex recusado: ${motivo}`, codigo);
  // MCP, plugins e notify dos config.toml (CODEX_HOME e `.codex/config.toml` da pasta e das pastas-mãe até a raiz do
  // repositório) pelo parser TOML; TOML inválido = recusa (não dá para saber o que desligar). Só leitura.
  function nomesConfig(cwd) {
    const r = { mcp: new Set(), plugins: new Set(), notify: false, notifyProjeto: false };
    const doProjeto = configsDeProjeto(cwd, home);
    for (const arq of [path.join(home, 'config.toml'), ...doProjeto]) {
      let txt; try { txt = fs.readFileSync(arq, 'utf8'); } catch { continue; }
      let n;
      try { n = nomesDoToml(txt); } catch (e) { throw recusaMembro(`não consegui ler ${arq} (${e.message}).`, 'verificacao_indisponivel'); }
      n.mcp.forEach((x) => r.mcp.add(x)); n.plugins.forEach((x) => r.plugins.add(x));
      if (n.notify) { r.notify = true; if (doProjeto.includes(arq)) r.notifyProjeto = true; }
    }
    return r;
  }
  // Antes do thread/start|resume: TOML + config efetiva do app-server (`config/read` com o cwd: pega também managed
  // config/requirements). `notify` não é legível por thread: se a config tiver um, recusa (não dá para provar que fica
  // desligado). Devolve os params de escritório: política, sandbox, instruções e override (vale também no resume).
  async function prepararEscritorio(p, t) {
    const n = nomesConfig(t.cwd);
    let ef;
    try { ef = (await p.cli.pedir('config/read', t.cwd ? { cwd: t.cwd } : {}))?.config; } catch (e) { throw recusaMembro(`não consegui ler a configuração efetiva do Codex (${corta(e?.message || e, 200)}).`, 'verificacao_indisponivel'); }
    if (!ehTabela(ef)) throw recusaMembro('o Codex não devolveu a configuração efetiva.', 'verificacao_indisponivel');
    if (ehTabela(ef.mcp_servers)) Object.keys(ef.mcp_servers).forEach((x) => n.mcp.add(x));
    if (ehTabela(ef.plugins)) Object.keys(ef.plugins).forEach((x) => n.plugins.add(x));
    // notify do repositório (`.codex/config.toml` da pasta ou de pastas-mãe) é conteúdo de terceiros: recusa. O do
    // CODEX_HOME (ou da config efetiva) é configuração do próprio usuário: não recusa; vai o override `notify = []`
    // (melhor esforço, não verificável por thread) e fica no log. Mudar notify pelo agente = editar .codex/CODEX_HOME = externa.
    if (n.notifyProjeto) throw recusaMembro('o `.codex/config.toml` do projeto (ou de uma pasta-mãe) define `notify` (roda um programa a cada fim de turno, sem aprovação). Tire o `notify` de lá para usar membros Codex nesta pasta.', 'notify_ativo');
    const temNotify = n.notify || notifyAtivo(ef.notify);
    if (temNotify) log('codex', 'escritório: a config do Codex tem `notify`; mando o override notify=[] (melhor esforço, não verificável):', t.cwd || '');
    t.desligados = { mcp: [...n.mcp], plugins: [...n.plugins], notify: temNotify };
    const o = { approvalPolicy: APROVACAO_ESCRITORIO, sandbox: SANDBOX, config: overrideEscritorio(t.desligados) };
    if (t.instrucoes) o.developerInstructions = t.instrucoes;
    return o;
  }
  // Depois do thread/start|resume: pelo próprio app-server, nenhum MCP (os de plugin e o de apps, `codex_apps`, também
  // aparecem aqui) pode estar ligado no thread. Algum ligado, ou não deu para conferir = descarrega o thread e recusa.
  async function conferirEscritorio(p, threadId) {
    const ativos = [];
    try {
      let cursor = null, voltas = 0;
      do {
        const r = await p.cli.pedir('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(r?.data)) throw new Error('resposta sem a lista de servidores');
        ativos.push(...mcpAtivos(r.data));
        cursor = r.nextCursor || null;
        if (++voltas > 50) throw new Error('lista de servidores sem fim');
      } while (cursor);
    } catch (e) {
      await descarregar(p, threadId);
      throw recusaMembro(`não consegui conferir no Codex que MCP/plugins/apps ficaram desligados (${corta(e?.message || e, 200)}).`, 'verificacao_indisponivel');
    }
    if (ativos.length) {
      await descarregar(p, threadId);
      throw recusaMembro(`o Codex deixou ativo neste thread: ${corta([...new Set(ativos)].join(', '), 300)} (MCP/plugin/app). No escritório nada disso pode rodar sem passar pelo Orbit.`, 'mcp_ativo');
    }
  }
  async function descarregar(p, threadId) {
    try { await p.cli.pedir('thread/unsubscribe', { threadId }); } catch (e) { log('codex', 'thread/unsubscribe falhou:', threadId, e?.message || e); }
  }
  function pausadoDe(t) {
    const f = t.travas?.pausado;
    // C3 (P2-1): thread de vínculo carregado do disco e ainda sem `vincular` (travas) desde o boot = pausado
    if (typeof f !== 'function') return !!t.semVinculo;
    try { return !!f(); } catch { return true; } // falha fechada
  }
  function emitirFim(t, st, erroForcado) {
    if (!ouvintesFim.size) return;
    const erro = erroForcado || (st === 'failed' ? (t.erroMsg || 'O turno falhou') : st === 'interrupted' ? 'Interrompida' : null);
    const ev = { sessao: t.id, texto: t.textoTurno || '', erro, tokens: t.tokensTotal ? { ...t.tokensTotal } : null, modelo: t.modeloReal || t.modelo || '', geracao: t.geracao || '', status: st };
    if (t.escritorio) ev.escritorio = { ...t.escritorio };
    for (const fn of [...ouvintesFim]) { try { fn(ev); } catch (e) { log('codex', 'ouvirFim falhou:', e?.message || e); } }
  }
  // item/tool/call e mcpServer/elicitation/request (fora da lista): num thread de escritório, recusa válida e registro.
  function foraDaLista(p, method, params) {
    const tid = params?.threadId || params?.conversationId;
    const t = tid ? threads.get(tid) : null;
    if (!t || t.proc !== p || !t.escritorio) return undefined; // Codex comum: segue -32601 como antes
    const qual = method === 'item/tool/call' ? `ferramenta "${corta(params?.tool || '?', 60)}"` : `pedido do MCP "${corta(params?.serverName || '?', 60)}"`;
    log('codex', 'escritório: pedido fora da lista recusado:', method, t.id);
    registrarBloqueio(t, `${qual} não é permitido em escritório`);
    t.recusados = (t.recusados || 0) + 1;
    return recusaForaDaLista(method);
  }

  // ───────── Acao (mesmo formato do controle.mjs; sai no SSE global `acao`) ─────────
  function novaAcao(sessao, tipo, via = 'orbit') {
    const a = { id: crypto.randomUUID(), sessao, tipo, estado: 'em_andamento', via, inicio: Date.now() };
    const l = acoes.get(sessao) || [];
    l.push(a);
    if (l.length > MAX_ACOES) l.splice(0, l.length - MAX_ACOES);
    acoes.set(sessao, l);
    deps.difundir?.('acao', a);
    return a;
  }
  function etapa(a, t) { if (a.estado !== 'em_andamento') return; a.etapa = t; deps.difundir?.('acao', a); }
  function concluir(a, resultado) {
    if (a.estado !== 'em_andamento') return;
    a.estado = 'sucesso'; a.fim = Date.now(); delete a.etapa;
    if (resultado) a.resultado = resultado;
    deps.difundir?.('acao', a);
  }
  function falhar(a, erro) {
    if (a.estado !== 'em_andamento') return;
    a.estado = 'erro'; a.fim = Date.now(); a.erro = String(erro);
    deps.difundir?.('acao', a);
  }

  // ───────── processo compartilhado ─────────
  function lancamento() {
    const info = acharCodex({ caminhoManual: deps.config?.()?.exe });
    if (!info.exe) throw erroHttp(503, `Não achei o executável do Codex (${info.motivo || 'sem caminho'}).`, 'sem_exe');
    // .mjs/.js (o Codex falso dos testes) roda com node, como o binario.mjs faz com o claude-falso.
    return /\.(mjs|cjs|js)$/i.test(info.exe) ? { exe: process.execPath, args: [info.exe, 'app-server'] } : { exe: info.exe, args: ['app-server'] };
  }

  function garantirProcesso() {
    if (parando) return Promise.reject(erroHttp(503, 'O Codex está desligado.', 'desligado'));
    if (proc && !proc.morto) return proc.pronto;
    let l;
    try { l = lancamento(); } catch (e) { return Promise.reject(e); }
    const p = { cli: null, morto: false, estado: 'iniciando', pronto: null, geracao: crypto.randomUUID() };
    p.pronto = (async () => {
      try {
        p.cli = await abrirCodex({
          exe: l.exe, args: l.args,
          aoNotificar: (m, pr) => notificacao(p, m, pr),
          aoPedir: (m, pr, rid) => pedido(p, m, pr, rid),
          aoForaDaLista: (m, pr) => foraDaLista(p, m, pr),
          aoSair: () => aoSair(p),
          log: (tipo, dado) => log('codex', tipo, typeof dado === 'string' ? dado : JSON.stringify(dado)),
        });
      } catch (e) {
        p.morto = true;
        if (proc === p) proc = null;
        throw erroHttp(502, `Não consegui iniciar o Codex: ${e.message}`, 'sem_processo');
      }
      p.estado = 'vivo';
      if (p.morto) throw erroHttp(502, 'O Codex saiu logo depois de subir.', 'sem_processo');
      if (parando) { p.cli.fechar().catch(() => {}); throw erroHttp(503, 'O Codex está desligado.', 'desligado'); }
      return p;
    })();
    p.pronto.catch(() => {});
    proc = p;
    return p.pronto;
  }

  // Pedido avulso ao app-server (modelos, uso do plano): sobe o processo se preciso.
  async function chamar(method, params) {
    const p = await garantirProcesso();
    return p.cli.pedir(method, params);
  }

  function aoSair(p) {
    p.morto = true;
    if (proc === p) proc = null;
    if (parando) return;
    for (const t of threads.values()) if (t.proc === p) { t.proc = null; perderTurno(t); }
  }

  // O processo caiu com o thread anexado: tira o turno em curso e avisa (o estado vira `dormindo`).
  function perderTurno(t) {
    const tinha = !!t.turno || !!t.iniciando || !!t.compactando;
    if (t.compactando) acabarCompactacao(t, t.compactando, new Error('O Codex parou durante a compactação.'), false);
    t.perdido = tinha; // o rollout ainda mostra o turno aberto: o monitor não pode desfazer o "interrompida"
    t.turno = null;
    t.ferramenta = null;
    descartarPedidos(t);
    liberarEsperas(t);
    for (const f of t.fila.splice(0)) falhar(f.a, 'O Codex parou antes de enviar a mensagem.');
    if (tinha) { t.status = 'interrompida'; t.motivo = 'O processo do Codex parou'; publicar(t); avisarFim(t, 'interrupted'); emitirFim(t, 'interrupted', 'O processo do Codex parou'); } else difundirEstado(t);
  }

  // ───────── registro do thread ─────────
  function registro(id, base = {}) {
    let t = threads.get(id);
    if (t) return t;
    t = {
      id, cwd: '', modelo: '', esforco: '', modeloReal: '', esforcoReal: '', nome: '', origem: '',
      status: 'nova', motivo: '', ferramenta: null, ultimaResposta: '', contexto: null,
      proc: null, acordando: false, anexando: null,
      turno: null, iniciando: null, finalizados: new Set(), fila: [], esperas: [], suprimirFim: false, erroMsg: '',
      parciais: new Map(), parcTimer: null, desde: Date.now(), atividade: Date.now(),
      pedidos: [], itens: new Map(), // etapa 3: fila de aprovações/perguntas abertas; itens iniciados (arquivos do fileChange)
      ...base,
    };
    threads.set(id, t);
    return t;
  }
  // Thread de uma sessão que o servidor conhece como Codex (criada aqui antes de um reinício, ou só monitorada).
  function threadDe(id) {
    const t = threads.get(id);
    if (t) return t;
    const v = vinculos.get(id);
    if (v) return registroDoVinculo(id, v); // B1a: thread de escritório de antes de um reinício (dorme até a próxima mensagem)
    const s = deps.sessao?.(id);
    if (!s || s.provedor !== 'codex') return null;
    return registro(id, { cwd: s.cwd || '', status: s.status || 'nova', origem: s.origem === 'orbit' ? 'orbit' : '', ultimaResposta: s.ultimaResposta || '', contexto: s.contexto || null, nomeadoPeloOrbit: false });
  }
  function registroDoVinculo(id, v) {
    return registro(id, { cwd: v.cwd || '', nome: v.nome || '', modelo: v.modelo || '', esforco: v.esforco || '', origem: 'orbit', pai: v.pai || '', avisar: false,
      escritorio: { ...v.escritorio }, instrucoes: v.instrucoes || '', travas: { ...(v.travas || {}) }, nomeadoPeloOrbit: true, semVinculo: true });
  }
  const ehMeu = (id, s) => threads.has(id) || vinculos.has(id) || (s?.provedor === 'codex' && s?.origem === 'orbit');

  const vivo = (t) => !!t.proc && !t.proc.morto;

  // Campos que o servidor entende (sessaoCodex). Sempre completos para status/ferramenta: o servidor sobrescreve os dois.
  function campos(t, extra = {}) {
    const c = {
      status: t.status, motivo: t.motivo || '', ferramenta: t.ferramenta, cwd: t.cwd, atividade: Date.now(),
      modelo: t.modeloReal || t.modelo || undefined, esforco: t.esforco || t.esforcoReal || undefined, ...extra,
    };
    if (t.origem === 'orbit') c.origem = 'orbit';
    if (t.nome) c.apelido = t.nome;
    if (t.pai) c.pai = t.pai;
    if (t.ultimaResposta) c.ultimaResposta = t.ultimaResposta;
    if (t.contexto) c.contexto = t.contexto;
    if (t.escritorio) c.escritorio = { ...t.escritorio }; // B1a
    return c;
  }
  function publicar(t, extra) {
    t.atividade = Date.now();
    try { deps.sessaoCodex?.(t.id, campos(t, extra)); } catch (e) { log('codex: publicar', t.id, e?.message || e); }
  }
  function difundirEstado(t) { try { deps.difundirSessao?.(t.id); } catch {} }

  // O monitor de rollouts só complementa o que a instância não sabe: com o thread anexado a um processo vivo,
  // status/motivo/ferramenta/resposta/contexto vêm da instância (notificações), o resto (contadores, título…) do rollout.
  function complementar(id, c) {
    const t = threads.get(id);
    if (!t) return c;
    if (!vivo(t)) return t.perdido ? { ...c, status: t.status, motivo: t.motivo || '', ferramenta: null } : c;
    const o = { ...c, status: t.status, motivo: t.motivo || '', ferramenta: t.ferramenta };
    if (t.ultimaResposta) o.ultimaResposta = t.ultimaResposta;
    if (t.contexto) {
      o.contexto = t.contexto;
      const j = t.contexto.janela || c.contexto?.janela; // sem janela no tokenUsage: a do rollout (model_context_window)
      if (j && !t.contexto.janela) o.contexto = { ...t.contexto, janela: j, pct: t.contexto.tokens != null ? Math.min(100, Math.round((t.contexto.tokens / j) * 100)) : null };
    }
    // modelo/esforço escolhidos no Orbit valem antes de o rollout (turn_context) mostrar o novo turno
    if (t.modeloReal || t.modelo) o.modelo = t.modeloReal || t.modelo;
    if (t.esforco || t.esforcoReal) o.esforco = t.esforco || t.esforcoReal;
    return o;
  }

  // ───────── estado (Sessao.controle) ─────────
  function estado(s) {
    if (!ehMeu(s.id, s)) return null;
    const t = threads.get(s.id);
    const processo = t && vivo(t) ? 'vivo' : t?.acordando ? 'iniciando' : 'dormindo';
    const o = {
      modo: 'orbit', provedor: 'codex', podeAssumir: false,
      motivo: processo === 'vivo' ? 'Já está no Orbit' : processo === 'iniciando' ? (t.criando ? 'Iniciando no Orbit' : 'Retomando no Orbit') : 'Dormindo no Orbit',
      ocupada: !!(t && (t.turno || t.iniciando || t.fila.length || t.compactando)) || processo === 'iniciando',
      processo, modelo: t?.modeloReal || t?.modelo || s.modelo || '', esforco: t?.esforco || t?.esforcoReal || s.esforco || '',
      permissao: null, pendentes: 0,
    };
    const q0 = t?.pedidos[0]?.q;
    if (q0) {
      // Mesmo formato do controle.estado do Claude: o 1º da fila e o tamanho da fila.
      o.permissao = { id: t.pedidos[0].id, ferramenta: q0.ferramenta, resumo: q0.resumo, entrada: q0.entrada, tipo: q0.tipo };
      if (q0.sugestoes.length) o.permissao.sugestoes = q0.sugestoes;
      if (q0.perguntas) o.permissao.perguntas = q0.perguntas;
      if (q0.externa) { o.permissao.externa = true; o.permissao.motivo = `Ação externa: ${q0.descricaoExterna}`; } // B1a: mesmo formato do Claude
      o.pendentes = t.pedidos.length;
    }
    if (t?.escritorio) o.escritorio = { ...t.escritorio };
    if (processo === 'vivo' && t.proc.cli?.pid) o.pid = t.proc.cli.pid;
    if (t?.atividade) o.ultimaAtividade = iso(t.atividade);
    return o;
  }

  // ───────── notificações do app-server ─────────
  const FERRAMENTAS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
  function ferramentaDe(item) {
    switch (item.type) {
      case 'commandExecution': return { nome: 'CommandExecution', alvo: corta(item.command, 200) };
      case 'fileChange': return { nome: 'FileChange', alvo: corta(Array.isArray(item.changes) && item.changes[0]?.path || '', 200) };
      case 'mcpToolCall': return { nome: item.tool ? (item.server ? `${item.server}/${item.tool}` : String(item.tool)) : 'McpToolCall', alvo: corta(item.server || '', 200) };
      case 'dynamicToolCall': return { nome: String(item.tool || 'Tool'), alvo: '' };
      default: return { nome: 'WebSearch', alvo: corta(item.query || '', 200) };
    }
  }

  function notificacao(p, method, params) {
    if (method.startsWith('account/')) { try { opcoes.aoConta?.(method, params); } catch {} return; }
    const id = params?.threadId || params?.thread?.id;
    const t = id ? threads.get(id) : null;
    if (!t || t.proc !== p) return; // thread que não é de uma instância deste processo (subagentes etc.)
    switch (method) {
      case 'turn/started': {
        const tid = params.turn?.id;
        if (tid && t.finalizados.has(tid)) return;
        if (tid) t.turno = { id: tid };
        t.status = 'trabalhando'; t.motivo = ''; t.ferramenta = null; t.erroMsg = '';
        publicar(t);
        break;
      }
      case 'serverRequest/resolved': { // o servidor resolveu/cancelou o pedido (turno interrompido etc.): sai da fila sem responder
        const i = t.pedidos.findIndex((x) => x.rid !== undefined && String(x.rid) === String(params.requestId));
        if (i >= 0) { const [e] = t.pedidos.splice(i, 1); e.resolve(SEM_RESPOSTA); aposFila(t); }
        break;
      }
      case 'item/started': {
        const item = params.item;
        if (item?.id) { t.itens.set(String(item.id), item); if (t.itens.size > 60) t.itens.delete(t.itens.keys().next().value); }
        if (item && FERRAMENTAS.has(item.type)) {
          t.ferramenta = { ...ferramentaDe(item), desde: Date.now() };
          if (t.status !== 'trabalhando' && !t.pedidos.length) t.status = 'trabalhando';
          publicar(t);
        }
        break;
      }
      case 'item/agentMessage/delta': parcial(t, String(params.itemId || ''), String(params.delta || '')); break;
      case 'item/completed': {
        const item = params.item;
        if (!item) break;
        if (item.type === 'contextCompaction' && t.compactando) acabarCompactacao(t, t.compactando); // forma nova de `thread/compacted`
        t.parciais.delete(String(item.id || ''));
        emitirItens(t.id, normalizarLinha({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item } }, `n${Date.now()}`));
        if (item.type === 'agentMessage' && String(item.phase || '') !== 'commentary' && typeof item.text === 'string' && item.text.trim()) {
          t.ultimaResposta = item.text; t.textoTurno = item.text; publicar(t);
        } else if (FERRAMENTAS.has(item.type) && t.ferramenta) { t.ferramenta = null; publicar(t); }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const u = params.tokenUsage;
        // B1a: acumulado do thread (total) para o ouvirFim
        if (u?.total && typeof u.total === 'object') {
          const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
          t.tokensTotal = { entrada: n(u.total.inputTokens), cacheEntrada: n(u.total.cachedInputTokens), saida: n(u.total.outputTokens), raciocinio: n(u.total.reasoningOutputTokens), total: n(u.total.totalTokens) };
          // custo no meio do turno (e depois do turn/completed): quem orça o escritório soma o que ainda não cobrou
          if (t.escritorio && ouvintesUso.size) {
            const ev = { sessao: t.id, tokens: { ...t.tokensTotal }, modelo: t.modeloReal || t.modelo || '', geracao: t.geracao || '', escritorio: { ...t.escritorio } };
            for (const fn of [...ouvintesUso]) { try { fn(ev); } catch (e) { log('codex', 'ouvirUso falhou:', e?.message || e); } }
          }
        }
        const tokens = Number(u?.last?.inputTokens), janela = Number(u?.modelContextWindow) || t.contexto?.janela || null;
        if (Number.isFinite(tokens)) {
          t.contexto = { tokens, modelo: t.modeloReal || t.modelo || '', janela, pct: janela ? Math.min(100, Math.round((tokens / janela) * 100)) : null };
          publicar(t);
        }
        break;
      }
      case 'error': if (params.willRetry === false || params.willRetry === undefined) t.erroMsg = corta(params.error?.message || 'erro', 300); break;
      case 'thread/compacted': if (t.compactando) acabarCompactacao(t, t.compactando); break; // contexto: o thread/tokenUsage/updated seguinte
      case 'turn/completed': finalizar(t, params.turn); break;
      default: break;
    }
  }

  // Pedidos de aprovação/pergunta (etapa 3): entram na fila da sessão como no Claude (status `aguardando`, `controle.permissao`
  // = 1º, `pendentes`) e a promessa só resolve quando o usuário responde (POST .../permissao), o servidor cancela
  // (serverRequest/resolved) ou o turno acaba. `opcoes.aoPedido` continua como gancho (teste/override).
  async function pedido(p, method, params, rid) {
    if (typeof opcoes.aoPedido === 'function') {
      const r = await opcoes.aoPedido(params?.threadId || params?.conversationId, method, params);
      if (r !== undefined) return r;
    }
    const tid = params?.threadId || params?.conversationId;
    const t = tid ? threads.get(tid) : null;
    if (!t || t.proc !== p || parando) { log('codex', 'pedido de thread que não é do Orbit, recusado:', method); return recusar(method); }
    let q;
    try { q = traduzirPedido(method, params, { cwd: t.cwd, item: t.itens.get(String(params.itemId || '')) }); } catch (e) { log('codex', 'pedido não entendido, recusado:', method, e?.message); return recusar(method); }
    if (q.bloquear) {
      // Acesso além da pasta do projeto/total: nunca concedido sozinho (pendência do usuário). Recusa e deixa registrado.
      log('codex', 'pedido recusado por segurança:', method, q.bloquear);
      registrarBloqueio(t, q.bloquear);
      return q.negar('Recusado pelo Orbit: ' + q.bloquear);
    }
    if (t.escritorio) {
      // B1a: escritório pausado nega tudo; senão todo pedido passa pelo classificar() (externa = só "permitir uma vez").
      if (pausadoDe(t)) {
        log('codex', 'escritório pausado: pedido recusado', method, t.id);
        registrarBloqueio(t, 'o escritório está pausado');
        return q.negar('Recusado pelo Orbit: o escritório está pausado.');
      }
      // C1: grantRoot libera escrita na raiz pedida pela sessão inteira (inclusive .codex/ e .git/): nunca em escritório.
      if (q.ferramenta === 'FileChange' && params?.grantRoot) {
        log('codex', 'escritório: fileChange com grantRoot recusado', t.id);
        registrarBloqueio(t, 'liberar escrita numa pasta para a sessão inteira não é permitido em escritório');
        return q.negar('Recusado pelo Orbit: liberar escrita numa pasta para a sessão inteira não é permitido em escritório.');
      }
      const item = t.itens.get(String(params?.itemId || ''));
      const fcs = params?.fileChanges && typeof params.fileChanges === 'object' ? params.fileChanges : {};
      const arquivos = (Array.isArray(item?.changes) ? item.changes.flatMap((c) => [c?.path, c?.kind?.move_path ?? c?.kind?.movePath])
        : Object.entries(fcs).flatMap(([k, v]) => [k, v?.move_path ?? v?.update?.move_path])).filter(Boolean).map(String); // destino de "mover" conta
      let d;
      try { d = externaDoPedido(method, params, q, t.travas || {}, arquivos, { cwd: t.cwd, home }); } catch { d = FALHA_AVALIAR; }
      if (d) { q.externa = true; q.descricaoExterna = corta(d, 200); q.sugestoes = []; q.cruas = []; }
    }
    return new Promise((resolve) => {
      t.pedidos.push({ id: String(rid ?? crypto.randomUUID()), rid, q, resolve, ts: Date.now() });
      t.status = 'aguardando'; t.motivo = detalheDe(t.pedidos[0].q); t.ferramenta = null;
      publicar(t);
    });
  }
  function registrarBloqueio(t, motivo) {
    emitirItens(t.id, normalizarLinha({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'error', message: `Pedido recusado pelo Orbit: ${motivo}` } }, `b${Date.now()}`));
  }
  // Depois de mexer na fila: sem pedidos volta a `trabalhando` (se há turno); com pedidos mostra o próximo.
  function aposFila(t) {
    if (t.pedidos.length) { t.status = 'aguardando'; t.motivo = detalheDe(t.pedidos[0].q); }
    else if (t.status === 'aguardando') { t.status = t.turno || t.iniciando ? 'trabalhando' : t.status; t.motivo = ''; }
    publicar(t);
  }
  // Fim do turno/processo/sessão: todos os pedidos abertos saem da fila e nada é escrito de volta (o servidor já os resolveu).
  function descartarPedidos(t) {
    if (!t.pedidos.length) return;
    for (const e of t.pedidos.splice(0)) e.resolve(SEM_RESPOSTA);
    if (t.status === 'aguardando') { t.status = 'trabalhando'; t.motivo = ''; }
  }

  // POST .../permissao {id, decisao:'permitir'|'negar', mensagem?, sugestao?, respostas?}
  function permissao(t, b) {
    if (typeof b.id !== 'string' || !b.id) throw erroHttp(400, 'id ausente');
    if (b.decisao !== 'permitir' && b.decisao !== 'negar') throw erroHttp(400, "decisao deve ser 'permitir' ou 'negar'");
    if (b.mensagem != null && (typeof b.mensagem !== 'string' || b.mensagem.length > MAX_MOTIVO)) throw erroHttp(400, `mensagem deve ser texto de até ${MAX_MOTIVO} caracteres`);
    const i = t ? t.pedidos.findIndex((x) => x.id === b.id) : -1;
    if (i < 0) throw erroHttp(404, 'pedido de permissão não encontrado (já respondido?)');
    const e = t.pedidos[i], q = e.q;
    const mensagem = (b.mensagem || '').trim();
    if (t.escritorio && b.decisao !== 'negar' && pausadoDe(t)) { // C1 (P2-3): a pausa chegou depois do pedido: nega
      t.pedidos.splice(i, 1);
      e.resolve(q.negar('Recusado pelo Orbit: o escritório está pausado.'));
      registrarBloqueio(t, 'o escritório está pausado');
      aposFila(t);
      throw erroHttp(409, 'O escritório está pausado: o pedido foi negado.', 'pausado');
    }
    let resultado;
    if (b.decisao === 'negar') resultado = q.negar(mensagem || (q.tipo === 'pergunta' ? '' : 'O usuário negou pelo Orbit.'));
    else if (q.tipo === 'pergunta') resultado = q.responder(b.respostas);
    else if (b.sugestao != null) {
      if (q.externa) throw erroHttp(400, 'Ação externa: só pode ser permitida uma vez (sem sugestão).', 'externa'); // B1a
      if (!Number.isInteger(b.sugestao) || !q.sugestoes.some((s) => s.indice === b.sugestao)) throw erroHttp(400, `Sugestão inexistente: ${corta(String(b.sugestao), 20)}.`);
      resultado = q.cruas[b.sugestao];
    } else resultado = q.aprovar;
    t.pedidos.splice(i, 1);
    e.resolve(resultado);
    aposFila(t);
  }

  // ───────── fluxo da conversa (SSE) ─────────
  function enviarFluxos(id, tipo, dados) {
    const set = fluxos.get(id);
    if (!set?.size) return;
    const bloco = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
    for (const f of [...set]) { try { f.res.write(bloco); } catch { set.delete(f); } }
  }
  function emitirItens(id, itens) { if (itens?.length) enviarFluxos(id, 'itens', { itens }); }
  // Texto ao vivo: no máximo um envio a cada MS_PARCIAL (o primeiro sai na hora); `texto` é o acumulado.
  function parcial(t, itemId, delta) {
    if (!itemId) return;
    const x = t.parciais.get(itemId) || { id: itemId, texto: '', sujo: false };
    x.texto += delta;
    t.parciais.set(itemId, x);
    if (!t.parcTimer) {
      enviarFluxos(t.id, 'parcial', { id: x.id, texto: x.texto });
      t.parcTimer = setTimeout(() => {
        t.parcTimer = null;
        for (const y of t.parciais.values()) if (y.sujo) { y.sujo = false; enviarFluxos(t.id, 'parcial', { id: y.id, texto: y.texto }); }
      }, MS_PARCIAL);
      t.parcTimer.unref?.();
    } else x.sujo = true;
  }
  function abrirFluxo(req, res, id) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const f = { res };
    const set = fluxos.get(id) || new Set();
    fluxos.set(id, set);
    set.add(f);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, MS_PING);
    ping.unref?.();
    const sair = () => { clearInterval(ping); set.delete(f); };
    req.on('close', sair);
    res.on('error', sair);
  }

  // ───────── turnos ─────────
  function liberarEsperas(t) { for (const f of t.esperas.splice(0)) f(); }
  function esperarFim(t, ms = MS_FIM_TURNO) {
    return new Promise((resolve, reject) => {
      const f = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { const i = t.esperas.indexOf(f); if (i >= 0) t.esperas.splice(i, 1); reject(new Error('A volta não parou a tempo.')); }, ms);
      t.esperas.push(f);
    });
  }

  function finalizar(t, turn) {
    const id = turn?.id;
    if (id) { t.finalizados.add(id); if (t.finalizados.size > 30) t.finalizados.delete(t.finalizados.values().next().value); }
    if (t.turno && (!id || t.turno.id === id)) t.turno = null;
    t.ferramenta = null;
    descartarPedidos(t);
    const st = String(turn?.status || 'completed');
    // a compactação roda como um turno próprio no Codex: se terminou sem `thread/compacted`, o turno decide
    if (t.compactando && !t.turno) acabarCompactacao(t, t.compactando, st === 'completed' ? null : new Error(st === 'interrupted' ? 'A compactação foi interrompida.' : corta(turn?.error?.message || t.erroMsg || 'A compactação falhou', 300)), false);
    if (st === 'interrupted') emitirItens(t.id, normalizarLinha({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'turn_aborted' } }, `i${id || Date.now()}`));
    else if (st === 'failed') {
      const msg = corta(turn?.error?.message || t.erroMsg || 'O turno falhou', 2000);
      emitirItens(t.id, normalizarLinha({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'error', message: msg } }, `e${id || Date.now()}`));
      t.erroMsg = msg;
    }
    liberarEsperas(t);
    emitirFim(t, st); // B1a: todo turno que acaba (inclusive o interrompido por um 'now')
    if (t.suprimirFim) return; // 'now': outro turno começa já, sem passar por interrompida
    if (t.fila.length) { avisarFim(t, st); seguirFila(t, st); return; }
    publicarFim(t, st);
  }
  // etapa 5: uma linha ao líder (controle.avisarLider) quando um turno do membro acaba. Só com `avisarLider` no criar.
  function avisarFim(t, st) {
    if (!t.avisar || !t.pai || !deps.avisarLider) return;
    const nome = corta(t.nome || path.basename(t.cwd || '') || t.id.slice(0, 8), 60);
    const resp = corta(t.ultimaResposta, 300);
    const texto = st === 'interrupted' ? `Membro Codex ${nome} foi interrompido.`
      : st === 'failed' ? `Membro Codex ${nome} deu erro: ${corta(t.erroMsg || 'o turno falhou', 300)}`
      : `Membro Codex ${nome} concluiu${resp ? ': ' + resp : '.'}`;
    try {
      const ok = deps.avisarLider(t.pai, texto);
      if (!ok) log('codex', 'aviso ao líder não entregue', t.pai);
    } catch (e) { log('codex', 'aviso ao líder falhou', e?.message || e); }
  }
  function publicarFim(t, st, avisar = true) {
    if (st === 'interrupted') { t.status = 'interrompida'; t.motivo = 'Interrompida'; }
    else if (st === 'failed') { t.status = 'erro'; t.motivo = t.erroMsg || 'O turno falhou'; }
    else { t.status = 'concluida'; t.motivo = ''; }
    publicar(t);
    if (avisar) avisarFim(t, st);
  }
  function seguirFila(t, st) {
    const prox = t.fila.shift();
    iniciarTurno(t, prox.texto).then(() => concluir(prox.a)).catch((e) => { falhar(prox.a, e.message); if (!t.turno && !t.iniciando) publicarFim(t, st); });
  }

  // turn/start; t.iniciando serializa mensagens que chegam durante o envio.
  function iniciarTurno(t, texto) {
    t.perdido = false;
    t.textoTurno = '';
    const corrida = (async () => {
      if (!vivo(t)) throw erroHttp(409, 'O Codex não está rodando para esta sessão.', 'sem_processo');
      const params = { threadId: t.id, input: [{ type: 'text', text: texto, text_elements: [] }] };
      if (t.modelo) params.model = t.modelo;
      if (t.esforco) params.effort = t.esforco;
      if (t.escritorio) { // B1a: reforça a cada turno (vale para este e os seguintes)
        params.approvalPolicy = APROVACAO_ESCRITORIO;
        params.sandboxPolicy = { ...SANDBOX_TURNO_ESCRITORIO };
        if (t.desligados?.plugins?.length) params.disabledPluginIds = [...t.desligados.plugins];
      }
      const r = await t.proc.cli.pedir('turn/start', params);
      const tid = r?.turn?.id;
      // A notificação turn/started pode ter chegado antes (ou o turno até terminado): só assume o que ainda não foi visto.
      if (!t.turno && tid && !t.finalizados.has(tid)) {
        t.turno = { id: tid };
        if (t.status !== 'trabalhando' && !t.pedidos.length) { t.status = 'trabalhando'; t.motivo = ''; t.ferramenta = null; publicar(t); }
      }
    })();
    t.iniciando = corrida;
    const limpar = () => { if (t.iniciando === corrida) t.iniciando = null; };
    corrida.then(limpar, limpar);
    return corrida;
  }

  async function interromper(t) {
    if (t.iniciando) await t.iniciando.catch(() => {});
    if (!t.turno || !vivo(t)) return false;
    const fim = esperarFim(t);
    fim.catch(() => {});
    try {
      await t.proc.cli.pedir('turn/interrupt', { threadId: t.id, turnId: t.turno.id });
    } catch (e) {
      if (t.turno) throw e; // o turno já tinha terminado por conta própria: tudo certo
    }
    await fim;
    return true;
  }

  // Sobe o processo (se preciso) e anexa o thread a ele com thread/resume.
  function anexar(t) {
    if (vivo(t)) return Promise.resolve();
    if (t.anexando) return t.anexando;
    t.acordando = true;
    difundirEstado(t);
    const corrida = (async () => {
      try {
        const p = await garantirProcesso();
        const params = { threadId: t.id, approvalPolicy: APROVACAO, sandbox: SANDBOX, ...(t.escritorio ? await prepararEscritorio(p, t) : {}) };
        if (t.cwd) params.cwd = t.cwd;
        if (t.modelo) params.model = t.modelo;
        const r = await p.cli.pedir('thread/resume', params);
        if (p.morto) throw erroHttp(502, 'O Codex saiu logo depois de subir.', 'sem_processo');
        if (t.escritorio) await conferirEscritorio(p, t.id); // C1: falha fechada (o thread fica dormindo)
        if (r?.model) t.modeloReal = String(r.model);
        if (r?.reasoningEffort) t.esforcoReal = String(r.reasoningEffort);
        t.proc = p; t.geracao = p.geracao;
      } catch (e) {
        throw e.status ? e : erroHttp(502, `Não consegui retomar o thread no Codex: ${e.message}`, 'sem_processo');
      } finally {
        t.acordando = false; t.anexando = null; difundirEstado(t);
      }
    })();
    t.anexando = corrida;
    corrida.catch(() => {});
    return corrida;
  }

  // ───────── operações ─────────
  function validarTexto(b) {
    const texto = typeof b.texto === 'string' ? b.texto : '';
    if (!texto.trim() || texto.length > MAX_TEXTO) throw erroHttp(400, `texto deve ter de 1 a ${MAX_TEXTO} caracteres`);
    return texto;
  }

  // Envia (ou enfileira) uma mensagem; devolve a Acao. 'next' durante um turno espera o fim; 'now' interrompe e envia.
  function enviarMensagem(t, texto, prioridade) {
    const a = novaAcao(t.id, 'mensagem');
    (async () => {
      try {
        await anexar(t);
        if (t.turno || t.iniciando || t.compactando) {
          if (prioridade === 'now' && !t.compactando) {
            etapa(a, 'Interrompendo');
            t.suprimirFim = true;
            try {
              await interromper(t);
              await iniciarTurno(t, texto);
            } finally { t.suprimirFim = false; }
            if (!t.turno && !t.iniciando) publicarFim(t, 'interrupted');
          } else {
            etapa(a, 'Na fila');
            t.fila.push({ texto, a });
            return;
          }
        } else await iniciarTurno(t, texto);
        concluir(a);
      } catch (e) { falhar(a, e.message || e); }
    })();
    return a;
  }

  // `esc` (só pela ponte, nunca pelo HTTP): { escritorio:{id,execucao,papel}, instrucoes, travas } validado em ponte.criar.
  async function criar(b, esc = null) {
    const bruta = typeof b.pasta === 'string' ? b.pasta.trim() : '';
    if (!bruta) throw erroHttp(400, 'Escolha a pasta da instância.');
    if (!path.isAbsolute(bruta)) throw erroHttp(400, 'Use o caminho completo da pasta.');
    const pasta = path.resolve(bruta);
    let st;
    try { st = await fsp.stat(pasta); } catch { throw erroHttp(400, `A pasta "${pasta}" não existe.`); }
    if (!st.isDirectory()) throw erroHttp(400, `"${pasta}" não é uma pasta.`);
    if (b.modelo != null && (typeof b.modelo !== 'string' || (b.modelo.trim() && !/^[\w.:/\-[\]]{1,100}$/.test(b.modelo.trim())))) throw erroHttp(400, 'Modelo inválido.');
    if (b.esforco != null && (typeof b.esforco !== 'string' || (b.esforco.trim() && !/^[a-z]{1,12}$/.test(b.esforco.trim())))) throw erroHttp(400, 'Esforço inválido.');
    if (b.nome != null && typeof b.nome !== 'string') throw erroHttp(400, 'O nome deve ser texto.');
    const nome = (b.nome || '').replace(/\s+/g, ' ').trim();
    if (nome.length > MAX_NOME) throw erroHttp(400, `O nome pode ter até ${MAX_NOME} caracteres.`);
    if (b.texto != null && typeof b.texto !== 'string') throw erroHttp(400, 'A 1ª mensagem deve ser texto.');
    const texto = b.texto || '';
    if (texto.length > MAX_TEXTO) throw erroHttp(400, `A 1ª mensagem pode ter até ${MAX_TEXTO} caracteres.`);
    // etapa 5: membro de time. `pai` = sessão do líder (precisa existir e NÃO ser Codex); `avisarLider` só com pai.
    if (b.pai != null && (typeof b.pai !== 'string' || b.pai.length > 100)) throw erroHttp(400, 'pai inválido.');
    const pai = (b.pai || '').trim();
    if (pai) {
      const m = deps.sessao?.(pai);
      if (!m) throw erroHttp(400, 'A sessão do líder (pai) não existe.');
      if (m.provedor === 'codex') throw erroHttp(400, 'O Codex não pode ser líder: o pai deve ser uma sessão do Claude.');
    }
    if (b.avisarLider != null && typeof b.avisarLider !== 'boolean') throw erroHttp(400, 'avisarLider deve ser verdadeiro ou falso.');
    if (b.avisarLider && !pai) throw erroHttp(400, 'avisarLider precisa de um pai (o líder).');
    let modelo = (b.modelo || '').trim(), esforco = (b.esforco || '').trim();
    // etapa 4: modelo/esforço têm de estar na lista do model/list (400 se não)
    if ((modelo || esforco) && opcoes.validar) ({ modelo, esforco } = await opcoes.validar(modelo, esforco, ''));

    const p = await garantirProcesso();
    const base = esc ? { cwd: pasta, escritorio: { ...esc.escritorio }, instrucoes: esc.instrucoes || '', travas: esc.travas || {} } : null;
    const params = { cwd: pasta, approvalPolicy: APROVACAO, sandbox: SANDBOX, ...(base ? await prepararEscritorio(p, base) : {}) };
    if (modelo) params.model = modelo;
    let r;
    try { r = await p.cli.pedir('thread/start', params); } catch (e) { throw erroHttp(502, `O Codex não criou o thread: ${e.message}`, 'sem_thread'); }
    const id = r?.thread?.id;
    if (!id) throw erroHttp(502, 'O Codex não devolveu o id do thread.', 'sem_thread');
    if (p.morto) throw erroHttp(502, 'O Codex saiu logo depois de subir.', 'sem_processo');
    if (base) await conferirEscritorio(p, id); // C1: falha fechada (thread descarregado, nada registrado nem vinculado)
    const t = registro(id, { cwd: pasta, modelo, esforco, nome, origem: 'orbit', proc: p, geracao: p.geracao, criando: false, pai, avisar: !!(pai && b.avisarLider), ...(base || {}) });
    if (base) {
      const { pausado, ...dados } = base.travas; // a função não persiste: depois de um reinício volta por ponte.vincular
      vinculos.set(id, { escritorio: base.escritorio, cwd: pasta, nome, modelo, esforco, pai, instrucoes: base.instrucoes, travas: dados, criado: Date.now() });
      gravarVinculos();
    }
    if (r.model) t.modeloReal = String(r.model);
    if (r.reasoningEffort) t.esforcoReal = String(r.reasoningEffort);
    const a = novaAcao(id, 'criar');
    etapa(a, 'Iniciando');
    publicar(t, { inicio: Date.now() });
    concluir(a);
    if (texto.trim()) enviarMensagem(t, texto);
    return { acao: a, sessao: id };
  }

  // ───────── etapa 4: compactar, modelo e esforço ─────────
  // Fecha a compactação em curso (ok = sem erro). `pub=false`: quem chamou publica o estado depois (turno próprio da compactação).
  function acabarCompactacao(t, c, erro = null, pub = true) {
    if (t.compactando !== c) return;
    clearTimeout(c.timer);
    t.compactando = null;
    if (erro) falhar(c.a, erro.message || erro); else concluir(c.a, { pre: c.pre ?? undefined, foco: c.foco ? 'ignorado' : undefined });
    if (!pub || t.turno || t.iniciando) return;
    if (t.fila.length) seguirFila(t, 'completed'); else publicarFim(t, 'completed', false);
  }

  // thread/compact/start só tem threadId: o Codex não aceita foco (é ignorado e a Acao avisa). Só com o turno parado.
  function compactar(t, b) {
    if (b.foco !== undefined && b.foco !== null && (typeof b.foco !== 'string' || b.foco.length > MAX_FOCO)) throw erroHttp(400, `foco deve ser texto de até ${MAX_FOCO} caracteres`);
    const foco = String(b.foco || '').replace(/\s+/g, ' ').trim();
    if (t.compactando) throw erroHttp(409, 'A sessão já está compactando.', 'compactando');
    if (t.turno || t.iniciando || t.fila.length || t.pedidos.length) throw erroHttp(409, 'A sessão está trabalhando. Espere a volta terminar (ou pare) para compactar.', 'ocupada');
    const a = novaAcao(t.id, 'compactar');
    etapa(a, foco ? 'Compactando (o Codex não aceita foco: foi ignorado)' : 'Compactando');
    const c = { a, pre: t.contexto?.tokens ?? null, foco: !!foco, timer: null };
    t.compactando = c; // mensagens que chegarem agora esperam na fila
    (async () => {
      try {
        await anexar(t);
        if (t.turno || t.iniciando) throw new Error('A sessão começou uma volta antes da compactação; tente de novo quando terminar.');
        t.status = 'trabalhando'; t.motivo = 'Compactando o contexto'; t.ferramenta = null; publicar(t);
        c.timer = setTimeout(() => acabarCompactacao(t, c, new Error('A compactação não terminou em 2 min.')), MS_COMPACTAR);
        c.timer.unref?.();
        await t.proc.cli.pedir('thread/compact/start', { threadId: t.id });
      } catch (e) { acabarCompactacao(t, c, e); }
    })();
    return a;
  }

  // Valem a partir do próximo turn/start (iniciarTurno manda model/effort a cada turno). A Acao conclui na hora.
  async function trocarModelo(t, b) {
    const v = typeof b.modelo === 'string' ? b.modelo.trim() : '';
    if (!v) throw erroHttp(400, 'Escolha o modelo.');
    if (!opcoes.validar) throw erroHttp(503, 'Sem a lista de modelos do Codex.', 'sem_modelos');
    const modelo = (await opcoes.validar(v, '', '')).modelo;
    let esforco = t.esforco || t.esforcoReal || '';
    if (esforco) { try { await opcoes.validar(modelo, esforco, ''); } catch (e) { if (e.status !== 400) throw e; esforco = ''; } } // o modelo novo não tem esse nível: volta ao padrão dele
    t.modelo = modelo; t.modeloReal = modelo;
    t.esforco = esforco; t.esforcoReal = esforco;
    publicar(t);
    return ajusteFeito(t, 'modelo', { modelo, esforco });
  }
  async function trocarEsforco(t, b) {
    const e = typeof b.esforco === 'string' ? b.esforco.trim() : '';
    if (!e) throw erroHttp(400, 'Escolha o esforço.');
    if (!opcoes.validar) throw erroHttp(503, 'Sem a lista de modelos do Codex.', 'sem_modelos');
    const esforco = (await opcoes.validar('', e, t.modeloReal || t.modelo || '')).esforco;
    t.esforco = esforco; t.esforcoReal = esforco;
    publicar(t);
    return ajusteFeito(t, 'esforco', { modelo: t.modeloReal || t.modelo || '', esforco });
  }
  function ajusteFeito(t, tipo, resultado) {
    const a = novaAcao(t.id, tipo);
    etapa(a, 'Vale no próximo turno');
    concluir(a, { ...resultado, nota: 'Vale a partir do próximo turno' });
    return a;
  }

  function mensagem(t, b) {
    const texto = validarTexto(b);
    if (b.prioridade !== undefined && b.prioridade !== 'next' && b.prioridade !== 'now') throw erroHttp(400, "prioridade deve ser 'next' ou 'now'");
    return enviarMensagem(t, texto, b.prioridade);
  }

  function parar(t) {
    const a = novaAcao(t.id, 'parar');
    (async () => {
      try {
        if (!vivo(t) || (!t.turno && !t.iniciando)) throw new Error('A sessão não está trabalhando.');
        // O pedido de parar cancela também o que estava na fila.
        for (const f of t.fila.splice(0)) falhar(f.a, 'Cancelada: a volta foi interrompida.');
        if (!(await interromper(t))) throw new Error('A volta já tinha terminado.');
        concluir(a);
      } catch (e) { falhar(a, e.message || e); }
    })();
    return a;
  }

  function retomar(t, eraMeu = true) {
    const a = novaAcao(t.id, 'retomar');
    etapa(a, 'Retomando');
    // Sessão só monitorada que não conseguiu subir continua só monitorada (o registro some de novo).
    anexar(t).then(() => concluir(a), (e) => { if (!eraMeu && !vivo(t)) { threads.delete(t.id); difundirEstado(t); } falhar(a, e.message || e); });
    return a;
  }

  // Só esquece localmente: o thread continua no app-server/rollout, a sessão sai da lista do Orbit.
  function encerrar(id) {
    const a = novaAcao(id, 'encerrar');
    if (vinculos.delete(id)) gravarVinculos(); // B1a: some da lista do escritório
    (async () => {
      const t = threads.get(id);
      try {
        if (t) {
          t.fila.splice(0).forEach((f) => falhar(f.a, 'A sessão foi encerrada.'));
          if (vivo(t) && t.turno) await t.proc.cli.pedir('turn/interrupt', { threadId: id, turnId: t.turno.id }).catch(() => {});
          if (t.compactando) { clearTimeout(t.compactando.timer); falhar(t.compactando.a, 'A sessão foi encerrada.'); t.compactando = null; }
          descartarPedidos(t);
          liberarEsperas(t);
          clearTimeout(t.parcTimer);
          threads.delete(id);
        }
        const set = fluxos.get(id);
        if (set) { for (const f of set) { try { f.res.end(); } catch {} } fluxos.delete(id); }
        deps.removerSessao?.(id);
        concluir(a);
      } catch (e) { falhar(a, e.message || e); }
    })();
    return a;
  }

  // ───────── rotas ─────────
  async function corpo(req) {
    const b = await deps.lerJSONCorpo(req, 256 * 1024);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw erroHttp(400, 'corpo inválido');
    return b;
  }

  async function rota(req, res, caminho, url) {
    try {
      if (caminho === '/codex/instancias') {
        if (req.method !== 'POST') { responder(res, 405, { erro: 'método não permitido' }); return true; }
        responder(res, 202, await criar(await corpo(req)));
        return true;
      }
      const m = RE_ROTA.exec(caminho);
      if (!m) return false;
      let id;
      try { id = decodeURIComponent(m[1]); } catch { responder(res, 400, { erro: 'id inválido' }); return true; }
      const acao = m[2];
      if ((req.method === 'GET') === POSTS.has(acao)) { responder(res, 405, { erro: 'método não permitido' }); return true; }
      const s = deps.sessao?.(id);
      if (!threads.has(id) && !vinculos.has(id) && (!s || s.provedor !== 'codex')) { responder(res, 404, { erro: 'sessão não encontrada' }); return true; }
      if (acao === 'conversa/fluxo') { abrirFluxo(req, res, id); return true; }
      if (acao === 'acoes') { responder(res, 200, (acoes.get(id) || []).slice(-MAX_ACOES)); return true; }
      if (acao === 'encerrar') { await corpo(req); responder(res, 202, { acao: encerrar(id) }); return true; }
      if (acao === 'permissao') { const b = await corpo(req); permissao(threads.get(id), b); responder(res, 200, { ok: true }); return true; }
      const meu = ehMeu(id, s); // antes de threadDe, que registra o thread
      const t = threadDe(id);
      if (!t) { responder(res, 404, { erro: 'sessão não encontrada' }); return true; }
      const b = await corpo(req);
      if (acao === 'retomar') { responder(res, 202, { acao: retomar(t, meu) }); return true; }
      // mensagem/parar só valem para a instância do Orbit (criada aqui, ou assumida por /retomar); as outras: assuma antes.
      if (!meu) { threads.delete(id); throw erroHttp(409, 'A sessão não está no Orbit. Assuma no Orbit para fazer isso.', 'nao_assumida'); }
      if (acao === 'mensagem') { responder(res, 202, { acao: mensagem(t, b) }); return true; }
      if (acao === 'compactar') { responder(res, 202, { acao: compactar(t, b) }); return true; }
      if (acao === 'modelo') { responder(res, 202, { acao: await trocarModelo(t, b) }); return true; }
      if (acao === 'esforco') { responder(res, 202, { acao: await trocarEsforco(t, b) }); return true; }
      responder(res, 202, { acao: parar(t) });
      return true;
    } catch (e) {
      if (!e.status) throw e;
      responder(res, e.status, e.codigo ? { erro: e.message, codigo: e.codigo } : { erro: e.message });
      return true;
    }
  }

  // Desliga tudo (chave desligada ou servidor saindo): encerra o app-server; nenhum processo do Codex sobra.
  function parar_() {
    parando = true;
    const p = proc;
    proc = null;
    for (const t of threads.values()) { clearTimeout(t.parcTimer); if (t.compactando) { clearTimeout(t.compactando.timer); falhar(t.compactando.a, 'O Codex foi desligado.'); t.compactando = null; } descartarPedidos(t); liberarEsperas(t); for (const f of t.fila.splice(0)) falhar(f.a, 'O Codex foi desligado.'); }
    for (const set of fluxos.values()) for (const f of set) { try { f.res.end(); } catch {} }
    fluxos.clear();
    threads.clear();
    if (!p) return Promise.resolve();
    p.morto = true;
    return (p.cli ? p.cli.fechar() : p.pronto.then((x) => x.cli.fechar(), () => {})).catch(() => {});
  }

  // ───────── B1a: ponte para outro módulo do servidor (sem HTTP) ─────────
  function validarEscritorio(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw erroHttp(400, 'escritorio deve ser { id, execucao, papel }.');
    const o = {};
    for (const k of ['id', 'execucao', 'papel']) {
      const v = e[k];
      if (typeof v !== 'string' || !v.trim() || v.length > MAX_CAMPO_ESC) throw erroHttp(400, `escritorio.${k} deve ser texto de 1 a ${MAX_CAMPO_ESC} caracteres.`);
      o[k] = v.trim();
    }
    return o;
  }
  function validarTravas(tv) {
    if (tv == null) return {};
    if (typeof tv !== 'object' || Array.isArray(tv)) throw erroHttp(400, 'travas deve ser { extras, porta, raiz, pausado }.');
    const o = {};
    if (tv.extras != null) {
      if (!Array.isArray(tv.extras)) throw erroHttp(400, 'travas.extras deve ser uma lista de textos.');
      o.extras = tv.extras.filter((x) => typeof x === 'string' && x && x.length <= 200).slice(0, 200);
    }
    if (tv.porta != null) { const n = Number(tv.porta); if (!Number.isInteger(n) || n < 1 || n > 65535) throw erroHttp(400, 'travas.porta inválida.'); o.porta = n; }
    if (tv.raiz != null) { if (typeof tv.raiz !== 'string' || tv.raiz.length > 1000) throw erroHttp(400, 'travas.raiz inválida.'); o.raiz = tv.raiz; }
    if (tv.pausado != null) { if (typeof tv.pausado !== 'function') throw erroHttp(400, 'travas.pausado deve ser uma função.'); o.pausado = tv.pausado; }
    return o;
  }
  function validarInstrucoes(s) {
    if (s == null) return '';
    if (typeof s !== 'string' || s.length > MAX_INSTRUCOES) throw erroHttp(400, `instrucoes deve ser texto de até ${MAX_INSTRUCOES} caracteres.`);
    return s;
  }
  // Só threads do Orbit (criados aqui, assumidos ou de escritório persistido).
  function threadMeu(sessao) {
    const id = typeof sessao === 'string' ? sessao : '';
    if (!id || !ehMeu(id, deps.sessao?.(id))) throw erroHttp(404, 'sessão não encontrada', 'sem_sessao');
    const t = threadDe(id);
    if (!t) throw erroHttp(404, 'sessão não encontrada', 'sem_sessao');
    return t;
  }
  const ponte = {
    // → { sessao, acao }. Com `escritorio`: modo escritório (vínculo persistido). `instrucoes`/`travas` só com ele.
    async criar(b = {}) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw erroHttp(400, 'corpo inválido');
      let esc = null;
      if (b.escritorio != null) esc = { escritorio: validarEscritorio(b.escritorio), instrucoes: validarInstrucoes(b.instrucoes), travas: validarTravas(b.travas) };
      else if (b.instrucoes != null || b.travas != null) throw erroHttp(400, 'instrucoes e travas só valem com escritorio.');
      const r = await criar({ pasta: b.pasta, nome: b.nome, modelo: b.modelo, esforco: b.esforco, pai: b.pai, avisarLider: b.avisarLider, texto: b.texto }, esc);
      return { sessao: r.sessao, acao: r.acao };
    },
    // → Acao 'mensagem'. prioridade 'next' (padrão: espera o turno) ou 'now' (interrompe e envia). Dormindo: thread/resume.
    enviar(sessao, texto, prioridade) {
      const t = threadMeu(sessao);
      const tx = validarTexto({ texto });
      if (prioridade != null && prioridade !== 'next' && prioridade !== 'now') throw erroHttp(400, "prioridade deve ser 'next' ou 'now'");
      return enviarMensagem(t, tx, prioridade || undefined);
    },
    // Cancela a fila e interrompe o turno; resolve depois do turn/completed (até 15 s). true = havia turno.
    async interromper(sessao) {
      const t = threadMeu(sessao);
      for (const f of t.fila.splice(0)) falhar(f.a, 'Cancelada: a volta foi interrompida.');
      if (!vivo(t)) return false;
      return interromper(t);
    },
    // Esquece no Orbit (e o vínculo, na hora); o thread continua no rollout. → Acao 'encerrar'.
    encerrar(sessao) { threadMeu(sessao); return encerrar(sessao); },
    // Estado de controle (formato do controle.estado) + status/ultimaResposta/tokens; null se não é do Orbit.
    estado(sessao) {
      const id = typeof sessao === 'string' ? sessao : '';
      const s = id ? deps.sessao?.(id) : null;
      if (!id || !ehMeu(id, s)) return null;
      const t = threads.get(id) || (vinculos.has(id) ? threadDe(id) : null);
      const o = estado({ ...(s || {}), id });
      if (!o) return null;
      return { ...o, status: t?.status || s?.status || 'nova', ultimaResposta: t?.ultimaResposta || s?.ultimaResposta || '', tokens: t?.tokensTotal ? { ...t.tokensTotal } : null };
    },
    // Threads de escritório conhecidos (persistidos): sobrevive ao reinício do servidor.
    listarEscritorio() {
      return [...vinculos].map(([id, v]) => { const t = threads.get(id); return { id, escritorio: { ...v.escritorio }, processo: t && vivo(t) ? 'vivo' : 'dormindo' }; });
    },
    // fn({ sessao, texto, erro, tokens, modelo, geracao, status, escritorio? }) no fim de cada turno → off().
    ouvirFim(fn) {
      if (typeof fn !== 'function') throw new TypeError('ouvirFim precisa de uma função');
      ouvintesFim.add(fn);
      return () => { ouvintesFim.delete(fn); };
    },
    // fn({ sessao, tokens (acumulado do thread), modelo, geracao, escritorio }) a cada atualização de uso de um thread de escritório → off().
    ouvirUso(fn) {
      if (typeof fn !== 'function') throw new TypeError('ouvirUso precisa de uma função');
      ouvintesUso.add(fn);
      return () => { ouvintesUso.delete(fn); };
    },
    // Reidratação: devolve as travas (pausado é função, não persiste) e/ou troca as instruções (valem no próximo resume).
    vincular(sessao, { instrucoes, travas } = {}) {
      const v = vinculos.get(sessao);
      if (!v) throw erroHttp(404, 'sessão de escritório não encontrada', 'sem_sessao');
      const t = threadDe(sessao);
      if (travas !== undefined) {
        const tv = validarTravas(travas);
        const { pausado, ...dados } = tv;
        v.travas = dados;
        if (t) { t.travas = tv; t.semVinculo = false; }
      }
      if (instrucoes !== undefined) { v.instrucoes = validarInstrucoes(instrucoes); if (t) t.instrucoes = v.instrucoes; }
      gravarVinculos();
      return true;
    },
  };

  return { rota, estado, complementar, chamar, vivo: () => !!proc && !proc.morto, parar: parar_, ponte, _threads: threads };
}
