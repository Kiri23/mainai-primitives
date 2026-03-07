"""Tests for claude_runner module."""

from pathlib import Path
from unittest.mock import MagicMock, patch

from mainai_primitives.claude_runner import (
    ClaudeResult,
    ClaudeRunConfig,
    _build_claude_args,
    _run_direct,
)


class TestClaudeRunConfig:
    def test_defaults(self):
        config = ClaudeRunConfig(prompt="hello")
        assert config.prompt == "hello"
        assert config.mcp_config_path is None
        assert config.plugin_dir is None
        assert config.allowed_tools == []
        assert config.verbose is False


class TestBuildClaudeArgs:
    def test_empty_config(self):
        config = ClaudeRunConfig(prompt="test")
        assert _build_claude_args(config) == ""

    def test_with_plugin_dir(self):
        config = ClaudeRunConfig(prompt="test", plugin_dir=Path("/home/user/plugins"))
        args = _build_claude_args(config)
        assert "--plugin-dir /home/user/plugins" in args

    def test_with_allowed_tools(self):
        config = ClaudeRunConfig(prompt="test", allowed_tools=["Read", "Glob"])
        args = _build_claude_args(config)
        assert "--allowedTools Read Glob" in args

    def test_with_mcp_config(self):
        config = ClaudeRunConfig(prompt="test", mcp_config_path=Path("/tmp/mcp.json"))
        args = _build_claude_args(config)
        assert "--mcp-config /tmp/mcp.json" in args

    def test_chroot_path_mapping(self):
        home = Path.home()
        config = ClaudeRunConfig(
            prompt="test",
            plugin_dir=home / "Code" / "MyClaudeSkills",
            mcp_config_path=Path("/data/data/com.termux/files/usr/tmp/mcp.json"),
        )
        args = _build_claude_args(config, chroot=True)
        assert "--plugin-dir /home/Code/MyClaudeSkills" in args
        assert "--mcp-config /tmp/mcp.json" in args


class TestRunDirect:
    def test_basic_run(self):
        mock_proc = MagicMock()
        mock_proc.stdout = "Hello from Claude"
        mock_proc.returncode = 0

        config = ClaudeRunConfig(prompt="test prompt")
        with patch("mainai_primitives.claude_runner.subprocess.run", return_value=mock_proc) as mock_run:
            result = _run_direct(config)

        assert result.output == "Hello from Claude"
        assert result.exit_code == 0
        call_args = mock_run.call_args
        assert call_args[0][0] == ["claude", "-p", "test prompt"]

    def test_with_all_options(self):
        mock_proc = MagicMock()
        mock_proc.stdout = "result"
        mock_proc.returncode = 0

        config = ClaudeRunConfig(
            prompt="test",
            plugin_dir=Path("/plugins"),
            allowed_tools=["Read", "Grep"],
            mcp_config_path=Path("/tmp/mcp.json"),
        )
        with patch("mainai_primitives.claude_runner.subprocess.run", return_value=mock_proc) as mock_run:
            _run_direct(config)

        cmd = mock_run.call_args[0][0]
        assert "--plugin-dir" in cmd
        assert "/plugins" in cmd
        assert "--allowedTools" in cmd
        assert "Read" in cmd
        assert "Grep" in cmd
        assert "--mcp-config" in cmd
        assert "/tmp/mcp.json" in cmd
