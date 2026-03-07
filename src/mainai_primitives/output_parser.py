"""Parse structured output from Claude CLI responses."""

import re


def parse_delimited_block(
    text: str,
    start_marker: str = "=== GO ITEMS ===",
    end_marker: str = "=== END GO ITEMS ===",
    delimiter: str = "|||",
    field_names: list[str] | None = None,
) -> list[dict]:
    """Extract and parse a delimited block from Claude's output.

    Finds text between start_marker and end_marker, splits each line by
    delimiter, and returns a list of dicts keyed by field_names (or
    integer indices if field_names is None).
    """
    pattern = re.escape(start_marker) + r"(.*?)" + re.escape(end_marker)
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        return []

    items = []
    for line in match.group(1).strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(delimiter)]
        if not parts or not parts[0]:
            continue

        if field_names:
            item = {}
            for i, name in enumerate(field_names):
                item[name] = parts[i] if i < len(parts) else ""
            items.append(item)
        else:
            item = {i: p for i, p in enumerate(parts)}
            items.append(item)

    return items


def extract_markdown_table(text: str, header_pattern: str | None = None) -> str | None:
    """Extract a markdown table from Claude's output.

    If header_pattern is given, looks for a table whose header line contains
    that pattern. Otherwise, returns the first markdown table found.
    """
    lines = text.split("\n")
    table_lines: list[str] = []
    in_table = False

    for line in lines:
        stripped = line.strip()
        if not in_table:
            if stripped.startswith("|"):
                if header_pattern is None or header_pattern in stripped:
                    in_table = True
                    table_lines.append(line)
        else:
            if stripped.startswith("|"):
                table_lines.append(line)
            elif table_lines:
                break

    return "\n".join(table_lines) if table_lines else None
