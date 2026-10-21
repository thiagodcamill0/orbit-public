// Reinício do servidor pelas Configurações (seção "Servidor", botão "Reiniciar"). Página: index.html.
//
// POST /reiniciar  confere o que o desligamento interromperia (instância fora do motor, instância do
//                  motor ainda no initialize, ação que mexe em processo) e a sintaxe dos .mjs do servidor;
//                  grava a marca <DADOS>/reinicio.json, sobe o ajudante (este arquivo, destacado) e desliga
//                  com o motivo "usuário" no log. 202 { ok, pedido, motor } ou 409 { erro } com o motivo.
// GET  /reinicio   o último reinício visto por este servidor: { ultimo: {...} | null }.
//
// O ajudante (`node reinicio.mjs ajudante <marca>`) espera o processo antigo sair e sobe o servidor de
// novo como o hook.mjs: pela tarefa de logon na produção (nasce fora do VS Code); senão, ou se ela não
// responder, direto, com o stderr num arquivo para dizer o motivo se ele cair na subida.
// O servidor novo, já com a porta, lê a marca (aoSubir), registra a linha no cofre e apaga a marca.
// O ajudante só escreve no cofre quando falha. As instâncias do motor não são tocadas: o motor é outro
// processo, e o servidor novo as adota (controle.mjs).
//
// Registro: <pasta de dados>/notas/Reinícios do servidor.md; GERENCIADOR_REINICIOS troca o arquivo.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WIN, pathAmpliado } from './plataforma.mjs';
import { comandoSubirPelaTarefa } from './logon.mjs';

const ARQ_ESTE = fileURLToPath(import.meta.url);
const PASTA = path.dirname(ARQ_ESTE);
const ms = (nome, padrao) => Number(process.env[nome]) || padrao;
const MS_SAIR = ms('ORBIT_REINICIO_SAIR_MS', 15e3); // o processo antigo precisa sair
const MS_TAREFA = ms('ORBIT_REINICIO_TAREFA_MS', 8e3); // pela tarefa de logon; depois disso, direto
const MS_SUBIR = ms('ORBIT_REINICIO_SUBIR_MS', 20e3); // o servidor novo precisa responder ao /saude
const MS_ADOCAO = ms('ORBIT_REINICIO_ADOCAO_MS', 10e3); // as instâncias do motor voltam ao servidor novo
const MS_PAUSA = ms('ORBIT_REINICIO_PAUSA_MS', 150); // entre a saída do antigo e a subida do novo (a porta se solta)
const NOMES_ACAO = { criar: 'criando uma instância', assumir: 'assumindo uma sessão', retomar: 'retomando uma instância', devolver: 'devolvendo uma instância', encerrar: 'encerrando uma instância', parar: 'parando uma instância', compactar: 'compactando uma conversa', limpar: 'limpando uma conversa', dormir: 'fechando uma instância', acordar: 'acordando uma instância' };

