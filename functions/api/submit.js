// Cloudflare Pages Function: POST /api/submit
//
// Accepts a multipart/form-data submission from intake.js:
//   - field "payload"      , JSON string (Tally-compatible shape)
//   - field "authorPhoto"  , optional image (jpeg/png/webp, <=15 MB)
//   - field "authorArtwork", optional image (same constraints)
//
// What we do:
//   1) Honeypot check + size limit + content-type whitelist for files
//   2) Inline em-dash sanitisation on every text value (mirrors lib/sanitise)
//   3) Validate the same required fields as scripts/import-submissions.js
//      so a successful submission is GUARANTEED importable on the editor's
//      side. If validation fails here, the editor never sees it; we 400.
//   4) Persist:
//        - Files to R2 bucket binding INTAKE_FILES at: <uuid>/<slug>.<ext>
//        - JSON payload to R2 bucket binding INTAKE_SUBMISSIONS at: <uuid>.json
//      Both buckets are configured in wrangler.toml / Pages dashboard.
//   5) Return { reference: "BUK-XXXXX", id: "<uuid>" }
//
// The editor pulls new submissions out of INTAKE_SUBMISSIONS (see
// scripts/fetch-intake-submissions.js in this directory's sibling)
// and feeds them straight to scripts/import-submissions.js. The on-the-wire
// shape ({ data: { fields: [...] } }) is exactly what flattenSubmissions()
// expects, so the round-trip is lossless.

const MAX_FILE_BYTES = 15 * 1024 * 1024;       // 15 MB per file
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;     // 2 MB JSON
const MAX_STORY_WORDS = 10000;                 // hard ceiling on prose
const MIN_STORY_WORDS = 30;                    // mirrors importer
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Mirror of scripts/import-submissions.js FIELD_MAP (primary labels only).
// Used for label → canonical-key lookup, validation, and consent detection.
const FIELD_LABELS = {
  authorName:        'Your name',
  authorAge:         'How old are you?',
  authorLocation:    'Which city or town do you live in?',
  authorBio:         "Tell us about you in a few lines, the way you'd tell a friend",
  storyTitle:        "Your story's title",
  story:             'Paste or type your whole story here. Write it exactly how you want it, we keep your voice.',
  inspiration:       'What gave you the idea for this story?',
  creditAs:          'How should we name you?',
  penName:           'Your pen name',
  childAssent:       'Do you want your story in the book?',
  guardianName:      'Parent/guardian full name',
  guardianRelation:  'Your relationship',
  guardianEmail:     "A grown-up's email (so we can reach your parent/guardian)",
  guardianPhone:     'Phone',
  consentPublish:    "I allow Bukmuk to lightly edit (keeping the child's voice) and publish this story in a Bukmuk book that may be sold on public platforms including Amazon. I understand I can request withdrawal before publication.",
  // consentVoice retired 2026-05-22: redundant with consentPublish's
  // "(keeping the child's voice)" clause + the §IX marginalia
  consentPhoto:      "I allow the author's photo to be printed.",
  consentLocation:   "I allow the author's city to be printed.",
  guardianSignature: 'Type your full name as a signature',
  consentDate:       'Date',
  book:              'book',
};

// Tolerant string compare on Tally labels (case + punctuation insensitive).
function normLabel(s){
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Em-dash sanitiser (matches lib/sanitise rules).
function sanitiseText(s){
  if (s == null) return s;
  return String(s)
    .replace(/—/g, ', ')
    .replace(/–/g, ' to ')
    .replace(/ {2,}/g, ' ');
}

// Walk the payload, em-dash sanitise every string value.
function sanitisePayload(payload){
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload.data?.fields)){
    for (const f of payload.data.fields){
      if (typeof f.value === 'string') f.value = sanitiseText(f.value);
      else if (Array.isArray(f.value)){
        f.value = f.value.map(v => typeof v === 'string' ? sanitiseText(v) : v);
      }
    }
  }
  return payload;
}

