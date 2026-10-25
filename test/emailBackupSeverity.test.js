// A permission error is not an outage. On 2026-10-24 a test send from a mailbox
// the tenant's AppOnly AccessPolicy does not cover failed with a 403, and every
// human in #wren-assistant got an @channel ping telling them to "follow up
// manually" on a message no human could ever have sent by hand.
//
// The first version of this classifier searched the whole error string, which
// quotes our own subject and recipient list back at us. That let anyone who
// could get "403" or "AccessPolicy" into a subject line downgrade a REAL outage
// to a quiet note. It now reads structured facts, and anything ambiguous pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfigFailure } from "../src/lib/emailBackup.js";

const RAOP_BODY = 'Graph MIME draft POST 403: {"error":{"code":"ErrorAccessDenied","message":"Access to OData is disabled: [RAOP] : Blocked by tenant configured AppOnly AccessPolicy settings."}}';

test("the status decides, and 403 is a configuration failure", () => {
  assert.equal(isConfigFailure(RAOP_BODY, { status: 403, errorCode: "ErrorAccessDenied" }), true);
  assert.equal(isConfigFailure("whatever", { status: 401 }), true);
});

test("a transport status pages even when the body talks about access policies", () => {
  assert.equal(isConfigFailure(RAOP_BODY, { status: 503 }), false);
  assert.equal(isConfigFailure("Graph sendMail 500", { status: 500 }), false);
});

test("a known provider code is enough on its own, compared exactly", () => {
  assert.equal(isConfigFailure("", { errorCode: "InvalidAuthenticationToken" }), true);
  assert.equal(isConfigFailure("", { errorCode: "  erroraccessdenied " }), true);
  assert.equal(isConfigFailure("", { errorCode: "ErrorAccessDeniedPlease" }), false);
  assert.equal(isConfigFailure("", { errorCode: "ErrorMailboxStoreUnavailable" }), false);
});

test("with no facts at all it reads only the error-code field", () => {
  assert.equal(isConfigFailure(RAOP_BODY), true);
  assert.equal(isConfigFailure('{"error":{"code":"ErrorMailboxStoreUnavailable"}}'), false);
  assert.equal(isConfigFailure("Graph sendMail 503: Service Unavailable"), false);
});

test("a hostile subject or recipient cannot silence the siren", () => {
  // Every one of these is attacker-reachable text quoted back inside a REAL
  // outage message. None of them may suppress the page.
  for (const reason of [
    'Graph MIME send POST 503: {"error":{"code":"ErrorMailboxStoreUnavailable","message":"To: accesspolicy@evil.com"}}',
    'Graph MIME send POST 500: subject was "RE: invoice 403 ErrorAccessDenied RAOP"',
    "Graph sendMail failed for invalid_client@partner.example: 502 Bad Gateway",
    'Graph 504: {"error":{"message":"AADSTS mentioned by the sender"}}',
  ]) {
    assert.equal(isConfigFailure(reason), false, reason);
    assert.equal(isConfigFailure(reason, { status: 503 }), false, reason);
  }
});

test("an empty or missing reason pages rather than going quiet", () => {
  assert.equal(isConfigFailure(""), false);
  assert.equal(isConfigFailure(undefined), false);
  assert.equal(isConfigFailure(undefined, {}), false);
});