const doisDig = (n) => String(n).padStart(2, '0');
function carimbo(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${doisDig(d.getMonth() + 1)}-${doisDig(d.getDate())} ${doisDig(d.getHours())}:${doisDig(d.getMinutes())}:${doisDig(d.getSeconds())}`;
}
const hora = (t) => carimbo(t).slice(11);
const segundos = (ms) => (ms / 1000).toFixed(1).replace('.', ',') + ' s';
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerMarca(arq) {
  try {
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return j && typeof j === 'object' && Number(j.pedido) > 0 ? j : null;
  } catch {
    return null;
  }
}

function gravarMarca(arq, m) {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const tmp = arq + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, arq);
}

// Uma linha por reinício no fim da nota; cria a nota se faltar e acerta o "atualizado".
async function registrarNoCofre(arquivo, linha) {
  let txt = '';
  try {
    txt = await fsp.readFile(arquivo, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const dia = carimbo().slice(0, 10);
  if (!txt.trim()) {
    txt = [
      '---',
      'tipo: registro',
      `atualizado: ${dia}`,
      '---',
      '',
      '# Reinícios do servidor',
      '',
      'Escrito pelo Orbit a cada reinício pelo botão **Configurações → Servidor → Reiniciar**, do mais',
      'antigo para o mais novo. As instâncias do motor seguem rodando durante o reinício.',
      '',
      '',
    ].join('\n');
  } else txt = txt.replace(/^(---\r?\n[\s\S]*?^atualizado: )\d{4}-\d{2}-\d{2}/m, `$1${dia}`);
  if (!txt.endsWith('\n')) txt += '\n';
  await fsp.mkdir(path.dirname(arquivo), { recursive: true });
  await fsp.writeFile(arquivo, txt + linha + '\n');
}

function textoMotor(esperadas, voltaram) {
  if (!esperadas) return '';
  if (voltaram == null) return ` · ${plural(esperadas, 'instância no motor', 'instâncias no motor')} (não conferido)`;
  if (voltaram >= esperadas) return ` · ${plural(esperadas, 'instância do motor seguiu rodando', 'instâncias do motor seguiram rodando')}`;
  return ` · ${voltaram} de ${plural(esperadas, 'instância do motor', 'instâncias do motor')} de volta`;
}

function linhaDoCofre(m) {
  const base = `- ${carimbo(m.pedido)} · pelo ${m.por} (${m.origem})`;
  if (m.falha && m.online) return `${base} · voltou às ${hora(m.online)}, pelo próximo evento, depois da falha${textoMotor(m.motor, m.voltaram)}`;
  if (m.falha) return `${base} · falhou: ${m.falha.motivo}`;
  return `${base} · online de novo às ${hora(m.online)} (${segundos(m.online - m.pedido)})${textoMotor(m.motor, m.voltaram)}`;
}

// O que o servidor carrega: o servidor.mjs e, seguindo os imports './x.mjs' (estáticos e import()), os
// módulos da pasta. Um erro de sintaxe num deles faria o servidor novo não subir (ou subir sem o módulo).
export function arquivosDoServidor(pasta) {
  const vistos = new Set();
  const fila = ['servidor.mjs'];
  while (fila.length) {
    const nome = fila.shift();
    if (vistos.has(nome)) continue;
    vistos.add(nome);
    let txt = '';
    try { txt = fs.readFileSync(path.join(pasta, nome), 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]\.\/([\w.-]+\.mjs)['"]/g)) fila.push(m[1]);
  }
  return [...vistos];
}

// `node --check` nos arquivos do servidor, em paralelo. Devolve o primeiro erro ou ''.
function conferirSintaxe(pasta) {
  const um = (nome) =>
    new Promise((ok) => {
      const arq = path.join(pasta, nome);
      if (!fs.existsSync(arq)) return ok('');
      execFile(process.execPath, ['--check', arq], { windowsHide: true, timeout: 15000 }, (e, _out, err) => {
        if (!e) return ok('');
        const linhas = String(err || e.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const onde = /:(\d+)$/.exec(linhas[0] || '');
        const msg = linhas.find((l) => /Error\b/.test(l)) || linhas[0] || 'erro de sintaxe';
        ok(`${nome}${onde ? `, linha ${onde[1]}` : ''}: ${msg}`);
      });
    });
  return Promise.all(arquivosDoServidor(pasta).map(um)).then((r) => r.find(Boolean) || '');
}

export function criarReinicio(deps) {
  const { dados, pasta = PASTA, cofre, lerJSONCorpo, log = () => {}, bloqueios = () => ({}), desligar } = deps;
  const ARQ_MARCA = path.join(dados, 'reinicio.json');
  let reiniciando = false;
  let ultimo = null;
  let cancelado = null;

  function motivoDoBloqueio() {
    const b = bloqueios() || {};
    if (b.direto) return `${plural(b.direto, 'instância do Orbit roda', 'instâncias do Orbit rodam')} fora do motor e ${b.direto === 1 ? 'seria encerrada' : 'seriam encerradas'}. Feche ${b.direto === 1 ? 'ela' : 'elas'} antes de reiniciar.`;
    if (b.iniciando) return `${plural(b.iniciando, 'instância do motor ainda está iniciando', 'instâncias do motor ainda estão iniciando')}; um reinício agora ${b.iniciando === 1 ? 'a encerraria' : 'as encerraria'}. Tente de novo em alguns segundos.`;
    if (b.acoes?.length) return `O Orbit está ${NOMES_ACAO[b.acoes[0]] || 'mexendo numa instância'}. Espere terminar e tente de novo.`;
    return '';
  }

  async function pedir(req, res) {
    await lerJSONCorpo(req).catch(() => null);
    if (reiniciando) return responder(res, 409, { erro: 'O servidor já está reiniciando.' });
    if (typeof desligar !== 'function') return responder(res, 503, { erro: 'Este servidor não sabe desligar sozinho.' });
    reiniciando = true;
    try {
      const bloqueio = motivoDoBloqueio();
      if (bloqueio) return responder(res, 409, { erro: bloqueio, motivo: 'instancias' });
      const sintaxe = await conferirSintaxe(pasta);
      if (sintaxe) return responder(res, 409, { erro: `O servidor novo não subiria: ${sintaxe}`, motivo: 'sintaxe' });
      const bloqueio2 = motivoDoBloqueio(); // a conferência leva alguns décimos
      if (bloqueio2) return responder(res, 409, { erro: bloqueio2, motivo: 'instancias' });
      const ua = String(req.headers['user-agent'] || 'sem user-agent').slice(0, 300);
      const marca = { pedido: Date.now(), por: 'usuário', origem: 'Configurações', ua, pidAntigo: process.pid, motor: Number(bloqueios()?.motor) || 0, cofre };
      try {
        gravarMarca(ARQ_MARCA, marca);
        const aj = spawn(process.execPath, [ARQ_ESTE, 'ajudante', ARQ_MARCA], { cwd: pasta, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
        aj.on('error', (e) => log('reinício', `o ajudante falhou: ${e.message}`));
        aj.unref();
        if (!aj.pid) throw new Error('o processo não abriu');
      } catch (e) {
        try { fs.rmSync(ARQ_MARCA, { force: true }); } catch {}
        return responder(res, 500, { erro: `Não consegui preparar o reinício: ${e.message}` });
      }
      log('reinício', `pedido pelo usuário (Configurações; ${ua}); ${plural(marca.motor, 'instância', 'instâncias')} no motor seguem vivas`);
      responder(res, 202, { ok: true, pedido: marca.pedido, motor: marca.motor, pid: process.pid });
      setTimeout(() => {
        // Última conferência: se alguma coisa começou nesses décimos, o reinício não acontece. Sem a
        // marca, o ajudante vê o servidor antigo vivo e desiste sem mexer em nada.
        const tarde = motivoDoBloqueio();
        if (tarde) {
          reiniciando = false;
          cancelado = { motivo: tarde, em: Date.now() };
          try { fs.rmSync(ARQ_MARCA, { force: true }); } catch {}
          log('reinício', `cancelado: ${tarde}`);
          return;
        }
        desligar(`POST /reiniciar (usuário · Configurações · ${ua})`);
      }, 300).unref?.();
      return;
    } finally {
      if (!res.headersSent || res.statusCode !== 202) reiniciando = false;
    }
  }

  async function rota(req, res, r) {
    if (req.method === 'GET' && r === '/reinicio') return responder(res, 200, { pid: process.pid, reiniciando, ultimo, cancelado }), true;
    if (req.method === 'POST' && r === '/reiniciar') return await pedir(req, res), true;
    return false;
  }

  // Chamado com a porta já ganha: fecha o reinício que trouxe este servidor (se trouxe).
  async function aoSubir() {
    const m = lerMarca(ARQ_MARCA);
    if (!m || m.pidAntigo === process.pid) return;
    try { fs.rmSync(ARQ_MARCA, { force: true }); } catch {}
    m.online = Date.now();
    m.pid = process.pid;
    ultimo = { pedido: m.pedido, online: m.online, por: m.por, origem: m.origem, motor: Number(m.motor) || 0, voltaram: null, conferido: false, falha: m.falha || null, duracao: m.online - m.pedido };
    log('reinício', m.falha ? `servidor de volta depois da falha (${m.falha.motivo})` : `online de novo em ${segundos(ultimo.duracao)}`);
    // As do motor voltam pela adoção do controle, logo depois da subida: conta até todas voltarem (até 10 s).
    if (ultimo.motor) {
      const fim = Date.now() + MS_ADOCAO;
      let n = 0;
      while ((n = Number(bloqueios()?.motor) || 0) < ultimo.motor && Date.now() < fim) await dormir(250);
      ultimo.voltaram = m.voltaram = n;
      log('reinício', `${n} de ${ultimo.motor} instâncias do motor de volta`);
    }
    // A falha já foi registrada pelo ajudante; aqui só a volta. "conferido" só depois do cofre.
    const arquivo = m.cofre || cofre;
    if (arquivo) await registrarNoCofre(arquivo, linhaDoCofre(m)).catch((e) => log('reinício', `não consegui escrever no cofre: ${e.message}`));
    ultimo.conferido = true;
  }

  return { rota, aoSubir, ultimo: () => ultimo };
}

// ───────────────────────── ajudante (processo destacado) ─────────────────────────

const dormir = (t) => new Promise((r) => setTimeout(r, t));
const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

function pidNaPorta(porta) {
  return new Promise((r) => {
    const q = http.get({ host: '127.0.0.1', port: porta, path: '/saude', timeout: 1500 }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        try {
          r(Number(JSON.parse(t).pid) || 0);
        } catch {
          r(0);
        }
      });
    });
    q.on('timeout', () => q.destroy());
    q.on('error', () => r(0));
  });
}

// "Subir pela tarefa" conforme o logon.json da pasta (o mesmo do hook.mjs): { cmd, args } ou null.
// `o` = { so, uid } para os testes simularem o Mac.
export function comandoDaTarefa(pasta = PASTA, o) {
  let txt;
  try { txt = fs.readFileSync(path.join(pasta, 'logon.json'), 'utf8'); } catch { return null; }
  return comandoSubirPelaTarefa(txt, o);
}

async function esperarNovo(porta, antigo, t, filho) {
  const fim = Date.now() + t;
  while (Date.now() < fim) {
    const pid = await pidNaPorta(porta);
    if (pid && pid !== antigo) return pid;
    if (filho && filho.saiu) {
      // Saiu sem ganhar a porta: talvez outro (o hook) tenha subido antes. Uma olhada final.
      await dormir(300);
      const p2 = await pidNaPorta(porta);
      return p2 && p2 !== antigo ? p2 : 0;
    }
    await dormir(250);
  }
  return 0;
}

async function ajudante(arqMarca) {
  const dados = path.dirname(arqMarca);
  const LOG = path.join(dados, 'logs', 'reinicio.log');
  const log = (...a) => {
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      if ((fs.statSync(LOG, { throwIfNoEntry: false })?.size || 0) > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
      fs.appendFileSync(LOG, [new Date().toISOString(), process.pid, ...a].join(' ') + '\n');
    } catch {}
  };
  const marca = lerMarca(arqMarca);
  if (!marca) return log('sem marca de reinício; nada a fazer');
  const porta = Number(process.env.GERENCIADOR_PORTA || 47821);
  const antigo = Number(marca.pidAntigo);

  async function falhar(motivo) {
    log('falhou:', motivo);
    const m = lerMarca(arqMarca) || marca;
    m.falha = { motivo, em: Date.now() };
    try { gravarMarca(arqMarca, m); } catch {}
    if (m.cofre) await registrarNoCofre(m.cofre, linhaDoCofre(m)).catch((e) => log('cofre:', e.message));
  }

  // 1. O antigo sai.
  const fimSair = Date.now() + MS_SAIR;
  while (vivo(antigo) && Date.now() < fimSair) await dormir(100);
  if (vivo(antigo)) {
    // Cancelado pelo próprio servidor (apagou a marca: algo começou na última hora) ou travado. Não mexe em nada.
    if (!lerMarca(arqMarca)) return log('o servidor cancelou o reinício');
    return falhar(`o servidor antigo (pid ${antigo}) não desligou em ${segundos(MS_SAIR)}`);
  }
  log('servidor antigo saiu, pid', antigo);
  await dormir(MS_PAUSA);

  // 2. Alguém (um hook) já subiu outro?
  let pid = await pidNaPorta(porta);
  if (pid && pid !== antigo) return log('um servidor já subiu sozinho, pid', pid);

  // 3. Pela tarefa de logon, como o hook.mjs (só a produção): schtasks no Windows, launchctl no Mac.
  if (porta === 47821 && !process.env.GERENCIADOR_DADOS) {
    try {
      const c = comandoDaTarefa(PASTA);
      if (c) {
        const p = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: true });
        p.on('error', (e) => log('tarefa de logon:', e.message));
        p.unref();
        pid = await esperarNovo(porta, antigo, MS_TAREFA);
        if (pid) return log('servidor de volta pela tarefa de logon, pid', pid);
        log('a tarefa de logon não subiu o servidor em', segundos(MS_TAREFA), '; subindo direto');
      }
    } catch (e) {
      log('tarefa de logon:', e.message);
    }
  }

  // 4. Direto, com o stderr guardado para dizer o motivo de uma queda na subida.
  const arqErro = path.join(dados, 'logs', 'reinicio-saida.log');
  let fd = 'ignore';
  try {
    fs.mkdirSync(path.dirname(arqErro), { recursive: true });
    fd = fs.openSync(arqErro, 'w');
  } catch {}
  const filho = { saiu: false, codigo: null };
  try {
    const env = WIN ? process.env : { ...process.env, PATH: pathAmpliado() }; // Mac: o launchd sobe com PATH mínimo
    const p = spawn(process.execPath, [path.join(PASTA, 'servidor.mjs')], { cwd: PASTA, detached: true, stdio: ['ignore', 'ignore', fd], windowsHide: true, env });
    p.on('exit', (c) => Object.assign(filho, { saiu: true, codigo: c }));
    p.on('error', (e) => Object.assign(filho, { saiu: true, erro: e.message }));
    p.unref();
  } catch (e) {
    return falhar(`não consegui abrir o servidor novo (${e.message})`);
  } finally {
    if (typeof fd === 'number') try { fs.closeSync(fd); } catch {}
  }
  pid = await esperarNovo(porta, antigo, MS_SUBIR, filho);
  if (pid) return log('servidor de volta, pid', pid);
  let motivo = filho.erro || '';
  if (!motivo && filho.saiu) {
    const saida = (() => { try { return fs.readFileSync(arqErro, 'utf8'); } catch { return ''; } })();
    const linhas = saida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const erro = linhas.find((l) => /^\w*Error\b|^Error:/.test(l)) || linhas[0] || '';
    motivo = `o servidor novo caiu na subida (código ${filho.codigo})${erro ? `: ${erro.slice(0, 240)}` : ''}`;
  }
  return falhar(motivo || `o servidor novo não respondeu em ${segundos(MS_SUBIR)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === ARQ_ESTE && process.argv[2] === 'ajudante') {
  ajudante(path.resolve(process.argv[3] || path.join(path.resolve(process.env.GERENCIADOR_DADOS || PASTA), 'reinicio.json')))
    .catch(() => {})
    .finally(() => process.exit(0));
}
