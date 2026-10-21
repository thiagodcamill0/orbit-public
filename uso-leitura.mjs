// Orbit — leitura do uso do plano sob demanda (botão "atualizar" do card Uso do plano, 15/10).
// Uma chamada mínima ao claude headless (Haiku, prompt de uma palavra, sem ferramentas) só para receber o
// rate_limit_event do stream-json, que traz unifiedWindows.{five_hour,seven_day}.{utilization 0–1, resetsAt s}.
// --safe-mode desliga hooks, CLAUDE.md, MCP e plugins e mantém o login do plano (o --bare não serve: só aceita
// ANTHROPIC_API_KEY). Gasta um pouco do plano (US$ 0,0006 e 3,2 s em 15/10) e, sem janela de 5h ativa, abre
// uma nova a partir de agora: por isso só roda no clique, e quem chama (servidor.mjs) confere antes.
// A sessão vai com --session-id escolhido aqui, para o servidor não listá-la (ela aparece no ~/.claude/sessions).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { binarioClaude } from './binario.mjs';
import { envLimpo } from './controle.mjs';

const LIMITE_MS = 45e3;

// rate_limit_info do stream → rate_limits no formato da status line (o que o aplicarUso lê).
export function usoDoEvento(info) {
  const w = info && typeof info === 'object' ? info.unifiedWindows : null;
  if (!w || typeof w !== 'object') return null;
  const j = (x) => {
    const u = x && typeof x === 'object' ? Number(x.utilization) : NaN;
    return Number.isFinite(u) ? { used_percentage: u * 100, resets_at: Number(x.resetsAt) || null } : undefined;
  };
  const r = { five_hour: j(w.five_hour), seven_day: j(w.seven_day) };
  return r.five_hour || r.seven_day ? r : null;
}

// Resolve { ts, rate_limits, custo } ou rejeita com uma mensagem para a página.
export function lerUsoAgora({ sessionId = crypto.randomUUID(), bin = binarioClaude(), limiteMs = LIMITE_MS } = {}) {
  const pasta = path.join(os.tmpdir(), 'orbit-uso'); // vazia e fora de qualquer projeto
  fs.mkdirSync(pasta, { recursive: true });
  const args = [...bin.pre, '-p', 'Responda apenas: ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--tools', '', '--max-turns', '1', '--session-id', sessionId];
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(bin.cmd, args, { cwd: pasta, env: envLimpo(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(new Error('não deu para abrir o claude: ' + e.message));
    }
    let resto = '', erro = '', leitura = null, custo = null, fim = false;
    const acabar = (e) => {
      if (fim) return;
      fim = true;
      clearTimeout(t);
      if (p.exitCode == null) try { p.kill(); } catch {}
      if (leitura) resolve({ ...leitura, custo });
      else reject(e || new Error('o claude respondeu, mas sem o uso do plano'));
    };
    const t = setTimeout(() => acabar(new Error('o claude não respondeu em ' + Math.round(limiteMs / 1000) + ' s')), limiteMs);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      const linhas = (resto + c).split('\n');
      resto = linhas.pop();
      for (const l of linhas) {
        let j;
        try { j = JSON.parse(l); } catch { continue; }
        if (j.type === 'rate_limit_event') {
          const rl = usoDoEvento(j.rate_limit_info);
          if (rl) leitura = { ts: Date.now(), rate_limits: rl };
        } else if (j.type === 'result') {
          custo = Number(j.total_cost_usd);
          if (!Number.isFinite(custo)) custo = null;
        }
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => { if (erro.length < 2000) erro += c; });
    p.on('error', (e) => acabar(new Error('não deu para abrir o claude: ' + e.message)));
    p.on('close', (codigo) => acabar(codigo ? new Error('o claude saiu com código ' + codigo + (erro.trim() ? ': ' + erro.trim().split('\n').pop().slice(0, 200) : '')) : null));
  });
}
