// Orbit — classificador puro de "ação externa" dos escritórios (contrato da Etapa 1, §6 e §11 F1).
//   classificar(tool_name, tool_input, extras, opts) → { externa: boolean, descricao: string }
//   opts: { porta (ORBIT_PORTA, padrão 47821), raiz (raiz do Orbit, padrão a pasta deste arquivo) }
// Ação externa = a que sai da máquina ou publica algo (git push, gh pr create, npm publish, curl/Invoke-RestMethod
// com envio, ssh/scp, deploys, docker push, stripe...), qualquer ferramenta MCP que não seja só de leitura, e,
// como aviso ("Ação externa possível: executa código"), tudo o que roda código que o classificador não enxerga:
// interpretadores com código ou script, npx/dlx, npm run, make, eval, iex, Start-Process, pipe para shell...
// O hook (escritorio-hook.mjs) transforma isso em permissionDecision "ask". Sem dependências, sem E/S.
//
// Como lê o comando: separa em segmentos (; & | quebra de linha, parênteses e chaves) respeitando aspas, tira
// heredocs/here-strings e comentários, e olha o 1º programa de cada segmento (depois de env VAR=x, sudo, time...).
// Texto entre aspas nunca é comando: `git commit -m "git push depois"` não é externa. `$(...)` e `crase` dentro de
// aspas duplas, `bash -c "..."`, `powershell -Command "..."` e `cmd /c ...` são analisados por dentro.
// Exceções: o comando exato `node "<raiz>/membro.mjs" ...` (a CLI do orquestrador) e o envio a 127.0.0.1/localhost
// fora da porta do Orbit. Envio para a porta do Orbit é "API do Orbit" (um agente não pode se liberar sozinho).
// Falha fechada: qualquer exceção interna vira "a trava não conseguiu avaliar" (externa).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAO = Object.freeze({ externa: false, descricao: '' });
const MAX_TEXTO = 20000;
const MAX_PROF = 4;
const PORTA_PADRAO = 47821;
const EXEC = 'executa código';
const exec = (x) => (x ? `${EXEC} (${x})` : EXEC);
// A descrição "executa código..." é um aviso ("Ação externa possível: ..."); as demais são concretas.
export const ehExecucao = (d) => typeof d === 'string' && d.startsWith(EXEC);
export const FALHA_AVALIAR = 'a trava não conseguiu avaliar';

const RAIZ_PADRAO = path.dirname(fileURLToPath(import.meta.url));
const barras = (p) => String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();

const nomeExe = (w) => String(w).replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');

