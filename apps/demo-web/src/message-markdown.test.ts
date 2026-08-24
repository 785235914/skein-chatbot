import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "./message-markdown.js";

const renderMarkdown = (content: string): string =>
  renderToStaticMarkup(createElement(MarkdownMessage, { content }));

describe("MarkdownMessage", () => {
  it("renders common Markdown as semantic HTML", () => {
    const html = renderMarkdown(
      "### Core definition\n\nThis is **important**.\n\n- First\n- Second",
    );

    expect(html).toContain("<h3>Core definition</h3>");
    expect(html).toContain("This is <strong>important</strong>.");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>First</li>");
  });

  it("does not expose raw HTML or unsafe link protocols", () => {
    const html = renderMarkdown(
      '<script>alert("xss")</script>\n\n[unsafe](javascript:alert(1))',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert(&quot;xss&quot;)");
  });

  it("renders GitHub-flavored Markdown tables", () => {
    const html = renderMarkdown(
      "| Tool | Type |\n| --- | --- |\n| Copilot | Product |\n| Codex | Agent |",
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<th>Tool</th>");
    expect(html).toContain("<td>Agent</td>");
  });

  it("opens safe Markdown links without granting opener access", () => {
    const html = renderMarkdown("[Documentation](https://example.com/docs)");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
