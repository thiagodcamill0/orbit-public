// Versionar pelo card da Visão geral (18/10): os fluxos que o card usa, de ponta a ponta, no
// servidor de verdade e com git de verdade. Remotos *bare* file:// (o GitHub falso do repos.test.mjs) e um
// projeto como um projeto grande: uma pasta com um .git vazio (vínculo pela metade) e um clone por branch (app/, main/).
// Um "outro computador" (outro clone) envia em paralelo para provocar recusa, junção e conflito.
// Confere: as subpastas viram projetos; a prévia acha pasta nativa do Expo, .DS_Store, credencial e arquivo de
// 101 MB; o ignorar só acrescenta ao .gitignore; commit confirmado; envio recusado → junta → envia; conflito →
// desfaz sem perder nada; receber; branch novo enviado ao GitHub; troca de branch levando alterações.
// Nunca toca a 47821, o GitHub de verdade nem o token do usuário (sem token: o git usa a identidade do
// GIT_CONFIG_GLOBAL de teste).
//   node testes/versionar.test.mjs <pasta-de-saida>    (~20 s)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { subirGithubFalso, definirRaizTeste, gitTeste, escrever } from './github-falso.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TMPDIR || process.env.TEMP || '.', 'orbit-versionar-teste'));
const k = (p) => path.resolve(p).toLowerCase();
if (k(SAIDA) === k(path.dirname(PROJ)) || k(SAIDA).startsWith(k(path.dirname(PROJ)) + path.sep)) {
  console.error('A saída não pode ficar dentro de', path.dirname(PROJ), '(outras sessões trabalham lá).');
  process.exit(2);
}
fs.rmSync(SAIDA, { recursive: true, force: true, maxRetries: 3 });
fs.mkdirSync(SAIDA, { recursive: true });
definirRaizTeste(SAIDA);
const D = (n) => path.join(SAIDA, n);
const DADOS = D('dados'), PERFIL = D('perfil'), SESS = D('sessoes'), REMOTOS = D('remotos'), SEMENTES = D('sementes'), TRAB = D('trab');
for (const d of [DADOS, PERFIL, SESS, REMOTOS, SEMENTES, TRAB]) fs.mkdirSync(d, { recursive: true });
const GLOBAL = D('gitconfig-global');
fs.writeFileSync(GLOBAL, '[user]\n\tname = Teste\n\temail = teste@exemplo.invalid\n[core]\n\tautocrlf = false\n'); // autocrlf=false: o gitconfig do sistema (Git for Windows) traz true e trocaria LF por CRLF
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}'); // config padrão de teste (o servidor completa com CONFIG_PADRAO); nada da raiz do app

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = '';
async function pedir(metodo, rota, corpo) {
  const r = await fetch(BASE + rota, metodo === 'GET' ? { cache: 'no-store' } : { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
  let c = null; try { c = await r.json(); } catch {}
  return { status: r.status, corpo: c };
}
const post = (rota, corpo) => pedir('POST', rota, corpo);
const get = (rota) => pedir('GET', rota);
const g = (cwd, ...a) => gitTeste(cwd, a).trim();
const gTalvez = (cwd, ...a) => { try { return g(cwd, ...a); } catch { return '(erro)'; } };

let srv = null, gh = null;
try {
  gh = await subirGithubFalso({ porta: await escolherPorta(47825), remotos: REMOTOS, sementes: SEMENTES, token: 'x' });
  const PORTA = await escolherPorta(47822);
  BASE = `http://127.0.0.1:${PORTA}`;
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL,
      ORBIT_GITHUB_API: gh.url, ORBIT_GIT_BASE: gh.base, ORBIT_REPOS_PRAZO_MS: '20000', GIT_CONFIG_GLOBAL: GLOBAL },
  });
  for (let i = 0; i < 80; i++) { try { const s = await (await fetch(BASE + '/saude')).json(); if (s.pid === srv.pid) break; } catch {} await dormir(150); }

  // ── o projeto: .git vazio em cima, um clone por branch embaixo (como o ~/Exemplo) ──
  const remoto = gh.semear('proj', { 'a.txt': 'linha 1\nlinha 2\n', 'b.txt': 'b\n', 'package.json': '{ "dependencies": { "expo": "^57.0.0" } }\n' }, { branches: { app: { 'app.txt': 'app\n' } } });
  const RAIZ = path.join(TRAB, 'Proj');
  fs.mkdirSync(RAIZ);
  g(RAIZ, 'init', '-q', '-b', 'main');
  g(RAIZ, 'remote', 'add', 'origin', remoto.url);
  g(TRAB, 'clone', '-q', '-b', 'app', remoto.url, path.join(RAIZ, 'app'));
  g(TRAB, 'clone', '-q', '-b', 'main', remoto.url, path.join(RAIZ, 'main'));
  const APP = path.join(RAIZ, 'app'), MAIN = path.join(RAIZ, 'main');
  // O outro computador: um clone de cada branch, fora do projeto.
  const OUTRO = path.join(TRAB, 'outro-pc');
  g(TRAB, 'clone', '-q', '-b', 'app', remoto.url, OUTRO);
  const outroEnvia = (arquivos, msg, branch = 'app') => {
    g(OUTRO, 'switch', '-q', branch);
    g(OUTRO, 'pull', '-q', '--ff-only');
    escrever(OUTRO, arquivos);
    g(OUTRO, 'add', '-A'); g(OUTRO, 'commit', '-q', '-m', msg); g(OUTRO, 'push', '-q', 'origin', branch);
  };

  let r = await post('/repos/adicionar', { pasta: RAIZ });
  conferir(r.status === 200, 'adicionar a pasta do projeto', r);
  r = await get('/repos/projetos');
  const lista = r.corpo?.projetos || [];
  const raiz = lista.find((p) => k(p.pasta) === k(RAIZ));
  const pApp = lista.find((p) => k(p.pasta) === k(APP)), pMain = lista.find((p) => k(p.pasta) === k(MAIN));
  conferir(raiz && raiz.status?.semCommits && JSON.stringify((raiz.subrepos || []).map((x) => path.basename(x))) === '["app","main"]', 'a pasta de cima (sem commits) lista as subpastas app e main', raiz);
  conferir(pApp?.origem === 'subpasta' && pApp.status?.branch === 'app' && pApp.repo?.completo === 'orbit-teste/proj' && pMain?.status?.branch === 'main', 'app e main viram projetos, cada um no seu branch e ligado ao repositório', { pApp, pMain });

  // ── prévia: pasta nativa do Expo, .DS_Store e credencial ──
  const TOKEN_FALSO = 'gh' + 'p_' + 'Ab3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gH3jK5';
  escrever(APP, { 'a.txt': 'linha 1 do app\nlinha 2\n', 'src/config.ts': `export const token = '${TOKEN_FALSO}';\n`, 'ios/Podfile': 'platform :ios\n', 'ios/App/AppDelegate.swift': '// gerado\n', '.DS_Store': 'x' });
  r = await post('/repos/previa', { pasta: APP });
  const pv = r.corpo || {};
  conferir(r.status === 200 && pv.branch === 'app' && pv.upstream === 'origin/app' && pv.arquivos === 5, 'prévia: branch, upstream e 5 arquivos', pv);
  conferir(JSON.stringify((pv.geradas || []).map((x) => x.padrao).sort()) === JSON.stringify(['.DS_Store', '/ios/']), 'prévia: /ios/ (Expo) e .DS_Store como gerados', pv.geradas);
  conferir((pv.credenciais || []).some((c) => c.arquivo === 'src/config.ts' && c.linha === 1 && c.tipo === 'token do GitHub') && !JSON.stringify(pv).includes(TOKEN_FALSO), 'prévia: acha o token em src/config.ts:1 sem devolver o valor', pv.credenciais);
  conferir(typeof pv.sugestao === 'string' && pv.sugestao.length > 3 && !/ios|DS_Store/.test(pv.sugestao), 'prévia: sugestão de mensagem sem os gerados', pv.sugestao);

  // ── ignorar: confirma, só acrescenta ao .gitignore ──
  r = await post('/repos/ignorar', { pasta: APP, padroes: ['/ios/', '.DS_Store'] });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && !fs.existsSync(path.join(APP, '.gitignore')), 'ignorar sem confirmar: 409 e nada muda', r);
  r = await post('/repos/ignorar', { pasta: APP, padroes: ['../fora'] });
  conferir(r.status === 400, 'ignorar com padrão para fora da pasta: 400', r);
  r = await post('/repos/ignorar', { pasta: APP, padroes: ['/ios/', '.DS_Store'], confirmar: true });
  const gi = fs.readFileSync(path.join(APP, '.gitignore'), 'utf8');
  conferir(r.status === 200 && /^\/ios\/$/m.test(gi) && /^\.DS_Store$/m.test(gi) && fs.existsSync(path.join(APP, 'ios', 'Podfile')), 'ignorar confirmado: .gitignore com as linhas e a pasta continua no disco', { r, gi });
  r = await post('/repos/previa', { pasta: APP });
  conferir(r.corpo?.geradas?.length === 0 && r.corpo.arquivos === 3, 'prévia depois de ignorar: só a.txt, src/config.ts e .gitignore', r.corpo);

  // ── commit: a credencial pede confirmação; sem ela, commit normal ──
  const antes = g(APP, 'rev-parse', 'HEAD');
  r = await post('/repos/commit', { pasta: APP, mensagem: 'com token' });
  conferir(r.status === 409 && r.corpo?.perigo === true && (r.corpo.itens || []).some((i) => i === 'src/config.ts:1 (token do GitHub)') && g(APP, 'rev-parse', 'HEAD') === antes, 'commit com credencial: 409 perigo com arquivo:linha e nada commitado', r.corpo);
  escrever(APP, { 'src/config.ts': 'export const token = process.env.TOKEN;\n' });
  r = await post('/repos/commit', { pasta: APP, mensagem: 'App: tela nova', confirmar: true });
  conferir(r.status === 200 && r.corpo?.projeto?.status?.alteracoes === 0 && r.corpo.projeto.status.adiante === 1 && g(APP, 'log', '-1', '--format=%s') === 'App: tela nova', 'commit confirmado: limpo e 1 commit à frente', r.corpo?.projeto?.status || r);

  // ── envio recusado (o outro computador enviou antes) → junta → envia ──
  outroEnvia({ 'b.txt': 'b do outro pc\n' }, 'Outro: b.txt');
  r = await post('/repos/push', { pasta: APP, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'rejeitado', 'envio com o GitHub à frente: recusado sem forçar', r.corpo);
  r = await post('/repos/pull', { pasta: APP, mesclar: true, confirmar: true });
  conferir(r.status === 200 && r.corpo?.recebidos === 1 && fs.readFileSync(path.join(APP, 'b.txt'), 'utf8') === 'b do outro pc\n', 'juntar: merge com o commit do outro computador', r.corpo);
  r = await post('/repos/push', { pasta: APP, confirmar: true });
  const remApp = g(OUTRO, 'ls-remote', 'origin', 'refs/heads/app').split(/\s/)[0];
  conferir(r.status === 200 && remApp === g(APP, 'rev-parse', 'HEAD') && r.corpo.projeto.status.adiante === 0, 'envio depois de juntar: o GitHub fica igual a este computador', { r: r.corpo?.projeto?.status, remApp });

  // ── conflito: as mesmas linhas nos dois lados → desfaz, nada se perde ──
  outroEnvia({ 'a.txt': 'linha 1 do OUTRO\nlinha 2\n' }, 'Outro: a.txt');
  escrever(APP, { 'a.txt': 'linha 1 DESTE\nlinha 2\n' });
  r = await post('/repos/commit', { pasta: APP, mensagem: 'Este: a.txt', confirmar: true });
  const meu = g(APP, 'rev-parse', 'HEAD');
  r = await post('/repos/push', { pasta: APP, confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'rejeitado', 'conflito: o envio é recusado primeiro', r.corpo);
  r = await post('/repos/pull', { pasta: APP, mesclar: true, confirmar: true });
  const gitDir = path.join(APP, '.git');
  conferir(r.status === 409 && r.corpo?.codigo === 'conflito' && (r.corpo.arquivos || []).includes('a.txt'), 'conflito: o merge para e diz o arquivo', r.corpo);
  conferir(!fs.existsSync(path.join(gitDir, 'MERGE_HEAD')) && g(APP, 'rev-parse', 'HEAD') === meu && g(APP, 'status', '--porcelain') === '' && fs.readFileSync(path.join(APP, 'a.txt'), 'utf8') === 'linha 1 DESTE\nlinha 2\n', 'conflito: merge desfeito, o commit e o arquivo deste computador intactos');

  // ── resolver no editor: a junção fica aberta, Concluir recusa enquanto houver marcas ──
  r = await post('/repos/pull', { pasta: APP, mesclar: true, confirmar: true, manterConflito: true });
  const comMarcas = fs.readFileSync(path.join(APP, 'a.txt'), 'utf8');
  conferir(r.status === 409 && r.corpo?.codigo === 'resolver' && fs.existsSync(path.join(gitDir, 'MERGE_HEAD')) && /^<{7} /m.test(comMarcas) && /DESTE/.test(comMarcas) && /OUTRO/.test(comMarcas), 'abrir para resolver: merge aberto com os dois lados marcados', { c: r.corpo, comMarcas });
  conferir(r.corpo?.projeto?.status?.operacao === 'merge' && r.corpo.projeto.status.arquivos.some((a) => a.caminho === 'a.txt' && a.tipo === 'conflito'), 'o status mostra o merge e o arquivo em conflito', r.corpo?.projeto?.status);
  r = await post('/repos/concluir', { pasta: APP });
  conferir(r.status === 409 && r.corpo?.codigo === 'marcas' && (r.corpo.arquivos || []).includes('a.txt') && fs.existsSync(path.join(gitDir, 'MERGE_HEAD')), 'concluir com marcas ainda no arquivo: recusa e o merge continua aberto', r.corpo);
  r = await post('/repos/commit', { pasta: APP, mensagem: 'x', confirmar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'operacao', 'commit comum com a junção aberta: recusado', r.corpo);
  escrever(APP, { 'a.txt': 'linha 1 RESOLVIDA\nlinha 2\n', 'solto.txt': 'não entra no merge\n' });
  r = await post('/repos/concluir', { pasta: APP });
  const pais = g(APP, 'log', '-1', '--format=%P').split(' ').length;
  conferir(r.status === 200 && !fs.existsSync(path.join(gitDir, 'MERGE_HEAD')) && pais === 2 && g(APP, 'show', 'HEAD:a.txt') === 'linha 1 RESOLVIDA\nlinha 2', 'concluir: commit de merge com o que foi resolvido', { c: r.corpo, pais });
  conferir(g(APP, 'status', '--porcelain') === '?? solto.txt', 'concluir: só os arquivos do conflito entram (o arquivo solto fica de fora)', g(APP, 'status', '--porcelain'));
  fs.rmSync(path.join(APP, 'solto.txt'));
  r = await post('/repos/push', { pasta: APP, confirmar: true });
  conferir(r.status === 200 && g(OUTRO, 'ls-remote', 'origin', 'refs/heads/app').split(/\s/)[0] === g(APP, 'rev-parse', 'HEAD'), 'enviar depois de concluir: o GitHub recebe a junção', r.corpo?.projeto?.status || r);

  // ── cancelar a junção: confirma e volta ao commit deste computador ──
  outroEnvia({ 'a.txt': 'linha 1 OUTRO de novo\nlinha 2\n' }, 'Outro: a.txt de novo');
  escrever(APP, { 'a.txt': 'linha 1 DESTE de novo\nlinha 2\n' });
  await post('/repos/commit', { pasta: APP, mensagem: 'Este: a.txt de novo', confirmar: true });
  const meu2 = g(APP, 'rev-parse', 'HEAD');
  r = await post('/repos/pull', { pasta: APP, mesclar: true, confirmar: true, manterConflito: true });
  conferir(r.corpo?.codigo === 'resolver', 'segundo conflito: junção aberta', r.corpo);
  r = await post('/repos/cancelar-juncao', { pasta: APP });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar' && r.corpo.perigo === true && fs.existsSync(path.join(gitDir, 'MERGE_HEAD')), 'cancelar sem confirmar: pergunta e nada muda', r.corpo);
  r = await post('/repos/cancelar-juncao', { pasta: APP, confirmar: true });
  conferir(r.status === 200 && !fs.existsSync(path.join(gitDir, 'MERGE_HEAD')) && g(APP, 'rev-parse', 'HEAD') === meu2 && g(APP, 'status', '--porcelain') === '', 'cancelar confirmado: volta ao commit deste computador, árvore limpa', r.corpo?.projeto?.status);

  // ── arquivo acima de 100 MB: o commit é recusado antes ──
  const grande = path.join(MAIN, 'video.mov');
  fs.closeSync(fs.openSync(grande, 'w')); fs.truncateSync(grande, 101 * 1024 * 1024);
  r = await post('/repos/previa', { pasta: MAIN });
  conferir(r.corpo?.enormes?.length === 1 && r.corpo.enormes[0].arquivo === 'video.mov', 'prévia: arquivo de 101 MB em enormes', r.corpo?.enormes);
  const antesMain = g(MAIN, 'rev-parse', 'HEAD');
  r = await post('/repos/commit', { pasta: MAIN, mensagem: 'vídeo', confirmar: true });
  conferir(r.status === 400 && r.corpo?.codigo === 'grande' && g(MAIN, 'rev-parse', 'HEAD') === antesMain && g(MAIN, 'diff', '--cached', '--name-only') === '', 'commit com arquivo de 101 MB: 400, sem commit e sem nada preparado', r.corpo);
  fs.rmSync(grande);

  // ── receber: o outro computador envia na main ──
  outroEnvia({ 'c.txt': 'c\n' }, 'Outro: c.txt na main', 'main');
  r = await post('/repos/pull', { pasta: MAIN });
  conferir(r.status === 200 && r.corpo?.recebidos === 1 && fs.existsSync(path.join(MAIN, 'c.txt')), 'receber na main: 1 commit, sem mesclar', r.corpo);

  // ── branch novo: cria, salva, envia (cria no GitHub com upstream) ──
  r = await get('/repos/branches?pasta=' + encodeURIComponent(MAIN));
  conferir(r.status === 200 && r.corpo?.atual === 'main' && (r.corpo.remotos || []).some((b) => b.nome === 'app'), 'branches da main: a atual e o app que só existe no GitHub', r.corpo);
  escrever(MAIN, { 'novo.txt': 'novo\n' });
  r = await post('/repos/branch', { pasta: MAIN, nome: 'ajuste-x', criar: true });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar', 'branch novo com alteração sem commit: pede confirmação', r.corpo);
  r = await post('/repos/branch', { pasta: MAIN, nome: 'ajuste-x', criar: true, confirmar: true });
  conferir(r.status === 200 && r.corpo?.projeto?.status?.branch === 'ajuste-x' && fs.existsSync(path.join(MAIN, 'novo.txt')), 'branch novo: troca e a alteração vai junto', r.corpo?.projeto?.status);
  r = await post('/repos/commit', { pasta: MAIN, mensagem: 'Ajuste X', confirmar: true });
  r = await post('/repos/push', { pasta: MAIN, confirmar: true });
  conferir(r.status === 200 && r.corpo?.projeto?.status?.upstream === 'origin/ajuste-x' && gTalvez(OUTRO, 'ls-remote', '--exit-code', 'origin', 'refs/heads/ajuste-x') !== '(erro)', 'enviar o branch novo: criado no GitHub e ligado', r.corpo?.projeto?.status);
  r = await post('/repos/branch', { pasta: MAIN, nome: 'main' });
  conferir(r.status === 200 && r.corpo?.projeto?.status?.branch === 'main' && !fs.existsSync(path.join(MAIN, 'novo.txt')), 'voltar para a main (sem alterações: sem pergunta)', r.corpo?.projeto?.status);
  r = await post('/repos/branch', { pasta: MAIN, nome: 'app' });
  conferir(r.status === 200 && r.corpo?.projeto?.status?.branch === 'app' && r.corpo.projeto.status.upstream === 'origin/app', 'trocar para um branch que só existe no GitHub: cria o local ligado', r.corpo?.projeto?.status);

  // ── a pasta de cima continua sem commits e nada foi enviado por ela ──
  conferir(gTalvez(RAIZ, 'rev-parse', 'HEAD') === '(erro)', 'o .git vazio de cima não ganhou commits');

  // ── ignorar neste computador (20/10): worktree em commit solto, como o app-build de um projeto ──
  const BUILD = path.join(RAIZ, 'app-build');
  g(APP, 'worktree', 'add', '-q', '--detach', BUILD);
  escrever(BUILD, { 'gerado/saida.bin': 'x\n', 'Relatório [v2] #1.txt': 'x\n' });
  escrever(BUILD, { 'a.txt': 'mexido no build\n' });
  await post('/repos/adicionar', { pasta: BUILD });
  r = await post('/repos/ignorar', { pasta: BUILD, local: true, arquivos: ['nao-existe.txt'] });
  conferir(r.status === 400 && r.corpo?.codigo === 'rastreados', 'ignorar local de arquivo sem alteração: 400', r.corpo);
  r = await post('/repos/ignorar', { pasta: BUILD, local: true, arquivos: ['../fora'] });
  conferir(r.status === 400, 'ignorar local para fora da pasta: 400', r.corpo);
  r = await post('/repos/ignorar', { pasta: BUILD, local: true, arquivos: ['gerado/', 'Relatório [v2] #1.txt'] });
  conferir(r.status === 409 && r.corpo?.codigo === 'confirmar', 'ignorar local sem confirmar: 409', r.corpo);
  r = await post('/repos/ignorar', { pasta: BUILD, local: true, arquivos: ['gerado/', 'Relatório [v2] #1.txt'], confirmar: true });
  const arqsBuild = (r.corpo?.projeto?.status?.arquivos || []).map((a) => a.caminho);
  const exclude = fs.readFileSync(path.join(APP, '.git', 'info', 'exclude'), 'utf8');
  conferir(r.status === 200 && JSON.stringify(arqsBuild) === '["a.txt"]' && fs.existsSync(path.join(BUILD, 'gerado', 'saida.bin')),
    'ignorar local: só a.txt continua como alteração (o .gitignore não mudou) e a pasta no disco', { arqsBuild, exclude });
  conferir(/^\/gerado\/$/m.test(exclude) && exclude.includes('/Relatório \\[v2\\] \\#1.txt'), 'ignorar local: caminhos exatos no info/exclude do repositório', exclude);
  // O que o git já acompanha (como os arquivos da build de iOS no Mac): skip-worktree, e o card fica Em dia.
  r = await post('/repos/ignorar', { pasta: BUILD, local: true, arquivos: ['a.txt'], confirmar: true });
  const stB = r.corpo?.projeto?.status;
  conferir(r.status === 200 && stB?.alteracoes === 0 && fs.readFileSync(path.join(BUILD, 'a.txt'), 'utf8') === 'mexido no build\n'
    && /^S /m.test(g(BUILD, 'ls-files', '-v', 'a.txt')), 'ignorar local de arquivo acompanhado: skip-worktree, sem alterações e o arquivo como está', stB);
  conferir(stB?.branch === null && stB?.destacado && stB?.destacadoEm === 'app', 'commit solto que já está num branch: destacadoEm diz qual', stB);
} catch (e) {
  falhas++;
  console.log('FALHA', e?.stack || e);
} finally {
  try { srv?.kill(); } catch {}
  try { await gh?.fechar?.(); } catch {}
}
console.log(`\n${ok} ok, ${falhas} falhas · saída em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
