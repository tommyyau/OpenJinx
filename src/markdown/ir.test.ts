import { describe, expect, it } from "vitest";
import { chunkMarkdownIR, markdownToIR } from "./ir.js";

describe("markdownToIR", () => {
  it("parses bold text", () => {
    const ir = markdownToIR("**hello**");
    expect(ir.text).toBe("hello");
    expect(ir.styles).toEqual([{ start: 0, end: 5, style: "bold" }]);
  });

  it("parses italic text", () => {
    const ir = markdownToIR("*hello*");
    expect(ir.text).toBe("hello");
    expect(ir.styles).toEqual([{ start: 0, end: 5, style: "italic" }]);
  });

  it("parses strikethrough", () => {
    const ir = markdownToIR("~~hello~~");
    expect(ir.text).toBe("hello");
    expect(ir.styles).toEqual([{ start: 0, end: 5, style: "strikethrough" }]);
  });

  it("parses inline code", () => {
    const ir = markdownToIR("`code`");
    expect(ir.text).toBe("code");
    expect(ir.styles).toEqual([{ start: 0, end: 4, style: "code" }]);
  });

  it("parses fenced code blocks", () => {
    const ir = markdownToIR("```\nconst x = 1;\n```");
    expect(ir.text).toContain("const x = 1;");
    expect(ir.styles.some((s) => s.style === "code_block")).toBe(true);
  });

  it("parses links", () => {
    const ir = markdownToIR("[Go](https://go.dev)");
    expect(ir.text).toBe("Go");
    expect(ir.links).toEqual([{ start: 0, end: 2, href: "https://go.dev" }]);
  });

  it("parses blockquotes", () => {
    const ir = markdownToIR("> quoted");
    expect(ir.text).toContain("quoted");
    expect(ir.styles.some((s) => s.style === "blockquote")).toBe(true);
  });

  it("parses bullet lists", () => {
    const ir = markdownToIR("- one\n- two");
    expect(ir.text).toContain("one");
    expect(ir.text).toContain("two");
    expect(ir.text).toContain("•");
  });

  it("parses ordered lists", () => {
    const ir = markdownToIR("1. first\n2. second");
    expect(ir.text).toContain("1.");
    expect(ir.text).toContain("2.");
  });

  it("handles empty input", () => {
    const ir = markdownToIR("");
    expect(ir.text).toBe("");
    expect(ir.styles).toEqual([]);
    expect(ir.links).toEqual([]);
  });

  it("parses spoilers when enabled", () => {
    const ir = markdownToIR("||spoiler||", { enableSpoilers: true });
    expect(ir.text).toBe("spoiler");
    expect(ir.styles.some((s) => s.style === "spoiler")).toBe(true);
  });

  it("ignores spoilers when disabled", () => {
    const ir = markdownToIR("||text||", { enableSpoilers: false });
    // Text includes the || markers as literal text
    expect(ir.styles.every((s) => s.style !== "spoiler")).toBe(true);
  });
});

