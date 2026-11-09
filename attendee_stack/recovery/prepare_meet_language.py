"""Derive scoped language selection from the exact reviewed public Meet UI.

No browser, framework import, network, runtime write or bot. Keep the original;
unknown source or existing destination refuses rather than overwriting it.
"""
import hashlib
import json
from pathlib import Path
import sys

UPSTREAM_SHA = '260172214810776fbe1b32e2d698a18972d9fed5ad62263b2d9dd06d9ec4c7e5'
LANGUAGE_SCRIPT = r'''
const language = arguments[0], select = arguments[1];
if (typeof language !== 'string' || !language || language.length > 64 ||
    typeof select !== 'boolean') return false;
const visible = node => {
  if (!node.isConnected || !node.getClientRects().length ||
      node.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let parent = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.opacity === '0' ||
        ['hidden', 'collapse'].includes(style.visibility)) return false;
  }
  return true;
};
const dialogs = Array.from(document.querySelectorAll(
  '[role="dialog"][aria-modal="true"]')).filter(visible);
if (dialogs.length !== 1 || dialogs[0].getAttribute('aria-label') !== 'Settings') return false;
const lists = dialogs[0].querySelectorAll('ul[role="listbox"][aria-label="Meeting language"]');
if (lists.length !== 1 || lists[0].closest('[disabled], [aria-disabled="true"]')) return false;
const options = Array.from(lists[0].querySelectorAll('li[role="option"][data-value]'));
const targets = options.filter(option => option.getAttribute('data-value') === language);
if (targets.length !== 1 || targets[0].closest('[disabled], [aria-disabled="true"]')) return false;
const selected = options.filter(option => option.getAttribute('aria-selected') === 'true');
if (!select) return selected.length === 1 && selected[0] === targets[0];
if (selected.length !== 1 || selected[0] !== targets[0]) targets[0].click();
return true;
'''


def prepare(source, destination):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA:
        raise ValueError('Reviewed Meet UI source differs; preserve and inspect it')
    text = raw.decode('utf-8')
    anchor = 'logger = logging.getLogger(__name__)\n\n\n'
    if text.count(anchor) != 1:
        raise ValueError('Ambiguous language-script insertion point')
    text = text.replace(anchor, anchor + 'LCT_CAPTION_LANGUAGE_SCRIPT = r"""' + LANGUAGE_SCRIPT + '"""\n\n\n')
    start = text.index('    def select_language(')
    end = text.index('\n    def click_leave_button(', start)
    body = text[start:end]
    old = 'self.driver.execute_script("return clickLanguageOption(arguments[0]);", language)'
    if body.count(old) != 1:
        raise ValueError('Public language-selection call differs')
    body = body.replace(old, '''self.locate_element(
            step="language:select_option",
            condition=lambda driver: driver.execute_script(LCT_CAPTION_LANGUAGE_SCRIPT, language, True) is True,
            wait_time_seconds=6,
        )''')
    close = '        logger.info("Waiting for the close button")\n'
    if body.count(close) != 1:
        raise ValueError('Language confirmation point differs')
    confirmation = '''        self.locate_element(
            step="language:confirmed_option",
            condition=lambda driver: driver.execute_script(LCT_CAPTION_LANGUAGE_SCRIPT, language, False) is True,
            wait_time_seconds=6,
        )

'''
    body = body.replace(close, confirmation + close)
    old_selector = 'button[aria-label="Close dialog"], button[aria-label="Close dialogue"]'
    new_selector = ', '.join('[role="dialog"][aria-modal="true"][aria-label="Settings"] ' + selector
                             for selector in old_selector.split(', '))
    if body.count(old_selector) != 1:
        raise ValueError('Language close-control scope differs')
    body = body.replace(old_selector, new_selector)
    text = text[:start] + body + text[end:]
    compile(text, 'google_meet_ui_methods.py', 'exec')
    encoded = text.encode('utf-8')
    with Path(destination).open('xb') as stream:
        stream.write(encoded)
    return {'upstream_sha256': UPSTREAM_SHA, 'derived_sha256': hashlib.sha256(encoded).hexdigest(),
            'source_lines_before': len(raw.splitlines()), 'source_lines_after': len(encoded.splitlines()),
            'runtime_changed': False, 'bot_created': False}


if __name__ == '__main__':
    print(json.dumps(prepare(*sys.argv[1:])))
