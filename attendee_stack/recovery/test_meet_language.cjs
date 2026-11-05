// Intent: tests/intent/meet-language-scope.md. Authored DOM only; no browser/network.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const appRequire = createRequire(path.join(__dirname, '../../lct_app/package.json'));
const { JSDOM } = appRequire('jsdom');
const baseline = process.env.LCT_MEET_LANGUAGE_BASELINE === '1';
let script;
if (baseline) {
  const raw = readFileSync(process.env.LCT_MEET_PAYLOAD_SOURCE);
  assert.equal(createHash('sha256').update(raw).digest('hex'), '18d1d59242bbe7089b157e008a1cd343aa40b590c29f1cd932b928f9f4934d50');
  const source = raw.toString();
  const start = source.indexOf('function clickLanguageOption(');
  const end = source.indexOf('\nasync function turnOnCamera()', start);
  assert.ok(start >= 0 && end > start, 'Pinned public helper boundaries must exist');
  script = source.slice(start, end) + '\nreturn clickLanguageOption(arguments[0]);';
} else {
  const generated = spawnSync('python3', ['-c',
    'from prepare_meet_language import LANGUAGE_SCRIPT; print(LANGUAGE_SCRIPT)'],
  { cwd: __dirname, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  script = generated.stdout;
}

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <ul role="listbox" aria-label="Meeting language" id="outside-list">
      <li role="option" data-value="en-US" aria-selected="true" id="outside">English</li>
    </ul>
    <div role="dialog" aria-label="Settings" aria-modal="true" id="settings">
      <button aria-label="Close dialog" id="close">Close</button>
      <ul role="listbox" aria-label="Meeting language" id="owned-list">
        <li role="option" data-value="fr-FR" aria-selected="true">French</li>
        <li role="option" data-value="en-US" aria-selected="false" id="owned">English</li>
      </ul>
    </div></body>`, { runScripts: 'outside-only' });
  const { document, HTMLElement } = dom.window;
  // jsdom has no layout; connected fixture controls have a box unless a case
  // explicitly removes it. CSS/hidden/aria-hidden checks still use the real DOM.
  HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{}] : []; };
  const actions = [];
  document.getElementById('outside').addEventListener('click', () => {
    actions.push('outside'); document.getElementById('settings').style.display = 'none';
  });
  document.getElementById('owned').addEventListener('click', event => {
    actions.push('owned');
    if (event.target.dataset.ignore !== 'true') {
      for (const option of document.querySelectorAll('#owned-list [role="option"]'))
        option.setAttribute('aria-selected', String(option === event.target));
    }
  });
  return { dom, document, actions,
    run: (select, language = 'en-US') => dom.window.eval(
      `(function(){${script}\n}).apply(null, ${JSON.stringify([language, select])})`) };
}
function check(name, body) {
  test(name, () => { const state = fixture(); try { body(state); } finally { state.dom.window.close(); } });
}

check('selection changes only the owning Settings list and confirmation is read-only', state => {
  assert.equal(state.run(false), false);
  assert.deepEqual(state.actions, []);
  assert.equal(state.run(true), true);
  assert.deepEqual(state.actions, ['owned']);
  assert.equal(state.document.querySelector('#outside').getAttribute('aria-selected'), 'true');
  assert.notEqual(state.document.querySelector('#settings').style.display, 'none');
  assert.equal(state.run(false), true);
  assert.deepEqual(state.actions, ['owned']);
});
check('an already selected exact setting needs no additional click', state => {
  state.document.querySelector('#owned').setAttribute('aria-selected', 'true');
  state.document.querySelector('#owned-list [data-value="fr-FR"]').setAttribute('aria-selected', 'false');
  assert.equal(state.run(true), true);
  assert.equal(state.run(false), true);
  assert.deepEqual(state.actions, []);
});
check('a click which is ignored never confirms selection', state => {
  state.document.querySelector('#owned').dataset.ignore = 'true';
  assert.equal(state.run(true), true);
  assert.equal(state.run(false), false);
  assert.deepEqual(state.actions, ['owned']);
});
for (const [name, alter] of [
  ['missing dialog', state => state.document.querySelector('#settings').remove()],
  ['hidden dialog', state => state.document.querySelector('#settings').hidden = true],
  ['CSS-hidden dialog', state => state.document.querySelector('#settings').style.display = 'none'],
  ['transparent dialog', state => state.document.querySelector('#settings').style.opacity = '0'],
  ['aria-hidden dialog', state => state.document.querySelector('#settings').setAttribute('aria-hidden', 'true')],
  ['zero-box dialog', state => state.document.querySelector('#settings').getClientRects = () => []],
  ['multiple visible Settings dialogs', state => state.document.body.append(state.document.querySelector('#settings').cloneNode(true))],
  ['another active modal', state => {
    const other = state.document.createElement('div');
    other.setAttribute('role', 'dialog'); other.setAttribute('aria-modal', 'true');
    other.setAttribute('aria-label', 'Other settings'); state.document.body.append(other);
  }],
  ['wrong owning dialog', state => state.document.querySelector('#settings').setAttribute('aria-label', 'Other settings')],
  ['missing owned language list', state => state.document.querySelector('#owned-list').remove()],
  ['multiple owned language lists', state => state.document.querySelector('#settings').append(state.document.querySelector('#owned-list').cloneNode(true))],
  ['missing target', state => state.document.querySelector('#owned').remove()],
  ['multiple target options', state => state.document.querySelector('#owned-list').append(state.document.querySelector('#owned').cloneNode(true))],
  ['disabled target', state => state.document.querySelector('#owned').setAttribute('aria-disabled', 'true')],
  ['disabled list', state => state.document.querySelector('#owned-list').setAttribute('aria-disabled', 'true')],
]) check(name + ' refuses without an unrelated click', state => {
  alter(state); assert.equal(state.run(true), false); assert.equal(state.run(false), false);
  assert.deepEqual(state.actions, []);
});
check('hidden duplicate dialog cannot shadow the active owner', state => {
  const copy = state.document.querySelector('#settings').cloneNode(true); copy.hidden = true;
  state.document.body.prepend(copy);
  assert.equal(state.run(true), true); assert.equal(state.run(false), true);
  assert.deepEqual(state.actions, ['owned']);
});
check('multiple selected values cannot confirm the requested one', state => {
  state.document.querySelector('#owned').setAttribute('aria-selected', 'true');
  assert.equal(state.run(false), false); assert.deepEqual(state.actions, []);
});
check('language text is compared as a value, never injected as a selector', state => {
  assert.equal(state.run(true, 'en-US"], body, li[data-value="fr-FR'), false);
  assert.deepEqual(state.actions, []);
});

if (baseline) check('instrument: actual old helper clicks outside Settings and still reports true', state => {
  assert.equal(state.run(true), true); assert.deepEqual(state.actions, ['outside']);
  assert.equal(state.document.querySelector('#settings').style.display, 'none');
});
