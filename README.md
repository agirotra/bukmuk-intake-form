# Bukmuk Authors' Intake

> **Live:** [`submit.bukmukpublishing.com`](https://submit.bukmukpublishing.com) · also at `bukmuk-intake.pages.dev`

The public form children fill in to submit a story to Bukmuk Publishing.
Static HTML + CSS + JS + one Cloudflare Pages Function. No build step,
no framework, no analytics.

Submissions land in a Cloudflare R2 bucket in a shape that is
**100% ingestable** by [`scripts/import-submissions.js`](https://github.com/agirotra/bukmuk-editor/blob/main/scripts/import-submissions.js)
in the private `bukmuk-editor` repo, with no transformation in between.

---

## Architecture

Two repos, intentionally separate:

```
This repo (bukmuk-intake-form, public)            bukmuk-editor (private)
├── index.html                                    ├── pipeline.js + agents
├── styles.css                                    ├── lib/, books/, etc.
├── intake.js                                     ├── scripts/import-submissions.js
├── assets/bukmuk-logo.png                        └── test/intake-form.test.js
├── functions/api/submit.js  ←──── POST ───→         ↑ contract round-trip test
└── scripts/setup-cloudflare.js                      against this form's labels

              ↓ writes
       R2: bukmuk-intake-submissions  (Tally-compatible JSON, one file per submission)
       R2: bukmuk-intake-files        (photo + drawing uploads)
                                                  ↑
                                        editor pulls down, pipes through
                                        scripts/import-submissions.js
```

Why split: the editor repo holds the editorial pipeline and (eventually)
children's content. This repo only holds the public-facing form. The
trust boundaries are different; the two products are coupled by API
contract, not by code.

---

## Visual identity

- Real Bukmuk logo: `assets/bukmuk-logo.png` (mirror of `bukmuk.com/assets/darklogo.png`)
- Fonts: **Fraunces** + **Geist Mono** (loaded from Google Fonts at runtime)
- Brand palette (from the editor's `CLAUDE.md`):
  - Blue `#3744e2` (working accent)
  - Lime `#d5f223` (rare and earned: progress bar, primary CTA, marginalia highlight)
  - Charcoal `#2e2c2c` (ink)
- Logo navy `#1d2a5e` is the registered mark's locked value, never recoloured
- Cream paper ground `#f5f1e6` (matches `bukmukpublishing.com` house style)

The guardian consent section (§IX) deliberately flips register: ruled
blue-tinted ledger paper, italic typed-signature font, no Lime accent.
This is the legal block; it intentionally does not look like the rest
of the form.

---

## File layout

```
.
├── index.html                  full form, every FIELD_MAP field
├── styles.css                  extracted from the signed-off mock
├── intake.js                   autosave, validation, conditional Q&A, submit
├── assets/
│   └── bukmuk-logo.png         registered BUKMUK® mark
├── functions/
│   └── api/
│       └── submit.js           Cloudflare Pages Function: validate → R2
└── scripts/
    └── setup-cloudflare.js     one-time R2 + Pages provisioning helper
```

---

## Deploy model

**Git-connected.** Cloudflare Pages is wired to this repo via the
Cloudflare dashboard's "Connect to Git" flow. Pushes to `main` trigger
an auto-build:

```
git push origin main
      ↓
GitHub webhook
      ↓
Cloudflare clones repo
      ↓
Detects functions/api/submit.js → bundles as a Worker
      ↓
Uploads static assets + Worker bundle
      ↓
Atomic swap → live within ~30 seconds
```

Each deploy gets its own preview URL (`<hash>.bukmuk-intake.pages.dev`)
so you can roll back through history if needed.

### One-time setup (already done , preserved here for the record)

1. **Enable R2** on the Cloudflare account (one-time dashboard click,
   accepts the free-tier pricing terms).
2. **Create the Pages project** by connecting this repo in the dashboard:
   - Project name: `bukmuk-intake`
   - Production branch: `main`
   - Framework preset: None
   - Build command: *(empty)*
   - Build output directory: `/`
3. **Provision resources** with:
   ```bash
   export CLOUDFLARE_API_TOKEN="<scoped token: R2:Edit + Pages:Edit + DNS:Edit>"
   node scripts/setup-cloudflare.js \
     --domain submit.bukmukpublishing.com --skip-deploy
   ```
   This creates the R2 buckets, binds them to the project as
   `INTAKE_SUBMISSIONS` + `INTAKE_FILES`, and attaches the custom
   domain. Idempotent , re-running is safe.

---

## Email notifications (AWS SES)

On every successful submission, the Function fires **two emails** in the
background (via `waitUntil`, so the parent's POST response is never
blocked by the email send):

1. **Editor notification** , short summary of the submission, sent to
   `NOTIFY_TO` (defaults to `abhinav.girotra@gmail.com`).
2. **Parent confirmation** , warm "we have your story" + reference + 
   what-happens-next timeline, sent to the `guardianEmail` field from the
   form.

If any of the SES env vars below are missing, the Function logs and
skips the emails , submissions still complete successfully.

### Required env vars on the Pages project

Set these in **Cloudflare Dashboard → Workers & Pages → bukmuk-intake →
Settings → Environment variables** (Production, mark secrets as Encrypted):

| Variable | Example | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | `AKIA…` | From the dedicated IAM user (see below). Encrypt. |
| `AWS_SECRET_ACCESS_KEY` | `…` | Same IAM user. **Encrypt.** |
| `AWS_REGION` | `ap-south-1` | SES region. |
| `SES_FROM_ADDRESS` | `editor@bukmuk.com` | Any address on a domain verified in SES. |
| `NOTIFY_TO` | `abhinav.girotra@gmail.com` | Optional. Defaults to the address above. |
| `SES_REPLY_TO` | `abhinav.girotra@gmail.com` | Optional. `Reply-To` header on both emails so parent replies don't bounce. Defaults to `NOTIFY_TO`. |

### Minimal IAM policy for the dedicated user

Create a new IAM user (e.g. `cf-pages-intake-ses`) with programmatic
access only. Attach an inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": "*"
    }
  ]
}
```

The smaller scope keeps blast radius minimal if the keys ever leak.

### SES sandbox check

New SES accounts start in **Sandbox mode** , you can only send to
addresses verified in your SES. To send parent confirmations to
arbitrary `guardianEmail` addresses, you need to **request production
access** in the SES dashboard (usually approved in 24-48h). Until then,
editor notifications work (verify `abhinav.girotra@gmail.com` as a
recipient) but parent emails will bounce for non-verified addresses.

---

## Local development

```bash
# Static side: any HTTP server works
python3 -m http.server 8765
# open http://127.0.0.1:8765/?book=monsoon-2026

