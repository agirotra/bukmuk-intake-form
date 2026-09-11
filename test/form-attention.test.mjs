/**
 * Pointing a guardian at what needs attention , contract test.
 *
 *   node --test test/form-attention.test.mjs
 *
 * On 2026-09-11 the story form, submitted with the agreement unticked, said
 * "Some things need a second look , see the fields marked above" and marked
 * nothing: the highlight only knew a .field box, and a tickbox row is not one.
 * Both forms had the same gap for both required tickboxes.
 *
 * What it is defending:
 *   , the message names what is missing, one by one, instead of pointing at
 *     "the fields marked above"
 *   , both pages load the shared helper before their own script, and both
 *     report through it, so the two forms cannot drift apart again
 *   , every required tickbox row has a name a parent recognises
 *   , a tickbox row has a red state to be marked with
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Loaded the way the browser loads it. With no document in the sandbox it
// registers no listeners, and the pure parts are what is tested here.
const ATT = (() => {
  const g = {};
  new Function('window', read('form-attention.js')
    .replace("typeof window !== 'undefined' ? window : this", 'arguments[0]'))(g);
  return g.BUKMUK_ATTENTION;
})();

describe('form-attention , the message', () => {
  test('names every missing answer', () => {
    assert.equal(ATT.summaryText(['Your name', 'The Young Author Agreement tick']),
      '2 things need your attention, marked in red: Your name; The Young Author Agreement tick.');
  });

  test('one thing reads as one thing', () => {
    assert.equal(ATT.summaryText(['Date']), 'One thing needs your attention, marked in red: Date.');
  });

  test('nothing missing says nothing', () => {
    assert.equal(ATT.summaryText([]), '');
  });

  test('carries no dashes, like every other text on the page', () => {
    assert.doesNotMatch(read('form-attention.js'), /[—–]/);
  });
});

describe('form-attention , both forms use it', () => {
  for (const [page, script] of [['index.html', 'intake.js'], ['consent.html', 'consent.js']]){
    test(`${page} loads it before ${script}`, () => {
      const html = read(page);
      const helper = html.indexOf('src="/form-attention.js');
      const own = html.indexOf(`src="/${script}`);
      assert.ok(helper > -1 && own > helper, `${script} calls it while validating`);
    });

    test(`${page}: every required tickbox row has a name a parent recognises`, () => {
      const html = read(page);
      for (const name of ['consentPublish', 'agreementAccepted']){
        const row = new RegExp(`<label data-attention-name="[^"]+">\\s*<input type="checkbox" name="${name}" required>`);
        assert.match(html, row, `${name} on ${page}`);
      }
    });

    test(`${script} reports through it`, () => {
      const js = read(script);
      assert.match(js, /(\w+)\s*=\s*window\.BUKMUK_ATTENTION;[\s\S]*?\b\1\.report\(\{/,
        'a failed validation marks, names and scrolls through the shared helper');
    });
  }

  test('a tickbox row has a red state', () => {
    assert.match(read('styles.css'), /\.consent label\.error\s*\{/);
  });
});
