// Teste dos repositórios do GitHub (repos.mjs, rodada 7). Servidor de teste e GitHub falso em portas livres
// de 47822–47826 (porta-livre.mjs); remotos *bare* file:// numa pasta temporária (ORBIT_GIT_BASE).
// Nunca toca a 47821, o GitHub de verdade, o token do usuário (ORBIT_PERFIL_DIR na saída) nem pastas fora da
// saída (o git das fixtures só roda dentro dela; a saída não pode ficar em D:\Dev\Projetos).
//   node testes/repos.test.mjs <pasta-de-saida>    (~1 min)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { subirGithubFalso, definirRaizTeste, gitTeste, escrever } from './github-falso.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-repos-teste'));
const k = (p) => path.resolve(p).toLowerCase();
const dentro = (p, raiz) => k(p) === k(raiz) || k(p).startsWith(k(raiz) + path.sep);
if (dentro(SAIDA, path.dirname(PROJ))) {
  console.error('A saída não pode ficar dentro de', path.dirname(PROJ), '(outras sessões trabalham lá).');
  process.exit(2);
}
fs.mkdirSync(SAIDA, { recursive: true });
definirRaizTeste(SAIDA);
const D = (n) => path.join(SAIDA, n);
const DADOS = D('dados'), PERFIL = D('perfil'), SESS = D('sessoes'), REMOTOS = D('remotos'), SEMENTES = D('sementes'), TRAB = D('trab'), CLONES = D('clones');
const GITLOG = D('git-argv.log'), GLOBAL = D('gitconfig-global');
for (const d of [DADOS, PERFIL, SESS, REMOTOS, SEMENTES, TRAB, CLONES]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
for (const d of [DADOS, PERFIL, SESS, REMOTOS, SEMENTES, TRAB, CLONES]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(GITLOG, '');
fs.writeFileSync(GLOBAL, '[core]\n\tautocrlf = false\n'); // sem user.email global: o commit usa a identidade do GitHub; autocrlf=false contra o gitconfig do sistema
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}'); // config padrão de teste (o servidor completa com CONFIG_PADRAO); nada da raiz do app
// Mac: o servidor de teste guarda o token num Chaveiro falso (ORBIT_SECURITY = um `security` falso na saída,
// que guarda os itens num JSON), nunca no Chaveiro do usuário; sem ele o perfil.mjs recusa guardar o token.
// O mesmo falso do perfil.test.mjs. No Windows o token vai para o arquivo cifrado de sempre.
const MAC = process.platform === 'darwin';
const SECURITY_FALSO = D('security-falso.mjs'), CHAVEIRO = D('chaveiro-falso.json');
if (MAC) {
  for (const f of [CHAVEIRO, CHAVEIRO + '.log']) fs.rmSync(f, { force: true });
  fs.writeFileSync(SECURITY_FALSO, `import fs from 'node:fs';
const ARQ = process.env.FALSO_CHAVEIRO;
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return {}; } };
// A linha do -i como o security lê: separa por espaço; entre aspas duplas, \\" e \\\\.
const separar = (linha) => {
  const out = []; let i = 0;
  while (i < linha.length) {
    while (linha[i] === ' ') i++;
    if (i >= linha.length) break;
    let a = '';
    if (linha[i] === '"') { i++; while (i < linha.length && linha[i] !== '"') { if (linha[i] === '\\\\') i++; a += linha[i++]; } i++; }
    else while (i < linha.length && linha[i] !== ' ') a += linha[i++];
    out.push(a);
  }
  return out;
};
const args = process.argv.slice(2);
const entrada = args[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(ARQ + '.log', JSON.stringify({ args, entrada }) + '\\n');
let codigo = 0;
for (const a of args[0] === '-i' ? entrada.split('\\n').filter(Boolean).map(separar) : [args]) {
  const opc = (f) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
  const chave = opc('-a') + '|' + opc('-s');
  const itens = ler();
  if (a[0] === 'add-generic-password') {
    if (itens[chave] !== undefined && !a.includes('-U')) { process.stderr.write('security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\\n'); codigo = 45; continue; }
    itens[chave] = opc('-w'); fs.writeFileSync(ARQ, JSON.stringify(itens));
  } else if (a[0] === 'find-generic-password') {
    if (itens[chave] === undefined) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); codigo = 44; continue; }
    process.stdout.write(a.includes('-w') ? itens[chave] + '\\n' : 'keychain: "falso"\\nclass: "genp"\\n');
  } else if (a[0] === 'delete-generic-password') {
    if (itens[chave] === undefined) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); codigo = 44; continue; }
    delete itens[chave]; fs.writeFileSync(ARQ, JSON.stringify(itens)); process.stderr.write('password has been deleted.\\n');
  } else { codigo = 2; }
}
process.exit(codigo);
`);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
// Pastas reais onde o servidor pode ler git (nunca escrever): a do Orbit e, no Mac, as vizinhas do mesmo GitHub.
let DO_ORBIT = [PROJ];
const doOrbit = (x) => DO_ORBIT.some((r) => dentro(x, r));
const TOKEN = 'github_pat_' + 'T3st3R7o' + 'k'.repeat(14) + '_' + 'Z9'.repeat(30);
const TOKEN_B64 = Buffer.from('x-access-token:' + TOKEN).toString('base64');
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 600))); };
const respostas = [];
let sseBruto = '';
const eventos = [];

let srv = null, gh = null, PORTA = 0, BASE = '';
const sse = new AbortController();

async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' });
  const t = await r.text();
  respostas.push(t);
  let corpo = null; try { corpo = JSON.parse(t); } catch {}
  return { status: r.status, corpo };
}
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  const t = await r.text();
  respostas.push(t);
  let corpo = null; try { corpo = JSON.parse(t); } catch {}
  return { status: r.status, corpo };
}
const q = (p) => encodeURIComponent(p);
const g = (cwd, ...a) => gitTeste(cwd, a).trim();
const gTalvez = (cwd, ...a) => { try { return g(cwd, ...a); } catch { return '(erro)'; } };

function hashes(dir) {
  const out = {};
  const andar = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) andar(p, r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  andar(dir, '');
  return JSON.stringify(out, Object.keys(out).sort());
}
// Retrato da pasta: git (status, refs, origin, HEAD, MERGE_HEAD) e o conteúdo de todos os arquivos.
function foto(dir, { refs = true } = {}) {
  const temGit = fs.existsSync(path.join(dir, '.git'));
  return JSON.stringify({
    temGit,
    status: temGit ? gTalvez(dir, '--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=all') : '',
    branch: temGit ? gTalvez(dir, 'symbolic-ref', '-q', 'HEAD') : '',
    head: temGit ? gTalvez(dir, 'rev-parse', 'HEAD') : '',
    refs: temGit && refs ? gTalvez(dir, 'for-each-ref', '--format=%(refname) %(objectname)') : '',
    origin: temGit ? gTalvez(dir, 'config', '--get', 'remote.origin.url') : '',
    merge: fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
    arquivos: hashes(dir),
  });
}
const clonar = (url, nome) => { const dir = path.join(TRAB, nome); gitTeste(TRAB, ['clone', '-q', url, dir]); return dir; };
const projetoDe = (lista, dir) => lista.find((p) => k(p.pasta) === k(dir));
async function adicionar(dir) { const r = await post('/repos/adicionar', { pasta: dir }); if (r.status !== 200) conferir(false, 'adicionar ' + path.basename(dir), r); return r; }