// ── tokenização ──
function limparBlocos(t) {
  return t
    // heredoc: <<EOF / <<'EOF' / <<-EOF ... EOF (o corpo é texto, não comando)
    .replace(/(<<-?[ \t]*(['"]?)(\w+)\2)([^\n]*)\r?\n[\s\S]*?\r?\n[ \t]*\3[ \t]*(?=\r?\n|\)|"|$)/g, '$1$4')
    // here-string do PowerShell: @' ... '@ e @" ... "@
    .replace(/@(['"])[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*\1@/g, '""');
}

function dividir(texto, ps = false) {
  const segs = [];
  const subs = [];
  let toks = [];
  let cur = '';
  let tem = false;
  let q = '';
  const n = texto.length;
  const fimTok = () => { if (tem) toks.push(cur); cur = ''; tem = false; };
  const fimSeg = () => { fimTok(); if (toks.length) segs.push(toks); toks = []; };
  for (let i = 0; i < n; i++) {
    const c = texto[i];
    if (q === "'") {
      if (c === "'") q = ''; else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') { q = ''; continue; }
      const p = texto[i + 1];
      if ((c === '\\' && (p === '"' || p === '\\')) || (ps && c === '`' && p === '"')) { cur += p; i++; continue; }
      if (!ps && c === '`') { // bash: `comando` dentro de aspas duplas também executa
        const j = texto.indexOf('`', i + 1);
        subs.push(texto.slice(i + 1, j < 0 ? n : j));
        i = j < 0 ? n : j;
        continue;
      }
      if (c === '$' && p === '(') {
        let prof = 1;
        let j = i + 2;
        for (; j < n && prof > 0; j++) {
          if (texto[j] === '(') prof++;
          else if (texto[j] === ')') prof--;
        }
        subs.push(texto.slice(i + 2, prof === 0 ? j - 1 : j));
        i = j - 1;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; tem = true; continue; }
    if (!ps && c === '`') {
      const j = texto.indexOf('`', i + 1);
      subs.push(texto.slice(i + 1, j < 0 ? n : j));
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '\\' && (texto[i + 1] === '\n' || (texto[i + 1] === '\r' && texto[i + 2] === '\n'))) { i += texto[i + 1] === '\r' ? 2 : 1; continue; }
    if (c === ' ' || c === '\t') { fimTok(); continue; }
    if (';&|\n\r(){}'.includes(c)) { fimSeg(); continue; }
    if (c === '#' && !tem && cur === '') {
      while (i + 1 < n && texto[i + 1] !== '\n') i++;
      continue;
    }
    cur += c;
    tem = true;
  }
  fimSeg();
  return { segs, subs };
}

// Argumentos que não começam com "-", pulando o valor das opções em `comValor`.
function posicionais(args, comValor = new Set()) {
  const r = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (comValor.has(a)) i++;
      continue;
    }
    r.push(a);
  }
  return r;
}

// ── rede: curl, wget, Invoke-WebRequest/RestMethod ──
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?)$/i;
// { local: todos os hosts são loopback, orbit: algum deles está na porta do Orbit }
function destinos(args, porta) {
  const hosts = [];
  let orbit = false;
  for (const bruto of args) {
    const a = bruto.replace(/^--url=/i, '');
    let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(a);
    if (!m) m = /^(localhost|127(?:\.\d+){3}|\[::1\])(?::(\d+))?(?:[/?#]|$)/i.exec(a);
    if (m) {
      hosts.push(m[1]);
      if (LOOPBACK.test(m[1]) && Number(m[2]) === porta) orbit = true;
    }
  }
  return { local: hosts.length > 0 && hosts.every((h) => LOOPBACK.test(h)), orbit };
}

const METODO_ENVIO = /^(post|put|patch|delete|merge)$/i;
const CURL_COM_VALOR = new Set([...'oHAuembcwxKEzYyrCtTdFX']);

function curlEnvia(args, ps) {
  let get = false;
  let dados = false;
  let metodo = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = (eq < 0 ? a : a.slice(0, eq)).toLowerCase();
      const v = eq < 0 ? undefined : a.slice(eq + 1);
      if (k === '--request') {
        if (v === undefined) { metodo = args[i + 1] || ''; i++; } else metodo = v;
      } else if (k === '--get') get = true;
      else if (/^--(data|data-raw|data-binary|data-ascii|data-urlencode|json|form|form-string|upload-file)$/.test(k)) dados = true;
      continue;
    }
    if (ps) {
      const r = psEnvia(a, args[i + 1]);
      if (r.metodo) metodo = r.metodo;
      if (r.dados) dados = true;
      if (r.consome) i++;
      if (/^-(me|met|meth|metho|method|b|bo|bod|body|infil|infile|form|uri|u|ur|contenttype|ct|headers|h)(:|$)/i.test(a)) continue;
    }
    // aglomerado de opções curtas: -sS, -sXPOST, -d@arq, -fsSLd
    for (let j = 1; j < a.length; j++) {
      const ch = a[j];
      if (ch === 'G') { get = true; continue; }
      if (ch === 'X') {
        const resto = a.slice(j + 1);
        if (resto) metodo = resto; else { metodo = args[i + 1] || ''; i++; }
        break;
      }
      if (ch === 'd' || ch === 'F' || ch === 'T') { dados = true; break; }
      if (CURL_COM_VALOR.has(ch)) { if (j === a.length - 1) i++; break; }
    }
  }
  if (metodo) return METODO_ENVIO.test(metodo);
  return dados && !get;
}

// Opções no estilo PowerShell (-Method Post, -Body, -InFile, -Form), com abreviações e "-Method:Post".
function psEnvia(a, prox) {
  const m = /^-([a-z]+)(?::(.*))?$/i.exec(a);
  if (!m) return {};
  const nome = m[1].toLowerCase();
  const val = m[2] !== undefined ? m[2] : prox;
  const consome = m[2] === undefined;
  if (/^me(t(h(o(d)?)?)?)?$/.test(nome)) return { metodo: String(val || ''), consome };
  if (/^b(o(d(y)?)?)?$/.test(nome) || nome === 'infile' || nome === 'infil' || nome === 'form') return { dados: true, consome };
  return {};
}

function psWebEnvia(args) {
  let metodo = '';
  let dados = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    const r = psEnvia(a, args[i + 1]);
    if (r.metodo !== undefined) metodo = r.metodo;
    if (r.dados) dados = true;
    if (r.consome && (r.metodo !== undefined || r.dados)) i++;
  }
  if (metodo) return METODO_ENVIO.test(metodo);
  return dados; // com -Body/-InFile e sem -Method o PowerShell envia POST
}

function wgetEnvia(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const k = a.split('=')[0].toLowerCase();
    if (/^--(post-data|post-file|body-data|body-file)$/.test(k)) return true;
    if (k === '--method') {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1] || '';
      if (METODO_ENVIO.test(v)) return true;
    }
  }
  return false;
}

// ── git, gh, gerenciadores de pacote ──
// Subcomandos nativos do git. Qualquer outro nome é alias (do .gitconfig ou de `-c alias.x=...`) e pode ser um push.
const GIT_NATIVOS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout ' +
  'cherry cherry-pick clean clone commit commit-tree config count-objects credential describe diff diff-files diff-index diff-tree ' +
  'difftool fetch for-each-ref format-patch fsck gc grep gui help hash-object init log ls-files ls-remote ls-tree maintenance merge ' +
  'merge-base mergetool mv name-rev notes pack-objects prune range-diff rebase reflog remote repack request-pull reset restore ' +
  'rev-list rev-parse revert rm send-email shortlog show show-branch show-ref sparse-checkout stage stash status submodule ' +
  'subtree switch symbolic-ref tag update-index update-ref var verify-pack version whatchanged worktree write-tree lfs push pull mktree replace filter-branch interpret-trailers fast-import fast-export unpack-file verify-commit verify-tag rerere').split(' '));
