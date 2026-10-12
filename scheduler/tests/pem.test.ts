import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt } from "../src/github";
import { pemToPkcs8, wrapPkcs1 } from "../src/pem";

// A GitHub App key is PKCS#1 PEM, RSA 2048
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const pkcs1Der = new Uint8Array(privateKey.export({ type: "pkcs1", format: "der" }));
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pkcs8Der = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));

describe("pemToPkcs8", () => {
  it("wraps PKCS#1 into the same PrivateKeyInfo OpenSSL writes", () => {
    expect(wrapPkcs1(pkcs1Der)).toEqual(pkcs8Der);
    expect(pemToPkcs8(pkcs1Pem)).toEqual(pkcs8Der);
  });
  it("passes PKCS#8 through", () => {
    expect(pemToPkcs8(pkcs8Pem)).toEqual(pkcs8Der);
  });
  it("accepts a key pasted with literal \\n escapes", () => {
    expect(pemToPkcs8(pkcs1Pem.trim().replace(/\n/g, "\\n"))).toEqual(pkcs8Der);
  });
  it("rejects anything else", () => {
    expect(() => pemToPkcs8("not a key")).toThrow(/PEM private key/);
    expect(() => pemToPkcs8(createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string)).toThrow();
  });
});

describe("appJwt", () => {
  it("is an RS256 JWT for the App, backdated a minute and valid nine", async () => {
    const now = new Date("2026-10-12T20:00:00Z");
    const jwt = await appJwt("123456", pkcs1Pem, now);
    const [h, p, sig] = jwt.split(".");
    const json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());
    expect(json(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const t = now.getTime() / 1000;
    expect(json(p)).toEqual({ iat: t - 60, exp: t + 540, iss: "123456" });
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(privateKey), Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});
