// Orbit — ponte com o Tailscale (recurso "Orbit no celular"): detecta se está instalado e logado, e liga/desliga o
// `tailscale serve` (só tailnet, HTTPS 443 -> 127.0.0.1:<porta remota>; nunca Funnel).
//   const ts = await detectar();       // { instalado, logado, host, dono, serve }
//   await ligarServe(47820);           // { ok, erro? }
//   await desligarServe();             // { ok, erro? }
// Só `execFile` (sem shell) com prazo de ~8 s. Nada aqui lança: Tailscale ausente, deslogado, parado ou travado
// vira um resultado. Os testes injetam o executor: criarTailscale({ executar, so }).
//
// Campos usados da CLI (tailscale status --json): BackendState ("Running" | "NeedsLogin" | "Stopped" | "NoState" | ...),
// Self.DNSName ("pc.tailnet.ts.net." com ponto final), Self.UserID e User[<UserID>].LoginName.
// tailscale serve status --json: { TCP: { "443": { HTTPS: true } }, Web: { "pc.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47820" } } } } }; vazio = {}.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MS_CLI = 8000;
const MAX_SAIDA = 4 * 1024 * 1024;

const CAMINHOS = {
  // Caminho absoluto primeiro; o nome nu só pelo PATH, sem o cwd (revisão P2-7: nada de tailscale.exe plantado na pasta).
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'],
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'],
};

// Executor padrão: { codigo, saida, erro, ausente }. `ausente` = o executável não existe (ENOENT/EACCES);
// codigo null = prazo estourado ou falha ao iniciar. Nunca rejeita.
// Nome nu (sem barra) → caminho absoluto achado no PATH, só em diretórios absolutos e fora do cwd (no Windows o
// execFile procuraria primeiro no cwd). null = não achou.
export function acharNoPath(nome, { so = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const mod = so === 'win32' ? path.win32 : path.posix;
  const nomes = so === 'win32' && !/\.exe$/i.test(nome) ? [nome + '.exe'] : [nome];
  const norm = (d) => (so === 'win32' ? mod.resolve(d).toLowerCase() : mod.resolve(d));
  const aqui = norm(cwd);
  const chave = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  for (const bruto of String(env[chave] || '').split(so === 'win32' ? ';' : ':')) {
    const d = bruto.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !mod.isAbsolute(d) || norm(d) === aqui) continue;
    for (const n of nomes) {
      const c = mod.join(d, n);
      try { if (fs.statSync(c).isFile()) return c; } catch {}
    }
  }
  return null;
}

export function executarCli(exe, args, { prazo = MS_CLI } = {}) {
  if (!/[\\/]/.test(exe)) {
    const achado = acharNoPath(exe);
    if (!achado) return Promise.resolve({ codigo: null, saida: '', erro: '', ausente: true });
    exe = achado;
  }
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: prazo, windowsHide: true, maxBuffer: MAX_SAIDA, encoding: 'utf8' }, (err, saida, erro) => {
      if (!err) return resolve({ codigo: 0, saida: String(saida || ''), erro: String(erro || ''), ausente: false });
      const ausente = err.code === 'ENOENT' || err.code === 'EACCES';
      resolve({
        codigo: typeof err.code === 'number' ? err.code : null,
        saida: String(saida || err.stdout || ''),
        erro: String(erro || err.stderr || '') || (err.killed ? 'tempo esgotado' : String(err.message || '')),
        ausente,
      });
    });
  });
}

const json = (txt) => { try { const o = JSON.parse(txt); return o && typeof o === 'object' ? o : null; } catch { return null; } };
const curto = (s, n = 300) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

export function criarTailscale({ executar = executarCli, so = process.platform } = {}) {
  const candidatos = CAMINHOS[so] || ['tailscale'];

  // Roda a CLI no primeiro executável que existir. null = Tailscale não instalado.
  async function rodar(args) {
    for (const exe of candidatos) {
      let r;
      try { r = await executar(exe, args); } catch (e) { r = { codigo: null, saida: '', erro: String(e?.message || e), ausente: e?.code === 'ENOENT' }; }
      if (r && !r.ausente) return r;
    }
    return null;
  }

  async function detectar(porta) {
    const vazio = { instalado: false, logado: false, host: '', dono: '', serve: false };
    const st = await rodar(['status', '--json']);
    if (!st) return vazio;
    const info = { ...vazio, instalado: true };
    const s = json(st.saida); // com NeedsLogin/Stopped a CLI ainda manda o JSON (às vezes com código != 0)
    if (!s) return info;
    info.logado = s.BackendState === 'Running';
    if (!info.logado) return info;
    const eu = s.Self || {};
    info.host = String(eu.DNSName || '').replace(/\.+$/, '');
    const usuario = s.User && eu.UserID != null ? s.User[String(eu.UserID)] : null;
    info.dono = String(usuario?.LoginName || '');
    const sv = await rodar(['serve', 'status', '--json']);
    info.serve = !!sv && temServe(json(sv.saida), porta);
    return info;
  }

  // Há um proxy HTTPS na 443 (e, se `porta` vier, apontando para 127.0.0.1:<porta>).
  function temServe(o, porta) {
    const web = o?.Web;
    if (!web || typeof web !== 'object') return false;
    for (const [chave, v] of Object.entries(web)) {
      if (!/:443$/.test(chave)) continue;
      for (const h of Object.values(v?.Handlers || {})) {
        const alvo = String(h?.Proxy || '');
        if (!alvo) continue;
        if (porta == null || new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${Number(porta)}/?$`).test(alvo)) return true;
      }
    }
    return false;
  }

  async function comando(args) {
    const r = await rodar(args);
    if (!r) return { ok: false, erro: 'Tailscale não está instalado' };
    if (r.codigo === 0) return { ok: true };
    return { ok: false, erro: curto(r.erro || r.saida) || `tailscale saiu com ${r.codigo}` };
  }

  async function ligarServe(porta) {
    const p = Number(porta);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, erro: 'porta inválida' };
    return comando(['serve', '--bg', '--https=443', `http://127.0.0.1:${p}`]);
  }

  const desligarServe = () => comando(['serve', '--https=443', 'off']);

  return { detectar, ligarServe, desligarServe };
}

const padrao = criarTailscale();
export const detectar = padrao.detectar;
export const ligarServe = padrao.ligarServe;
export const desligarServe = padrao.desligarServe;
