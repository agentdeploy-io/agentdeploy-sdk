import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Render markdown to sanitized HTML for chat bubbles.
 * Sanitization strips event handlers / script injection while keeping the
 * formatting the agents produce (headings, lists, tables, code fences).
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text || "", { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["target"],
  });
}
