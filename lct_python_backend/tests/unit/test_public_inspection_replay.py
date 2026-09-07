"""Test intent: public diagnostic cannot accept an unverified input or silently
replace a replay with altered IDs, timing, speaker attribution or source text.
"""
from types import SimpleNamespace

import pytest

from tools.replay_public_source_inspection import FIELDS, verified_public_source, verify_rows


def test_unrecognized_input_fails_before_database_or_inference(tmp_path):
    path = tmp_path / 'not-public.threads'
    path.write_text('{}')
    with pytest.raises(ValueError, match='exact authorized public'):
        verified_public_source(path)


@pytest.mark.parametrize('field', FIELDS)
def test_existing_source_mismatch_is_not_overwritten(field):
    source = dict.fromkeys(FIELDS)
    source['id'] = 'known-public-id'
    row = SimpleNamespace(**source)
    verify_rows([row], [source])
    setattr(row, field, 'changed-value')
    with pytest.raises(ValueError, match='no overwrite permitted'):
        verify_rows([row], [source])
