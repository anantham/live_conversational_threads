"""Test intent: use actual public GoogleMeetUIMethods with a realistic WebDriver.

- Language, layout and reactions close only the one visible enabled control,
  even when a hidden duplicate appears first in DOM order.
- Stale and disabled candidates cannot hide a later usable control.
- Missing/hidden or ambiguous controls time out without clicking them.
- Opt-in first-failure diagnostics persist one synthetic snapshot; default stays off,
  and snapshot failure never replaces the original UI refusal.
- No browser, network, model, recording, database or provider write is performed.

Run inside the isolated recovery app: python test_meet_dialogs.py SOURCE_PATH.
The import root is asserted before Django setup. No real driver is constructed.
"""
import importlib.util
import os
from pathlib import Path
import sys
import unittest
import tempfile
from unittest.mock import patch

if os.environ.get('POSTGRES_DB') != 'lct_meet_recovery_20261017':
    raise RuntimeError('Refusing another persistence root before framework import')
import django
django.setup()
from selenium.common.exceptions import ElementNotInteractableException, StaleElementReferenceException
from bots.web_bot_adapter.ui_methods import UiCouldNotLocateElementException

SOURCE = Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location('bots.google_meet_bot_adapter.lct_dialog_test_source', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Control:
    def __init__(self, label, actions, displayed=True, enabled=True, stale=False):
        self.label, self.actions = label, actions
        self.displayed, self.enabled, self.stale = displayed, enabled, stale

    def is_displayed(self):
        if self.stale:
            raise StaleElementReferenceException('Synthetic detached control')
        return self.displayed

    def is_enabled(self):
        return self.enabled

    def click(self):
        if not self.is_displayed() or not self.is_enabled():
            raise ElementNotInteractableException('Synthetic non-interactable control')
        self.actions.append(self.label)


class Driver:
    """DOM-order search contract, including hidden/disabled close duplicates."""
    def __init__(self, candidates):
        self.actions = []
        self.close = [Control(name, self.actions, **flags) for name, flags in candidates]

    def find_elements(self, by, selector):
        if 'aria-label="Close' in selector:
            return self.close
        return [Control('menu-control', self.actions)]

    def find_element(self, by, selector):
        nodes = self.find_elements(by, selector)
        if not nodes:
            from selenium.common.exceptions import NoSuchElementException
            raise NoSuchElementException('Synthetic missing control')
        return nodes[0]

    def execute_script(self, script, *args):
        return True


class DialogReadinessTests(unittest.TestCase):
    def invoke(self, method, candidates):
        driver = Driver(candidates)
        ui = module.GoogleMeetUIMethods()
        ui.driver = driver
        if method == 'language':
            ui.select_language('en-US')
        elif method == 'layout':
            ui.attempt_to_set_layout('sidebar')
        else:
            ui.attempt_to_turn_off_reactions()
        return driver.actions

    def test_language_ignores_hidden_first_duplicate(self):
        actions = self.invoke('language', [('hidden-close', {'displayed': False}), ('active-close', {})])
        self.assertEqual([x for x in actions if x.endswith('close')], ['active-close'])

    def test_layout_ignores_hidden_first_duplicate(self):
        actions = self.invoke('layout', [('hidden-close', {'displayed': False}), ('active-close', {})])
        self.assertEqual([x for x in actions if x.endswith('close')], ['active-close'])

    def test_reactions_ignores_hidden_first_duplicate(self):
        actions = self.invoke('reactions', [('hidden-close', {'displayed': False}), ('active-close', {})])
        self.assertEqual([x for x in actions if x.endswith('close')], ['active-close'])

    def test_language_skips_stale_and_disabled_controls(self):
        actions = self.invoke('language', [('stale-close', {'stale': True}), ('disabled-close', {'enabled': False}), ('active-close', {})])
        self.assertEqual([x for x in actions if x.endswith('close')], ['active-close'])

    def test_hidden_close_refuses_without_click(self):
        driver = Driver([('hidden-close', {'displayed': False})])
        ui = module.GoogleMeetUIMethods(); ui.driver = driver
        with self.assertRaises(UiCouldNotLocateElementException):
            ui.select_language('en-US')
        self.assertNotIn('hidden-close', driver.actions)

    def test_ambiguous_visible_close_refuses_without_click(self):
        driver = Driver([('first-close', {}), ('second-close', {})])
        ui = module.GoogleMeetUIMethods(); ui.driver = driver
        with self.assertRaises(UiCouldNotLocateElementException):
            ui.select_language('en-US')
        self.assertFalse(any(x.endswith('close') for x in driver.actions))


class FirstFailureDiagnosticsTests(unittest.TestCase):
    def exercise(self, directory, flag=None, fail_snapshot=False):
        target = Path(directory) / 'snapshot.json'

        class UI(module.GoogleMeetUIMethods):
            driver = None
            def send_screenshot_and_mhtml_file_message(self):
                if fail_snapshot:
                    raise OSError('Synthetic storage failure')
                with target.open('a') as stream:
                    stream.write('snapshot\n')

        ui = UI()
        with patch.dict(os.environ, {'LCT_MEET_UI_DIAGNOSTICS': flag or ''}):
            for _ in range(2):
                with self.assertRaises(UiCouldNotLocateElementException):
                    ui.locate_element('video_button', lambda driver: False, wait_time_seconds=0)
        return target.read_text().splitlines() if target.exists() else []

    def test_first_failure_persists_only_one_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.exercise(directory, 'first-failure'), ['snapshot'])

    def test_diagnostics_remain_off_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.exercise(directory), [])

    def test_snapshot_failure_preserves_original_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.exercise(directory, 'first-failure', fail_snapshot=True), [])


if __name__ == '__main__':
    unittest.main()
