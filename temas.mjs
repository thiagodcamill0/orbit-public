// Orbit — temas do VS Code na prévia de arquivos.
// Lê do VS Code do usuário, sem copiar nada para o projeto:
//   - o tema de cores ativo (workbench.colorTheme): só as cores do texto vão para o realce (Shiki, no realce.mjs);
//     o fundo continua o do Orbit, e cor com pouco contraste sobre ele é clareada até 4,5:1 (WCAG AA);
//   - o tema de ícones ativo (workbench.iconTheme): mapa de arquivo/pasta → ícone, servido em /temas/icone/<n>.
// Vigia o settings.json, a pasta de extensões e os arquivos dos temas; quando algo muda, recarrega e avisa a página
// pelo SSE "temas". Se um tema não puder ser lido, aquela parte fica desligada e a página usa o visual do Orbit.
// Rotas (GET): /temas (situação), /temas/icones (mapa), /temas/icone/<n>, /temas/fonte/<n>.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { SO, pastaUsuarioVSCode, appsVSCode } from './plataforma.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// Fundo da área de código do Orbit (.arq-codigo em assets/arquivos.css). O contraste é medido contra ele.
export const FUNDO_ORBIT = '#141414';
const CONTRASTE_MIN = 4.5;
const MAX_REALCE = 512 * 1024;
const MAX_LINHAS_REALCE = 20000;
const LIMITE_REALCE_MS = 15000;

// ───────────── leitura de JSON com comentários (settings.json e temas do VS Code) ─────────────
export function lerJSONC(txt) {
  let s = String(txt);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const f = s.indexOf('*/', i + 2);
      i = f < 0 ? s.length : f + 1;
    } else out += c;
  }
  // Vírgula sobrando antes de } ou ] (fora de string: as strings já passaram inteiras acima).
  let limpo = '';
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      limpo += out.slice(i, j + 1);
      i = j;
    } else if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] !== '}' && out[j] !== ']') limpo += c;
    } else limpo += c;
  }
  return JSON.parse(limpo);
}
async function lerJSONCArq(p) { return lerJSONC(await fsp.readFile(p, 'utf8')); }

// ───────────── cores e contraste ─────────────
function hexParaRgba(hex) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(hex || '').trim());
  if (!m || ![3, 4, 6, 8].includes(m[1].length)) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const rgbParaHex = ({ r, g, b }) => '#' + hex2(r) + hex2(g) + hex2(b);
function sobre(c, f) { return { r: c.r * c.a + f.r * (1 - c.a), g: c.g * c.a + f.g * (1 - c.a), b: c.b * c.a + f.b * (1 - c.a), a: 1 }; }
function luminancia({ r, g, b }) {
  const l = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b);
}
export function contraste(cor, fundo) {
  const f = hexParaRgba(fundo), c = hexParaRgba(cor);
  if (!f || !c) return 0;
  const a = luminancia(sobre(c, f)), b = luminancia(f);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function rgbParaHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h / 6, s, l };
}
function hslParaRgb({ h, s, l }) {
  if (!s) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
}
// Clareia (fundo escuro) ou escurece (fundo claro) só a luminosidade, mantendo matiz e saturação, até o mínimo.
export function ajustarContraste(cor, fundo, minimo = CONTRASTE_MIN) {
  const c = hexParaRgba(cor), f = hexParaRgba(fundo);
  if (!c || !f) return cor;
  if (contraste(cor, fundo) >= minimo) return cor;
  const base = rgbParaHsl(sobre(c, f));
  const claro = luminancia(f) < 0.5;
  let lo = base.l, hi = claro ? 1 : 0, melhor = rgbParaHex(hslParaRgb({ ...base, l: hi }));
  for (let i = 0; i < 24; i++) {
    const meio = (lo + hi) / 2;
    const hx = rgbParaHex(hslParaRgb({ ...base, l: meio }));
    if (contraste(hx, fundo) >= minimo) { melhor = hx; hi = meio; } else lo = meio;
  }
  return melhor;
}

// ───────────── onde está o VS Code ─────────────
// Os caminhos vêm do plataforma.mjs; `o = { so, env, home }` deixa os testes simularem o Mac.
// Pasta de configurações do VS Code (settings.json): Windows %APPDATA%\Code\User; Mac
// ~/Library/Application Support/Code/User.
export function pastaUsuario(o) { return pastaUsuarioVSCode(o); }

