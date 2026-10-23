// Orbit no celular — tela parear (onda 3). API no contrato, "App do celular" (OM.parear, OM.estado.motivoParear).
// Única tela do modo parear (sem barra). Passo 1: nome do aparelho → OM.parear.pedir. Passo 2: código que aparece no PC →
// OM.parear.confirmar (entra no app sozinho; a casca troca o modo). Nada de innerHTML; tudo por OM.h / OM.txt.
(() => {
  'use strict';
  const OM = window.OM;
  if (!OM || !OM.telas) return;
  const { h, txt } = OM;

  const MOTIVOS = {
    revogado: { icone: 'alerta', tom: 'aviso', texto: 'Este aparelho foi removido no PC. Para voltar a usar o Orbit aqui, peça um novo código.' },
    saiu: { icone: 'info', tom: '', texto: 'Você saiu do Orbit neste aparelho. Pareie de novo quando quiser.' },
  };

  const ua = () => String(navigator.userAgent || '');
  const ehApple = () => /iPhone|iPad|iPod/.test(ua()) || (/Macintosh/.test(ua()) && (navigator.maxTouchPoints || 0) > 1);
  function nomeSugerido() {
    const u = ua();
    if (/iPad/.test(u) || (/Macintosh/.test(u) && (navigator.maxTouchPoints || 0) > 1)) return 'iPad';
    if (/iPhone|iPod/.test(u)) return 'iPhone';
    if (/Android/.test(u)) return 'Android';
    return 'Celular';
  }
  function instalado() {
    try { if (OM.push && typeof OM.push.instalado === 'function') return !!OM.push.instalado(); } catch {}
    return navigator.standalone === true;
  }
  const soDigitos = (v) => String(v || '').replace(/\D/g, '');

  function montar(cont) {
    const S = { passo: 1, pedido: null, expiraEm: 0, timer: 0, ocupado: false, vivo: true, expirou: false };

    // ── cabeçalho comum (logo, aviso de motivo) ──
    const marca = h('div', { class: 'par-marca' },
      h('img', { class: 'par-logo', src: '/assets/pwa/icone-96.png', width: 56, height: 56, alt: '', 'aria-hidden': 'true', draggable: 'false' }),
      h('span', { class: 'par-nome-app' }, 'Orbit'));
    const aviso = h('div', { class: 'par-aviso', role: 'status', hidden: true });

    // ── passo 1 ──
    const campoNome = h('input', {
      class: 'par-campo', type: 'text', id: 'par-nome', name: 'nome', maxlength: '40', autocomplete: 'off', autocapitalize: 'words',
      autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', value: nomeSugerido(), 'aria-describedby': 'par-erro-1',
    });
    const erro1 = h('p', { class: 'par-erro', id: 'par-erro-1', role: 'alert', hidden: true });
    const btnPedir = h('button', { class: 'btn solido par-btn', type: 'submit' }, 'Pedir código');
    const dica = h('p', { class: 'par-dica', hidden: true },
      OM.icone('instalar', 16),
      h('span', {}, 'Para receber notificações no iPhone, toque em Compartilhar e em Adicionar à Tela de Início.'));
    const f1 = h('form', { class: 'par-passo', dados: { p: '1' }, novalidate: true, onsubmit: pedir },
      h('h1', { class: 'par-tit' }, 'Parear este aparelho'),
      h('p', { class: 'par-txt' }, 'Dê um nome a este aparelho. Depois, você confirma com um código de 6 dígitos que aparece no Orbit do PC.'),
      h('label', { class: 'par-rot', for: 'par-nome' }, 'Nome deste aparelho'),
      campoNome, erro1, btnPedir, dica);

    // ── passo 2 ──
    const campoCodigo = h('input', {
      class: 'par-campo par-codigo', type: 'text', id: 'par-codigo', name: 'codigo', inputmode: 'numeric', pattern: '[0-9]*',
      autocomplete: 'one-time-code', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go',
      'aria-describedby': 'par-erro-2 par-tempo', 'aria-label': 'Código de 6 dígitos', placeholder: '000000',
    });
    const tempo = h('p', { class: 'par-tempo', id: 'par-tempo', role: 'timer', 'aria-live': 'off' });
    const erro2 = h('p', { class: 'par-erro', id: 'par-erro-2', role: 'alert', hidden: true });
    const btnConfirmar = h('button', { class: 'btn solido par-btn', type: 'submit' }, 'Parear');
    const btnDeNovo = h('button', { class: 'btn solido par-btn', type: 'button', hidden: true, onclick: pedirDeNovo }, 'Pedir de novo');
    const btnVoltar = h('button', { class: 'btn par-btn par-sec', type: 'button', onclick: () => irPasso(1) }, 'Trocar o nome');
    const f2 = h('form', { class: 'par-passo', dados: { p: '2' }, novalidate: true, onsubmit: confirmar },
      h('h1', { class: 'par-tit' }, 'Confirme no PC'),
      h('p', { class: 'par-txt' }, 'O código de 6 dígitos aparece agora no Orbit do PC, no aviso de pareamento. Digite-o aqui.'),
      h('label', { class: 'par-rot', for: 'par-codigo' }, 'Código'),
      campoCodigo, tempo, erro2, btnConfirmar, btnDeNovo, btnVoltar);

    const raiz = h('div', { class: 'par', dados: { passo: '1' } },
      marca, aviso, h('div', { class: 'par-passos' }, f1, f2));
    cont.append(raiz);

    // ── helpers ──
    function mostrarErro(el, t) { el.hidden = !t; txt(el, t || ''); campoCodigo.removeAttribute('aria-invalid'); }
    function irPasso(n, foco = true) {
      S.passo = n;
      raiz.dataset.passo = String(n);
      clearInterval(S.timer);
      mostrarErro(erro1, ''); mostrarErro(erro2, '');
      if (n === 2) {
        S.expirou = false;
        btnConfirmar.hidden = false; btnDeNovo.hidden = true; btnConfirmar.disabled = false;
        campoCodigo.disabled = false;
        S.timer = setInterval(tique, 500);
        tique();
      }
      if (foco) setTimeout(() => { if (S.vivo && S.passo === n) (n === 1 ? campoNome : campoCodigo).focus({ preventScroll: true }); }, 30);
    }
    function tique() {
      const falta = S.expiraEm - Date.now();
      if (falta <= 0) {
        clearInterval(S.timer);
        S.expirou = true;
        tempo.classList.add('fim');
        txt(tempo, 'O código expirou (vale 2 minutos).');
        btnConfirmar.hidden = true; btnDeNovo.hidden = false;
        campoCodigo.disabled = true;
        return;
      }
      tempo.classList.remove('fim');
      const s = Math.ceil(falta / 1000);
      txt(tempo, 'Expira em ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
    }
    function ocupar(sim) {
      S.ocupado = sim;
      raiz.setAttribute('aria-busy', sim ? 'true' : 'false');
      btnPedir.disabled = sim; btnDeNovo.disabled = sim;
      btnConfirmar.disabled = sim || S.expirou;
    }
    const nomeAtual = () => OM.fmt.limpo(campoNome.value).slice(0, 40) || nomeSugerido();

    // ── ações ──
    async function solicitar(erroEl) {
      if (S.ocupado) return false;
      ocupar(true);
      mostrarErro(erroEl, '');
      try {
        const r = await OM.parear.pedir(nomeAtual());
        if (!S.vivo) return false;
        S.pedido = r.pedido;
        S.expiraEm = r.expiraEm;
        campoCodigo.value = '';
        return true;
      } catch (e) {
        if (S.vivo) mostrarErro(erroEl, OM.parear.textoErro(e, false));
        return false;
      } finally {
        if (S.vivo) ocupar(false);
      }
    }
    async function pedir(ev) {
      ev.preventDefault();
      if (await solicitar(erro1)) irPasso(2);
    }
    async function pedirDeNovo() {
      if (await solicitar(erro2)) irPasso(2);
    }
    async function confirmar(ev) {
      if (ev) ev.preventDefault();
      if (S.ocupado || S.expirou) return;
      const codigo = soDigitos(campoCodigo.value);
      if (codigo.length !== 6) { mostrarErro(erro2, 'Digite os 6 dígitos do código.'); campoCodigo.setAttribute('aria-invalid', 'true'); campoCodigo.focus(); return; }
      ocupar(true);
      mostrarErro(erro2, '');
      try {
        await OM.parear.confirmar(S.pedido, codigo);   // entra no app: a casca troca o modo e desmonta esta tela
      } catch (e) {
        if (!S.vivo) return;
        ocupar(false);
        if (OM.parear.recomecar(e)) {                  // expirou ou bloqueou: volta ao nome (o nome digitado fica)
          irPasso(1, false);
          mostrarErro(erro1, OM.parear.textoErro(e, true));
          return;
        }
        mostrarErro(erro2, OM.parear.textoErro(e, true));
        campoCodigo.setAttribute('aria-invalid', 'true');
        campoCodigo.focus({ preventScroll: true });
        try { campoCodigo.select(); } catch {}         // o que foi digitado fica; digitar de novo substitui
      }
    }

    campoCodigo.addEventListener('input', () => {
      const v = soDigitos(campoCodigo.value).slice(0, 6);   // colar "123 456" ou "123-456" funciona
      if (campoCodigo.value !== v) campoCodigo.value = v;
      if (!erro2.hidden) mostrarErro(erro2, '');
      if (v.length === 6 && !S.ocupado && !S.expirou) confirmar();
    });
    campoNome.addEventListener('input', () => { if (!erro1.hidden) mostrarErro(erro1, ''); });
    for (const c of [campoNome, campoCodigo]) {
      c.addEventListener('focus', () => setTimeout(() => { if (S.vivo) try { c.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {} }, 320));
    }

    function aplicarMotivo() {
      const m = MOTIVOS[OM.estado.motivoParear];
      aviso.hidden = !m;
      aviso.classList.toggle('aviso', !!(m && m.tom === 'aviso'));
      if (m) { aviso.replaceChildren(OM.icone(m.icone, 18), h('span', {}, m.texto)); }
      dica.hidden = !(ehApple() && !instalado());
    }
    aplicarMotivo();

    return { S, aplicarMotivo, irPasso, campoNome, campoCodigo, parar() { S.vivo = false; clearInterval(S.timer); } };
  }

  const instancias = new WeakMap();
  OM.telas.registrar('parear', {
    titulo: 'Parear',
    semBarra: true,
    montar(cont, params, ctx) { instancias.set(ctx.tela, montar(cont)); },
    mostrar(ctx) {
      const t = instancias.get(ctx.tela);
      if (!t) return;
      t.aplicarMotivo();
    },
    atualizar(estado, ctx) { const t = instancias.get(ctx.tela); if (t) t.aplicarMotivo(); },
    desmontar(ctx) { const t = instancias.get(ctx.tela); if (t) t.parar(); instancias.delete(ctx.tela); },
  });
})();
