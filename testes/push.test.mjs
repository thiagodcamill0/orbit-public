// Web Push (push.mjs) sem internet: vetor do Apêndice A da RFC 8291, JWT VAPID, envio contra um servidor HTTP local
// falso (só 47822–47826, conferida antes) e a privada VAPID nunca em texto puro no arquivo.
// Rodar:  node --test testes/push.test.mjs
// Tudo em pasta temporária (apagada no fim); o cofre é falso, em memória.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { criarPush, cifrarAes128gcm, assinarJwtVapid } from '../push.mjs';
import { escolherPorta } from './porta-livre.mjs';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-push-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const b64u = (b) => Buffer.from(b).toString('base64url');
const deB64u = (s) => Buffer.from(s, 'base64url');
const cofreFalso = () => {
  const c = { texto: '', ler: async () => c.texto, guardar: async (t) => { c.texto = t; } };
  return c;
};

// Decifra o corpo aes128gcm como o navegador faria (RFC 8291 §3.4), com a chave privada do assinante.
function decifrar(corpo, uaPrivada, uaPublica, auth) {
  const salt = corpo.subarray(0, 16);
  const rs = corpo.readUInt32BE(16);
  const idlen = corpo[20];
  const asPublica = corpo.subarray(21, 21 + idlen);
  const texto = corpo.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivada);
  const segredo = ecdh.computeSecret(asPublica);
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublica, asPublica]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', segredo, auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(texto.subarray(texto.length - 16));
  const claro = Buffer.concat([d.update(texto.subarray(0, texto.length - 16)), d.final()]);
  assert.equal(claro[claro.length - 1], 2, 'delimitador 0x02 do último registro');
  return claro.subarray(0, claro.length - 1);
}

function novoAssinante() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { privada: ecdh.getPrivateKey(), publica: ecdh.getPublicKey(), auth: crypto.randomBytes(16) };
}
const assinaturaDe = (a, endpoint) => ({ endpoint, keys: { p256dh: b64u(a.publica), auth: b64u(a.auth) } });

function chavePublicaKeyObject(publica65) {
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(publica65.subarray(1, 33)), y: b64u(publica65.subarray(33, 65)) }, format: 'jwk' });
}

// ───────────────────────── (a) vetor da RFC 8291, Apêndice A ─────────────────────────

