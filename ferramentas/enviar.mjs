// Envio desta cópia ao repositório (só para quem mantém o Orbit Public; quem usa só faz git pull).
//
//   node ferramentas/enviar.mjs                          confere tudo e não muda nada (simulação)
//   node ferramentas/enviar.mjs --enviar -m "mensagem"   confere; se estiver limpo, faz o commit e o push
//   --origem <url> --nome "..." --email "..."            só na primeira vez: git init, remote origin e a
//                                                        identidade do git gravada só nesta pasta
//
// O que confere (qualquer problema recusa o envio):
//   - arquivos que iriam (os do .gitignore ficam fora): binário executável, arquivo acima de 10 MB, segredos
//     (tokens do GitHub, da Anthropic, da AWS, do Slack, chave privada) e os termos pessoais da lista local;
//   - identidade do git desta pasta (user.name e user.email): definida e sem termo pessoal;
//   - commits que iriam: autor e quem fez o commit iguais à identidade (commit de outra pessoa recusa), e a
//     mensagem sem segredo nem termo pessoal;
//   - o remoto: se tem commit que não está aqui, recusa (git pull antes). Nunca usa --force.
//
// Termos pessoais: envio-termos.txt na raiz (fora do git: /envio-termos.txt no .gitignore). Um termo por linha,
// sem diferença de maiúscula; "#" comenta; "ignorar: <caminho>" tira um arquivo só da busca de termos (os
// segredos são procurados nele do mesmo jeito); "permitir: <texto>" aceita esse texto exato só na identidade do git
// (ex.: o e-mail "noreply" do GitHub, que leva o nome da conta). Sem a lista, a simulação avisa e o envio recusa.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARQ_TERMOS = path.join(PASTA, 'envio-termos.txt');
const RAMO = 'main';
const MAX_BYTES = 10 * 1024 * 1024;
const PROIBIDAS = new Set(['.exe', '.dll', '.node', '.pdb', '.msi', '.zip', '.7z', '.rar', '.jar']);
const SEM_TEXTO = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp3', '.mp4', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.otf']);
export const SEGREDOS = [
  ['token do GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['token do GitHub', /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ['chave da Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['chave da AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['chave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function git(args, { pasta = PASTA, gitDir } = {}) {
  const pre = gitDir ? ['--git-dir', gitDir, '--work-tree', pasta] : [];
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...pre, ...args], { cwd: pasta, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error('git não encontrado: ' + r.error.message);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function lerTermos(texto) {
  const termos = [];
  const ignorar = new Set();
  const permitir = new Set();
  for (const bruta of String(texto).split(/\r?\n/)) {
    const l = bruta.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^ignorar:\s*(.+)$/i.exec(l);
    const p = /^permitir:\s*(.+)$/i.exec(l);
    if (m) ignorar.add(m[1].trim().replace(/\\/g, '/'));
    else if (p) permitir.add(p[1].trim().toLowerCase());
    else termos.push(l.toLowerCase());
  }
  return { termos, ignorar, permitir };
}

// Procura segredos e termos num texto; devolve [{ tipo, linha, trecho }].
export function varrerTexto(texto, termos = []) {
  const achados = [];
  const linhas = String(texto).split('\n');
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    for (const [tipo, re] of SEGREDOS) if (re.test(l)) achados.push({ tipo, linha: i + 1, trecho: '(segredo omitido)' });
    const min = l.toLowerCase();
    for (const t of termos) if (min.includes(t)) achados.push({ tipo: `termo "${t}"`, linha: i + 1, trecho: l.trim().slice(0, 120) });
  }
  return achados;
}

// Arquivos que iriam ao repositório (sem .git ainda: um git temporário só para ler o .gitignore).
function arquivosQueIriam(temRepo) {
  if (temRepo) {
    const r = git(['ls-files', '-co', '--exclude-standard', '-z']);
    if (!r.ok) throw new Error(r.err);
    return r.out.split('\0').filter(Boolean);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-envio-'));
  try {
    git(['init', '-q', '--bare', tmp]);
    const r = git(['-c', 'core.excludesFile=', 'ls-files', '-o', '--exclude-standard', '-z'], { gitDir: tmp });
    if (!r.ok) throw new Error(r.err);
    return r.out.split('\0').filter(Boolean);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function conferirArquivos(lista, { termos, ignorar }) {
  const problemas = [];
  for (const rel of lista) {
    const abs = path.join(PASTA, rel);
    const ext = path.extname(rel).toLowerCase();
    const nomeMin = rel.toLowerCase();
    for (const t of termos) if (nomeMin.includes(t)) problemas.push(`${rel}: termo "${t}" no caminho`);
    if (PROIBIDAS.has(ext)) { problemas.push(`${rel}: binário (${ext})`); continue; }
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > MAX_BYTES) problemas.push(`${rel}: ${(st.size / 1048576).toFixed(1)} MB (máximo 10 MB)`);
    if (SEM_TEXTO.has(ext) || st.size > MAX_BYTES) continue;
    const texto = fs.readFileSync(abs, 'utf8');
    const achados = varrerTexto(texto, ignorar.has(rel) ? [] : termos);
    for (const a of achados) problemas.push(`${rel}:${a.linha}: ${a.tipo}: ${a.trecho}`);
  }
  return problemas;
}

function identidade({ termos, permitir = new Set() }, temRepo) {
  const nome = (temRepo ? git(['config', 'user.name']).out : '') || argumento('--nome') || '';
  const email = (temRepo ? git(['config', 'user.email']).out : '') || argumento('--email') || '';
  const problemas = [];
  if (!nome || !email) problemas.push(temRepo ? 'identidade do git não definida: git -C <esta pasta> config user.name "..." e user.email "..." (sugestão: o e-mail "noreply" do GitHub)' : 'na primeira vez, passe --nome "..." e --email "..." (sugestão: o e-mail "noreply" do GitHub)');
  let junto = `${nome} ${email}`.toLowerCase();
  for (const p of permitir) junto = junto.split(p).join(' ');
  for (const t of termos) if (junto.includes(t)) problemas.push(`identidade do git (${nome} <${email}>): termo "${t}"`);
  return { nome, email, problemas };
}

// Commits que iriam (origin/main..HEAD, ou todos sem remoto) e o estado do remoto.
function conferirCommits(id, termos) {
  const problemas = [];
  const temHead = git(['rev-parse', '--verify', '-q', 'HEAD']).ok;
  if (!temHead) return { problemas, commits: 0 };
  let faixa = 'HEAD';
  if (git(['remote', 'get-url', 'origin']).ok) {
    const f = git(['fetch', '-q', 'origin']);
    if (!f.ok) problemas.push('não consegui ler o remoto (git fetch): ' + f.err);
    else if (git(['rev-parse', '--verify', '-q', `origin/${RAMO}`]).ok) {
      const atras = git(['rev-list', '--count', `HEAD..origin/${RAMO}`]).out;
      if (atras !== '0') problemas.push(`o remoto tem ${atras} commit(s) que não estão aqui: git pull antes de enviar`);
      faixa = `origin/${RAMO}..HEAD`;
    }
  }
  const r = git(['log', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', faixa]);
  const commits = r.out.split('\x1e').map((c) => c.trim()).filter(Boolean);
  for (const c of commits) {
    const [h, an, ae, cn, ce, msg] = c.split('\x1f');
    const curto = h.slice(0, 7);
    if (an !== id.nome || ae !== id.email || cn !== id.nome || ce !== id.email) {
      problemas.push(`commit ${curto} de outra pessoa ou outra identidade: ${an} <${ae}> (commit: ${cn} <${ce}>)`);
    }
    for (const a of varrerTexto(msg, termos)) problemas.push(`commit ${curto}, mensagem: ${a.tipo}`);
  }
  return { problemas, commits: commits.length };
}

function argumento(nome) {
  const i = process.argv.indexOf(nome);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function principal() {
  const enviar = process.argv.includes('--enviar');
  const mensagem = argumento('-m');
  const origem = argumento('--origem');
  const temRepo = fs.existsSync(path.join(PASTA, '.git'));
  const listaTermos = fs.existsSync(ARQ_TERMOS) ? lerTermos(fs.readFileSync(ARQ_TERMOS, 'utf8')) : null;
  const problemas = [];

  if (!listaTermos) problemas.push('sem a lista de termos pessoais (envio-termos.txt na raiz): não dá para conferir');
  const termos = listaTermos || { termos: [], ignorar: new Set(), permitir: new Set() };
  if (!temRepo && !origem) problemas.push('a pasta ainda não tem git: na primeira vez, passe --origem <url do repositório>');
  if (temRepo && origem) problemas.push('--origem só serve na primeira vez (a pasta já tem git)');
  if (enviar && !mensagem) problemas.push('falta a mensagem do commit: -m "..."');

  const lista = arquivosQueIriam(temRepo);
  problemas.push(...conferirArquivos(lista, termos));
  const id = identidade(termos, temRepo);
  problemas.push(...id.problemas);
  const cm = temRepo ? conferirCommits(id, termos.termos) : { problemas: [], commits: 0 };
  problemas.push(...cm.problemas);

  console.log(`Pasta: ${PASTA}`);
  console.log(`Arquivos que iriam: ${lista.length}${temRepo ? '' : ' (primeiro envio)'}`);
  console.log(`Identidade: ${id.nome || '?'} <${id.email || '?'}>`);
  if (temRepo) console.log(`Commits ainda não enviados: ${cm.commits}`);
  if (listaTermos) console.log(`Termos conferidos: ${termos.termos.length}${termos.ignorar.size ? `, ${termos.ignorar.size} arquivo(s) fora da busca de termos` : ''}`);
  if (problemas.length) {
    console.log(`\nRecusado: ${problemas.length} problema(s).`);
    for (const p of problemas) console.log('  - ' + p);
    process.exitCode = 1;
    return;
  }
  if (!enviar) {
    console.log('\nTudo limpo. Nada foi mudado (simulação). Para enviar: --enviar -m "mensagem".');
    return;
  }

  const passo = (args, oque) => {
    const r = git(args);
    if (!r.ok) throw new Error(`${oque}: ${r.err || r.out}`);
    return r;
  };
  if (!temRepo) {
    passo(['init', '-q', '-b', RAMO], 'git init');
    passo(['remote', 'add', 'origin', origem], 'remote origin');
    passo(['config', 'user.name', id.nome], 'user.name');
    passo(['config', 'user.email', id.email], 'user.email');
  }
  passo(['add', '-A'], 'git add');
  if (!git(['diff', '--cached', '--quiet']).ok) passo(['commit', '-q', '-m', mensagem], 'git commit');
  // O commit novo também passa pela conferência de identidade e mensagem antes do push.
  const depois = conferirCommits(id, termos.termos);
  if (depois.problemas.length) {
    console.log('\nO commit foi feito, mas o envio parou:');
    for (const p of depois.problemas) console.log('  - ' + p);
    process.exitCode = 1;
    return;
  }
  passo(['push', '-q', '-u', 'origin', RAMO], 'git push');
  console.log(`\nEnviado: ${git(['rev-parse', '--short', 'HEAD']).out} para origin/${RAMO}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    principal();
  } catch (e) {
    console.log('Erro: ' + e.message);
    process.exitCode = 1;
  }
}
