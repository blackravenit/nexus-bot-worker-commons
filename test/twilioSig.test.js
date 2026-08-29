import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyTwilioSignature } from "../src/lib/twilioSig.js";

const TOKEN = "test-twilio-auth-token";
const URL_STR = "https://robert-worker.blackravenit.workers.dev/twilio/sms";

/** Reproduces Twilio's own signing algorithm for a given URL + params. */
async function signTwilio(token, url, params) {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const paramStr = entries.map(([k, v]) => `${k}${v}`).join("");
  const data = url + paramStr;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  let bin = "";
  for (const b of new Uint8Array(sigBytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function makeRequest(url, sig, body) {
  const headers = new Headers();
  if (sig !== undefined) headers.set("X-Twilio-Signature", sig);
  return new Request(url, { method: "POST", headers, body: new URLSearchParams(body) });
}

test("verifyTwilioSignature accepts a correctly signed request", async () => {
  const params = { From: "+15551234567", Body: "1" };
  const sig = await signTwilio(TOKEN, URL_STR, params);
  const req = makeRequest(URL_STR, sig);
  const ok = await verifyTwilioSignature({ TWILIO_AUTH_TOKEN: TOKEN }, req, new URLSearchParams(params));
  assert.equal(ok, true);
});

test("verifyTwilioSignature rejects a tampered body", async () => {
  const params = { From: "+15551234567", Body: "1" };
  const sig = await signTwilio(TOKEN, URL_STR, params);
  const req = makeRequest(URL_STR, sig);
  const tampered = new URLSearchParams({ From: "+15551234567", Body: "2" });
  const ok = await verifyTwilioSignature({ TWILIO_AUTH_TOKEN: TOKEN }, req, tampered);
  assert.equal(ok, false);
});

test("verifyTwilioSignature rejects a missing signature header", async () => {
  const params = { From: "+15551234567", Body: "1" };
  const req = makeRequest(URL_STR, undefined);
  const ok = await verifyTwilioSignature({ TWILIO_AUTH_TOKEN: TOKEN }, req, new URLSearchParams(params));
  assert.equal(ok, false);
});

test("verifyTwilioSignature rejects a wrong auth token", async () => {
  const params = { From: "+15551234567", Body: "1" };
  const sig = await signTwilio(TOKEN, URL_STR, params);
  const req = makeRequest(URL_STR, sig);
  const ok = await verifyTwilioSignature({ TWILIO_AUTH_TOKEN: "wrong-token" }, req, new URLSearchParams(params));
  assert.equal(ok, false);
});

test("verifyTwilioSignature fails closed when TWILIO_AUTH_TOKEN is unset", async () => {
  const params = { From: "+15551234567", Body: "1" };
  const sig = await signTwilio(TOKEN, URL_STR, params);
  const req = makeRequest(URL_STR, sig);
  const ok = await verifyTwilioSignature({}, req, new URLSearchParams(params));
  assert.equal(ok, false);
});
