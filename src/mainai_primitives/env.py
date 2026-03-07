"""Platform detection and environment utilities."""

import os
import sys
import tempfile
from enum import Enum
from pathlib import Path


class Platform(Enum):
    TERMUX = "termux"
    LINUX = "linux"
    MACOS = "macos"


def detect_platform() -> Platform:
    """Detect the current platform."""
    prefix = os.environ.get("PREFIX", "")
    if "com.termux" in prefix:
        return Platform.TERMUX
    if sys.platform == "darwin":
        return Platform.MACOS
    return Platform.LINUX


def get_tmp_dir() -> Path:
    """Return the appropriate temp directory for the current platform.

    On Termux, uses $PREFIX/tmp (required for termux-chroot path mapping).
    On other platforms, uses the system temp directory.
    """
    if detect_platform() == Platform.TERMUX:
        return Path(os.environ["PREFIX"]) / "tmp"
    return Path(tempfile.gettempdir())


def get_secondbrain_path() -> Path:
    """Return the path to the Obsidian Secondbrain vault for the current platform.

    - Termux (Pixel): ~/storage/documents/Secondbrain
    - macOS (Mac): ~/Documents/Secondbrain
    - Linux (VPS): ~/Code/Secondbrain
    """
    home = Path.home()
    platform = detect_platform()
    if platform == Platform.TERMUX:
        return home / "storage" / "documents" / "Secondbrain"
    if platform == Platform.MACOS:
        return home / "Documents" / "Secondbrain"
    return home / "Code" / "Secondbrain"


def needs_tty_workaround() -> bool:
    """Whether the current platform needs the script/termux-chroot TTY workaround."""
    return detect_platform() == Platform.TERMUX
