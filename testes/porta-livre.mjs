// Orbit — porta de teste livre e desligamento seguro (pedido do usuário, 15/10: um agente nunca derruba o
// servidor de teste de outro). Regra (Processo do time): testes só em 47822–47826; antes de subir, a porta
// tem de estar livre (nada escutando, não basta o /saude falhar); no fim, desligar só o processo que o
// próprio teste subiu (matar o filho, ou /desligar quando o /saude devolve o pid desse filho).
//   import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
//   const porta = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);

import net from 'node:net';
import http from 'node:http';

export const FAIXA = [47822, 47823, 47824, 47825, 47826];

// Livre = dá para escutar nela agora (em 127.0.0.1, como o servidor e o mock).
export function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(porta, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

// A preferida, se livre; senão a primeira livre da faixa. Nunca a 47821 (produção).
export async function escolherPorta(preferida) {
  const ordem = [...new Set([Number(preferida), ...FAIXA])].filter((p) => FAIXA.includes(p));
  for (const p of ordem) if (await portaLivre(p)) return p;
  throw new Error('nenhuma porta livre em 47822–47826: outros testes estão rodando; espere ou feche os seus');
}

// /desligar só se o /saude daquela porta devolver o pid do processo que este teste subiu.
export function desligarSeMeu(porta, pid) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/saude', timeout: 2000 }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch {}
        if (!pid || j?.pid !== pid) return resolve(false);
        const p = http.request({ host: '127.0.0.1', port: porta, path: '/desligar', method: 'POST', headers: { 'x-gerenciador': '1' }, timeout: 2000 }, (r) => {
          r.resume();
          resolve(true);
        });
        p.on('error', () => resolve(false));
        p.on('timeout', () => p.destroy());
        p.end();
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}