const GIT_CONFIG_PERIGOSO = /^(alias\.|core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass|gitproxy)|credential\.|sequence\.editor|diff\.external|gpg\.|filter\.|protocol\.|url\.|remote\.|pager\.)/i;
function gitClassifica(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-c' || a === '--config-env') {
      const cfg = args[i + 1] || '';
      if (GIT_CONFIG_PERIGOSO.test(cfg)) return `git ${a} ${cfg.split('=')[0]} (alias/comando via configuração)`;
      i += 2;
      continue;
    }
    if (/^--config-env=/.test(a)) return 'git --config-env (comando via configuração)';
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--exec-path') { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const sub = args[i];
  const resto = args.slice(i + 1);
  if (!sub) return null;
  if (sub === 'push') {
    const seco = resto.some((x) => x === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(x));
    return seco ? null : 'git push';
  }
  if (sub === 'send-email') return 'git send-email';
  if ((sub === 'lfs' || sub === 'subtree') && posicionais(resto)[0] === 'push') return `git ${sub} push`;
  if (!GIT_NATIVOS.has(sub.toLowerCase())) return exec(`git ${sub}: alias ou subcomando desconhecido`);
  return null;
}

const GH_ESCRITA = {
  pr: /^(create|merge|close|reopen|comment|edit|review|ready|update-branch)$/,
  issue: /^(create|close|reopen|comment|edit|delete|transfer|pin|unpin|lock|unlock)$/,
  release: /^(create|delete|edit|upload|delete-asset)$/,
  repo: /^(create|delete|fork|edit|rename|archive|unarchive|sync)$/,
  workflow: /^(run|enable|disable)$/,
  run: /^(rerun|cancel|delete)$/,
  gist: /^(create|edit|delete|rename)$/,
  label: /^(create|edit|delete|clone)$/,
};
function ghClassifica(args) {
  const pos = posicionais(args, new Set(['-R', '--repo', '--hostname']));
  const [grupo, acao] = pos;
  if (grupo === 'api') {
    let metodo = '';
    let campos = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const k = a.split('=')[0];
      if (k === '-X' || k === '--method') metodo = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1] || '';
      else if (/^-X./.test(a)) metodo = a.slice(2);
      else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(k)) campos = true;
    }
    if (metodo) return METODO_ENVIO.test(metodo) ? `gh api ${metodo.toUpperCase()}` : null;
    return campos ? 'gh api (envio)' : null;
  }
  if (GH_ESCRITA[grupo] && acao && GH_ESCRITA[grupo].test(acao)) return `gh ${grupo} ${acao}`;
  return null;
}

