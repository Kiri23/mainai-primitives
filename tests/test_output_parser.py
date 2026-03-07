"""Tests for output_parser module."""

from mainai_primitives.output_parser import extract_markdown_table, parse_delimited_block


class TestParseDelimitedBlock:
    def test_basic_parsing(self):
        text = """Some preamble text
=== GO ITEMS ===
7.5 ||| AI Agents 101 ||| Jane Smith ||| https://example.com/1 ||| Relevant to MainAI
6.2 ||| Building with Claude ||| Bob Lee ||| https://example.com/2 ||| Claude patterns
=== END GO ITEMS ===
Some trailing text"""

        items = parse_delimited_block(
            text,
            field_names=["score", "title", "author", "url", "reason"],
        )
        assert len(items) == 2
        assert items[0]["score"] == "7.5"
        assert items[0]["title"] == "AI Agents 101"
        assert items[0]["author"] == "Jane Smith"
        assert items[0]["url"] == "https://example.com/1"
        assert items[0]["reason"] == "Relevant to MainAI"
        assert items[1]["score"] == "6.2"

    def test_missing_optional_field(self):
        text = """=== GO ITEMS ===
7.5 ||| Title ||| Author ||| https://example.com
=== END GO ITEMS ==="""

        items = parse_delimited_block(
            text,
            field_names=["score", "title", "author", "url", "reason"],
        )
        assert len(items) == 1
        assert items[0]["reason"] == ""

    def test_no_match(self):
        items = parse_delimited_block("No markers here")
        assert items == []

    def test_empty_block(self):
        text = "=== GO ITEMS ===\n\n=== END GO ITEMS ==="
        items = parse_delimited_block(text)
        assert items == []

    def test_custom_markers(self):
        text = "---START---\na|||b\n---END---"
        items = parse_delimited_block(
            text,
            start_marker="---START---",
            end_marker="---END---",
            field_names=["x", "y"],
        )
        assert len(items) == 1
        assert items[0] == {"x": "a", "y": "b"}

    def test_no_field_names_uses_indices(self):
        text = "=== GO ITEMS ===\nfoo ||| bar ||| baz\n=== END GO ITEMS ==="
        items = parse_delimited_block(text)
        assert items[0] == {0: "foo", 1: "bar", 2: "baz"}

    def test_custom_delimiter(self):
        text = "=== GO ITEMS ===\na::b::c\n=== END GO ITEMS ==="
        items = parse_delimited_block(text, delimiter="::", field_names=["x", "y", "z"])
        assert items[0] == {"x": "a", "y": "b", "z": "c"}


class TestExtractMarkdownTable:
    def test_basic_table(self):
        text = """Some text before
| # | Score | Title |
|---|-------|-------|
| 1 | 7.5   | Foo   |
| 2 | 6.2   | Bar   |

Some text after"""

        table = extract_markdown_table(text)
        assert table is not None
        lines = table.split("\n")
        assert len(lines) == 4
        assert "| # |" in lines[0]

    def test_with_header_pattern(self):
        text = """| Other | Table |
|-------|-------|
| a     | b     |

| Score | Title |
|-------|-------|
| 7.5   | Foo   |"""

        table = extract_markdown_table(text, header_pattern="Score")
        assert table is not None
        assert "Score" in table
        assert "Other" not in table

    def test_no_table(self):
        assert extract_markdown_table("No table here") is None

    def test_single_row_table(self):
        text = "| A | B |\n|---|---|\n| 1 | 2 |"
        table = extract_markdown_table(text)
        assert table is not None
        assert table.count("\n") == 2
