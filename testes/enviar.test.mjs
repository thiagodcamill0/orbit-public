// Testes do script de envio (ferramentas/enviar.mjs): a lista de termos, a varredura e o envio de verdade para
// um repositório local (bare) numa pasta temporária. Não usa rede nem o git desta pasta.
// Rodar: node testes/enviar.test.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerTermos, varrerTexto } from '../ferramentas/enviar.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let oks = 0;
let falhas = 0;
function conferir(cond, nome, info = '') {
  if (cond) { oks++; console.log('  ok  ' + nome); } else { falhas++; console.log('  FALHA  ' + nome + (info ? ' — ' + info : '')); }
}

// Os segredos de exemplo são montados aqui para este arquivo não ter nenhum (o próprio envio o varre).
const FALSOS = {
  github: 'gh' + 'p_' + 'a1B2'.repeat(9),
  pat: 'github' + '_pat_' + 'x'.repeat(60),
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'y'.repeat(30),
  privada: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
};

console.log('termos e varredura');
const t = lerTermos('# comentário\nFulano\n\n  alguem@  \nignorar: docs\\RECEITA.md\n');
conferir(t.termos.join(',') === 'fulano,alguem@' && t.ignorar.has('docs/RECEITA.md'), 'lerTermos: termos em minúsculas, comentário e ignorar', JSON.stringify([t.termos, [...t.ignorar]]));
conferir(varrerTexto('linha do FULANO aqui', ['fulano']).length === 1, 'termo sem diferença de maiúscula');
for (const [k, v] of Object.entries(FALSOS)) {
  const a = varrerTexto(`const x = "${v}";`, []);
  conferir(a.length === 1 && !JSON.stringify(a).includes(v), `segredo achado e omitido (${k})`, JSON.stringify(a));
}
conferir(varrerTexto("placeholder: 'github_pat_…'", []).length === 0, 'o exemplo "github_pat_…" da tela não é segredo');

