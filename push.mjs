// Orbit — Web Push (RFC 8030 + RFC 8291 aes128gcm + VAPID RFC 8292/ES256), só node:crypto e http(s).
// "Orbit no celular": o servidor avisa o iPhone quando uma instância precisa de você ou termina.
//   const push = criarPush({ cofre, arquivoChaves, log });
//   await push.chavePublica()                       // base64url (65 bytes, ponto não comprimido) para o applicationServerKey
//   await push.enviar(assinatura, payload, { ttl, urgencia }) // → { status } (0 = não chegou ao serviço de push)
// A chave privada VAPID só existe em memória e no `cofre` (perfil.criarCofreTexto: DPAPI no Windows, Chaveiro no
// Mac; interface { ler(): Promise<string>, guardar(texto) }). No arquivoChaves vai só a pública. 404/410 voltam como
// status (o chamador remove a assinatura); nada aqui lança por causa do serviço de push ou da rede.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

const SUB = 'mailto:orbit@localhost'; // fixo: nenhum e-mail real sai da máquina
const VALIDADE_JWT_S = 12 * 3600 - 600; // RFC 8292: no máximo 24 h; o Orbit usa menos que 12 h
const TAM_REGISTRO = 4096;
const MAX_PAYLOAD = TAM_REGISTRO - 86 - 17; // corpo total <= 4096: cabeçalho (21 + 65) + delimitador + tag de 16 => 3993 bytes (RFC 8291 §4)
const MS_ENVIO = 10_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (s) => Buffer.from(String(s), 'base64url');

// ───────────────────────── cifra (RFC 8291 + RFC 8188) ─────────────────────────

// Cifra `payload` (Buffer) para o assinante. `efemeraPrivada` (32 bytes) e `salt` (16 bytes) só são passados
// pelos testes (vetor do Apêndice A da RFC 8291); em uso real saem do crypto.randomBytes / ECDH novo.
// Devolve o corpo completo da requisição: cabeçalho aes128gcm (salt, rs, idlen, keyid) + um registro.
export function cifrarAes128gcm({ payload, uaPublica, authSecret, efemeraPrivada, salt }) {
  const ua = Buffer.from(uaPublica);
  const auth = Buffer.from(authSecret);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error('chave p256dh inválida');
  if (auth.length !== 16) throw new Error('segredo auth inválido');
  const dados = Buffer.from(payload);
  if (dados.length > MAX_PAYLOAD) throw new Error('payload grande demais');

  const ecdh = crypto.createECDH('prime256v1');
  if (efemeraPrivada) ecdh.setPrivateKey(Buffer.from(efemeraPrivada));
  else ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey(); // 65 bytes
  const saltReg = salt ? Buffer.from(salt) : crypto.randomBytes(16);
  if (saltReg.length !== 16) throw new Error('salt inválido');

  const segredo = ecdh.computeSecret(ua);
  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0" || ua || as, 32)
  const infoChave = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ua, asPublica]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', segredo, auth, infoChave, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, saltReg, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, saltReg, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // Um registro só e último: delimitador 0x02, sem padding extra.
  const texto = Buffer.concat([cifra.update(Buffer.concat([dados, Buffer.from([2])])), cifra.final(), cifra.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(TAM_REGISTRO);
  return Buffer.concat([saltReg, rs, Buffer.from([asPublica.length]), asPublica, texto]);
}

// ───────────────────────── VAPID (RFC 8292) ─────────────────────────

// JWT ES256 com a assinatura em IEEE P1363 (r||s, 64 bytes). `agora` em segundos (injetável nos testes).
export function assinarJwtVapid(chavePrivada, audiencia, agora = Math.floor(Date.now() / 1000)) {
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const corpo = b64u(JSON.stringify({ aud: audiencia, exp: agora + VALIDADE_JWT_S, sub: SUB }));
  const assinatura = crypto.sign('sha256', Buffer.from(`${cab}.${corpo}`), { key: chavePrivada, dsaEncoding: 'ieee-p1363' });
  return `${cab}.${corpo}.${b64u(assinatura)}`;
}

function publicaDe(chavePrivada) {
  const jwk = crypto.createPublicKey(chavePrivada).export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)]);
}

