"""Behavioral contract for mutable per-user runtime paths.

Test intent:
- production runtime state never defaults to a repository-relative path;
- Windows, macOS, and Linux use their conventional per-user data roots;
- an explicit registry override remains the highest-precedence contract.
"""

from pathlib import Path

from lct_python_backend.services.runtime_paths import (
    get_attendee_session_registry_path,
    get_user_data_directory,
)


def test_windows_user_data_directory_uses_local_app_data():
    root = get_user_data_directory(
        environ={"LOCALAPPDATA": r"D:\Profiles\Ada\AppData\Local"},
        platform_name="win32",
        home=Path(r"D:\Profiles\Ada"),
    )

    assert root == Path(r"D:\Profiles\Ada\AppData\Local") / "LCT"


def test_macos_user_data_directory_uses_application_support():
    root = get_user_data_directory(
        environ={}, platform_name="darwin", home=Path("/Users/ada")
    )

    assert root == Path("/Users/ada/Library/Application Support/LCT")


def test_linux_user_data_directory_prefers_xdg_data_home():
    root = get_user_data_directory(
        environ={"XDG_DATA_HOME": "/srv/ada/data"},
        platform_name="linux",
        home=Path("/home/ada"),
    )

    assert root == Path("/srv/ada/data/LCT")


def test_linux_user_data_directory_falls_back_to_dot_local_share():
    root = get_user_data_directory(
        environ={}, platform_name="linux", home=Path("/home/ada")
    )

    assert root == Path("/home/ada/.local/share/LCT")


def test_attendee_registry_override_has_highest_precedence(tmp_path):
    override = tmp_path / "explicit" / "registry.json"

    actual = get_attendee_session_registry_path(
        environ={
            "ATTENDEE_SESSION_REGISTRY_PATH": str(override),
            "LOCALAPPDATA": str(tmp_path / "ignored"),
        },
        platform_name="win32",
        home=tmp_path,
    )

    assert actual == override


def test_default_attendee_registry_is_below_user_data_directory(tmp_path):
    actual = get_attendee_session_registry_path(
        environ={"LOCALAPPDATA": str(tmp_path)},
        platform_name="win32",
        home=tmp_path,
    )

    assert actual == tmp_path / "LCT" / "data" / "attendee_sessions.json"