// Pasta "app" da instalação do VS Code (a que tem extensions/ com as extensões embutidas), ou null.
export function acharApp(o = {}) {
  const env = o.env || process.env;
  const so = o.so || SO;
  const bruto = env.GERENCIADOR_VSCODE_APP;
  if (bruto) return bruto === 'nenhum' ? null : bruto;
  if (so !== 'win32') {
    // Mac: /Applications ou ~/Applications/Visual Studio Code.app/Contents/Resources/app. Linux: pastas usuais.
    return appsVSCode(o).find((c) => fs.existsSync(path.join(c, 'extensions'))) || null;
  }
  const raizes = new Set();
  // Windows: o code.cmd do PATH primeiro (instalação fora do lugar padrão), depois as pastas padrão.
  for (const d of String(env.PATH || env.Path || '').split(';')) {
    if (d && /[\\/]bin[\\/]?$/i.test(d) && fs.existsSync(path.join(d, 'code.cmd'))) raizes.add(path.resolve(d, '..'));
  }
  for (const app of appsVSCode(o)) raizes.add(path.win32.resolve(app, '..', '..'));
  for (const r of raizes) {
    const cand = [path.join(r, 'resources', 'app')];
    // Instalações novas guardam a versão numa subpasta com hash (ex.: 6d62b1d5da\resources\app).
    try { for (const d of fs.readdirSync(r, { withFileTypes: true })) if (d.isDirectory()) cand.push(path.join(r, d.name, 'resources', 'app')); } catch {}
    const validos = cand.filter((c) => fs.existsSync(path.join(c, 'extensions')));
    if (validos.length) return validos.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  return null;
}

// Extensões instaladas: as do usuário (pelo extensions.json, que é a lista que o VS Code usa) e as embutidas.
async function listarExtensoes(dirUsuario, dirApp) {
  const lista = [];
  const add = async (dir, embutida) => {
    try {
      const pkg = await lerJSONCArq(path.join(dir, 'package.json'));
      let nls = null;
      try { nls = await lerJSONCArq(path.join(dir, 'package.nls.json')); } catch {}
      lista.push({ dir, pkg, nls, embutida });
    } catch {}
  };
  if (dirUsuario) {
    let dirs = null;
    try {
      const ej = await lerJSONCArq(path.join(dirUsuario, 'extensions.json'));
      if (Array.isArray(ej)) {
        dirs = ej.map((e) => (e?.relativeLocation ? path.join(dirUsuario, e.relativeLocation) : e?.location?.fsPath || null)).filter(Boolean);
      }
    } catch {}
    if (!dirs) {
      let obsoletas = {};
      try { obsoletas = await lerJSONCArq(path.join(dirUsuario, '.obsolete')); } catch {}
      try {
        dirs = (await fsp.readdir(dirUsuario, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !obsoletas[d.name]).map((d) => path.join(dirUsuario, d.name));
      } catch { dirs = []; }
    }
    await Promise.all(dirs.map((d) => add(d, false)));
  }
  if (dirApp) {
    const ext = path.join(dirApp, 'extensions');
    try {
      const ds = (await fsp.readdir(ext, { withFileTypes: true })).filter((d) => d.isDirectory());
      await Promise.all(ds.map((d) => add(path.join(ext, d.name), true)));
    } catch {}
  }
  // As do usuário vêm antes: um tema com o mesmo nome instalado pelo usuário ganha do embutido.
  return lista.sort((a, b) => Number(a.embutida) - Number(b.embutida));
}
function traduzir(txt, nls) {
  const m = /^%(.+)%$/.exec(String(txt || ''));
  if (!m || !nls) return txt;
  const v = nls[m[1]];
  return typeof v === 'string' ? v : v && typeof v.message === 'string' ? v.message : txt;
}
const nomeExt = (e) => (e.pkg.publisher ? e.pkg.publisher + '.' : '') + (e.pkg.name || path.basename(e.dir)) + (e.pkg.version ? ' ' + e.pkg.version : '');

// ───────────── tema de cores → tema do Shiki (só o texto) ─────────────
// Grupos do editor.tokenColorCustomizations, como o VS Code traduz para escopos.
const GRUPOS = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};
function regrasDePersonalizacao(p) {
  const regras = [];
  if (!p || typeof p !== 'object') return regras;
  for (const [g, escopos] of Object.entries(GRUPOS)) {
    const v = p[g];
    if (typeof v === 'string') regras.push({ scope: escopos, settings: { foreground: v } });
    else if (v && typeof v === 'object') regras.push({ scope: escopos, settings: { ...(v.foreground ? { foreground: v.foreground } : {}), ...(v.fontStyle ? { fontStyle: v.fontStyle } : {}) } });
  }
  if (Array.isArray(p.textMateRules)) for (const r of p.textMateRules) if (r && r.settings) regras.push(r);
  return regras;
}
async function carregarArquivoTema(arq, vistos = new Set()) {
  const abs = path.resolve(arq);
  if (vistos.has(abs)) throw new Error('include em ciclo: ' + path.basename(abs));
  vistos.add(abs);
  const j = await lerJSONCArq(abs);
  let colors = {}, tokenColors = [];
  if (typeof j.include === 'string') {
    const pai = await carregarArquivoTema(path.join(path.dirname(abs), j.include), vistos);
    colors = pai.colors; tokenColors = pai.tokenColors;
  }
  if (j.colors && typeof j.colors === 'object') colors = { ...colors, ...j.colors };
  if (typeof j.tokenColors === 'string') {
    const alvo = path.join(path.dirname(abs), j.tokenColors);
    if (!/\.json$/i.test(alvo)) throw new Error('tokenColors em formato .tmTheme não é lido: ' + path.basename(alvo));
    const t = await lerJSONCArq(alvo);
    tokenColors = [...tokenColors, ...(Array.isArray(t.tokenColors) ? t.tokenColors : Array.isArray(t.settings) ? t.settings : [])];
  } else if (Array.isArray(j.tokenColors)) tokenColors = [...tokenColors, ...j.tokenColors];
  return { colors, tokenColors, arquivos: [...vistos] };
}
function montarTemaShiki(base, tipo, personal, nomeTema) {
  const extra = [...regrasDePersonalizacao(personal), ...regrasDePersonalizacao(personal && personal[`[${nomeTema}]`])];
  const tokenColors = [...base.tokenColors, ...extra].filter((r) => r && typeof r === 'object' && r.settings && typeof r.settings === 'object')
    .map((r) => ({ ...(r.scope != null ? { scope: r.scope } : {}), settings: { ...r.settings } }));
  // Cor padrão do texto: a regra sem escopo do tema ganha; senão editor.foreground; senão o padrão do VS Code.
  const global = tokenColors.filter((r) => r.scope == null || r.scope === '').map((r) => r.settings.foreground).filter(Boolean).pop();
  let fg = global || base.colors['editor.foreground'] || (tipo === 'light' ? '#333333' : '#bbbbbb');
  const ajustes = [];
  const cache = new Map();
  const ajustar = (cor, onde) => {
    if (typeof cor !== 'string' || !hexParaRgba(cor)) return cor;
    const k = cor.toLowerCase();
    if (!cache.has(k)) {
      const novo = ajustarContraste(k, FUNDO_ORBIT);
      cache.set(k, novo);
      if (novo !== k) ajustes.push({ de: k, para: novo, antes: +contraste(k, FUNDO_ORBIT).toFixed(2), depois: +contraste(novo, FUNDO_ORBIT).toFixed(2), onde: [] });
    }
    const a = ajustes.find((x) => x.de === k);
    if (a && onde && a.onde.length < 6 && !a.onde.includes(onde)) a.onde.push(onde);
    return cache.get(k);
  };
  fg = ajustar(fg, 'texto padrão');
  for (const r of tokenColors) {
    if (r.settings.foreground) {
      const esc = r.scope == null ? 'texto padrão' : Array.isArray(r.scope) ? r.scope[0] : String(r.scope).split(',')[0].trim();
      r.settings.foreground = ajustar(r.settings.foreground, esc);
    }
    delete r.settings.background; // fundo de trecho fica com o Orbit
  }
  return {
    tema: { name: 'orbit-vscode', type: tipo, fg, bg: FUNDO_ORBIT, colors: { 'editor.foreground': fg, 'editor.background': FUNDO_ORBIT }, tokenColors },
    ajustes,
  };
}

// ───────────── tema de ícones → mapa para a página ─────────────
const TIPOS_ICONE = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TIPOS_FONTE = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const minusculas = (o) => {
  const r = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string') r[k.toLowerCase()] = v;
  return r;
};
function caracterFonte(fc) {
  const s = String(fc || '');
  const m = /^\\([0-9a-f]{1,6})$/i.exec(s);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return s.length <= 2 ? s : '';
}

// ───────────── gramáticas (Shiki) ─────────────
// Id de linguagem do VS Code → gramática do Shiki, quando o nome difere.
const ALIAS_LANG = {
  typescriptreact: 'tsx', javascriptreact: 'jsx', dockerfile: 'docker', makefile: 'make', 'code-workspace': 'jsonc',
  snippets: 'jsonc', 'json-tmlanguage': 'json', ignore: null, plaintext: null, 'git-commit': 'git-commit', 'git-rebase': 'git-rebase',
};
// Extensão → gramática, para o que o VS Code não conhece sozinho (Astro, por exemplo) ou quando ele não está instalado.
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', md: 'markdown', markdown: 'markdown', mdx: 'mdx', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', py: 'python', pyw: 'python', pyi: 'python', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'dotenv', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', plist: 'xml',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat', sql: 'sql', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp',
  hpp: 'cpp', cc: 'cpp', php: 'php', rb: 'ruby', lua: 'lua', astro: 'astro', vue: 'vue', svelte: 'svelte', graphql: 'graphql',
  gql: 'graphql', prisma: 'prisma', diff: 'diff', patch: 'diff', log: 'log', properties: 'properties', csv: 'csv', dart: 'dart', swift: 'swift',
};
const NOME_LANG = {
  dockerfile: 'docker', makefile: 'make', '.env': 'dotenv', 'tsconfig.json': 'jsonc', 'jsconfig.json': 'jsonc', '.babelrc': 'json',
  '.eslintrc': 'json', '.prettierrc': 'json', 'settings.json': 'jsonc', 'launch.json': 'jsonc', 'tasks.json': 'jsonc', 'keybindings.json': 'jsonc',
};
function gramaticasInstaladas() {
  try {
    const dir = path.join(AQUI, 'node_modules', '@shikijs', 'langs', 'dist');
    return new Set(fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs').map((n) => n.slice(0, -4)));
  } catch { return new Set(); }
}

export function criarTemas(deps = {}) {
  const log = deps.log || (() => {});
  const difundir = deps.difundir || (() => {});
  // deps.sistema = { so, env, home }: só os testes (Mac simulado). Extensões do usuário: ~/.vscode/extensions
  // nos dois sistemas.
  const sis = deps.sistema || {};
  const caminhos = () => ({
    settings: deps.settings || process.env.GERENCIADOR_VSCODE_SETTINGS || path.join(pastaUsuario(sis), 'settings.json'),
    extensoes: deps.extensoes || process.env.GERENCIADOR_VSCODE_EXT || path.join(sis.home || os.homedir(), '.vscode', 'extensions'),
    app: deps.app !== undefined ? deps.app : acharApp(sis),
  });
  const gramaticas = gramaticasInstaladas();

  let estado = { versao: '', cor: { ok: false, erro: 'ainda não carregado' }, icones: { ok: false, erro: 'ainda não carregado' } };
  let temaShiki = null;
  let mapa = null; // corpo do /temas/icones
  let arquivosIcone = []; // índice → { abs, tipo }
  let arquivosFonte = [];
  let linguagens = { ext: {}, nome: {} }; // do VS Code: extensão/nome de arquivo → id de linguagem
  let associacoes = { ext: {}, nome: {} }; // files.associations do usuário
  let assinatura = '';
  let parado = false;
  let carregando = null;
  let pendente = false;

  // ── vigias ──
  const vigias = new Map();
  let tVigia = 0;
  function agendar() {
    if (parado) return;
    clearTimeout(tVigia);
    tVigia = setTimeout(() => { recarregar().catch((e) => log('temas: recarregar', e?.message || e)); }, 400);
  }
  // alvos: [pasta, nomes de arquivo (minúsculos) ou null = qualquer um]. A chave inclui os nomes, então trocar o
  // tema ativo troca o vigia da pasta.
  function vigiar(alvos) {
    const novos = new Map();
    for (const [dir, nomes] of alvos) {
      const lista = nomes ? [...new Set(nomes)].sort() : null;
      novos.set(dir + '|' + (lista ? lista.join('|') : '*'), { dir, filtro: lista ? (n) => lista.includes(n.toLowerCase()) : null });
    }
    for (const [k, w] of vigias) if (!novos.has(k)) { try { w.close(); } catch {} vigias.delete(k); }
    for (const [k, { dir, filtro }] of novos) {
      if (vigias.has(k)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, nome) => { if (!filtro || !nome || filtro(String(nome))) agendar(); });
        w.on('error', () => { try { w.close(); } catch {} vigias.delete(k); });
        vigias.set(k, w);
      } catch {}
    }
  }

  // ── carga ──
  async function carregarTudo() {
    const c = caminhos();
    let settings = {};
    let erroSettings = null;
    try { settings = await lerJSONCArq(c.settings); } catch (e) { erroSettings = e?.code === 'ENOENT' ? 'settings.json do VS Code não encontrado' : 'settings.json ilegível: ' + (e?.message || e); }
    const exts = await listarExtensoes(fs.existsSync(c.extensoes) ? c.extensoes : null, c.app);

    // Linguagens (para o ícone por languageIds e para escolher a gramática).
    const lgExt = {}, lgNome = {};
    for (const e of exts.slice().reverse()) { // embutidas primeiro; as do usuário sobrescrevem
      const ls = e.pkg?.contributes?.languages;
      if (!Array.isArray(ls)) continue;
      for (const l of ls) {
        if (!l || typeof l.id !== 'string') continue;
        for (const x of Array.isArray(l.extensions) ? l.extensions : []) if (typeof x === 'string' && x.startsWith('.')) lgExt[x.slice(1).toLowerCase()] = l.id;
        for (const n of Array.isArray(l.filenames) ? l.filenames : []) if (typeof n === 'string') lgNome[n.toLowerCase()] = l.id;
      }
    }
    const assoc = { ext: {}, nome: {} };
    const fa = settings['files.associations'];
    if (fa && typeof fa === 'object') for (const [pad, id] of Object.entries(fa)) {
      if (typeof id !== 'string') continue;
      const m = /^\*\.([^*?/\\[\]{}]+)$/.exec(pad);
      if (m) assoc.ext[m[1].toLowerCase()] = id;
      else if (!/[*?/\\[\]{}]/.test(pad)) assoc.nome[pad.toLowerCase()] = id;
    }

    // Tema de cores.
    const nomeCor = typeof settings['workbench.colorTheme'] === 'string' ? settings['workbench.colorTheme'] : 'Default Dark Modern';
    let cor;
    let tema = null;
    const vigiarArqs = [];
    try {
      if (erroSettings && !fs.existsSync(c.settings)) throw new Error(erroSettings);
      let achado = null;
      for (const e of exts) {
        for (const t of Array.isArray(e.pkg?.contributes?.themes) ? e.pkg.contributes.themes : []) {
          if (!t || typeof t.path !== 'string') continue;
          const rot = traduzir(t.label, e.nls);
          if ((t.id || rot) === nomeCor || t.id === nomeCor || rot === nomeCor) { achado = { e, t, rot }; break; }
        }
        if (achado) break;
      }
      if (!achado) throw new Error(`o tema "${nomeCor}" não está em nenhuma extensão instalada`);
      const arq = path.join(achado.e.dir, achado.t.path);
      const base = await carregarArquivoTema(arq);
      vigiarArqs.push(...base.arquivos);
      const tipo = /^(vs|hc-light)$/.test(achado.t.uiTheme || '') ? 'light' : 'dark';
      const m = montarTemaShiki(base, tipo, settings['editor.tokenColorCustomizations'], nomeCor);
      tema = m.tema;
      cor = { ok: true, nome: nomeCor, extensao: nomeExt(achado.e), arquivo: arq, tipo, regras: tema.tokenColors.length, fundo: FUNDO_ORBIT, texto: tema.fg, ajustes: m.ajustes };
    } catch (e) {
      cor = { ok: false, nome: nomeCor, erro: String(e?.message || e) };
    }
    if (!gramaticas.size) cor = { ...cor, ok: false, erro: 'Shiki não instalado (rode npm install na pasta do Orbit)' };

    // Tema de ícones.
    const valorIco = settings['workbench.iconTheme'];
    const nomeIco = valorIco === undefined ? 'vs-seti' : valorIco;
    let icones;
    let novoMapa = null;
    const novosIco = [], novasFontes = [];
    try {
      if (erroSettings && !fs.existsSync(c.settings)) throw new Error(erroSettings);
      if (nomeIco === null || nomeIco === '') throw new Error('o VS Code está sem tema de ícones');
      let achado = null;
      for (const e of exts) {
        for (const t of Array.isArray(e.pkg?.contributes?.iconThemes) ? e.pkg.contributes.iconThemes : []) {
          if (t && t.id === nomeIco && typeof t.path === 'string') { achado = { e, t }; break; }
        }
        if (achado) break;
      }
      if (!achado) throw new Error(`o tema de ícones "${nomeIco}" não está em nenhuma extensão instalada`);
      const arq = path.join(achado.e.dir, achado.t.path);
      const j = await lerJSONCArq(arq);
      vigiarArqs.push(arq);
      const dirTema = path.dirname(arq);
      const raizExt = path.resolve(achado.e.dir) + path.sep;
      const dentro = (p) => (path.resolve(p) + path.sep).startsWith(raizExt) || path.resolve(p).startsWith(raizExt);
      const fontes = [];
      for (const f of Array.isArray(j.fonts) ? j.fonts : []) {
        const src = Array.isArray(f?.src) ? f.src.find((s) => s && typeof s.path === 'string' && TIPOS_FONTE[path.extname(s.path).toLowerCase()]) : null;
        if (!src) continue;
        const abs = path.join(dirTema, src.path);
        if (!dentro(abs)) continue;
        const i = novasFontes.push({ abs, tipo: TIPOS_FONTE[path.extname(abs).toLowerCase()] }) - 1;
        fontes.push({ id: String(f.id || 'f' + i), i, peso: f.weight || 'normal', estilo: f.style || 'normal', tam: f.size || '100%' });
      }
      const defs = {};
      const porArquivo = new Map();
      for (const [id, d] of Object.entries(j.iconDefinitions || {})) {
        if (!d || typeof d !== 'object') continue;
        if (typeof d.iconPath === 'string') {
          const abs = path.join(dirTema, d.iconPath);
          const tipo = TIPOS_ICONE[path.extname(abs).toLowerCase()];
          if (!tipo || !dentro(abs)) continue;
          let i = porArquivo.get(abs);
          if (i === undefined) { i = novosIco.push({ abs, tipo }) - 1; porArquivo.set(abs, i); }
          defs[id] = { u: `/temas/icone/${i}${path.extname(abs).toLowerCase()}` };
        } else if (d.fontCharacter) {
          const ch = caracterFonte(d.fontCharacter);
          const f = fontes.find((x) => x.id === (d.fontId || (fontes[0] && fontes[0].id)));
          if (ch && f) defs[id] = { f: f.i, ch, ...(d.fontColor ? { cor: d.fontColor } : {}), ...(d.fontSize ? { tam: d.fontSize } : {}) };
        }
      }
      if (!Object.keys(defs).length) throw new Error('o tema de ícones não tem ícones que o Orbit consiga mostrar');
      const usados = new Set(Object.values(j.languageIds || {}).length ? Object.keys(j.languageIds) : []);
      const filtra = (o) => Object.fromEntries(Object.entries(o).filter(([, id]) => usados.has(id)));
      novoMapa = {
        ok: true, nome: nomeIco, rotulo: traduzir(achado.t.label, achado.e.nls) || nomeIco,
        defs,
        file: j.file || null, folder: j.folder || null, folderExpanded: j.folderExpanded || null,
        fileExtensions: minusculas(j.fileExtensions), fileNames: minusculas(j.fileNames),
        folderNames: minusculas(j.folderNames), folderNamesExpanded: minusculas(j.folderNamesExpanded),
        languageIds: j.languageIds && typeof j.languageIds === 'object' ? { ...j.languageIds } : {},
        langExt: filtra({ ...lgExt, ...assoc.ext }), langNome: filtra({ ...lgNome, ...assoc.nome }),
        fontes: fontes.map((f) => ({ i: f.i, peso: f.peso, estilo: f.estilo, tam: f.tam, formato: path.extname(novasFontes[f.i].abs).slice(1).replace('ttf', 'truetype').replace('otf', 'opentype') })),
      };
      icones = { ok: true, nome: nomeIco, rotulo: novoMapa.rotulo, extensao: nomeExt(achado.e), arquivo: arq, icones: Object.keys(defs).length };
    } catch (e) {
      icones = { ok: false, nome: nomeIco, erro: String(e?.message || e) };
    }

    // Vigias: settings.json (pela pasta, que o VS Code regrava por troca), lista de extensões e os temas ativos.
    const porPasta = new Map();
    const add = (dir, nome) => {
      const k = path.resolve(dir);
      const ant = porPasta.get(k);
      if (ant === null) return;
      if (nome === null) porPasta.set(k, null);
      else porPasta.set(k, [...(ant || []), nome.toLowerCase()]);
    };
    add(path.dirname(c.settings), path.basename(c.settings));
    if (fs.existsSync(c.extensoes)) add(c.extensoes, null);
    for (const a of new Set(vigiarArqs)) add(path.dirname(a), path.basename(a));
    vigiar([...porPasta]);

    return { cor, icones, tema, mapa: novoMapa, novosIco, novasFontes, linguagens: { ext: lgExt, nome: lgNome }, assoc };
  }

  async function recarregar() {
    if (carregando) { pendente = true; return carregando; }
    carregando = (async () => {
      do {
        pendente = false;
        const r = await carregarTudo();
        const sig = JSON.stringify([r.cor, r.icones, r.tema, r.mapa, r.assoc, r.novosIco, r.novasFontes]);
        linguagens = r.linguagens; associacoes = r.assoc;
        if (sig === assinatura) continue;
        const primeira = !assinatura;
        assinatura = sig;
        const versao = Date.now().toString(36);
        temaShiki = r.cor.ok ? r.tema : null;
        mapa = r.mapa ? { ...r.mapa, versao } : null;
        arquivosIcone = r.novosIco; arquivosFonte = r.novasFontes;
        estado = { versao, cor: r.cor, icones: r.icones };
        enviarTema();
        const resumo = (x) => (x.ok ? `"${x.nome}" (${x.extensao})` : `desligado: ${x.erro}`);
        log(`temas: cores ${resumo(r.cor)}; ícones ${resumo(r.icones)}` + (r.cor.ok && r.cor.ajustes.length ? `; ${r.cor.ajustes.length} cor(es) ajustada(s) para contraste` : ''));
        if (!primeira) difundir('temas', { versao, cor: r.cor.ok, icones: r.icones.ok });
      } while (pendente && !parado);
    })().finally(() => { carregando = null; });
    return carregando;
  }
  let pronto = null;
  const garantir = () => (pronto ||= recarregar().catch((e) => log('temas: carga', e?.message || e)));

  // ── worker do realce ──
  let worker = null;
  let seqJob = 0;
  const jobs = new Map();
  function enviarTema() { if (worker && temaShiki) worker.postMessage({ tipo: 'tema', tema: temaShiki }); }
  function obterWorker() {
    if (worker || parado) return worker;
    try {
      worker = new Worker(new URL('./realce.mjs', import.meta.url));
      worker.unref();
      worker.on('message', (m) => {
        if (m && m.tipo === 'tema' && !m.ok) log('temas: o Shiki recusou o tema', m.erro);
        if (!m || m.tipo !== 'realce') return;
        const j = jobs.get(m.id);
        if (!j) return;
        jobs.delete(m.id); clearTimeout(j.t);
        if (m.erro) log('temas: realce', m.erro);
        j.ok(m.realce || null);
      });
      const morreu = (e) => {
        if (e) log('temas: worker do realce', e?.message || e);
        worker = null;
        for (const [id, j] of jobs) { clearTimeout(j.t); j.ok(null); jobs.delete(id); }
      };
      worker.on('error', morreu);
      worker.on('exit', () => morreu());
      enviarTema();
    } catch (e) {
      log('temas: worker do realce não subiu', e?.message || e);
      worker = null;
    }
    return worker;
  }

  function linguagemDe(nome) {
    const n = String(nome || '').toLowerCase();
    const segs = n.split('.');
    const exts = segs.length > 1 ? segs.slice(1).map((_, i) => segs.slice(i + 1).join('.')) : [];
    const daLang = (id) => {
      if (!id) return null;
      const k = String(id).toLowerCase();
      if (k in ALIAS_LANG) return ALIAS_LANG[k];
      return gramaticas.has(k) ? k : null;
    };
    const cands = [
      daLang(associacoes.nome[n]), ...exts.map((x) => daLang(associacoes.ext[x])),
      NOME_LANG[n] || (/^\.env(\..+)?$/.test(n) ? 'dotenv' : null),
      daLang(linguagens.nome[n]), ...exts.map((x) => daLang(linguagens.ext[x])),
      ...exts.map((x) => EXT_LANG[x]),
    ];
    return cands.find((x) => x && gramaticas.has(x)) || null;
  }

  // Realce de um texto (o arquivos.mjs chama, já confinado ao projeto). null = sem realce (a página usa o Orbit).
  async function realcar(texto, nome) {
    await garantir();
    if (parado || !temaShiki || typeof texto !== 'string') return null;
    if (texto.length > MAX_REALCE) return { semRealce: 'grande' };
    let n = 1;
    for (let i = texto.indexOf('\n'); i >= 0 && n <= MAX_LINHAS_REALCE; i = texto.indexOf('\n', i + 1)) n++;
    if (n > MAX_LINHAS_REALCE) return { semRealce: 'grande' };
    const lang = linguagemDe(nome);
    if (!lang) return null;
    const w = obterWorker();
    if (!w) return null;
    const id = ++seqJob;
    return new Promise((ok) => {
      const t = setTimeout(() => {
        // Demorou demais: derruba o worker (o próximo pedido sobe outro).
        jobs.delete(id);
        log('temas: realce passou do limite', nome);
        try { w.terminate(); } catch {}
        ok(null);
      }, LIMITE_REALCE_MS);
      jobs.set(id, { ok: (r) => ok(r ? { ...r, lang, tema: estado.cor.nome, versao: estado.versao } : null), t });
      w.postMessage({ tipo: 'realcar', id, texto, lang });
    });
  }

  async function servirArquivo(res, item, tipoExtra) {
    let dados;
    try { dados = await fsp.readFile(item.abs); } catch { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"erro":"não encontrado"}'); return; }
    const cab = { 'content-type': item.tipo, 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff', ...(tipoExtra || {}) };
    if (item.tipo === 'image/svg+xml') cab['content-security-policy'] = 'sandbox';
    res.writeHead(200, cab);
    res.end(dados);
  }
  function responder(res, codigo, corpo) {
    res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(corpo));
  }

  async function rota(req, res, caminho) {
    if (req.method !== 'GET' || (caminho !== '/temas' && !caminho.startsWith('/temas/'))) return false;
    await garantir();
    if (caminho === '/temas') { responder(res, 200, estado); return true; }
    if (caminho === '/temas/icones') { responder(res, 200, mapa || { ok: false, versao: estado.versao, erro: estado.icones.erro }); return true; }
    let m = /^\/temas\/icone\/(\d{1,6})\.[a-z]{3,4}$/.exec(caminho);
    if (m && arquivosIcone[+m[1]]) { await servirArquivo(res, arquivosIcone[+m[1]]); return true; }
    m = /^\/temas\/fonte\/(\d{1,4})$/.exec(caminho);
    if (m && arquivosFonte[+m[1]]) { await servirArquivo(res, arquivosFonte[+m[1]]); return true; }
    responder(res, 404, { erro: 'não encontrado' });
    return true;
  }

  function parar() {
    parado = true;
    clearTimeout(tVigia);
    for (const w of vigias.values()) { try { w.close(); } catch {} }
    vigias.clear();
    if (worker) { try { worker.terminate(); } catch {} worker = null; }
  }

  garantir();
  return { rota, realcar, linguagemDe, recarregar, estado: () => estado, parar };
}