# To exercise the Pages Function locally (needs wrangler + bindings):
npx wrangler pages dev . --binding INTAKE_FILES=local --binding INTAKE_SUBMISSIONS=local
```

Without R2 bindings, the function logs each submission to stdout instead
of writing to R2 , useful for end-to-end manual testing.

---

## Getting submissions back into the editor

Submissions land in R2 as `<uuid>.json` (Tally-compatible shape) plus
optional `<uuid>/authorPhoto.<ext>` and `<uuid>/authorArtwork.<ext>`.

### Manual download (from the editor repo)

```bash
# List submissions in the bucket
npx wrangler r2 object list bukmuk-intake-submissions

# Download one (or all) submissions to a local file
npx wrangler r2 object get bukmuk-intake-submissions/<uuid>.json > /tmp/responses.json

# Run the importer (lives in bukmuk-editor)
node scripts/import-submissions.js \
  --book monsoon-2026 \
  --file /tmp/responses.json \
  --no-fetch-photos        # photos are fetched manually in the next step
```

### Photos

The submission JSON carries a photo URL like `r2://<uuid>/authorPhoto.jpg`.
The importer recognises this as "URL pending" and writes it to the
consent ledger. Download the photo manually and copy it to the matching
slug:

```bash
npx wrangler r2 object get bukmuk-intake-files/<uuid>/authorPhoto.jpg \
  > books/monsoon-2026/input/<slug>-photo.jpg
```

