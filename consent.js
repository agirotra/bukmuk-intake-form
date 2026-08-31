/* Bukmuk , consent + agreement form (consent.html).
 *
 * For young authors whose story reached us on WhatsApp, by email or on a call,
 * so they never went through the full authors' intake at "/". There is no
 * story to upload here: the page collects the two things we still need in
 * writing, publication consent and acceptance of the Young Author Agreement,
 * and posts them to the SAME /api/submit endpoint as the full form.
 *
 * The payload is the same Tally-compatible shape, with formKind: "consent".
 * The Function branches on that to relax the story fields (there is no story)
 * and files the record under the consent/ prefix in R2, so the editor's
 * story importer never tries to build a book out of a signature.
 *
 * Clause text is NOT defined here. It comes from consent-clauses.js, the
 * single source of truth loaded before this file. See the header there.
 */
(function () {
  'use strict';

  var CLAUSES = window.BUKMUK_CONSENT;
  if (!CLAUSES){
    console.error('[bukmuk-consent] consent-clauses.js did not load; refusing to run.');
    return;
  }

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var form = $('#consentForm');
  if (!form) return;

  // Labels the editor's importer matches on. The three consent ticks and the
  // agreement tick come from the SSOT; the rest mirror intake.js LABELS.
  var LABELS = {
    authorName:        'Your name',
    authorAge:         'How old are you?',
    authorLocation:    'Which city or town do you live in?',
    storyTitle:        "Your story's title",
    creditAs:          'How should we name you?',
    penName:           'Your pen name',
    childAssent:       'Do you want your story in the book?',
    guardianName:      'Parent/guardian full name',
    guardianRelation:  'Your relationship',
    guardianEmail:     "A grown-up's email (so we can reach your parent/guardian)",
    guardianPhone:     'Phone',
    guardianSignature: 'Type your full name as a signature',
    consentDate:       'Date',
    consentPublish:    CLAUSES.LABELS.consentPublish,
    consentPhoto:      CLAUSES.LABELS.consentPhoto,
    consentLocation:   CLAUSES.LABELS.consentLocation,
    consentPromo:      CLAUSES.LABELS.consentPromo,
    agreementAccepted: CLAUSES.LABELS.agreementAccepted,
  };

  // creditAs goes out as long-form text, because the importer's
  // normaliseCreditAs() does a substring match on it (mirrors intake.js).
  var CREDIT_AS_LABEL = {
    full:  'My full name',
    first: 'My first name only',
    pen:   'A pen name',
  };

  // ── Em-dash sanitiser (mirrors lib/sanitise in bukmuk-editor) ──────────
  function sanitiseEmDashes(s){
    if (s == null) return s;
    return String(s).replace(/—/g, ', ').replace(/–/g, ' to ').replace(/ {2,}/g, ' ');
  }
  $$('input[type=text], input[type=email], input[type=tel]').forEach(function (el) {
    el.addEventListener('input', function () {
      if (/[—–]/.test(el.value)){
        var pos = el.selectionStart;
        el.value = sanitiseEmDashes(el.value);
        try { el.setSelectionRange(pos, pos); } catch (e) {}
      }
    });
  });

  // ── Prefill from the link ──────────────────────────────────────────────
  // The editor sends one tap on WhatsApp, e.g.
  //   /consent?child=Avish%20Jain&age=6&title=Mageton&book=mageton-avish
  //     &package=Signature%20Paperback&total=%E2%82%B99%2C500&guardian=Neha%20Jain
  //     &email=neha@example.in&phone=%2B919812345678&code=<workshop code>
  // Everything stays editable; the parent corrects anything we got wrong.
  var params = new URLSearchParams(window.location.search);
  var hidden = {
    book:        params.get('book') || '',
    channel:     params.get('channel') || 'direct',   // whatsapp / email / call
    cohort:      params.get('cohort') || '',
    facilitator: params.get('facilitator') || '',
    packageName:  params.get('package') || '',
    packageTotal: params.get('total') || '',
    workshopCode: params.get('code') || '',
  };

  function prefill(name, value){
    if (!value) return;
    var el = form.elements[name];
    if (el && !el.value) el.value = sanitiseEmDashes(value);
  }
  prefill('authorName', params.get('child'));
  prefill('authorAge', params.get('age'));
  prefill('storyTitle', params.get('title'));
  prefill('authorLocation', params.get('city'));
  prefill('guardianName', params.get('guardian'));
  prefill('guardianRelation', params.get('relation'));
  prefill('guardianEmail', params.get('email'));
  prefill('guardianPhone', params.get('phone'));

  // Package line, shown only when the link carries one.
  if (hidden.packageName || hidden.packageTotal){
    var line = $('#packageLine');
    line.textContent = [hidden.packageName, hidden.packageTotal].filter(Boolean).join('  ·  ');
    line.hidden = false;
  }

  // The signature placeholder mirrors the name they typed above. A different
  // person's name greyed out inside a signature box is the one place on this
  // form where a stranger's name must never appear.
  var nameEl = form.elements['guardianName'];
  var sigEl  = form.elements['guardianSignature'];
  function syncSigPlaceholder(){
    var typed = String(nameEl && nameEl.value || '').trim();
    if (sigEl) sigEl.placeholder = typed || 'Your full name';
  }
  if (nameEl) nameEl.addEventListener('input', syncSigPlaceholder);
  syncSigPlaceholder();

  // Today's date, pre-filled but editable.
  var dateEl = form.elements['consentDate'];
  if (dateEl && !dateEl.value){
    var d = new Date();
    dateEl.value = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // ── Conditional reveals ────────────────────────────────────────────────
  function toggle(wrapId, open){
    var w = $('#' + wrapId);
    if (w) w.classList.toggle('is-open', !!open);
  }
  function syncCredit(){
    var picked = $$('input[name=creditAs]:checked')[0];
    toggle('penWrap', picked && picked.value === 'pen');
  }
  $$('input[name=creditAs]').forEach(function (el) { el.addEventListener('change', syncCredit); });
  syncCredit();

  var cityBox  = form.elements['consentLocation'];
  var photoBox = form.elements['consentPhoto'];
  var promoBox = form.elements['consentPromo'];
  function syncCity(){ toggle('cityWrap', cityBox && cityBox.checked); }
  // Either tick is a reason to want the photo: one prints it, one promotes it.
  function syncPhoto(){ toggle('photoWrap', (photoBox && photoBox.checked) || (promoBox && promoBox.checked)); }
  if (cityBox) cityBox.addEventListener('change', syncCity);
  if (photoBox) photoBox.addEventListener('change', syncPhoto);
  if (promoBox) promoBox.addEventListener('change', syncPhoto);
  syncCity(); syncPhoto();

  // Hide the "scroll the box" hint once they have reached the end of the terms.
  var termsBox = $('.terms');
  var scrollHint = $('#scrollHint');
  if (termsBox && scrollHint){
    var checkScrolled = function () {
      var atEnd = termsBox.scrollTop + termsBox.clientHeight >= termsBox.scrollHeight - 24;
      var noScroll = termsBox.scrollHeight <= termsBox.clientHeight + 4;
      scrollHint.style.visibility = (atEnd || noScroll) ? 'hidden' : 'visible';
    };
    termsBox.addEventListener('scroll', checkScrolled);
    window.addEventListener('resize', checkScrolled);
    checkScrolled();
  }

  // ── Validation ─────────────────────────────────────────────────────────
  // Mirrors validateOnServer()'s consent-mode contract in
  // functions/api/submit.js. If this passes, the server accepts it.
  var MAX_FILE_BYTES = 15 * 1024 * 1024;
  var ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp'];

  function fieldOf(el){ return el ? el.closest('.field') : null; }

  function validate(){
    var bad = [];
    function flag(el, msg){
      var f = fieldOf(el);
      if (f){
        f.classList.add('error');
        var e = f.querySelector('.field-error');
        if (e && msg) e.textContent = msg;
      }
      bad.push(el);
    }
    function ok(el){ var f = fieldOf(el); if (f) f.classList.remove('error'); }

    ['authorName','storyTitle','guardianName','guardianRelation',
     'guardianEmail','guardianPhone','guardianSignature','consentDate'].forEach(function (k) {
      var el = form.elements[k];
      if (!el) return;
      if (!String(el.value || '').trim()) flag(el); else ok(el);
    });

    // 1 to 17, not the intake form's 7 to 15: this form is signed by families
    // we already work with, and some of those authors are younger than the
    // programme's floor. See the note in functions/api/submit.js.
    var ageEl = form.elements['authorAge'];
    var age = parseInt(String(ageEl && ageEl.value || ''), 10);
    if (!(age >= 1 && age <= 17)) flag(ageEl, 'Their age in years.'); else ok(ageEl);

    var emailEl = form.elements['guardianEmail'];
    if (emailEl && emailEl.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailEl.value)){
      flag(emailEl, 'That email does not look right.');
    }

    var credit = $$('input[name=creditAs]:checked')[0];
    if (!credit) flag($$('input[name=creditAs]')[0]);
    else {
      ok($$('input[name=creditAs]')[0]);
      if (credit.value === 'pen'){
        var pen = form.elements['penName'];
        if (!String(pen.value || '').trim()) flag(pen); else ok(pen);
      }
    }

    var assent = $$('input[name=childAssent]:checked')[0];
    if (!assent) flag($$('input[name=childAssent]')[0]);
    else ok($$('input[name=childAssent]')[0]);

    // City is required only when they asked us to print one.
    if (cityBox && cityBox.checked){
      var loc = form.elements['authorLocation'];
      if (!String(loc.value || '').trim()) flag(loc); else ok(loc);
    }

    var photoEl = form.elements['authorPhoto'];
    var photoFile = photoEl && photoEl.files && photoEl.files[0];
    if (photoFile){
      if (ALLOWED_IMAGE.indexOf(photoFile.type) === -1 || photoFile.size > MAX_FILE_BYTES){
        flag(photoEl);
      } else ok(photoEl);
    }

    var errors = [];
    if (!form.elements['consentPublish'].checked){
      errors.push('Please tick the first box in section III. Without it we cannot publish the story.');
    }
    if (!form.elements['agreementAccepted'].checked){
      errors.push('Please tick the box in section V to accept the Young Author Agreement.');
    }
    if (assent && assent.value !== 'Yes'){
      errors.push('You have told us the author is not ready. Nothing to sign yet: write to us at helpdesk@bukmuk.com and we will hold the book.');
    }

    return { ok: bad.length === 0 && errors.length === 0, firstBadEl: bad[0] || null, errors: errors };
  }

  // ── Payload ────────────────────────────────────────────────────────────
  function buildPayload(){
    var fields = [];
    function add(key, value, label){
      if (value == null || value === '') return;
      fields.push({ label: label || LABELS[key] || key, key: key, value: sanitiseEmDashes(String(value)) });
    }

    ['authorName','authorAge','authorLocation','storyTitle','penName',
     'guardianName','guardianRelation','guardianEmail','guardianPhone',
     'guardianSignature','consentDate'].forEach(function (k) {
      var el = form.elements[k];
      if (el && el.value) add(k, el.value);
    });

    var credit = $$('input[name=creditAs]:checked')[0];
    if (credit) add('creditAs', CREDIT_AS_LABEL[credit.value] || credit.value);
    var assent = $$('input[name=childAssent]:checked')[0];
    if (assent) add('childAssent', assent.value);

    // Ticks go out as their long label text, the way a Tally export reads.
    ['consentPublish','consentPhoto','consentLocation','consentPromo','agreementAccepted'].forEach(function (k) {
      var el = form.elements[k];
      if (el && el.checked) add(k, LABELS[k]);
    });

    // What the parent actually read, stored verbatim with the signature. This
    // is deliberately the text and not a pointer to it: a summary that can be
    // edited later is not evidence of what was on screen at signing time.
    add('agreementVersion', CLAUSES.AGREEMENT_VERSION, 'Agreement version');
    add('agreementSummary', CLAUSES.summaryText(), 'Agreement summary as shown');
    add('agreementUrl', CLAUSES.AGREEMENT_URL, 'Full agreement URL');

    // A consent-only record. The Function branches on this, and the editor
    // files it against an existing story rather than creating one.
    add('formKind', 'consent', 'formKind');

    Object.keys(hidden).forEach(function (k) {
      if (hidden[k]) add(k, hidden[k], k === 'workshopCode' ? 'Workshop code' : k);
    });

    return { data: { fields: fields }, _client: { submittedAt: new Date().toISOString() } };
  }

  // ── Submit ─────────────────────────────────────────────────────────────
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var submitBtn = $('#submitBtn');
    var submitError = $('#submitError');
    submitError.textContent = '';

    // Honeypot: pretend success, send nothing.
    var hp = form.elements['website'];
    if (hp && hp.value){ showThankyou('hp-' + Math.random().toString(36).slice(2, 8)); return; }

    var v = validate();
    if (!v.ok){
      submitError.textContent = v.errors.length
        ? v.errors.join(' ')
        : 'Some things need a second look, see the fields marked above.';
      submitError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (v.firstBadEl) { try { v.firstBadEl.focus({ preventScroll: true }); } catch (e) {} }
      return;
    }

    submitBtn.setAttribute('aria-busy', 'true');
    var started = Date.now();
    var counter = setInterval(function () {
      var s = Math.floor((Date.now() - started) / 1000);
      submitBtn.textContent = s > 0 ? 'Sending… ' + s + 's' : 'Sending…';
    }, 500);
    submitBtn.textContent = 'Sending…';

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 45000);
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var MAX_ATTEMPTS = 3;

    try {
      var photoEl = form.elements['authorPhoto'];
      var wantsPhoto = (photoBox && photoBox.checked) || (promoBox && promoBox.checked);
      var photoFile = (wantsPhoto && photoEl && photoEl.files) ? photoEl.files[0] : null;

      var res;
      for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
        var body = new FormData();
        body.append('payload', JSON.stringify(buildPayload()));
        if (photoFile) body.append('authorPhoto', photoFile, photoFile.name);
        try {
          res = await fetch('/api/submit', { method: 'POST', body: body, signal: controller.signal });
        } catch (netErr){
          if (netErr && netErr.name === 'AbortError') throw netErr;
          if (attempt < MAX_ATTEMPTS && !controller.signal.aborted){
            await sleep(700 * attempt);
            if (controller.signal.aborted) throw netErr;
            continue;
          }
          throw netErr;
        }
        if (res.status >= 500 && attempt < MAX_ATTEMPTS && !controller.signal.aborted){
          await sleep(700 * attempt);
          if (controller.signal.aborted) break;
          continue;
        }
        break;
      }

      if (!res.ok){
        var t = await res.text().catch(function () { return ''; });
        if (res.status === 403){
          var reason = '';
          try { reason = (JSON.parse(t).reason) || ''; } catch (e) {}
          throw new Error(reason === 'missing'
            ? 'This link is missing its access code. Please use the exact link we sent you, or write to helpdesk@bukmuk.com.'
            : 'This link is not valid any more. Please write to helpdesk@bukmuk.com and we will send you a fresh one.');
        }
        throw new Error('We could not save that (' + res.status + '). ' + (t || '').slice(0, 200));
      }

      var out = await res.json();
      showThankyou(out.reference || '');
    } catch (err){
      var msg = (err && err.name === 'AbortError')
        ? 'That took too long. Your connection may have dropped. Nothing was saved, so please try again.'
        : (err && err.message) || 'Something went wrong.';
      submitError.textContent = msg + ' If it keeps happening, WhatsApp us on +91 81302 86286 and we will take it down by hand.';
      submitBtn.removeAttribute('aria-busy');
      submitBtn.textContent = 'Sign and send →';
    } finally {
      clearInterval(counter);
      clearTimeout(timeout);
    }
  });

  function showThankyou(ref){
    var el = $('#refCode');
    if (el) el.textContent = ref || '';
    // Same reveal mechanism as the full intake form: .is-submitted hides the
    // sheet, .is-shown reveals the thank-you. Both classes live in styles.css.
    $$('.form-shell-guardian').forEach(function (n) { n.classList.add('is-submitted'); });
    var ty = $('#thankyou');
    if (ty) ty.classList.add('is-shown');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
})();
