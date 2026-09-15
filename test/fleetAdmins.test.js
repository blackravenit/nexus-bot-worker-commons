import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAdminNexusUserIds,
  isFleetAdmin,
  getPrimaryAdminNexusUserId,
} from "../src/lib/fleetAdmins.js";

const BRIAN = "69276926-7182-4920-a849-fc6f27dc049b";
const SECOND = "11112222-3333-4444-5555-666677778888";

test("parses a comma separated list in order", () => {
  const env = { ADMIN_NEXUS_USER_IDS: `${BRIAN},${SECOND}` };
  assert.deepEqual(getAdminNexusUserIds(env), [BRIAN, SECOND]);
});

test("trims whitespace and drops empty entries", () => {
  const env = { ADMIN_NEXUS_USER_IDS: `  ${BRIAN} , , ${SECOND}  ,` };
  assert.deepEqual(getAdminNexusUserIds(env), [BRIAN, SECOND]);
});

test("de duplicates repeated ids", () => {
  const env = { ADMIN_NEXUS_USER_IDS: `${BRIAN}, ${BRIAN}` };
  assert.deepEqual(getAdminNexusUserIds(env), [BRIAN]);
});

test("falls back to the legacy BRIAN_NEXUS_USER_ID when the list is unset", () => {
  assert.deepEqual(getAdminNexusUserIds({ BRIAN_NEXUS_USER_ID: BRIAN }), [BRIAN]);
});

test("falls back to the legacy var when the list is present but blank", () => {
  const env = { ADMIN_NEXUS_USER_IDS: "  , ", BRIAN_NEXUS_USER_ID: ` ${BRIAN} ` };
  assert.deepEqual(getAdminNexusUserIds(env), [BRIAN]);
});

test("the list wins over the legacy var when both are set", () => {
  const env = { ADMIN_NEXUS_USER_IDS: SECOND, BRIAN_NEXUS_USER_ID: BRIAN };
  assert.deepEqual(getAdminNexusUserIds(env), [SECOND]);
});

test("an unconfigured env yields no admins, never a hardcoded uid", () => {
  assert.deepEqual(getAdminNexusUserIds({}), []);
  assert.deepEqual(getAdminNexusUserIds(undefined), []);
  assert.deepEqual(getAdminNexusUserIds({ BRIAN_NEXUS_USER_ID: "   " }), []);
});

test("isFleetAdmin matches any id in the list", () => {
  const env = { ADMIN_NEXUS_USER_IDS: `${BRIAN},${SECOND}` };
  assert.equal(isFleetAdmin(env, BRIAN), true);
  assert.equal(isFleetAdmin(env, SECOND), true);
  assert.equal(isFleetAdmin(env, "99999999-0000-0000-0000-000000000000"), false);
});

test("isFleetAdmin tolerates a padded caller id but rejects empty and non string", () => {
  const env = { ADMIN_NEXUS_USER_IDS: BRIAN };
  assert.equal(isFleetAdmin(env, ` ${BRIAN} `), true);
  assert.equal(isFleetAdmin(env, ""), false);
  assert.equal(isFleetAdmin(env, undefined), false);
  assert.equal(isFleetAdmin(env, null), false);
});

test("isFleetAdmin fails closed when nothing is configured", () => {
  assert.equal(isFleetAdmin({}, BRIAN), false);
});

test("getPrimaryAdminNexusUserId returns the first id or null", () => {
  assert.equal(getPrimaryAdminNexusUserId({ ADMIN_NEXUS_USER_IDS: `${SECOND},${BRIAN}` }), SECOND);
  assert.equal(getPrimaryAdminNexusUserId({ BRIAN_NEXUS_USER_ID: BRIAN }), BRIAN);
  assert.equal(getPrimaryAdminNexusUserId({}), null);
});