const PM_COM_VALOR = new Set(['--prefix', '--registry', '--workspace', '-w', '--filter', '-F', '--tag', '--cache', '--userconfig', '--otp', '--access', '--cwd', '-C', '--dir']);
// Ferramentas de desenvolvimento que o npx/dlx pode chamar sem rótulo.
const NPX_SEGURO = /^(tsc|eslint|prettier|jest|vitest|mocha|stylelint)$/;

// npx / bunx / pnpm dlx / yarn dlx / npm exec: baixa e roda um pacote. Se o pacote é um CLI que o classificador
// conhece (vercel...), vale a descrição concreta; as ferramentas de desenvolvimento comuns passam sem rótulo.
function npxClassifica(nome, args, ctx, prof) {
  if (args.some((a) => /^(-p|--package|-c|--call)(=|$)/.test(a))) return exec(`${nome} com pacote ou comando explícito`);
  const pos = posicionais(args, new Set(['--registry', '--cache', '--userconfig', '--node-arg', '-n']));
  if (!pos.length) return null;
  const pacote = pos[0].replace(/(?<=.)@[^@/]*$/, '');
  if (NPX_SEGURO.test(pacote.replace(/^.*\//, '')) && !pacote.startsWith('@')) return null;
  const k = args.indexOf(pos[0]);
  const d = classificarSegmento([pacote, ...args.slice(k + 1)], ctx, prof + 1);
  if (d && !ehExecucao(d)) return d;
  return exec(`${nome} ${pacote}`);
}

function pacoteClassifica(cmd, args, ctx, prof) {
  const pos = posicionais(args, PM_COM_VALOR);
  let i = 0;
  if (cmd === 'yarn' && pos[0] === 'npm') i = 1;
  const p0 = pos[i];
  if (p0 === 'publish' || p0 === 'unpublish' || p0 === 'deprecate') return `${cmd} ${p0}`;
  if (p0 === 'dist-tag' && /^(add|rm|remove|set)$/.test(pos[i + 1] || '')) return `${cmd} dist-tag`;
  if (!p0 || i) return null;
  if (cmd === 'bun') {
    if (/^(install|i|add|a|remove|rm|update|upgrade|pm|outdated|link|unlink|patch|test|build|init|why)$/.test(p0)) return null;
    if (p0 === 'x') return npxClassifica('bun x', args.slice(args.indexOf(p0) + 1), ctx, prof);
    return exec(`bun ${p0}`);
  }
  if (/^(run|run-script|rum|urn|start-script)$/.test(p0)) return exec(`${cmd} run`);
  if (/^(exec|dlx|x)$/.test(p0)) return npxClassifica(`${cmd} ${p0}`, args.slice(args.indexOf(p0) + 1), ctx, prof);
  if (p0 === 'create' || (p0 === 'init' && pos[1])) return exec(`${cmd} ${p0}`);
  return null;
}

function dockerClassifica(cmd, args) {
  const pos = posicionais(args, new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '-f', '--file', '-p', '--project-name', '--profile']));
  if (pos[0] === 'push') return `${cmd} push`;
  if (/^(image|manifest|compose)$/.test(pos[0] || '') && pos[1] === 'push') return `${cmd} ${pos[0]} push`;
  if (/^(build|buildx|bake)$/.test(pos[0] || '') && args.some((a) => a === '--push' || a === '--push=true')) return `${cmd} ${pos[0]} --push`;
  return null;
}

const VERCEL_SEM_DEPLOY = /^(ls|list|whoami|logs|inspect|login|logout|help|pull|link|unlink|dev|build|switch|teams|project|projects|bisect|curl|open|telemetry|cache|git|install|init|httpstat|upgrade|target|activity|blob|flags|integration|mcp)$/;
function vercelClassifica(args) {
  if (args.some((a) => /^(--help|-h|--version|-v|-V)$/.test(a))) return null;
  const pos = posicionais(args, new Set(['--cwd', '--scope', '-S', '--token', '-t', '--local-config', '-A', '--global-config', '-Q', '--target', '-e', '--env', '-b', '--build-env', '-m', '--meta']));
  const p0 = pos[0];
  if (p0 === 'env') return /^(add|rm|remove|update)$/.test(pos[1] || '') ? 'vercel env' : null;
  if (p0 && VERCEL_SEM_DEPLOY.test(p0)) return null;
  return p0 ? `vercel ${p0}` : 'vercel deploy';
}

const STRIPE_SEM_ESCRITA = /^(listen|logs|login|logout|config|version|help|status|open|completion|samples|community|feedback|projects|get)$/;
function stripeClassifica(args) {
  if (args.some((a) => /^(--help|-h|--version|-v)$/.test(a))) return null;
  const pos = posicionais(args, new Set(['--api-key', '--project-name', '--config', '--device-name', '--log-level', '-p']));
  if (pos[0] && STRIPE_SEM_ESCRITA.test(pos[0])) return null;
  if (pos[1] && /^(list|retrieve|search|get)$/.test(pos[1])) return null;
  return 'stripe';
}

// ── interpretadores: node, python, deno... rodam código que o classificador não enxerga ──
const INTERP_AJUDA = /^(-v|-V|--version|-h|--help|-\?)$/;
const PY_MODULO_SEGURO = /^(pytest|unittest|pip|pip3|venv|ensurepip|black|ruff|mypy|flake8|isort|pylint|coverage|compileall)$/;
const INTERPRETES = /^(node|nodejs|python[\d.]*|py|pythonw|pypy3?|ruby|perl|php|lua|luajit|rscript|tsx|ts-node|esno|babel-node|osascript|cscript|wscript|mshta|deno)$/;
function interpClassifica(cmd, args, ctx) {
  if (INTERP_AJUDA.test(args[0] || '')) return null;
  if (cmd.startsWith('node')) {
    if (/^(-c|--check)$/.test(args[0] || '')) return null;
    if (args[0] && ctx.membro && barras(args[0]) === ctx.membro) return null; // a CLI do orquestrador
  } else if (cmd === 'deno') {
    if (/^(fmt|lint|check|info|doc|help|--version)$/.test(args[0] || '')) return null;
  } else if (/^(python|py|pypy)/.test(cmd)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '-m' || /^-m./.test(a)) {
        const mod = a === '-m' ? args[k + 1] || '' : a.slice(2);
        if (PY_MODULO_SEGURO.test(mod)) return null;
        break;
      }
      if (!a.startsWith('-')) break;
    }
  }
  return exec(cmd);
}

