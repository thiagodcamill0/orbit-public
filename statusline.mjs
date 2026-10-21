// Orbit (gerenciador de instâncias do Claude Code) — status line.
// O Claude Code passa no stdin um JSON com rate_limits.{five_hour,seven_day}.{used_percentage,
// resets_at}, context_window.{total_input_tokens, context_window_size, used_percentage},
// session_id, model e cost. Imprime UMA linha curta ("● 5h 34% · sem 12% · ctx 61%") e
// repassa os números ao servidor (POST /uso) sem nunca atrasar a linha: se o servidor
// demorar ou estiver fora, sai mesmo assim (não sobe o servidor — isso é papel do hook).

import http from 'node:http';

const ts = Math.round(performance.timeOrigin) || Date.now();
const PORTA = Number(process.env.GERENCIADOR_PORTA || 47821);
const LIMITE_MS = 110; // teto para tudo depois de ler o stdin

let saiu = false;
function sair() {
  if (saiu) return;
  saiu = true;
  process.exit(0);
}

function lerStdin() {
  return new Promise((resolve) => {
    const partes = [];
    const fim = () => resolve(Buffer.concat(partes).toString('utf8'));
    process.stdin.on('data', (c) => partes.push(c));
    process.stdin.on('end', fim);
    process.stdin.on('error', fim);
    setTimeout(fim, 1000).unref(); // o Claude Code fecha o stdin logo; isto é só uma rede
  });
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (v) => (num(v) === null ? null : `${Math.round(num(v))}%`);

function montarLinha(d) {
  const partes = [];
  const h5 = pct(d?.rate_limits?.five_hour?.used_percentage);
  const sem = pct(d?.rate_limits?.seven_day?.used_percentage);
  const cw = d?.context_window;
  let ctx = pct(cw?.used_percentage);
  if (!ctx && num(cw?.total_input_tokens) && num(cw?.context_window_size)) ctx = pct((cw.total_input_tokens / cw.context_window_size) * 100);
  if (h5) partes.push(`5h ${h5}`);
  if (sem) partes.push(`sem ${sem}`);
  if (ctx) partes.push(`ctx ${ctx}`);
  if (!partes.length) {
    const m = typeof d?.model?.display_name === 'string' ? d.model.display_name : '';
    return m ? `● ${m}` : '●';
  }
  return `● ${partes.join(' · ')}`;
}

// Só o necessário para o servidor.
function resumo(d) {
  const janela = (j) => (j && typeof j === 'object' ? { used_percentage: num(j.used_percentage), resets_at: num(j.resets_at) } : undefined);
  const rl = d?.rate_limits;
  const cw = d?.context_window;
  return JSON.stringify({
    ts,
    session_id: typeof d?.session_id === 'string' ? d.session_id.slice(0, 200) : undefined,
    model: d?.model && typeof d.model === 'object' ? { id: String(d.model.id || '').slice(0, 100), display_name: String(d.model.display_name || '').slice(0, 100) } : undefined,
    rate_limits: rl && typeof rl === 'object' ? { five_hour: janela(rl.five_hour), seven_day: janela(rl.seven_day) } : undefined,
    context_window:
      cw && typeof cw === 'object'
        ? { total_input_tokens: num(cw.total_input_tokens), context_window_size: num(cw.context_window_size), used_percentage: num(cw.used_percentage) }
        : undefined,
    cost: d?.cost && typeof d.cost === 'object' ? { total_cost_usd: num(d.cost.total_cost_usd) } : undefined,
  });
}

function enviar(corpo) {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORTA,
          path: '/uso',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo), 'x-gerenciador': '1' },
          timeout: 100,
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
          res.on('error', resolve);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.on('error', resolve);
      req.end(corpo);
    } catch {
      resolve();
    }
  });
}

try {
  let dados = null;
  try {
    dados = JSON.parse((await lerStdin()) || 'null');
  } catch {}
  setTimeout(sair, LIMITE_MS).unref();
  const linha = montarLinha(dados);
  // A linha sai primeiro; o envio corre em paralelo e não segura o processo além do teto.
  const escrito = new Promise((r) => process.stdout.write(linha + '\n', () => r()));
  const enviado = dados && typeof dados === 'object' ? enviar(resumo(dados)) : Promise.resolve();
  await Promise.all([escrito, enviado]);
} catch {}
sair();
