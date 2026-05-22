/* ─── Bukmuk Authors' Intake , client-side form behaviour ──────────────────
   Lives on Cloudflare Pages alongside index.html. No build step, no deps.
   Posts a Tally-compatible payload to /api/submit so the existing
   scripts/import-submissions.js can ingest it losslessly.
   ─────────────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ─── Field contract ────────────────────────────────────────────────────
  // EXACT Tally question labels the importer matches on. Keep in sync with
  // scripts/import-submissions.js FIELD_MAP[*][0]. If you rename a label
  // here, rename the alias there in the same commit, otherwise import will
  // silently drop the field.
  const LABELS = {
    authorName:        'Your name',
    authorAge:         'How old are you?',
    authorLocation:    'Which city or town do you live in?',
    authorBio:         "Tell us about you in a few lines, the way you'd tell a friend",
    storyTitle:        "Your story's title",
    story:             'Paste or type your whole story here. Write it exactly how you want it, we keep your voice.',
    hasChapters:       'Does your story have chapters?',
    languageNote:      'Did you use words from Hindi, Tamil, or any other language? List them so we keep them.',
    inspiration:       'What gave you the idea for this story?',
    behindTheStory:    "What's the story behind writing it, how did it go?",

    qa_early_1: 'What is your story about, in your own words?',
    qa_early_2: 'Which part was the most fun to write?',
    qa_early_3: 'What do you want a reader to feel?',
    qa_mid_1:   'Where did the idea come from?',
    qa_mid_2:   'What was the trickiest bit to get right?',
    qa_mid_3:   'What would you tell another kid who wants to write?',
    qa_mid_4:   'A favourite line of yours, and why',
    qa_up_1:    'What were you trying to explore with this piece?',
    qa_up_2:    'What changed between your first idea and the final story?',
    qa_up_3:    'What are you proudest of, what would you still change?',
    qa_up_4:    'Advice for a younger writer?',

    funFavouriteWord:  'A word you love',
    funHobby:          'Something you do for fun',
    funAdvice:         'Your advice to other young writers',
    funFavouriteBook:  'A book you love',
    funThemeSong:      'A song that fits your story',
    funRandomFact:     'One random fact about you',

    artworkCaption:    'What is the drawing of?',
    dedication:        'Who do you dedicate your story to?',
    acknowledgements:  'Anyone you want to thank?',

    creditAs:          'How should we name you?',
    penName:           'Your pen name',

    guardianName:      'Parent/guardian full name',
    guardianRelation:  'Your relationship',
    guardianEmail:     "A grown-up's email (so we can reach your parent/guardian)",
    guardianPhone:     'Phone',
    consentPublish:    "I allow Bukmuk to lightly edit (keeping the child's voice) and publish this story in a Bukmuk book that may be sold on public platforms including Amazon. I understand I can request withdrawal before publication.",
    // consentVoice retired 2026-05-22: its "I understand light edits are made"
    // is redundant with consentPublish's "(keeping the child's voice)" and the
    // §IX marginalia. Importer accepts payloads with or without it.
    consentPhoto:      "I allow the author's photo to be printed.",
    consentLocation:   "I allow the author's city to be printed.",
    guardianSignature: 'Type your full name as a signature',
    consentDate:       'Date',

    childAssent:       'Do you want your story in the book?',
    editorNote:        'Anything you want the editor to know?',

    book:        'book',
    channel:     'channel',
    cohort:      'cohort',
    facilitator: 'facilitator',
  };

  // Map creditAs radio value → the long-form text Tally export uses, so the
  // importer's normaliseCreditAs() matches (it looks for substrings: "full",
  // "only", "age" / "city", "pen").
  const CREDIT_AS_LABEL = {
    full:            'My full name',
    'first-only':    'Just my first name (only)',
    'first-age-city':'First name, age, city',
    pen:             'A pen name',
  };

  const MIN_STORY_WORDS = 30;  // mirrors scripts/import-submissions.js
  const STORAGE_KEY = 'bukmuk-intake-v1';
  const SAVE_DEBOUNCE_MS = 300;

  // ─── Em-dash sanitiser (mirror of lib/sanitise) ────────────────────────
  // The repo-wide rule is "no em-dashes anywhere". The server applies the
  // same sanitisation on submit, but doing it client-side keeps the UI
  // honest as you type (paste a doc with em-dashes, see them replaced).
  function sanitiseEmDashes(s){
    if (s == null) return s;
    return String(s)
      .replace(/—/g, ', ')   // em-dash
      .replace(/–/g, ' to ') // en-dash
      .replace(/ {2,}/g, ' ');
  }

  // ─── DOM helpers ───────────────────────────────────────────────────────
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function wordCount(s){
    return String(s || '').trim().split(/\s+/).filter(Boolean).length;
  }
  function ageGroup(age){
    const n = parseInt(age, 10);
    if (n >= 7  && n <= 9)  return 'early';
    if (n >= 10 && n <= 12) return 'mid';
    if (n >= 13 && n <= 15) return 'upper';
    return null;
  }

  // ─── State ─────────────────────────────────────────────────────────────
  const form = $('#intakeForm');
  const guardianForm = $('#guardianForm');
  if (!form || !guardianForm) return;

  const fileBlobs = { authorPhoto: null, authorArtwork: null };
  let saveTimer = null;
  let submitted = false;

  // ─── Hidden fields from query string ───────────────────────────────────
  // Bukmuk's intake links are personalised per channel/cohort via query params:
  // ?book=monsoon-2026&channel=tally-twitter&cohort=delhi-school&facilitator=meera
  const params = new URLSearchParams(window.location.search);
  const hidden = {
    book:        params.get('book')        || '',
    channel:     params.get('channel')     || 'cf-pages',
    cohort:      params.get('cohort')      || '',
    facilitator: params.get('facilitator') || '',
  };

  // ─── Autosave (text only, never file blobs) ────────────────────────────
  function snapshot(){
    const data = {};
    for (const el of $$('input, textarea', form)){
      if (el.type === 'file') continue;
      if (el.name === 'website') continue; // honeypot
      if (el.type === 'radio' || el.type === 'checkbox'){
        if (el.checked) data[el.name] = el.value || true;
      } else {
        if (el.value) data[el.name] = el.value;
      }
    }
    for (const el of $$('input, textarea', guardianForm)){
      if (el.name === 'website') continue;
      if (el.type === 'radio' || el.type === 'checkbox'){
        if (el.checked) data[el.name] = el.value || true;
      } else {
        if (el.value) data[el.name] = el.value;
      }
    }
    return data;
  }

  function restore(){
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return; }
    if (!saved) return;
    for (const [name, value] of Object.entries(saved)){
      const els = $$(`[name="${CSS.escape(name)}"]`);
      if (!els.length) continue;
      if (els[0].type === 'radio'){
        for (const r of els) r.checked = (r.value === value);
      } else if (els[0].type === 'checkbox'){
        for (const c of els) c.checked = Boolean(value);
      } else {
        els[0].value = value;
      }
    }
    onAgeChange();
    onCreditAsChange();
    onStoryChange();
    updateProgress();
    syncRadioCards();
  }

  function persist(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); }
    catch {}
  }

  function scheduleSave(){
    if (submitted) return;
    setSaveTag('saving', 'Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persist();
      setSaveTag('saved', 'Saved , you can close and come back');
      updateProgress();
    }, SAVE_DEBOUNCE_MS);
  }

  function setSaveTag(state, text){
    for (const el of $$('.save-tag')){
      el.classList.remove('saving', 'error');
      if (state === 'saving') el.classList.add('saving');
      if (state === 'error')  el.classList.add('error');
      el.textContent = text;
      // re-add the colour dot via ::before (textContent doesn't kill it)
    }
  }

  // ─── Em-dash live sanitisation on text fields ──────────────────────────
  for (const el of $$('input[type=text], input[type=email], input[type=tel], textarea')){
    el.addEventListener('input', () => {
      const cleaned = sanitiseEmDashes(el.value);
      if (cleaned !== el.value){
        const pos = el.selectionStart;
        el.value = cleaned;
        try { el.setSelectionRange(pos, pos); } catch {}
      }
    });
  }

  // ─── Age → Q&A bracket switching ───────────────────────────────────────
  const qaSets = $$('.qa-set');
  const qaPlaceholder = $('#qaPlaceholder');
  function onAgeChange(){
    const age = (form.elements['authorAge'] || []).value
      || ($$('input[name=authorAge]:checked')[0] && $$('input[name=authorAge]:checked')[0].value);
    const bracket = ageGroup(age);
    for (const set of qaSets){
      set.hidden = (set.dataset.bracket !== bracket);
    }
    if (qaPlaceholder) qaPlaceholder.hidden = Boolean(bracket);
  }

  // ─── creditAs → conditionally reveal pen name ──────────────────────────
  const penWrap = $('#penNameWrap');
  function onCreditAsChange(){
    const v = ($$('input[name=creditAs]:checked')[0] || {}).value;
    if (!penWrap) return;
    penWrap.classList.toggle('is-open', v === 'pen');
    const pen = $('#penName');
    if (pen) pen.required = (v === 'pen');
  }

  // ─── Story word counter ────────────────────────────────────────────────
  const storyEl = $('#story');
  const storyCounter = $('#storyCounter');
  const storyCount = $('#storyCount');
  function onStoryChange(){
    if (!storyEl) return;
    const n = wordCount(storyEl.value);
    if (storyCount) storyCount.textContent = String(n);
    if (storyCounter) storyCounter.classList.toggle('ok', n >= MIN_STORY_WORDS);
  }

  // ─── Visually mark the chosen radio card ───────────────────────────────
  function syncRadioCards(){
    for (const group of $$('.radios')){
      for (const lbl of $$('label', group)){
        const inp = $('input[type=radio]', lbl);
        lbl.classList.toggle('is-checked', !!(inp && inp.checked));
      }
    }
  }

  // ─── File dropzones ────────────────────────────────────────────────────
  function attachDropzone(dropEl, inputEl, slot){
    const copy = $('[data-copy]', dropEl);
    const original = copy ? copy.innerHTML : '';

    function show(file){
      fileBlobs[slot] = file;
      dropEl.classList.add('has-file');
      const kb = Math.round(file.size / 1024);
      copy.innerHTML =
        `<b>${escapeHtml(file.name)}</b>` +
        `<span class="meta">${(kb > 1024 ? (kb/1024).toFixed(1) + ' MB' : kb + ' KB')} &nbsp;·&nbsp; ${escapeHtml(file.type || 'image')}</span>`;
      // Add remove button if not already there
      if (!dropEl.querySelector('.remove')){
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'remove'; btn.textContent = 'Remove';
        btn.addEventListener('click', (e) => { e.preventDefault(); reset(); });
        dropEl.appendChild(btn);
      }
    }
    function reset(){
      fileBlobs[slot] = null;
      inputEl.value = '';
      dropEl.classList.remove('has-file');
      if (copy) copy.innerHTML = original;
      const btn = dropEl.querySelector('.remove');
      if (btn) btn.remove();
    }
    inputEl.addEventListener('change', () => {
      const f = inputEl.files && inputEl.files[0];
      if (!f) return reset();
      if (f.size > 15 * 1024 * 1024){
        alert('Photo is over 15 MB. Please pick a smaller image.');
        return reset();
      }
      show(f);
    });
    // drag visuals
    ['dragenter','dragover'].forEach(evt =>
      dropEl.addEventListener(evt, e => { e.preventDefault(); dropEl.classList.add('drag-over'); }));
    ['dragleave','drop'].forEach(evt =>
      dropEl.addEventListener(evt, e => { dropEl.classList.remove('drag-over'); }));
  }
  attachDropzone($('#authorPhotoDrop'),   $('#authorPhoto'),   'authorPhoto');
  attachDropzone($('#authorArtworkDrop'), $('#authorArtwork'), 'authorArtwork');

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  // ─── Progress bar (% of required fields filled) ────────────────────────
  function updateProgress(){
    const req = $$('[data-required]');
    let filled = 0;
    for (const f of req){
      const inp = $('input, textarea, select', f);
      if (!inp) continue;
      if (inp.type === 'radio'){
        const name = inp.name;
        const any = $$(`input[name="${CSS.escape(name)}"]:checked`).length > 0;
        if (any) filled++;
      } else if (inp.type === 'checkbox'){
        if (inp.checked) filled++;
      } else {
        if (String(inp.value || '').trim()) filled++;
      }
    }
    // also count guardian required consents (they're checkboxes, not data-required)
    const consents = ['consentPublish'];
    const consentReq = consents.length;
    const consentFilled = consents.filter(n => {
      const el = guardianForm.elements[n]; return el && el.checked;
    }).length;
    // story word floor counts as a unit if filled
    const totalReq = req.length + consentReq;
    const totalFilled = filled + consentFilled;
    const pct = totalReq ? Math.round((totalFilled / totalReq) * 100) : 0;
    const fill = $('#progressFill');
    if (fill) fill.style.width = pct + '%';
  }

  // ─── Wire up listeners ────────────────────────────────────────────────
  form.addEventListener('input',  () => { scheduleSave(); onStoryChange(); syncRadioCards(); });
  form.addEventListener('change', () => { scheduleSave(); onAgeChange(); onCreditAsChange(); syncRadioCards(); });
  guardianForm.addEventListener('input',  scheduleSave);
  guardianForm.addEventListener('change', () => { scheduleSave(); syncRadioCards(); });

  // Restore from localStorage on load
  restore();
  onAgeChange();
  onStoryChange();
  syncRadioCards();
  updateProgress();

  // Start button on welcome card just scrolls into the form
  const startBtn = $('#startBtn');
  if (startBtn) startBtn.addEventListener('click', () => {
    document.getElementById('start').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const topBtn = $('#topBtn');
  if (topBtn) topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  // Default consent date to today if empty
  const dateEl = $('#consentDate');
  if (dateEl && !dateEl.value){
    const t = new Date();
    dateEl.value = t.toISOString().slice(0, 10);
  }

  // ─── Validation ────────────────────────────────────────────────────────
  function validate(){
    const errors = [];
    let firstBadEl = null;

    function flag(fieldEl, msg){
      if (!fieldEl) return;
      fieldEl.classList.add('error');
      errors.push(msg);
      if (!firstBadEl){
        const inp = $('input, textarea', fieldEl);
        firstBadEl = inp || fieldEl;
      }
    }
    function ok(fieldEl){ if (fieldEl) fieldEl.classList.remove('error'); }

    // Clear previous errors
    for (const f of $$('.field.error')) f.classList.remove('error');

    // Required text-ish fields (matches REQUIRED_STR in import-submissions.js)
    const reqText = ['authorName','authorLocation','authorBio','storyTitle','story','inspiration'];
    for (const name of reqText){
      const el = form.elements[name];
      const fieldEl = el && el.closest('.field');
      const v = (el && el.value || '').trim();
      if (!v) flag(fieldEl, `${name} required`);
      else ok(fieldEl);
    }

    // Age
    const ageEl = $$('input[name=authorAge]:checked')[0];
    const ageField = $('[data-required] .agewheel') && $('[data-required] .agewheel').closest('.field');
    if (!ageEl){ flag(ageField, 'authorAge required'); }
    else if (parseInt(ageEl.value, 10) < 7 || parseInt(ageEl.value, 10) > 15){
      flag(ageField, 'authorAge must be 7-15');
    } else ok(ageField);

    // Story word count
    if (storyEl && wordCount(storyEl.value) < MIN_STORY_WORDS){
      flag(storyEl.closest('.field'), `story too short (< ${MIN_STORY_WORDS} words)`);
    }

    // creditAs + penName
    const creditEl = $$('input[name=creditAs]:checked')[0];
    const creditField = $$('input[name=creditAs]')[0] && $$('input[name=creditAs]')[0].closest('.field');
    if (!creditEl){ flag(creditField, 'creditAs required'); }
    else { ok(creditField); }
    if (creditEl && creditEl.value === 'pen'){
      const pen = $('#penName');
      const v = (pen && pen.value || '').trim();
      if (!v) flag(pen.closest('.field'), 'pen name required');
      else ok(pen.closest('.field'));
    }

    // childAssent
    const assentEl = $$('input[name=childAssent]:checked')[0];
    const assentField = $$('input[name=childAssent]')[0] && $$('input[name=childAssent]')[0].closest('.field');
    if (!assentEl){ flag(assentField, 'childAssent required'); }
    else if (assentEl.value === 'No'){
      flag(assentField, 'child did not assent (No)');
    } else ok(assentField);

    // Guardian required text + email
    const reqGuardian = ['guardianName','guardianRelation','guardianEmail','guardianPhone','guardianSignature','consentDate'];
    for (const name of reqGuardian){
      const el = guardianForm.elements[name];
      const fieldEl = el && el.closest('.field');
      const v = (el && el.value || '').trim();
      if (!v) flag(fieldEl, `${name} required`);
      else ok(fieldEl);
    }
    const emailEl = guardianForm.elements['guardianEmail'];
    if (emailEl && emailEl.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailEl.value)){
      flag(emailEl.closest('.field'), 'email looks invalid');
    }

    // Required consents (only consentPublish; consentVoice retired 2026-05-22).
    // Use a FRESH document.querySelector instead of guardianForm.elements[name]:
    // Cloudflare auto-inserts an obfuscated email link inside §IX's lede
    // paragraph (right above this form), and `email-decode.min.js` runs on
    // every page load. We could not pin down a precise mechanism, but in
    // practice the live closure's `guardianForm.elements['consentPublish']`
    // intermittently returns a stale/falsy reference at validate-time even
    // though `document.querySelector('input[name=consentPublish]')` returns
    // the live checked element. Fresh querySelector is the immune path.
    // (Verified 2026-05-22: same bug observed at every UI submit.)
    for (const name of ['consentPublish']){
      const el = document.querySelector(`input[name="${name}"]`);
      if (!el || !el.checked){
        errors.push(`${name} not ticked`);
        flag(el && el.closest('.field'), `${name} not ticked`);  // also flag visually
      }
    }

    return { ok: errors.length === 0, errors, firstBadEl };
  }

  // ─── Build the Tally-compatible payload ────────────────────────────────
  // Shape: { data: { fields: [{ label, value }, ...] } }
  // import-submissions.js / flattenSubmissions() handles this exact shape.
  function buildPayload(){
    const fields = [];
    function add(key, value){
      if (value == null || value === '') return;
      fields.push({ label: LABELS[key], key, value: sanitiseEmDashes(String(value)) });
    }

    // text + radios from form
    for (const key of [
      'authorName','authorLocation','authorBio','storyTitle','story',
      'languageNote','inspiration','behindTheStory',
      'qa_early_1','qa_early_2','qa_early_3',
      'qa_mid_1','qa_mid_2','qa_mid_3','qa_mid_4',
      'qa_up_1','qa_up_2','qa_up_3','qa_up_4',
      'funFavouriteWord','funHobby','funAdvice','funFavouriteBook','funThemeSong','funRandomFact',
      'artworkCaption','dedication','acknowledgements','editorNote','penName',
    ]){
      const el = form.elements[key];
      if (el && el.value) add(key, el.value);
    }
    // authorAge as integer string
    const ageEl = $$('input[name=authorAge]:checked')[0];
    if (ageEl) add('authorAge', ageEl.value);
    // hasChapters
    const chaptersEl = $$('input[name=hasChapters]:checked')[0];
    if (chaptersEl) add('hasChapters', chaptersEl.value);
    // creditAs , send long-form text so importer's substring match works
    const credit = $$('input[name=creditAs]:checked')[0];
    if (credit) add('creditAs', CREDIT_AS_LABEL[credit.value] || credit.value);
    // childAssent
    const assent = $$('input[name=childAssent]:checked')[0];
    if (assent) add('childAssent', assent.value);

    // guardian
    for (const key of ['guardianName','guardianRelation','guardianEmail','guardianPhone',
                       'guardianSignature','consentDate']){
      const el = guardianForm.elements[key];
      if (el && el.value) add(key, el.value);
    }
    // consent checkboxes , emit the long label text when ticked (mirrors
    // how a real Tally export reads them; the importer's isChecked() does
    // the heavy lifting either way). consentVoice retired 2026-05-22.
    for (const key of ['consentPublish','consentPhoto','consentLocation']){
      const el = guardianForm.elements[key];
      if (el && el.checked) add(key, LABELS[key]);
    }

    // hidden fields (book, channel, cohort, facilitator)
    for (const [k, v] of Object.entries(hidden)) if (v) add(k, v);

    return { data: { fields }, _client: { submittedAt: new Date().toISOString() } };
  }

  // ─── Submit ────────────────────────────────────────────────────────────
  guardianForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const submitBtn = $('#submitBtn');
    const submitError = $('#submitError');
    submitError.textContent = '';
    submitError.style.color = '';

    // honeypot trip , silently succeed (bots see "ok", real submission isn't sent)
    const hp = form.elements['website'];
    if (hp && hp.value){
      // pretend success without sending
      showThankyou('hp-' + Math.random().toString(36).slice(2, 8));
      return;
    }

    const v = validate();
    if (!v.ok){
      submitError.textContent = 'Some things need a second look , see the fields marked above.';
      submitError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (v.firstBadEl) try { v.firstBadEl.focus({ preventScroll: false }); } catch {}
      return;
    }

    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.textContent = 'Sending…';

    try {
      const payload = buildPayload();
      const body = new FormData();
      body.append('payload', JSON.stringify(payload));
      if (fileBlobs.authorPhoto)   body.append('authorPhoto',   fileBlobs.authorPhoto);
      if (fileBlobs.authorArtwork) body.append('authorArtwork', fileBlobs.authorArtwork);

      const res = await fetch('/api/submit', { method: 'POST', body });
      if (!res.ok){
        const t = await res.text().catch(() => '');
        throw new Error(t || `submission failed (${res.status})`);
      }
      const json = await res.json().catch(() => ({}));
      const ref = json.reference || ('BUK-' + Math.random().toString(36).slice(2, 8).toUpperCase());
      showThankyou(ref);
    } catch (err){
      submitBtn.removeAttribute('aria-busy');
      submitBtn.textContent = 'Send to Bukmuk →';
      submitError.textContent = 'Couldn\'t send right now. Your story is still saved in this browser. Please try again in a minute, or email hello@bukmuk.in.';
      submitError.style.color = 'var(--err)';
      setSaveTag('error', 'Submit failed; saved locally');
    }
  });

  function showThankyou(ref){
    submitted = true;
    // Detach the beforeunload guard immediately — at this point the data is
    // safely persisted to R2, the localStorage copy is about to be cleared,
    // and we never want to prompt the user after a successful submit.
    window.removeEventListener('beforeunload', beforeUnloadGuard);
    persist();          // last save (no-op after submitted=true, kept for symmetry)
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    document.querySelectorAll('.form-shell, .form-shell-guardian').forEach(el => el.classList.add('is-submitted'));
    const ty = $('#thankyou');
    if (ty) ty.classList.add('is-shown');
    const refEl = $('#refCode');
    if (refEl) refEl.textContent = ref;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Warn if leaving with unsaved data , prevents accidental tab-closes during
  // the long story textarea. Detached the instant we accept a submission.
  function beforeUnloadGuard(e){
    if (submitted) return;
    if (Object.keys(snapshot()).length === 0) return;
    e.preventDefault();
    e.returnValue = '';
  }
  window.addEventListener('beforeunload', beforeUnloadGuard);

})();
