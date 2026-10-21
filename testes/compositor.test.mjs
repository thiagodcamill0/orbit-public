// Compositor da Conversa: cartão, seletores (menus do modo e do modelo com esforço), Parar/Enviar e o menu
// dos comandos com barra.
// Sobe o mock (ROTEIRO=0) numa porta de teste, abre o index.html real no Edge headless e confere o
// comportamento; as capturas ficam em logs/compositor/. Uso: node testes/compositor.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'compositor');
const PORTA = Number(process.env.PORTA || 47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => { if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
const pcdp = 9600 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const estado = await (await fetch(BASE + '/estado')).json();
  const sess = estado.sessoes;
  // Ociosa: no mock (ROTEIRO=0) as livres do Orbit estão dormindo; acordam no primeiro envio.
  const ocioso = sess.find((s) => s.controle?.modo === 'orbit' && !s.controle.ocupada && !s.controle.permissao && !s.controle.interrompida)
    || sess.find((s) => s.controle?.modo === 'orbit' && !s.controle.ocupada && !s.controle.permissao);
  const ocupado = sess.find((s) => s.controle?.modo === 'orbit' && s.controle.ocupada && !s.controle.permissao && s.controle.processo !== 'iniciando');
  const leitura = sess.find((s) => s.controle && s.controle.modo !== 'orbit');
  conferir(ocioso && ocupado && leitura, 'o mock tem sessões ociosa, ocupada e fora do Orbit', [ocioso?.id, ocupado?.id, leitura?.id]);

  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${perfil}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map(); const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const foto = async (nome, sel = '#pk-conversa .cv-compor', margem = 0) => {
    const c = await av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const clip = c ? { x: Math.max(0, c.x - margem), y: Math.max(0, c.y - margem), width: c.w + 2 * margem, height: c.h + 2 * margem, scale: 2 } : undefined;
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const tecla = async (key, code, vk, extra = {}) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, ...extra });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await dormir(180);
  };
  const enter = () => tecla('Enter', 'Enter', 13, { text: '\r' });
  const digitar = async (s) => { await cdp('Input.insertText', { text: s }); await dormir(160); };
  const limparCampo = () => av(`(() => { const t = document.querySelector('#pk-conversa .cv-texto'); t.focus(); t.select(); document.execCommand('delete'); return t.value; })()`);
  // Duplo clique na linha abre a conversa (a página não expõe funções globais; a linha não tem mais botões de ação).
  const abrir = async (id) => {
    const r = await av(`(() => { const l = document.querySelector('#lista .linha[data-id=${JSON.stringify(id)}]'); if (!l) return 'sem linha'; l.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'ok'; })()`);
    if (r !== 'ok') throw new Error(r + ' (' + id + ')');
    await dormir(1100);
    const aba = await av(`(() => { const b = document.querySelector('#pk-abas button[data-aba="conversa"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); return !document.getElementById('pk-conversa').hidden; })()`);
    if (!aba) { await dormir(800); }
    await av(`document.querySelector('#pk-conversa .cv-texto').focus()`);
  };
  const q = (expr) => av(`(() => { const R = document.getElementById('pk-conversa'); ${expr} })()`);

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/?abas=0' }); // rodada 9: a Conversa no detalhe (sem as abas)
  await dormir(2500);

  // ── instância ociosa do Orbit ──
  await abrir(ocioso.id);
  let v = await q(`const vis = (e) => !!e && !e.closest('[hidden]') && e.getClientRects().length > 0;
    return { sels: [...R.querySelectorAll('.cv-sel')].filter(vis).map((b) => b.classList[1]), enviarDes: R.querySelector('.cv-enviar').getAttribute('aria-disabled'),
      parar: vis(R.querySelector('.cv-b-parar')), ph: R.querySelector('.cv-texto').placeholder,
      pe: !!R.querySelector('.cv-dica, .cv-selo, .cv-compor-pe, .cv-compor kbd'), selects: R.querySelectorAll('.cv-compor select').length,
      barra: !!R.querySelector('.cv-campo > .cv-barra .cv-enviar'), icones: R.querySelectorAll('.cv-sel .cv-sel-ico svg').length,
      ordem: [...R.querySelector('.cv-barra').querySelectorAll('.cv-sel, .cv-enviar')].map((x) => x.className.split(' ')[1] || x.className) };`);
  conferir(v.sels.join() === 'cv-sel-modo,cv-sel-modelo', 'ociosa: dois botões, o do modo e o do modelo (com o esforço)', v);
  conferir(v.icones === 2 && !v.selects, 'cada botão tem o ícone; sem <select> nativo', v);
  conferir(v.ordem.join() === 'cv-sel-modo,cv-sel-modelo,cv-enviar', 'modo à esquerda; modelo e Enviar à direita', v.ordem);
  conferir(v.barra, 'Enviar fica na barra dentro do cartão', v);
  conferir(v.enviarDes === 'true', 'campo vazio: Enviar desabilitado', v);
  conferir(!v.parar, 'sem volta: Parar escondido', v);
  conferir(!v.pe, 'nada abaixo do cartão: sem selo do modo e sem dicas de atalho', v);
  conferir(/\/ para comandos/.test(v.ph), 'placeholder fala do /', v.ph);
  await foto('1-ocioso', '#pk-conversa .cv-compor');

  // ── menu do modelo: lista com descrição, marca no escolhido e o esforço em degraus ──
  const popAberto = () => q(`const p = R.querySelector('.cv-pop'); return !p.hidden && p.getClientRects().length > 0 ? p.dataset.qual : '';`);
  await q(`R.querySelector('.cv-sel-modelo').click();`);
  await dormir(250);
  v = await q(`const p = R.querySelector('.cv-pop'); const its = [...p.querySelectorAll('.cv-pop-i[data-tipo="modelo"]')];
    return { qual: p.hidden ? '' : p.dataset.qual, exp: R.querySelector('.cv-sel-modelo').getAttribute('aria-expanded'),
      rots: its.map((i) => i.querySelector('.cv-pop-rot').textContent), descs: its.map((i) => i.querySelector('.cv-pop-desc')?.textContent || ''),
      marcados: its.filter((i) => i.getAttribute('aria-checked') === 'true').map((i) => i.dataset.valor), foco: document.activeElement?.dataset?.valor,
      mais: p.querySelector('.cv-pop-mais')?.textContent, degraus: p.querySelectorAll('.cv-degrau').length, esf: p.querySelector('.cv-esf-val')?.textContent,
      on: p.querySelectorAll('.cv-degrau.cv-on').length, botaoNivel: R.querySelectorAll('.cv-sel-modelo .cv-nivel i').length, botaoOn: R.querySelectorAll('.cv-sel-modelo .cv-nivel i.cv-on').length };`);
  conferir(v.qual === 'modelo' && v.exp === 'true', 'clicar no modelo abre o menu (aria-expanded)', v);
  conferir(v.rots.join() === 'Padrão,Opus 5.5,Fable 5.1,Sonnet 5.5,Haiku 5.5', 'menu: os modelos da conta, sem as versões fixas na lista principal', v.rots);
  conferir(v.descs.every((d) => d.length > 5) && !v.descs.some((d) => /^(For|Most|Fastest|Best)\b/.test(d)) && /^Recomendado · Fable 5\.1$/.test(v.descs[0]), 'menu: cada modelo com a descrição curta em português', v.descs);
  // O esperado vem do mock: o modelo e o esforço escolhidos na instância ociosa.
  const NIVEIS = ['low', 'medium', 'high', 'xhigh', 'max'], ROT = ['Baixo', 'Médio', 'Alto', 'Muito alto', 'Máximo'];
  const nEsf = NIVEIS.indexOf(ocioso.controle.esforco) + 1;
  conferir(v.marcados.join() === ocioso.controle.modelo && v.foco === ocioso.controle.modelo, 'menu: só o escolhido tem a marca e recebe o foco', v);
  conferir(/Outras versões\s*8/.test(v.mais || ''), 'menu: "Outras versões" recolhida, com a quantidade', v.mais);
  conferir(nEsf > 0 && v.degraus === 5 && v.esf === ROT[nEsf - 1] && v.on === nEsf, 'menu: esforço em 5 degraus, cheios até o atual', { v, esperado: ocioso.controle.esforco });
  conferir(v.botaoNivel === 5 && v.botaoOn === nEsf, 'botão: os degraus do esforço ao lado do nome', v);
  const cxPop = await q(`const r = R.querySelector('.cv-pop').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
  const rPop = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: cxPop.x - 16, y: cxPop.y - 16, width: cxPop.w + 32, height: cxPop.h + 110, scale: 2 } });
  fs.writeFileSync(path.join(SAIDA, '1b-menu-modelo.png'), Buffer.from(rPop.result.data, 'base64'));
  // Esforço: clicar num degrau troca (o menu fica aberto).
  await q(`R.querySelector('.cv-degrau[data-valor="high"]').click();`);
  await dormir(900);
  v = await q(`return { qual: R.querySelector('.cv-pop').hidden ? '' : R.querySelector('.cv-pop').dataset.qual, esf: R.querySelector('.cv-sel-modelo').dataset.esforco,
    val: R.querySelector('.cv-esf-val')?.textContent, on: R.querySelectorAll('.cv-pop .cv-degrau.cv-on').length };`);
  let srvS = (await (await fetch(BASE + '/estado')).json()).sessoes.find((s) => s.id === ocioso.id);
  conferir(v.qual === 'modelo' && v.esf === 'high' && v.val === 'Alto' && v.on === 3 && srvS?.controle?.esforco === 'high', 'degrau "Alto": o esforço vai ao servidor e o menu continua aberto', { v, srv: srvS?.controle?.esforco });
  // Setas: para baixo anda pelos modelos; Esc fecha só o menu e devolve o foco ao botão.
  await q(`R.querySelector('.cv-pop-i[data-valor="opus"]').focus();`);
  await tecla('ArrowDown', 'ArrowDown', 40);
  v = await q(`return document.activeElement?.dataset?.valor;`);
  conferir(v === 'fable', 'seta para baixo anda pela lista', v);
  await tecla('Escape', 'Escape', 27);
  v = await q(`return { pop: R.querySelector('.cv-pop').hidden, foco: document.activeElement === R.querySelector('.cv-sel-modelo'), painel: !R.hidden && !R.closest('[hidden]') };`);
  conferir(v.pop && v.foco && v.painel, 'Esc fecha só o menu e volta o foco ao botão', v);
  // Outras versões: Haiku 4.5 não tem esforço.
  await q(`R.querySelector('.cv-sel-modelo').click();`);
  await dormir(250);
  await q(`R.querySelector('.cv-pop-mais').click();`);
  await dormir(150);
  v = await q(`return [...R.querySelectorAll('.cv-pop-versoes .cv-pop-i')].map((i) => i.querySelector('.cv-pop-rot').textContent);`);
  conferir(v.length === 8 && v.includes('Haiku 4.5'), '"Outras versões" abre as versões fixas', v);
  await q(`R.querySelector('.cv-pop-i[data-valor="claude-haiku-4-5-20251001"]').click();`);
  await dormir(900);
  v = await q(`return { pop: R.querySelector('.cv-pop').hidden, valor: R.querySelector('.cv-sel-modelo').dataset.valor, rot: R.querySelector('.cv-sel-modelo .cv-sel-rot').textContent, nivel: R.querySelector('.cv-sel-modelo .cv-nivel').hidden };`);
  conferir(v.pop && v.valor === 'claude-haiku-4-5-20251001' && v.rot === 'Haiku 4.5' && v.nivel, 'escolher um modelo fecha o menu e troca o botão (sem degraus quando não há esforço)', v);
  await q(`R.querySelector('.cv-sel-modelo').click();`);
  await dormir(250);
  v = await q(`return { nao: R.querySelector('.cv-esf-nao')?.textContent, versoes: !!R.querySelector('.cv-pop-versoes'), degraus: R.querySelectorAll('.cv-degrau').length };`);
  conferir(/não tem nível de esforço/.test(v.nao || '') && v.versoes && !v.degraus, 'modelo sem esforço: o menu explica (e abre já nas outras versões)', v);
  await q(`R.querySelector('.cv-pop-i[data-valor="opus"]').click();`);
  await dormir(900);
  // ── menu do modo ──
  await q(`R.querySelector('.cv-sel-modo').click();`);
  await dormir(250);
  v = await q(`const its = [...R.querySelectorAll('.cv-pop .cv-pop-i[data-tipo="modo"]')]; return { qual: R.querySelector('.cv-pop').dataset.qual, n: its.length,
    descs: its.every((i) => (i.querySelector('.cv-pop-desc')?.textContent || '').length > 10), marcado: its.filter((i) => i.getAttribute('aria-checked') === 'true').map((i) => i.dataset.valor) };`);
  conferir(v.qual === 'modo' && v.n === 4 && v.descs && v.marcado.length === 1, 'menu do modo: quatro modos com descrição e um marcado', v);
  const cxPop2 = await q(`const r = R.querySelector('.cv-pop').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
  const rPop2 = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: cxPop2.x - 16, y: cxPop2.y - 16, width: cxPop2.w + 32, height: cxPop2.h + 110, scale: 2 } });
  fs.writeFileSync(path.join(SAIDA, '1c-menu-modo.png'), Buffer.from(rPop2.result.data, 'base64'));
  await av(`document.body.click()`);
  await dormir(150);
  conferir(!(await popAberto()), 'clique fora fecha o menu');
  await av(`document.querySelector('#pk-conversa .cv-texto').focus()`);

  await digitar('Rode os testes');
  v = await q(`return R.querySelector('.cv-enviar').getAttribute('aria-disabled');`);
  conferir(v === 'false', 'com texto: Enviar disponível', v);
  await foto('2-com-texto');
  await limparCampo();

  // ── menu ──
  await digitar('/');
  v = await q(`const m = R.querySelector('.cv-cmds'); const nomes = [...m.querySelectorAll('.cv-cmd-nome')].map((x) => x.textContent);
    return { aberto: !m.hidden, nomes, tits: [...m.querySelectorAll('.cv-cmds-tit')].map((x) => x.textContent), exp: R.querySelector('.cv-texto').getAttribute('aria-expanded'),
      ativo: R.querySelector('.cv-texto').getAttribute('aria-activedescendant'), descs: [...m.querySelectorAll('.cv-cmd-desc')].length };`);
  conferir(v.aberto && v.exp === 'true', '"/" abre o menu (aria-expanded)', v);
  conferir(v.nomes[0] === '/clear' && v.nomes.includes('/compact') && v.nomes.includes('/context') && v.nomes.includes('/code-review'), 'menu: comandos do Orbit, do Claude Code e skills', v.nomes);
  conferir(!v.nomes.some((n) => ['/status', '/fast'].includes(n)) && v.nomes.filter((n) => n === '/help').length === 1, 'menu: sem os que não respondem aqui e sem repetidos', v.nomes);
  conferir(v.tits.join('|') === 'Comandos|Skills e plugins', 'menu: dois grupos', v.tits);
  conferir(v.ativo === 'cv-cmd-0' && v.descs === v.nomes.length, 'primeiro item ativo e todos com descrição', v);
  await foto('3-menu', '#pk-conversa .cv-compor', 0);
  const cxMenu = await q(`const r = R.querySelector('.cv-cmds').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
  const r3 = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: cxMenu.x - 20, y: cxMenu.y - 20, width: cxMenu.w + 40, height: cxMenu.h + 200, scale: 2 } });
  fs.writeFileSync(path.join(SAIDA, '3-menu.png'), Buffer.from(r3.result.data, 'base64'));

  await digitar('co');
  v = await q(`return [...R.querySelectorAll('.cv-cmds .cv-cmd-nome')].map((x) => x.textContent);`);
  conferir(v[0] === '/compact' && v.includes('/context') && v.includes('/code-review'), '"/co" filtra (prefixo primeiro)', v);
  await tecla('ArrowDown', 'ArrowDown', 40);
  v = await q(`return { a: R.querySelector('.cv-texto').getAttribute('aria-activedescendant'), sel: R.querySelector('.cv-cmd[aria-selected="true"] .cv-cmd-nome').textContent };`);
  conferir(v.a === 'cv-cmd-1', 'seta para baixo move o ativo', v);
  await tecla('ArrowUp', 'ArrowUp', 38);
  await tecla('ArrowUp', 'ArrowUp', 38);
  v = await q(`return R.querySelector('.cv-cmd[aria-selected="true"]').dataset.i === String(R.querySelectorAll('.cv-cmd').length - 1);`);
  conferir(v, 'seta para cima no primeiro dá a volta no último');
  await tecla('Escape', 'Escape', 27);
  v = await q(`return { fechado: R.querySelector('.cv-cmds').hidden, texto: R.querySelector('.cv-texto').value, painel: !R.hidden };`);
  conferir(v.fechado && v.texto === '/co' && v.painel, 'Esc fecha só o menu (texto e painel ficam)', v);

  await limparCampo();
  await digitar('/comp');
  await tecla('Tab', 'Tab', 9);
  v = await q(`return { t: R.querySelector('.cv-texto').value, m: R.querySelector('.cv-cmds').hidden };`);
  conferir(v.t === '/compact ' && v.m, 'Tab completa "/compact " e fecha o menu', v);
  await limparCampo();

  await digitar('/limpa');
  v = await q(`return [...R.querySelectorAll('.cv-cmds .cv-cmd-nome')].map((x) => x.textContent);`);
  conferir(v[0] === '/clear', 'busca também pela descrição em português ("/limpa" acha /clear)', v);
  await limparCampo();
  await digitar('/xyzw');
  v = await q(`return R.querySelector('.cv-cmds-vazio')?.textContent || '';`);
  conferir(/Nenhum comando/.test(v), 'sem resultado: aviso no menu', v);
  await limparCampo();

  // ── comandos ──
  const nItens = () => q(`return R.querySelectorAll('.cv-itens > .cv-item').length;`);
  await digitar('/cont');
  await enter();
  for (let i = 0; i < 20 && !(await q(`return !!R.querySelector('.cv-saida');`)); i++) await dormir(300); // a 1ª acorda a instância
  v = await q(`const s = [...R.querySelectorAll('.cv-saida')].pop(); return { saida: !!s, md: !!s?.querySelector('table'), texto: R.querySelector('.cv-texto').value, cmd: [...R.querySelectorAll('.cv-comando code')].pop()?.textContent };`);
  conferir(v.saida && v.md && v.cmd === '/context' && v.texto === '', 'Enter no /context roda o comando e a saída aparece (markdown)', v);
  await av(`(() => { const l = document.querySelector('#pk-conversa .cv-lista'); l.scrollTop = l.scrollHeight; })()`);
  await dormir(300);
  await foto('4-saida-context', '#pk-conversa .cv-corpo');

  await digitar('/usage');
  await tecla('Escape', 'Escape', 27);
  await enter();
  await dormir(1200);
  v = await q(`const s = [...R.querySelectorAll('.cv-saida')].pop(); return { pre: s && !s.querySelector('.md') && /Current week/.test(s.textContent) };`);
  conferir(v.pre, '/usage (texto puro) aparece como veio', v);

  await digitar('/model sonnet');
  await enter();
  await dormir(1500);
  v = await q(`return { m: R.querySelector('.cv-sel-modelo').dataset.valor, t: R.querySelector('.cv-texto').value, n: [...R.querySelectorAll('.cv-usuario')].some((b) => /\\/model/.test(b.textContent)) };`);
  conferir(v.m === 'sonnet' && v.t === '' && !v.n, '/model sonnet troca o modelo do botão (sem virar mensagem)', v);
  await digitar('/effort low');
  await enter();
  await dormir(1500);
  v = await q(`return R.querySelector('.cv-sel-modelo').dataset.esforco;`);
  conferir(v === 'low', '/effort low troca o esforço', v);
  await digitar('/effort turbo');
  await enter();
  v = await q(`return { m: R.querySelector('.cv-motivo').textContent, t: R.querySelector('.cv-texto').value };`);
  conferir(/não existe/.test(v.m) && v.t === '/effort turbo', 'esforço inválido: explica e mantém o texto', v);
  await limparCampo();
  await digitar('/model nada');
  await enter();
  v = await q(`return R.querySelector('.cv-motivo').textContent;`);
  conferir(/Não achei o modelo/.test(v), 'modelo inválido: explica', v);
  await limparCampo();

  await digitar('/help');
  await tecla('Escape', 'Escape', 27);
  await enter();
  v = await q(`return { t: R.querySelector('.cv-texto').value, m: !R.querySelector('.cv-cmds').hidden };`);
  conferir(v.t === '/' && v.m, '/help abre o menu com todos os comandos', v);
  await limparCampo();

  await digitar('/clear');
  await enter();
  await dormir(500);
  v = await av(`(() => { const d = [...document.querySelectorAll('dialog[open], .confirmar, [role="alertdialog"]')].find((x) => x.getClientRects().length > 0 || x.open); return d ? d.textContent.slice(0, 200) : ''; })()`);
  conferir(/Limpar a conversa/.test(v), '/clear pede a confirmação do Orbit', v);
  await foto('5-confirmar-clear', 'body');
  await tecla('Escape', 'Escape', 27);
  await dormir(300);
  v = await q(`return R.querySelector('.cv-texto').value;`);
  conferir(v === '/clear', 'cancelar a limpeza mantém o texto', v);
  await limparCampo();

  const antes = await nItens();
  await digitar('/compact só o backend');
  await enter();
  await dormir(700);
  v = await q(`return R.querySelector('.cv-estado')?.textContent || '';`);
  conferir(/Compactando/.test(v), '/compact <foco> usa a ação do Orbit (faixa "Compactando")', v);
  await dormir(2500);
  conferir((await nItens()) > antes, 'a compactação chega na lista');

  // envio: estado "enviando" e depois desabilitado
  await digitar('Olá');
  await av(`window.__cvBusy = []; (() => { const b = document.querySelector('#pk-conversa .cv-enviar'); new MutationObserver(() => window.__cvBusy.push(b.classList.contains('cv-ocupado'))).observe(b, { attributes: true, attributeFilter: ['class'] }); })()`);
  await enter();
  await dormir(1200);
  v = await av(`window.__cvBusy`);
  conferir(v.includes(true) && v[v.length - 1] === false, 'Enviar mostra o giro enquanto envia e depois volta', v);

  // ── instância ocupada: Parar ──
  await abrir(ocupado.id);
  await dormir(500);
  v = await q(`const p = R.querySelector('.cv-b-parar'); return { p: !p.hidden, esc: p.getAttribute('aria-keyshortcuts'), tit: p.title };`);
  conferir(v.p && v.esc === 'Escape' && !/Esc/.test(v.tit), 'ocupada: Parar visível (o Esc segue no aria-keyshortcuts, sem dica no title)', v);
  await digitar('Mais uma coisa');
  v = await q(`return R.querySelector('.cv-enviar').title;`);
  conferir(/fila/.test(v), 'ocupada: Enviar avisa que entra na fila', v);
  await foto('6-ocupado');
  await limparCampo();

  // ── fora do Orbit: sem menu ──
  await abrir(leitura.id);
  await digitar('/');
  v = await q(`return { m: R.querySelector('.cv-cmds').hidden, sels: [...R.querySelectorAll('.cv-ajustes')].every((x) => x.hidden), pop: R.querySelector('.cv-pop').hidden };`);
  conferir(v.m && v.sels && v.pop, 'fora do Orbit: sem menu e sem seletores', v);
  await foto('7-fora-do-orbit');
  await limparCampo();

  // ── painel estreito ──
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir(ocioso.id);
  await dormir(400);
  v = await q(`const c = R.querySelector('.cv-campo').getBoundingClientRect(); const b = R.querySelector('.cv-barra'); return { cabe: b.scrollWidth <= b.clientWidth + 1, w: c.width };`);
  conferir(v.cabe, 'painel estreito: a barra cabe sem estourar', v);
  await foto('8-estreito');
  await digitar('/');
  await dormir(200);
  const cx = await q(`const r = R.querySelector('.cv-cmds').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
  const r8 = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: cx.x - 20, y: cx.y - 20, width: cx.w + 40, height: cx.h + 190, scale: 2 } });
  fs.writeFileSync(path.join(SAIDA, '9-menu-estreito.png'), Buffer.from(r8.result.data, 'base64'));

  conferir(!erros.length, 'sem erros no console', erros);
  await fecharEdge(pcdp, perfil);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e);
  await fecharEdge(pcdp, perfil).catch(() => {});
} finally {
  mock.kill();
}
console.log(`\n${ok} ok / ${falhas} falhas · capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
