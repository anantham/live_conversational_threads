"""Intent: tests/intent/meet-language-scope.md.

Run with the exact public reviewed UI source path. Generator guards use isolated
temporary files. Public select_language/locate/click methods run unchanged from
their actual AST with a one-poll WebDriver contract; this is not an Asus/Django
or real Selenium/browser result. Real DOM script effects are tested separately.
"""
import ast
import hashlib
import logging
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from prepare_meet_language import prepare, UPSTREAM_SHA

SOURCE = Path(sys.argv.pop(1)).read_bytes()
if hashlib.sha256(SOURCE).hexdigest() != UPSTREAM_SHA:
    raise RuntimeError('Refusing unexpected public source before any derivation')


class Refused(Exception):
    pass


class Control:
    def __init__(self, label, actions):
        self.label, self.actions = label, actions

    def is_displayed(self):
        return True

    def is_enabled(self):
        return True

    def click(self):
        self.actions.append(self.label)


class Driver:
    def __init__(self, selection=True, confirmation=True):
        self.actions, self.requests = [], []
        self.selection, self.confirmation = selection, confirmation

    def find_element(self, by, selector):
        return Control('menu', self.actions)

    def find_elements(self, by, selector):
        if '[role="dialog"][aria-modal="true"][aria-label="Settings"]' in selector:
            return [Control('owned-close', self.actions)]
        return [Control('global-close', self.actions)]

    def execute_script(self, script, language, *mode):
        self.requests.append((language, mode))
        return self.selection if not mode or mode[0] else self.confirmation


class OnePollWait:
    def __init__(self, driver, timeout):
        self.driver = driver

    def until(self, condition):
        value = condition(self.driver)
        if not value:
            raise TimeoutError('Synthetic unmet public WebDriver condition')
        return value


def public_ui(source):
    parsed = ast.parse(source)
    original = next(node for node in parsed.body if isinstance(node, ast.ClassDef) and node.name == 'GoogleMeetUIMethods')
    methods = [node for node in original.body if isinstance(node, ast.FunctionDef)
               and node.name in ('select_language', 'locate_element', 'click_element')]
    helper = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == 'visible_enabled_element')
    constants = [node for node in parsed.body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == 'LCT_CAPTION_LANGUAGE_SCRIPT' for target in node.targets)]
    cls = ast.ClassDef(name='GoogleMeetUIMethods', bases=[], keywords=[], body=methods, decorator_list=[])
    selected = ast.fix_missing_locations(ast.Module(body=constants + [helper, cls], type_ignores=[]))
    namespace = dict(logger=logging.getLogger('synthetic-meet-language'), os=os,
                     By=types.SimpleNamespace(CSS_SELECTOR='css selector', XPATH='xpath'),
                     EC=types.SimpleNamespace(presence_of_element_located=lambda locator: lambda driver: driver.find_element(*locator)),
                     WebDriverWait=OnePollWait, UiCouldNotLocateElementException=Refused,
                     UiCouldNotClickElementException=Refused, StaleElementReferenceException=Refused)
    exec(compile(selected, '<actual-public-meet-ui-methods>', 'exec'), namespace)
    return namespace['GoogleMeetUIMethods']


class MeetLanguagePreparationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='lct-meet-language-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source, self.output = self.root / 'original.py', self.root / 'derived.py'
        self.source.write_bytes(SOURCE)
        self.receipt = prepare(self.source, self.output)
        self.proposed = self.output.read_bytes()

    def invoke(self, source, selection=True, confirmation=True):
        driver = Driver(selection, confirmation)
        ui = public_ui(source)(); ui.driver = driver
        with patch.dict(os.environ, {'LCT_MEET_UI_DIAGNOSTICS': ''}):
            ui.select_language('en-US')
        return driver

    def test_original_source_is_preserved_and_other_public_methods_are_identical(self):
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(hashlib.sha256(self.proposed).hexdigest(), self.receipt['derived_sha256'])
        self.assertFalse(self.receipt['runtime_changed'])
        old, new = ast.parse(SOURCE), ast.parse(self.proposed)
        def unchanged(tree):
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'GoogleMeetUIMethods')
            return {node.name: ast.dump(node) for node in cls.body if isinstance(node, ast.FunctionDef) and node.name != 'select_language'}
        self.assertEqual(unchanged(old), unchanged(new))

    def test_unknown_source_refuses_without_output(self):
        unknown, output = self.root / 'unknown.py', self.root / 'never.py'
        unknown.write_bytes(SOURCE + b'\n')
        with self.assertRaisesRegex(ValueError, 'source differs'):
            prepare(unknown, output)
        self.assertFalse(output.exists())

    def test_existing_output_is_preserved(self):
        with self.assertRaises(FileExistsError):
            prepare(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), self.proposed)

    def test_baseline_accepts_an_unconfirmed_click_and_closes_globally(self):
        driver = self.invoke(SOURCE, confirmation=False)
        self.assertIn('global-close', driver.actions)

    def test_confirmed_configuration_closes_only_its_own_settings(self):
        driver = self.invoke(self.proposed)
        self.assertEqual([action for action in driver.actions if action.endswith('close')], ['owned-close'])

    def test_unconfirmed_selection_refuses_without_closing(self):
        driver = Driver(confirmation=False)
        ui = public_ui(self.proposed)(); ui.driver = driver
        with patch.dict(os.environ, {'LCT_MEET_UI_DIAGNOSTICS': ''}):
            with self.assertRaises(Refused): ui.select_language('en-US')
        self.assertFalse(any(action.endswith('close') for action in driver.actions))

    def test_non_boolean_confirmation_refuses_without_closing(self):
        driver = Driver(confirmation={'selected': True})
        ui = public_ui(self.proposed)(); ui.driver = driver
        with patch.dict(os.environ, {'LCT_MEET_UI_DIAGNOSTICS': ''}):
            with self.assertRaises(Refused): ui.select_language('en-US')
        self.assertFalse(any(action.endswith('close') for action in driver.actions))

    def test_missing_language_option_refuses_without_closing(self):
        driver = Driver(selection=False)
        ui = public_ui(self.proposed)(); ui.driver = driver
        with self.assertRaises(Refused): ui.select_language('en-US')
        self.assertFalse(any(action.endswith('close') for action in driver.actions))


if __name__ == '__main__':
    unittest.main()
