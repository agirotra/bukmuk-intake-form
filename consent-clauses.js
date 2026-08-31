/* Bukmuk , consent clause SINGLE SOURCE OF TRUTH.
 *
 * Every consent tick text and the plain-language summary of the Young Author
 * Agreement live HERE and nowhere else on the client. Both pages load this
 * file BEFORE their own script:
 *
 *   index.html   , the full authors' intake (folio IX guardian sign-off)
 *   consent.html , the short consent + agreement form, for stories that
 *                  reached us by WhatsApp, email or a call
 *
 * Why a shared file: the Young Author Agreement already exists twice in the
 * bukmuk-publishing repo (PARENT_AGREEMENT.md and src/app/(site)/agreement/
 * page.tsx), separately hand-maintained, and only the .tsx is what parents
 * actually sign. A third hand-copied set of clauses is how you end up with
 * three different promises. Do not inline these strings anywhere.
 *
 * The HTML still carries the same text literally, so the page reads correctly
 * with no JavaScript. applyClauses() overwrites it from here on load, so this
 * file wins, and logs a warning if the two ever drift.
 *
 * Server side (functions/api/submit.js) has its own FIELD_LABELS mirror for
 * label lookup. The AGREEMENT SUMMARY is not mirrored there: consent.js sends
 * the exact text the parent read as the `agreementSummary` field, so the
 * stored record and the confirmation email quote what was on screen rather
 * than a second copy that can drift.
 *
 * House rule: zero em-dashes and en-dashes in anything here.
 */