// ── segmento ──
const PREFIXOS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time', 'nohup', 'command', 'exec', 'builtin', 'call', '&']);
const COM_VALOR_WRAPPER = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
};

const REMOTO_RSYNC = /^(?:[\w.+-]+@)?[A-Za-z0-9_.-]{2,}::?/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash']);
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|vbs|wsf)$/i;
const XARGS_COM_VALOR = new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-E', '-s', '-a', '-l', '--max-args', '--max-procs', '--delimiter', '--max-lines', '--eof', '--arg-file', '--replace']);

function classificarSegmento(t, ctx, prof) {
  let i = 0;
  while (i < t.length) {
    const w = t[i];
    const b = nomeExe(w);
    if (/^[A-Za-z_]\w*=/.test(w) || PREFIXOS.has(b)) { i++; continue; }
    if (/^\$[\w:]+$/.test(w) && /^[-+*/]?=$/.test(t[i + 1] || '')) { i += 2; continue; } // PowerShell: $r = comando
    if (COM_VALOR_WRAPPER[b]) {
      i++;
      while (i < t.length && (t[i].startsWith('-') || /^[A-Za-z_]\w*=/.test(t[i]))) i += COM_VALOR_WRAPPER[b].has(t[i]) ? 2 : 1;
      continue;
    }
    if (b === 'timeout') {
      i++;
      while (i < t.length && (t[i].startsWith('-') || /^\d+[smhd]?$/.test(t[i]))) i++;
      continue;
    }
    break;
  }
  if (i >= t.length) return null;
  const cmd = nomeExe(t[i]);
  const args = t.slice(i + 1);

  switch (cmd) {
    case 'git': return gitClassifica(args);
    case 'gh': return ghClassifica(args);
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return pacoteClassifica(cmd, args, ctx, prof);
    case 'npx': case 'pnpx': case 'bunx': return npxClassifica(cmd, args, ctx, prof);
    case 'uvx': return exec('uvx');
    case 'pipx': return posicionais(args)[0] === 'run' ? exec('pipx run') : null;
    case 'uv': return posicionais(args)[0] === 'run' ? exec('uv run') : null;
    case 'make': case 'gmake': case 'nmake': case 'mingw32-make': return exec('make');
    case 'cargo': return posicionais(args)[0] === 'publish' ? 'cargo publish' : null;
    case 'poetry': return posicionais(args)[0] === 'publish' ? 'poetry publish' : null;
    case 'twine': return posicionais(args)[0] === 'upload' ? 'twine upload' : null;
    case 'gem': return posicionais(args)[0] === 'push' ? 'gem push' : null;
    case 'vsce': case 'ovsx': return posicionais(args)[0] === 'publish' ? `${cmd} publish` : null;
    case 'dotnet': { const p = posicionais(args); return p[0] === 'nuget' && p[1] === 'push' ? 'dotnet nuget push' : null; }
    case 'curl': case 'wget': case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm': {
      const ps = cmd === 'invoke-webrequest' || cmd === 'iwr' || cmd === 'invoke-restmethod' || cmd === 'irm';
      const envia = cmd === 'wget' ? wgetEnvia(args) : ps ? psWebEnvia(args) : curlEnvia(args, ctx.ps);
      if (!envia) return null;
      const dest = destinos(args, ctx.porta);
      if (dest.local) return dest.orbit ? 'API do Orbit' : null;
      return ps ? `${t[i]} com envio` : `${cmd} com envio`;
    }
    case 'ssh': case 'scp': case 'sftp': case 'ftp': case 'plink': case 'pscp':
    case 'enter-pssession': case 'new-pssession':
      return cmd;
    case 'rsync':
      return args.some((a) => !a.startsWith('-') && REMOTO_RSYNC.test(a)) ? 'rsync remoto' : null;
    case 'sendmail': case 'mail': case 'mailx': case 'mutt': case 'msmtp': case 'send-mailmessage':
      return cmd;
    case 'vercel': return vercelClassifica(args);
    case 'netlify': return posicionais(args)[0] === 'deploy' ? 'netlify deploy' : null;
    case 'firebase': return /(^|:)deploy$/.test(posicionais(args)[0] || '') ? 'firebase deploy' : null;
    case 'fly': case 'flyctl': return posicionais(args)[0] === 'deploy' ? `${cmd} deploy` : null;
    case 'wrangler': return posicionais(args).some((p) => p === 'deploy' || p === 'publish') ? 'wrangler deploy' : null;
    case 'docker': case 'podman': return dockerClassifica(cmd, args);
    case 'stripe': return stripeClassifica(args);
    case 'wsl': {
      const r = args.filter((a) => a !== '-e' && a !== '--exec' && a !== '--');
      return r.length ? classificarTexto(r.map(citar).join(' '), ctx, prof + 1) : null;
    }
    case 'cmd': {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
      return k >= 0 ? classificarTexto(args.slice(k + 1).join(' '), ctx, prof + 1) : null;
    }
    case 'powershell': case 'pwsh': {
      const kc = args.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a));
      const enc = args.some((a) => /^-(e|ec|en\w*)$/i.test(a));
      const arq = args.some((a) => /^-f(i(l(e)?)?)?$/i.test(a));
      let r = null;
      if (kc >= 0) {
        const resto = args.slice(kc + 1);
        r = resto.length === 1 && resto[0] === '-' ? exec(`${cmd} -Command - (lê do stdin)`) : classificarTexto(resto.join(' '), { ...ctx, ps: true }, prof + 1);
      }
      if (r && !ehExecucao(r)) return r;
      if (enc) return exec(`${cmd} -EncodedCommand`);
      if (arq) return exec(`${cmd} -File`);
      if (kc < 0 && !INTERP_AJUDA.test(args[0] || '')) return exec(`${cmd} com script ou stdin`);
      return r;
    }
    case 'eval': {
      const d = classificarTexto(args.join(' '), ctx, prof + 1);
      return d && !ehExecucao(d) ? d : exec('eval');
    }
    case 'source': case '.': return exec(cmd);
    case 'iex': case 'invoke-expression': return exec('Invoke-Expression');
    case 'start-process': case 'saps': case 'start': case 'invoke-command': case 'icm': case 'start-job': case 'start-threadjob':
      return exec(t[i]);
    case 'new-object':
      return args.some((a) => /webclient|httpclient|tcpclient|net\.sockets|websocket/i.test(a)) ? exec('.NET de rede') : null;
    case 'xargs': {
      let k = 0;
      while (k < args.length && args[k].startsWith('-')) k += XARGS_COM_VALOR.has(args[k]) ? 2 : 1;
      return k < args.length ? classificarSegmento(args.slice(k), ctx, prof + 1) : null;
    }
    case 'find': {
      const k = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
      return k >= 0 && k + 1 < args.length ? classificarSegmento(args.slice(k + 1), ctx, prof + 1) : null;
    }
    default:
      if (SHELLS.has(cmd)) {
        const k = args.findIndex((a) => /^-[a-z]*c$/.test(a));
        if (k >= 0) return args[k + 1] ? classificarTexto(args[k + 1], { ...ctx, ps: false }, prof + 1) : null;
        return INTERP_AJUDA.test(args[0] || '') ? null : exec(`${cmd} com script ou stdin`);
      }
      if (INTERPRETES.test(cmd)) return interpClassifica(cmd, args, ctx);
      if (/^\[.*(webclient|httpclient)/i.test(t[i])) return exec('.NET de rede');
      if (!ctx.ps && /^\$(\w|$)/.test(t[i])) return exec('comando em variável');
      if (/^(\.{1,2}|~)[\\/]/.test(t[i]) || SCRIPT_EXT.test(t[i])) return exec('script');
      return null;
  }
}

