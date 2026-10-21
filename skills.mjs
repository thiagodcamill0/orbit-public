// Skills (aba Skills da lateral). Página: assets/skills.js. Pesquisa e testes: cofre, 06 Referências/Claude Code
// por dentro, seção Skills (2.1.300, 17/10).
//
// Onde moram (o que o Orbit lê): <projeto>/.claude/skills/<nome>/SKILL.md (projeto), ~/.claude/skills/<nome>/
// (pessoais) e ~/.claude/skills/synced/<balde>/<nome>/ (claude.ai, só leitura: o app sincroniza e sobrescreve).
// As de plugin e o estado efetivo vêm da sonda (controle.sondarSkills: get_skills_dialog na pasta do projeto).
//
// Escrita:
//   - skills do projeto: livre (é o padrão de toda criação e duplicação);
//   - skills pessoais (~/.claude/skills, globais): só com `confirmarGlobal: true` no corpo; sem ele, 428
//     `confirmar_global` e nada muda. A página pergunta antes, dizendo que vale para todos os projetos;
//   - ativo/inativo: `skillOverrides` do <projeto>/.claude/settings.json (decisão do usuário, 17/10: vai para o
//     git e vale igual no Mac). Nunca o ~/.claude/settings.json. Ligar apaga a chave do projeto; só grava "on"
//     quando o settings pessoal desliga aquele nome (o "on" do projeto vence o "off" pessoal: testado). Uma
//     entrada no settings.local.json do projeto (que venceria o settings.json) sai junto.
//   - excluir: para a Lixeira do sistema (a do arquivos.mjs), nunca apaga de vez.
//
// Rotas: GET /skills?pasta · GET /skills/ler?pasta&origem&nome · GET /skills/arquivo?pasta&origem&nome&arq ·
// GET /skills/sessao?id · POST /skills/salvar · /skills/duplicar · /skills/excluir · /skills/estado ·
// /skills/arquivo · /skills/arquivo/excluir. Toda mudança difunde o SSE "skills" {pasta}.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ESTADOS = ['on', 'name-only', 'user-invocable-only', 'off'];
const RE_NOME = /^[a-z0-9][a-z0-9-]{0,63}$/; // a regra das skills: minúsculas, números e hífen, até 64
const MAX_SKILL_MD = 256 * 1024;
const MAX_ARQ_TEXTO = 512 * 1024;
const MAX_ARQUIVOS = 400;
const MS_SONDA_VALE = 30e3; // a lista da sonda vale 30 s (cada escrita do Orbit a invalida)
const MS_SONDA_ESPERA = 15e3;
const TRAVAS = {
  author: 'O autor da skill desligou o uso pelo modelo no cabeçalho (disable-model-invocation).',
  plugin: 'Vem de um plugin: o estado é do plugin (/plugin).',
  policy: 'Definido por uma política gerenciada.',
  flag: 'Definido por uma opção de linha de comando.',
  'reserved-name': 'O nome não pode ser guardado no settings; renomeie a pasta.',
};

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}
function erro(status, msg, codigo) {
  const e = new Error(msg);
  e.status = status;
  if (codigo) e.codigo = codigo;
  return e;
}
const chave = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const dentro = (filho, pai) => {
  const f = chave(filho), p = chave(pai);
  return f.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};
