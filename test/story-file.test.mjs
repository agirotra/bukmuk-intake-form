/**
 * "Upload your story as a file" , server contract test.
 *
 *   node --test test/story-file.test.mjs
 *
 * The intake form used to accept the manuscript only as pasted text. A
 * <textarea> flattens italics, bold, tables, and the blank-line runs the
 * editor's ingest.js reads as [SPREAD] markers, and it is where a manuscript
 * silently arrives truncated: one family pasted a 200-word extract over a
 * 2,056-word book. Families can now attach the document instead.
 *
 * This drives the REAL Cloudflare Function, because the parts that can only
 * fail here are the parts nothing else covers: the type gate, the R2 object,
 * and the r2:// reference the editor's importer reads.
 *
 * What it is defending:
 *   , a submission with NO pasted text but an attached document is accepted.
 *     Requiring the textarea bounced every upload as "missing: story"
 *   , the gate matches on the EXTENSION, not the MIME type alone. Windows
 *     sends application/octet-stream for a .docx, and refusing that would
 *     refuse real manuscripts
 *   , a format nothing downstream can parse is refused WITH the fix named. A
 *     refusal a parent cannot act on is a story we never receive
 *   , the stored reference carries the extension. The editor lands the file at
 *     input/<slug>.<ext>, and that extension is what picks the parser
 *   , neither carrier is still a hard failure. "Either" must not become
 *     "optional"
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/submit.js';

// Mirror of intake.js LABELS for the fields the full form requires. These must
// stay equal to FIELD_LABELS in the Function; the editor repo's
// test/intake-form.test.js pins the same strings on the importer's side.
const L = {
  authorName:        'Your name',
  authorAge:         'How old are you?',
  authorLocation:    'Which city or town do you live in?',
  authorBio:         "Tell us about you in a few lines, the way you'd tell a friend",
  storyTitle:        "Your story's title",
  story:             'Paste or type your whole story here. Write it exactly how you want it, we keep your voice.',
  storyFile:         'Or upload your story as a file',
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

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function fixture(){
  const v = {
    authorName: 'Test Author', authorAge: '9', authorLocation: 'Testville',
    authorBio: 'A fixture bio for the test harness.',
    storyTitle: 'The Fixture Story', story: STORY_30_WORDS,
    inspiration: 'A fixture value for the test harness.',
    creditAs: 'My full name', childAssent: 'Yes',
    guardianName: 'Test Guardian', guardianRelation: 'Mother',
    guardianEmail: 'parent@example.in', guardianPhone: '+91 9812345678',
    guardianSignature: 'Test Guardian', consentDate: '2026-09-01',
    consentPublish: L.consentPublish,
    book: 'fixture-book',
  };
  return { data: { fields: Object.entries(v).map(([k, value]) => ({ label: L[k], key: k, value })) } };
}

const clone = () => JSON.parse(JSON.stringify(fixture()));
const drop  = (p, key) => { p.data.fields = p.data.fields.filter(f => f.key !== key); return p; };
const set   = (p, key, value) => { const f = p.data.fields.find(x => x.key === key); if (f) f.value = value; return p; };

// `file` is { name, type, bytes } or null. The Function only gates the file, it
// never parses it, so the bytes are a stand-in; the editor repo covers a real
// .docx end to end through mammoth.
async function post(payload, file){
  const puts = [];
  const filePuts = [];
  const env = {
    INTAKE_SUBMISSIONS: { put: async (k, body, opts) => { puts.push({ key: k, body, opts }); } },
    INTAKE_FILES:       { put: async (k, body, opts) => { filePuts.push({ key: k, opts }); } },
  };
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  if (file){
    fd.append('storyFile', new Blob([file.bytes ?? 'document bytes'], { type: file.type }), file.name);
  }
  const request = new Request('https://submit.bukmukpublishing.com/api/submit', { method: 'POST', body: fd });
  const res = await onRequestPost({ request, env, waitUntil: () => {} });
  return { status: res.status, body: await res.json(), puts, filePuts };
}

// The stored payload is what the editor's importer reads. Pull the field back
// out of the JSON that was actually handed to R2, not out of our own fixture.
function storedField(r, key){
  const body = JSON.parse(r.puts[0].body);
  return body.data.fields.find(f => f.key === key);
}

describe('story as an uploaded document , server contract', () => {

  test('an upload with NO pasted text is accepted', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'Fixture Story.docx', type: DOCX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'submission');
    assert.ok(!r.puts[0].key.startsWith('consent/'), 'a story must file at the bucket root');
  });

  test('the document is stored under its real extension', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'Fixture Story.docx', type: DOCX });
    assert.equal(r.filePuts.length, 1, 'the manuscript was not written to the files bucket');
    assert.match(r.filePuts[0].key, /\/story\.docx$/,
      `stored at "${r.filePuts[0].key}"; the editor lands this at input/<slug>.<ext> and the ` +
      `extension is what chooses the parser, so an extension-less object is unreadable`);
  });

  test('the stored payload carries the reference the importer looks for', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'Fixture Story.docx', type: DOCX });
    const ref = storedField(r, 'storyFile');
    assert.ok(ref, 'no storyFile field in the stored payload; the manuscript would be unreachable');
    assert.equal(ref.label, L.storyFile, 'the label is how the importer matches the field');
    assert.match(ref.value.url, /^r2:\/\/.+\/story\.docx$/, JSON.stringify(ref.value));
    assert.equal(ref.value.name, 'Fixture Story.docx', 'the family\'s own filename is kept');
  });

  // The gate matches on the extension first for exactly this reason.
  test('a .docx sent as application/octet-stream is accepted (Windows)', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'From Windows.docx', type: 'application/octet-stream' });
    assert.equal(r.status, 200, `a MIME-only gate would refuse a real manuscript here: ${JSON.stringify(r.body)}`);
    assert.match(r.filePuts[0].key, /\/story\.docx$/);
  });

  test('a file with no extension is placed by its content type', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'manuscript', type: DOCX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.filePuts[0].key, /\/story\.docx$/);
  });

  test('every format ingest.js can parse is accepted', async () => {
    for (const [name, type] of [['a.docx', DOCX], ['a.pdf', 'application/pdf'], ['a.txt', 'text/plain'], ['a.md', '']]){
      const r = await post(drop(clone(), 'story'), { name, type });
      assert.equal(r.status, 200, `${name} was refused: ${JSON.stringify(r.body)}`);
    }
  });

  // A bounce a parent cannot act on is a story we never receive.
  test('the near-miss formats are refused, each naming the fix', async () => {
    for (const [name, type] of [
      ['Manuscript.doc',   'application/msword'],
      ['Manuscript.pages', ''],
      ['Manuscript.odt',   'application/vnd.oasis.opendocument.text'],
      ['Manuscript.rtf',   'application/rtf'],
    ]){
      const r = await post(drop(clone(), 'story'), { name, type });
      assert.equal(r.status, 400, `${name} should be refused`);
      assert.match(r.body.error, /\.docx/, `${name} refusal must say how to make a .docx: ${r.body.error}`);
    }
  });

  test('an image is refused as a story', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'scan.jpg', type: 'image/jpeg' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /\.docx|\.pdf/);
  });

  test('nothing is written to R2 when the file is refused', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'Manuscript.doc', type: 'application/msword' });
    assert.equal(r.filePuts.length, 0, 'a refused file must not reach the bucket');
    assert.equal(r.puts.length, 0, 'a refused submission must not be stored');
  });

  // "Either" must not quietly become "optional".
  test('neither pasted text nor a file is still a hard failure', async () => {
    const r = await post(drop(clone(), 'story'), null);
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.includes('missing: story')), JSON.stringify(r.body.details));
  });

  test('pasting still works, unchanged', async () => {
    const r = await post(clone(), null);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.filePuts.length, 0);
  });

  // The 30-word floor catches an empty textarea. It says nothing about a
  // document nobody has parsed, so an upload is exempt from it.
  test('a short covering note beside an attached document is fine', async () => {
    const r = await post(set(clone(), 'story', 'My story is attached.'), { name: 'a.docx', type: DOCX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('a short pasted story with NO document is still refused', async () => {
    const r = await post(set(clone(), 'story', 'Too short.'), null);
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => /short/.test(d)), JSON.stringify(r.body.details));
  });

  // The word ceiling cannot be applied to a document the worker never parses,
  // so the size cap is the only ceiling on an upload. It has to hold.
  test('an oversized document is refused', async () => {
    const big = new Uint8Array(15 * 1024 * 1024 + 1);
    const r = await post(drop(clone(), 'story'), { name: 'huge.docx', type: DOCX, bytes: big });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /15 MB/);
  });

  test('an empty file is not mistaken for an attached story', async () => {
    const r = await post(drop(clone(), 'story'), { name: 'empty.docx', type: DOCX, bytes: new Uint8Array(0) });
    assert.equal(r.status, 400, 'a zero-byte pick must not satisfy the story requirement');
    assert.ok(r.body.details.some(d => d.includes('missing: story')), JSON.stringify(r.body.details));
  });
});