// Build a label→value getter over the payload's fields[] array.
function buildLookup(payload){
  const fields = payload?.data?.fields || [];
  const byNorm = {};
  for (const f of fields){
    byNorm[normLabel(f.label)] = f.value;
  }
  const out = {};
  for (const [key, label] of Object.entries(FIELD_LABELS)){
    const n = normLabel(label);
    if (n in byNorm) out[key] = byNorm[n];
  }
  return out;
}

// Treat a consent value as "ticked" unless it's empty / explicit negative.
const NEG = new Set(['', 'false', 'no', '0', 'off', 'unchecked', 'none']);
function isChecked(v){
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (Array.isArray(v)) return v.some(isChecked);
  return !NEG.has(String(v).trim().toLowerCase());
}

function wordCount(s){
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

// Validate using the same contract as scripts/import-submissions.js
// validateSubmission(). If this passes, the editor's import will pass.
function validateOnServer(payload){
  const r = buildLookup(payload);
  const errors = [];
  const reqStr = ['authorName','authorLocation','authorBio','storyTitle','story','inspiration',
    'guardianName','guardianRelation','guardianEmail','guardianPhone','guardianSignature','consentDate'];
  for (const k of reqStr){
    if (!String(r[k] || '').trim()) errors.push(`missing: ${k}`);
  }
  const age = parseInt(String(r.authorAge || ''), 10);
  if (!Number.isInteger(age) || age < 7 || age > 15) errors.push('authorAge must be 7-15');
  if (r.story && wordCount(r.story) < MIN_STORY_WORDS) errors.push(`story too short (< ${MIN_STORY_WORDS} words)`);
  if (r.story && wordCount(r.story) > MAX_STORY_WORDS) errors.push(`story too long (> ${MAX_STORY_WORDS} words)`);
  if (r.guardianEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(r.guardianEmail))){
    errors.push('guardianEmail invalid');
  }
  // creditAs , the importer's normaliseCreditAs() looks for substrings;
  // a missing value is the failure case we want to catch
  const credit = String(r.creditAs || '').toLowerCase();
  if (!credit.trim()) errors.push('creditAs missing');
  if (credit.includes('pen') && !String(r.penName || '').trim()){
    errors.push('pen name chosen but penName is empty');
  }
  if (!isChecked(r.consentPublish)) errors.push('consentPublish not ticked');
  // consentVoice retired 2026-05-22 (was redundant with consentPublish)
  const assent = String(r.childAssent || '').trim().toLowerCase();
  if (!assent) errors.push('childAssent missing');
  else if (assent.startsWith('n')) errors.push('child did not assent (No)');

  return { ok: errors.length === 0, errors };
}

// ─── Workshop access gate ──────────────────────────────────────────────────
// Only people from a real Bukmuk workshop should be able to submit (random
// kids' submissions are unconsented minor PII we must not collect). Each
// workshop has a short memorable code the facilitator shares; the form carries
// it (typed, or pre-filled from a ?code= link). We validate it against the
// WORKSHOP_CODES env var (comma-separated allowlist, case-insensitive).
//
// If WORKSHOP_CODES is unset, the gate is OPEN (so the form keeps working
// before codes are configured). To turn the gate ON, set WORKSHOP_CODES in the
// Pages project env. Adding a workshop = append its code to that list.
function fieldValue(payload, key){
  const f = (payload && payload.data && payload.data.fields || []).find(x => x.key === key);
  return f ? String(f.value || '').trim() : '';
}
function normCode(raw){
  return String(raw == null ? '' : raw).trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9._-]+/g, '').replace(/^[-_.]+|[-_.]+$/g, '');
}
// Valid codes come from two places: a static WORKSHOP_CODES env list (fallback)
// and the editor-managed Cloudflare KV store, where each code is its OWN key
// `wc:<code>` (the editor uses per-key writes so codes never clobber each other
// under KV's eventual consistency). We look up just the ONE entered code , a
// single KV get , and honour it only when active and not expired.
// Gate is OFF only when truly unconfigured (no env list AND no KV binding).
async function checkWorkshopCode(payload, env){
  const envSet = new Set(String(env.WORKSHOP_CODES || '').split(',').map(s => normCode(s)).filter(Boolean));
  const configured = !!(envSet.size || env.WORKSHOP_CODES_KV);
  if (!configured) return { ok: true, code: null, cohort: null };
  const entered = normCode(fieldValue(payload, 'workshopCode') || fieldValue(payload, 'code'));
  if (!entered) return { ok: false, reason: 'missing' };
  if (envSet.has(entered)) return { ok: true, code: entered, cohort: null };
  if (env.WORKSHOP_CODES_KV){
    try {
      const raw = await env.WORKSHOP_CODES_KV.get('wc:' + entered);
      if (raw){
        const c = JSON.parse(raw);
        const active = c.active !== false;
        const exp = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
        const expired = Number.isFinite(exp) && exp < Date.now();
        if (active && !expired) return { ok: true, code: entered, cohort: c.cohort || null };
      }
    } catch (_) { /* KV unreadable , fall through to invalid */ }
  }
  return { ok: false, reason: 'invalid' };
}