async function existe(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

// ───────────── cabeçalho (frontmatter YAML simples) ─────────────
// Lê só o nível de cima: `chave: valor` (simples, '…' ou "…") e blocos | / > com linhas recuadas. O resto
// do cabeçalho volta intacto em `extra` (o editor mostra como "Cabeçalho avançado").
export function lerSkillMd(texto) {
  const t = String(texto || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { campos: {}, extra: '', corpo: t, semCabecalho: true };
  const linhas = m[1].split('\n');
  const campos = {};
  const extra = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    const k = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(l);
    // linhas que continuam o item de cima (recuadas ou vazias)
    const cont = [];
    while (i + 1 < linhas.length && (/^[ \t]/.test(linhas[i + 1]) || (linhas[i + 1] === '' && i + 2 < linhas.length && /^[ \t]/.test(linhas[i + 2])))) cont.push(linhas[++i]);
    if (!k || (k[1] !== 'name' && k[1] !== 'description')) { extra.push(l, ...cont); continue; }
    campos[k[1]] = valorYaml(k[2], cont);
  }
  return { campos, extra: extra.join('\n').trim(), corpo: t.slice(m[0].length) };
}
function valorYaml(v, cont) {
  v = v.trim();
  if (/^[|>][+-]?$/.test(v)) {
    const ind = Math.min(...cont.filter((x) => x.trim()).map((x) => /^\s*/.exec(x)[0].length));
    const ls = cont.map((x) => x.slice(Number.isFinite(ind) ? ind : 0));
    return v[0] === '|' ? ls.join('\n').trim() : ls.join(' ').replace(/\s+/g, ' ').trim();
  }
  const resto = cont.map((x) => x.trim()).join(' ');
  const tudo = resto ? `${v} ${resto}` : v;
  if (tudo.startsWith("'")) return tudo.replace(/^'|'$/g, '').replace(/''/g, "'");
  if (tudo.startsWith('"')) { try { return JSON.parse(tudo); } catch { return tudo.replace(/^"|"$/g, ''); } }
  return tudo.replace(/\s+#.*$/, '');
}
// Texto como escalar YAML: simples quando dá; senão entre aspas duplas (JSON é YAML válido).
function yaml(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s && !/^[\s!&*?|>'"%@`#,[\]{}-]|: | #|[\u0000-\u001f]/.test(s) && !/^(true|false|null|yes|no|~|[\d.+-]+)$/i.test(s)) return s;
  return JSON.stringify(s);
}
export function montarSkillMd({ nome, descricao, extra, corpo }) {
  const cab = [`name: ${nome}`, `description: ${yaml(descricao)}`];
  const ex = String(extra || '').replace(/\r\n/g, '\n').trim();
  if (ex) cab.push(ex);
  const c = String(corpo || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return `---\n${cab.join('\n')}\n---\n\n${c}${c.endsWith('\n') ? '' : '\n'}`;
}

// ───────────── skills usadas (transcript) ─────────────
// Formatos vistos no 2.1.300: tool_use `Skill` {skill, args} (o modelo chamou); /nome digitado vira uma
// entrada user com <command-name>/nome</command-name> seguida de outra que começa com "Base directory for
// this skill" (os comandos que não são skill, como /clear, não têm a segunda).
export function novaLeituraUso() {
  return { off: 0, resto: '', pend: null, usadas: new Map() };
}
export function lerLinhasUso(est, texto) {
  const tudo = est.resto + texto;
  const linhas = tudo.split('\n');
  est.resto = linhas.pop();
  for (const l of linhas) {
    if (!l.includes('"Skill"') && !l.includes('command-name') && !l.includes('Base directory for this skill')) {
      if (est.pend && l.includes('"type":"user"')) est.pend = null;
      continue;
    }
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const ts = typeof j.timestamp === 'string' ? j.timestamp : '';
    const marcar = (nome, por) => {
      if (typeof nome !== 'string' || !nome.trim()) return;
      const n = nome.trim().replace(/^\//, '').slice(0, 200);
      const u = est.usadas.get(n) || { nome: n, vezes: 0, primeira: ts, ultima: ts, por: new Set() };
      u.vezes++;
      if (ts) u.ultima = ts;
      u.por.add(por);
      est.usadas.set(n, u);
    };
    if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) if (b?.type === 'tool_use' && b.name === 'Skill') marcar(b.input?.skill, 'modelo');
      continue;
    }
    if (j.type !== 'user') continue;
    const c = j.message?.content;
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
    if (est.pend && txt.startsWith('Base directory for this skill')) {
      marcar(est.pend, 'voce');
      est.pend = null;
      continue;
    }
    const m = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(txt);
    est.pend = m ? m[1] : null;
  }
}
export function resumoUso(est) {
  return [...est.usadas.values()]
    .map((u) => ({ nome: u.nome, vezes: u.vezes, primeira: u.primeira, ultima: u.ultima, por: [...u.por] }))
    .sort((a, b) => (b.ultima || '').localeCompare(a.ultima || '') || a.nome.localeCompare(b.nome));
}

// ───────────── módulo ─────────────
export function criarSkills(deps) {
  const {
    sessoes = () => [],
    sessao = () => null,
    pastaOrbit,
    dados,
    difundir = () => {},
    lerJSONCorpo,
    log = () => {},
    casa = os.homedir(),
    sondar = null, // (pasta) => Promise<linhas do get_skills_dialog>
    lixeira = null, // (absolutos) => Promise<enviados>
    permitidas = () => null, // (id) => allowlist da instância do Orbit (ou null)
  } = deps;
  const casaK = chave(casa);
  const PESSOAIS = path.join(casa, '.claude', 'skills');
  const SINCRONIZADAS = path.join(PESSOAIS, 'synced');
  const SETTINGS_PESSOAL = path.join(casa, '.claude', 'settings.json');

  let fila = Promise.resolve();
  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  function proibida(k) {
    return k === casaK || casaK.startsWith(k.endsWith(path.sep) ? k : k + path.sep) || path.parse(k).root === k;
  }
  // Pastas de projeto: a do Orbit, as da lateral (projetos.json) e o cwd das sessões, sem repetir.
  function pastas() {
    const m = new Map();
    const pos = (p, nome) => {
      if (typeof p !== 'string' || !p) return;
      const k = chave(p);
      if (m.has(k) || proibida(k)) return;
      try { if (!fs.statSync(p).isDirectory()) return; } catch { return; }
      m.set(k, { pasta: path.resolve(p), nome: nome || path.basename(p) });
    };
    if (pastaOrbit) pos(pastaOrbit, 'Orbit');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dados, 'projetos.json'), 'utf8'));
      for (const it of Array.isArray(j?.lista) ? j.lista : []) pos(it?.pasta, it?.nome);
    } catch {}
    for (const s of sessoes()) pos(s?.cwd, s?.projeto);
    return m;
  }
  function pastaValida(p) {
    if (typeof p !== 'string' || !p) throw erro(400, 'pasta ausente');
    const k = chave(p);
    if (proibida(k)) throw erro(403, 'Essa pasta é a pessoal (ou uma de cima dela): as skills dali valeriam para todos os projetos.');
    const it = pastas().get(k);
    if (!it) throw erro(404, 'Pasta desconhecida: só valem as pastas dos projetos e das sessões do Orbit.', 'pasta_desconhecida');
    return it.pasta;
  }

  // ── arquivos de settings ──
  async function lerJson(arq) {
    let bruto;
    try { bruto = await fsp.readFile(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { json: {}, existe: false };
      throw e;
    }
    const texto = bruto.replace(/^﻿/, '');
    if (!texto.trim()) return { json: {}, existe: true };
    let json;
    try { json = JSON.parse(texto); } catch { return { invalido: true, existe: true }; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { invalido: true, existe: true };
    return { json, existe: true, eol: bruto.includes('\r\n') ? '\r\n' : '\n' };
  }
  async function gravarAtomico(arq, texto) {
    await fsp.mkdir(path.dirname(arq), { recursive: true });
    const tmp = `${arq}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, texto, 'utf8');
      await fsp.rename(tmp, arq);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('skills: gravação atômica falhou, gravando direto:', e.code || e.message);
      await fsp.writeFile(arq, texto, 'utf8');
    }
  }
  const gravarJson = (arq, json, eol = '\n') => gravarAtomico(arq, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);
  const overridesDe = (r) => (r && !r.invalido && r.json.skillOverrides && typeof r.json.skillOverrides === 'object' && !Array.isArray(r.json.skillOverrides) ? r.json.skillOverrides : {});

  // ── leitura das pastas de skills ──
  function raizDe(origem, pasta) {
    if (origem === 'projeto') return path.join(pasta, '.claude', 'skills');
    if (origem === 'pessoal') return PESSOAIS;
    throw erro(400, 'origem deve ser "projeto" ou "pessoal"');
  }
  async function lerPasta(raiz, origem) {
    let nomes = [];
    try { nomes = await fsp.readdir(raiz, { withFileTypes: true }); } catch { return []; }
    const l = [];
    for (const d of nomes) {
      if (!d.isDirectory() || d.name.startsWith('.') || (origem === 'pessoal' && d.name === 'synced')) continue;
      const dir = path.join(raiz, d.name);
      let texto;
      try {
        const st = await fsp.stat(path.join(dir, 'SKILL.md'));
        if (st.size > MAX_SKILL_MD) { l.push({ nome: d.name, origem, caminho: dir, descricao: '', erro: 'SKILL.md grande demais' }); continue; }
        texto = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8');
      } catch { continue; }
      const f = lerSkillMd(texto);
      l.push({
        nome: d.name,
        origem,
        caminho: dir,
        descricao: String(f.campos.description || '').slice(0, 1500),
        ...(f.campos.name && f.campos.name !== d.name ? { nomeCabecalho: String(f.campos.name).slice(0, 100) } : {}),
        ...(f.semCabecalho ? { semCabecalho: true } : {}),
        soVoce: /^disable-model-invocation:\s*true\b/m.test(f.extra) || undefined,
      });
    }
    return l;
  }
  async function lerSincronizadas() {
    const l = [];
    let baldes = [];
    try { baldes = await fsp.readdir(SINCRONIZADAS, { withFileTypes: true }); } catch { return l; }
    for (const b of baldes) {
      if (!b.isDirectory() || b.name.startsWith('.')) continue;
      for (const s of await lerPasta(path.join(SINCRONIZADAS, b.name), 'claude.ai')) l.push(s);
    }
    return l;
  }

  // ── sonda (estado efetivo) ──
  const sondas = new Map(); // chave da pasta → { quando, linhas, erro, pr }
  function invalidar(pasta) {
    if (pasta) sondas.delete(chave(pasta));
    else sondas.clear();
  }
  async function sondaDe(pasta) {
    if (!sondar) return { linhas: null, erro: 'sem sonda neste servidor' };
    const k = chave(pasta);
    let s = sondas.get(k);
    if (s && !s.pr && Date.now() - s.quando < MS_SONDA_VALE) return s;
    if (!s?.pr) {
      const pr = Promise.resolve()
        .then(() => sondar(pasta))
        .then((linhas) => ({ quando: Date.now(), linhas: Array.isArray(linhas) ? linhas : [], erro: '' }))
        .catch((e) => ({ quando: Date.now(), linhas: null, erro: e?.message || String(e) }))
        .then((r) => { if (sondas.get(k)?.pr === pr) sondas.set(k, r); return r; });
      s = { ...(s || {}), pr };
      sondas.set(k, s);
    }
    const t = new Promise((r) => setTimeout(() => r(null), MS_SONDA_ESPERA).unref?.());
    return (await Promise.race([s.pr, t])) || { linhas: null, erro: 'a sonda demorou demais' };
  }

  async function listar(pasta) {
    const [proj, pess, sinc, sonda, setProj, setLocal, setPess] = await Promise.all([
      lerPasta(raizDe('projeto', pasta), 'projeto'),
      lerPasta(PESSOAIS, 'pessoal'),
      lerSincronizadas(),
      sondaDe(pasta),
      lerJson(path.join(pasta, '.claude', 'settings.json')).catch(() => ({ invalido: true })),
      lerJson(path.join(pasta, '.claude', 'settings.local.json')).catch(() => ({ invalido: true })),
      lerJson(SETTINGS_PESSOAL).catch(() => ({ invalido: true })),
    ]);
    const ovProj = overridesDe(setProj), ovLocal = overridesDe(setLocal), ovPess = overridesDe(setPess);
    const estadoDe = (n) => (ESTADOS.includes(ovLocal[n]) ? ovLocal[n] : ESTADOS.includes(ovProj[n]) ? ovProj[n] : ESTADOS.includes(ovPess[n]) ? ovPess[n] : 'on');
    const skills = [];
    const usadas = new Set();
    const linhas = Array.isArray(sonda.linhas) ? sonda.linhas : null;
    const doFs = { project: proj, user: pess, 'claude.ai sync': sinc };
    const base = (s) => ({
      id: `${s.origem}:${s.nome}`,
      nome: s.nome,
      chave: s.nome,
      origem: s.origem,
      descricao: s.descricao,
      caminho: s.caminho,
      editavel: s.origem === 'projeto' || s.origem === 'pessoal',
      ...(s.nomeCabecalho ? { nomeCabecalho: s.nomeCabecalho } : {}),
      ...(s.semCabecalho ? { semCabecalho: true } : {}),
      ...(s.soVoce ? { soVoce: true } : {}),
    });
    if (linhas) {
      for (const r of linhas) {
        if (!r || typeof r.name !== 'string') continue;
        const curto = r.handles?.unqualified_name || r.name.split(':').pop();
        const lista = doFs[r.source];
        const achado = lista && lista.find((s) => !usadas.has(s) && (s.nome === r.name || s.nome === curto || s.nomeCabecalho === r.name));
        let o;
        if (achado) { usadas.add(achado); o = base(achado); }
        else {
          const origem = r.source === 'plugin' ? 'plugin' : r.source === 'project' ? 'projeto' : r.source === 'user' ? 'pessoal' : r.source === 'claude.ai sync' ? 'claude.ai' : /built|bundl/i.test(r.source) ? 'embutida' : String(r.source || 'outra');
          o = { id: `${origem}:${r.name}`, nome: r.display_name || r.name, chave: r.name, origem, descricao: String(r.description || '').slice(0, 1500), editavel: false };
        }
        o.chave = r.name; // o nome canônico: chave do skillOverrides e da allowlist da instância
        if (r.display_name && !achado) o.nome = r.display_name;
        o.estado = ESTADOS.includes(r.state) ? r.state : 'on';
        if (r.locked_by) { o.travada = r.locked_by; o.motivoTrava = TRAVAS[r.locked_by] || r.locked_by; }
        o.anunciada = !!r.advertised;
        if (Number.isFinite(r.tokens)) o.tokens = r.tokens;
        skills.push(o);
      }
    }
    // Sem sonda (ou o que ela não viu): o que está nas pastas, com o estado lido dos settings.
    for (const s of [...proj, ...pess, ...sinc]) {
      if (usadas.has(s)) continue;
      if (linhas && s.origem === 'claude.ai') continue; // a sonda é quem sabe o nome canônico delas
      const o = base(s);
      o.estado = estadoDe(s.nome);
      if (linhas) o.foraDaSonda = true;
      skills.push(o);
    }
    // Nomes repetidos (testado em 17/10): a pessoal vence e a do projeto fica escondida.
    for (const o of skills) {
      if (o.origem !== 'projeto') continue;
      if (skills.some((x) => x !== o && x.origem === 'pessoal' && x.chave === o.chave)) o.sombreada = true;
    }
    for (const o of skills) {
      if (ESTADOS.includes(ovProj[o.chave])) o.noProjeto = ovProj[o.chave];
      if (ESTADOS.includes(ovLocal[o.chave])) o.noLocal = ovLocal[o.chave];
      if (ESTADOS.includes(ovPess[o.chave])) o.noPessoal = ovPess[o.chave];
    }
    const ordem = { projeto: 0, pessoal: 1, 'claude.ai': 2, plugin: 3, embutida: 4 };
    skills.sort((a, b) => (ordem[a.origem] ?? 9) - (ordem[b.origem] ?? 9) || a.nome.localeCompare(b.nome));
    const avisos = [];
    if (setProj.invalido) avisos.push('O .claude/settings.json deste projeto tem JSON inválido: o Orbit não muda o ativo/inativo até ele ser corrigido.');
    return {
      pasta,
      projetos: [...pastas().values()],
      skills,
      sonda: { ok: !!linhas, erro: linhas ? '' : sonda.erro || '', quando: sonda.quando ? new Date(sonda.quando).toISOString() : null },
      pessoais: PESSOAIS,
      avisos,
    };
  }

  // ── uma skill: SKILL.md e arquivos de apoio ──
  function dirDe(pasta, origem, nome) {
    if (typeof nome !== 'string' || !nome || nome.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f]/.test(nome) || nome === '..') throw erro(400, 'Nome de skill inválido.');
    const raiz = raizDe(origem, pasta);
    const dir = path.join(raiz, nome);
    if (!dentro(dir, raiz)) throw erro(400, 'Nome de skill inválido.');
    if (origem === 'pessoal' && chave(dir) === chave(SINCRONIZADAS)) throw erro(400, 'Essa pasta é das skills do claude.ai.');
    return dir;
  }
  function relValido(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw erro(400, 'Caminho do arquivo ausente.');
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    const partes = r.split('/');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || partes.some((p) => !p || p === '.' || p === '..' || /[:*?"<>|\u0000-\u001f]/.test(p)) || r.length > 300) throw erro(400, 'Caminho de arquivo inválido: use um caminho relativo dentro da skill, como scripts/ajuda.mjs.');
    if (partes.length === 1 && partes[0].toLowerCase() === 'skill.md') throw erro(400, 'O SKILL.md se edita nos campos de cima.');
    return partes.join('/');
  }
  async function arquivosDe(dir) {
    const l = [];
    async function andar(d, rel, nivel) {
      if (nivel > 6 || l.length >= MAX_ARQUIVOS) return;
      let itens = [];
      try { itens = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      itens.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of itens) {
        if (l.length >= MAX_ARQUIVOS) return;
        const r = rel ? `${rel}/${it.name}` : it.name;
        if (it.isSymbolicLink()) continue;
        if (it.isDirectory()) { await andar(path.join(d, it.name), r, nivel + 1); continue; }
        if (!rel && it.name.toLowerCase() === 'skill.md') continue;
        let st;
        try { st = await fsp.stat(path.join(d, it.name)); } catch { continue; }
        l.push({ caminho: r, tamanho: st.size, texto: st.size <= MAX_ARQ_TEXTO && (await ehTexto(path.join(d, it.name))) });
      }
    }
    await andar(dir, '', 0);
    return l;
  }
  async function ehTexto(arq) {
    let fh;
    try {
      fh = await fsp.open(arq, 'r');
      const b = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(b, 0, b.length, 0);
      return !b.subarray(0, bytesRead).includes(0);
    } catch { return false; } finally { await fh?.close().catch(() => {}); }
  }
  async function dirLeitura(pasta, origem, nome) {
    if (origem !== 'claude.ai') return dirDe(pasta, origem, nome);
    for (const s of await lerSincronizadas()) if (s.nome === nome) return s.caminho;
    throw erro(404, 'Essa skill do claude.ai não está mais nesta máquina.');
  }
  async function ler(pasta, origem, nome) {
    const dir = await dirLeitura(pasta, origem, nome);
    let texto;
    try { texto = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8'); } catch { throw erro(404, 'Essa skill não existe mais (pode ter sido movida ou excluída).'); }
    if (Buffer.byteLength(texto) > MAX_SKILL_MD) throw erro(413, 'O SKILL.md é grande demais para o editor.');
    const f = lerSkillMd(texto);
    return {
      nome,
      origem,
      caminho: dir,
      editavel: origem === 'projeto' || origem === 'pessoal',
      descricao: String(f.campos.description || ''),
      nomeCabecalho: f.campos.name ? String(f.campos.name) : '',
      extra: f.extra,
      corpo: f.corpo.replace(/^\n+/, ''),
      semCabecalho: !!f.semCabecalho,
      arquivos: await arquivosDe(dir),
    };
  }

  function exigirGlobal(origem, corpo, acao) {
    if (origem !== 'pessoal' || corpo.confirmarGlobal === true) return;
    throw erro(428, `${acao} uma skill pessoal muda ~/.claude/skills, que vale para todos os projetos e para o Claude Code fora do Orbit. Confirme para seguir.`, 'confirmar_global');
  }
  function mudou(pasta) {
    invalidar(pasta && chave(pasta) !== casaK ? pasta : null);
    difundir('skills', { pasta: pasta || null });
  }
  const textoCampo = (v, max, nome) => {
    if (v == null) return '';
    if (typeof v !== 'string') throw erro(400, `${nome} deve ser texto.`);
    if (v.length > max) throw erro(400, `${nome} passa do tamanho máximo.`);
    return v;
  };

  // salvar: cria (sem `nomeAntigo`) ou edita; `nome` novo diferente do antigo renomeia a pasta.
  async function salvar(c) {
    const pasta = pastaValida(c.pasta);
    const origem = c.origem || 'projeto';
    raizDe(origem, pasta);
    const nome = String(c.nome || '').trim();
    if (!RE_NOME.test(nome)) throw erro(400, 'Use no nome só letras minúsculas, números e hífen (até 64), como revisar-pr.');
    const descricao = textoCampo(c.descricao, 1500, 'A descrição').replace(/\s+/g, ' ').trim();
    if (!descricao) throw erro(400, 'Escreva a descrição: é por ela que o Claude decide quando usar a skill.');
    const corpoMd = textoCampo(c.corpo, MAX_SKILL_MD, 'As instruções');
    const extra = textoCampo(c.extra, 8000, 'O cabeçalho avançado');
    if (/^---\s*$/m.test(extra)) throw erro(400, 'O cabeçalho avançado não pode ter a linha ---.');
    if (/^(name|description):/m.test(extra)) throw erro(400, 'Nome e descrição ficam nos campos próprios, não no cabeçalho avançado.');
    const antigo = c.nomeAntigo == null ? null : String(c.nomeAntigo);
    exigirGlobal(origem, c, antigo ? 'Editar' : 'Criar');
    return emFila(async () => {
      const dir = dirDe(pasta, origem, nome);
      if (antigo == null || antigo !== nome) {
        if (await existe(dir)) throw erro(409, `Já existe uma skill "${nome}" ${origem === 'pessoal' ? 'nas pessoais' : 'neste projeto'}.`, 'existe');
      }
      if (antigo != null) {
        const dirAntigo = dirDe(pasta, origem, antigo);
        if (!(await existe(path.join(dirAntigo, 'SKILL.md')))) throw erro(404, 'Essa skill não existe mais (pode ter sido movida ou excluída).');
        if (antigo !== nome) await fsp.rename(dirAntigo, dir);
      }
      await fsp.mkdir(dir, { recursive: true });
      await gravarAtomico(path.join(dir, 'SKILL.md'), montarSkillMd({ nome, descricao, extra, corpo: corpoMd }));
      log('skills:', `${antigo == null ? 'criada' : antigo !== nome ? `renomeada (${antigo} →)` : 'salva'} ${origem} ${nome} em ${dir}`);
      mudou(origem === 'projeto' ? pasta : null);
      return { ok: true, skill: await ler(pasta, origem, nome) };
    });
  }

  async function duplicar(c) {
    const pasta = pastaValida(c.pasta);
    const destino = c.destino || 'projeto';
    raizDe(destino, pasta);
    const novo = String(c.novoNome || '').trim();
    if (!RE_NOME.test(novo)) throw erro(400, 'Use no nome só letras minúsculas, números e hífen (até 64), como revisar-pr.');
    exigirGlobal(destino, c, 'Criar');
    return emFila(async () => {
      const de = await dirLeitura(pasta, c.origem, String(c.nome || ''));
      if (!(await existe(path.join(de, 'SKILL.md')))) throw erro(404, 'Essa skill não existe mais.');
      const para = dirDe(pasta, destino, novo);
      if (await existe(para)) throw erro(409, `Já existe uma skill "${novo}" ${destino === 'pessoal' ? 'nas pessoais' : 'neste projeto'}.`, 'existe');
      await fsp.mkdir(path.dirname(para), { recursive: true });
      await fsp.cp(de, para, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      const f = lerSkillMd(await fsp.readFile(path.join(para, 'SKILL.md'), 'utf8'));
      await gravarAtomico(path.join(para, 'SKILL.md'), montarSkillMd({ nome: novo, descricao: f.campos.description || '', extra: f.extra, corpo: f.corpo }));
      log('skills:', `duplicada ${c.origem}:${c.nome} → ${destino}:${novo}`);
      mudou(destino === 'projeto' ? pasta : null);
      return { ok: true, skill: await ler(pasta, destino, novo) };
    });
  }

  async function excluir(c) {
    const pasta = pastaValida(c.pasta);
    const origem = c.origem;
    exigirGlobal(origem, c, 'Excluir');
    if (!lixeira) throw erro(501, 'A Lixeira não está disponível neste servidor.');
    return emFila(async () => {
      const dir = dirDe(pasta, origem, String(c.nome || ''));
      if (!(await existe(path.join(dir, 'SKILL.md')))) throw erro(404, 'Essa skill não existe mais.');
      await lixeira([dir]);
      log('skills:', `excluída (Lixeira) ${origem} ${c.nome}`);
      mudou(origem === 'projeto' ? pasta : null);
      return { ok: true };
    });
  }

  async function estado(c) {
    const pasta = pastaValida(c.pasta);
    const nome = typeof c.chave === 'string' ? c.chave : '';
    if (!nome || nome.length > 200 || nome === '__proto__') throw erro(400, 'Skill inválida.');
    if (!ESTADOS.includes(c.estado)) throw erro(400, `Estado inválido. Use: ${ESTADOS.join(', ')}.`);
    return emFila(async () => {
      const lista = await listar(pasta);
      const s = lista.skills.find((x) => x.chave === nome);
      if (s?.travada) throw erro(409, s.motivoTrava || 'O estado dessa skill não muda pelo projeto.', 'travada');
      const arq = path.join(pasta, '.claude', 'settings.json');
      const r = await lerJson(arq);
      if (r.invalido) throw erro(409, `O arquivo ${arq} tem JSON inválido; corrija à mão antes.`);
      const ov = overridesDe(r);
      const pess = overridesDe(await lerJson(SETTINGS_PESSOAL).catch(() => null));
      if (c.estado === 'on' && (!pess[nome] || pess[nome] === 'on')) delete ov[nome];
      else ov[nome] = c.estado;
      const json = r.json;
      if (Object.keys(ov).length) json.skillOverrides = ov;
      else delete json.skillOverrides;
      await gravarJson(arq, json, r.eol);
      // O settings.local.json venceria o settings.json: a entrada dele para esse nome sai.
      const arqLocal = path.join(pasta, '.claude', 'settings.local.json');
      const rl = await lerJson(arqLocal).catch(() => ({ invalido: true }));
      let local = false;
      if (!rl.invalido && rl.existe && Object.prototype.hasOwnProperty.call(overridesDe(rl), nome)) {
        delete rl.json.skillOverrides[nome];
        if (!Object.keys(rl.json.skillOverrides).length) delete rl.json.skillOverrides;
        await gravarJson(arqLocal, rl.json, rl.eol);
        local = true;
      }
      log('skills:', `estado ${nome} = ${c.estado} em ${arq}${local ? ' (e saiu do settings.local.json)' : ''}`);
      mudou(pasta);
      return { ok: true, chave: nome, estado: c.estado, local };
    });
  }

  async function gravarArquivo(c) {
    const pasta = pastaValida(c.pasta);
    const origem = c.origem;
    const rel = relValido(c.caminho);
    const texto = textoCampo(c.texto, MAX_ARQ_TEXTO, 'O arquivo');
    exigirGlobal(origem, c, 'Editar');
    return emFila(async () => {
      const dir = dirDe(pasta, origem, String(c.nome || ''));
      if (!(await existe(path.join(dir, 'SKILL.md')))) throw erro(404, 'Essa skill não existe mais.');
      const arq = path.join(dir, ...rel.split('/'));
      if (!dentro(arq, dir)) throw erro(400, 'Caminho de arquivo inválido.');
      if (c.novo === true && (await existe(arq))) throw erro(409, `Já existe ${rel} nesta skill.`, 'existe');
      try { if ((await fsp.lstat(arq)).isSymbolicLink()) throw erro(400, 'Esse arquivo é um atalho; edite o original.'); } catch (e) { if (e.status) throw e; }
      await fsp.mkdir(path.dirname(arq), { recursive: true });
      await gravarAtomico(arq, texto);
      mudou(origem === 'projeto' ? pasta : null);
      return { ok: true, arquivos: await arquivosDe(dir) };
    });
  }
  async function excluirArquivo(c) {
    const pasta = pastaValida(c.pasta);
    const origem = c.origem;
    const rel = relValido(c.caminho);
    exigirGlobal(origem, c, 'Editar');
    if (!lixeira) throw erro(501, 'A Lixeira não está disponível neste servidor.');
    return emFila(async () => {
      const dir = dirDe(pasta, origem, String(c.nome || ''));
      const arq = path.join(dir, ...rel.split('/'));
      if (!dentro(arq, dir) || !(await existe(arq))) throw erro(404, 'Esse arquivo não existe mais.');
      await lixeira([arq]);
      mudou(origem === 'projeto' ? pasta : null);
      return { ok: true, arquivos: await arquivosDe(dir) };
    });
  }
  async function lerArquivo(pasta, origem, nome, relBruto) {
    const dir = await dirLeitura(pasta, origem, nome);
    const rel = relValido(relBruto);
    const arq = path.join(dir, ...rel.split('/'));
    if (!dentro(arq, dir)) throw erro(400, 'Caminho de arquivo inválido.');
    let st;
    try { st = await fsp.stat(arq); } catch { throw erro(404, 'Esse arquivo não existe mais.'); }
    if (st.size > MAX_ARQ_TEXTO || !(await ehTexto(arq))) throw erro(415, 'Esse arquivo não é texto (ou é grande demais) para o editor.');
    return { caminho: rel, texto: await fsp.readFile(arq, 'utf8') };
  }

  // ── skills usadas por sessão (leitura incremental do transcript) ──
  const usos = new Map(); // transcript → estado da leitura
  async function usadasDe(arq) {
    let est = usos.get(arq);
    let st;
    try { st = await fsp.stat(arq); } catch { return []; }
    if (!est || st.size < est.off) { est = novaLeituraUso(); usos.set(arq, est); }
    if (usos.size > 200) usos.delete(usos.keys().next().value);
    if (st.size > est.off) {
      const fh = await fsp.open(arq, 'r');
      try {
        const passo = 4 * 1024 * 1024;
        const b = Buffer.alloc(passo);
        let resto = Buffer.alloc(0);
        while (est.off < st.size) {
          const { bytesRead } = await fh.read(b, 0, Math.min(passo, st.size - est.off), est.off);
          if (!bytesRead) break;
          est.off += bytesRead;
          // corta no último \n para não partir um caractere UTF-8 no meio
          const junto = Buffer.concat([resto, b.subarray(0, bytesRead)]);
          const ult = junto.lastIndexOf(10);
          if (ult < 0) { resto = junto; continue; }
          lerLinhasUso(est, junto.subarray(0, ult + 1).toString('utf8'));
          resto = Buffer.from(junto.subarray(ult + 1));
        }
        est.off -= resto.length; // o pedaço sem \n é relido na próxima vez
      } finally { await fh.close(); }
    }
    return resumoUso(est);
  }

  async function rota(req, res, rotaUrl, url) {
    if (rotaUrl !== '/skills' && !rotaUrl.startsWith('/skills/')) return false;
    try {
      if (req.method === 'GET') {
        const q = url?.searchParams || new URL(req.url, 'http://x').searchParams;
        if (rotaUrl === '/skills') {
          const pedida = q.get('pasta');
          const lista = pastas();
          if (!pedida) {
            const primeira = lista.values().next().value;
            if (!primeira) return responder(res, 200, { pasta: null, projetos: [], skills: [], sonda: { ok: false }, avisos: [] }), true;
            responder(res, 200, await listar(primeira.pasta));
            return true;
          }
          responder(res, 200, await listar(pastaValida(pedida)));
          return true;
        }
        if (rotaUrl === '/skills/ler') {
          responder(res, 200, await ler(pastaValida(q.get('pasta')), q.get('origem'), q.get('nome') || ''));
          return true;
        }
        if (rotaUrl === '/skills/arquivo') {
          responder(res, 200, await lerArquivo(pastaValida(q.get('pasta')), q.get('origem'), q.get('nome') || '', q.get('arq') || ''));
          return true;
        }
        if (rotaUrl === '/skills/sessao') {
          const id = q.get('id') || '';
          const s = sessao(id);
          if (!s) throw erro(404, 'sessão não encontrada');
          const arq = typeof s._transcript === 'string' ? s._transcript : '';
          responder(res, 200, { id, usadas: arq ? await usadasDe(arq) : [], permitidas: permitidas(id), semTranscript: !arq });
          return true;
        }
        return false;
      }
      if (req.method !== 'POST') return false;
      const corpo = await lerJSONCorpo(req, 2 * 1024 * 1024);
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'corpo inválido');
      const acoes = { '/skills/salvar': salvar, '/skills/duplicar': duplicar, '/skills/excluir': excluir, '/skills/estado': estado, '/skills/arquivo': gravarArquivo, '/skills/arquivo/excluir': excluirArquivo };
      const fn = acoes[rotaUrl];
      if (!fn) return false;
      responder(res, 200, await fn(corpo));
      return true;
    } catch (e) {
      if (!e.status) log('skills:', rotaUrl, e?.stack || e?.message || e);
      responder(res, e.status || 500, { erro: e.status ? e.message : `Falhou: ${e.message}`, ...(e.codigo ? { codigo: e.codigo } : {}) });
      return true;
    }
  }

  return { rota, listar, invalidar };
}
