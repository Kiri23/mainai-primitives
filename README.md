# mainai-primitives

Reusable primitives for building autonomous workflows with Claude CLI.

## Modules

- **`env`** — Platform detection (Termux, macOS, Linux), temp dir resolution
- **`claude_runner`** — Run `claude -p` with automatic TTY workaround on Termux
- **`mcp_config`** — Extract MCP server configs from `~/.claude.json`
- **`output_parser`** — Parse delimited blocks and markdown tables from Claude output

## Install

```bash
pip install mainai-primitives
```

## Quick Start

```python
from mainai_primitives import run_claude, ClaudeRunConfig, extract_mcp_config
from mainai_primitives import parse_delimited_block

# Set up MCP config for memorygraph
mcp_path = extract_mcp_config(["memorygraph"])

# Run Claude
config = ClaudeRunConfig(
    prompt="Score these articles...",
    mcp_config_path=mcp_path,
    allowed_tools=["Read", "Glob", "Grep"],
)
result = run_claude(config)

# Parse structured output
items = parse_delimited_block(
    result.output,
    start_marker="=== GO ITEMS ===",
    end_marker="=== END GO ITEMS ===",
    delimiter="|||",
    field_names=["score", "title", "author", "url", "reason"],
)
```

## Zero Runtime Dependencies

This package has no runtime dependencies beyond the Python standard library.

## License

MIT
