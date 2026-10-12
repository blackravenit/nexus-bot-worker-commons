// The internal-client gate. One wrong answer here either leaks a sale onto our
// own books or suppresses a real customer's paperwork, so both directions are
// pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInternalRow,
  internalSkipReason,
  INTERNAL_COGS_ACCOUNT,
} from "../src/lib/internalClient.js";

test("isInternalRow accepts both shapes the CRM serves", () => {
  assert.equal(isInternalRow({ is_internal: 1 }), true, "client row");
  assert.equal(isInternalRow({ client_is_internal: 1 }), true, "joined opp/contract row");
  assert.equal(isInternalRow({ is_internal: "1" }), true, "string from a form post");
  assert.equal(isInternalRow({ client_is_internal: "1" }), true);
  assert.equal(isInternalRow({ is_internal: true }), true);
});

test("isInternalRow is false for a real client and for every absent shape", () => {
  assert.equal(isInternalRow({ is_internal: 0 }), false);
  assert.equal(isInternalRow({ client_is_internal: 0 }), false);
  assert.equal(isInternalRow({ is_internal: "" }), false);
  assert.equal(isInternalRow({ is_internal: null }), false);
  assert.equal(isInternalRow({ company: "Acme Dental" }), false, "flag absent entirely");
  assert.equal(isInternalRow({}), false);
  assert.equal(isInternalRow(null), false);
  assert.equal(isInternalRow(undefined), false);
});

test("either field saying internal is enough, in both orders", () => {
  // A caller that merges an opportunity over its client, or fetches one of the
  // two partially, must not let an absent or zero field overrule a present 1.
  assert.equal(isInternalRow({ is_internal: 1, client_is_internal: 0 }), true);
  assert.equal(isInternalRow({ is_internal: 0, client_is_internal: 1 }), true);
  assert.equal(isInternalRow({ is_internal: null, client_is_internal: 1 }), true);
  assert.equal(isInternalRow({ is_internal: 0, client_is_internal: 0 }), false);
});

test("the reader accepts exactly what crm-app truthyFlag writes", () => {
  // A gate that accepts less than its writer disagrees with the record it is
  // gating on. truthyFlag maps true, 1, "1" and "true" to a stored 1.
  for (const v of [true, 1, "1", "true"]) {
    assert.equal(isInternalRow({ is_internal: v }), true, `is_internal=${JSON.stringify(v)}`);
    assert.equal(isInternalRow({ client_is_internal: v }), true, `client_is_internal=${JSON.stringify(v)}`);
  }
  // Everything truthyFlag maps to 0 must read as not internal.
  for (const v of [false, 0, "0", "false", "", "yes", "TRUE", 2, null, undefined]) {
    assert.equal(isInternalRow({ is_internal: v }), false, `is_internal=${JSON.stringify(v)}`);
  }
});

test("absence never reads as internal, so a real client is never silenced", () => {
  // Fail direction matters: defaulting an unknown row to internal would stop a
  // paying customer's contract, invoice and onboarding with no error anywhere.
  for (const row of [{}, null, undefined, { is_internal: undefined }]) {
    assert.equal(isInternalRow(row), false);
  }
});

test("internalSkipReason names what was skipped and why", () => {
  const reason = internalSkipReason("Thank-you email");
  assert.match(reason, /^Thank-you email skipped:/);
  assert.match(reason, /is_internal = 1/);
  assert.match(reason, /not a sale/);
});

test("the internal expense account matches the CRM and Maxwell", () => {
  assert.equal(INTERNAL_COGS_ACCOUNT, "6080");
});