// ---------- envio de verdade numa pasta temporária ----------
console.log('envio para um repositório local');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-enviar-'));
const proj = path.join(tmp, 'copia');
const remoto = path.join(tmp, 'remoto.git');
const git = (args, cwd = proj) => spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
const enviar = (...args) => {
  const r = spawnSync(process.execPath, [path.join(proj, 'ferramentas', 'enviar.mjs'), ...args], { cwd: proj, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
try {
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  fs.mkdirSync(path.join(proj, 'ferramentas'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'ferramentas', 'enviar.mjs'), path.join(proj, 'ferramentas', 'enviar.mjs'));
  fs.writeFileSync(path.join(proj, '.gitignore'), '/envio-termos.txt\n/dados/\n');
  fs.writeFileSync(path.join(proj, 'envio-termos.txt'), 'fulano\nignorar: LISTA.md\n');
  fs.writeFileSync(path.join(proj, 'app.mjs'), 'export const autor = "Fulano";\n');
  fs.writeFileSync(path.join(proj, 'LISTA.md'), 'Fora da cópia: as notas do fulano.\n');
  fs.mkdirSync(path.join(proj, 'dados'));
  fs.writeFileSync(path.join(proj, 'dados', 'segredo.txt'), FALSOS.github);
  git(['init', '-q', '--bare', '-b', 'main', remoto], tmp);
  const primeira = ['--origem', remoto, '--nome', 'Mantenedor', '--email', 'mantenedor@exemplo.invalid'];

  let r = enviar(...primeira);
  conferir(r.status === 1 && /app\.mjs:1: termo "fulano"/.test(r.out), 'termo num arquivo recusa', r.out);
  conferir(!/LISTA\.md/.test(r.out), '"ignorar:" tira o arquivo da busca de termos', r.out);
  conferir(!/segredo\.txt/.test(r.out), 'arquivo do .gitignore fica fora', r.out);
  conferir(!fs.existsSync(path.join(proj, '.git')), 'a simulação não cria o git');

  fs.writeFileSync(path.join(proj, 'app.mjs'), `export const k = "${FALSOS.anthropic}";\n`);
  r = enviar(...primeira);
  conferir(r.status === 1 && /app\.mjs:1: chave da Anthropic/.test(r.out) && !r.out.includes(FALSOS.anthropic), 'segredo recusa, sem aparecer na saída', r.out);

  fs.writeFileSync(path.join(proj, 'app.mjs'), 'export const autor = "usuario";\n');
  fs.writeFileSync(path.join(proj, 'claude.exe'), 'MZ');
  r = enviar(...primeira);
  conferir(r.status === 1 && /claude\.exe: binário/.test(r.out), 'binário recusa', r.out);
  fs.rmSync(path.join(proj, 'claude.exe'));

  r = enviar('--origem', remoto, '--nome', 'Fulano', '--email', 'f@exemplo.invalid');
  conferir(r.status === 1 && /identidade do git .*termo "fulano"/.test(r.out), 'identidade com termo pessoal recusa', r.out);
  r = enviar('--origem', remoto);
  conferir(r.status === 1 && /passe --nome/.test(r.out), 'primeira vez sem identidade recusa', r.out);
  fs.appendFileSync(path.join(proj, 'envio-termos.txt'), 'permitir: 1+Fulano@users.noreply.github.com\n');
  r = enviar('--origem', remoto, '--nome', 'Orbit', '--email', '1+fulano@users.noreply.github.com');
  conferir(r.status === 0 && /Tudo limpo/.test(r.out), '"permitir:" aceita o e-mail noreply com o nome da conta', r.out);
  r = enviar('--origem', remoto, '--nome', 'Orbit', '--email', 'fulano@exemplo.invalid');
  conferir(r.status === 1 && /identidade do git .*termo "fulano"/.test(r.out), '"permitir:" vale só para o texto exato', r.out);
  fs.writeFileSync(path.join(proj, 'envio-termos.txt'), 'fulano\nignorar: LISTA.md\n');

  r = enviar(...primeira);
  conferir(r.status === 0 && /Tudo limpo/.test(r.out) && /Arquivos que iriam: 4 \(primeiro envio\)/.test(r.out), 'tudo limpo na simulação (4 arquivos)', r.out);
  r = enviar(...primeira, '--enviar');
  conferir(r.status === 1 && /falta a mensagem/.test(r.out) && !fs.existsSync(path.join(proj, '.git')), 'enviar sem mensagem recusa antes de criar o git', r.out);
  r = enviar(...primeira, '--enviar', '-m', 'Primeira versão');
  const noRemoto = git(['log', '--format=%an <%ae> %s', 'main'], remoto).stdout.trim();
  conferir(r.status === 0 && /Enviado:/.test(r.out) && noRemoto === 'Mantenedor <mantenedor@exemplo.invalid> Primeira versão', 'primeiro envio: git init, identidade local, commit e push', r.out + ' | ' + noRemoto);
  const noArvore = git(['ls-tree', '-r', '--name-only', 'main'], remoto).stdout.trim().split('\n').sort().join(',');
  conferir(noArvore === '.gitignore,LISTA.md,app.mjs,ferramentas/enviar.mjs', 'só os arquivos certos no remoto', noArvore);

  r = enviar('--origem', remoto);
  conferir(r.status === 1 && /só serve na primeira vez/.test(r.out), '--origem com o git já criado recusa', r.out);

  fs.writeFileSync(path.join(proj, 'app.mjs'), 'export const v = 2;\n');
  git(['add', '-A']);
  git(['-c', 'user.name=Outra Pessoa', '-c', 'user.email=outra@exemplo.invalid', 'commit', '-q', '-m', 'mudança alheia']);
  r = enviar('--enviar', '-m', 'x');
  conferir(r.status === 1 && /de outra pessoa ou outra identidade: Outra Pessoa/.test(r.out), 'commit de outra pessoa recusa', r.out);
  git(['reset', '-q', '--soft', 'HEAD~1']);
  git(['commit', '-q', '-m', 'versão 2 do fulano']);
  r = enviar('--enviar', '-m', 'x');
  conferir(r.status === 1 && /mensagem: termo "fulano"/.test(r.out), 'termo na mensagem de um commit recusa', r.out);
  git(['commit', '-q', '--amend', '-m', 'versão 2']);
  r = enviar('--enviar', '-m', 'x');
  conferir(r.status === 0 && /Enviado:/.test(r.out) && git(['rev-list', '--count', 'main'], remoto).stdout.trim() === '2', 'segundo envio com o commit já feito', r.out);

  // Outro clone envia antes: o remoto fica na frente e o envio recusa (nunca --force).
  const outro = path.join(tmp, 'outro');
  git(['clone', '-q', remoto, outro], tmp);
  fs.writeFileSync(path.join(outro, 'novo.txt'), 'oi\n');
  git(['add', '-A'], outro);
  git(['-c', 'user.name=Mantenedor', '-c', 'user.email=mantenedor@exemplo.invalid', 'commit', '-q', '-m', 'do outro clone'], outro);
  git(['push', '-q', 'origin', 'main'], outro);
  fs.writeFileSync(path.join(proj, 'app.mjs'), 'export const v = 3;\n');
  r = enviar('--enviar', '-m', 'versão 3');
  conferir(r.status === 1 && /o remoto tem 1 commit\(s\) que não estão aqui/.test(r.out), 'remoto na frente recusa (git pull antes)', r.out);
  conferir(git(['rev-list', '--count', 'main'], remoto).stdout.trim() === '3', 'o remoto continua igual');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${oks} ok / ${falhas} falhas`);
process.exitCode = falhas ? 1 : 0;
