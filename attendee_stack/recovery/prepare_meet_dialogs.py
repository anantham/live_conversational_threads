"""Derive a narrow dialog-readiness repair from the pinned public Meet UI source.

No runtime change, browser, network or persistence operation. The original source
is retained. An ambiguous, hidden, disabled or stale close control never qualifies.
"""
import hashlib
import json
from pathlib import Path
import sys

UPSTREAM_SHA = '9a050f26e7312589549a81e868b91c443fa0a57ccb8e71722f22afb89ad97d30'
ANCHOR = 'logger = logging.getLogger(__name__)\n\n\n'
HELPER = '''def visible_enabled_element(locator):
    """Selenium wait condition: one unambiguous, displayed and enabled match."""
    def ready(driver):
        matches = []
        for element in driver.find_elements(*locator):
            try:
                if element.is_displayed() and element.is_enabled():
                    matches.append(element)
            except StaleElementReferenceException:
                continue
        return matches[0] if len(matches) == 1 else False
    return ready


'''


def prepare(source, destination):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA:
        raise ValueError('Pinned Meet UI source differs; preserve and inspect it')
    text = raw.decode('utf-8')
    if text.count(ANCHOR) != 1:
        raise ValueError('Ambiguous helper insertion point')
    text = text.replace(ANCHOR, ANCHOR + HELPER)
    for method, step in [('attempt_to_turn_off_reactions', 'reactions'),
                         ('attempt_to_set_layout', 'layout'), ('select_language', 'language')]:
        start = text.index('    def ' + method + '(')
        end = text.find('\n    def ', start + 1)
        end = len(text) if end < 0 else end
        body = text[start:end]
        marker = '        close_button = self.locate_element('
        if body.count(marker) != 1:
            raise ValueError('Unexpected close-control implementation: ' + method)
        pos = body.index(marker)
        prefix, close = body[:pos], body[pos:]
        if close.count('EC.presence_of_element_located(') != 1:
            raise ValueError('Close-control wait differs: ' + method)
        close = close.replace('EC.presence_of_element_located(', 'visible_enabled_element(')
        close = close.replace('step="close_button_for_language_selection"', 'step="' + step + ':close_button"')
        close = close.replace('step="close_button"', 'step="' + step + ':close_button"')
        close = close.replace('self.click_element(close_button, "close_button")', 'self.click_element(close_button, "' + step + ':close_button")')
        text = text[:start] + prefix + close + text[end:]
    compile(text, 'google_meet_ui_methods.py', 'exec')
    output = Path(destination)
    if output.exists():
        raise ValueError('Preserve existing output')
    output.write_text(text)
    return {'upstream_sha256': UPSTREAM_SHA, 'derived_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'source_lines_before': len(raw.splitlines()), 'source_lines_after': len(text.splitlines()),
            'browser_started': False, 'runtime_changed': False}


if __name__ == '__main__':
    print(json.dumps(prepare(*sys.argv[1:])))
