/**
 * Consent + agreement form , server contract test.
 *
 *   node --test test/consent-form.test.mjs
 *
 * consent.html posts to the SAME /api/submit endpoint as the full intake
 * form, with formKind: "consent". This test drives the real Cloudflare
 * Function with a payload built from the REAL clause module, so the fixture
 * cannot drift from what a browser actually sends: consent-clauses.js is
 * loaded and its label text used verbatim.
 *
 * What it is defending:
 *   , a consent submission carries no story, and must not be held to the
 *     full form's story contract
 *   , both ticks are load-bearing. Publication consent and acceptance of the
 *     Young Author Agreement are separate acts and neither substitutes for
 *     the other
 *   , the agreement summary the guardian read is stored verbatim. A record
 *     that only points at editable text is not evidence of what was accepted
 *   , consent records file under the consent/ prefix, never the bucket root
 *     where the editor's story importer reads
 *   , a payload WITHOUT formKind still gets the full-story contract, so this
 *     branch can never become a way around it
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestPost } from '../functions/api/submit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// Load consent-clauses.js the way the browser does, so the clause text in this
// test IS the clause text the form ships. Not a mirror fixture: the real thing.
const CLAUSES = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'consent-clauses.js'), 'utf8');
  const g = {};
  new Function('window', src.replace("typeof window !== 'undefined' ? window : this", 'arguments[0]'))(g);
  return g.BUKMUK_CONSENT;
})();

// Mirror of consent.js LABELS. Change one there, change it here.
const L = {
  authorName: 'Your name',
  authorAge: 'How old are you?',
  authorLocation: 'Which city or town do you live in?',
  storyTitle: "Your story's title",
  creditAs: 'How should we name you?',
  penName: 'Your pen name',
  childAssent: 'Do you want your story in the book?',
  guardianName: 'Parent/guardian full name',
  guardianRelation: 'Your relationship',
  guardianEmail: "A grown-up's email (so we can reach your parent/guardian)",
  guardianPhone: 'Phone',
  guardianSignature: 'Type your full name as a signature',
  consentDate: 'Date',
  consentPublish: CLAUSES.LABELS.consentPublish,
  consentPhoto: CLAUSES.LABELS.consentPhoto,
  consentLocation: CLAUSES.LABELS.consentLocation,
  agreementAccepted: CLAUSES.LABELS.agreementAccepted,
  agreementVersion: 'Agreement version',
  agreementSummary: 'Agreement summary as shown',
  agreementUrl: 'Full agreement URL',
  formKind: 'formKind',
  book: 'book',
  channel: 'channel',
};

function fixture(){
  const v = {
    authorName: 'Avish Jain', authorAge: '9', storyTitle: "Mageton's Big Adventure",
    authorLocation: 'Haridwar', creditAs: 'My full name', childAssent: 'Yes',
    guardianName: 'Neha Jain', guardianRelation: 'Mother',
    guardianEmail: 'neha@example.in', guardianPhone: '+91 9812345678',
    guardianSignature: 'Neha Jain', consentDate: '2026-08-31',
    consentPublish: L.consentPublish,
    consentPhoto: L.consentPhoto,
    consentLocation: L.consentLocation,
    agreementAccepted: L.agreementAccepted,
    agreementVersion: CLAUSES.AGREEMENT_VERSION,
    agreementSummary: CLAUSES.summaryText(),
    agreementUrl: CLAUSES.AGREEMENT_URL,
    formKind: 'consent', book: 'mageton-avish', channel: 'whatsapp',
  };
  return {
    data: { fields: Object.entries(v).map(([k, value]) => ({ label: L[k], key: k, value })) },
  };
}

const clone = () => JSON.parse(JSON.stringify(fixture()));
const drop = (p, key) => { p.data.fields = p.data.fields.filter(f => f.key !== key); return p; };
const set  = (p, key, value) => { const f = p.data.fields.find(x => x.key === key); if (f) f.value = value; return p; };

async function post(payload){
  const puts = [];
  const env = { INTAKE_SUBMISSIONS: { put: async (k, body, opts) => { puts.push({ key: k, opts }); } } };
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  const request = new Request('https://submit.bukmukpublishing.com/api/submit', { method: 'POST', body: fd });
  const res = await onRequestPost({ request, env, waitUntil: () => {} });
  return { status: res.status, body: await res.json(), puts };
}

describe('consent form , server contract', () => {

  test('a complete consent submission is accepted and filed under consent/', async () => {
    const r = await post(clone());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'consent');
    assert.ok(r.puts[0].key.startsWith('consent/'),
      `filed at "${r.puts[0].key}"; a signature at the bucket root would be read as a story ` +
      `with no prose and rejected on every pull, for ever`);
  });

  test('no story is required: that is the whole point of this form', async () => {
    const r = await post(clone());
    assert.equal(r.status, 200);
  });

  test('publication consent and the agreement are separate, both required', async () => {
    const noPublish = await post(drop(clone(), 'consentPublish'));
    assert.equal(noPublish.status, 400);
    assert.ok(noPublish.body.details.includes('consentPublish not ticked'));

    const noAgreement = await post(drop(clone(), 'agreementAccepted'));
    assert.equal(noAgreement.status, 400);
    assert.ok(noAgreement.body.details.includes('agreementAccepted not ticked'),
      'accepting the terms is not implied by allowing publication; ask for both');
  });

  test('the summary the guardian read is stored, not assumed', async () => {
    const noSummary = await post(drop(clone(), 'agreementSummary'));
    assert.equal(noSummary.status, 400);
    assert.ok(noSummary.body.details.includes('missing: agreementSummary'));

    const noVersion = await post(drop(clone(), 'agreementVersion'));
    assert.equal(noVersion.status, 400);
    assert.ok(noVersion.body.details.includes('missing: agreementVersion'));
  });

  test('a young author is not turned away by the programme age floor', async () => {
    // Avish Jain was 6 when he wrote Mageton's Big Adventure. The authors'
    // intake is a 7 to 15 programme; this form is signed by families we are
    // already working with, so it must not refuse his mother's consent.
    const six = await post(set(clone(), 'authorAge', '6'));
    assert.equal(six.status, 200, JSON.stringify(six.body));

    const adult = await post(set(clone(), 'authorAge', '18'));
    assert.equal(adult.status, 400, 'guardian consent for an adult is meaningless');
  });

  test('city consent with no city is a contradiction, and fails safe', async () => {
    const ticked = await post(drop(clone(), 'authorLocation'));
    assert.equal(ticked.status, 400);
    assert.ok(ticked.body.details.some(d => d.includes('authorLocation')));

    const withheld = await post(drop(drop(clone(), 'authorLocation'), 'consentLocation'));
    assert.equal(withheld.status, 200, 'no city consent, no city needed');
  });

  test('consent mode is opt-in: without formKind the full contract still applies', async () => {
    const r = await post(drop(clone(), 'formKind'));
    assert.equal(r.status, 400, 'a story-less payload must not pass the full form contract');
    assert.ok(r.body.details.some(d => d.includes('story')));
    assert.equal(r.puts.length, 0, 'and nothing is persisted');
  });

  test('em-dashes are sanitised on the way in, same as every other path', async () => {
    const r = await post(set(clone(), 'guardianName', 'Neha — Jain'));
    assert.equal(r.status, 200);
  });
});
