"""Extract MCP server configurations from ~/.claude.json."""

import json
import tempfile
from pathlib import Path

from .env import get_tmp_dir


def extract_mcp_config(
    server_names: list[str] | None = None,
    claude_json_path: Path | None = None,
) -> Path | None:
    """Extract MCP server configs into a temporary JSON file.

    Args:
        server_names: Server names to extract. None means all servers.
        claude_json_path: Path to claude.json. Defaults to ~/.claude.json.

    Returns:
        Path to temp file containing the extracted config, or None if no
        matching servers were found.
    """
    if claude_json_path is None:
        claude_json_path = Path.home() / ".claude.json"

    if not claude_json_path.exists():
        return None

    with open(claude_json_path) as f:
        config = json.load(f)

    all_servers = config.get("mcpServers", {})
    if not all_servers:
        return None

    if server_names is None:
        selected = all_servers
    else:
        selected = {k: v for k, v in all_servers.items() if k in server_names}

    if not selected:
        return None

    mcp_config = {"mcpServers": selected}
    tmp_dir = get_tmp_dir()
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix="mcp-config-",
        dir=str(tmp_dir), delete=False,
    )
    json.dump(mcp_config, tmp)
    tmp.close()
    return Path(tmp.name)
