/* Anexos — imagens anexadas na Conversa e no popover "Nova instância" (prefixo ax-, 16/10).
 *
 * Integração (index.html carrega antes da Conversa e das Instâncias):
 *   window.Anexos.criar(op) → controlador. op: { alvo, campo, max, aoMudar(), aoAviso(texto) }
 *     alvo   elemento que recebe o arrastar-e-soltar e o Ctrl+V (o painel da conversa, o popover)
 *     campo  o textarea; ganha a faixa de miniaturas logo acima (o consumidor a posiciona: .faixa)
 *   c.botao / c.faixa           o botão de anexar e as miniaturas (a faixa some vazia)
 *   c.lista()                   [{ tipo, dados }] prontas para o POST (base64 sem o "data:")
 *   c.contagem() / c.pendentes() quantas há / quantas ainda estão sendo preparadas
 *   c.miniaturas()              [{ url, tipo }] das prontas (a bolha otimista mostra essas)
 *   c.guardar() / c.repor(itens) tira tudo sem soltar (rascunho por sessão) / põe de volta
 *   c.entregar()                esvazia sem soltar as URLs (passam para a bolha, que as solta depois)
 *   c.limpar()                  tira tudo e solta as URLs
 *   c.habilitar(sim, motivo)    sem habilitar, o botão explica o motivo e soltar/colar não anexa
 *   window.Anexos.ampliar(imgs, i)  visor em tela cheia: imgs = [{ url }], Esc fecha, ← → trocam
 *   window.Anexos.soltar(urls)      revoga as URLs blob: (as cópias temporárias só existem na memória)
 *
 * Preparação (só no navegador, nada vai ao disco): PNG, JPEG, GIF e WebP de até LADO px e ALVO bytes vão
 * como estão; o resto (maior, BMP, AVIF, SVG…) é redesenhado num canvas com o lado maior em LADO px e vai
 * como PNG, ou WebP/JPEG quando o PNG passa de ALVO. A API recusa acima de 5 MB por imagem.
 */
