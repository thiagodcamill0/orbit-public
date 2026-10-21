/* Ideias — bloco de notas (servidor: ideias.mjs; a nota fica na pasta de dados do Orbit).
 *
 * Integração: o index.html tem o item da lateral (e o botão da faixa estreita) com data-ideias e carrega
 * este arquivo depois do script principal. Da página se usa window.GerenciadorAPI.on('ideias' | 'conexao')
 * e, com as abas ligadas, window.Orbit.abrirIdeias() (abre a aba `ideias`, cujo provedor chama
 * Ideias.criarAba). Sem as abas, abre no painel à direita, como antes.
 *
 * Cada ideia é um editor rico (contenteditable) que grava sozinho numa pausa da digitação e ao sair dele.
 * Formatação: barra que aparece ao selecionar um trecho, Ctrl+B / Ctrl+I / Ctrl+U e Ctrl+Shift+H (destaque).
 * O texto vai para a nota em Markdown do Obsidian: **negrito**, *itálico*, ==destaque==, listas "- " e
 * "1. "; sublinhado, cor e tamanho vão como HTML (<u>, <span style="…">), que o Obsidian também mostra.
 * Texto vindo do servidor entra só por textContent (o editor é montado nó a nó, nunca por innerHTML).
 */
(function () {
  'use strict';

  const botoes = [...document.querySelectorAll('[data-ideias]')];
  if (!botoes.length) return;
  const api = window.GerenciadorAPI;

  // A página roda no navegador da própria máquina: no Mac, os atalhos mostrados são os do Mac (⌘) (16/10).
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const MS_EDITAR = 700; // pausa na digitação antes de gravar a edição
  const MS_CONFIRMAR = 3000;
  const CHAVE_RASCUNHO = 'gi.ideias.rascunho';

  // Cores e tamanhos da barra. "Padrão" tira a cor/tamanho. As cores são tons médios: legíveis no tema
  // escuro do Orbit e nos temas claro e escuro do Obsidian.
  const CORES = [
    { nome: 'Padrão', v: null },
    { nome: 'Cinza', v: '#8b8d98' },
    { nome: 'Vermelho', v: '#e5484d' },
    { nome: 'Laranja', v: '#f76b15' },
    { nome: 'Amarelo', v: '#e2a336' },
    { nome: 'Verde', v: '#30a46c' },
    { nome: 'Azul', v: '#3e8ef7' },
    { nome: 'Roxo', v: '#8e4ec6' },
  ];
  const TAMANHOS = [
    { nome: 'Pequeno', v: '0.85em', font: 2 },
    { nome: 'Normal', v: null, font: 3 },
    { nome: 'Grande', v: '1.25em', font: 5 },
    { nome: 'Título', v: '1.5em', font: 6 },
  ];
  const COR_SENTINELA = '#010203'; // o execCommand precisa de uma cor; esta quer dizer "sem cor" e sai na leitura
  const FONT_TAM = { 1: '0.75em', 2: '0.85em', 3: null, 4: '1.125em', 5: '1.25em', 6: '1.5em', 7: '2em' };
  const DESTAQUE = 'rgba(255, 208, 80, 0.3)'; // o mesmo do <mark> no CSS

  const st = { lista: [], carregado: false, antigo: false, visivel: false, modo: 'painel', salvando: 0, erro: '', nota: 'Ideias.md', confirmar: '' };
  const pendentes = new Map(); // anotadas que o servidor ainda não confirmou (id provisório → ideia)
  const ui = {};
  const itens = new Map(); // id → <li>
  let edicao = null; // { id, gravado, ed, t }
  let confirmarT = 0;
  let seq = 0;

  // ───────────────────────────── utilidades ─────────────────────────────
  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  function txt(el, v) {
    const t = v == null ? '' : String(v);
    if (el.textContent !== t) el.textContent = t;
  }

  const NS = 'http://www.w3.org/2000/svg';
  const ICONES = {
    x: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
    check: [['path', { d: 'M3.5 8.5l3 3 6-7' }]],
    lixeira: [['path', { d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2' }]],
    marca: [['path', { d: 'M9.6 2.6l3.8 3.8-5.6 5.6H4v-3.8z' }], ['path', { d: 'M2.5 14h11' }]],
    lista: [['path', { d: 'M6.5 4.5h7M6.5 8h7M6.5 11.5h7' }], ['circle', { cx: 3.2, cy: 4.5, r: '.6', fill: 'currentColor' }], ['circle', { cx: 3.2, cy: 8, r: '.6', fill: 'currentColor' }], ['circle', { cx: 3.2, cy: 11.5, r: '.6', fill: 'currentColor' }]],
    numerada: [['path', { d: 'M7 4.5h6.5M7 8h6.5M7 11.5h6.5' }], ['path', { d: 'M2.6 3.4l.9-.5v3.2M2.4 9.6c.2-.5 1.6-.6 1.6.2 0 .6-1.6 1.2-1.6 1.9H4' }]],
  };
  function icone(nome, tam = 16, traco = 1.5) {
    const v = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': traco, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const k in attrs) v.setAttribute(k, String(attrs[k]));
    for (const [t, a] of ICONES[nome] || []) {
      const e = document.createElementNS(NS, t);
      for (const k in a) e.setAttribute(k, String(a[k]));
      v.append(e);
    }
    return v;
  }

  const doisDig = (n) => String(n).padStart(2, '0');
  function carimbo(d = new Date()) {
    return `${d.getFullYear()}-${doisDig(d.getMonth() + 1)}-${doisDig(d.getDate())} ${doisDig(d.getHours())}:${doisDig(d.getMinutes())}`;
  }
  // "2026-10-15 18:42" → "hoje, 18:42" · "ontem, 09:10" · "12/10, 14:00" · "12/10/2025"
  function dataCurta(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(s || '');
    if (!m) return '';
    const hoje = new Date();
    const dia = new Date(+m[1], +m[2] - 1, +m[3]);
    const dif = Math.round((new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) - dia) / 864e5);
    const hora = m[4] ? ', ' + m[4] : '';
    if (dif === 0) return 'hoje' + hora;
    if (dif === 1) return 'ontem' + hora;
    if (+m[1] === hoje.getFullYear()) return `${m[3]}/${m[2]}${hora}`;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }
  function dataLonga(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(s || '');
    return m ? `Anotada em ${m[3]}/${m[2]}/${m[1]}${m[4] ? ' às ' + m[4] : ''}` : '';
  }

  function lerRascunho() { try { return localStorage.getItem(CHAVE_RASCUNHO) || ''; } catch { return ''; } }
  function gravarRascunho(v) { try { if (v) localStorage.setItem(CHAVE_RASCUNHO, v); else localStorage.removeItem(CHAVE_RASCUNHO); } catch {} }

  // ───────────────────────────── Markdown ⇄ blocos ─────────────────────────────
  // Bloco = { tipo: 'p' | 'ul' | 'ol', runs: [Run] }; Run = { t, b, i, u, h, c: cor | null, s: tamanho | null }.
  const MESMO = (a, b) => a.b === b.b && a.i === b.i && a.u === b.u && a.h === b.h && a.c === b.c && a.s === b.s;
  const PURO = { b: false, i: false, u: false, h: false, c: null, s: null };
  function juntar(runs) {
    const out = [];
    for (const r of runs) {
      if (!r.t) continue;
      const ult = out[out.length - 1];
      if (ult && MESMO(ult, r)) ult.t += r.t;
      else out.push({ ...r });
    }
    return out;
  }
  function hexDe(cor) {
    const c = String(cor || '').trim().toLowerCase();
    if (!c || c === 'inherit' || c === 'initial' || c === 'currentcolor' || c === 'transparent' || c === 'none') return null;
    let m = /^#([0-9a-f]{3})$/.exec(c);
    if (m) return '#' + m[1].split('').map((x) => x + x).join('');
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
    if (m) {
      if (m[4] != null && parseFloat(m[4]) === 0) return null;
      return '#' + [m[1], m[2], m[3]].map((x) => doisDig(Math.min(255, +x).toString(16))).join('');
    }
    return /^[a-z]+$/.test(c) ? c : null; // nome de cor (red, teal…)
  }
  function tamDe(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'medium' || s === '1em' || s === '100%' || s === 'inherit') return null;
    const kw = { 'x-small': '0.75em', small: '0.85em', smaller: '0.85em', large: '1.25em', larger: '1.25em', 'x-large': '1.5em', 'xx-large': '2em' };
    if (kw[s]) return kw[s];
    let m = /^(\d*\.?\d+)em$/.exec(s);
    if (m) return +m[1] === 1 ? null : +m[1] + 'em';
    m = /^(\d*\.?\d+)%$/.exec(s);
    if (m) return +m[1] === 100 ? null : +(m[1] / 100).toFixed(3) + 'em';
    m = /^(\d*\.?\d+)px$/.exec(s);
    if (m) { const em = +(m[1] / 13.5).toFixed(2); return Math.abs(em - 1) < 0.04 ? null : em + 'em'; }
    return null;
  }
  function estiloSpan(style) {
    const out = {};
    for (const parte of String(style || '').split(';')) {
      const i = parte.indexOf(':');
      if (i < 0) continue;
      const k = parte.slice(0, i).trim().toLowerCase(), v = parte.slice(i + 1).trim();
      if (k === 'color') out.c = hexDe(v);
      else if (k === 'font-size') out.s = tamDe(v);
      else if (k === 'background-color' || k === 'background') out.h = !!hexDe(v);
      else if (k === 'font-weight') out.b = /bold|[6-9]00/.test(v);
      else if (k === 'font-style') out.i = /italic|oblique/.test(v);
      else if (k === 'text-decoration' || k === 'text-decoration-line') out.u = /underline/.test(v);
    }
    return out;
  }
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

  // Texto de uma linha (Markdown inline) → runs. Lê o que o próprio Orbit escreve e o que costuma vir à mão.
  function inline(s) {
    const runs = [];
    const pilha = []; // { k: 'b' | 'i' | 'h' | 'tag', tag?, marca?, estilo? }
    const estilo = () => {
      const e = { ...PURO };
      for (const f of pilha) {
        if (f.k === 'b' || f.k === 'i' || f.k === 'h') e[f.k] = true;
        else if (f.estilo) for (const k in f.estilo) if (f.estilo[k] !== undefined) e[k] = f.estilo[k];
      }
      return e;
    };
    let buf = '';
    const soltar = () => { if (buf) runs.push({ t: buf, ...estilo() }); buf = ''; };
    const aberto = (k, marca) => pilha.findIndex((f) => f.k === k && (!marca || f.marca === marca));
    const fechar = (idx) => { soltar(); pilha.splice(idx, 1); };
    const abrir = (f) => { soltar(); pilha.push(f); };
    const ehEsp = (c) => c === undefined || /\s/.test(c);
    const ehAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (c === '&') {
        const m = /^&(amp|lt|gt|quot|apos|nbsp|#39);/i.exec(s.slice(i));
        if (m) { buf += ENT[m[1].toLowerCase()]; i += m[0].length; continue; }
      }
      if (c === '<') {
        const m = /^<(\/?)(u|b|strong|i|em|mark|span|font|br|ins)\b([^<>]*)>/i.exec(s.slice(i));
        if (m) {
          const tag = m[2].toLowerCase(), attrs = m[3];
          i += m[0].length;
          if (tag === 'br') continue;
          if (m[1]) {
            let idx = -1;
            for (let k = pilha.length - 1; k >= 0; k--) if (pilha[k].k === 'tag' && pilha[k].tag === tag) { idx = k; break; }
            if (idx >= 0) fechar(idx);
            continue;
          }
          let e = {};
          if (tag === 'u' || tag === 'ins') e = { u: true };
          else if (tag === 'b' || tag === 'strong') e = { b: true };
          else if (tag === 'i' || tag === 'em') e = { i: true };
          else if (tag === 'mark') e = { h: true };
          else {
            const sm = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
            if (sm) e = estiloSpan(sm[2] ?? sm[3]);
            if (tag === 'font') {
              const cm = /color\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
              const zm = /size\s*=\s*["']?(\d)/i.exec(attrs);
              if (cm) e.c = hexDe(cm[1]);
              if (zm) e.s = FONT_TAM[zm[1]] ?? null;
            }
          }
          abrir({ k: 'tag', tag, estilo: e });
          continue;
        }
      }
      if (c === '*' || c === '_') {
        let n = 1;
        while (s[i + n] === c) n++;
        const ant = s[i - 1], dep = s[i + n];
        const intra = c === '_' && ehAlnum(ant) && ehAlnum(dep);
        let resto = n;
        if (!intra && !ehEsp(ant)) {
          // fecha primeiro o mais de dentro
          for (let volta = 0; volta < 2 && resto; volta++) {
            const ib = aberto('b', c), ii = aberto('i', c);
            const dentro = ib > ii ? 'b' : ii > ib ? 'i' : null;
            if (dentro === 'i' && resto >= 1) { fechar(ii); resto -= 1; }
            else if (dentro === 'b' && resto >= 2) { fechar(ib); resto -= 2; }
            else if (dentro === 'b' && ii >= 0) { fechar(ii); resto -= 1; }
            else break;
          }
        }
        if (resto && !intra && !ehEsp(dep)) {
          const depois = s.slice(i + n);
          if (resto >= 2 && aberto('b', c) < 0 && depois.includes(c + c)) { abrir({ k: 'b', marca: c }); resto -= 2; }
          if (resto >= 1 && aberto('i', c) < 0 && depois.includes(c)) { abrir({ k: 'i', marca: c }); resto -= 1; }
        }
        buf += c.repeat(resto);
        i += n;
        continue;
      }
      if (c === '=' && s[i + 1] === '=') {
        const ant = s[i - 1], dep = s[i + 2];
        const ih = aberto('h');
        if (ih >= 0 && !ehEsp(ant)) { fechar(ih); i += 2; continue; }
        if (ih < 0 && !ehEsp(dep) && s.indexOf('==', i + 2) > 0) { abrir({ k: 'h' }); i += 2; continue; }
      }
      buf += c;
      i++;
    }
    soltar();
    return juntar(runs);
  }

  const LISTA_UL = /^\s*[-*+](?: (.*)|$)/, LISTA_OL = /^\s*\d{1,9}[.)](?: (.*)|$)/;
  function paraBlocos(md) {
    const linhas = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    return linhas.map((l) => {
      let m = LISTA_UL.exec(l);
      if (m) return { tipo: 'ul', runs: inline(m[1] || '') };
      m = LISTA_OL.exec(l);
      if (m) return { tipo: 'ol', runs: inline(m[1] || '') };
      return { tipo: 'p', runs: inline(l.replace(/^\s+/, '')) };
    });
  }

  // Escapa o que o Markdown/Obsidian leria como marcação.
  function escapar(t) {
    return t
      .replace(/\\/g, '\\\\')
      .replace(/[*_`$]/g, '\\$&')
      .replace(/=(?==)|(?<==)=/g, '\\=')
      .replace(/~(?=~)|(?<=~)~/g, '\\~')
      .replace(/%(?=%)|(?<=%)%/g, '\\%')
      .replace(/<(?=[a-zA-Z/!])/g, '\\<')
      .replace(/&(?=#?[a-zA-Z0-9]+;)/g, '\\&')
      .replace(/\u00a0/g, ' ');
  }
  function abreSpan(r) {
    const css = [];
    if (r.c) css.push('color:' + r.c);
    if (r.s) css.push('font-size:' + r.s);
    return `<span style="${css.join('; ')}">`;
  }
  // Runs → Markdown. As marcas abrem de fora para dentro (span, u, ==, **, *) e só fecham o que muda,
  // com os espaços das pontas fora das marcas (senão o Obsidian não reconhece o fechamento).
  function linhaMd(runs) {
    let out = '';
    const pilha = []; // [{ k, v, fecha }]
    const fecharAte = (n) => {
      if (pilha.length <= n) return;
      const esp = /\s*$/.exec(out)[0];
      out = out.slice(0, out.length - esp.length);
      while (pilha.length > n) out += pilha.pop().fecha;
      out += esp;
    };
    const lista = juntar(runs.map((r) => ({ ...r, t: r.t.replace(/\n/g, ' ') })));
    lista.forEach((r, idx) => {
      // Trecho só de espaço não muda a formatação: herda a do vizinho.
      const so = !r.t.trim();
      const alvo = so ? (lista[idx - 1] || lista[idx + 1] || PURO) : r;
      const quero = [];
      if (alvo.c || alvo.s) quero.push({ k: 'span', v: (alvo.c || '') + '|' + (alvo.s || ''), abre: abreSpan(alvo), fecha: '</span>' });
      if (alvo.u) quero.push({ k: 'u', abre: '<u>', fecha: '</u>' });
      if (alvo.h) quero.push({ k: 'h', abre: '==', fecha: '==' });
      if (alvo.b) quero.push({ k: 'b', abre: '**', fecha: '**' });
      if (alvo.i) quero.push({ k: 'i', abre: '*', fecha: '*' });
      let igual = 0;
      while (igual < pilha.length && igual < quero.length && pilha[igual].k === quero[igual].k && pilha[igual].v === quero[igual].v) igual++;
      const t = escapar(r.t);
      const ini = /^\s*/.exec(t)[0];
      out += ini;
      fecharAte(igual);
      for (let k = igual; k < quero.length; k++) { out += quero[k].abre; pilha.push(quero[k]); }
      out += t.slice(ini.length);
    });
    fecharAte(0);
    return out.replace(/\s+$/, '');
  }
  function deBlocos(blocos) {
    const out = [];
    let n = 0;
    blocos.forEach((b, k) => {
      const corpo = linhaMd(b.runs);
      const ant = blocos[k - 1];
      if (b.tipo === 'ol') n = ant && ant.tipo === 'ol' ? n + 1 : 1;
      if (b.tipo === 'p') {
        // Parágrafo logo depois de uma lista precisa de uma linha vazia, senão vira continuação do item.
        if (ant && ant.tipo !== 'p' && corpo) out.push('');
        out.push(corpo.replace(/^([-*+])(?= |$)/, '\\$1').replace(/^(\d{1,9})([.)])(?= |$)/, '$1\\$2').replace(/^([#>])/, '\\$1'));
      } else out.push((b.tipo === 'ul' ? '- ' : n + '. ') + corpo);
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  // Blocos → nós do editor (nó a nó, sem innerHTML).
  function nosDe(runs) {
    if (!runs.length) return [h('br')];
    return runs.map((r) => {
      let n = document.createTextNode(r.t);
      if (r.i) n = h('em', null, n);
      if (r.b) n = h('strong', null, n);
      if (r.h) n = h('mark', null, n);
      if (r.u) n = h('u', null, n);
      if (r.c || r.s) {
        const sp = h('span', null, n);
        if (r.c) sp.style.color = r.c;
        if (r.s) sp.style.fontSize = r.s;
        n = sp;
      }
      return n;
    });
  }
  function desenhar(el, md) {
    const blocos = paraBlocos(md);
    // Linhas vazias depois de uma lista (separador que o Markdown pede) não viram linha no editor.
    const vis = blocos.filter((b, k) => !(b.tipo === 'p' && !b.runs.length && blocos[k - 1] && blocos[k - 1].tipo !== 'p' && blocos[k + 1] && blocos[k + 1].tipo === 'p' && blocos[k + 1].runs.length));
    const nos = [];
    for (const b of vis) {
      if (b.tipo === 'p') { nos.push(h('div', null, ...nosDe(b.runs))); continue; }
      const ult = nos[nos.length - 1];
      const lista = ult && ult.tagName === b.tipo.toUpperCase() ? ult : h(b.tipo);
      lista.append(h('li', null, ...nosDe(b.runs)));
      if (lista !== ult) nos.push(lista);
    }
    el.replaceChildren(...nos);
  }

  // DOM do editor → blocos. Lê o que o navegador produz no contenteditable (b, i, u, font, span com estilo…).
  function estiloDe(no, raiz) {
    const cadeia = [];
    for (let e = no.parentElement; e && e !== raiz; e = e.parentElement) cadeia.unshift(e);
    const r = { ...PURO };
    for (const e of cadeia) {
      const t = e.tagName;
      if (t === 'B' || t === 'STRONG') r.b = true;
      else if (t === 'I' || t === 'EM') r.i = true;
      else if (t === 'U' || t === 'INS') r.u = true;
      else if (t === 'MARK') r.h = true;
      else if (t === 'FONT') {
        if (e.getAttribute('color')) r.c = hexDe(e.getAttribute('color'));
        if (e.getAttribute('size')) r.s = FONT_TAM[e.getAttribute('size')] ?? null;
      }
      if (e.style && e.style.cssText) {
        const x = estiloSpan(e.style.cssText);
        for (const k in x) if (x[k] !== undefined) r[k] = x[k];
      }
    }
    if (r.c === COR_SENTINELA) r.c = null;
    return r;
  }
  const BLOCOS_DOM = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE)$/;
  function blocosDoDom(raiz) {
    const out = [];
    let cur = null;
    const novo = (tipo) => { cur = { tipo, runs: [] }; out.push(cur); };
    const andar = (no, lista) => {
      for (const n of no.childNodes) {
        if (n.nodeType === 3) {
          // Com white-space: pre-wrap o Shift+Enter do Chromium escreve "\n" no texto (e n\u00e3o <br>): \u00e9 quebra de linha.
          const partes = n.data.replace(/\u200b/g, '').replace(/\r\n?/g, '\n').split('\n');
          const est = estiloDe(n, raiz);
          partes.forEach((t, k) => {
            if (k) { if (!cur) novo(lista || 'p'); cur = null; }
            if (!t) return;
            if (!cur) novo(lista || 'p');
            cur.runs.push({ t, ...est });
          });
        } else if (n.nodeType === 1) {
          const tag = n.tagName;
          if (tag === 'BR') { if (!cur) novo(lista || 'p'); cur = null; }
          else if (tag === 'UL' || tag === 'OL') { cur = null; andar(n, tag.toLowerCase()); cur = null; }
          else if (BLOCOS_DOM.test(tag)) {
            cur = null;
            const antes = out.length;
            andar(n, tag === 'LI' ? lista || 'ul' : lista);
            if (tag === 'LI' && out.length === antes) novo(lista || 'ul'); // item vazio
            cur = null;
          } else andar(n, lista);
        }
      }
    };
    andar(raiz, null);
    for (const b of out) b.runs = juntar(b.runs);
    return out;
  }
  const mdDoEditor = (el) => deBlocos(blocosDoDom(el));

  // ───────────────────────────── editor ─────────────────────────────
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch {}
  function criarEditor(o) {
    const el = h('div', { class: 'id-ed' + (o.classe ? ' ' + o.classe : ''), contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': o.rotulo, spellcheck: 'true', 'data-placeholder': o.placeholder || '' });
    const vazio = () => el.classList.toggle('sem-texto', !el.textContent.trim() && !el.querySelector('li'));
    el.addEventListener('input', () => { vazio(); if (o.aoMudar) o.aoMudar(); });
    el.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) {
        e.preventDefault();
        e.stopPropagation();
        formatar({ b: 'bold', i: 'italic', u: 'underline' }[k]);
        return;
      }
      if (mod && e.shiftKey && k === 'h') { e.preventDefault(); e.stopPropagation(); formatar('destaque'); return; }
      if (o.aoTeclar) o.aoTeclar(e);
    });
    // Colar entra como texto (sem a formatação de outro lugar); as quebras de linha ficam.
    el.addEventListener('paste', (e) => {
      const t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (t == null) return;
      e.preventDefault();
      document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
    });
    el.addEventListener('drop', (e) => e.preventDefault());
    return {
      el,
      valor: () => mdDoEditor(el),
      definir: (md) => { desenhar(el, md); vazio(); },
      vazio: () => !el.textContent.trim() && !el.querySelector('li'),
    };
  }
  function cursorNoFim(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function editorDaSelecao() {
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    const n = s.anchorNode;
    const e = n && (n.nodeType === 1 ? n : n.parentElement);
    const ed = e && e.closest('.id-ed');
    return ed && ui.vista && ui.vista.contains(ed) ? ed : null;
  }
  function noCursor() {
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    let n = s.getRangeAt(0).startContainer;
    if (n.nodeType === 1 && n.childNodes[s.getRangeAt(0).startOffset]) n = n.childNodes[s.getRangeAt(0).startOffset];
    return n.nodeType === 3 ? n : n.firstChild && n.firstChild.nodeType === 3 ? n.firstChild : n;
  }
  function estiloAtual() {
    const ed = editorDaSelecao(), n = noCursor();
    if (!ed || !n) return { ...PURO };
    return n.nodeType === 3 ? estiloDe(n, ed) : estiloDe(h('span'), ed);
  }

  // Aplica a formatação na seleção (execCommand: o desfazer do navegador continua valendo).
  function formatar(acao, valor) {
    const ed = editorDaSelecao();
    if (!ed) return;
    try { document.execCommand('styleWithCSS', false, acao === 'destaque' || acao === 'cor'); } catch {}
    if (acao === 'destaque') {
      const tem = estiloAtual().h;
      document.execCommand('hiliteColor', false, tem ? 'transparent' : DESTAQUE);
      if (tem) limparMarks(ed);
    } else if (acao === 'cor') document.execCommand('foreColor', false, valor || COR_SENTINELA);
    else if (acao === 'tamanho') document.execCommand('fontSize', false, String(valor));
    else document.execCommand(acao, false, null);
    try { document.execCommand('styleWithCSS', false, false); } catch {}
    normalizar(ed);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    atualizarBarra();
  }
  // O execCommand escreve <font size> (tamanho absoluto) e <font color>: viram <span> com em, como na nota.
  // A cor sentinela ("Padrão") sai na hora.
  function normalizar(ed) {
    for (const f of [...ed.querySelectorAll('font')]) {
      const sp = h('span');
      const c = f.getAttribute('color'), z = f.getAttribute('size');
      if (c && hexDe(c) !== COR_SENTINELA) sp.style.color = hexDe(c) || c;
      if (z && FONT_TAM[z]) sp.style.fontSize = FONT_TAM[z];
      if (f.style.cssText) sp.style.cssText += ';' + f.style.cssText;
      sp.append(...f.childNodes);
      f.replaceWith(sp);
    }
    for (const e of [...ed.querySelectorAll('[style]')]) {
      if (hexDe(e.style.color) === COR_SENTINELA) e.style.removeProperty('color');
      if (!e.getAttribute('style').trim()) e.removeAttribute('style');
      if (e.tagName === 'SPAN' && !e.attributes.length) e.replaceWith(...e.childNodes);
    }
  }
  // Tirar o destaque de um trecho que veio como <mark>: o transparent do execCommand não vence o fundo do <mark>.
  function limparMarks(ed) {
    const s = getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    for (const m of [...ed.querySelectorAll('mark')]) {
      if (!r.intersectsNode(m)) continue;
      const sp = h('span');
      sp.style.backgroundColor = 'transparent';
      sp.append(...m.childNodes);
      m.replaceWith(sp);
    }
  }

  // ───────────────────────────── barra de formatação ─────────────────────────────
  function montarBarra() {
    const bt = (acao, rot, atalho, conteudo, classe) => h('button', { type: 'button', class: 'idb-bt' + (classe ? ' ' + classe : ''), 'data-acao': acao, title: rot + (atalho ? ' (' + atalho + ')' : ''), 'aria-label': rot, 'aria-pressed': 'false' }, conteudo);
    ui.corTraco = h('i', { class: 'idb-cor-traco' });
    ui.barra = h('div', { class: 'idb', role: 'toolbar', 'aria-label': 'Formatação', hidden: true },
      bt('bold', 'Negrito', MAC ? '⌘B' : 'Ctrl+B', h('b', { text: 'B' })),
      bt('italic', 'Itálico', MAC ? '⌘I' : 'Ctrl+I', h('i', { text: 'I' })),
      bt('underline', 'Sublinhado', MAC ? '⌘U' : 'Ctrl+U', h('u', { text: 'U' })),
      bt('destaque', 'Marca-texto', MAC ? '⇧⌘H' : 'Ctrl+Shift+H', icone('marca', 15)),
      h('span', { class: 'idb-sep', 'aria-hidden': 'true' }),
      bt('cores', 'Cor do texto', '', h('span', { class: 'idb-cor' }, h('span', { text: 'A' }), ui.corTraco), 'idb-menu'),
      bt('tamanhos', 'Tamanho do texto', '', h('span', { class: 'idb-tam', text: 'Aa' }), 'idb-menu'),
      h('span', { class: 'idb-sep', 'aria-hidden': 'true' }),
      bt('insertUnorderedList', 'Lista', '', icone('lista', 15)),
      bt('insertOrderedList', 'Lista numerada', '', icone('numerada', 15)));
    ui.sub = h('div', { class: 'idb idb-sub', role: 'menu', hidden: true });
    // mousedown sem padrão: a seleção do editor não se perde ao clicar na barra.
    for (const el of [ui.barra, ui.sub]) el.addEventListener('mousedown', (e) => e.preventDefault());
    ui.barra.addEventListener('click', (e) => {
      const b = e.target.closest('[data-acao]');
      if (!b) return;
      const a = b.dataset.acao;
      if (a === 'cores' || a === 'tamanhos') abrirSub(a, b);
      else { fecharSub(); formatar(a); }
    });
    ui.sub.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const tipo = ui.sub.dataset.tipo;
      if (tipo === 'cores') formatar('cor', b.dataset.v || null);
      else formatar('tamanho', b.dataset.v);
      fecharSub();
    });
    document.body.append(ui.barra, ui.sub);
    document.addEventListener('selectionchange', () => atualizarBarra());
    document.addEventListener('focusout', () => setTimeout(atualizarBarra, 0)); // sair do editor nem sempre muda a seleção
    window.addEventListener('resize', () => esconderBarra());
    document.addEventListener('scroll', () => { if (!ui.barra.hidden) posicionarBarra(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ui.sub.hidden) { e.preventDefault(); e.stopPropagation(); fecharSub(); } }, true);
  }
  function abrirSub(tipo, ancora) {
    if (!ui.sub.hidden && ui.sub.dataset.tipo === tipo) { fecharSub(); return; }
    const atual = estiloAtual();
    ui.sub.dataset.tipo = tipo;
    if (tipo === 'cores') {
      ui.sub.replaceChildren(...CORES.map((c) => {
        const b = h('button', { type: 'button', class: 'idb-amostra' + (c.v ? '' : ' padrao'), role: 'menuitemradio', 'data-v': c.v || '', title: c.nome, 'aria-label': c.nome, 'aria-checked': String((atual.c || null) === c.v) });
        if (c.v) b.style.setProperty('--amostra', c.v);
        return b;
      }));
    } else {
      ui.sub.replaceChildren(...TAMANHOS.map((t) => {
        const b = h('button', { type: 'button', class: 'idb-opcao', role: 'menuitemradio', 'data-v': String(t.font), 'aria-checked': String((atual.s || null) === t.v), text: t.nome });
        if (t.v) b.style.fontSize = t.v === '1.5em' ? '15px' : t.v === '1.25em' ? '13.5px' : '11px';
        return b;
      }));
    }
    ui.sub.hidden = false;
    const r = ancora.getBoundingClientRect(), w = ui.sub.offsetWidth;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    const cima = ui.barra.dataset.lado === 'baixo';
    ui.sub.style.left = x + 'px';
    ui.sub.style.top = (cima ? r.bottom + 6 : r.top - ui.sub.offsetHeight - 6) + 'px';
    if (ui.sub.getBoundingClientRect().top < 4) ui.sub.style.top = r.bottom + 6 + 'px';
  }
  function fecharSub() { if (ui.sub) ui.sub.hidden = true; }
  function esconderBarra() { if (ui.barra) ui.barra.hidden = true; fecharSub(); }
  function posicionarBarra() {
    const s = getSelection();
    if (!s.rangeCount) return;
    const rs = s.getRangeAt(0).getClientRects();
    const r = rs.length ? rs[0] : s.getRangeAt(0).getBoundingClientRect();
    const w = ui.barra.offsetWidth, hb = ui.barra.offsetHeight;
    let y = r.top - hb - 8, lado = 'cima';
    if (y < 6) { y = (rs.length ? rs[rs.length - 1].bottom : r.bottom) + 8; lado = 'baixo'; }
    ui.barra.dataset.lado = lado;
    ui.barra.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
    ui.barra.style.top = y + 'px';
  }
  function atualizarBarra() {
    if (!ui.barra) return;
    const s = getSelection();
    const ed = editorDaSelecao();
    if (!ed || !ed.contains(document.activeElement) || !s || s.isCollapsed || !s.toString().trim() || !st.visivel) { if (!ui.barra.hidden) esconderBarra(); return; }
    const est = estiloAtual();
    const marcar = (a, v) => { const b = ui.barra.querySelector(`[data-acao="${a}"]`); if (b) b.setAttribute('aria-pressed', String(!!v)); };
    let ul = false, ol = false;
    try { ul = document.queryCommandState('insertUnorderedList'); ol = document.queryCommandState('insertOrderedList'); } catch {}
    marcar('bold', est.b); marcar('italic', est.i); marcar('underline', est.u); marcar('destaque', est.h);
    marcar('insertUnorderedList', ul); marcar('insertOrderedList', ol);
    ui.corTraco.style.background = est.c || '';
    const nova = ui.barra.hidden;
    ui.barra.hidden = false;
    posicionarBarra();
    if (nova) fecharSub();
  }

  // ───────────────────────────── servidor ─────────────────────────────
  async function postar(caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, { method: 'POST', cache: 'no-store', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    } catch {
      throw new Error('Sem conexão com o servidor do Orbit.');
    }
    let d = null;
    try { d = await r.json(); } catch {}
    if (r.status === 404 && !(d && /ideia/i.test(d.erro || ''))) { st.antigo = true; throw new Error('Reinicie o servidor do Orbit para ativar as ideias.'); }
    if (!r.ok) throw new Error((d && typeof d.erro === 'string' && d.erro) || 'O servidor do Orbit respondeu ' + r.status + '.');
    return d;
  }

  // Toda gravação passa por aqui: conta as que estão no ar (o SSE espera) e mostra o estado no pé.
  async function gravar(caminho, corpo) {
    st.salvando++;
    st.erro = '';
    renderPe();
    try {
      return await postar(caminho, corpo);
    } catch (e) {
      st.erro = e.message;
      if (/não está mais na nota/.test(e.message)) carregar();
      throw e;
    } finally {
      st.salvando--;
      renderPe();
    }
  }

  async function carregar() {
    try {
      const r = await fetch('/ideias', { cache: 'no-store' });
      if (r.status === 404) { st.antigo = true; st.carregado = true; render(); return; }
      if (!r.ok) return;
      const d = await r.json();
      st.antigo = false;
      st.carregado = true;
      if (d && typeof d.nota === 'string') st.nota = d.nota;
      if (!st.salvando) aplicar(d.ideias);
    } catch {}
  }

  function aplicar(lista) {
    if (!Array.isArray(lista)) return;
    st.lista = [...[...pendentes.values()].reverse(), ...lista.filter((x) => x && typeof x.id === 'string')];
    // A ideia em edição fica com o texto da tela até sair do editor.
    if (edicao) { const it = st.lista.find((x) => x.id === edicao.id); if (it) it.texto = edicao.gravado; }
    st.carregado = true;
    render();
  }

  // ───────────────────────────── ações ─────────────────────────────
  function anotar() {
    const texto = ui.campo.valor();
    if (!texto.trim() || st.antigo) return;
    const prov = { id: 'tmp-' + ++seq, texto, data: carimbo(), feita: false, pendente: true };
    pendentes.set(prov.id, prov);
    st.lista.unshift(prov);
    ui.campo.definir('');
    gravarRascunho('');
    render();
    ui.lista.scrollTop = 0;
    gravar('/ideias/nova', { texto }).then((d) => {
      pendentes.delete(prov.id);
      aplicar(d.ideias);
    }).catch(() => {
      pendentes.delete(prov.id);
      st.lista = st.lista.filter((x) => x !== prov);
      if (ui.campo.vazio()) { ui.campo.definir(texto); gravarRascunho(texto); }
      render();
    });
  }

  function alternarFeita(id) {
    const it = st.lista.find((x) => x.id === id);
    if (!it || it.pendente) return;
    it.feita = !it.feita;
    render();
    gravar('/ideias/feita', { id, feita: it.feita }).then((d) => aplicar(d.ideias)).catch(() => carregar());
  }

  function apagar(id, botao) {
    const it = st.lista.find((x) => x.id === id);
    if (!it || it.pendente) return;
    if (st.confirmar !== id) {
      st.confirmar = id;
      clearTimeout(confirmarT);
      confirmarT = setTimeout(() => { st.confirmar = ''; render(); }, MS_CONFIRMAR);
      render();
      return;
    }
    clearTimeout(confirmarT);
    st.confirmar = '';
    if (edicao && edicao.id === id) { clearTimeout(edicao.t); edicao = null; }
    const li = itens.get(id);
    const vizinho = li && (li.nextElementSibling || li.previousElementSibling);
    st.lista = st.lista.filter((x) => x !== it);
    render();
    // O foco não se perde com a linha: vai para a vizinha, ou para o campo.
    if (botao && document.activeElement === document.body) {
      const alvo = vizinho && vizinho.isConnected && vizinho.querySelector('.id-apagar');
      (alvo || ui.campo.el).focus({ preventScroll: true });
    }
    gravar('/ideias/apagar', { id }).then((d) => aplicar(d.ideias)).catch(() => carregar());
  }

  // Edição no lugar: cada ideia é um editor; grava sozinha numa pausa da digitação e ao sair dele.
  function comecarEdicao(li) {
    const id = li.dataset.id;
    const it = st.lista.find((x) => x.id === id);
    if (!it || it.pendente) return;
    if (edicao && edicao.id === id) return;
    if (edicao) terminarEdicao();
    edicao = { id, gravado: it.texto, ed: li._ed, t: 0, mudou: false };
  }
  function gravarEdicao() {
    if (!edicao) return Promise.resolve();
    const ed = edicao;
    clearTimeout(ed.t);
    if (!ed.mudou) return Promise.resolve();
    const t = ed.ed.valor();
    if (!t.trim() || t === ed.gravado) return Promise.resolve();
    ed.gravado = t;
    const it = st.lista.find((x) => x.id === ed.id);
    if (it) it.texto = t;
    return gravar('/ideias/editar', { id: ed.id, texto: t }).then((d) => {
      // Linha escrita à mão na nota ganha id próprio na primeira mudança.
      if (d.id && d.id !== ed.id) {
        const li = itens.get(ed.id);
        itens.delete(ed.id);
        if (li) { li.dataset.id = d.id; itens.set(d.id, li); }
        ed.id = d.id;
      }
      aplicar(d.ideias);
    }).catch(() => { ed.gravado = ''; });
  }
  // Ao sair: grava o que faltou e redesenha no formato da nota. Vazio volta ao texto de antes (apagar é na lixeira).
  function terminarEdicao() {
    if (!edicao) return;
    const ed = edicao;
    if (ed.ed.valor().trim()) gravarEdicao();
    edicao = null;
    const it = st.lista.find((x) => x.id === ed.id);
    if (it) { ed.ed.definir(it.texto); ed.ed.el.dataset.md = it.texto; }
    render();
  }

  // ───────────────────────────── vista ─────────────────────────────
  function montar() {
    ui.campo = criarEditor({
      rotulo: 'Nova ideia', placeholder: 'Anotar uma ideia…', classe: 'id-novo',
      aoMudar: () => gravarRascunho(ui.campo.valor()),
      aoTeclar: (e) => {
        // Enter anota; Shift+Enter quebra a linha; numa lista, Enter faz o próximo item (Ctrl+Enter anota).
        if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
        const n = noCursor();
        const naLista = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('li');
        if (naLista && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        anotar();
      },
    });
    ui.campo.definir(lerRascunho());
    ui.n = h('span', { class: 'id-n' });
    ui.fechar = h('button', { class: 'id-fechar', type: 'button', title: 'Fechar', 'aria-label': 'Fechar as ideias', onclick: () => fechar(true) }, icone('x', 15));
    ui.lista = h('ul', { class: 'id-lista', 'aria-label': 'Ideias anotadas' });
    ui.vazio = h('p', { class: 'id-vazio', text: 'Nada anotado ainda. Escreva acima e aperte Enter.' });
    ui.peTxt = h('span');
    ui.pe = h('footer', { class: 'id-pe', 'aria-live': 'polite' }, h('i', { 'aria-hidden': 'true' }), ui.peTxt);
    ui.dica = h('p', { class: 'id-dica', text: 'Enter anota · Shift+Enter quebra a linha · selecione um trecho para formatar' });
    // tabindex -1: ao abrir, o foco vai para a vista (o teclado segue nela); o campo só ganha foco no clique ou no Tab.
    ui.vista = h('div', { class: 'ideias-vista', tabindex: '-1' },
      h('header', { class: 'id-cab' }, h('span', { class: 'id-tit', text: 'Ideias' }), ui.n, ui.fechar),
      h('div', { class: 'id-campo' }, ui.campo.el, ui.dica),
      ui.lista, ui.vazio, ui.pe);
    ui.raiz = h('aside', { id: 'ideias', class: 'ideias', role: 'dialog', 'aria-label': 'Ideias', hidden: true }, ui.vista);
    ui.raiz.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && st.modo === 'painel') { e.preventDefault(); fechar(true); }
    });
    // Esc num editor só sai dele (a gravação já foi feita); no painel, o Esc seguinte fecha.
    ui.vista.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const ed = e.target.closest && e.target.closest('.id-item .id-ed');
      if (!ed) return;
      e.preventDefault();
      e.stopPropagation();
      ed.closest('.id-item').focus({ preventScroll: true });
    });
    document.body.append(ui.raiz);
    montarBarra();
    for (const b of botoes) b.addEventListener('click', () => alternar());
  }

  // Com as abas do Orbit, abre (ou ativa) a aba `ideias`; sem elas, o painel lateral.
  function abrirAba() {
    try { return !!(window.Orbit && typeof window.Orbit.abrirIdeias === 'function' && window.Orbit.abrirIdeias()); } catch (e) { console.warn('ideias', e); return false; }
  }
  function abrir() {
    if (abrirAba()) return;
    if (st.visivel) { ui.vista.focus({ preventScroll: true }); return; }
    st.modo = 'painel';
    ui.raiz.append(ui.vista);
    ui.vista.classList.remove('em-aba');
    st.visivel = true;
    ui.raiz.hidden = false;
    render();
    ui.vista.focus({ preventScroll: true });
    carregar(); // pega o que o gestor mudou na nota
  }
  function fechar(devolverFoco) {
    if (!st.visivel || st.modo !== 'painel') return;
    if (edicao) terminarEdicao();
    esconderBarra();
    const dentro = ui.raiz.contains(document.activeElement);
    st.visivel = false;
    ui.raiz.hidden = true;
    render();
    if (devolverFoco && dentro) {
      const b = botoes.find((x) => x.offsetParent !== null);
      if (b) b.focus({ preventScroll: true });
    }
  }
  function alternar() { if (st.visivel && st.modo === 'painel') fechar(true); else abrir(); }

  // Provedor da aba (index.html): a vista é uma só e muda de casa (painel ⇄ aba).
  function criarAba(painel) {
    if (st.modo === 'painel' && st.visivel) fechar(false);
    st.modo = 'aba';
    ui.vista.classList.add('em-aba');
    painel.classList.add('aba-ideias');
    painel.append(ui.vista);
    const mostrar = () => { st.visivel = true; render(); carregar(); };
    const esconder = () => { if (edicao) terminarEdicao(); esconderBarra(); st.visivel = false; render(); };
    mostrar();
    return {
      mostrar,
      esconder,
      destruir: () => {
        esconder();
        st.modo = 'painel';
        ui.vista.classList.remove('em-aba');
        ui.raiz.append(ui.vista);
      },
      focar: () => { if (!ui.vista.contains(document.activeElement)) ui.vista.focus({ preventScroll: true }); },
    };
  }

  function linhaDe(it) {
    let li = itens.get(it.id);
    if (!li) {
      const check = h('button', { class: 'id-check', type: 'button', role: 'checkbox', onclick: () => alternarFeita(li.dataset.id) }, icone('check', 11, 2));
      const lixo = h('button', { class: 'id-apagar', type: 'button', onclick: (e) => apagar(li.dataset.id, e.currentTarget) }, icone('lixeira', 14));
      const ed = criarEditor({ rotulo: 'Ideia', classe: 'id-txt' });
      ed.el.addEventListener('focus', () => comecarEdicao(li));
      ed.el.addEventListener('input', () => {
        if (!edicao || edicao.ed !== ed) comecarEdicao(li);
        if (!edicao) return;
        edicao.mudou = true;
        clearTimeout(edicao.t);
        edicao.t = setTimeout(() => gravarEdicao(), MS_EDITAR);
      });
      ed.el.addEventListener('blur', () => {
        // Clique na barra de formatação não tira o foco (mousedown sem padrão); o resto termina a edição.
        setTimeout(() => { if (edicao && edicao.ed === ed && document.activeElement !== ed.el) terminarEdicao(); }, 0);
      });
      li = h('li', { class: 'id-item', tabindex: '-1' }, check, h('div', { class: 'id-corpo' }, ed.el, h('time', { class: 'id-data' })), lixo);
      li._ed = ed;
      li.dataset.id = it.id;
      itens.set(it.id, li);
    }
    const editando = edicao && edicao.ed === li._ed;
    li.classList.toggle('pendente', !!it.pendente);
    li.toggleAttribute('data-feita', !!it.feita);
    const check = li.querySelector('.id-check');
    check.setAttribute('aria-checked', String(!!it.feita));
    check.setAttribute('aria-label', it.feita ? 'Marcar como não feita' : 'Marcar como feita');
    check.title = it.feita ? 'Feita · desmarcar' : 'Marcar como feita';
    check.disabled = !!it.pendente;
    li._ed.el.contentEditable = it.pendente ? 'false' : 'true';
    if (!editando && li._ed.el.dataset.md !== it.texto) { li._ed.definir(it.texto); li._ed.el.dataset.md = it.texto; }
    const tm = li.querySelector('.id-data');
    txt(tm, it.pendente ? 'salvando…' : dataCurta(it.data));
    tm.title = dataLonga(it.data);
    if (it.data) tm.setAttribute('datetime', it.data.replace(' ', 'T')); else tm.removeAttribute('datetime');
    const lixo = li.querySelector('.id-apagar');
    const conf = st.confirmar === it.id;
    lixo.classList.toggle('confirmar', conf);
    lixo.title = conf ? 'Clique de novo para apagar' : 'Apagar';
    lixo.setAttribute('aria-label', conf ? 'Confirmar: apagar esta ideia' : 'Apagar esta ideia');
    lixo.disabled = !!it.pendente;
    return li;
  }

  function render() {
    const abertas = st.lista.filter((x) => !x.feita);
    const feitas = st.lista.filter((x) => x.feita);
    // Contador no item da lateral: só as que faltam.
    for (const b of botoes) {
      const n = b.querySelector('[data-ideias-n]');
      if (n) txt(n, abertas.length ? abertas.length : '');
      if (st.modo === 'painel') { b.setAttribute('aria-expanded', String(st.visivel)); b.setAttribute('aria-controls', 'ideias'); }
      else { b.removeAttribute('aria-expanded'); b.removeAttribute('aria-controls'); }
    }
    if (!st.visivel) return;
    txt(ui.n, st.lista.length ? String(abertas.length) : '');
    ui.n.title = abertas.length + (abertas.length === 1 ? ' ideia em aberto' : ' ideias em aberto');

    const vivos = new Set(st.lista.map((x) => x.id));
    for (const [id, li] of itens) if (!vivos.has(id)) { li.remove(); itens.delete(id); }
    if (edicao && !vivos.has(edicao.id)) edicao = null;

    const quero = abertas.map(linhaDe);
    if (feitas.length) {
      ui.sep = ui.sep || h('li', { class: 'id-sep', role: 'presentation', text: 'Feitas' });
      quero.push(ui.sep, ...feitas.map(linhaDe));
    }
    const atual = [...ui.lista.children];
    if (atual.length !== quero.length || atual.some((el, i) => el !== quero[i])) {
      // Reordenar tira o editor do DOM por um instante: guarda o foco e a seleção.
      const ativo = document.activeElement;
      const s = getSelection();
      const r = s.rangeCount && ativo && ui.lista.contains(ativo) ? s.getRangeAt(0).cloneRange() : null;
      ui.lista.replaceChildren(...quero);
      if (ativo && ativo !== document.activeElement && ui.lista.contains(ativo)) {
        ativo.focus({ preventScroll: true });
        if (r) { s.removeAllRanges(); s.addRange(r); }
      }
    }
    ui.vazio.hidden = !st.carregado || st.lista.length > 0 || st.antigo;
    ui.campo.el.contentEditable = st.antigo ? 'false' : 'true';
    ui.fechar.hidden = st.modo !== 'painel';
    renderPe();
  }

  function renderPe() {
    if (!ui.pe) return;
    let estado = 'ok', t = 'Salvo · ' + st.nota;
    if (st.antigo) { estado = 'erro'; t = 'Reinicie o servidor do Orbit para ativar as ideias.'; }
    else if (st.erro) { estado = 'erro'; t = st.erro; }
    else if (st.salvando || (edicao && edicao.mudou && edicao.ed.valor() !== edicao.gravado)) { estado = 'salvando'; t = 'Salvando…'; }
    ui.pe.dataset.estado = estado;
    txt(ui.peTxt, t);
    ui.peTxt.title = estado === 'ok' ? st.nota : t;
  }

  // ───────────────────────────── atalho ─────────────────────────────
  function digitando(el) {
    return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.repeat) return;
    if (e.key !== 'i' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (digitando(e.target)) return;
    // Com uma camada (configurações, atalhos, confirmação) ou o popover de projeto aberto, a tecla é deles.
    if (document.querySelector('.camada:not([hidden]), .pj-pop:not([hidden])')) return;
    e.preventDefault();
    if (st.modo === 'aba' && st.visivel && ui.vista.contains(document.activeElement)) return;
    alternar();
  });

  montar();
  render();
  carregar();
  if (api && typeof api.on === 'function') {
    api.on('ideias', (lista) => { if (!st.salvando) aplicar(lista); });
    api.on('conexao', (estado) => { if (estado === 'vivo') carregar(); });
  }
  window.Ideias = { criarAba, abrir: () => abrir(), _md: { paraBlocos, deBlocos, inline, linhaMd, blocosDoDom, desenhar } };
})();
