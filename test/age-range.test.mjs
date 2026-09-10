/**
 * Authors' age range, 6 to 17 , contract test.
 *
 *   node --test test/age-range.test.mjs
 *
 * The range lives in four places that must agree: the age chips in
 * index.html, the browser check and the Q&A bracket switch in intake.js, and
 * the server gate in functions/api/submit.js. It was 7 to 15 until 2026-09-10.
 *
 * What it is defending:
 *   , the server accepts 6 and 17 on the FULL form and refuses 5 and 18
 *   , every age the form offers lands in a Q&A bracket. ageGroup() returning
 *     null does not raise an error: it hides every question set, so a child
 *     outside the old range would have submitted with no answers at all
 *   , every bracket ageGroup() returns has a question set to show
 *   , the chips offered are exactly the range the server accepts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestPost } from '../functions/api/submit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIN = 6;
const MAX = 17;

// Mirror of intake.js LABELS for the fields the full form requires (same set as
// test/story-file.test.mjs).
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
  consentPublish:    "I allow Bukmuk to lightly edit (keeping the child's voice) and publish this story in a Bukmuk book that may be sold on public platforms including Amazon. I understand I can request withdrawal before publication.",
  guardianSignature: 'Type your full name as a signature',
  consentDate:       'Date',
  book:              'book',
};

const STORY_30_WORDS =
  'The door in the forest was open, which it had never been before, and she ' +
  'stood there for a long moment counting her own breaths before she finally ' +
  'decided that she was going to walk through it.';

function fixture(age){
  const v = {
    authorName: 'Test Author', authorAge: String(age), authorLocation: 'Testville',
    authorBio: 'A fixture bio for the test harness.',
    storyTitle: 'The Fixture Story', story: STORY_30_WORDS,
    inspiration: 'A fixture value for the test harness.',
    creditAs: 'My full name', childAssent: 'Yes',
    guardianName: 'Test Guardian', guardianRelation: 'Mother',
    guardianEmail: 'parent@example.in', guardianPhone: '+91 9812345678',
    guardianSignature: 'Test Guardian', consentDate: '2026-09-10',
    consentPublish: L.consentPublish,
    book: 'fixture-book',
  };
  return { data: { fields: Object.entries(v).map(([k, value]) => ({ label: L[k], key: k, value })) } };
}

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

// ageGroup() is private to intake.js's IIFE. Lift the function's own source out
// of the file rather than mirroring it, so this tests the code that ships.
const ageGroup = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'intake.js'), 'utf8');
  const m = src.match(/function ageGroup\(age\)\{[\s\S]*?\n  \}/);
  assert.ok(m, 'could not find ageGroup() in intake.js; update this extractor if it moved');
  return new Function(`${m[0]}; return ageGroup;`)();
})();

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('authors age range 6 to 17', () => {

  test('the full form accepts the youngest and oldest ages in range', async () => {
    for (const age of [MIN, MAX]){
      const r = await post(fixture(age));
      assert.equal(r.status, 200, `age ${age} refused: ${JSON.stringify(r.body)}`);
    }
  });

  test('the full form refuses one either side of the range, and stores nothing', async () => {
    for (const age of [MIN - 1, MAX + 1]){
      const r = await post(fixture(age));
      assert.equal(r.status, 400, `age ${age} should be refused`);
      assert.ok(r.body.details.some(d => d.includes(`authorAge must be ${MIN}-${MAX}`)), JSON.stringify(r.body.details));
      assert.equal(r.puts.length, 0);
    }
  });

  test('every age in range gets a Q&A bracket, none outside it', () => {
    for (let age = MIN; age <= MAX; age++){
      assert.ok(ageGroup(age), `age ${age} has no bracket, so every question set would stay hidden`);
    }
    assert.equal(ageGroup(MIN - 1), null);
    assert.equal(ageGroup(MAX + 1), null);
    assert.equal(ageGroup(6), 'early');
    assert.equal(ageGroup(9), 'early');
    assert.equal(ageGroup(10), 'mid');
    assert.equal(ageGroup(12), 'mid');
    assert.equal(ageGroup(13), 'upper');
    assert.equal(ageGroup(17), 'upper');
  });

  test('every bracket ageGroup returns has a question set in index.html', () => {
    const sets = new Set([...HTML.matchAll(/class="qa-set" data-bracket="([a-z]+)"/g)].map(m => m[1]));
    for (let age = MIN; age <= MAX; age++){
      assert.ok(sets.has(ageGroup(age)), `bracket "${ageGroup(age)}" (age ${age}) has no qa-set to show`);
    }
  });

  test('the age chips offered are exactly the range the server accepts', () => {
    const chips = [...HTML.matchAll(/name="authorAge" value="(\d+)"/g)].map(m => Number(m[1]));
    const want = Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i);
    assert.deepEqual(chips, want);
  });
});
