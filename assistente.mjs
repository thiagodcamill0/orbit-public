// Orbit — assistente da primeira vez (uma tela só, assets/assistente.js).
//
// Rotas (só no PC; o servidor.mjs só encaixa: criarAssistente(deps) e rota()):
//   GET  /assistente            { feito, nome, nomeSistema, pastaProjetos, instalacao, celular, avisos }
//   POST /assistente/concluir   { nome, pastaProjetos, hooks, aviso, subir, liderar, celular }
//                               → aplica cada escolha e devolve { passos: [{ passo, ok, texto }], estado }
//   POST /assistente/pular      marca como feito sem mudar nada (dá para refazer pelas Configurações)
//   POST /assistente/refazer    volta a mostrar o assistente
// O login do Claude e o GitHub usam as rotas de sempre (/conta/claude e /perfil/github): a tela só as chama.
//
// Nada global muda sem a escolha do usuário nesta tela: os hooks, o aviso aos subagentes, o "abrir sozinho"
// e a skill liderar-time vão pelo `node instalar.mjs` com as opções marcadas (desmarcar tira o que for do Orbit).
// Servidor de teste (GERENCIADOR_DADOS) sem GERENCIADOR_SETTINGS e GERENCIADOR_SKILLS: recusa, para nunca
// tocar o ~/.claude de quem roda os testes.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { estadoDaInstalacao, cuidarDaSkill } from './instalar.mjs';
import { nomeLocal } from './perfil.mjs';

const MS_INSTALAR = 30e3;

export function criarAssistente(deps) {
  const { pasta, dados, config, gravarConfig, repos, log = () => {} } = deps;
  const env = deps.env || process.env;

  function responder(res, status, corpo) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(corpo));
  }

  // Servidor de teste sem as pastas de teste do Claude: nada de instalar.
  const semPastasDeTeste = () => !!env.GERENCIADOR_DADOS && (!env.GERENCIADOR_SETTINGS || !env.GERENCIADOR_SKILLS);

  function estado() {
    const c = config();
    return {
      // Servidor de teste (GERENCIADOR_DADOS): conta como feito, para a tela não cobrir os testes de interface;
      // ORBIT_ASSISTENTE=1 mostra (testes do assistente).
      feito: c.assistente ? !!c.assistente.feito : !!env.GERENCIADOR_DADOS && env.ORBIT_ASSISTENTE !== '1',
      nome: c.nome || '',
      nomeSistema: nomeLocal(deps.so || process.platform),
      pastaProjetos: repos?.pastaClones ? repos.pastaClones() : '',
      instalacao: estadoDaInstalacao(),
      celular: !!c.remoto?.ativo,
      windows: (deps.so || process.platform) === 'win32',
    };
  }

  function rodarInstalar(args) {
    return new Promise((resolve) => {
      let saida = '';
      let p;
      try {
        p = spawn(process.execPath, [path.join(pasta, 'instalar.mjs'), ...args], {
          cwd: pasta,
          env: { ...env, GERENCIADOR_DADOS: dados },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        resolve({ ok: false, texto: e.message });
        return;
      }
      const t = setTimeout(() => { try { p.kill(); } catch {} }, MS_INSTALAR);
      p.stdout.on('data', (d) => (saida += d));
      p.stderr.on('data', (d) => (saida += d));
      p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, texto: e.message }); });
      p.on('exit', (codigo) => { clearTimeout(t); resolve({ ok: codigo === 0, texto: saida.trim().slice(0, 2000) }); });
    });
  }

  async function concluir(b) {
    const passos = [];
    const passo = (nome, ok, texto) => passos.push({ passo: nome, ok, texto: String(texto || '') });

    // 1. Nome e pasta de projetos.
    if (typeof b.nome === 'string') {
      gravarConfig({ nome: b.nome });
      passo('nome', true, b.nome.trim() ? `Nome: ${config().nome}` : 'Nome: o da conta do Windows');
    }
    if (typeof b.pastaProjetos === 'string' && b.pastaProjetos.trim() && repos?.definirPastaClones) {
      try {
        passo('pasta', true, `Pasta de projetos: ${await repos.definirPastaClones(b.pastaProjetos)}`);
      } catch (e) {
        passo('pasta', false, e.message);
      }
    }

    // 2. Hooks, aviso aos subagentes, abrir sozinho e skill (só o que foi marcado).
    const antes = estadoDaInstalacao();
    const quer = (k) => b[k] === true;
    if (semPastasDeTeste()) {
      passo('instalar', false, 'Servidor de teste sem GERENCIADOR_SETTINGS e GERENCIADOR_SKILLS: nada foi instalado.');
    } else if (quer('hooks')) {
      const args = [
        quer('aviso') ? '--aviso-subagente' : '--sem-aviso-subagente',
        quer('subir') ? '--abrir-sozinho' : '--sem-abrir-sozinho',
        quer('liderar') ? '--liderar-time' : '--sem-liderar-time',
      ];
      const r = await rodarInstalar(args);
      passo('instalar', r.ok, r.texto);
    } else {
      if (antes.hooks || antes.aviso) {
        const r = await rodarInstalar(['--remover']);
        passo('instalar', r.ok, r.texto);
      }
      try {
        const pastaSkills = path.resolve(env.GERENCIADOR_SKILLS || path.join(os.homedir(), '.claude', 'skills'));
        const linha = cuidarDaSkill(quer('liderar') ? 'instalar' : 'tirar', dados, pastaSkills);
        if (linha) passo('skill', !/^Aviso|não consegui/.test(linha), linha);
      } catch (e) {
        passo('skill', false, e.message);
      }
    }

    // 3. Celular: só liga a porta do celular; o Tailscale e o pareamento ficam em Configurações → Celular.
    if (typeof b.celular === 'boolean') {
      await gravarConfig({ remoto: { ativo: b.celular } });
      passo('celular', true, b.celular ? 'Celular ligado: termine em Configurações → Celular (Tailscale e pareamento).' : 'Celular desligado.');
    }

    if (passos.every((p) => p.ok)) gravarConfig({ assistente: { feito: true } });
    log('assistente:', passos.map((p) => `${p.passo}=${p.ok ? 'ok' : 'falhou'}`).join(' '));
    return { passos, estado: estado() };
  }

  async function rota(req, res, caminho, lerCorpo) {
    if (caminho !== '/assistente' && !caminho.startsWith('/assistente/')) return false;
    try {
      if (req.method === 'GET') {
        if (caminho !== '/assistente') return false;
        responder(res, 200, estado());
        return true;
      }
      const b = (await lerCorpo(req).catch(() => null)) || {};
      if (typeof b !== 'object' || Array.isArray(b)) { responder(res, 400, { erro: 'Corpo inválido.' }); return true; }
      if (caminho === '/assistente/concluir') { responder(res, 200, await concluir(b)); return true; }
      if (caminho === '/assistente/pular') { gravarConfig({ assistente: { feito: true } }); responder(res, 200, estado()); return true; }
      if (caminho === '/assistente/refazer') { gravarConfig({ assistente: { feito: false } }); responder(res, 200, estado()); return true; }
      responder(res, 404, { erro: 'não encontrado' });
    } catch (e) {
      log('assistente: rota:', e?.stack || e);
      responder(res, 500, { erro: String(e?.message || e) });
    }
    return true;
  }

  return { rota, estado };
}
