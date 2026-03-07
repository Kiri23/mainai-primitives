"""mainai-primitives: Reusable primitives for Claude CLI autonomous workflows."""

__version__ = "0.1.0"

from .claude_runner import ClaudeResult, ClaudeRunConfig, run_claude
from .env import Platform, detect_platform, get_tmp_dir, needs_tty_workaround
from .mcp_config import extract_mcp_config
from .output_parser import extract_markdown_table, parse_delimited_block

__all__ = [
    "ClaudeResult",
    "ClaudeRunConfig",
    "Platform",
    "detect_platform",
    "extract_markdown_table",
    "extract_mcp_config",
    "get_tmp_dir",
    "needs_tty_workaround",
    "parse_delimited_block",
    "run_claude",
]