async function subirServidor() {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore', windowsHide: true,
    env: {
      ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL,
      ORBIT_GITHUB_API: gh.url, ORBIT_GIT_BASE: gh.base, ORBIT_GIT_LOG: GITLOG, ORBIT_REPOS_PRAZO_MS: '8000', GIT_CONFIG_GLOBAL: GLOBAL,
      ...(MAC ? { ORBIT_SECURITY: SECURITY_FALSO, FALSO_CHAVEIRO: CHAVEIRO } : {}),
    },
  });
  for (let i = 0; i < 60; i++) {
    try { const s = await (await fetch(BASE + '/saude')).json(); if (s.pid === srv.pid) return; } catch {}
    await dormir(150);
  }
  throw new Error('servidor de teste não subiu (ou outro processo respondeu na porta)');
}
function ouvirSSE() {
  (async () => {
    const r = await fetch(BASE + '/fluxo', { signal: sse.signal });
    const leitor = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      const t = dec.decode(value, { stream: true });
      sseBruto += t; buf += t;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const bloco = buf.slice(0, i); buf = buf.slice(i + 2);
        const tipo = /^event: (.+)$/m.exec(bloco)?.[1]; const dados = /^data: (.+)$/m.exec(bloco)?.[1];
        if (tipo === 'repos') { try { eventos.push(JSON.parse(dados)); } catch {} }
      }
    }
  })().catch(() => {});
}

