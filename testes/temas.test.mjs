// Teste do temas.mjs: node testes/temas.test.mjs <saida>
// Monta um VS Code falso dentro de <saida> (settings.json, extensions.json, uma extensão de tema de cores e uma de
// ícones) e chama criarTemas(...) direto, sem servidor. Não lê nem escreve nada do VS Code real. Apaga <saida> no fim.

import fs from 'node:fs';
import path from 'node:path';
import { criarTemas, lerJSONC, contraste, ajustarContraste, FUNDO_ORBIT, pastaUsuario, acharApp } from '../temas.mjs';

const saidaArg = process.argv[2];
if (!saidaArg) { console.error('uso: node testes/temas.test.mjs <saida>'); process.exit(2); }
const SAIDA = path.resolve(saidaArg);
if (fs.existsSync(SAIDA)) fs.rmSync(SAIDA, { recursive: true, force: true });
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0;
let falhas = 0;
function conferir(cond, nome, extra) {
  if (cond) { ok++; console.log('  ok  ', nome); }
  else { falhas++; console.log('  FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const escrever = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c, null, 2)); };
async function ate(fn, ms = 4000) { const fim = Date.now() + ms; while (Date.now() < fim) { if (await fn()) return true; await esperar(50); } return false; }

// ── VS Code falso ──
const USER = path.join(SAIDA, 'User');
const SETTINGS = path.join(USER, 'settings.json');
const EXT = path.join(SAIDA, 'extensions');
const COR = path.join(EXT, 'eu.tema-1.0.0');
const ICO = path.join(EXT, 'eu.icones-2.0.0');
const VELHA = path.join(EXT, 'eu.icones-1.0.0'); // versão antiga que ficou na pasta: fora do extensions.json
const settings = (o) => escrever(SETTINGS, `// comentário do usuário\n{\n  "workbench.colorTheme": ${JSON.stringify(o.cor)},\n  /* bloco */\n  "workbench.iconTheme": ${JSON.stringify(o.ico)},\n  "url": "http://x//y",\n  "editor.tokenColorCustomizations": ${JSON.stringify(o.personal || {})},\n  "files.associations": { "*.orbit": "typescript" },\n}\n`);
settings({ cor: 'Tema Escuro', ico: 'icones-eu' });
escrever(path.join(EXT, 'extensions.json'), [
  { identifier: { id: 'eu.tema' }, version: '1.0.0', relativeLocation: 'eu.tema-1.0.0' },
  { identifier: { id: 'eu.icones' }, version: '2.0.0', relativeLocation: 'eu.icones-2.0.0' },
]);
escrever(path.join(COR, 'package.json'), { name: 'tema', publisher: 'eu', version: '1.0.0', contributes: { themes: [
  { label: '%escuro%', uiTheme: 'vs-dark', path: './themes/escuro.json' },
  { label: 'Tema Dois', uiTheme: 'vs-dark', path: './themes/dois.json' },
  { label: 'Tema Claro', uiTheme: 'vs', path: './themes/claro.json' },
] } });
escrever(path.join(COR, 'package.nls.json'), { escuro: 'Tema Escuro' });
escrever(path.join(COR, 'themes', 'base.json'), `{ "colors": { "editor.foreground": "#cccccc" }, "tokenColors": [ { "scope": "string", "settings": { "foreground": "#a5d6ff" } }, ] }`);
escrever(path.join(COR, 'themes', 'escuro.json'), `{
  // herda o base
  "include": "./base.json",
  "colors": { "editor.background": "#1f1f1f" },
  "tokenColors": [
    { "settings": { "foreground": "#e1e4e8" } },
    { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#f97583", "fontStyle": "bold" } },
    { "scope": "comment", "settings": { "foreground": "#3a3a3a", "fontStyle": "italic", "background": "#ff0000" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#79b8ff" } },
  ]
}`);
escrever(path.join(COR, 'themes', 'dois.json'), { tokenColors: [{ settings: { foreground: '#ffffff' } }, { scope: 'keyword', settings: { foreground: '#00ff00' } }] });
escrever(path.join(COR, 'themes', 'claro.json'), { tokenColors: [{ settings: { foreground: '#24292e' } }, { scope: 'keyword', settings: { foreground: '#d73a49' } }] });
escrever(path.join(ICO, 'package.json'), { name: 'icones', publisher: 'eu', version: '2.0.0', contributes: { iconThemes: [{ id: 'icones-eu', label: 'Ícones Eu', path: './tema/icones.json' }], languages: [{ id: 'linguaeu', extensions: ['.leu'] }] } });
escrever(path.join(ICO, 'tema', 'svg', 'doc.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>');
escrever(path.join(ICO, 'tema', 'svg', 'ts.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
escrever(path.join(ICO, 'tema', 'svg', 'pasta.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
escrever(path.join(ICO, 'tema', 'png', 'p.png'), Buffer.from('89504e470d0a1a0a', 'hex').toString('latin1'));
escrever(path.join(SAIDA, 'segredo.svg'), '<svg>segredo</svg>');
escrever(path.join(ICO, 'tema', 'icones.json'), `{
  "iconDefinitions": {
    "doc": { "iconPath": "./svg/doc.svg" }, "ts": { "iconPath": "./svg/ts.svg" }, "pasta": { "iconPath": "./svg/pasta.svg" },
    "spec": { "iconPath": "./png/p.png" }, "leu": { "iconPath": "./svg/doc.svg" }, "fuga": { "iconPath": "../../../segredo.svg" },
    "exe": { "iconPath": "./svg/x.exe" }
  },
  "file": "doc", "folder": "pasta",
  "fileExtensions": { "ts": "ts", "spec.ts": "spec", "evil": "fuga" },
  "fileNames": { "Package.json": "spec" },
  "folderNames": { "src": "ts" },
  "languageIds": { "linguaeu": "leu" },
}`);
escrever(path.join(VELHA, 'package.json'), { name: 'icones', publisher: 'eu', version: '1.0.0', contributes: { iconThemes: [{ id: 'icones-eu', label: 'velho', path: './x.json' }] } });

const fake = () => { const r = { c: 0, h: null, body: '' }; return { writeHead(c, h) { r.c = c; r.h = h; }, end(b) { r.body = b; }, r }; };
async function get(t, url) { const res = fake(); const tratou = await t.rota({ method: 'GET' }, res, url); return { tratou, c: res.r.c, h: res.r.h || {}, body: res.r.body, json: () => JSON.parse(res.r.body) }; }

console.log('JSONC e contraste');
conferir(lerJSONC('{"a":"x//y", /* c */ "b":[1,2,],}').a === 'x//y', 'lerJSONC mantém // dentro de string e tira vírgula sobrando');
conferir(lerJSONC('{"a":"tem, vírgula ]"}').a === 'tem, vírgula ]', 'lerJSONC não mexe em vírgula dentro de string');
conferir(Math.abs(contraste('#ffffff', '#000000') - 21) < 0.01, 'contraste branco/preto = 21');
const aj = ajustarContraste('#3a3a3a', FUNDO_ORBIT);
conferir(aj !== '#3a3a3a' && contraste(aj, FUNDO_ORBIT) >= 4.5 && contraste(aj, FUNDO_ORBIT) < 4.8, 'cor escura clareada só até 4,5:1', aj);
conferir(ajustarContraste('#f97583', FUNDO_ORBIT) === '#f97583', 'cor com contraste bom fica igual');

// Cópia intacta das extensões falsas, para o Mac simulado no fim (as de cima são estragadas de propósito).
const EXT_MAC = path.join(SAIDA, 'ext-copia');
fs.cpSync(EXT, EXT_MAC, { recursive: true });

console.log('carga');
const ev = [];
const logs = [];
const t = criarTemas({ settings: SETTINGS, extensoes: EXT, app: null, difundir: (tipo, d) => ev.push([tipo, d]), log: (...a) => logs.push(a.join(' ')) });
let r = await get(t, '/temas');
let est = r.json();
conferir(r.tratou && r.c === 200, 'GET /temas responde');
conferir(est.cor.ok && est.cor.nome === 'Tema Escuro' && est.cor.extensao === 'eu.tema 1.0.0', 'tema de cores achado pelo rótulo traduzido (package.nls.json)', est.cor);
conferir(est.cor.texto === '#e1e4e8', 'cor padrão do texto vem da regra sem escopo', est.cor.texto);
conferir(est.cor.regras >= 5, 'include junta as regras do tema base', est.cor.regras);
conferir(est.cor.ajustes.length === 1 && est.cor.ajustes[0].de === '#3a3a3a' && est.cor.ajustes[0].onde.includes('comment'), 'só a cor de baixo contraste é ajustada e o escopo é informado', est.cor.ajustes);
conferir(est.icones.ok && est.icones.extensao === 'eu.icones 2.0.0', 'tema de ícones da versão do extensions.json (não a pasta antiga)', est.icones);
conferir(ev.length === 0, 'a primeira carga não difunde');

console.log('ícones');
r = await get(t, '/temas/icones');
let m = r.json();
conferir(m.ok && m.file === 'doc' && m.folder === 'pasta', 'mapa com padrões de arquivo e pasta');
conferir(!m.defs.fuga && !m.defs.exe, 'ícone fora da extensão ou de tipo estranho fica de fora', Object.keys(m.defs));
conferir(m.fileNames['package.json'] === 'spec' && m.fileExtensions['spec.ts'] === 'spec', 'chaves em minúsculas, como o VS Code compara');
conferir(m.langExt.leu === 'linguaeu' && !('ts' in m.langExt), 'linguagens só as que o tema usa', m.langExt);
conferir(m.langExt.orbit === undefined, 'files.associations só entra se a linguagem tiver ícone no tema');
const urlTs = m.defs.ts.u;
r = await get(t, urlTs);
conferir(r.c === 200 && r.h['content-type'] === 'image/svg+xml' && r.h['content-security-policy'] === 'sandbox' && r.h['x-content-type-options'] === 'nosniff', 'SVG servido com sandbox e nosniff', r.h);
r = await get(t, m.defs.spec.u);
conferir(r.c === 200 && r.h['content-type'] === 'image/png', 'PNG servido');
r = await get(t, '/temas/icone/999.svg');
conferir(r.c === 404, 'índice inexistente dá 404');
r = await get(t, '/temas/icone/..%2F..%2Fsegredo.svg');
conferir(r.c === 404, 'caminho no lugar do índice dá 404');
conferir(!(await get(t, '/temasx')).tratou && !(await get(t, '/arquivos/ler')).tratou, 'rotas de fora não são tratadas');

console.log('gramáticas e realce');
conferir(t.linguagemDe('a.ts') === 'typescript' && t.linguagemDe('App.tsx') === 'tsx' && t.linguagemDe('x.mjs') === 'javascript', 'ts, tsx, mjs');
conferir(t.linguagemDe('p.astro') === 'astro' && t.linguagemDe('a.py') === 'python' && t.linguagemDe('i.cmd') === 'bat' && t.linguagemDe('tsconfig.json') === 'jsonc', 'astro, python, bat, jsonc');
conferir(t.linguagemDe('x.orbit') === 'typescript', 'files.associations do usuário escolhe a gramática');
conferir(t.linguagemDe('x.txt') === null && t.linguagemDe('semext') === null, 'texto puro sem gramática');
const codigo = 'const n = 42; // nota\nexport function f() { return "s"; }\n';
let re = await t.realcar(codigo, 'a.ts');
conferir(re && Array.isArray(re.linhas) && re.lang === 'typescript' && re.tema === 'Tema Escuro', 'realce de TypeScript', re && { lang: re.lang, tema: re.tema });
const corDe = (re, txt) => { for (const l of re.linhas) for (const tk of l) if (tk[0].includes(txt)) return { cor: re.cores[tk[1]], estilo: tk[2] || 0 }; return null; };
conferir(corDe(re, 'const').cor === '#f97583' && corDe(re, 'const').estilo === 2, 'palavra-chave na cor do tema e em negrito', corDe(re, 'const'));
conferir(corDe(re, '42').cor === '#79b8ff', 'número na cor do tema');
conferir(corDe(re, '"s"').cor === '#a5d6ff', 'string vem do tema base (include)');
const com = corDe(re, '// nota');
conferir(com.cor === est.cor.ajustes[0].para && com.estilo === 1, 'comentário com a cor ajustada e itálico', com);
conferir(re.fg === '#e1e4e8' && re.cores[0] === re.fg, 'cor 0 é a padrão do texto');
conferir(re.linhas[0].map((x) => x[0]).join('') === 'const n = 42; // nota', 'texto da linha preservado');
conferir(!JSON.stringify(re).includes('#ff0000'), 'fundo de trecho do tema não passa');
conferir(await t.realcar('só texto', 'x.txt') === null, 'sem gramática: sem realce');
const grande = await t.realcar('x\n'.repeat(20001), 'a.ts');
conferir(grande && grande.semRealce === 'grande' && !grande.linhas, 'arquivo grande demais: sem realce');
re = await t.realcar('<p>{a}</p>\n<script>const x = 1</script>', 'p.html');
conferir(re && corDe(re, 'const') && corDe(re, 'const').cor === '#f97583', 'HTML com JS embutido realçado');

console.log('troca no VS Code');
settings({ cor: 'Tema Dois', ico: 'icones-eu', personal: { comments: '#123456' } });
conferir(await ate(() => ev.some(([tipo]) => tipo === 'temas')), 'trocar o tema no settings.json avisa a página (SSE temas)', ev);
est = (await get(t, '/temas')).json();
conferir(est.cor.ok && est.cor.nome === 'Tema Dois', 'novo tema carregado', est.cor);
re = await t.realcar('if (a) b()', 'a.ts');
conferir(re && corDe(re, 'if').cor === '#00ff00' && re.tema === 'Tema Dois', 'realce usa o tema novo', re && corDe(re, 'if'));
re = await t.realcar('// c\n', 'a.ts');
conferir(re && corDe(re, '// c').cor !== '#123456' && contraste(corDe(re, '// c').cor, FUNDO_ORBIT) >= 4.5, 'tokenColorCustomizations aplicado (e ajustado para contraste)', re && corDe(re, '// c'));
const versaoAntes = est.versao;
ev.length = 0;
escrever(path.join(COR, 'themes', 'dois.json'), { tokenColors: [{ settings: { foreground: '#ffffff' } }, { scope: 'keyword', settings: { foreground: '#ff9900' } }] });
conferir(await ate(() => ev.some(([tipo]) => tipo === 'temas')), 'editar o arquivo do tema ativo também avisa');
re = await t.realcar('if (a) b()', 'a.ts');
conferir(re && corDe(re, 'if').cor === '#ff9900', 'realce com o arquivo editado');
conferir((await get(t, '/temas')).json().versao !== versaoAntes, 'versão muda');

console.log('temas ilegíveis → visual do Orbit');
ev.length = 0;
settings({ cor: 'Não Existe', ico: 'nao-existe' });
await ate(() => ev.some(([tipo]) => tipo === 'temas'));
est = (await get(t, '/temas')).json();
conferir(!est.cor.ok && /não está em nenhuma extensão/.test(est.cor.erro), 'tema de cores ausente: desligado com motivo', est.cor);
conferir(await t.realcar('let a = 1', 'a.ts') === null, 'sem tema de cores: sem realce');
m = (await get(t, '/temas/icones')).json();
conferir(m.ok === false && typeof m.erro === 'string', 'tema de ícones ausente: mapa desligado', m);
conferir((await get(t, urlTs)).c === 404, 'ícones antigos deixam de ser servidos');
ev.length = 0;
settings({ cor: 'Tema Escuro', ico: null });
await ate(() => ev.some(([tipo]) => tipo === 'temas'));
m = (await get(t, '/temas/icones')).json();
est = (await get(t, '/temas')).json();
conferir(est.cor.ok && m.ok === false, 'iconTheme null: cores de volta, ícones do Orbit');
ev.length = 0;
escrever(SETTINGS, '{ "workbench.colorTheme": ');
await ate(() => ev.some(([tipo]) => tipo === 'temas'));
est = (await get(t, '/temas')).json();
conferir(!est.cor.ok || est.cor.nome === 'Default Dark Modern', 'settings.json quebrado: cai no padrão do VS Code (que aqui não existe)', est.cor);
conferir(logs.some((l) => /temas: cores/.test(l)), 'situação registrada no log');

t.parar();
const t2 = criarTemas({ settings: path.join(SAIDA, 'nada', 'settings.json'), extensoes: path.join(SAIDA, 'nada'), app: null });
est = (await get(t2, '/temas')).json();
conferir(!est.cor.ok && !est.icones.ok, 'sem VS Code: tudo desligado sem erro');
t2.parar();

// ── onde está o VS Code, por sistema (16/10); o Mac é simulado com so 'darwin' e uma home falsa ──
console.log('Mac simulado e caminhos por sistema');
conferir(pastaUsuario({ so: 'darwin', home: '/Users/t', env: {} }) === '/Users/t/Library/Application Support/Code/User', 'Mac: settings em ~/Library/Application Support/Code/User');
conferir(pastaUsuario({ so: 'win32', home: 'C:\\Users\\t', env: { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' } }) === 'C:\\Users\\t\\AppData\\Roaming\\Code\\User', 'Windows: settings em %APPDATA%\\Code\\User (como antes)');
const HMAC = path.join(SAIDA, 'mac-home');
const APP_MAC = path.join(HMAC, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app');
conferir(acharApp({ so: 'darwin', home: HMAC, env: {} }) === null, 'Mac: sem o .app, sem extensões embutidas');
fs.mkdirSync(path.join(APP_MAC, 'extensions'), { recursive: true });
const achadoMac = acharApp({ so: 'darwin', home: HMAC, env: {} });
conferir(achadoMac && path.resolve(achadoMac) === path.resolve(APP_MAC), 'Mac: acha ~/Applications/Visual Studio Code.app/Contents/Resources/app', achadoMac);
conferir(acharApp({ so: 'darwin', home: HMAC, env: { GERENCIADOR_VSCODE_APP: 'nenhum' } }) === null, 'GERENCIADOR_VSCODE_APP=nenhum continua valendo');
// Windows: pasta padrão com a subpasta de hash; o code.cmd do PATH vem antes.
const LAD = path.join(SAIDA, 'win-local');
const HASH = path.join(LAD, 'Programs', 'Microsoft VS Code', '6d62b1d5da', 'resources', 'app');
fs.mkdirSync(path.join(HASH, 'extensions'), { recursive: true });
// Só no Windows de verdade: a pasta padrão vem do appsVSCode com path.win32 (barras invertidas), que não
// anda numa pasta temporária do Mac. No Mac, os equivalentes são os de ~/Applications acima.
if (process.platform === 'win32') conferir(acharApp({ so: 'win32', home: SAIDA, env: { LOCALAPPDATA: LAD, PATH: '' } }) === HASH, 'Windows: pasta padrão com subpasta de hash', HASH);
const OUTRO = path.join(SAIDA, 'win-outro');
fs.mkdirSync(path.join(OUTRO, 'resources', 'app', 'extensions'), { recursive: true });
escrever(path.join(OUTRO, 'bin', 'code.cmd'), '@echo off');
conferir(acharApp({ so: 'win32', home: SAIDA, env: { LOCALAPPDATA: LAD, PATH: path.join(OUTRO, 'bin') } }) === path.join(OUTRO, 'resources', 'app'), 'Windows: o code.cmd do PATH continua valendo e vem primeiro');
// criarTemas lendo o settings.json e as extensões nos lugares do Mac.
fs.cpSync(EXT_MAC, path.join(HMAC, '.vscode', 'extensions'), { recursive: true });
escrever(path.join(HMAC, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), { 'workbench.colorTheme': 'Tema Escuro', 'workbench.iconTheme': 'icones-eu' });
const tm = criarTemas({ sistema: { so: 'darwin', home: HMAC, env: {} } });
est = (await get(tm, '/temas')).json();
conferir(est.cor.ok && est.cor.nome === 'Tema Escuro' && est.icones.ok, 'Mac: tema de cores e de ícones lidos dos caminhos do Mac', est);
tm.parar();

await esperar(100);
fs.rmSync(SAIDA, { recursive: true, force: true });
console.log(`\n${ok} ok / ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
