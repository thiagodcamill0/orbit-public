// Orbit — localiza o codex.exe (Codex da OpenAI) sem nunca executá-lo: só readdir/stat.
// Ordem: ORBIT_CODEX_EXE (testes) > caminho manual das Configurações > automático.
// Automático (Windows): %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe. O hash muda a cada
// atualização e há pastas sem codex.exe (ex.: só rg.exe): vale a pasta com o codex.exe mais recente.
// Mac fica para depois.

import nodeFs from 'node:fs';
import path from 'node:path';

const CACHE_MS = 30_000;
let cache = null; // { chave, quando, auto }

// Limpa o cache do automático (testes e botão "procurar de novo").
export function limparCacheCodex() {
  cache = null;
}

function varrer(localAppData, fs) {
  const base = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let nomes;
  try {
    nomes = fs.readdirSync(base);
  } catch {
    return null;
  }
  let melhor = null;
  for (const nome of nomes) {
    const exe = path.win32.join(base, nome, 'codex.exe');
    let st;
    try {
      st = fs.statSync(exe);
    } catch {
      continue; // pasta sem codex.exe
    }
    if (!st.isFile()) continue;
    if (!melhor || st.mtimeMs > melhor.mtimeMs) melhor = { exe, versaoPasta: nome, mtimeMs: st.mtimeMs };
  }
  return melhor && { exe: melhor.exe, versaoPasta: melhor.versaoPasta };
}

function existe(fs, p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function automatico(localAppData, fs, usarCache) {
  const chave = String(localAppData);
  const agora = Date.now();
  if (usarCache && cache && cache.chave === chave && agora - cache.quando < CACHE_MS) return cache.auto;
  const auto = varrer(localAppData, fs);
  if (usarCache) cache = { chave, quando: agora, auto };
  return auto;
}

export function acharCodex({ caminhoManual, localAppData = process.env.LOCALAPPDATA, so = process.platform, fs = nodeFs } = {}) {
  const env = process.env.ORBIT_CODEX_EXE;
  if (env) return { exe: env, origem: 'env', versaoPasta: null };
  if (so !== 'win32') return { exe: null, motivo: 'Mac depois' };
  // Cache só com o fs real: com fs injetado (teste) sempre varre.
  const usarCache = fs === nodeFs;
  const manual = typeof caminhoManual === 'string' ? caminhoManual.trim() : '';
  if (manual) {
    if (existe(fs, manual)) return { exe: manual, origem: 'manual', versaoPasta: null };
    const auto = localAppData ? automatico(localAppData, fs, usarCache) : null;
    return { exe: null, motivo: 'caminho manual não encontrado', auto: auto ? auto.exe : null };
  }
  if (!localAppData) return { exe: null, motivo: 'LOCALAPPDATA ausente' };
  const auto = automatico(localAppData, fs, usarCache);
  if (!auto) return { exe: null, motivo: 'codex.exe não encontrado' };
  return { exe: auto.exe, origem: 'auto', versaoPasta: auto.versaoPasta };
}