(function (global) {
  'use strict';

  // Version stamp stored with every signature. Bump it whenever the text of a
  // tick or a summary line changes, so a record always says which wording was
  // accepted. Format: <instrument>-<yyyy>-<mm>.
  var AGREEMENT_VERSION = 'ya-2026-08';

  var AGREEMENT_URL = 'https://bukmukpublishing.com/agreement';

  // ── Publication consent ticks ──────────────────────────────────────────
  // Keys match scripts/import-submissions.js FIELD_MAP in bukmuk-editor.
  // These three strings are the labels the importer matches on; changing one
  // means changing FIELD_MAP and test/intake-form.test.js in the same commit.
  var LABELS = {
    consentPublish: "I allow Bukmuk to lightly edit (keeping the child's voice) and publish this story in a Bukmuk book that may be sold on public platforms including Amazon. I understand I can request withdrawal before publication.",
    consentPhoto: "I allow the author's photo to be printed.",
    consentLocation: "I allow the author's city to be printed.",

    // Added 2026-08-31, and added to BOTH forms in the same change. Printing a
    // child's photo in their own book and putting that child on our website,
    // on Instagram and on an Amazon listing are different decisions, and we do
    // the second. lib/family-message.js in bukmuk-editor had been asking this
    // on the WhatsApp route since 2026-08-31 with a note that "the form does
    // not ask it yet", which is backwards: the written form should never
    // capture less than a conversation does.
    consentPromo: "I allow the author's photo and name to be used to promote the book, on our website, on social media and on the shop listing.",

    // Commercial acceptance. New with consent.html; the full intake form does
    // not show it (a workshop submission is not a paid package).
    agreementAccepted: 'I am the parent or lawful guardian of the author named above. I have read the short version above, and I accept the Bukmuk Young Author Agreement in full.',
  };

  // ── The Young Author Agreement, in short ───────────────────────────────
  // Distilled from PARENT_AGREEMENT.md in the bukmuk-publishing repo. This is
  // a summary a parent can read in a minute, NOT a replacement for the
  // agreement: the tick above accepts the full document, which is linked on
  // the page. If a line here and the full agreement ever disagree, the full
  // agreement governs and this line is the bug. Re-read both when either
  // changes.
  var SHORT_TERMS = [
    "Your child owns their story. Publishing with us does not change that. You are letting us edit, design, print and sell the book for as long as it is in publication.",
    "You are agreeing on your child's behalf, because they are under 18.",
    "Your child earns 5% of the price of every copy sold on Amazon, in India and in the Amazon shops in other countries. We pay it every three months into the bank account you give us, once it adds up to ₹500, and we send you a statement each time. Copies we sell ourselves are already discounted, so they do not earn a royalty on top.",
    "We print your child's name the way you choose above, their age and a short bio. Their photo and their city are printed only if you tick those boxes.",
    "We may use the book, your child's name and the photo you give us to celebrate their work on our website and in our marketing. You can opt out of marketing at any time by writing to helpdesk@bukmuk.com.",
    "We edit lightly and we keep your child's voice. Clear spelling, punctuation and grammar fixes, never a rewrite, never a nicer synonym. Anything that would change the meaning, we ask you both first.",
    "You confirm the story is your child's own original work, not copied from anyone, and that it contains nothing unlawful. If that turns out not to be true we may pause or stop publishing, and you agree to cover reasonable costs we face because of it.",
    "You see and approve the book before we print it. Changes you ask for after that, or a reprint for a mistake that was not ours, may cost extra.",
    "Payment is in full and in advance, and we start work once it is received. Full refund if you cancel before we start. After we start and before printing, we refund the part we have not done. Once printing starts, or the book is published, it is non refundable. Workshop and mentoring seats have their own notice periods, set out in the full agreement.",
    "We aim to have the book ready in about 8 to 10 weeks after we have the final manuscript and the payment, depending on how quickly approvals come back.",
    "Listing on Amazon follows Amazon's own rules, which change, so we cannot promise a book stays available forever or guarantee any sales.",
    "If something goes wrong, the most we would owe you is what you paid us for the service, and we are not responsible for indirect losses such as lost sales. Delays caused by printers, couriers or Amazon are outside our control.",
    "Indian law applies, and any dispute goes to the courts in Delhi.",
    "You can withdraw at any time before publication. Write to helpdesk@bukmuk.com and we remove the story and the photo from our systems. We cannot recall copies that are already printed.",
  ];

  // The exact block of text the parent read, stored with their signature.
  function summaryText(){
    return SHORT_TERMS.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
  }

  // Fill every [data-clause="<key>"] element from LABELS, and every
  // [data-clause-list] from SHORT_TERMS. The HTML keeps the same text inline
  // so the page is correct without JavaScript; this makes THIS file the
  // authority and shouts if the two have drifted.
  function applyClauses(root){
    var scope = root || global.document;
    if (!scope || !scope.querySelectorAll) return;

    scope.querySelectorAll('[data-clause]').forEach(function (el) {
      var key = el.getAttribute('data-clause');
      var want = LABELS[key];
      if (want == null) return;
      var have = (el.textContent || '').replace(/\s+/g, ' ').trim();
      var norm = want.replace(/\s+/g, ' ').trim();
      if (have && have !== norm){
        try {
          console.warn('[bukmuk-consent] clause drift on "' + key + '".\n  HTML: ' + have + '\n  SSOT: ' + norm);
        } catch (e) {}
      }
      el.textContent = want;
    });

    scope.querySelectorAll('[data-clause-list]').forEach(function (el) {
      el.innerHTML = '';
      SHORT_TERMS.forEach(function (t) {
        var li = scope.createElement ? scope.createElement('li') : global.document.createElement('li');
        li.textContent = t;
        el.appendChild(li);
      });
    });

    scope.querySelectorAll('[data-agreement-link]').forEach(function (el) {
      el.setAttribute('href', AGREEMENT_URL);
    });
  }

  global.BUKMUK_CONSENT = {
    AGREEMENT_VERSION: AGREEMENT_VERSION,
    AGREEMENT_URL: AGREEMENT_URL,
    LABELS: LABELS,
    SHORT_TERMS: SHORT_TERMS,
    summaryText: summaryText,
    applyClauses: applyClauses,
  };

  if (global.document){
    if (global.document.readyState === 'loading'){
      global.document.addEventListener('DOMContentLoaded', function () { applyClauses(); });
    } else {
      applyClauses();
    }
  }
})(typeof window !== 'undefined' ? window : this);