(function () {
  'use strict';

  const TIPOS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const LADO = 2000;               // px do lado maior (o modelo reduz acima de ~1568 de todo jeito)
  const ALVO = 1.5 * 1024 * 1024;  // bytes: acima disso, redesenha/comprime
  const TETO = 3.7 * 1024 * 1024;  // bytes: ~5 MB em base64, o limite da API
  let seq = 0;

  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  function svg(d, tam, extra) {
    const ns = 'http://www.w3.org/2000/svg';
    const v = document.createElementNS(ns, 'svg');
    for (const [k, x] of Object.entries({ viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, x);
    for (const p of [].concat(d)) {
      const el = document.createElementNS(ns, p.t || 'path');
      for (const [k, x] of Object.entries(p.t ? p.a : { d: p })) el.setAttribute(k, x);
      v.append(el);
    }
    if (extra) v.setAttribute('class', extra);
    return v;
  }
  const icoImagem = (t = 15) => svg([{ t: 'rect', a: { x: 2, y: 2.5, width: 12, height: 11, rx: 2 } }, { t: 'circle', a: { cx: 5.7, cy: 6.2, r: 1.2 } }, 'M2.6 11.6 6 8.3l2.6 2.5 1.8-1.7 3 3'], t);
  const icoX = (t = 10) => svg('M4.5 4.5l7 7M11.5 4.5l-7 7', t);
  const icoSeta = (d, t = 18) => svg(d < 0 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5', t);
  const soltar = (urls) => { for (const u of [].concat(urls || [])) { const x = typeof u === 'string' ? u : u && u.url; if (x && x.startsWith('blob:')) try { URL.revokeObjectURL(x); } catch {} } };

  // ───────────────────────────── preparação ─────────────────────────────
  function carregar(blob) {
    return new Promise((ok, ruim) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => ok({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); ruim(new Error('não deu para ler a imagem')); };
      img.src = url;
    });
  }
  const paraBlob = (c, tipo, q) => new Promise((ok) => c.toBlob((b) => ok(b), tipo, q));
  function base64(blob) {
    return new Promise((ok, ruim) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ''); ok(s.slice(s.indexOf(',') + 1)); };
      r.onerror = () => ruim(new Error('não deu para ler a imagem'));
      r.readAsDataURL(blob);
    });
  }
  async function preparar(arquivo) {
    const { img, url } = await carregar(arquivo);
    try {
      const w = img.naturalWidth || img.width, hh = img.naturalHeight || img.height;
      if (!w || !hh) throw new Error('imagem vazia');
      let blob = arquivo;
      if (!TIPOS.includes(arquivo.type) || Math.max(w, hh) > LADO || arquivo.size > ALVO) {
        const k = Math.min(1, LADO / Math.max(w, hh));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(hh * k));
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        blob = await paraBlob(c, 'image/png');
        if (!blob || blob.size > ALVO) {
          const webp = await paraBlob(c, 'image/webp', 0.9);
          if (webp && webp.type === 'image/webp' && webp.size <= ALVO) blob = webp;
          else {
            // JPEG não tem transparência: fundo branco antes.
            const f = document.createElement('canvas');
            f.width = c.width;
            f.height = c.height;
            const gf = f.getContext('2d');
            gf.fillStyle = '#fff';
            gf.fillRect(0, 0, f.width, f.height);
            gf.drawImage(c, 0, 0);
            for (const q of [0.88, 0.8, 0.7]) {
              blob = await paraBlob(f, 'image/jpeg', q);
              if (blob && blob.size <= ALVO) break;
            }
          }
        }
      }
      if (!blob || !TIPOS.includes(blob.type)) throw new Error('formato não suportado');
      if (blob.size > TETO) throw new Error('grande demais mesmo depois de reduzida');
      const dados = await base64(blob);
      return { tipo: blob.type, dados, url: blob === arquivo ? url : (URL.revokeObjectURL(url), URL.createObjectURL(blob)) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  const ehArquivoDeImagem = (f) => f && /^image\//.test(f.type || '');
  const temArquivos = (dt) => !!dt && [...(dt.types || [])].includes('Files');

  // ───────────────────────────── controlador ─────────────────────────────
  function criar(op) {
    const max = op.max || 10;
    let itens = [];        // { id, nome, url, tipo, dados, pronto, erro, no }
    const fora = new Set(); // guardadas no rascunho de outra sessão (podem terminar de preparar lá)
    const nossa = (it) => itens.includes(it) || fora.has(it);
    let ativo = true;
    let motivo = '';
    const aoMudar = () => { try { op.aoMudar && op.aoMudar(); } catch (e) { console.warn('Anexos', e); } };
    const avisar = (t) => { try { op.aoAviso && op.aoAviso(t); } catch {} };

    const entrada = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    const botao = h('button', { type: 'button', class: 'ax-botao', 'aria-label': 'Anexar imagens', title: 'Anexar imagens (ou arraste, ou cole)' }, icoImagem(15), entrada);
    const faixa = h('div', { class: 'ax-faixa', role: 'list', 'aria-label': 'Imagens anexadas', hidden: true });
    const solte = h('div', { class: 'ax-solte', 'aria-hidden': 'true' }, h('span', null, icoImagem(18), 'Solte para anexar'));

    botao.addEventListener('click', (e) => {
      if (e.target === entrada) return;
      if (!ativo) { avisar(motivo); return; }
      entrada.value = '';
      entrada.click();
    });
    entrada.addEventListener('change', () => { adicionar([...(entrada.files || [])]); entrada.value = ''; });

    const alvo = op.alvo;
    if (alvo) {
      if (getComputedStyle(alvo).position === 'static') alvo.style.position = 'relative';
      alvo.append(solte);
      let dentro = 0;
      const mostrar = (v) => alvo.classList.toggle('ax-arrastando', v);
      alvo.addEventListener('dragenter', (e) => { if (!temArquivos(e.dataTransfer)) return; e.preventDefault(); dentro++; mostrar(true); });
      alvo.addEventListener('dragover', (e) => { if (!temArquivos(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = ativo ? 'copy' : 'none'; });
      alvo.addEventListener('dragleave', (e) => { if (!temArquivos(e.dataTransfer)) return; if (--dentro <= 0) { dentro = 0; mostrar(false); } });
      alvo.addEventListener('drop', (e) => {
        if (!temArquivos(e.dataTransfer)) return;
        e.preventDefault();
        dentro = 0;
        mostrar(false);
        if (!ativo) { avisar(motivo); return; }
        adicionar([...e.dataTransfer.files]);
      });
      alvo.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        if (!dt) return;
        const arqs = [...(dt.items || [])].filter((it) => it.kind === 'file' && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
        if (!arqs.length) return;
        // Com texto junto (cópia de uma página), o texto segue para o campo; só a imagem é nossa.
        if (!dt.types.includes('text/plain')) e.preventDefault();
        if (!ativo) { avisar(motivo); return; }
        adicionar(arqs);
      });
    }

    function adicionar(arquivos) {
      const imgs = arquivos.filter(ehArquivoDeImagem);
      if (arquivos.length && !imgs.length) { avisar('Só imagens: PNG, JPEG, GIF, WebP e outras que o navegador abre.'); return; }
      const vagas = max - itens.length;
      if (vagas <= 0) { avisar('Até ' + max + ' imagens por mensagem.'); return; }
      if (imgs.length > vagas) avisar('Até ' + max + ' imagens por mensagem: ' + (imgs.length - vagas) + ' ficaram de fora.');
      for (const f of imgs.slice(0, vagas)) {
        const it = { id: 'ax-' + ++seq, nome: f.name || 'imagem colada', url: '', tipo: '', dados: '', pronto: false, erro: '' };
        itens.push(it);
        desenhar(it);
        preparar(f).then((r) => {
          if (!nossa(it)) { soltar(r.url); return; } // tirada enquanto preparava
          Object.assign(it, r, { pronto: true });
          desenhar(it);
          aoMudar();
        }).catch((e) => {
          if (!nossa(it)) return;
          fora.delete(it);
          tirar(it);
          avisar('Não deu para anexar "' + it.nome + '": ' + e.message + '.');
        });
      }
      render();
      aoMudar();
    }
    function desenhar(it) {
      const rot = it.nome + (it.pronto ? '' : ' (preparando)');
      const vista = h('button', { type: 'button', class: 'ax-vista', 'aria-label': 'Ampliar ' + it.nome, title: it.nome, disabled: !it.pronto },
        it.pronto ? h('img', { src: it.url, alt: '', draggable: 'false' }) : h('span', { class: 'ax-gira', 'aria-hidden': 'true' }));
      const x = h('button', { type: 'button', class: 'ax-tirar', 'aria-label': 'Remover ' + it.nome, title: 'Remover' }, icoX(10));
      vista.addEventListener('click', () => { const prontos = itens.filter((y) => y.pronto); ampliar(prontos, prontos.indexOf(it)); });
      x.addEventListener('click', () => {
        const i = itens.indexOf(it);
        tirar(it);
        // O foco vai para a vizinha (ou para o campo), não se perde no body.
        const viz = itens[Math.min(i, itens.length - 1)];
        if (viz && viz.no) viz.no.querySelector('.ax-tirar').focus(); else if (op.campo) op.campo.focus();
      });
      const no = h('div', { class: 'ax-mini' + (it.pronto ? '' : ' ax-preparando'), role: 'listitem', 'aria-label': rot }, vista, x);
      if (it.no && it.no.parentNode) it.no.replaceWith(no);
      it.no = no;
    }
    function tirar(it) {
      itens = itens.filter((y) => y !== it);
      soltar(it.url);
      render();
      aoMudar();
    }
    function render() {
      faixa.replaceChildren(...itens.map((it) => it.no));
      faixa.hidden = !itens.length;
      botao.classList.toggle('ax-tem', !!itens.length);
    }

    return {
      botao, faixa,
      lista: () => itens.filter((it) => it.pronto).map((it) => ({ tipo: it.tipo, dados: it.dados })),
      miniaturas: () => itens.filter((it) => it.pronto).map((it) => ({ url: it.url, tipo: it.tipo })),
      contagem: () => itens.length,
      pendentes: () => itens.filter((it) => !it.pronto).length,
      guardar() { const g = itens; for (const it of g) fora.add(it); itens = []; render(); aoMudar(); return g; },
      repor(g) {
        soltar(itens.map((it) => it.url));
        itens = Array.isArray(g) ? g : [];
        for (const it of itens) { fora.delete(it); desenhar(it); }
        render();
        aoMudar();
      },
      entregar() { itens = []; render(); aoMudar(); },
      limpar() { soltar(itens.map((it) => it.url)); itens = []; render(); aoMudar(); },
      habilitar(sim, m) {
        ativo = !!sim;
        motivo = m || '';
        botao.setAttribute('aria-disabled', String(!ativo));
        botao.title = ativo ? 'Anexar imagens (ou arraste, ou cole)' : motivo;
      },
      desabilitar(v) { botao.disabled = !!v; for (const b of faixa.querySelectorAll('.ax-tirar')) b.disabled = !!v; },
    };
  }

  // ───────────────────────────── visor ─────────────────────────────
  let visor = null;
  function ampliar(imgs, i) {
    imgs = (imgs || []).filter((x) => x && x.url);
    if (!imgs.length) return;
    fecharVisor();
    let atual = Math.max(0, Math.min(i | 0, imgs.length - 1));
    const antes = document.activeElement;
    const foto = h('img', { class: 'ax-foto', alt: '' });
    const conta = h('span', { class: 'ax-conta', 'aria-live': 'polite' });
    const fechar = h('button', { type: 'button', class: 'ax-v-b ax-v-x', 'aria-label': 'Fechar', title: 'Fechar' }, icoX(14));
    const ant = h('button', { type: 'button', class: 'ax-v-b ax-v-ant', 'aria-label': 'Anterior', title: 'Anterior' }, icoSeta(-1));
    const prox = h('button', { type: 'button', class: 'ax-v-b ax-v-prox', 'aria-label': 'Próxima', title: 'Próxima' }, icoSeta(1));
    const el = h('div', { class: 'ax-visor', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Imagem ampliada', tabindex: '-1' }, foto, fechar, ant, prox, conta);
    const varias = imgs.length > 1;
    ant.hidden = prox.hidden = conta.hidden = !varias;
    function mostrar(k) {
      atual = (k + imgs.length) % imgs.length;
      foto.src = imgs[atual].url;
      conta.textContent = (atual + 1) + ' de ' + imgs.length;
    }
    function sair() {
      if (visor !== el) return;
      visor = null;
      el.classList.add('ax-saindo');
      window.removeEventListener('keydown', tecla, true);
      setTimeout(() => el.remove(), 140);
      if (antes && antes.isConnected) try { antes.focus({ preventScroll: true }); } catch {}
    }
    function tecla(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sair(); }
      else if (varias && e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); mostrar(atual - 1); }
      else if (varias && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); mostrar(atual + 1); }
      else if (e.key === 'Tab') { // o foco fica no visor
        const bs = [...el.querySelectorAll('button')].filter((b) => !b.hidden);
        const k = bs.indexOf(document.activeElement);
        e.preventDefault();
        bs[(k + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
      } else e.stopPropagation();
    }
    el.addEventListener('click', (e) => { if (e.target === el) sair(); });
    fechar.addEventListener('click', sair);
    ant.addEventListener('click', () => mostrar(atual - 1));
    prox.addEventListener('click', () => mostrar(atual + 1));
    el._sair = sair;
    window.addEventListener('keydown', tecla, true);
    mostrar(atual);
    document.body.append(el);
    visor = el;
    fechar.focus({ preventScroll: true });
  }
  function fecharVisor() { if (visor && visor._sair) visor._sair(); }

  window.Anexos = Object.freeze({ criar, ampliar, fecharVisor, soltar, MAX: 10 });
})();
