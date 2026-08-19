/**
 * CodeBlock Component
 * ────────────────────
 * Syntax-highlighted code display with copy button.
 * Used for JSON state viewers, configuration display, and logs.
 *
 * Features:
 *   - Monospace font with line numbers
 *   - Copy to clipboard button
 *   - Collapsible for long content
 *   - Language label
 *   - Dark background (works in both themes)
 */

import React from "react";
import { COLORS, RADIUS } from "../../constants/theme";

// ─── Types ───────────────────────────────────────────────────────

export interface CodeBlockProps {
  code: string;
  language?: string;
  maxHeight?: string;
  showLineNumbers?: boolean;
  showCopyButton?: boolean;
  title?: string;
}

// ─── Component ───────────────────────────────────────────────────

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language = "json",
  maxHeight = "400px",
  showLineNumbers = false,
  showCopyButton = true,
  title,
}) => {
  const [copied, setCopied] = React.useState(false);
  const codeRef = React.useRef<HTMLElement>(null);

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  }, [code]);

  const lines = React.useMemo(() => code.split("\n"), [code]);

  // ─── Basic JSON Syntax Highlighting ───────────────────────────

  const highlightJson = (text: string): string => {
    if (language !== "json") return text;

    // Escape HTML first
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Highlight strings, numbers, booleans, null
    return escaped
      .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span style="color:#93C5FD">$1</span>$2') // keys
      .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span style="color:#86EFAC">$1</span>') // string values
      .replace(/:\s*(true|false)/g, ': <span style="color:#FBBF24">$1</span>') // booleans
      .replace(/:\s*(null)/g, ': <span style="color:#9CA3AF">$1</span>') // null
      .replace(/:\s*(-?\d+\.?\d*)/g, ': <span style="color:#C4B5FD">$1</span>'); // numbers
  };

  return (
    <div
      style={{
        borderRadius: RADIUS.md,
        overflow: "hidden",
        border: `1px solid ${COLORS.border}`,
        backgroundColor: "#0F0F11",
      }}
    >
      {/* Header */}
      {(title || showCopyButton) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            backgroundColor: "#18181B",
            borderBottom: "1px solid #27272A",
          }}
        >
          <span
            style={{
              fontSize: "0.6875rem",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "#71717A",
            }}
          >
            {title ?? language}
          </span>
          {showCopyButton && (
            <button
              onClick={handleCopy}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                borderRadius: RADIUS.sm,
                backgroundColor: "transparent",
                border: `1px solid #27272A`,
                color: copied ? "#22C55E" : "#A1A1AA",
                fontSize: "0.6875rem",
                fontWeight: 500,
                cursor: "pointer",
                transition: "color 150ms ease, border-color 150ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#3F3F46";
                e.currentTarget.style.color = copied ? "#22C55E" : "#FAFAFA";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#27272A";
                e.currentTarget.style.color = copied ? "#22C55E" : "#A1A1AA";
              }}
            >
              {copied ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Code */}
      <div
        ref={codeRef as React.RefObject<HTMLDivElement>}
        style={{
          maxHeight,
          overflow: "auto",
          padding: "12px 0",
        }}
      >
        <pre
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "0.8125rem",
            lineHeight: 1.6,
            color: "#E4E4E7",
          }}
        >
          {showLineNumbers ? (
            lines.map((line, i) => (
              <div key={i} style={{ display: "flex" }}>
                <span
                  style={{
                    minWidth: "40px",
                    padding: "0 12px",
                    color: "#3F3F46",
                    textAlign: "right",
                    userSelect: "none",
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </span>
                <code
                  style={{ paddingRight: "16px", whiteSpace: "pre" }}
                  dangerouslySetInnerHTML={{ __html: highlightJson(line) || "&nbsp;" }}
                />
              </div>
            ))
          ) : (
            <code
              style={{ padding: "0 16px", display: "block", whiteSpace: "pre-wrap" }}
              dangerouslySetInnerHTML={{ __html: highlightJson(code) }}
            />
          )}
        </pre>
      </div>
    </div>
  );
};
