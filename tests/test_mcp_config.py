"""Tests for mcp_config module."""

import json
import os
from pathlib import Path
from unittest.mock import patch

from mainai_primitives.mcp_config import extract_mcp_config


def _write_claude_json(tmp_path: Path, data: dict) -> Path:
    p = tmp_path / "claude.json"
    p.write_text(json.dumps(data))
    return p


class TestExtractMcpConfig:
    def test_extract_single_server(self, tmp_path):
        claude_json = _write_claude_json(tmp_path, {
            "mcpServers": {
                "memorygraph": {"url": "http://localhost:3000"},
                "other": {"url": "http://localhost:4000"},
            }
        })

        with patch("mainai_primitives.mcp_config.get_tmp_dir", return_value=tmp_path):
            result = extract_mcp_config(["memorygraph"], claude_json)

        assert result is not None
        data = json.loads(result.read_text())
        assert "memorygraph" in data["mcpServers"]
        assert "other" not in data["mcpServers"]
        os.unlink(result)

    def test_extract_all_servers(self, tmp_path):
        claude_json = _write_claude_json(tmp_path, {
            "mcpServers": {
                "a": {"url": "http://a"},
                "b": {"url": "http://b"},
            }
        })

        with patch("mainai_primitives.mcp_config.get_tmp_dir", return_value=tmp_path):
            result = extract_mcp_config(None, claude_json)

        assert result is not None
        data = json.loads(result.read_text())
        assert len(data["mcpServers"]) == 2
        os.unlink(result)

    def test_no_matching_server(self, tmp_path):
        claude_json = _write_claude_json(tmp_path, {
            "mcpServers": {"other": {"url": "http://x"}}
        })

        result = extract_mcp_config(["memorygraph"], claude_json)
        assert result is None

    def test_missing_file(self, tmp_path):
        result = extract_mcp_config(None, tmp_path / "nonexistent.json")
        assert result is None

    def test_empty_servers(self, tmp_path):
        claude_json = _write_claude_json(tmp_path, {"mcpServers": {}})
        result = extract_mcp_config(None, claude_json)
        assert result is None

    def test_no_mcp_servers_key(self, tmp_path):
        claude_json = _write_claude_json(tmp_path, {"something": "else"})
        result = extract_mcp_config(None, claude_json)
        assert result is None