---

## What the form guarantees on the editor's behalf

These behaviours are enforced **client-side AND server-side** so the
contract holds even if a request bypasses the form:

1. **No em-dashes ever.** `intake.js` strips `—` (em-dash) and `–`
   (en-dash) live as the author types; `functions/api/submit.js`
   sanitises the payload again before persisting. Mirrors the
   editor's repo-wide `lib/sanitise` rule that every read/write path
   enforces.

2. **Required-field contract matches the importer's
   `validateSubmission()`.** Same list, same word-count floor (30),
   same email regex, same consent gates. If the form accepts a
   submission, `import-submissions.js` will too.

3. **Privacy fails safe.**
   - `authorLocation` is only included in the per-story metadata if
     `consentLocation` is ticked. If unticked, the city is dropped at
     `buildMeta()` time , downstream paths never see it.
   - `authorPhoto` is only uploaded to R2 if `consentPhoto` is ticked.

4. **Round-trip is lossless.** The `data.fields[]` shape this Function
   writes is exactly what `flattenSubmissions()` in the importer reads.
   The round-trip is tested by `test/intake-form.test.js` in
   `bukmuk-editor` (15 tests, covers labels, validation, age brackets,
   consent matrix, idempotency hash).

---

## Editorial ethic in the UI

The form text reflects the Bukmuk editorial ethic verbatim. These are
not marketing copy decisions; they are the same promises documented in
`bukmuk-editor`'s `CLAUDE.md`, surfaced at the point an author is being
asked to commit:

- **Marginalia in §I:** *"Your voice is sacred. If you write 'the door
  were broken' on purpose, we keep it on purpose."*
- **Hint on the language-words field:** *"So our typesetter doesn't
  'correct' them."*
- **Guardian marginalia:** *"Light edits means: clear spelling errors,
  capitalising proper nouns, full stops. We never restructure sentences
  or replace words."*
- **Pact card 03:** *"Within a fortnight you'll hear from a real human.
  Light edits only. We always ask before changing anything."*

Do not rewrite these copy lines as "branded marketing voice". They are
the editorial commitment.

---

## Honeypot + spam controls

- A hidden `name="website"` field is included in the form. Real humans
  never fill it. If it arrives non-empty, the server treats the
  submission as silently successful (returns a fake reference, persists
  nothing).
- Cloudflare Pages' default WAF + bot management catches volumetric
  abuse.

---

## Accessibility notes

- All form fields have explicit `<label>` associations; required fields
  carry a visible `required` tag and the field's error text shows
  inline on validation failure.
- The age wheel (7–15) is a styled radio group with full keyboard
  support; focus rings are honoured.
- The consent checkboxes are large click/tap targets (28px box + the
  entire label text is clickable).
- A skip-link jumps from the masthead straight into the form.
- Body text scales fluidly (`clamp()` used for headings); no fixed-width
  layouts that break under reflow.

---

## Future iterations

- One-command "fetch all new submissions from R2 and run the importer"
  helper (planned for the editor repo, not this one).
- Email notification per submission via Cloudflare Email Workers /
  Resend to `helpdesk@bukmuk.com`.
- Optional per-school landing pages parameterised by `?cohort=...`.
- Saved-draft sharing link (so a kid can save halfway and a parent can
  finish the consent on a different device).

---

## Related

- [`agirotra/bukmuk-editor`](https://github.com/agirotra/bukmuk-editor)
  , the editorial pipeline. Receives submissions out of R2 and runs
  them through the publishing flow.
- [bukmuk.com](https://bukmuk.com) , Bukmuk Library
- [bukmukpublishing.com](https://bukmukpublishing.com) , Bukmuk Publishing