test('RFC 8291 Apêndice A: o corpo cifrado é exatamente o da RFC', () => {
  const corpo = cifrarAes128gcm({
    payload: Buffer.from('When I grow up, I want to be a watermelon'),
    uaPublica: deB64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    authSecret: deB64u('BTBZMqHH6r4Tts7J_aSIgg'),
    efemeraPrivada: deB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    salt: deB64u('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  assert.equal(
    b64u(corpo),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('cifra: rejeita chave/segredo/payload fora do formato', () => {
  const a = novoAssinante();
  assert.throws(() => cifrarAes128gcm({ payload: 'x', uaPublica: Buffer.alloc(10), authSecret: a.auth }));
  assert.throws(() => cifrarAes128gcm({ payload: 'x', uaPublica: a.publica, authSecret: Buffer.alloc(3) }));
  assert.throws(() => cifrarAes128gcm({ payload: Buffer.alloc(4000), uaPublica: a.publica, authSecret: a.auth }));
  // ida e volta com o mínimo e com o máximo
  for (const n of [0, 1, 3993]) {
    const claro = crypto.randomBytes(n);
    assert.deepEqual(decifrar(cifrarAes128gcm({ payload: claro, uaPublica: a.publica, authSecret: a.auth }), a.privada, a.publica, a.auth), claro);
  }
});

// ───────────────────────── (b) JWT VAPID ─────────────────────────

test('JWT VAPID: ES256 P1363, aud, exp <= 12 h, sub fixo, verificável com a pública', async () => {
  const cofre = cofreFalso();
  const push = criarPush({ cofre, arquivoChaves: path.join(BASE, 'jwt', 'chaves.json') });
  const publica = await push.chavePublica();
  assert.equal(deB64u(publica).length, 65);
  assert.equal(deB64u(publica)[0], 4);

  const privada = crypto.createPrivateKey({ key: deB64u(cofre.texto), format: 'der', type: 'pkcs8' });
  const agora = 1_800_000_000;
  const jwt = assinarJwtVapid(privada, 'https://push.exemplo.net', agora);
  const [cab, corpo, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(deB64u(cab)), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(deB64u(corpo));
  assert.equal(c.aud, 'https://push.exemplo.net');
  assert.ok(c.exp > agora && c.exp - agora <= 12 * 3600);
  assert.equal(c.sub, 'mailto:orbit@localhost');
  assert.equal(deB64u(sig).length, 64);
  assert.equal(crypto.verify('sha256', Buffer.from(`${cab}.${corpo}`), { key: chavePublicaKeyObject(deB64u(publica)), dsaEncoding: 'ieee-p1363' }, deB64u(sig)), true);
  // adulterado não passa
  assert.equal(crypto.verify('sha256', Buffer.from(`${cab}.${b64u('{"aud":"https://outro"}')}`), { key: chavePublicaKeyObject(deB64u(publica)), dsaEncoding: 'ieee-p1363' }, deB64u(sig)), false);
});

// ───────────────────────── (c) enviar contra servidor local falso ─────────────────────────

test('enviar: cabeçalhos, JWT, corpo decifrável pelo assinante e status devolvido (inclusive 404/410/rede/prazo)', async () => {
  const porta = await escolherPorta(47822);
  const pedidos = [];
  let responder = 201;
  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (d) => partes.push(d));
    req.on('end', () => {
      pedidos.push({ url: req.url, metodo: req.method, h: req.headers, corpo: Buffer.concat(partes) });
      if (responder === 'pendurar') return; // nunca responde
      res.writeHead(responder);
      res.end();
    });
  });
  await new Promise((r) => srv.listen(porta, '127.0.0.1', r));
  try {
    const cofre = cofreFalso();
    const arquivo = path.join(BASE, 'envio', 'chaves.json');
    const push = criarPush({ cofre, arquivoChaves: arquivo, permitirHttp: true, timeoutMs: 600 });
    const publica = await push.chavePublica();
    const a = novoAssinante();
    const origem = `http://127.0.0.1:${porta}`;
    const sub = assinaturaDe(a, `${origem}/push/abc123?x=1`);
    const payload = { titulo: 'Orbit · proj · terminou', corpo: '', url: '/m#s=7', tag: 's-7' };

    const r = await push.enviar(sub, payload);
    assert.deepEqual(r, { status: 201 });
    const p = pedidos.at(-1);
    assert.equal(p.metodo, 'POST');
    assert.equal(p.url, '/push/abc123?x=1');
    assert.equal(p.h['content-encoding'], 'aes128gcm');
    assert.equal(p.h.ttl, '3600');
    assert.equal(p.h.urgency, 'high');
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(p.h.authorization);
    assert.ok(m, 'Authorization: vapid t=..., k=...');
    assert.equal(m[2], publica);
    const [cab, corpoJwt, sig] = m[1].split('.');
    const c = JSON.parse(deB64u(corpoJwt));
    assert.equal(c.aud, origem);
    assert.ok(c.exp > Date.now() / 1000 && c.exp - Date.now() / 1000 <= 12 * 3600);
    assert.equal(c.sub, 'mailto:orbit@localhost');
    assert.equal(crypto.verify('sha256', Buffer.from(`${cab}.${corpoJwt}`), { key: chavePublicaKeyObject(deB64u(publica)), dsaEncoding: 'ieee-p1363' }, deB64u(sig)), true);
    assert.deepEqual(JSON.parse(decifrar(p.corpo, a.privada, a.publica, a.auth).toString('utf8')), payload);

    // TTL e urgência personalizados; string passa como veio
    await push.enviar(sub, 'texto', { ttl: 60, urgencia: 'low' });
    const p2 = pedidos.at(-1);
    assert.equal(p2.h.ttl, '60');
    assert.equal(p2.h.urgency, 'low');
    assert.equal(decifrar(p2.corpo, a.privada, a.publica, a.auth).toString(), 'texto');

    // 404 e 410 voltam como status, sem lançar
    responder = 410;
    assert.deepEqual(await push.enviar(sub, payload), { status: 410 });
    responder = 404;
    assert.deepEqual(await push.enviar(sub, payload), { status: 404 });

    // prazo estourado e assinatura/endpoint ruins: status 0, sem lançar
    responder = 'pendurar';
    assert.deepEqual(await push.enviar(sub, payload), { status: 0 });
    assert.deepEqual(await push.enviar({ endpoint: 'nao-e-url', keys: sub.keys }, payload), { status: 0 });
    assert.deepEqual(await push.enviar({ endpoint: origem + '/x', keys: { p256dh: 'abc', auth: 'x' } }, payload), { status: 0 });
    assert.deepEqual(await push.enviar(null, payload), { status: 0 });
    // sem permitirHttp, http é recusado (nada chega ao servidor)
    const antes = pedidos.length;
    const rigido = criarPush({ cofre, arquivoChaves: arquivo });
    assert.deepEqual(await rigido.enviar(sub, payload), { status: 0 });
    assert.equal(pedidos.length, antes);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
  // porta fechada: erro de rede vira status 0
  const push2 = criarPush({ cofre: cofreFalso(), arquivoChaves: path.join(BASE, 'rede', 'chaves.json'), permitirHttp: true });
  const a = novoAssinante();
  assert.deepEqual(await push2.enviar(assinaturaDe(a, `http://127.0.0.1:${porta}/x`), {}), { status: 0 });
});

// ───────────────────────── (d) privada só no cofre ─────────────────────────

test('privada VAPID: só no cofre; o arquivo tem só a pública; segunda criação reaproveita as chaves', async () => {
  const cofre = cofreFalso();
  const arquivo = path.join(BASE, 'sigilo', 'chaves.json');
  const push = criarPush({ cofre, arquivoChaves: arquivo });
  const publica = await push.chavePublica();

  const guardado = cofre.texto; // PKCS8 DER em base64url
  assert.ok(guardado.length > 0);
  const privada = crypto.createPrivateKey({ key: deB64u(guardado), format: 'der', type: 'pkcs8' });
  const jwk = privada.export({ format: 'jwk' });
  const bruto = fs.readFileSync(arquivo, 'utf8');
  for (const segredo of [guardado, jwk.d, deB64u(jwk.d).toString('hex'), deB64u(jwk.d).toString('base64'), deB64u(guardado).toString('base64')]) {
    assert.equal(bruto.includes(segredo), false, 'a privada não pode aparecer no arquivo');
  }
  assert.deepEqual(JSON.parse(bruto), { publica });

  // novo objeto com o mesmo cofre/arquivo: mesma pública, sem trocar a privada
  const push2 = criarPush({ cofre, arquivoChaves: arquivo });
  assert.equal(await push2.chavePublica(), publica);
  assert.equal(cofre.texto, guardado);

  // arquivo apagado: recria a pública a partir da privada do cofre
  fs.rmSync(arquivo);
  assert.equal(await criarPush({ cofre, arquivoChaves: arquivo }).chavePublica(), publica);
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8')), { publica });

  // cofre com lixo: gera par novo (não lança)
  const cofreRuim = cofreFalso();
  cofreRuim.texto = 'isto-nao-e-uma-chave';
  const p3 = criarPush({ cofre: cofreRuim, arquivoChaves: path.join(BASE, 'sigilo', 'outro.json') });
  assert.equal(deB64u(await p3.chavePublica()).length, 65);
  assert.notEqual(cofreRuim.texto, 'isto-nao-e-uma-chave');

  // nenhum arquivo temporário sobrou
  assert.deepEqual(fs.readdirSync(path.dirname(arquivo)).filter((n) => n.endsWith('.tmp')), []);
});
