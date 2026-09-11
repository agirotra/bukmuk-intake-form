/* Bukmuk , point a guardian at what still needs attention.
 *
 * Shared by both forms (index.html and consent.html), loaded before their own
 * script. Written 2026-09-11, after the editor tested the story form with the
 * agreement left unticked and got "Some things need a second look , see the
 * fields marked above" with nothing marked. The highlight only knew how to
 * mark a .field box, and a tickbox row is not one, so both required tickboxes
 * on both forms failed without a trace, and the page scrolled to the message
 * at the bottom instead of to the problem. On a nine-section form that sends a
 * parent hunting.
 *
 * So, in one place for both pages:
 *   , every missing answer is marked in red, a tickbox row included
 *   , the page scrolls to the FIRST one, in page order
 *   , the message names each one, so nobody has to search for them
 *   , the red clears the moment the answer is given
 *
 * House rule: zero em-dashes and en-dashes in anything here.
 */
(function (global) {
  'use strict';

  // What to mark red for an input: its .field box, or for a tickbox its row.
  function holderOf(el){
    if (!el || !el.closest) return null;
    return el.closest('.field') || el.closest('.consent label');
  }

  // The name a parent would recognise. A tickbox row carries it in
  // data-attention-name; a field uses its visible label, minus the
  // "required" tag.
  function nameOf(holder){
    if (!holder) return '';
    var given = holder.getAttribute && holder.getAttribute('data-attention-name');
    if (given) return given;
    var cap = holder.querySelector && holder.querySelector('label.cap');
    if (!cap) return '';
    var copy = cap.cloneNode(true);
    var tags = copy.querySelectorAll('.req');
    for (var i = 0; i < tags.length; i++) tags[i].parentNode.removeChild(tags[i]);
    return copy.textContent.replace(/\s+/g, ' ').trim();
  }

  // The sentence under the Send button. Pure, so a test can pin it.
  function summaryText(names){
    var n = names.length;
    if (!n) return '';
    var list = names.filter(Boolean);
    var head = n === 1 ? 'One thing needs your attention, marked in red'
                       : n + ' things need your attention, marked in red';
    return head + (list.length ? ': ' + list.join('; ') + '.' : '.');
  }

  // Unique holders, in the order they appear on the page.
  function inPageOrder(holders){
    var out = [];
    for (var i = 0; i < holders.length; i++){
      var h = holders[i];
      if (h && out.indexOf(h) === -1) out.push(h);
    }
    return out.sort(function (a, b) {
      if (a === b) return 0;
      return (a.compareDocumentPosition(b) & 4) ? -1 : 1;   // 4: b follows a
    });
  }

  // Mark, name, and take the parent to the first one.
  //   holders , elements to mark (use holderOf on an input)
  //   notes   , problems with no field to point at, said in words
  //   errorEl , the message line under the Send button
  function report(opts){
    var holders = inPageOrder((opts && opts.holders) || []);
    var notes = ((opts && opts.notes) || []).filter(Boolean);
    for (var i = 0; i < holders.length; i++) holders[i].classList.add('error');
    var text = [summaryText(holders.map(nameOf)), notes.join(' ')].filter(Boolean).join(' ')
      || 'Something needs a second look before we can send this.';
    if (opts && opts.errorEl) opts.errorEl.textContent = text;
    var first = holders[0];
    if (first){
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var inp = first.querySelector('input:not([type=hidden]), textarea, select');
      if (inp){ try { inp.focus({ preventScroll: true }); } catch (e) {} }
    } else if (opts && opts.errorEl){
      opts.errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return text;
  }

  // Clear the red the moment an answer is given, so whatever is still red is
  // exactly what is still to do.
  function clearIfAnswered(ev){
    var t = ev.target;
    var holder = holderOf(t);
    if (!holder || !holder.classList.contains('error')) return;
    var answered = t.type === 'checkbox' ? t.checked
                 : t.type === 'radio' ? true
                 : t.type === 'file' ? !!(t.files && t.files.length)
                 : !!String(t.value || '').trim();
    if (answered) holder.classList.remove('error');
  }
  if (global.document){
    global.document.addEventListener('input', clearIfAnswered, true);
    global.document.addEventListener('change', clearIfAnswered, true);
  }

  global.BUKMUK_ATTENTION = {
    holderOf: holderOf, nameOf: nameOf, summaryText: summaryText, report: report,
  };
})(typeof window !== 'undefined' ? window : this);
