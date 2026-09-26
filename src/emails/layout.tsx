/**
 * The shell every dunning email is rendered into.
 *
 * Inline styles and a table-free single column: email clients strip
 * stylesheets and disagree about everything else, so the markup here stays at
 * the level all of them render the same way.
 */
import type { CSSProperties, ReactNode } from "react";

const body: CSSProperties = {
  margin: 0,
  padding: "24px",
  backgroundColor: "#f5f5f4",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  color: "#1c1917",
};

const card: CSSProperties = {
  maxWidth: "520px",
  margin: "0 auto",
  padding: "32px",
  backgroundColor: "#ffffff",
  borderRadius: "8px",
  border: "1px solid #e7e5e4",
};

const heading: CSSProperties = { margin: "0 0 16px", fontSize: "20px", lineHeight: "28px" };

const paragraph: CSSProperties = { margin: "0 0 16px", fontSize: "15px", lineHeight: "24px" };

const footer: CSSProperties = { margin: "24px 0 0", fontSize: "13px", color: "#78716c" };

/**
 * Hidden in the client, and skipped by the plain-text render: react-email's
 * default selectors drop `data-skip-in-text`, so the preheader does not turn
 * into a duplicated first line for anyone reading the text part.
 */
const preheader: CSSProperties = {
  display: "none",
  overflow: "hidden",
  maxHeight: 0,
  opacity: 0,
};

export { heading as emailHeading, paragraph as emailParagraph, footer as emailFooter };

export interface EmailShellProps {
  /** The one-line summary inbox lists show next to the subject. */
  preview: string;
  children: ReactNode;
}

export function EmailShell({ preview, children }: EmailShellProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="color-scheme" content="light" />
      </head>
      <body style={body}>
        <span style={preheader} data-skip-in-text="true">
          {preview}
        </span>
        <div style={card}>{children}</div>
      </body>
    </html>
  );
}
