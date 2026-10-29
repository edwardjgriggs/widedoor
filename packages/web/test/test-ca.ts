import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/*
 * A throwaway certificate authority for TLS tests: one CA and one leaf for a DNS name,
 * both EC P-256, valid for a day. Tests trust the CA through `ca`; verification stays on.
 * X.509 has no builder in node:crypto, so this writes the few DER structures it needs.
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts: Buffer[]): Buffer => der(0x30, ...parts);

function oid(text: string): Buffer {
  const [a = 0, b = 0, ...rest] = text.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return der(0x17, Buffer.from(text, 'ascii'));
}

const name = (cn: string): Buffer =>
  seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function certificate(options: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  extensions: Buffer[];
}): string {
  const serial = randomBytes(8);
  // Positive (top bit clear) and minimal DER (a leading 0x00 is not): OpenSSL refuses
  // a non-minimal INTEGER, which a random first byte of 0 would give 1 run in 512.
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_SHA256,
    name(options.issuer),
    seq(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 86400_000))),
    name(options.subject),
    options.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(...options.extensions)),
  );
  const signature = sign('sha256', tbs, options.signingKey);
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), signature));
  const lines = cert.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export interface TestCertificates {
  /** PEM of the CA certificate, for the client's `ca`. */
  ca: string;
  /** PEM of the leaf certificate and its private key, for the server. */
  cert: string;
  key: string;
}

export function makeTestCertificates(dnsName: string): TestCertificates {
  const caKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leafKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caName = 'Widedoor throwaway test CA';
  const ca = certificate({
    subject: caName,
    issuer: caName,
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      // basicConstraints cA=TRUE; keyUsage keyCertSign and cRLSign.
      extension('2.5.29.19', true, seq(der(0x01, Buffer.from([0xff])))),
      extension('2.5.29.15', true, der(0x03, Buffer.from([1, 0x06]))),
    ],
  });
  const cert = certificate({
    subject: dnsName,
    issuer: caName,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      extension('2.5.29.19', true, seq()),
      // keyUsage digitalSignature; extKeyUsage serverAuth; subjectAltName dNSName.
      extension('2.5.29.15', true, der(0x03, Buffer.from([7, 0x80]))),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(der(0x82, Buffer.from(dnsName, 'ascii')))),
    ],
  });
  const key = leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { ca, cert, key };
}