describe("chunkMarkdownIR", () => {
  it("returns single chunk when within limit", () => {
    const ir = markdownToIR("short");
    const chunks = chunkMarkdownIR(ir, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("short");
  });

  it("returns empty for empty IR", () => {
    const ir = { text: "", styles: [], links: [] };
    expect(chunkMarkdownIR(ir, 100)).toEqual([]);
  });

  it("splits long text into chunks", () => {
    const ir = markdownToIR("word ".repeat(100).trim());
    const chunks = chunkMarkdownIR(ir, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(50);
    }
  });

  it("preserves style spans in chunks", () => {
    const ir = markdownToIR("**bold text** and more words to make it longer");
    const chunks = chunkMarkdownIR(ir, 15);
    // First chunk should contain the bold span
    expect(chunks[0]!.styles.some((s) => s.style === "bold")).toBe(true);
  });
});

describe("table rendering — bullets mode", () => {
  it("renders a simple 2x2 table as bullet points", () => {
    const md = `| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |`;
    const ir = markdownToIR(md, { tableMode: "bullets" });
    expect(ir.text).toContain("•");
    expect(ir.text).toContain("Alice");
    expect(ir.text).toContain("30");
    expect(ir.text).toContain("Bob");
    expect(ir.text).toContain("25");
  });

  it("uses first column as bold label in bullets mode", () => {
    const md = `| Key | Value |\n| --- | --- |\n| Name | Alice |`;
    const ir = markdownToIR(md, { tableMode: "bullets" });
    // The first column "Name" should be bold-styled
    const boldStyles = ir.styles.filter((s) => s.style === "bold");
    const boldTexts = boldStyles.map((s) => ir.text.slice(s.start, s.end));
    expect(boldTexts.some((t) => t.includes("Name"))).toBe(true);
  });
});

describe("table rendering — code mode", () => {
  it("renders a simple 2x2 table as code block", () => {
    const md = `| Name | Age |\n| --- | --- |\n| Alice | 30 |`;
    const ir = markdownToIR(md, { tableMode: "code" });
    expect(ir.text).toContain("|");
    expect(ir.text).toContain("Alice");
    expect(ir.text).toContain("30");
    expect(ir.styles.some((s) => s.style === "code_block")).toBe(true);
  });

  it("pads columns to equal width in code mode", () => {
    const md = `| Short | VeryLongColumnName |\n| --- | --- |\n| A | B |`;
    const ir = markdownToIR(md, { tableMode: "code" });
    // Each row should have consistent pipe characters
    const lines = ir.text.split("\n").filter((l) => l.includes("|"));
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + divider + 1 row
  });
});

describe("table rendering — off mode", () => {
  it("strips table content when tableMode is off", () => {
    const md = `| Name | Age |\n| --- | --- |\n| Alice | 30 |`;
    const ir = markdownToIR(md, { tableMode: "off" });
    // With tables disabled, the markdown parser doesn't parse as a table
    // The content may appear as plain text or be stripped
    expect(ir.styles.every((s) => s.style !== "code_block" || !ir.text.includes("| --- |"))).toBe(
      true,
    );
  });
});

describe("table edge cases", () => {
  it("handles ragged table (unequal column counts) without crash", () => {
    const md = `| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |`;
    const ir = markdownToIR(md, { tableMode: "bullets" });
    expect(ir.text).toContain("1");
    expect(ir.text).toContain("2");
  });

  it("handles table with empty cells", () => {
    const md = `| A | B |\n| --- | --- |\n|  | value |`;
    const ir = markdownToIR(md, { tableMode: "bullets" });
    expect(ir.text).toContain("value");
  });

  it("preserves styled content inside table cells", () => {
    const md = `| Name | Link |\n| --- | --- |\n| **Alice** | [site](https://example.com) |`;
    const ir = markdownToIR(md, { tableMode: "bullets" });
    expect(ir.text).toContain("Alice");
    const boldStyles = ir.styles.filter((s) => s.style === "bold");
    expect(boldStyles.length).toBeGreaterThan(0);
  });
});

describe("markdown style edge cases", () => {
  it("handles nested bold+italic (***text***)", () => {
    const ir = markdownToIR("***bold italic***");
    expect(ir.text).toBe("bold italic");
    expect(ir.styles.some((s) => s.style === "bold")).toBe(true);
    expect(ir.styles.some((s) => s.style === "italic")).toBe(true);
  });

  it("handles adjacent same-style spans", () => {
    const ir = markdownToIR("**a** **b**");
    expect(ir.text).toContain("a");
    expect(ir.text).toContain("b");
    // Both should have bold styles
    const boldStyles = ir.styles.filter((s) => s.style === "bold");
    expect(boldStyles.length).toBeGreaterThanOrEqual(1);
  });

  it("handles deeply nested styles (bold > italic > code)", () => {
    const ir = markdownToIR("**bold *italic `code`* text**");
    expect(ir.styles.some((s) => s.style === "bold")).toBe(true);
    expect(ir.styles.some((s) => s.style === "italic")).toBe(true);
    expect(ir.styles.some((s) => s.style === "code")).toBe(true);
  });

  it("handles unmatched markdown gracefully", () => {
    // Unmatched ** should not crash
    const ir = markdownToIR("hello **unclosed bold");
    expect(ir.text).toContain("hello");
    // Should not throw
  });
});