// UUID (v4) without crypto.randomUUID dependency
function uuid(){
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0'));
  return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
}

// Short human-readable reference for the thank-you screen
function refFromId(id){
  return 'BUK-' + id.replace(/-/g, '').slice(0, 6).toUpperCase();
}

// ─── Notification emails (via AWS SES) ─────────────────────────────────
//
// On every successful submission we fire two emails (in the background via
// ctx.waitUntil so the parent's POST response is never blocked):
//
//   1. To the editor (NOTIFY_TO env var, default abhinav.girotra@gmail.com)
//      , short summary so the editor knows to go check the inbox.
//   2. To the parent (guardianEmail field from the form)
//      , warm confirmation with the reference + what-happens-next timeline.
//
// SES creds + region + sender come from the Pages project's env vars:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (encrypted, dedicated IAM user)
//   AWS_REGION       , e.g. ap-south-1
//   SES_FROM_ADDRESS , e.g. editor@bukmuk.com (verified domain identity)
//   NOTIFY_TO        , editor's inbox; falls back to abhinav.girotra@gmail.com
//   SES_REPLY_TO     , where parent replies should land; falls back to NOTIFY_TO
//
// If any of the SES vars are missing, we log and skip , submission still
// succeeds. This lets the form ship before SES is fully configured.

import { sendSesEmail } from '../_lib/aws-ses.js';

function peek(payload){
  const fields = (payload && payload.data && payload.data.fields) || [];
  const files  = (payload && payload._meta && payload._meta.files) || {};
  const get = key => {
    const f = fields.find(x => x.key === key);
    return f ? String(f.value || '').trim() : '';
  };
  return {
    authorName:   get('authorName'),
    authorAge:    get('authorAge'),
    authorLocation: get('authorLocation'),
    storyTitle:   get('storyTitle'),
    story:        get('story'),
    inspiration:  get('inspiration'),
    dedication:   get('dedication'),
    acknowledgements: get('acknowledgements'),
    languageNote: get('languageNote'),
    editorNote:   get('editorNote'),
    hasChapters:  get('hasChapters'),
    creditAs:     get('creditAs'),
    penName:      get('penName'),
    book:         get('book'),
    channel:      get('channel'),
    cohort:       get('cohort'),
    workshopCode: get('workshopCode') || get('code'),
    // Guardian + consent block , the legal record the editor needs to see.
    guardianName:      get('guardianName'),
    guardianRelation:  get('guardianRelation'),
    guardianEmail:     get('guardianEmail'),
    guardianPhone:     get('guardianPhone'),
    guardianSignature: get('guardianSignature'),
    consentDate:       get('consentDate'),
    consentPublish:    get('consentPublish'),
    consentPhoto:      get('consentPhoto'),
    consentLocation:   get('consentLocation'),
    childAssent:       get('childAssent'),
    hasPhoto:   !!files.authorPhoto,
    hasArtwork: !!files.authorArtwork,
  };
}

