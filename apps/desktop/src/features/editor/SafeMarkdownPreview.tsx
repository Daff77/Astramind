import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface SafeMarkdownPreviewProps {
  markdown: string;
  onOpenWikilink: (rawTarget: string) => void;
}

const WIKILINK_PREFIX = "pb-wikilink:";
const NOTE_LINK_PREFIX = "pb-notelink:";

function stripFrontmatter(raw: string): string {
  const normalized = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(normalized);
  return match ? normalized.slice(match[0].length) : normalized;
}

/**
 * Rewrites [[target]] and [[target|alias]] outside fenced code blocks and inline
 * code spans into markdown links using our internal `pb-wikilink:` scheme.
 */
function preprocessWikilinks(body: string): string {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let fenceChar = "";

  return lines
    .map((line) => {
      const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1]?.[0] ?? "";
        if (!inFence) {
          inFence = true;
          fenceChar = marker;
        } else if (marker === fenceChar) {
          inFence = false;
          fenceChar = "";
        }
        return line;
      }
      if (inFence) return line;

      const segments = line.split(/(`+[^`]*`+)/g);
      return segments
        .map((segment, index) => {
          if (index % 2 === 1) return segment;
          return segment.replace(
            /\[\[([^\]\n]+)\]\]/g,
            (_full, inner: string) => {
              const pipeIdx = inner.indexOf("|");
              const rawTarget = (
                pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner
              ).trim();
              const label = (
                pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : rawTarget
              ).trim();
              const safeLabel = (label || rawTarget).replace(/[[\]]/g, "");
              return `[${safeLabel}](${WIKILINK_PREFIX}${encodeURIComponent(rawTarget)})`;
            },
          );
        })
        .join("");
    })
    .join("\n");
}

function isSafeRelativeMarkdownHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    /^[a-zA-Z]:/.test(trimmed) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  ) {
    return null;
  }
  const withoutHash = trimmed.split("#")[0]?.split("?")[0] ?? "";
  const cleaned = withoutHash.replace(/^\.\//, "").replace(/\\/g, "/");
  if (
    !cleaned ||
    cleaned.split("/").some((seg) => seg === ".." || seg === "" || seg.includes(":"))
  ) {
    return null;
  }
  if (!cleaned.toLowerCase().endsWith(".md")) {
    return null;
  }
  return cleaned;
}

function isAllowedExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function safeUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith(WIKILINK_PREFIX)) {
    return trimmed;
  }
  const relNote = isSafeRelativeMarkdownHref(trimmed);
  if (relNote) {
    return `${NOTE_LINK_PREFIX}${encodeURIComponent(relNote)}`;
  }
  if (isAllowedExternalHref(trimmed)) {
    return trimmed;
  }
  return "";
}

export function SafeMarkdownPreview({
  markdown,
  onOpenWikilink,
}: SafeMarkdownPreviewProps) {
  const processed = useMemo(
    () => preprocessWikilinks(stripFrontmatter(markdown)),
    [markdown],
  );

  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        const rawHref = (href ?? "").trim();
        if (
          rawHref.startsWith(WIKILINK_PREFIX) ||
          rawHref.startsWith(NOTE_LINK_PREFIX)
        ) {
          const encoded = rawHref.startsWith(WIKILINK_PREFIX)
            ? rawHref.slice(WIKILINK_PREFIX.length)
            : rawHref.slice(NOTE_LINK_PREFIX.length);
          let target = encoded;
          try {
            target = decodeURIComponent(encoded);
          } catch {
            // Keep fallback string
          }
          return (
            <button
              type="button"
              className="pb-wikilink-btn"
              onClick={() => onOpenWikilink(target)}
            >
              {children}
            </button>
          );
        }

        if (!isAllowedExternalHref(rawHref)) {
          return (
            <span
              className="pb-blocked-link"
              title="Blocked potentially unsafe or local link"
            >
              [blocked link: {children as ReactNode}]
            </span>
          );
        }

        return (
          <a href={rawHref} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img({ alt, src }) {
        return (
          <span
            className="pb-blocked-link"
            title={src ? `Image loading blocked (${src})` : "Image blocked"}
          >
            [image blocked by local privacy policy{alt ? `: ${alt}` : ""}]
          </span>
        );
      },
    }),
    [onOpenWikilink],
  );

  return (
    <div className="pb-preview-pane" aria-label="Markdown preview">
      <article className="pb-preview-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={safeUrlTransform}
          components={components}
        >
          {processed}
        </ReactMarkdown>
      </article>
    </div>
  );
}