const citar = (s) => (/\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

// Descrição concreta tem prioridade sobre o aviso genérico de "executa código".
function classificarTexto(texto, ctx, prof) {
  if (typeof texto !== 'string' || !texto.trim()) return null;
  if (prof > MAX_PROF) return exec('aninhamento profundo demais');
  const { segs, subs } = dividir(limparBlocos(texto), ctx.ps);
  let aviso = null;
  for (const t of segs) {
    const d = classificarSegmento(t, ctx, prof);
    if (!d) continue;
    if (!ehExecucao(d)) return d;
    aviso = aviso || d;
  }
  for (const s of subs) {
    const d = classificarTexto(s, ctx, prof + 1);
    if (!d) continue;
    if (!ehExecucao(d)) return d;
    aviso = aviso || d;
  }
  return aviso;
}

// ── MCP ──
const LEITURA = new Set(['get', 'list', 'read', 'search', 'query', 'fetch', 'view', 'describe', 'inspect', 'status', 'balance', 'explore', 'show']);
const ESCRITA = new Set(['create', 'write', 'update', 'delete', 'remove', 'send', 'post', 'put', 'patch', 'set', 'add', 'publish', 'deploy', 'upload', 'run', 'execute', 'merge', 'push', 'move', 'rename', 'edit', 'save', 'destroy', 'drop', 'replace', 'generate']);
const SQL_ESCRITA = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|merge|upsert|exec|execute|call|vacuum|copy|attach)\b/i;
const SQL_INICIO = /(^|;)\s*(\(?\s*with\b[\s\S]*?\b)?(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|merge|upsert|exec|execute|call)\b/i;

function palavras(nome) {
  return nome
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Entrada de uma ferramenta "de leitura" que na verdade escreve: method, sql, body.
function entradaMcpEscreve(entrada) {
  if (!entrada || typeof entrada !== 'object') return '';
  const m = typeof entrada.method === 'string' ? entrada.method : typeof entrada.http_method === 'string' ? entrada.http_method : '';
  if (m) return METODO_ENVIO.test(m.trim()) ? `method ${m.trim().toUpperCase()}` : '';
  for (const k of ['sql', 'statement', 'statements']) {
    const v = entrada[k];
    const txt = Array.isArray(v) ? v.join(';') : v;
    if (typeof txt === 'string' && SQL_ESCRITA.test(txt)) return `${k} de escrita`;
  }
  for (const k of ['query', 'command']) {
    if (typeof entrada[k] === 'string' && SQL_INICIO.test(entrada[k])) return `${k} de escrita`;
  }
  for (const k of ['body', 'data', 'json', 'payload']) {
    const v = entrada[k];
    if (v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && !Object.keys(v).length)) return `${k} enviado`;
  }
  return '';
}

function classificarMcp(toolName, entrada) {
  const partes = toolName.split('__');
  const servidor = partes[1] || '?';
  const ferramenta = partes.slice(2).join('_') || toolName;
  const ws = palavras(ferramenta);
  const leitura = ws.some((w) => LEITURA.has(w)) && !ws.some((w) => ESCRITA.has(w));
  if (leitura) {
    const motivo = entradaMcpEscreve(entrada);
    if (!motivo) return NAO;
    return { externa: true, descricao: `ferramenta MCP ${servidor}/${ferramenta} (${motivo})` };
  }
  return { externa: true, descricao: `ferramenta MCP ${servidor}/${ferramenta}` };
}

// ── gravação nos arquivos que sustentam a trava ──
function classificarEscrita(entrada) {
  const bruto = [entrada?.file_path, entrada?.notebook_path, entrada?.path].find((x) => typeof x === 'string' && x);
  if (!bruto) return NAO;
  const p = path.posix.normalize(String(bruto).replace(/\\/g, '/')).toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/(^|\/)\.claude\/settings[^/]*$/.test(p) || base === '.mcp.json' || /^escritorio-.*\.mjs$/.test(base) || base === 'membro.mjs') {
    return { externa: true, descricao: `altera a configuração da trava (${base})` };
  }
  return NAO;
}