// ───────────────────────── criarPush ─────────────────────────

export function criarPush({ cofre, arquivoChaves, log = () => {}, permitirHttp = false, timeoutMs = MS_ENVIO } = {}) {
  if (!cofre || typeof cofre.ler !== 'function' || typeof cofre.guardar !== 'function') throw new Error('push: falta o cofre');
  if (!arquivoChaves) throw new Error('push: falta o arquivoChaves');

  let carregando = null; // Promise<{ privada: KeyObject, publica: string }>

  async function gravarPublica(publica) {
    await fsp.mkdir(path.dirname(arquivoChaves), { recursive: true });
    const tmp = `${arquivoChaves}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ publica }, null, 2));
    await fsp.rename(tmp, arquivoChaves);
  }

  async function lerPublicaGravada() {
    try { return String(JSON.parse(await fsp.readFile(arquivoChaves, 'utf8'))?.publica || ''); } catch { return ''; }
  }

  async function carregar() {
    let privada = null;
    const guardado = String((await cofre.ler()) || '').trim();
    if (guardado) {
      try { privada = crypto.createPrivateKey({ key: deB64u(guardado), format: 'der', type: 'pkcs8' }); } catch { log('push: a chave VAPID guardada não abriu; gerando outra'); }
    }
    if (!privada) {
      // Chave nova: o cofre vem antes do arquivo, para nunca existir pública sem privada guardada.
      const par = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      privada = par.privateKey;
      await cofre.guardar(b64u(privada.export({ format: 'der', type: 'pkcs8' })));
      log('push: par VAPID novo gerado (assinaturas antigas precisam ser refeitas)');
    }
    const publica = b64u(publicaDe(privada));
    if ((await lerPublicaGravada()) !== publica) await gravarPublica(publica);
    return { privada, publica };
  }

  const chaves = () => (carregando ||= carregar().catch((e) => { carregando = null; throw e; }));

  const chavePublica = async () => (await chaves()).publica;

  function enviar(assinatura, payload, { ttl = 3600, urgencia = 'high' } = {}) {
    return enviarInterno(assinatura, payload, { ttl, urgencia }).catch((e) => {
      log('push: envio falhou:', e?.message || e); // sem endpoint nem chaves no log
      return { status: 0 };
    });
  }

  async function enviarInterno(assinatura, payload, { ttl, urgencia }) {
    let url;
    let uaPublica;
    let auth;
    try {
      url = new URL(String(assinatura?.endpoint || ''));
      uaPublica = deB64u(assinatura?.keys?.p256dh);
      auth = deB64u(assinatura?.keys?.auth);
    } catch { throw new Error('assinatura inválida'); }
    const https_ = url.protocol === 'https:';
    if (!https_ && !(permitirHttp && url.protocol === 'http:')) throw new Error('endpoint precisa ser https');
    if (!['very-low', 'low', 'normal', 'high'].includes(urgencia)) urgencia = 'high';
    ttl = Math.max(0, Math.floor(Number(ttl)) || 0);

    const texto = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload ?? {});
    const corpo = cifrarAes128gcm({ payload: texto, uaPublica, authSecret: auth });
    const { privada, publica } = await chaves();
    const jwt = assinarJwtVapid(privada, url.origin);

    const opcoes = {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs), // prazo total do envio, não só ocioso
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers: {
        Authorization: `vapid t=${jwt}, k=${publica}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': corpo.length,
        TTL: String(ttl),
        Urgency: urgencia,
      },
    };
    return new Promise((resolve, reject) => {
      const req = (https_ ? https : http).request(opcoes, (res) => {
        res.resume(); // a resposta não interessa; só o status
        res.on('end', () => resolve({ status: res.statusCode }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(corpo);
    });
  }

  return { chavePublica, enviar };
}
