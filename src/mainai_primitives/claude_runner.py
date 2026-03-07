"""Run Claude CLI (claude -p) with platform-appropriate TTY handling."""

import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .env import Platform, detect_platform, get_tmp_dir, needs_tty_workaround


@dataclass
class ClaudeRunConfig:
    """Configuration for a Claude CLI invocation."""
    prompt: str
    mcp_config_path: Path | None = None
    plugin_dir: Path | None = None
    allowed_tools: list[str] = field(default_factory=list)
    verbose: bool = False


@dataclass
class ClaudeResult:
    """Result from a Claude CLI invocation."""
    output: str
    exit_code: int


def _build_claude_args(config: ClaudeRunConfig, *, chroot: bool = False) -> str:
    """Build the CLI arguments string for claude -p."""
    parts: list[str] = []

    if config.plugin_dir:
        if chroot:
            # Map ~/Code/X to /home/Code/X inside termux-chroot
            relative = config.plugin_dir.relative_to(Path.home())
            parts.append(f"--plugin-dir /home/{relative}")
        else:
            parts.append(f"--plugin-dir {config.plugin_dir}")

    if config.allowed_tools:
        tools = " ".join(config.allowed_tools)
        parts.append(f"--allowedTools {tools}")

    if config.mcp_config_path:
        if chroot:
            # $PREFIX/tmp/foo.json -> /tmp/foo.json inside chroot
            parts.append(f"--mcp-config /tmp/{config.mcp_config_path.name}")
        else:
            parts.append(f"--mcp-config {config.mcp_config_path}")

    return " ".join(parts)


def _run_termux(config: ClaudeRunConfig) -> ClaudeResult:
    """Run claude -p via termux-chroot with script pseudo-TTY workaround."""
    tmp_dir = get_tmp_dir()

    # Write prompt to temp file
    prompt_file = tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", prefix="claude-prompt-",
        dir=str(tmp_dir), delete=False,
    )
    prompt_file.write(config.prompt)
    prompt_file.close()

    # Result placeholder
    result_file = tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", prefix="claude-result-",
        dir=str(tmp_dir), delete=False,
    )
    result_file.close()

    prompt_name = Path(prompt_file.name).name
    result_name = Path(result_file.name).name
    claude_args = _build_claude_args(config, chroot=True)

    # Inner script for termux-chroot
    inner_file = tempfile.NamedTemporaryFile(
        mode="w", suffix=".sh", prefix="claude-inner-",
        dir=str(tmp_dir), delete=False,
    )
    inner_file.write(
        f'#!/bin/bash\n'
        f'cd /home\n'
        f'unset CLAUDECODE\n'
        f'claude -p "$(cat /tmp/{prompt_name})" {claude_args} > /tmp/{result_name} 2>&1\n'
    )
    inner_file.close()
    os.chmod(inner_file.name, 0o755)
    inner_name = Path(inner_file.name).name

    if config.verbose:
        import sys
        print(f"[claude_runner] Running claude -p ({len(config.prompt)} chars)...", file=sys.stderr)

    # Execute with pseudo-TTY + termux-chroot
    proc = subprocess.run(
        ["script", "-qc", f"termux-chroot bash /tmp/{inner_name}", "/dev/null"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Read result
    output = Path(result_file.name).read_text()
    output = output.replace("\r", "").strip()

    # Cleanup temp files
    for f in [prompt_file.name, result_file.name, inner_file.name]:
        try:
            os.unlink(f)
        except OSError:
            pass

    return ClaudeResult(output=output, exit_code=proc.returncode)


def _run_direct(config: ClaudeRunConfig) -> ClaudeResult:
    """Run claude -p directly via subprocess (Mac/Linux)."""
    cmd = ["claude", "-p", config.prompt]

    if config.plugin_dir:
        cmd.extend(["--plugin-dir", str(config.plugin_dir)])

    if config.allowed_tools:
        cmd.extend(["--allowedTools"] + config.allowed_tools)

    if config.mcp_config_path:
        cmd.extend(["--mcp-config", str(config.mcp_config_path)])

    if config.verbose:
        import sys
        print(f"[claude_runner] Running claude -p ({len(config.prompt)} chars)...", file=sys.stderr)

    proc = subprocess.run(cmd, capture_output=True, text=True)
    output = proc.stdout.strip()

    return ClaudeResult(output=output, exit_code=proc.returncode)


def run_claude(config: ClaudeRunConfig) -> ClaudeResult:
    """Run Claude CLI with the given configuration.

    Automatically selects the appropriate execution strategy:
    - Termux: Uses script + termux-chroot for TTY workaround
    - Mac/Linux: Direct subprocess execution
    """
    if needs_tty_workaround():
        return _run_termux(config)
    return _run_direct(config)
