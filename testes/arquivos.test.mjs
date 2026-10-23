// Teste do arquivos.mjs (rodada 8): node testes/arquivos.test.mjs <saida>
// Sobe um servidor HTTP mínimo próprio (porta livre 47822–47826) que só chama criarArquivos(...).rota.
// Tudo (dados, projetos, lixeira falsa, raiz temporária falsa) fica dentro de <saida>, apagada no fim.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const saidaArg = process.argv[2];
if (!saidaArg) { console.error('uso: node testes/arquivos.test.mjs <saida>'); process.exit(2); }
const SAIDA = path.resolve(saidaArg);
if (fs.existsSync(SAIDA)) fs.rmSync(SAIDA, { recursive: true, force: true });
fs.mkdirSync(SAIDA, { recursive: true });

const DADOS = path.join(SAIDA, 'dados');
const LIXO = path.join(SAIDA, 'lixeira-falsa');
const TMPF = path.join(SAIDA, 'tmp-falso');
const FORA = path.join(SAIDA, 'fora');
const A = path.join(SAIDA, 'projA');
const B = path.join(SAIDA, 'projB');
process.env.ORBIT_LIXEIRA_FALSA = LIXO;
process.env.ORBIT_PASTAS_TEMP = TMPF;

let ok = 0;
let falhas = 0;
function conferir(cond, nome, extra) {
  if (cond) { ok++; console.log('  ok  ', nome); }
  else { falhas++; console.log('  FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const escrever = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

// ── cenário ──
escrever(path.join(A, 'src', 'app.js'), 'const x = 1;\nfunction ola() { return "Olá Mundo"; }\n');
escrever(path.join(A, 'src', 'util.mjs'), '\ufeffexport const mundo = "mundo";\n');
escrever(path.join(A, 'a10.txt'), 'dez');
escrever(path.join(A, 'a2.txt'), 'dois');
escrever(path.join(A, 'Zeta.md'), '# Zeta\nmundo grande\n');
escrever(path.join(A, '.git', 'config'), '[core] mundo');
escrever(path.join(A, 'node_modules', 'pkg', 'index.js'), 'mundo mundo');
escrever(path.join(A, 'Thumbs.db'), 'x');
fs.writeFileSync(path.join(A, 'bin.dat'), Buffer.from([1, 2, 0, 3, 109, 117, 110, 100, 111]));
fs.writeFileSync(path.join(A, 'grande.txt'), Buffer.alloc(2 * 1024 * 1024 + 10, 97));
fs.writeFileSync(path.join(A, 'img.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
escrever(path.join(A, 'desenho.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
escrever(path.join(A, 'longa.txt'), 'x'.repeat(1000) + 'ACHADO' + 'y'.repeat(1000));
escrever(path.join(B, 'leia.md'), 'projeto B');
escrever(path.join(FORA, 'segredo.txt'), 'não pode ler');
escrever(path.join(TMPF, 'temp1', 'x.txt'), 'x');
// Junção que escapa (não exige admin). No Mac, um link simbólico para a pasta de fora (o equivalente).
const WIN = process.platform === 'win32';
const jr = WIN
  ? spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(A, 'escape'), FORA], { encoding: 'utf8' })
  : (() => { try { fs.symlinkSync(FORA, path.join(A, 'escape'), 'dir'); return { stdout: '', stderr: '' }; } catch (e) { return { stdout: '', stderr: e.message }; } })();
const temJuncao = fs.existsSync(path.join(A, 'escape', 'segredo.txt'));
// Caminho real (no Mac, /tmp é /private/tmp e o projeto entra pelo real). No Windows, o próprio caminho.
const real = (p) => (WIN ? p : fs.realpathSync.native(p));

// ── servidor mínimo ──
const eventos = [];
const sessoesFalsas = [
  { id: 's1', cwd: A },
  { id: 's2', cwd: path.join(TMPF, 'temp1') },
  { id: 's3', cwd: path.join(SAIDA, 'nao-existe') },
];
const { criarArquivos } = await import(pathToFileURL(path.join(RAIZ, 'arquivos.mjs')).href);
async function lerJSONCorpo(req) {
  let s = '';
  for await (const c of req) s += c;
  try { return s.trim() ? JSON.parse(s) : {}; } catch { const e = new Error('JSON inválido'); e.status = 400; throw e; }
}
const mod = criarArquivos({
  dados: DADOS,
  sessoes: () => sessoesFalsas.values(),
  difundir: (tipo, dados) => eventos.push({ tipo, dados, t: Date.now() }),
  lerJSONCorpo,
  log: () => {},
  teste: true,
});
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!(await mod.rota(req, res, url.pathname, url))) { res.writeHead(404); res.end('{}'); }
});
const PORTA = await escolherPorta(47822);
await new Promise((r) => servidor.listen(PORTA, '127.0.0.1', r));
console.log(`servidor mínimo na ${PORTA}; saída ${SAIDA}`);

async function get(rota, q = {}) {
  const u = new URL(`http://127.0.0.1:${PORTA}${rota}`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const tipo = r.headers.get('content-type') || '';
  const corpo = tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { s: r.status, j: corpo, h: r.headers };
}
async function post(rota, corpo, cab = { 'x-gerenciador': '1' }) {
  const r = await fetch(`http://127.0.0.1:${PORTA}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json', ...cab }, body: JSON.stringify(corpo) });
  return { s: r.status, j: await r.json().catch(() => null) };
}

async function macSimulado() {
  const { OSA_LIXEIRA, OSA_ESCOLHER, checarLixeiraMac, lerMontagensOcultas } = await import(pathToFileURL(path.join(RAIZ, 'arquivos.mjs')).href);
  const MAC = path.join(SAIDA, 'mac');
  const HOME = path.join(MAC, 'home');
  const VOLS = path.join(MAC, 'Volumes');
  const LIXO_MAC = path.join(HOME, '.Trash');
  const MP = path.join(HOME, 'Projetos', 'macproj');
  let MPR = MP; // caminho real do projeto (no Mac de verdade, /private/tmp/…), lido depois de criar a pasta
  for (const d of ['Desktop', 'Documents', 'Library', '.config', 'Projetos']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
  for (const d of ['Macintosh HD', 'Pendrive', '.oculto', 'Recovery']) fs.mkdirSync(path.join(VOLS, d), { recursive: true });
  fs.mkdirSync(LIXO_MAC, { recursive: true });
  escrever(path.join(MP, 'x.txt'), 'x');
  escrever(path.join(MP, "it's & $(rm) ; x.txt"), 'aspas');
  escrever(path.join(MP, 'pasta', 'y.txt'), 'y');
  escrever(path.join(MP, 'z.txt'), 'z');
  escrever(path.join(MP, 'fica.txt'), 'fica');
  MPR = real(MP);

  let modo = 'ok';
  const chamadas = [];
  const mostrados = [];
  let mostrarFalha = false;
  // osascript falso: faz o que o Finder faria (move para ~/.Trash e diz onde ficou) ou simula as falhas.
  const osascript = async (linhas, args) => {
    chamadas.push({ linhas, args });
    if (linhas === OSA_ESCOLHER) {
      if (modo === 'cancelar') return { codigo: 1, saida: '', erro: 'execution error: User canceled. (-128)' };
      return { codigo: 0, saida: '/Users/voce/Projetos/escolhida/\n', erro: '' };
    }
    if (modo === 'negado') return { codigo: 1, saida: '', erro: 'execution error: Not authorized to send Apple events to Finder. (-1743)' };
    if (modo === 'ficou') return { codigo: 0, saida: '/Users/voce/.Trash/x.txt\n', erro: '' };
    const alvo = path.join(LIXO_MAC, path.basename(args[0]));
    fs.renameSync(args[0], alvo);
    return { codigo: 0, saida: modo === 'semdestino' ? '\n' : alvo.split(path.sep).join('/') + '\n', erro: '' };
  };
  const mostrar = async (abs) => { if (mostrarFalha) throw new Error('open falhou'); mostrados.push(abs); };
  const abertas = [];
  const abrirPasta = async (abs) => { abertas.push(abs); };
  const criar = (home, dados) => criarArquivos({
    dados, sessoes: () => [], lerJSONCorpo: async (req) => req.corpo, log: () => {},
    so: 'darwin', osascript, mostrar, abrirPasta, home, volumes: VOLS, lixeiraFalsa: '',
    montagensOcultas: async () => new Set([path.join(VOLS, 'Recovery')]), // como o "nobrowse" do mount
  });
  const modMac = criar(HOME, path.join(MAC, 'dados'));
  // Chamada direta da rota, sem HTTP.
  const chamar = async (m, metodo, rota, corpo, q = {}) => {
    const url = new URL('http://127.0.0.1' + rota);
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
    const res = { headersSent: false, s: 0, b: '', writeHead(s) { this.s = s; this.headersSent = true; }, end(b) { this.b = String(b || ''); } };
    await m.rota({ method: metodo, headers: { 'x-gerenciador': '1' }, corpo }, res, url.pathname, url);
    let j = null;
    try { j = JSON.parse(res.b); } catch {}
    return { s: res.s, j };
  };
  try {
    let r = await get('/projetos');
    conferir(r.j.plataforma === process.platform, `${WIN ? 'Windows' : 'Mac'}: GET /projetos diz plataforma ${process.platform}`, r.j.plataforma);
    r = await chamar(modMac, 'GET', '/projetos');
    conferir(r.s === 200 && r.j.plataforma === 'darwin', 'Mac: GET /projetos diz plataforma darwin', r.j);
    r = await chamar(modMac, 'POST', '/projetos/adicionar', { pasta: MP });
    conferir(r.s === 201 && r.j.projeto.nome === 'macproj', 'Mac: adicionar projeto', r);

    // Lixeira pelo Finder: caminho como argumento, nunca no texto do script.
    chamadas.length = 0;
    r = await chamar(modMac, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: ['x.txt'] });
    const c0 = chamadas[0];
    conferir(r.s === 200 && r.j.enviados === 1 && !fs.existsSync(path.join(MP, 'x.txt')) && fs.existsSync(path.join(LIXO_MAC, 'x.txt')),
      'Mac: excluir manda para a Lixeira pelo osascript', { r, chamadas: chamadas.length });
    conferir(c0 && c0.linhas === OSA_LIXEIRA && c0.args.length === 1 && c0.args[0] === path.join(MPR, 'x.txt'), 'Mac: osascript recebe o caminho como argumento', c0);
    const textoScript = OSA_LIXEIRA.join('\n');
    conferir(/^on run argv/.test(textoScript) && /item 1 of argv/.test(textoScript) && /tell application "Finder"/.test(textoScript) && /delete/.test(textoScript),
      'Mac: script fixo com on run argv + Finder delete', textoScript);
    chamadas.length = 0;
    const estranho = "it's & $(rm) ; x.txt";
    r = await chamar(modMac, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: [estranho] });
    conferir(r.s === 200 && chamadas[0]?.args[0] === path.join(MPR, estranho) && !chamadas[0].linhas.join('\n').includes(estranho),
      'Mac: nome com aspas, & e $() vai intacto como argumento e fora do script', { r, c: chamadas[0] });
    chamadas.length = 0;
    r = await chamar(modMac, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: ['pasta', 'pasta/y.txt', 'z.txt'] });
    conferir(r.s === 200 && r.j.enviados === 2 && chamadas.length === 2 && fs.existsSync(path.join(LIXO_MAC, 'pasta', 'y.txt')),
      'Mac: vários itens, sem mandar o que já vai dentro da pasta', { r, n: chamadas.length });

    modo = 'negado';
    r = await chamar(modMac, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: ['fica.txt'] });
    conferir(r.s === 409 && r.j.motivo === 'sem-permissao' && /Automação/.test(r.j.erro) && fs.existsSync(path.join(MP, 'fica.txt')),
      'Mac: sem permissão de Automação → 409, nada sai do lugar', r);
    modo = 'ficou';
    r = await chamar(modMac, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: ['fica.txt'] });
    conferir(r.s === 500 && r.j.motivo === 'falhou' && fs.existsSync(path.join(MP, 'fica.txt')), 'Mac: item que continua no lugar → falhou', r);
    modo = 'semdestino';
    escrever(path.join(MP, 'some.txt'), 's');
    r = await chamar(modMac, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: ['some.txt'] });
    conferir(r.s === 500 && r.j.motivo === 'nao-conferido', 'Mac: Finder sem dizer onde ficou → nao-conferido', r);
    modo = 'ok';

    // Volume sem Lixeira: o Orbit não envia nada.
    const longe = path.join(SAIDA, 'nao-existe-home');
    conferir((await checarLixeiraMac(path.join(MP, 'fica.txt'), HOME)) === null, 'Mac: mesmo volume da pasta do usuário tem Lixeira');
    const semL = await checarLixeiraMac(path.join(MP, 'fica.txt'), longe);
    conferir(typeof semL === 'string' && /não tem Lixeira/.test(semL), 'Mac: volume sem .Trashes não tem Lixeira', semL);
    const modLonge = criar(longe, path.join(MAC, 'dados2'));
    await chamar(modLonge, 'POST', '/projetos/adicionar', { pasta: MP });
    chamadas.length = 0;
    r = await chamar(modLonge, 'POST', '/arquivos/excluir', { projeto: 'macproj', caminhos: ['fica.txt'] });
    conferir(r.s === 409 && r.j.motivo === 'sem-lixeira' && !chamadas.length && fs.existsSync(path.join(MP, 'fica.txt')),
      'Mac: sem Lixeira no volume → 409 sem chamar o Finder', r);
    modLonge.parar();

    // Mostrar no Finder.
    r = await chamar(modMac, 'POST', '/arquivos/revelar', { projeto: 'macproj', caminho: 'fica.txt' });
    conferir(r.s === 200 && mostrados[0] === path.join(MPR, 'fica.txt'), 'Mac: revelar usa mostrarNaPasta com o caminho', { r, mostrados });
    mostrarFalha = true;
    r = await chamar(modMac, 'POST', '/arquivos/revelar', { projeto: 'macproj', caminho: 'fica.txt' });
    conferir(r.s === 500 && /Finder/.test(r.j.erro), 'Mac: falha ao mostrar cita o Finder', r);
    mostrarFalha = false;
    r = await chamar(modMac, 'POST', '/arquivos/abrir-pasta', { projeto: 'macproj', caminho: '' });
    conferir(r.s === 200 && abertas[0] === MPR, 'Mac: abrir na pasta usa abrirPasta com a raiz do projeto', { r, abertas });

    // Seletor: raízes = pasta do usuário e /Volumes/*; listagem sem ocultas.
    r = await chamar(modMac, 'GET', '/arquivos/pastas');
    const uns = (r.j.unidades || []).map((u) => u.nome);
    conferir(r.s === 200 && uns.join() === 'Macintosh HD,Pendrive' && r.j.unidades[0].caminho === path.join(VOLS, 'Macintosh HD') && r.j.plataforma === 'darwin',
      'Mac: unidades = /Volumes/* (sem ocultas nem nobrowse)', r.j);
    const montagens = lerMontagensOcultas([
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
      '/dev/disk3s3 on /Volumes/Recovery (apfs, local, journaled, nobrowse)',
      '/dev/disk4s1 on /Volumes/Meu Pendrive (msdos, local, nodev, nosuid, noowners)',
    ].join('\n'));
    conferir([...montagens].join() === '/System/Volumes/Data,/Volumes/Recovery', 'Mac: lerMontagensOcultas pega só as nobrowse', [...montagens]);
    conferir(r.j.atalhos?.[0]?.caminho === HOME && r.j.atalhos.some((a) => a.caminho === path.join(HOME, 'Desktop')) && r.j.atalhos.some((a) => a.caminho === path.join(HOME, 'Documents')),
      'Mac: atalhos com a pasta do usuário, Desktop e Documents', r.j.atalhos);
    r = await chamar(modMac, 'GET', '/arquivos/pastas', null, { caminho: HOME });
    const nomesHome = (r.j.pastas || []).map((p) => p.nome);
    conferir(r.s === 200 && nomesHome.join() === 'Desktop,Documents,Projetos', 'Mac: pasta do usuário sem Library e sem .config', nomesHome);

    // Janela "Escolher pasta".
    chamadas.length = 0;
    r = await chamar(modMac, 'POST', '/arquivos/escolher-pasta', {});
    conferir(r.s === 200 && r.j.caminho === '/Users/voce/Projetos/escolhida' && chamadas[0]?.linhas === OSA_ESCOLHER && chamadas[0].args.length === 1,
      'Mac: escolher pasta devolve o caminho sem barra no fim', { r, c: chamadas[0] });
    conferir(/choose folder/.test(OSA_ESCOLHER.join('\n')) && /on run argv/.test(OSA_ESCOLHER.join('\n')), 'Mac: script do seletor usa choose folder com argv');
    modo = 'cancelar';
    r = await chamar(modMac, 'POST', '/arquivos/escolher-pasta', {});
    conferir(r.s === 200 && r.j.cancelado === true, 'Mac: cancelar a janela → cancelado', r);
    modo = 'ok';
    // Windows: o módulo da máquina. No Mac, um Windows simulado (so: 'win32'): o do Mac abriria a janela.
    if (WIN) r = await post('/arquivos/escolher-pasta', {});
    else {
      const modWin = criarArquivos({ dados: path.join(MAC, 'dados-win'), sessoes: () => [], lerJSONCorpo: async (req) => req.corpo, log: () => {}, so: 'win32', osascript });
      chamadas.length = 0;
      r = await chamar(modWin, 'POST', '/arquivos/escolher-pasta', {});
      modWin.parar();
      conferir(!chamadas.length, 'Windows simulado: escolher-pasta não chama o osascript', chamadas);
    }
    conferir(r.s === 409 && r.j.motivo === 'sem-seletor', 'Windows: escolher-pasta → 409 (o seletor é o da página)', r);
    // Servidor de teste (teste: true) sem osascript falso: nunca abre a janela de verdade.
    const modT = criarArquivos({ dados: path.join(MAC, 'dados-t'), sessoes: () => [], lerJSONCorpo: async (req) => req.corpo, log: () => {}, so: 'darwin', teste: true });
    r = await chamar(modT, 'POST', '/arquivos/escolher-pasta', {});
    modT.parar();
    conferir(r.s === 200 && r.j.cancelado === true, 'Mac em teste sem osascript falso: escolher-pasta não abre a janela', r);
  } finally {
    modMac.parar();
  }
}

try {
  // ── grep: nada de apagar de vez ──
  console.log('grep');
  const fonte = fs.readFileSync(path.join(RAIZ, 'arquivos.mjs'), 'utf8');
  const proibido = fonte.match(/\bfs\.rm\b|\bfsp\.rm\b|\brm\s*\(|rmSync|unlink|rmdir|Remove-Item/gi);
  conferir(!proibido, 'arquivos.mjs sem fs.rm/rmSync/unlink/rmdir/Remove-Item', proibido);

  // ── projetos e descoberta ──
  console.log('projetos');
  let r = await get('/projetos');
  conferir(r.s === 200 && r.j.projetos.length === 1 && r.j.projetos[0].nome === 'projA' && r.j.projetos[0].existe === true,
    '1ª carga nasce das sessões (temporária e inexistente fora)', r.j);
  r = await post('/projetos/adicionar', { pasta: B });
  conferir(r.s === 201 && r.j.projeto.nome === 'projB' && r.j.projetos.map((p) => p.nome).join() === 'projA,projB', 'adicionar → 201', r);
  r = await post('/projetos/adicionar', { pasta: B });
  conferir(r.s === 200 && r.j.projetos.length === 2, 'adicionar repetido → 200 com a lista', r);
  r = await post('/projetos/adicionar', { pasta: path.join(TMPF, 'temp1') });
  conferir(r.s === 400 && r.j.motivo === 'temporaria', 'adicionar temporária → 400 temporaria', r);
  r = await post('/projetos/adicionar', { pasta: path.join(SAIDA, 'nao-existe') });
  conferir(r.s === 404, 'adicionar inexistente → 404', r);
  fs.mkdirSync(path.join(SAIDA, 'outra', 'projA'), { recursive: true });
  r = await post('/projetos/adicionar', { pasta: path.join(SAIDA, 'outra', 'projA') });
  conferir(r.s === 409 && r.j.motivo === 'nome', 'nome repetido → 409 nome', r);
  r = await post('/projetos/adicionar', { pasta: B }, {});
  conferir(r.s === 403, 'POST sem x-gerenciador → 403', r);
  conferir(eventos.some((e) => e.tipo === 'projetos' && e.dados.projetos.length === 2), 'SSE projetos difundido');

  mod.sessaoVista({ cwd: path.join(TMPF, 'temp1') });
  const C = path.join(SAIDA, 'projC');
  fs.mkdirSync(C);
  mod.sessaoVista({ cwd: C });
  mod.sessaoVista({ cwd: path.join(SAIDA, 'sumiu') });
  await esperar(200);
  r = await get('/projetos');
  conferir(r.j.projetos.map((p) => p.nome).join() === 'projA,projB,projC', 'descoberta: só a pasta real e não temporária entra', r.j);
  r = await post('/projetos/remover', { nome: 'projC' });
  conferir(r.s === 200 && r.j.projetos.length === 2 && fs.existsSync(C), 'remover tira da lista sem mexer na pasta', r);
  mod.sessaoVista({ cwd: C });
  await esperar(200);
  r = await get('/projetos');
  conferir(!r.j.projetos.some((p) => p.nome === 'projC'), 'removido não volta pela descoberta');
  const salvo = JSON.parse(fs.readFileSync(path.join(DADOS, 'projetos.json'), 'utf8'));
  conferir(salvo.ocultos.length === 1 && salvo.ocultos[0] === real(C).toLowerCase() && salvo.lista.every((p) => p.nome && p.pasta && p.desde), 'projetos.json com lista e ocultos', salvo);
  r = await post('/projetos/adicionar', { pasta: C });
  const salvo2 = JSON.parse(fs.readFileSync(path.join(DADOS, 'projetos.json'), 'utf8'));
  conferir(r.s === 201 && salvo2.ocultos.length === 0, 'adicionar à mão tira de ocultos', salvo2);
  await post('/projetos/remover', { nome: 'projC' });

  // ── lista ──
  console.log('lista');
  r = await get('/arquivos/lista', { projeto: 'projA', caminho: '' });
  const nomes = r.j.itens?.map((i) => i.nome) || [];
  conferir(r.s === 200 && r.j.caminho === '' && r.j.projeto === 'projA', 'lista raiz', r.j);
  conferir(nomes[0] === 'escape' || nomes[0] === 'node_modules' || nomes[0] === 'src', 'pastas primeiro', nomes);
  conferir(!nomes.includes('.git') && !nomes.includes('Thumbs.db'), 'esconde .git e Thumbs.db', nomes);
  conferir(nomes.indexOf('a2.txt') < nomes.indexOf('a10.txt') && nomes.indexOf('a10.txt') < nomes.indexOf('Zeta.md'), 'ordem natural sem maiúsculas', nomes);
  const app = (await get('/arquivos/lista', { projeto: 'projA', caminho: 'src' })).j.itens.find((i) => i.nome === 'app.js');
  conferir(app && app.tipo === 'arquivo' && app.tamanho > 0 && app.mtime > 0, 'item com tipo/tamanho/mtime', app);
  r = await get('/arquivos/lista', { projeto: 'PROJA', caminho: 'SRC' });
  conferir(r.s === 200 && r.j.projeto === 'projA' && r.j.itens.some((i) => i.nome === 'app.js'), 'sem diferenciar maiúsculas', r.j);
  r = await get('/arquivos/lista', { projeto: 'nada', caminho: '' });
  conferir(r.s === 404, 'projeto desconhecido → 404', r.j);
  fs.mkdirSync(path.join(B, 'muitos'));
  for (let i = 0; i < 5005; i++) fs.writeFileSync(path.join(B, 'muitos', `f${i}.txt`), '');
  r = await get('/arquivos/lista', { projeto: 'projB', caminho: 'muitos' });
  conferir(r.j.itens.length === 5000 && r.j.truncado === true, 'até 5000 itens, truncado além', { n: r.j.itens?.length, t: r.j.truncado });

  // ── confinamento ──
  console.log('confinamento');
  for (const c of ['../projB/leia.md', '..', 'src/../../projB', 'C:\\Windows\\win.ini', '/Windows', '\\\\servidor\\x', 'C:/Windows']) {
    r = await get('/arquivos/ler', { projeto: 'projA', caminho: c });
    conferir(r.s === 403, `ler ${c} → 403`, r);
  }
  conferir(temJuncao, WIN ? 'junção criada com mklink /J' : 'link simbólico para fora criado', jr.stdout + jr.stderr);
  if (temJuncao) {
    r = await get('/arquivos/lista', { projeto: 'projA', caminho: 'escape' });
    conferir(r.s === 403, 'lista na junção que escapa → 403', r.j);
    r = await get('/arquivos/ler', { projeto: 'projA', caminho: 'escape/segredo.txt' });
    conferir(r.s === 403, 'ler pela junção → 403', r.j);
    r = await post('/arquivos/excluir', { projeto: 'projA', caminhos: ['escape'] });
    conferir(r.s === 403 && fs.existsSync(path.join(FORA, 'segredo.txt')), 'excluir junção que escapa → 403', r);
    r = await post('/arquivos/novo', { projeto: 'projA', pasta: 'escape', nome: 'x.txt', tipo: 'arquivo' });
    conferir(r.s === 403 && !fs.existsSync(path.join(FORA, 'x.txt')), 'novo dentro da junção → 403', r);
    r = await post('/arquivos/buscar', { projeto: 'projA', caminho: '', texto: 'não pode' });
    conferir(r.s === 200 && r.j.ocorrencias === 0, 'busca não segue a junção', r.j);
  }
  r = await post('/arquivos/renomear', { projeto: 'projA', caminho: '', nome: 'outro' });
  conferir(r.s === 400, 'renomear a raiz → 400', r);
  r = await post('/arquivos/excluir', { projeto: 'projA', caminhos: [''] });
  conferir(r.s === 400 && fs.existsSync(A), 'excluir a raiz → 400', r);
  r = await post('/arquivos/colar', { projeto: 'projB', destino: '', modo: 'mover', itens: [{ projeto: 'projA', caminho: '' }] });
  conferir(r.s === 400, 'mover a raiz → 400', r);

  // ── ler / bruto ──
  console.log('ler e bruto');
  r = await get('/arquivos/ler', { projeto: 'projA', caminho: 'src/util.mjs' });
  conferir(r.s === 200 && r.j.tipo === 'texto' && r.j.conteudo.startsWith('export') && r.j.linguagem === 'javascript', 'texto sem BOM, linguagem', r.j);
  r = await get('/arquivos/ler', { projeto: 'projA', caminho: 'bin.dat' });
  conferir(r.j.tipo === 'binario' && r.j.conteudo === undefined, 'binário', r.j);
  r = await get('/arquivos/ler', { projeto: 'projA', caminho: 'grande.txt' });
  conferir(r.j.tipo === 'grande' && r.j.conteudo === undefined, 'grande > 2 MB', { tipo: r.j.tipo });
  r = await get('/arquivos/ler', { projeto: 'projA', caminho: 'img.png' });
  conferir(r.j.tipo === 'imagem', 'imagem por extensão', r.j);
  r = await get('/arquivos/ler', { projeto: 'projA', caminho: 'nao.txt' });
  conferir(r.s === 404, 'ler inexistente → 404', r.j);
  r = await get('/arquivos/bruto', { projeto: 'projA', caminho: 'img.png' });
  conferir(r.s === 200 && r.h.get('content-type') === 'image/png' && r.j.length === 16, 'bruto png', r.h.get('content-type'));
  r = await get('/arquivos/bruto', { projeto: 'projA', caminho: 'desenho.svg' });
  conferir(r.s === 200 && r.h.get('content-type') === 'image/svg+xml' && r.h.get('content-security-policy') === 'sandbox', 'bruto svg com CSP sandbox');
  r = await get('/arquivos/bruto', { projeto: 'projA', caminho: 'a2.txt' });
  conferir(r.s === 415, 'bruto de texto → 415', r.s);

  // ── novo / renomear ──
  console.log('novo e renomear');
  r = await post('/arquivos/novo', { projeto: 'projA', pasta: 'src', nome: 'novo.txt', tipo: 'arquivo' });
  conferir(r.s === 201 && r.j.caminho === 'src/novo.txt' && fs.existsSync(path.join(A, 'src', 'novo.txt')), 'novo arquivo → 201', r);
  r = await post('/arquivos/novo', { projeto: 'projA', pasta: '', nome: 'pasta nova', tipo: 'pasta' });
  conferir(r.s === 201 && fs.statSync(path.join(A, 'pasta nova')).isDirectory(), 'nova pasta → 201', r);
  r = await post('/arquivos/novo', { projeto: 'projA', pasta: 'src', nome: 'NOVO.txt', tipo: 'arquivo' });
  conferir(r.s === 409 && r.j.motivo === 'existe', 'já existe → 409 existe', r);
  for (const n of ['a<b', 'a:b', 'a|b', 'a?b', 'a*b', 'a"b', 'a/b', 'a\\b', 'CON', 'nul.txt', 'com1', 'LPT9.log', 'termina.', 'termina ', '', '..']) {
    r = await post('/arquivos/novo', { projeto: 'projA', pasta: '', nome: n, tipo: 'arquivo' });
    conferir(r.s === 400 && r.j.motivo === 'nome', `nome inválido ${JSON.stringify(n)} → 400 nome`, r);
  }
  r = await post('/arquivos/renomear', { projeto: 'projA', caminho: 'src/novo.txt', nome: 'b.txt' });
  conferir(r.s === 200 && r.j.caminho === 'src/b.txt' && fs.existsSync(path.join(A, 'src', 'b.txt')), 'renomear', r);
  r = await post('/arquivos/renomear', { projeto: 'projA', caminho: 'src/b.txt', nome: 'B.txt' });
  conferir(r.s === 200 && r.j.caminho === 'src/B.txt' && fs.readdirSync(path.join(A, 'src')).includes('B.txt'), 'renomear só maiúsculas', r);
  r = await post('/arquivos/renomear', { projeto: 'projA', caminho: 'src/B.txt', nome: 'app.js' });
  conferir(r.s === 409 && r.j.motivo === 'existe', 'renomear para nome existente → 409', r);
  r = await post('/arquivos/renomear', { projeto: 'projA', caminho: 'src/B.txt', nome: 'x>y' });
  conferir(r.s === 400 && r.j.motivo === 'nome', 'renomear com nome inválido → 400', r);

  // ── colar ──
  console.log('colar');
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src', modo: 'copiar', itens: [{ projeto: 'projA', caminho: 'src/app.js' }] });
  conferir(r.s === 200 && r.j.caminhos[0] === 'src/app copy.js', 'copiar no mesmo lugar → "app copy.js"', r);
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src', modo: 'copiar', itens: [{ projeto: 'projA', caminho: 'src/app.js' }] });
  conferir(r.s === 200 && r.j.caminhos[0] === 'src/app copy 2.js', 'de novo → "app copy 2.js"', r);
  r = await post('/arquivos/colar', { projeto: 'projA', destino: '', modo: 'copiar', itens: [{ projeto: 'projA', caminho: 'src' }] });
  conferir(r.s === 200 && r.j.caminhos[0] === 'src copy' && fs.existsSync(path.join(A, 'src copy', 'app.js')), 'copiar pasta → "src copy"', r);
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src', modo: 'mover', itens: [{ projeto: 'projA', caminho: 'src/app copy 2.js' }] });
  conferir(r.s === 200 && r.j.caminhos[0] === 'src/app copy 2.js' && fs.existsSync(path.join(A, 'src', 'app copy 2.js')), 'mover para a mesma pasta: nada muda', r);
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src copy', modo: 'mover', itens: [{ projeto: 'projA', caminho: 'src/app.js' }] });
  conferir(r.s === 409 && r.j.motivo === 'existe' && fs.existsSync(path.join(A, 'src', 'app.js')), 'mover com nome no destino → 409', r);
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src/sub', modo: 'mover', itens: [{ projeto: 'projA', caminho: 'src' }] });
  conferir(r.s === 404 || r.s === 400, 'mover para pasta inexistente recusa', r);
  fs.mkdirSync(path.join(A, 'src', 'sub'));
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src/sub', modo: 'mover', itens: [{ projeto: 'projA', caminho: 'src' }] });
  conferir(r.s === 400 && fs.existsSync(path.join(A, 'src', 'app.js')), 'pasta para dentro dela mesma → 400', r);
  r = await post('/arquivos/colar', { projeto: 'projA', destino: 'src', modo: 'copiar', itens: [{ projeto: 'projA', caminho: 'src' }] });
  conferir(r.s === 400, 'copiar pasta para dentro dela mesma → 400', r);
  r = await post('/arquivos/colar', { projeto: 'projB', destino: '', modo: 'copiar', itens: [{ projeto: 'projA', caminho: 'Zeta.md' }] });
  conferir(r.s === 200 && r.j.caminhos[0] === 'Zeta.md' && fs.existsSync(path.join(B, 'Zeta.md')) && fs.existsSync(path.join(A, 'Zeta.md')), 'copiar entre projetos', r);
  r = await post('/arquivos/colar', { projeto: 'projB', destino: '', modo: 'mover', itens: [{ projeto: 'projA', caminho: 'a2.txt' }] });
  conferir(r.s === 200 && fs.existsSync(path.join(B, 'a2.txt')) && !fs.existsSync(path.join(A, 'a2.txt')), 'mover entre projetos', r);
  r = await post('/arquivos/colar', { projeto: 'projB', destino: '', modo: 'mover', itens: [{ projeto: 'projA', caminho: '../fora/segredo.txt' }] });
  conferir(r.s === 403 && fs.existsSync(path.join(FORA, 'segredo.txt')), 'colar de fora → 403', r);

  // ── excluir (lixeira falsa) ──
  console.log('excluir');
  const antesA = fs.readdirSync(A).length;
  r = await post('/arquivos/excluir', { projeto: 'projA', caminhos: ['src copy', 'src copy/app.js', 'a10.txt'] });
  const naLixeira = fs.existsSync(LIXO) ? fs.readdirSync(LIXO) : [];
  conferir(r.s === 200 && r.j.enviados === 2 && !fs.existsSync(path.join(A, 'src copy')) && !fs.existsSync(path.join(A, 'a10.txt')), 'excluir manda e tira da origem', r);
  conferir(naLixeira.length === 2 && naLixeira.some((n) => n.endsWith('-a10.txt')) && naLixeira.some((n) => n.endsWith('-src copy')), 'itens estão na lixeira falsa', naLixeira);
  const pastaLixo = naLixeira.find((n) => n.endsWith('-src copy'));
  conferir(pastaLixo && fs.existsSync(path.join(LIXO, pastaLixo, 'app.js')) && fs.readFileSync(path.join(LIXO, pastaLixo, 'app.js'), 'utf8').includes('Olá'), 'nada apagado: conteúdo inteiro na lixeira');
  conferir(fs.readdirSync(A).length === antesA - 2, 'o resto do projeto intacto');
  r = await post('/arquivos/excluir', { projeto: 'projA', caminhos: ['nao-existe.txt'] });
  conferir(r.s === 404, 'excluir inexistente → 404', r);

  // ── buscar ──
  console.log('buscar');
  r = await post('/arquivos/buscar', { projeto: 'projA', caminho: '', texto: 'mundo' });
  const caminhosB = r.j.resultados?.map((x) => x.caminho) || [];
  conferir(r.s === 200 && caminhosB.includes('src/app.js') && caminhosB.includes('src/util.mjs') && caminhosB.includes('Zeta.md'), 'busca simples sem maiúsculas', r.j);
  conferir(!caminhosB.some((c) => c.startsWith('.git') || c.startsWith('node_modules') || c === 'bin.dat' || c === 'grande.txt'), 'pula .git, node_modules, binário e > 1 MB', caminhosB);
  const lin = r.j.resultados.find((x) => x.caminho === 'src/app.js')?.linhas[0];
  conferir(lin && lin.n === 2 && lin.texto.slice(lin.ini, lin.fim) === 'Mundo', 'linha com n, ini e fim', lin);
  r = await post('/arquivos/buscar', { projeto: 'projA', caminho: '', texto: 'Mundo', maiusculas: true });
  conferir(r.j.ocorrencias === 3 && r.j.resultados.every((x) => x.caminho.startsWith('src/app')), 'maiúsculas (app.js e as 2 cópias)', r.j);
  r = await post('/arquivos/buscar', { projeto: 'projA', caminho: 'src', texto: 'mund', palavra: true });
  conferir(r.j.ocorrencias === 0, 'palavra inteira', r.j);
  r = await post('/arquivos/buscar', { projeto: 'projA', caminho: 'src', texto: 'ol[aá]\\(', regex: true });
  conferir(r.j.ocorrencias === 3 && r.j.resultados.some((x) => x.caminho === 'src/app.js') && r.j.resultados[0].linhas[0].ini === 9, 'regex', r.j);
  r = await post('/arquivos/buscar', { projeto: 'projA', caminho: '', texto: '([', regex: true });
  conferir(r.s === 400, 'regex inválida → 400', r);
  r = await post('/arquivos/buscar', { projeto: 'projA', caminho: '', texto: 'ACHADO' });
  const l2 = r.j.resultados?.[0]?.linhas?.[0];
  conferir(l2 && l2.texto.length <= 300 && l2.texto.slice(l2.ini, l2.fim) === 'ACHADO', 'linha cortada em 300 em volta do achado', l2 && { len: l2.texto.length, ini: l2.ini });
  // Regex catastrófica: a busca roda num Worker encerrado em 5 s; o servidor segue atendendo.
  escrever(path.join(B, 'cat', 'catastrofe.txt'), 'linha boa aaa\n' + 'a'.repeat(50) + 'b\n');
  const t0 = Date.now();
  const pBusca = post('/arquivos/buscar', { projeto: 'projB', caminho: 'cat', texto: '(a+)+$', regex: true });
  await esperar(500);
  const t1 = Date.now();
  const durante = await get('/projetos');
  const tOutra = Date.now() - t1;
  conferir(durante.s === 200 && tOutra < 1000, 'servidor responde outra rota durante a busca catastrófica', { tOutra });
  r = await pBusca;
  const tBusca = Date.now() - t0;
  conferir(r.s === 200 && r.j.truncado === true && tBusca >= 4500 && tBusca < 7000, 'regex catastrófica volta em ~5 s com truncado', { tBusca, j: r.j });
  r = await post('/arquivos/buscar', { projeto: 'projB', caminho: '', texto: 'f' });
  conferir(r.s === 200 && typeof r.j.truncado === 'boolean', 'busca com muitos arquivos responde', { o: r.j.ocorrencias, t: r.j.truncado });

  // ── revelar / pastas ──
  console.log('revelar e seletor');
  r = await post('/arquivos/revelar', { projeto: 'projA', caminho: 'Zeta.md' });
  conferir(r.s === 200 && r.j.ok === true, 'revelar em teste só responde ok', r);
  r = await post('/arquivos/revelar', { projeto: 'projA', caminho: '../x' });
  conferir(r.s === 403, 'revelar fora → 403', r);
  r = await post('/arquivos/abrir-pasta', { projeto: 'projA', caminho: '' });
  conferir(r.s === 200 && r.j.ok === true, 'abrir na pasta (raiz) em teste só responde ok', r);
  r = await post('/arquivos/abrir-pasta', { projeto: 'projA', caminho: 'Zeta.md' });
  conferir(r.s === 400 && r.j.motivo === 'nao-pasta', 'abrir na pasta com arquivo → 400 nao-pasta', r);
  r = await post('/arquivos/abrir-pasta', { projeto: 'projA', caminho: '../x' });
  conferir(r.s === 403, 'abrir na pasta fora → 403', r);
  r = await get('/arquivos/pastas');
  // No Mac as unidades são os volumes de /Volumes (o do sistema, "Macintosh HD", aponta para /).
  conferir(r.s === 200 && r.j.unidades.some((u) => (WIN ? u.caminho === 'C:\\' : u.caminho.startsWith('/Volumes/') && fs.realpathSync(u.caminho) === '/'))
    && (WIN || !r.j.unidades.some((u) => u.nome === 'Recovery')) && r.j.atalhos.length >= 1, 'pastas: unidades e atalhos', r.j);
  fs.mkdirSync(path.join(SAIDA, 'escondida'));
  // Oculta: atributo +h no Windows; marca "oculto" do Finder (chflags hidden) no Mac.
  if (WIN) spawnSync('attrib.exe', ['+h', path.join(SAIDA, 'escondida')]);
  else spawnSync('/usr/bin/chflags', ['hidden', path.join(SAIDA, 'escondida')]);
  r = await get('/arquivos/pastas', { caminho: SAIDA });
  const ps = r.j.pastas?.map((p) => p.nome) || [];
  conferir(r.s === 200 && ps.includes('projA') && ps.includes('projB') && !ps.includes('escondida') && r.j.pai === path.dirname(SAIDA), 'pastas: só pastas visíveis, com pai', r.j);
  conferir(!ps.includes('a2.txt') && r.j.pastas.every((p) => p.caminho === path.join(SAIDA, p.nome)), 'pastas: sem arquivos, caminho absoluto');
  r = await get('/arquivos/pastas', { caminho: 'relativo' });
  conferir(r.s === 400, 'pastas com caminho relativo → 400', r.j);

  // ── vigia ──
  console.log('vigia');
  await get('/arquivos/lista', { projeto: 'projA', caminho: '' });
  await esperar(300);
  eventos.length = 0;
  const vigiado = async (fn, pred, nome) => {
    eventos.length = 0;
    fn();
    const ate = Date.now() + 3000;
    while (Date.now() < ate && !eventos.some((e) => e.tipo === 'arquivos' && pred(e.dados))) await esperar(50);
    const ev = eventos.find((e) => e.tipo === 'arquivos' && pred(e.dados));
    conferir(!!ev, nome, eventos.map((e) => e.dados));
    return ev;
  };
  await vigiado(() => fs.writeFileSync(path.join(A, 'src', 'vig.txt'), '1'),
    (d) => d.projeto === 'projA' && d.arquivos.includes('src/vig.txt') && d.pastas.includes('src'), 'vigia: criar gera arquivos');
  await esperar(400);
  await vigiado(() => fs.appendFileSync(path.join(A, 'src', 'vig.txt'), '2'), (d) => d.arquivos.includes('src/vig.txt'), 'vigia: alterar gera arquivos');
  await esperar(400);
  await vigiado(() => fs.rmSync(path.join(A, 'src', 'vig.txt')), (d) => d.arquivos.includes('src/vig.txt'), 'vigia: apagar gera arquivos');
  await esperar(400);
  eventos.length = 0;
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(A, `rajada${i}.txt`), 'x');
  await esperar(900);
  const rajada = eventos.filter((e) => e.tipo === 'arquivos');
  conferir(rajada.length >= 1 && rajada.length <= 3 && rajada.flatMap((e) => e.dados.arquivos).filter((a) => a.startsWith('rajada')).length >= 10, 'vigia agrupa (~300 ms)', rajada.length);
  eventos.length = 0;
  fs.writeFileSync(path.join(A, '.git', 'HEAD'), 'ref: x');
  await esperar(700);
  conferir(!eventos.some((e) => e.tipo === 'arquivos' && e.dados.arquivos.some((a) => a.toLowerCase().startsWith('.git'))), 'vigia ignora .git', eventos);
  await post('/projetos/remover', { nome: 'projA' });
  eventos.length = 0;
  fs.writeFileSync(path.join(A, 'depois.txt'), 'x');
  await esperar(700);
  conferir(!eventos.some((e) => e.tipo === 'arquivos'), 'vigia desliga quando o projeto sai da lista', eventos);
  conferir(!fs.readdirSync(A).some((n) => /orbit|\.tmp$/i.test(n)), 'nenhum arquivo auxiliar no projeto', fs.readdirSync(A));

  // ── Mac simulado (16/10): so 'darwin', osascript/mostrar falsos, home e /Volumes dentro da saída ──
  // Nada roda o osascript nem o Finder de verdade; a "Lixeira" é <saida>/mac/home/.Trash.
  console.log('Mac simulado');
  await macSimulado();
} catch (e) {
  falhas++;
  console.log('  FALHA exceção', e?.stack || e);
} finally {
  mod.parar();
  await new Promise((r) => servidor.close(r));
  try { spawnSync('cmd.exe', ['/d', '/c', 'rmdir', path.join(A, 'escape')]); } catch {}
  try { await fsp.rm(SAIDA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log('não deu para apagar a saída:', e.message); }
}

console.log(`\n${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
