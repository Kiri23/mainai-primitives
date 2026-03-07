"""Tests for env module."""

import tempfile
from unittest.mock import patch

from mainai_primitives.env import Platform, detect_platform, get_tmp_dir, needs_tty_workaround


class TestDetectPlatform:
    def test_termux(self):
        with patch.dict("os.environ", {"PREFIX": "/data/data/com.termux/files/usr"}):
            assert detect_platform() == Platform.TERMUX

    def test_macos(self):
        with patch.dict("os.environ", {"PREFIX": ""}, clear=False):
            with patch("mainai_primitives.env.sys") as mock_sys:
                mock_sys.platform = "darwin"
                assert detect_platform() == Platform.MACOS

    def test_linux(self):
        with patch.dict("os.environ", {"PREFIX": ""}, clear=False):
            with patch("mainai_primitives.env.sys") as mock_sys:
                mock_sys.platform = "linux"
                assert detect_platform() == Platform.LINUX

    def test_no_prefix(self):
        with patch.dict("os.environ", {}, clear=True):
            with patch("mainai_primitives.env.sys") as mock_sys:
                mock_sys.platform = "linux"
                assert detect_platform() == Platform.LINUX


class TestGetTmpDir:
    def test_termux_uses_prefix_tmp(self):
        with patch("mainai_primitives.env.detect_platform", return_value=Platform.TERMUX):
            with patch.dict("os.environ", {"PREFIX": "/data/data/com.termux/files/usr"}):
                result = get_tmp_dir()
                assert str(result) == "/data/data/com.termux/files/usr/tmp"

    def test_non_termux_uses_system_tmp(self):
        with patch("mainai_primitives.env.detect_platform", return_value=Platform.LINUX):
            result = get_tmp_dir()
            assert result.exists()


class TestNeedsTtyWorkaround:
    def test_true_on_termux(self):
        with patch("mainai_primitives.env.detect_platform", return_value=Platform.TERMUX):
            assert needs_tty_workaround() is True

    def test_false_on_mac(self):
        with patch("mainai_primitives.env.detect_platform", return_value=Platform.MACOS):
            assert needs_tty_workaround() is False

    def test_false_on_linux(self):
        with patch("mainai_primitives.env.detect_platform", return_value=Platform.LINUX):
            assert needs_tty_workaround() is False
