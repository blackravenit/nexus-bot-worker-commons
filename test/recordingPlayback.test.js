// Twilio recording media 401s without the owning account's credentials, so a
// stored recording_url cannot be played in a browser. The CRM signs a short lived
// link and the bridge verifies it, which is why this lives in commons: the two
// workers must agree exactly, and the signature IS the access control on real
// prospect and support call audio.
import test from 'node:test';
import assert from 'node:assert';
import {
  signPlaybackUrl, verifyPlaybackRequest, recordingSidFromUrl, isRecordingSid, PLAYBACK_TTL_SEC,
} from '../src/lib/recordingPlayback.js';

const SID = 'RE' + 'a'.repeat(32);
const ENV = { RECORDING_PLAYBACK_KEY: 'test-key', BRIDGE_PUBLIC_URL: 'https://bridge.example' };

test('a signed link verifies, and a tampered one does not', async () => {
  const url = await signPlaybackUrl(ENV, SID);
  const ok = await verifyPlaybackRequest(ENV, new URL(url));
  assert.equal(ok.ok, true);
  assert.equal(ok.sid, SID);

  // Swapping the sid while keeping the signature must fail: otherwise one valid
  // link would play every recording in the account.
  const other = 'RE' + 'b'.repeat(32);
  const swapped = new URL(url);
  swapped.searchParams.set('sid', other);
  assert.equal((await verifyPlaybackRequest(ENV, swapped)).ok, false);

  const badSig = new URL(url);
  badSig.searchParams.set('sig', 'deadbeef');
  assert.equal((await verifyPlaybackRequest(ENV, badSig)).ok, false);
});

test('an expired link is refused', async () => {
  const url = await signPlaybackUrl(ENV, SID, { ttlSec: 60 });
  const later = Date.now() + 61_000;
  const res = await verifyPlaybackRequest(ENV, new URL(url), later);
  assert.equal(res.ok, false);
  assert.match(res.reason, /expired/);
});

test('extending the expiry invalidates the signature', async () => {
  // exp is signed, so a caller cannot simply edit it to keep a link alive.
  const url = await signPlaybackUrl(ENV, SID, { ttlSec: 60 });
  const stretched = new URL(url);
  stretched.searchParams.set('exp', String(Math.floor(Date.now() / 1000) + 99999));
  assert.equal((await verifyPlaybackRequest(ENV, stretched)).ok, false);
});

test('no signing key configured means nothing is signed and nothing verifies', async () => {
  // Fails CLOSED. An unsigned endpoint would serve call audio to anyone.
  assert.equal(await signPlaybackUrl({}, SID), '');
  const url = await signPlaybackUrl(ENV, SID);
  assert.equal((await verifyPlaybackRequest({}, new URL(url))).ok, false);
});

test('only a real recording sid is accepted', async () => {
  for (const bad of ['', 'RE123', 'CA' + 'a'.repeat(32), '../../etc/passwd', null,
    'RE' + 'a'.repeat(31) + 'z']) {
    assert.equal(isRecordingSid(bad), false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(await signPlaybackUrl(ENV, bad), '', 'must not sign a bad sid');
  }
  assert.equal(isRecordingSid(SID), true);
});

test('recordingSidFromUrl pulls the sid out of a stored Twilio URL', () => {
  assert.equal(
    recordingSidFromUrl(`https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/${SID}.mp3`),
    SID,
  );
  // No extension, and with a query string, both appear in the wild.
  assert.equal(recordingSidFromUrl(`https://api.twilio.com/x/Recordings/${SID}`), SID);
  assert.equal(recordingSidFromUrl(`https://api.twilio.com/x/Recordings/${SID}.mp3?Download=true`), SID);
  for (const bad of ['', null, 'https://evil.example/Recordings/REzz', 'https://api.twilio.com/Calls/CA1']) {
    assert.equal(recordingSidFromUrl(bad), '');
  }
});

test('the default TTL is hours, not days', () => {
  assert.ok(PLAYBACK_TTL_SEC > 0 && PLAYBACK_TTL_SEC <= 24 * 3600);
});

test('persona is part of the signature, because it picks Twilio credentials', async () => {
  // A subaccount persona (fieldpilot) has its own Twilio credentials, so persona
  // selects which account the bridge queries. Leaving it out of the signed string
  // would make it a caller-editable input to that choice.
  const url = await signPlaybackUrl(ENV, SID, { persona: 'fieldpilot' });
  assert.match(url, /persona=fieldpilot/);
  const ok = await verifyPlaybackRequest(ENV, new URL(url));
  assert.equal(ok.ok, true);
  assert.equal(ok.persona, 'fieldpilot');

  const swapped = new URL(url);
  swapped.searchParams.set('persona', 'jacob');
  assert.equal((await verifyPlaybackRequest(ENV, swapped)).ok, false, 'persona must not be swappable');

  const dropped = new URL(url);
  dropped.searchParams.delete('persona');
  assert.equal((await verifyPlaybackRequest(ENV, dropped)).ok, false, 'persona must not be removable');
});

test('a link with no persona still verifies, for accounts on the master', async () => {
  const url = await signPlaybackUrl(ENV, SID);
  assert.ok(!url.includes('persona='));
  const ok = await verifyPlaybackRequest(ENV, new URL(url));
  assert.equal(ok.ok, true);
  assert.equal(ok.persona, '');
});
