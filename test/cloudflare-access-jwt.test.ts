import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareAccessJwtValidator,
  type AccessJwk,
  type AccessJwksProvider
} from "../src/access/cloudflare-access-jwt.ts";

const textEncoder = new TextEncoder();
const toBase64Url = (value: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const staticNow = () => new Date("2026-08-16T10:00:00.000Z");
const issuer = "https://personal-consultant.cloudflareaccess.com";
const audience = "settings-audience";
const ownerEmail = "owner@example.com";

async function createSignedAssertion(input: Readonly<{
  key: CryptoKey;
  kid: string;
  email?: string;
  aud?: string | readonly string[];
  exp?: number;
  nbf?: number;
  iss?: string;
}>): Promise<string> {
  const header = toBase64Url(JSON.stringify({ alg: "RS256", kid: input.kid, typ: "JWT" }));
  const claims = toBase64Url(JSON.stringify({
    iss: input.iss ?? issuer,
    aud: input.aud ?? audience,
    exp: input.exp ?? 1_786_878_000,
    email: input.email ?? ownerEmail,
    ...(input.nbf === undefined ? {} : { nbf: input.nbf })
  }));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    input.key,
    textEncoder.encode(signingInput)
  );
  return `${signingInput}.${toBase64Url(signature)}`;
}

async function createKeys(kid: string): Promise<Readonly<{ privateKey: CryptoKey; publicJwk: AccessJwk }>> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return Object.freeze({ privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } });
}

const createValidator = (jwks: AccessJwksProvider) => new CloudflareAccessJwtValidator({
  issuer,
  audience,
  ownerEmail,
  jwks,
  now: staticNow
});

test("accepts only a correctly signed Cloudflare Access assertion for the exact owner", async () => {
  const keys = await createKeys("key-one");
  const assertion = await createSignedAssertion({ key: keys.privateKey, kid: "key-one", email: " Owner@Example.com " });
  const validator = createValidator({ load: async () => [keys.publicJwk] });

  const principal = await validator.verifyRequest(new Request("https://settings.example.test/settings", {
    headers: { "cf-access-jwt-assertion": assertion }
  }));

  assert.deepEqual(principal, { kind: "owner" });
});

test("fails closed for a bad audience, issuer, email, expiry or a missing assertion", async () => {
  const keys = await createKeys("key-one");
  const validator = createValidator({ load: async () => [keys.publicJwk] });
  const invalidAssertions = await Promise.all([
    createSignedAssertion({ key: keys.privateKey, kid: "key-one", aud: "other-audience" }),
    createSignedAssertion({ key: keys.privateKey, kid: "key-one", iss: "https://other.cloudflareaccess.com" }),
    createSignedAssertion({ key: keys.privateKey, kid: "key-one", email: "other@example.com" }),
    createSignedAssertion({ key: keys.privateKey, kid: "key-one", exp: 1_786_870_000 })
  ]);

  for (const assertion of invalidAssertions) {
    assert.equal(await validator.verifyToken(assertion), undefined);
  }
  assert.equal(await validator.verifyRequest(new Request("https://settings.example.test/settings")), undefined);
});

test("refreshes JWKS once for an unknown kid and never accepts a stale cached match as a bypass", async () => {
  const initialKeys = await createKeys("initial-key");
  const rotatedKeys = await createKeys("rotated-key");
  const initialAssertion = await createSignedAssertion({ key: initialKeys.privateKey, kid: "initial-key" });
  const assertion = await createSignedAssertion({ key: rotatedKeys.privateKey, kid: "rotated-key" });
  let loads = 0;
  const validator = createValidator({
    load: async () => {
      loads += 1;
      return loads === 1 ? [initialKeys.publicJwk] : [rotatedKeys.publicJwk];
    }
  });

  assert.deepEqual(await validator.verifyToken(initialAssertion), { kind: "owner" });
  assert.deepEqual(await validator.verifyToken(assertion), { kind: "owner" });
  assert.equal(loads, 2);
});

test("an unknown kid with no cache performs one JWKS fetch, not two back-to-back fetches", async () => {
  const signingKeys = await createKeys("unknown-key");
  const unrelatedKeys = await createKeys("unrelated-key");
  const assertion = await createSignedAssertion({ key: signingKeys.privateKey, kid: "unknown-key" });
  let loads = 0;
  const validator = createValidator({ load: async () => { loads += 1; return [unrelatedKeys.publicJwk]; } });

  assert.equal(await validator.verifyToken(assertion), undefined);
  assert.equal(loads, 1);
});
