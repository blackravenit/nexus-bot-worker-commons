// A permission error is not an outage. On 2026-10-24 a test send from a mailbox
// the tenant's AppOnly AccessPolicy does not cover failed with a 403, and every
// human in #wren-assistant got an @channel ping telling them to "follow up
// manually" on a message that no human could ever have sent by hand. The siren
// belongs to real outages; a config failure gets a quiet, accurate line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfigFailure } from "../src/lib/emailBackup.js";

const RAOP = 'Graph MIME draft POST 403: {"error":{"code":"ErrorAccessDenied","message":"Access to OData is disabled: [RAOP] : Blocked by tenant configured AppOnly AccessPolicy settings."}}';

test("the access-policy 403 that started this is a configuration failure", () => {
  assert.equal(isConfigFailure(RAOP), true);
});

test("every other way a token or grant can be wrong counts too", () => {
  for (const reason of [
    "AADSTS7000215: Invalid client secret provided",
    "invalid_client",
    "401 Unauthorized",
    "InvalidAuthenticationToken: Access token has expired",
    "MailboxNotEnabledForRESTAPI",
    "Authorization_RequestDenied: Insufficient privileges to complete the operation",
  ]) {
    assert.equal(isConfigFailure(reason), true, reason);
  }
});

test("a real outage still pages the channel", () => {
  for (const reason of [
    "Graph sendMail 503: Service Unavailable",
    "fetch failed: network timeout after 20000ms",
    "Graph 429 too many requests",
    "ErrorMailboxStoreUnavailable",
    "500 internal server error",
  ]) {
    assert.equal(isConfigFailure(reason), false, reason);
  }
});

test("an empty or missing reason is treated as an outage, not silenced", () => {
  assert.equal(isConfigFailure(""), false);
  assert.equal(isConfigFailure(undefined), false);
});
