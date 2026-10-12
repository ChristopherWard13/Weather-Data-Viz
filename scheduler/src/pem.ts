/**
 * A GitHub App's private key as WebCrypto can import it. GitHub hands out
 * PKCS#1 PEM ("BEGIN RSA PRIVATE KEY") and WebCrypto only takes PKCS#8, so a
 * PKCS#1 key is wrapped in a PrivateKeyInfo here; a PKCS#8 key passes through.
 * Keys pasted with literal "\n" escapes (a common secret-store accident) work too.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const text = pem.replace(/\\n/g, "\n").trim();
  const m = text.match(/^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]+?)-----END \1-----$/);
  if (!m) throw new Error("the App key isn't a PEM private key (expected BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)");
  const der = fromBase64(m[2].replace(/\s+/g, ""));
  return m[1] === "PRIVATE KEY" ? der : wrapPkcs1(der);
}

// SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/** PrivateKeyInfo ::= SEQUENCE { version 0, algorithm, OCTET STRING { RSAPrivateKey } } */
export function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const body = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, 0x04, ...derLength(pkcs1.length)];
  const inner = body.length + pkcs1.length;
  const head = [0x30, ...derLength(inner), ...body];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head);
  out.set(pkcs1, head.length);
  return out;
}

/** DER length: one byte below 128, otherwise 0x80 + the count of big-endian length bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
