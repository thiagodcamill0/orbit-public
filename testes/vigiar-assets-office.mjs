// Vigia assets/office/assets separados e recompõe o fundo da Visão de Office a cada PNG
// salvo, trocado, renomeado ou apagado (testes/aplicar-assets-office.py faz o trabalho).
// Uma linha por acontecimento, para quem acompanha (o gestor lê pelo Monitor):
//   TROCADO <elemento> ← <arquivo> ...    peça aplicada
//   DESCONHECIDO <arquivo> ...            nome fora do padrão: perguntar ao usuário
//   VOLTOU <elemento> (<arquivo> saiu)    arquivo apagado, elemento volta ao original
//   IGNORADO / ERRO ...
// _apelidos.json ({"arquivo.png": "elemento"}) liga um nome fora do padrão a um elemento.
// Uso: node testes/vigiar-assets-office.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = path.join(PROJ, 'assets', 'office', 'assets separados');
const COMPOR = path.join(PROJ, 'testes', 'aplicar-assets-office.py');
const ESPERA_MS = 1200; // o arquivo precisa ficar parado esse tempo antes de entrar

const log = (s) => console.log(`[office-assets ${new Date().toTimeString().slice(0, 8)}] ${s}`);
const relevante = (n) => /\.png$/i.test(n) && !/^[_.]/.test(n) && !/\.tmp\.png$/i.test(n);

let anterior = new Map(); // arquivo → { elemento, mtime, tamanho }
const pendentes = new Set();
let timer = null, rodando = false, deNovo = false;

function assinatura(n) {
  try { const s = fs.statSync(path.join(PASTA, n)); return s.mtimeMs + ':' + s.size; } catch { return null; }
}

function compor() {
  return new Promise((ok, falha) => {
    execFile('py', ['-3', COMPOR], { cwd: PROJ, windowsHide: true, maxBuffer: 1 << 24, env: { ...process.env, PYTHONIOENCODING: 'utf8' } }, (err, out, errOut) => {
      if (err) return falha(new Error((errOut || err.message).trim().split('\n').slice(-3).join(' | ')));
      try { ok(JSON.parse(out.trim().split('\n').pop())); } catch (e) { falha(new Error('saída inválida: ' + out.slice(0, 200))); }
    });
  });
}

async function rodar(focos, inicial = false) {
  if (rodando) { deNovo = true; for (const f of focos) pendentes.add(f); return; }
  rodando = true;
  try {
    const r = await compor();
    const agora = new Map();
    for (const it of r.itens) agora.set(it.arquivo, it);
    for (const nome of focos) {
      const it = agora.get(nome);
      if (!it) {
        const antes = anterior.get(nome);
        if (antes && antes.elemento) log(`VOLTOU ${antes.elemento} ao desenho original (${nome} saiu da pasta)`);
        continue;
      }
      const sig = assinatura(nome);
      const antes = anterior.get(nome);
      if (!inicial && antes && antes.sig === sig && antes.elemento === it.elemento) continue; // nada mudou
      if (!it.elemento) {
        log(`DESCONHECIDO ${nome} — nome fora do padrão` + (it.sugestoes && it.sugestoes.length ? `; parecidos: ${it.sugestoes.join(', ')}` : ''));
      } else if (it.erro) {
        log(`ERRO ${nome} → ${it.elemento}: ${it.erro}`);
      } else if (it.ignorado) {
        log(`IGNORADO ${nome}: ${it.ignorado}`);
      } else {
        log(`TROCADO ${it.elemento} ← ${nome} (desenho de ${it.tamanho.join('×')} px em ${(it.destinos || []).join('; ')})` + (it.avisos ? ` — aviso: ${it.avisos.join('; ')}` : ''));
      }
    }
    anterior = new Map([...agora].map(([n, it]) => [n, { elemento: it.elemento, sig: assinatura(n) }]));
  } catch (e) {
    log(`ERRO na composição: ${e.message}`);
  } finally {
    rodando = false;
    if (deNovo) { deNovo = false; agendar(); }
  }
}

// Espera o arquivo parar de crescer (editores salvam em etapas) antes de compor.
function agendar() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const focos = [...pendentes];
    pendentes.clear();
    if (focos.length) rodar(focos);
  }, ESPERA_MS);
}

fs.mkdirSync(PASTA, { recursive: true });
const iniciais = fs.readdirSync(PASTA).filter(relevante);
log(`vigiando ${PASTA} (${iniciais.length} PNG já na pasta)`);
await rodar(iniciais, true);

fs.watch(PASTA, (tipo, nome) => {
  if (nome === '_apelidos.json') { for (const n of fs.readdirSync(PASTA).filter(relevante)) pendentes.add(n); agendar(); return; }
  if (!nome || !relevante(nome)) return;
  pendentes.add(nome);
  agendar();
});
setInterval(() => {}, 1 << 30); // mantém vivo mesmo se o watch for o único handle