try {
  // ── ambiente ──
  const portaGh = await escolherPorta(47825);
  gh = await subirGithubFalso({ porta: portaGh, remotos: REMOTOS, sementes: SEMENTES, token: TOKEN });
  PORTA = await escolherPorta(47822);
  BASE = `http://127.0.0.1:${PORTA}`;
  await subirServidor();
  ouvirSSE();
  let r = await post('/perfil/github', { token: TOKEN });
  conferir(r.status === 200 && r.corpo?.github?.login === 'orbit-teste', 'perfil: token falso conectado', r);

  // ── remotos ──
  const rStatus = gh.semear('status', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'pasta/c.txt': 'c\n' });
  const rPush = gh.semear('push', { 'p.txt': 'p\n' });
  const rPull = gh.semear('pull', { 'l.txt': 'l\n' });
  const rConf = gh.semear('conflito', { 'x.txt': 'linha original\n' });
  const rMescla = gh.semear('mescla', { 'm1.txt': '1\n', 'm2.txt': '2\n' });
  const rSobre = gh.semear('sobre', { 's.txt': 's\n' });
  const rBr = gh.semear('branches', { 'a.txt': 'a\n' }, { branches: { outro: { 'o.txt': 'o\n' }, conflito: { 'a.txt': 'a do branch conflito\n' }, remota: { 'r.txt': 'r\n' } } });
  const rVinc = gh.semear('vinc', { 'a.txt': 'A\n', 'b.txt': 'B\n', 'sub/c.txt': 'C\n' });
  const rCommit = gh.semear('commit', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const rConc = gh.semear('conc', { 'k.txt': 'k\n' });
  const rOper = gh.semear('oper', { 'o.txt': 'base\n' });
  // No Mac o clone de ~1 MB acaba antes do primeiro aviso de progresso (de 250 em 250 ms) e só chegam o início e o
  // fim; lá cada arquivo é maior (~20 MB no pack, ~1 s de clone). No Windows, o tamanho de sempre.
  const TAM_GRANDE = process.platform === 'win32' ? 1500 : 60000;
  const grande = {}; for (let i = 0; i < 300; i++) grande[`arq/${String(i).padStart(3, '0')}.txt`] = crypto.randomBytes(TAM_GRANDE).toString('hex');
  gh.semear('grande', grande);
  for (let i = 0; i < 120; i++) gh.adicionar({ nome: `enchimento-${String(i).padStart(3, '0')}`, pushedAt: Date.now() - 86400e3 * (10 + i), privado: i % 2 === 0 });

  // ── lista e status ──
  const stLimpo = clonar(rStatus.url, 'st-limpo');
  const stAlt = clonar(rStatus.url, 'st-alterado');
  const stAd = clonar(rStatus.url, 'st-adiante');
  const stAt = clonar(rStatus.url, 'st-atras');
  const stDest = clonar(rStatus.url, 'st-destacado');
  const stVazio = path.join(TRAB, 'st-vazio'); fs.mkdirSync(stVazio); g(stVazio, 'init', '-q');
  escrever(stAlt, { 'a.txt': 'a mudado\n', 'novo.txt': 'n\n' });
  escrever(stAd, { 'a.txt': 'a local\n' }); g(stAd, 'commit', '-qam', 'local');
  g(stDest, 'checkout', '-q', '--detach', 'HEAD');
  gh.avancar('status', { 'b.txt': 'b do github\n' });
  for (const d of [stLimpo, stAlt, stAd, stAt, stDest, stVazio]) await adicionar(d);
  r = await get('/repos/projetos');
  conferir(r.status === 200 && Array.isArray(r.corpo?.projetos), 'GET /repos/projetos', r);
  conferir(r.corpo?.github?.conectado === true && r.corpo.github.login === 'orbit-teste' && r.corpo.github.expirado === false, 'projetos: github conectado', r.corpo?.github);
  conferir(k(r.corpo?.pastaClones || '') === k(path.dirname(PROJ)), 'pastaClones padrão = pasta-mãe do Orbit', r.corpo?.pastaClones);
  let L = r.corpo.projetos;
  let p = projetoDe(L, stLimpo);
  conferir(p?.git && p.repo?.completo === 'orbit-teste/status' && p.remoto?.github === true && p.status?.branch === 'main' && p.status.upstream === 'origin/main' &&
    p.status.adiante === 0 && p.status.atras === 0 && p.status.alteracoes === 0 && !p.status.semCommits && p.status.destacado === null && p.origem === 'manual', 'status limpo', p);
  conferir(p?.repo?.url === 'https://github.com/orbit-teste/status' && !p.remoto.url.includes('@'), 'repo.url do GitHub e remoto sem credenciais', p?.remoto);
  p = projetoDe(L, stAlt);
  conferir(p?.status?.alteracoes === 2 && p.status.arquivos.some((a) => a.caminho === 'a.txt' && a.tipo === 'modificado' && a.preparado === false) &&
    p.status.arquivos.some((a) => a.caminho === 'novo.txt' && a.tipo === 'nao-rastreado'), 'status alterado', p?.status);
  conferir(projetoDe(L, stAd)?.status?.adiante === 1, 'status ↑1', projetoDe(L, stAd)?.status);
  p = projetoDe(L, stDest);
  conferir(p?.status?.branch === null && /^[0-9a-f]{7}$/.test(p.status.destacado || ''), 'status destacado', p?.status);
  p = projetoDe(L, stVazio);
  conferir(p?.git && p.status?.semCommits === true && p.status.branch === 'main' && !p.repo, 'status sem commits', p);
  conferir(projetoDe(L, stAt)?.status?.atras === 0, 'status ↓ só depois de buscar (sem fetch em segundo plano)', projetoDe(L, stAt)?.status);
  r = await post('/repos/buscar', { pasta: stAt });
  conferir(r.status === 200 && r.corpo.buscou === true && r.corpo.projeto?.status?.atras === 1 && r.corpo.projeto.status.buscadoEm > 0, 'buscar → status ↓1', r);
  r = await post('/repos/buscar', { pasta: stAt });
  conferir(r.status === 200 && r.corpo.buscou === false, 'buscar de novo em < 3 min não busca', r.corpo);
  // cache de 2 s
  const lido1 = projetoDe(L, stAlt).status.lidoEm;
  escrever(stAlt, { 'outro-novo.txt': 'x\n' });
  r = await get('/repos/projetos');
  p = projetoDe(r.corpo.projetos, stAlt);
  conferir(p.status.lidoEm === lido1 && p.status.alteracoes === 2, 'cache de 2 s na lista', p.status);
  await dormir(2200);
  r = await get('/repos/projetos');
  p = projetoDe(r.corpo.projetos, stAlt);
  conferir(p.status.lidoEm > lido1 && p.status.alteracoes === 3, 'lista relê depois de 2 s', p.status);
  r = await get('/repos/projeto?pasta=' + q(stAlt));
  conferir(r.status === 200 && r.corpo.projeto?.status?.alteracoes === 3, 'GET /repos/projeto (fresco)', r);
  r = await get('/repos/projeto?pasta=' + q(path.join(TRAB, 'nao-listado')));
  conferir(r.status === 404, 'projeto fora da lista → 404', r);

  // ── pasta do Orbit ──
  await post('/evento', { session_id: 'repos-teste-orbit', hook_event_name: 'SessionStart', cwd: PROJ });
  const sessPasta = path.join(TRAB, 'da-sessao'); fs.mkdirSync(sessPasta);
  await post('/evento', { session_id: 'repos-teste-sessao', hook_event_name: 'SessionStart', cwd: sessPasta });
  await dormir(2100);
  r = await get('/repos/projetos');
  p = projetoDe(r.corpo.projetos, PROJ);
  // Desde 15/10 a pasta do Orbit pode ter git (decisão do usuário); só as de cima ficam bloqueadas.
  // O teste nunca escreve na pasta real do Orbit: só confere a lista e as recusas nas pastas de cima.
  const tinhaGit = fs.existsSync(path.join(PROJ, '.git'));
  conferir(p && p.bloqueado === null, 'lista: pasta do Orbit liberada', p);
  conferir(projetoDe(r.corpo.projetos, sessPasta)?.origem === 'sessao', 'lista: pasta de sessão (origem sessao)', projetoDe(r.corpo.projetos, sessPasta));
  r = await post('/repos/remover', { pasta: sessPasta });
  conferir(r.status === 400 && r.corpo?.codigo === 'sessao', 'remover pasta de sessão → 400', r);
  const ACIMA = path.dirname(PROJ);
  const tentativasAcima = [
    ['/repos/adicionar', { pasta: ACIMA }], ['/repos/adicionar', { pasta: path.dirname(ACIMA) }],
    ['/repos/commit', { pasta: ACIMA, mensagem: 'x' }], ['/repos/vincular', { pasta: ACIMA, repo: 'orbit-teste/vinc', confirmar: true }],
    ['/repos/criar', { pasta: ACIMA, nome: 'orbit', confirmar: true }],
  ];
  for (const [rota, corpo] of tentativasAcima) {
    r = await post(rota, corpo);
    conferir((r.status === 403 && r.corpo?.codigo === 'orbit') || (rota !== '/repos/adicionar' && r.status === 404), `acima do Orbit: ${rota} ${corpo.pasta} → recusado`, r);
  }
  conferir(!fs.existsSync(path.join(ACIMA, '.git')) && fs.existsSync(path.join(PROJ, '.git')) === tinhaGit, 'nenhum .git criado acima do Orbit nem no Orbit');
  // A pasta de cima (Mac: Tudo/Orbit com app/ e brain/) mostra os repositórios de dentro só se todos forem do mesmo
  // GitHub que o Orbit; no PC (a pasta de projetos, com outros repositórios) fica sem nenhum. Só leitura.
  await post('/evento', { session_id: 'repos-teste-acima', hook_event_name: 'SessionStart', cwd: ACIMA });
  await dormir(2100);
  const origem = (d) => { try { return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(fs.readFileSync(path.join(d, '.git', 'config'), 'utf8'))[1].replace(/\.git$/, '').toLowerCase(); } catch { return null; } };
  const irmaos = fs.readdirSync(ACIMA, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && fs.existsSync(path.join(ACIMA, d.name, '.git'))).map((d) => path.join(ACIMA, d.name));
  const soDoOrbit = !!origem(PROJ) && irmaos.every((d) => origem(d) === origem(PROJ));
  if (soDoOrbit) DO_ORBIT = [PROJ, ...irmaos];
  p = projetoDe((await get('/repos/projetos')).corpo.projetos, ACIMA);
  conferir(p?.bloqueado === 'orbit' && (soDoOrbit ? p.subrepos.some((x) => k(x) === k(PROJ)) : p.subrepos.length === 0), `acima do Orbit: ${soDoOrbit ? 'mostra os repositórios de dentro' : 'sem repositórios de dentro'}`, p);

  // ── push ──
  const pPush = clonar(rPush.url, 'push'); await adicionar(pPush);
  escrever(pPush, { 'p.txt': 'p 2\n' }); g(pPush, 'commit', '-qam', 'segundo commit');
  let antes = foto(pPush);
  r = await post('/repos/push', { pasta: pPush });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && r.corpo.botao && r.corpo.titulo && /origin\/main/.test(r.corpo.mensagem) &&
    r.corpo.itens?.length === 1 && /^[0-9a-f]{7} segundo commit$/.test(r.corpo.itens[0]), 'push: 409 confirmar com os commits', r);
  conferir(foto(pPush) === antes && g(rPush.bare, 'rev-parse', 'main') !== g(pPush, 'rev-parse', 'HEAD'), 'push: o 409 não muda nada');
  r = await post('/repos/push', { pasta: pPush, confirmar: true });
  conferir(r.status === 200 && r.corpo.ok && r.corpo.projeto?.status?.adiante === 0 && g(rPush.bare, 'rev-parse', 'main') === g(pPush, 'rev-parse', 'HEAD'), 'push confirmado sobe', r);
  r = await post('/repos/push', { pasta: pPush, confirmar: true });
  conferir(r.status === 400 && r.corpo?.codigo === 'nada', 'push sem commits → 400 nada', r);
  const remotoAntes = gh.avancar('push', { 'outro.txt': 'do github\n' });
  escrever(pPush, { 'p.txt': 'p 3\n' }); g(pPush, 'commit', '-qam', 'terceiro');
  g(pPush, 'fetch', '-q'); // o Orbit sabe que está atrás, mas o push é tentado mesmo assim
  g(pPush, 'reset', '-q', '--soft', 'HEAD'); // (não muda nada; só deixa claro que a fixture não mexe no remoto)
  r = await post('/repos/push', { pasta: pPush, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'rejeitado' && /Receba antes de enviar/.test(r.corpo.erro), 'push rejeitado → 409 rejeitado', r);
  conferir(g(rPush.bare, 'rev-parse', 'main') === remotoAntes, 'push rejeitado não mexe no remoto');
  r = await post('/repos/push', { pasta: stDest, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'destacado', 'push destacado → 409', r);

  // ── pull ──
  const pPull = clonar(rPull.url, 'pull'); await adicionar(pPull);
  const novo = gh.avancar('pull', { 'l.txt': 'l 2\n' });
  r = await post('/repos/pull', { pasta: pPull });
  conferir(r.status === 200 && r.corpo.recebidos === 1 && g(pPull, 'rev-parse', 'HEAD') === novo && fs.readFileSync(path.join(pPull, 'l.txt'), 'utf8').replace(/\r/g, '') === 'l 2\n', 'pull ff (limpo, sem confirmar)', r);
  gh.avancar('pull', { 'g.txt': 'github\n' });
  escrever(pPull, { 'local.txt': 'local\n' }); g(pPull, 'add', '-A'); g(pPull, 'commit', '-qm', 'local');
  antes = foto(pPull, { refs: false });
  r = await post('/repos/pull', { pasta: pPull });
  conferir(r.status === 409 && r.corpo?.codigo === 'divergiu' && r.corpo.adiante === 1 && r.corpo.atras === 1, 'pull divergiu → 409 com ↑↓', r);
  conferir(foto(pPull, { refs: false }) === antes, 'pull divergiu não muda nada');
  // mesclar sem conflito
  const pMescla = clonar(rMescla.url, 'mescla'); await adicionar(pMescla);
  gh.avancar('mescla', { 'm2.txt': '2 github\n' });
  escrever(pMescla, { 'm1.txt': '1 local\n' }); g(pMescla, 'commit', '-qam', 'local m1');
  antes = foto(pMescla);
  r = await post('/repos/pull', { pasta: pMescla, mesclar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && r.corpo.botao === 'Mesclar', 'mesclar: 409 confirmar', r);
  conferir(foto(pMescla) === antes, 'mesclar: o 409 não muda nada (nem busca)');
  r = await post('/repos/pull', { pasta: pMescla, mesclar: true, confirmar: true });
  conferir(r.status === 200 && g(pMescla, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3 && r.corpo.projeto.status.atras === 0, 'mesclar sem conflito → commit de merge', r);
  conferir(/orbit-teste/.test(g(pMescla, 'log', '-1', '--format=%an %ae')), 'merge com a identidade do GitHub', g(pMescla, 'log', '-1', '--format=%an %ae'));
  // mesclar com conflito
  const pConf = clonar(rConf.url, 'conflito'); await adicionar(pConf);
  gh.avancar('conflito', { 'x.txt': 'linha do github\n' });
  escrever(pConf, { 'x.txt': 'linha local\n' }); g(pConf, 'commit', '-qam', 'local x');
  r = await post('/repos/pull', { pasta: pConf, mesclar: true, confirmar: true });
  antes = foto(pConf, { refs: false });
  // (a 1ª chamada buscou e deu conflito; repete para comparar o antes/depois exato da tentativa)
  r = await post('/repos/pull', { pasta: pConf, mesclar: true, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'conflito' && r.corpo.arquivos?.includes('x.txt') && /Nada mudou/.test(r.corpo.erro), 'mesclar com conflito → abort, 409 conflito', r);
  conferir(foto(pConf, { refs: false }) === antes && !fs.existsSync(path.join(pConf, '.git', 'MERGE_HEAD')), 'conflito: nada muda (HEAD, status, arquivos, sem MERGE_HEAD)');
  escrever(pConf, { 'y.txt': 'y\n' });
  r = await post('/repos/pull', { pasta: pConf, mesclar: true, confirmar: true });
  conferir(r.status === 200 || r.corpo?.codigo === 'conflito', 'mesclar aceita arquivo não rastreado (árvore limpa = sem alterações rastreadas)', r);
  escrever(pConf, { 'x.txt': 'sujo\n' });
  r = await post('/repos/pull', { pasta: pConf, mesclar: true, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'sujo', 'mesclar com alteração → 409 sujo', r);
  // sobrescreveria
  const pSobre = clonar(rSobre.url, 'sobre'); await adicionar(pSobre);
  gh.avancar('sobre', { 's.txt': 's do github\n' });
  escrever(pSobre, { 's.txt': 's local não commitado\n' });
  antes = foto(pSobre);
  r = await post('/repos/pull', { pasta: pSobre });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && /1 alteração/.test(r.corpo.mensagem), 'pull com alteração local → 409 confirmar', r);
  conferir(foto(pSobre) === antes, 'pull: o 409 não muda nada');
  antes = foto(pSobre, { refs: false });
  r = await post('/repos/pull', { pasta: pSobre, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'sobrescreveria' && r.corpo.arquivos?.includes('s.txt'), 'pull → 409 sobrescreveria', r);
  conferir(foto(pSobre, { refs: false }) === antes, 'sobrescreveria: nada muda');
  r = await post('/repos/pull', { pasta: stDest, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'destacado', 'pull destacado → 409', r);
  const semUp = clonar(rPull.url, 'sem-upstream'); g(semUp, 'switch', '-q', '-c', 'solto'); await adicionar(semUp);
  r = await post('/repos/pull', { pasta: semUp });
  conferir(r.status === 409 && r.corpo?.codigo === 'sem-upstream', 'pull sem upstream → 409', r);

  // ── branch ──
  const pBr = clonar(rBr.url, 'branches'); await adicionar(pBr);
  r = await get('/repos/branches?pasta=' + q(pBr));
  conferir(r.status === 200 && r.corpo.atual === 'main' && r.corpo.locais.some((b) => b.nome === 'main' && b.upstream === 'origin/main') &&
    ['outro', 'conflito', 'remota'].every((n) => r.corpo.remotos.some((b) => b.nome === n)) && !r.corpo.remotos.some((b) => b.nome === 'main' || b.nome === 'HEAD'), 'GET branches', r);
  escrever(pBr, { 'a.txt': 'a mudado localmente\n' });
  antes = foto(pBr);
  r = await post('/repos/branch', { pasta: pBr, nome: 'outro' });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && /vai junto para outro/.test(r.corpo.mensagem), 'branch com alteração → 409 confirmar', r);
  conferir(foto(pBr) === antes, 'branch: o 409 não muda nada');
  r = await post('/repos/branch', { pasta: pBr, nome: 'outro', confirmar: true });
  conferir(r.status === 200 && r.corpo.projeto.status.branch === 'outro' && r.corpo.projeto.status.upstream === 'origin/outro' &&
    fs.readFileSync(path.join(pBr, 'a.txt'), 'utf8') === 'a mudado localmente\n' && fs.existsSync(path.join(pBr, 'o.txt')), 'troca com alteração: a alteração vai junto', r.corpo?.projeto?.status || r);
  antes = foto(pBr);
  r = await post('/repos/branch', { pasta: pBr, nome: 'conflito', confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'sobrescreveria' && r.corpo.arquivos?.includes('a.txt'), 'troca com conflito → 409 sobrescreveria', r);
  conferir(foto(pBr) === antes, 'troca recusada: nada muda');
  r = await post('/repos/branch', { pasta: pBr, nome: 'a..b', criar: true, confirmar: true });
  conferir(r.status === 400 && r.corpo?.codigo === 'nome', 'nome de branch inválido → 400', r);
  r = await post('/repos/branch', { pasta: pBr, nome: 'nao-existe', confirmar: true });
  conferir(r.status === 404 && r.corpo?.codigo === 'sem-branch', 'branch inexistente sem criar → 404', r);
  r = await post('/repos/branch', { pasta: pBr, nome: 'nova', criar: true, confirmar: true });
  conferir(r.status === 200 && r.corpo.projeto.status.branch === 'nova' && r.corpo.projeto.status.alteracoes === 1, 'criar branch', r.corpo?.projeto?.status || r);
  r = await post('/repos/push', { pasta: pBr });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && /será criado no GitHub/.test(r.corpo.mensagem), 'push sem upstream: avisa que o branch será criado', r);
  r = await post('/repos/push', { pasta: pBr, confirmar: true });
  conferir(r.status === 200 && r.corpo.projeto.status.upstream === 'origin/nova' && gTalvez(rBr.bare, 'rev-parse', 'refs/heads/nova') !== '(erro)', 'push -u cria o branch no remoto', r.corpo?.projeto?.status || r);

  // ── commit ──
  const pCom = clonar(rCommit.url, 'commit'); await adicionar(pCom);
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'nada' });
  conferir(r.status === 400 && r.corpo?.codigo === 'nada', 'commit sem alterações → 400 nada', r);
  escrever(pCom, { 'a.txt': 'a 2\n', 'b.txt': 'b 2\n', 'c.txt': 'c\n', 'd/e.txt': 'e\n' });
  r = await post('/repos/commit', { pasta: pCom, mensagem: '', arquivos: ['a.txt'] });
  conferir(r.status === 400 && r.corpo?.codigo === 'mensagem', 'commit sem mensagem → 400', r);
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'x', arquivos: ['../fora.txt'] });
  conferir(r.status === 400, 'commit com caminho para fora → 400', r);
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'só a e d', arquivos: ['a.txt', 'd/'] });
  const nomes = g(pCom, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  conferir(r.status === 200 && /^[0-9a-f]{7}$/.test(r.corpo.commit?.sha || '') && r.corpo.commit.titulo === 'só a e d' && JSON.stringify(nomes) === '["a.txt","d/e.txt"]', 'commit só dos arquivos escolhidos', { r, nomes });
  conferir(r.corpo?.projeto?.status?.alteracoes === 2, 'os outros continuam alterados', r.corpo?.projeto?.status);
  conferir(g(pCom, 'log', '-1', '--format=%an <%ae>') === 'orbit-teste <42+orbit-teste@users.noreply.github.com>', 'identidade do GitHub sem gravar config', g(pCom, 'log', '-1', '--format=%an <%ae>'));
  conferir(gTalvez(pCom, 'config', '--get', 'user.email') === '(erro)', 'user.email não foi gravado');
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'resto\n\ncorpo da mensagem' });
  conferir(r.status === 200 && r.corpo.projeto.status.alteracoes === 0 && g(pCom, 'log', '-1', '--format=%B').includes('corpo da mensagem'), 'commit de tudo', r);
  escrever(pCom, { '.env': 'SENHA=1\n', 'cfg/id_rsa': 'chave\n' });
  antes = foto(pCom);
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'segredos' });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && r.corpo.perigo === true && r.corpo.itens?.includes('.env') && r.corpo.itens.includes('cfg/id_rsa'), 'commit com arquivo sensível → 409 com a lista', r);
  conferir(foto(pCom) === antes, 'commit: o 409 não muda nada');
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'segredos', confirmar: true });
  conferir(r.status === 200 && r.corpo.projeto.status.alteracoes === 0, 'commit sensível confirmado', r);
  // mode 0o755: no Mac o git ignora hook sem permissão de execução (no Windows não faz diferença).
  fs.writeFileSync(path.join(pCom, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "recusado pelo hook de teste" >&2\nexit 1\n', { mode: 0o755 });
  escrever(pCom, { 'a.txt': 'a 3\n' });
  r = await post('/repos/commit', { pasta: pCom, mensagem: 'com hook' });
  conferir(r.status === 422 && r.corpo?.codigo === 'hook' && /recusado pelo hook de teste/.test(r.corpo.erro) && r.corpo.erro.length <= 2000, 'hook recusa → 422 hook com a saída', r);
  fs.rmSync(path.join(pCom, '.git', 'hooks', 'pre-commit'));
  // operação em andamento
  const pOper = clonar(rOper.url, 'oper'); await adicionar(pOper);
  g(pOper, 'switch', '-q', '-c', 'lado'); escrever(pOper, { 'o.txt': 'lado\n' }); g(pOper, 'commit', '-qam', 'lado');
  g(pOper, 'switch', '-q', 'main'); escrever(pOper, { 'o.txt': 'main\n' }); g(pOper, 'commit', '-qam', 'main');
  try { g(pOper, 'merge', 'lado'); } catch {}
  r = await get('/repos/projeto?pasta=' + q(pOper));
  conferir(r.corpo?.projeto?.status?.operacao === 'merge' && r.corpo.projeto.status.arquivos.some((a) => a.caminho === 'o.txt' && a.tipo === 'conflito'), 'status: merge em andamento e conflito', r.corpo?.projeto?.status);
  r = await post('/repos/commit', { pasta: pOper, mensagem: 'x' });
  conferir(r.status === 409 && r.corpo?.codigo === 'operacao', 'commit com merge em andamento → 409 operacao', r);
  r = await post('/repos/pull', { pasta: pOper, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'operacao', 'pull com merge em andamento → 409 operacao', r);
  g(pOper, 'merge', '--abort');

  // ── criar ──
  const pNovo = path.join(TRAB, 'novo-projeto');
  escrever(pNovo, { 'f.txt': 'f\n', '.env': 'X=1\n', '.gitignore': 'ignorado/\n', 'ignorado/lixo.txt': 'lixo\n' });
  await adicionar(pNovo);
  antes = foto(pNovo);
  const postsAntes = gh.chamadas.filter((c) => c === 'POST /user/repos').length;
  r = await post('/repos/criar', { pasta: pNovo, nome: 'novo-repo' });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && /orbit-teste\/novo-repo/.test(r.corpo.mensagem) && /privado/.test(r.corpo.mensagem) && /3 arquivos entram/.test(r.corpo.mensagem) &&
    r.corpo.itens?.some((i) => i.includes('.env')) && r.corpo.perigo === true && /main/.test(r.corpo.mensagem), 'criar: 409 com dono/nome, visibilidade, branch, nº de arquivos e sensível', r);
  conferir(foto(pNovo) === antes && gh.chamadas.filter((c) => c === 'POST /user/repos').length === postsAntes, 'criar: o 409 não muda nada (nem no GitHub)');
  r = await post('/repos/criar', { pasta: pNovo, nome: 'novo-repo', descricao: 'teste', confirmar: true });
  const bareNovo = path.join(REMOTOS, 'orbit-teste', 'novo-repo.git');
  conferir(r.status === 200 && r.corpo.projeto?.repo?.completo === 'orbit-teste/novo-repo' && r.corpo.projeto.status.upstream === 'origin/main' && r.corpo.projeto.status.adiante === 0 &&
    r.corpo.repo?.url === 'https://github.com/orbit-teste/novo-repo', 'criar: init → commit → push', r);
  conferir(fs.existsSync(bareNovo) && g(bareNovo, 'log', '-1', '--format=%s', 'main') === 'Primeiro commit' && !g(bareNovo, 'ls-tree', '-r', '--name-only', 'main').includes('ignorado/'), 'criar: remoto com "Primeiro commit", respeitando o .gitignore');
  conferir(gh.repos.find((x) => x.name === 'novo-repo')?.private === true, 'criar: privado por padrão');
  const pNovo2 = path.join(TRAB, 'outro-projeto'); escrever(pNovo2, { 'z.txt': 'z\n' }); await adicionar(pNovo2);
  r = await post('/repos/criar', { pasta: pNovo2, nome: 'novo-repo', confirmar: true });
  conferir(r.status === 422 && r.corpo?.codigo === 'nome-em-uso' && !fs.existsSync(path.join(pNovo2, '.git')), 'criar: nome em uso → 422, pasta intacta', r);
  r = await post('/repos/criar', { pasta: stLimpo, nome: 'qualquer', confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'ja-vinculado', 'criar com origin → 409 ja-vinculado', r);
  gh.negar.criar = 'administration=write';
  r = await post('/repos/criar', { pasta: pNovo2, nome: 'sem-permissao', confirmar: true });
  gh.negar.criar = null;
  conferir(r.status === 403 && r.corpo?.codigo === 'permissao' && JSON.stringify(r.corpo.faltando) === '["administration:write"]' && !fs.existsSync(path.join(pNovo2, '.git')), 'criar sem permissão → 403 com faltando do cabeçalho', r);

  // ── clonar ──
  const progAntes = eventos.length;
  const t0Clone = Date.now();
  r = await post('/repos/clonar', { repo: 'orbit-teste/grande', destino: CLONES, nomePasta: 'grande-clone' });
  const msClone = Date.now() - t0Clone;
  const destClone = path.join(CLONES, 'grande-clone');
  conferir(r.status === 200 && r.corpo.projeto?.origem === 'clone' && r.corpo.projeto.repo?.completo === 'orbit-teste/grande' && fs.existsSync(path.join(destClone, 'arq', '299.txt')), 'clonar ok', r);
  await dormir(300);
  const prog = eventos.slice(progAntes).filter((e) => e.tipo === 'progresso' && e.op === 'clonar' && k(e.pasta) === k(destClone));
  conferir(prog.length >= 2 && prog.some((e) => ['preparando', 'recebendo', 'resolvendo', 'arquivos'].includes(e.fase)) && prog.at(-1).fase === 'concluido' && prog.at(-1).pct === 100 &&
    prog.every((e, i) => i === 0 || e.pct >= prog[i - 1].pct), 'clonar: progresso pelo SSE (fases do git, pct crescente, fim 100)', { ms: msClone, prog: prog.map((e) => `${e.fase}:${e.pct}`) });
  const reg = JSON.parse(fs.readFileSync(path.join(DADOS, 'repos.json'), 'utf8'));
  conferir(reg.projetos[k(destClone)]?.origem === 'clone' && k(reg.pastaClones) === k(CLONES), 'clonar: registra (origem clone) e guarda pastaClones', reg);
  r = await post('/repos/clonar', { repo: 'orbit-teste/grande', destino: CLONES, nomePasta: 'grande-clone' });
  conferir(r.status === 409 && r.corpo?.codigo === 'existe', 'clonar em pasta com arquivos → 409 existe', r);
  r = await post('/repos/clonar', { repo: 'orbit-teste/grande', destino: CLONES, nomePasta: 'a:b' });
  conferir(r.status === 400, 'clonar com nome de pasta inválido → 400', r);
  r = await post('/repos/clonar', { repo: 'https://evil.example/x', destino: CLONES });
  conferir(r.status === 400 && r.corpo?.codigo === 'repo', 'clonar só aceita dono/nome (nunca URL)', r);
  r = await post('/repos/clonar', { repo: 'orbit-teste/nao-existe', destino: CLONES });
  conferir(r.status >= 400 && r.status !== 200 && !fs.existsSync(path.join(CLONES, 'nao-existe')), 'clonar repo inexistente falha sem deixar pasta', r);
  conferir(eventos.some((e) => e.tipo === 'lista') && eventos.some((e) => e.tipo === 'projeto' && e.projeto?.chave), 'SSE: eventos lista e projeto');

  // ── vincular ──
  const pV = path.join(TRAB, 'vinc-local');
  escrever(pV, { 'a.txt': 'A\n', 'b.txt': 'B modificado\n', 'd.txt': 'novo\n' });
  await adicionar(pV);
  const hAntes = hashes(pV);
  antes = foto(pV);
  r = await post('/repos/vincular', { pasta: pV, repo: 'orbit-teste/vinc' });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && /não mudam/.test(r.corpo.mensagem) && /orbit-teste\/vinc/.test(r.corpo.mensagem), 'vincular sem git → 409 confirmar', r);
  conferir(foto(pV) === antes && !fs.existsSync(path.join(pV, '.git')), 'vincular: o 409 não muda nada (sem .git)');
  r = await post('/repos/vincular', { pasta: pV, repo: 'orbit-teste/vinc', confirmar: true });
  const sv = r.corpo?.projeto?.status;
  conferir(r.status === 200 && r.corpo.projeto.repo?.completo === 'orbit-teste/vinc' && sv?.branch === 'main' && sv.upstream === 'origin/main' && !sv.semCommits && sv.adiante === 0 && sv.atras === 0, 'vincular sem git: init + fetch + reset misto + upstream', r);
  conferir(hashes(pV) === hAntes, 'vincular sem git: arquivos idênticos antes e depois');
  const tipos = Object.fromEntries((sv?.arquivos || []).map((a) => [a.caminho, a.tipo]));
  conferir(tipos['b.txt'] === 'modificado' && tipos['sub/c.txt'] === 'apagado' && tipos['d.txt'] === 'nao-rastreado' && !('a.txt' in tipos), 'vincular sem git: o que difere do GitHub aparece como alteração', tipos);
  // trocar origin
  const pTroca = clonar(rStatus.url, 'troca'); await adicionar(pTroca);
  antes = foto(pTroca);
  r = await post('/repos/vincular', { pasta: pTroca, repo: 'orbit-teste/vinc' });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && /orbit-teste\/status/.test(r.corpo.mensagem) && /orbit-teste\/vinc/.test(r.corpo.mensagem), 'trocar origin → 409 "aponta para X; trocar por Y"', r);
  conferir(foto(pTroca) === antes, 'trocar origin: o 409 não muda nada');
  r = await post('/repos/vincular', { pasta: pTroca, repo: 'orbit-teste/vinc', confirmar: true });
  conferir(r.status === 200 && g(pTroca, 'config', '--get', 'remote.origin.url') === rVinc.url && r.corpo.projeto.repo.completo === 'orbit-teste/vinc', 'trocar origin confirmado', r);
  antes = foto(stLimpo);
  r = await post('/repos/vincular', { pasta: stLimpo, repo: 'orbit-teste/status' });
  conferir(r.status === 200 && foto(stLimpo) === antes, 'vincular ao próprio origin: só confirma, nada muda', r);
  const pSemOrigin = path.join(TRAB, 'sem-origin'); escrever(pSemOrigin, { 'q.txt': 'q\n' });
  g(pSemOrigin, 'init', '-q'); g(pSemOrigin, 'add', '-A'); g(pSemOrigin, 'commit', '-qm', 'local');
  await adicionar(pSemOrigin);
  r = await post('/repos/vincular', { pasta: pSemOrigin, repo: 'orbit-teste/vinc' });
  conferir(r.status === 200 && r.corpo.projeto.repo?.completo === 'orbit-teste/vinc' && r.corpo.projeto.status.upstream === 'origin/main', 'vincular git sem origin: sem confirmação, origin + upstream', r);
  r = await post('/repos/vincular', { pasta: stAlt, repo: 'orbit-teste/nao-existe', confirmar: true });
  conferir(r.status === 403 && r.corpo?.codigo === 'permissao', 'vincular a repo que o GitHub não mostra → 403', r);
  // desvincular
  antes = foto(pTroca);
  r = await post('/repos/desvincular', { pasta: pTroca });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar', 'desvincular → 409 confirmar', r);
  conferir(foto(pTroca) === antes, 'desvincular: o 409 não muda nada');
  r = await post('/repos/desvincular', { pasta: pTroca, confirmar: true });
  conferir(r.status === 200 && r.corpo.projeto.repo === null && gTalvez(pTroca, 'config', '--get', 'remote.origin.url') === '(erro)' && g(pTroca, 'rev-parse', 'HEAD').length === 40, 'desvincular: origin sai, histórico fica', r);

  // ── concorrência e prazo ──
  const pConc = clonar(rConc.url, 'concorrencia'); await adicionar(pConc);
  fs.writeFileSync(path.join(pConc, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
  escrever(pConc, { 'k.txt': 'k 2\n' });
  const lento = post('/repos/commit', { pasta: pConc, mensagem: 'lento' });
  await dormir(700);
  r = await post('/repos/push', { pasta: pConc, confirmar: true });
  const r2 = await post('/repos/commit', { pasta: pConc, mensagem: 'outro' });
  conferir(r.status === 409 && r.corpo?.codigo === 'ocupado' && r2.status === 409 && r2.corpo?.codigo === 'ocupado', 'operação em curso → 409 ocupado', { r, r2 });
  r = await lento;
  conferir(r.status === 200, 'a primeira operação termina normalmente', r);
  fs.writeFileSync(path.join(pConc, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  escrever(pConc, { 'k.txt': 'k 3\n' });
  const t0 = Date.now();
  r = await post('/repos/commit', { pasta: pConc, mensagem: 'estoura' });
  conferir(r.status === 504 && r.corpo?.codigo === 'prazo' && Date.now() - t0 < 20e3, 'prazo estourado → mata o git e responde 504 (prazo de teste 8 s)', { r, ms: Date.now() - t0 });
  r = await post('/repos/buscar', { pasta: pConc });
  conferir(r.status === 200, 'depois do 504 a pasta fica livre', r);

  // ── GitHub ──
  const pagAntes = gh.chamadas.filter((c) => c === 'GET /user/repos').length;
  r = await get('/repos/github');
  conferir(r.status === 200 && r.corpo.login === 'orbit-teste' && r.corpo.repos.length === gh.repos.length && gh.chamadas.filter((c) => c === 'GET /user/repos').length - pagAntes === 2, 'GET /repos/github: todas as páginas', { n: r.corpo?.repos?.length, esperado: gh.repos.length });
  const lista = r.corpo.repos || [];
  conferir(lista.every((x, i) => i === 0 || x.atualizado <= lista[i - 1].atualizado), 'repos em ordem de atualização (desc)');
  const rs = lista.find((x) => x.completo === 'orbit-teste/status');
  conferir(rs && rs.visibilidade === 'privado' && rs.branchPadrao === 'main' && rs.url === 'https://github.com/orbit-teste/status' && rs.podeEnviar === true &&
    [stLimpo, stAlt, stAd, stAt, stDest].every((d) => rs.vinculadoA.includes(k(d))), 'Repo: campos e vinculadoA', rs);
  conferir(lista.some((x) => x.visibilidade === 'publico'), 'visibilidade público mapeada');
  const lidoGh = r.corpo.lidoEm;
  r = await get('/repos/github');
  conferir(r.corpo.lidoEm === lidoGh, 'cache de 60 s do GitHub');
  await dormir(20);
  r = await get('/repos/github?forcar=1');
  conferir(r.corpo.lidoEm > lidoGh, 'forcar=1 relê');
  gh.negar.listar = 'metadata=read';
  r = await get('/repos/github?forcar=1');
  gh.negar.listar = null;
  conferir(r.status === 403 && r.corpo?.codigo === 'permissao' && JSON.stringify(r.corpo.faltando) === '["metadata:read"]', 'GitHub 403 → permissao com faltando', r);

  // ── token: nunca em resposta, SSE, log, repos.json, .git/config nem argv ──
  const argv = fs.readFileSync(GITLOG, 'utf8');
  conferir(/"fetch"/.test(argv) && /"push"/.test(argv) && /"clone"/.test(argv), 'ORBIT_GIT_LOG registrou os git de rede');
  const fontes = { respostas: respostas.join('\n'), sse: sseBruto, argv, 'repos.json': fs.readFileSync(path.join(DADOS, 'repos.json'), 'utf8') };
  try { fontes.log = fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8'); } catch { fontes.log = ''; }
  const configs = [];
  const andar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, e.name); if (e.isDirectory()) { if (e.name === '.git' || e.name.endsWith('.git')) { const c = path.join(p2, 'config'); if (fs.existsSync(c)) configs.push(c); } if (e.name !== 'objects') andar(p2); } } };
  andar(TRAB); andar(CLONES); andar(REMOTOS);
  for (const c of configs) fontes[c] = fs.readFileSync(c, 'utf8');
  const vazou = Object.entries(fontes).filter(([, t]) => t.includes(TOKEN) || t.includes(TOKEN_B64) || /authorization/i.test(t)).map(([n]) => n);
  conferir(vazou.length === 0 && configs.length >= 15, `token ausente de respostas, SSE, log, repos.json, argv e ${configs.length} .git/config`, vazou);
  // Na pasta real do Orbit o servidor pode ler (status), nunca escrever.
  const LEITURA = new Set(['rev-parse', 'status', 'symbolic-ref', 'for-each-ref', 'rev-list', 'log', 'remote', 'config', 'branch', 'diff', 'ls-files', 'show-ref', 'cat-file']);
  const gitsOrbit = argv.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((j) => doOrbit(j.cwd) || j.args.some((x) => typeof x === 'string' && doOrbit(x) && path.isAbsolute(x)));
  const sub = (j) => j.args.find((x) => typeof x === 'string' && !x.startsWith('-') && !x.includes('=') && x !== 'git');
  conferir(gitsOrbit.every((j) => LEITURA.has(sub(j)) && !j.args.some((x) => /^--(?:set|add|unset|replace)/.test(String(x)))), 'nas pastas do Orbit só rodou git de leitura', gitsOrbit.map((j) => j.args.join(' ')).slice(0, 5));
  // No Mac não há %TEMP%: a pasta temporária do sistema (onde o repos.mjs conta os arquivos) é o os.tmpdir().
  const foraDoTeste = argv.split('\n').filter(Boolean).map((l) => JSON.parse(l).cwd).filter((c) => !(dentro(c, SAIDA) || dentro(c, process.env.TEMP || (process.platform === 'win32' ? 'C:\\x' : os.tmpdir())) || doOrbit(c)));
  conferir(foraDoTeste.length === 0, 'todo git do servidor rodou nas pastas de teste ou (só leitura) no Orbit', [...new Set(foraDoTeste)].slice(0, 5));

  // ── token recusado (por último: o perfil fica expirado) ──
  gh.estado.tokenVale = false;
  r = await get('/repos/github?forcar=1');
  conferir(r.status === 401 && r.corpo?.codigo === 'expirado', 'GitHub 401 → 401 expirado', r);
  r = await get('/perfil');
  conferir(r.corpo?.github?.expirado === true, 'o 401 chama perfil.verificar() (perfil expirado)', r.corpo?.github);
  r = await get('/repos/projetos');
  conferir(r.corpo?.github?.expirado === true && r.corpo.github.login === 'orbit-teste', 'projetos: github.expirado depois do 401', r.corpo?.github);
  r = await post('/repos/criar', { pasta: pNovo2, nome: 'depois', confirmar: true });
  conferir(r.status === 401 && r.corpo?.codigo === 'expirado', 'ação de GitHub com token vencido → 401', r);
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  sse.abort();
  if (srv) { const ok = await desligarSeMeu(PORTA, srv.pid); if (!ok) try { srv.kill(); } catch {} }
  if (gh) await gh.fechar();
}

// ── sistema (16/10, Orbit no Mac): mensagens com exemplo do sistema certo; git e árvore pelo plataforma.mjs ──
try {
  const { textosDoSistema } = await import(new URL('../repos.mjs', import.meta.url).href);
  const w = textosDoSistema('win32');
  conferir(w.exemploPasta === 'D:\\Projetos\\app' && /Git for Windows/.test(w.semGit) && w.usuario === 'outro usuário do Windows', 'Windows: mensagens iguais às de antes', w);
  const m = textosDoSistema('darwin');
  conferir(m.exemploPasta.startsWith('/Users/') && /xcode-select --install/.test(m.semGit) && !/Windows/.test(JSON.stringify(m)), 'Mac (simulado): exemplo /Users/… e instalar pelo xcode-select, sem citar o Windows', m);
  const fonte = fs.readFileSync(path.join(PROJ, 'repos.mjs'), 'utf8');
  conferir(!/Program Files|taskkill\.exe|TASKKILL|SystemRoot/.test(fonte) && /acharNoPath\('git'\)/.test(fonte) && /gitsPadrao\(\)/.test(fonte) && /matarArvore\(/.test(fonte),
    'repos.mjs sem caminho fixo do Windows: git por acharNoPath/gitsPadrao, árvore por matarArvore');
} catch (e) {
  res.falhas.push('exceção (sistema): ' + (e?.stack || e));
}

fs.writeFileSync(path.join(SAIDA, 'resultado.json'), JSON.stringify(res, null, 2));
console.log(`${res.ok.length} ok / ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('FALHA:', f);
process.exit(res.falhas.length ? 1 : 0);
