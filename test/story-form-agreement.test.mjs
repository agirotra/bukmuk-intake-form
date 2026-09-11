/**
 * The Young Author Agreement on the STORY form , contract test.
 *
 *   node --test test/story-form-agreement.test.mjs
 *
 * Until 2026-09-11 only consent.html asked for the agreement, so a family who
 * filled the story form had signed half of what we need and would have been
 * sent a second form for the rest. The editor's rule since then is that one
 * signed form is enough, so the story form now carries both halves.
 *
 * What it is defending:
 *   , a story submission with the agreement ticked is accepted, and is filed at
 *     the bucket root as a story, never under consent/
 *   , a page that showed the agreement cannot send it unticked, or send the
 *     tick without the terms the guardian read
 *   , a story page opened BEFORE the change, which never showed the agreement,
 *     still submits. Refusing it would lose a family's whole story over a
 *     question they were never asked
 *   , the page asks it inside the guardian's form, loads the clause module
 *     before intake.js, and intake.js validates and sends every agreement field
 *   , the terms box styles live in the shared stylesheet, once
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestPost } from '../functions/api/submit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The clause module, loaded the way the browser loads it, so the label and the
// summary in this test ARE the ones the page ships.
const CLAUSES = (() => {
  const g = {};
  new Function('window', read('consent-clauses.js')
    .replace("typeof window !== 'undefined' ? window : this", 'arguments[0]'))(g);
  return g.BUKMUK_CONSENT;
})();

// Mirror of intake.js LABELS for the fields the full form requires (same set
// as test/age-range.test.mjs), plus the four agreement keys.
const L = {
  authorName:        'Your name',
  authorAge:         'How old are you?',
  authorLocation:    'Which city or town do you live in?',
  authorBio:         "Tell us about you in a few lines, the way you'd tell a friend",
  storyTitle:        "Your story's title",
  story:             'Paste or type your whole story here. Write it exactly how you want it, we keep your voice.',
  inspiration:       'What gave you the idea for this story?',
  creditAs:          'How should we name you?',
  childAssent:       'Do you want your story in the book?',
  guardianName:      'Parent/guardian full name',
  guardianRelation:  'Your relationship',
  guardianEmail:     "A grown-up's email (so we can reach your parent/guardian)",
  guardianPhone:     'Phone',
  consentPublish:    CLAUSES.LABELS.consentPublish,
  guardianSignature: 'Type your full name as a signature',
  consentDate:       'Date',
  book:              'book',
  agreementAccepted: CLAUSES.LABELS.agreementAccepted,
  agreementVersion:  'Agreement version',
  agreementSummary:  'Agreement summary as shown',
  agreementUrl:      'Full agreement URL',
};

const STORY_30_WORDS =
  'The door in the forest was open, which it had never been before, and she ' +
  'stood there for a long moment counting her own breaths before she finally ' +
  'decided that she was going to walk through it.';

function fixture(){
  const v = {
    authorName: 'Test Author', authorAge: '9', authorLocation: 'Testville',
    authorBio: 'A fixture bio for the test harness.',
    storyTitle: 'The Fixture Story', story: STORY_30_WORDS,
    inspiration: 'A fixture value for the test harness.',
    creditAs: 'My full name', childAssent: 'Yes',
    guardianName: 'Test Guardian', guardianRelation: 'Mother',
    guardianEmail: 'parent@example.in', guardianPhone: '+91 9812345678',
    guardianSignature: 'Test Guardian', consentDate: '2026-09-11',
    consentPublish: L.consentPublish,
    book: 'fixture-book',
    agreementAccepted: L.agreementAccepted,
    agreementVersion: CLAUSES.AGREEMENT_VERSION,
    agreementSummary: CLAUSES.summaryText(),
    agreementUrl: CLAUSES.AGREEMENT_URL,
  };
  return { data: { fields: Object.entries(v).map(([k, value]) => ({ label: L[k], key: k, value })) } };
}

const drop = (p, ...keys) => { p.data.fields = p.data.fields.filter(f => !keys.includes(f.key)); return p; };

async function post(payload){
  const puts = [];
  const env = {
    INTAKE_SUBMISSIONS: { put: async (k) => { puts.push(k); } },
    INTAKE_FILES:       { put: async () => {} },
  };
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  const request = new Request('https://submit.bukmukpublishing.com/api/submit', { method: 'POST', body: fd });
  const res = await onRequestPost({ request, env, waitUntil: () => {} });
  return { status: res.status, body: await res.json(), puts };
}

describe('the agreement on the story form , server contract', () => {
  test('a story with the agreement ticked is accepted and filed as a story', async () => {
    const r = await post(fixture());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.puts.length, 1);
    assert.ok(!r.puts[0].startsWith('consent/'),
      'a story that carries the agreement is still a story; consent/ is for signatures with no story');
  });

  test('a page that showed the agreement cannot send it unticked', async () => {
    const r = await post(drop(fixture(), 'agreementAccepted'));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.includes('agreementAccepted not ticked'));
    assert.equal(r.puts.length, 0, 'and nothing is persisted');
  });

  test('a tick with no record of the terms read is refused', async () => {
    const r = await post(drop(fixture(), 'agreementSummary'));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.includes('missing: agreementSummary'),
      'a tick with no record of what was on screen is not evidence of what was accepted');
  });

  test('a page opened before the agreement was added still submits', async () => {
    const r = await post(drop(fixture(), 'agreementAccepted', 'agreementVersion', 'agreementSummary', 'agreementUrl'));
    assert.equal(r.status, 200, 'a family must not lose a whole story over a question their page never asked');
    assert.equal(r.puts.length, 1);
  });
});

describe('the agreement on the story form , the page', () => {
  const html = read('index.html');
  const guardian = html.slice(html.indexOf('id="guardianForm"'), html.indexOf('</form>', html.indexOf('id="guardianForm"')));

  test('the tick, the terms and the link are inside the guardian form', () => {
    assert.match(guardian, /name="agreementAccepted"[^>]*required/);
    assert.match(guardian, /data-clause-list/, 'the plain-English terms are shown, not only linked');
    assert.match(guardian, /data-agreement-link/);
  });

  test('the clause module loads before intake.js', () => {
    const clauses = html.indexOf('src="/consent-clauses.js');
    const intake = html.indexOf('src="/intake.js');
    assert.ok(clauses > -1 && intake > clauses,
      'intake.js reads the agreement label and summary from consent-clauses.js at load');
  });

  test('intake.js validates the tick and sends every agreement field', () => {
    const js = read('intake.js');
    assert.match(js, /for \(const name of \[[^\]]*'agreementAccepted'/, 'the tick is required in validate()');
    for (const k of ['agreementVersion', 'agreementSummary', 'agreementUrl']){
      assert.match(js, new RegExp(`add\\('${k}'`), `buildPayload sends ${k}`);
    }
    assert.match(js, /summaryText\(\)/, 'the summary sent is the text the page rendered');
  });

  test('the terms box is styled once, in the shared stylesheet', () => {
    assert.match(read('styles.css'), /\.terms\s*\{/);
    assert.doesNotMatch(read('consent.html'), /\.terms\s*\{/,
      'a second copy of the component on one page is how the two pages drift');
  });
});