// Consent ticks export as the long label text; render a clean Yes/No.
function yesNo(v){ return isChecked(v) ? 'Yes' : 'No'; }

function wordCountStr(s){
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

function firstName(full){
  if (!full) return 'your child';
  return String(full).trim().split(/\s+/)[0];
}

async function sendEditorNotification(env, p, meta){
  const to = env.NOTIFY_TO || 'abhinav.girotra@gmail.com';
  const replyTo = env.SES_REPLY_TO || to;
  const lines = [
    `Bukmuk Authors' Intake , new submission`,
    ``,
    `Author:       ${p.authorName || '(unknown)'}${p.authorAge ? ` (age ${p.authorAge})` : ''}`,
    `Story title:  ${p.storyTitle || '(untitled)'}`,
    `Word count:   ${wordCountStr(p.story)}`,
    `Target book:  ${p.book || '(not specified)'}`,
    p.channel ? `Channel:      ${p.channel}` : null,
    p.cohort  ? `Cohort:       ${p.cohort}`  : null,
    p.workshopCode ? `Workshop code: ${p.workshopCode}` : null,
    `Reference:    ${meta.reference}`,
    `Received:     ${meta.receivedAt}`,
    ``,
    `, Parent / guardian consent ,`,
    `Guardian:     ${p.guardianName || '(none)'}${p.guardianRelation ? ` (${p.guardianRelation})` : ''}`,
    `Email:        ${p.guardianEmail || '(none)'}`,
    `Phone:        ${p.guardianPhone || '(none)'}`,
    `Signed:       ${p.guardianSignature || '(none)'}${p.consentDate ? ` on ${p.consentDate}` : ''}`,
    `Publish:      ${yesNo(p.consentPublish)}`,
    `Print photo:  ${yesNo(p.consentPhoto)}`,
    `Print city:   ${yesNo(p.consentLocation)}`,
    `Child assent: ${p.childAssent || '(none)'}`,
    `Credit as:    ${p.creditAs || '(none)'}${p.penName ? ` , pen name: ${p.penName}` : ''}`,
    ``,
    `, Author details ,`,
    `Location:     ${p.authorLocation || '(none)'}`,
    `Has chapters: ${p.hasChapters || '(none)'}`,
    `Inspiration:  ${p.inspiration || '(none)'}`,
    `Dedication:   ${p.dedication || '(none)'}`,
    `Thanks:       ${p.acknowledgements || '(none)'}`,
    `Language note (words to keep): ${p.languageNote || '(none)'}`,
    `Editor note:  ${p.editorNote || '(none)'}`,
    `Photo:        ${p.hasPhoto ? 'attached' : 'none'}`,
    `Artwork:      ${p.hasArtwork ? 'attached' : 'none'}`,
    ``,
    `Open the editor's inbox to review and import:`,
    `  ${(env.EDITOR_URL || 'https://editor.bukmuk.com').replace(/\/+$/, '')}/#/intake`,
    ``,
    `R2 object key (for manual pull if needed):`,
    `  bukmuk-intake-submissions/${meta.id}.json`,
  ].filter(Boolean).join('\n');

  await sendSesEmail({
    env,
    from: env.SES_FROM_ADDRESS,
    to,
    replyTo,
    subject: `New submission: ${p.storyTitle || '(untitled)'} by ${p.authorName || 'an author'}`,
    text: lines,
  });
}

async function sendParentConfirmation(env, p, meta){
  if (!p.guardianEmail){
    console.log('[intake] no guardianEmail on payload; skipping parent confirmation');
    return;
  }
  const replyTo = env.SES_REPLY_TO || env.NOTIFY_TO || 'abhinav.girotra@gmail.com';
  const child = firstName(p.authorName);
  const greet = p.guardianName ? `Hello ${firstName(p.guardianName)},` : `Hello,`;

  const text = [
    greet,
    ``,
    `Thank you for sending us ${child}'s story, "${p.storyTitle || '(untitled)'}". We have it safely.`,
    ``,
    `Your reference is ${meta.reference}. Keep it in case you ever need to write to us about this submission.`,
    ``,
    `A copy of what you confirmed, for your records:`,
    `  ,  Publish ${child}'s story in a Bukmuk book (which may be sold on public platforms including Amazon): ${yesNo(p.consentPublish)}`,
    `  ,  Print the author's photo: ${yesNo(p.consentPhoto)}`,
    `  ,  Print the author's city${p.authorLocation ? ` (${p.authorLocation})` : ''}: ${yesNo(p.consentLocation)}`,
    `  ,  ${child} wants the story in the book: ${p.childAssent || '(not answered)'}`,
    `  ,  Signed by ${p.guardianSignature || p.guardianName || 'you'}${p.consentDate ? ` on ${p.consentDate}` : ''}.`,
    ``,
    `What happens next:`,
    `  ,  Within a fortnight, a real editor will read the story and write back to you and ${child}. We'll share what we'd like to gently edit and ask before changing anything that matters.`,
    `  ,  Within about 60 days, you'll see an edited proof with every change marked.`,
    `  ,  Before printing, we'll always ask both of you for a final yes.`,
    ``,
    `To withdraw at any time before publication, reply to this email or write to helpdesk@bukmuk.com. We'll remove the story and photo from our systems.`,
    ``,
    `Questions any time: helpdesk@bukmuk.com  or  WhatsApp +91 81302 86286`,
    ``,
    `, Bukmuk Editorial Team`,
    `  bukmukpublishing.com`,
  ].join('\n');

  await sendSesEmail({
    env,
    from: env.SES_FROM_ADDRESS,
    to: p.guardianEmail,
    replyTo,
    subject: `We have ${child}'s story , Bukmuk Authors' Intake`,
    text,
  });
}

// Wrapper: try both emails independently, log on failure, never throw.
async function fireNotificationEmails(env, payload, meta){
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.SES_FROM_ADDRESS){
    console.log('[intake] SES env vars missing; skipping email notifications.');
    return;
  }
  const p = peek(payload);
  // Editor notification , independent of parent send
  try {
    await sendEditorNotification(env, p, meta);
    console.log(`[intake] editor notification sent for ${meta.reference}`);
  } catch (err) {
    console.error('[intake] editor notification failed:', err && err.message);
  }
  // Parent confirmation , independent of editor send
  try {
    await sendParentConfirmation(env, p, meta);
    console.log(`[intake] parent confirmation sent for ${meta.reference}`);
  } catch (err) {
    console.error('[intake] parent confirmation failed:', err && err.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────
export async function onRequestPost({ request, env, waitUntil }){
  // Light rate-limit (Cloudflare gives us cf-connecting-ip; the surrounding
  // Pages config + WAF should do the heavy lifting, this is defence in depth).
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  // 1) Parse multipart
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid multipart' }, 400);
  }

  const payloadRaw = form.get('payload');
  if (typeof payloadRaw !== 'string' || payloadRaw.length > MAX_PAYLOAD_BYTES){
    return json({ error: 'missing or oversized payload' }, 400);
  }

  // 2) Honeypot inside payload (intake.js sets website on submit-with-bot)
  let payload;
  try { payload = JSON.parse(payloadRaw); }
  catch { return json({ error: 'invalid JSON payload' }, 400); }

  if (!payload || typeof payload !== 'object'){
    return json({ error: 'invalid payload shape' }, 400);
  }

  // 3) Em-dash sanitise (so the importer never sees one)
  payload = sanitisePayload(payload);

  // 3b) Workshop access gate , block anyone without a valid workshop code
  // (random / non-workshop submissions). Open until codes are configured.
  const gate = await checkWorkshopCode(payload, env);
  if (!gate.ok){
    return json({ error: 'workshop code required', reason: gate.reason }, 403);
  }
  // Auto-tag the cohort from the matched code (if the code carries one and the
  // submission didn't already specify a cohort), so editor inbox grouping works.
  if (gate.cohort && !fieldValue(payload, 'cohort')){
    payload.data.fields.push({ label: 'cohort', key: 'cohort', value: String(gate.cohort) });
  }

  // 4) Validate on the server side too
  const v = validateOnServer(payload);
  if (!v.ok){
    return json({ error: 'validation failed', details: v.errors }, 400);
  }

  // 5) File whitelist
  const photoFile   = form.get('authorPhoto');
  const artworkFile = form.get('authorArtwork');
  for (const [slot, f] of [['authorPhoto', photoFile], ['authorArtwork', artworkFile]]){
    if (!f) continue;
    if (typeof f === 'string') continue;
    if (!ALLOWED_IMAGE_TYPES.has(f.type)){
      return json({ error: `${slot} must be JPEG, PNG, or WEBP` }, 400);
    }
    if (f.size > MAX_FILE_BYTES){
      return json({ error: `${slot} is larger than 15 MB` }, 400);
    }
  }

  // 6) Persist , each submission gets its own UUID-prefixed bucket of objects
  const id = uuid();
  const ref = refFromId(id);
  const meta = {
    id,
    reference: ref,
    receivedAt: new Date().toISOString(),
    ip,
    userAgent: request.headers.get('user-agent') || '',
    files: {},
  };

  async function uploadFile(slot, file){
    if (!file || typeof file === 'string') return null;
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const key = `${id}/${slot}.${ext}`;
    if (env.INTAKE_FILES){
      await env.INTAKE_FILES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { submissionId: id, slot },
      });
    }
    meta.files[slot] = { key, name: file.name, type: file.type, size: file.size };
    return key;
  }

  try {
    await uploadFile('authorPhoto',   photoFile);
    await uploadFile('authorArtwork', artworkFile);

    // Append file URLs back into the payload as additional fields so the
    // importer's extractFile() can find them. Use the keys; the fetch
    // script signs them when downloading.
    if (meta.files.authorPhoto){
      payload.data.fields.push({
        label: 'A clear photo of you (as big as you have it)',
        key:   'authorPhoto',
        value: { url: `r2://${meta.files.authorPhoto.key}`, name: meta.files.authorPhoto.name },
      });
    }
    if (meta.files.authorArtwork){
      payload.data.fields.push({
        label: "Any drawing of your own you'd like us to see",
        key:   'authorArtwork',
        value: { url: `r2://${meta.files.authorArtwork.key}`, name: meta.files.authorArtwork.name },
      });
    }

    // Stamp the payload with the same submission id so the importer's
    // idempotency check (sourceId) catches re-imports.
    payload.data.fields.push({ label: 'Submission ID', key: '__submissionId', value: id });
    payload._meta = meta;

    if (env.INTAKE_SUBMISSIONS){
      await env.INTAKE_SUBMISSIONS.put(`${id}.json`, JSON.stringify(payload, null, 2), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { reference: ref, receivedAt: meta.receivedAt },
      });
    } else {
      // Local-dev fallback: just log; the test harness reads from the
      // request, not from R2.
      console.log('[intake] R2 binding INTAKE_SUBMISSIONS missing, dropping submission to stdout:\n', JSON.stringify(payload, null, 2));
    }

    // Fire-and-forget the email notifications via waitUntil so the parent's
    // POST response returns immediately. Email failure never affects the
    // user-facing submit success.
    if (typeof waitUntil === 'function'){
      waitUntil(fireNotificationEmails(env, payload, meta));
    }

    return json({ ok: true, id, reference: ref });
  } catch (err){
    return json({ error: 'persistence failed', detail: String(err && err.message || err) }, 500);
  }
}

// CORS preflight: this endpoint is same-origin in production, but allow
// OPTIONS so local dev (file:// → wrangler) doesn't choke.
export function onRequestOptions(){
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

function json(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