// ── API ──
const SHELL_TOOL = /^(bash|powershell|monitor)$/i;
const ESCRITA_TOOL = /^(write|edit|multiedit|notebookedit)$/i;
export const ehFerramentaDeEscrita = (nome) => ESCRITA_TOOL.test(String(nome || ''));
export const ehFerramentaDeShell = (nome) => SHELL_TOOL.test(String(nome || ''));

// Extras: texto literal, sem regex (sem ReDoS), sem diferenciar maiúsculas nem espaços repetidos.
const compacto = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
function extraCasa(cmd, extras) {
  if (!Array.isArray(extras)) return '';
  const alvo = compacto(cmd);
  for (const x of extras) {
    if (typeof x !== 'string' || !x || x.length > 200) continue;
    const lit = compacto(x);
    if (lit && alvo.includes(lit)) return x;
  }
  return '';
}

export function classificar(toolName, toolInput, extras = [], opts = {}) {
  try {
    const nome = String(toolName || '');
    if (/^mcp__/i.test(nome)) return classificarMcp(nome, toolInput);
    if (ESCRITA_TOOL.test(nome)) return classificarEscrita(toolInput);
    if (!SHELL_TOOL.test(nome)) return NAO;
    const ps = /^powershell$/i.test(nome);
    const cmd = typeof toolInput?.command === 'string' ? toolInput.command.slice(0, MAX_TEXTO) : '';
    if (!cmd.trim()) return NAO;
    const ctx = {
      ps,
      porta: Number(opts?.porta) || PORTA_PADRAO,
      membro: `${barras(opts?.raiz || RAIZ_PADRAO)}/membro.mjs`,
    };
    const d = classificarTexto(cmd, ctx, 0);
    if (d && !ehExecucao(d)) return { externa: true, descricao: d };
    const x = extraCasa(cmd, extras);
    if (x) return { externa: true, descricao: `padrão extra "${x.length > 40 ? x.slice(0, 40) + '…' : x}"` };
    if (d) return { externa: true, descricao: d };
    return NAO;
  } catch {
    return { externa: true, descricao: FALHA_AVALIAR };
  }
}
