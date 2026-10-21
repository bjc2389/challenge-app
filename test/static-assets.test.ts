/// <reference types="vite/client" />
// M7: static asset hardening and polish.
// - public/_headers: the CSP and security headers for the app shell and static files (§3).
// - index.html: meta tags and favicon (§9, CLAUDE.md design).
// - public/favicon.svg: brand colors only, no scripts or external references (CLAUDE.md design).
// - src/client/styles.css: animations only with prefers-reduced-motion: no-preference (§9).
// Files are read with `?raw` through import.meta.glob, so a missing file fails its own
// assertions instead of breaking the whole suite.
import { describe, expect, it } from "vitest";

// One brace glob: a pattern with no glob syntax at all breaks Vite's glob crawler.
const files = import.meta.glob<string>("../{index.html,public/_headers,public/favicon.svg,src/client/styles.css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Contents of a repo-relative file, failing the calling test if it doesn't exist. */
function rawFile(name: string): string {
  const text = files[`../${name}`];
  expect(text, `${name} should exist`).toBeTypeOf("string");
  return text as string;
}

// ---------------------------------------------------------------------------
// _headers parsing (Cloudflare format: unindented path lines, indented `Name: value`)
// ---------------------------------------------------------------------------

type HeaderRule = { path: string; headers: Array<[string, string]> };

function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { path: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const colon = line.indexOf(":");
    if (current === null || colon === -1) throw new Error(`Unparseable _headers line: ${JSON.stringify(line)}`);
    current.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

function headerValues(rule: HeaderRule, name: string): string[] {
  return rule.headers.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

/** CSP directives keyed by lowercased name; values are the source lists. */
function parseCsp(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...sources] = tokens;
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

function allowsOrigin(sources: string[], url: string): boolean {
  const origin = new URL(url).origin;
  return sources.some((s) => s === origin || s === `${origin}/`);
}

function rootRule(): HeaderRule | undefined {
  return parseHeadersFile(rawFile("public/_headers")).find((r) => r.path === "/*");
}

function rootCsp(): { raw: string; directives: Map<string, string[]> } {
  const rule = rootRule();
  expect(rule, "a /* rule").toBeDefined();
  const values = headerValues(rule as HeaderRule, "Content-Security-Policy");
  expect(values, "exactly one CSP header on /*").toHaveLength(1);
  const raw = values[0] as string;
  return { raw, directives: parseCsp(raw) };
}

// ---------------------------------------------------------------------------
// HTML tag parsing (attribute order free)
// ---------------------------------------------------------------------------

function tags(html: string, name: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const m of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))) {
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const a of (m[1] ?? "").matchAll(attrRe)) {
      attrs[(a[1] as string).toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    out.push(attrs);
  }
  return out;
}

function metaContent(html: string, name: string): string[] {
  return tags(html, "meta")
    .filter((t) => t.name?.toLowerCase() === name)
    .map((t) => t.content ?? "");
}

// ---------------------------------------------------------------------------
// CSS helpers (comments stripped; braces matched)
// ---------------------------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Index of the `}` matching the `{` at `open`. */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i;
  }
  throw new Error("Unbalanced braces in CSS");
}

/** Finds each at-rule block matching `header` (a regex ending at its `{`). */
function findBlocks(css: string, header: RegExp): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  const re = new RegExp(header.source, "g");
  for (const m of css.matchAll(re)) {
    const open = (m.index as number) + m[0].length - 1;
    const close = matchBrace(css, open);
    out.push({ start: m.index as number, end: close + 1, body: css.slice(open + 1, close) });
  }
  return out;
}

/** Every style rule as {selector, body}, recursing into at-rule blocks. */
function styleRules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let selector = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i] as string;
    if (ch === "{") {
      const close = matchBrace(css, i);
      const body = css.slice(i + 1, close);
      const sel = selector.trim();
      if (sel.startsWith("@") && body.includes("{")) out.push(...styleRules(body));
      else out.push({ selector: sel, body });
      selector = "";
      i = close + 1;
    } else if (ch === ";") {
      selector = ""; // a statement at-rule such as @import
      i++;
    } else {
      selector += ch;
      i++;
    }
  }
  return out;
}

const NO_PREFERENCE = /@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{/;
const REDUCE = /@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{/;

// ===========================================================================

describe("§3 public/_headers: the /* rule", () => {
  it("parses the format", () => {
    expect(parseHeadersFile("/*\n  X-A: 1\n  X-B: a: b\n/x\n  X-C: 2\n")).toEqual([
      { path: "/*", headers: [["X-A", "1"], ["X-B", "a: b"]] },
      { path: "/x", headers: [["X-C", "2"]] },
    ]);
  });

  it("has a /* rule", () => {
    expect(rootRule()).toBeDefined();
  });

  it("CSP has default-src 'self'", () => {
    expect(rootCsp().directives.get("default-src")).toEqual(["'self'"]);
  });

  it("CSP script-src is exactly 'self'", () => {
    expect(rootCsp().directives.get("script-src")).toEqual(["'self'"]);
  });

  it("CSP has no unsafe-inline or unsafe-eval anywhere", () => {
    const { raw } = rootCsp();
    expect(raw).not.toMatch(/unsafe-inline/i);
    expect(raw).not.toMatch(/unsafe-eval/i);
  });

  it("CSP style-src allows 'self' and Google Fonts CSS", () => {
    const styles = rootCsp().directives.get("style-src");
    expect(styles).toBeDefined();
    expect(styles).toContain("'self'");
    expect(allowsOrigin(styles as string[], "https://fonts.googleapis.com/css2")).toBe(true);
  });

  it("CSP font-src allows Google Fonts files", () => {
    const fonts = rootCsp().directives.get("font-src");
    expect(fonts).toBeDefined();
    expect(allowsOrigin(fonts as string[], "https://fonts.gstatic.com/s/x.woff2")).toBe(true);
  });

  it.each(["frame-ancestors", "object-src", "base-uri"])("CSP has %s 'none'", (name) => {
    expect(rootCsp().directives.get(name)).toEqual(["'none'"]);
  });

  it.each([
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "same-origin"],
  ])("has %s: %s", (name, value) => {
    const rule = rootRule();
    expect(rule, "a /* rule").toBeDefined();
    expect(headerValues(rule as HeaderRule, name)).toEqual([value]);
  });
});

describe("§3 index.html external resources are allowed by the CSP", () => {
  it("every https:// stylesheet and script origin is in the matching directive", () => {
    const html = rawFile("index.html");
    const { directives } = rootCsp();
    const external: Array<[string, string]> = [];
    for (const link of tags(html, "link")) {
      const rels = (link.rel ?? "").toLowerCase().split(/\s+/);
      if (rels.includes("stylesheet") && link.href?.startsWith("https://")) external.push(["style-src", link.href]);
    }
    for (const script of tags(html, "script")) {
      if (script.src?.startsWith("https://")) external.push(["script-src", script.src]);
    }
    for (const [directive, url] of external) {
      const sources = directives.get(directive) ?? [];
      expect(allowsOrigin(sources, url), `${directive} should allow ${url}`).toBe(true);
    }
  });
});

describe("§9 CLAUDE.md design: index.html meta tags", () => {
  const html = () => rawFile("index.html");

  it("the viewport includes width=device-width", () => {
    const viewport = metaContent(html(), "viewport");
    expect(viewport).toHaveLength(1);
    expect(viewport[0]).toMatch(/(^|[\s,])width=device-width([\s,]|$)/);
  });

  it("theme-color is #002657", () => {
    const theme = metaContent(html(), "theme-color");
    expect(theme).toHaveLength(1);
    expect((theme[0] as string).toLowerCase()).toBe("#002657");
  });

  it("color-scheme is light", () => {
    expect(metaContent(html(), "color-scheme")).toEqual(["light"]);
  });

  it("has a non-empty meta description", () => {
    const desc = metaContent(html(), "description");
    expect(desc).toHaveLength(1);
    expect((desc[0] as string).trim()).not.toBe("");
  });

  it("robots is noindex", () => {
    expect(metaContent(html(), "robots")).toEqual(["noindex"]);
  });

  it("links the SVG favicon", () => {
    const icons = tags(html(), "link").filter((t) => (t.rel ?? "").toLowerCase().split(/\s+/).includes("icon"));
    expect(icons).toHaveLength(1);
    expect(icons[0]?.href).toBe("/favicon.svg");
    expect(icons[0]?.type).toBe("image/svg+xml");
  });

  it('never says "Gators"', () => {
    expect(html()).not.toMatch(/gators/i);
  });
});

describe("CLAUDE.md design: public/favicon.svg", () => {
  const ALLOWED = ["#fa4616", "#0021a5", "#002657", "#fff", "#ffffff"];
  const svg = () => rawFile("public/favicon.svg");

  function hexColors(text: string): string[] {
    return [...text.matchAll(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi)].map((m) =>
      m[0].toLowerCase(),
    );
  }

  it("starts with <svg", () => {
    expect(svg()).toMatch(/^\s*<svg[\s>]/);
  });

  it("has no <script or <text", () => {
    expect(svg()).not.toMatch(/<script/i);
    expect(svg()).not.toMatch(/<text/i);
  });

  it("has no xlink:href and no external href", () => {
    expect(svg()).not.toMatch(/xlink:href/i);
    for (const m of svg().matchAll(/(?<![\w:-])href\s*=\s*["']([^"']*)["']/gi)) {
      expect(m[1], "only in-document #fragment hrefs").toMatch(/^#/);
    }
  });

  it("uses only brand colors, and at least one", () => {
    const colors = hexColors(svg());
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(ALLOWED, `color ${c}`).toContain(c);
  });
});

describe("§9 styles.css: animations only without a reduced-motion preference", () => {
  // Vitest replaces every .css module (even `?raw`) with "" unless its `css` option
  // includes the file, so guard against checking an empty string.
  const css = () => {
    const text = stripComments(rawFile("src/client/styles.css"));
    expect(text, "styles.css read as an empty string; see the vitest `css` option").toMatch(/:root\s*\{/);
    return text;
  };

  it("reads the real stylesheet, not Vitest's empty CSS stub", () => {
    expect(css().length).toBeGreaterThan(0);
  });

  it("the CSS helpers find rules inside at-rules", () => {
    const sample = "@media (x) { .a .reveal { animation: r 1s; } } .b { color: red; }";
    expect(styleRules(sample)).toEqual([
      { selector: ".a .reveal", body: " animation: r 1s; " },
      { selector: ".b", body: " color: red; " },
    ]);
    expect(findBlocks(sample, /@media\s*\(x\)\s*\{/)[0]?.body).toBe(" .a .reveal { animation: r 1s; } ");
  });

  it("has a prefers-reduced-motion: no-preference block with the .reveal animation", () => {
    const blocks = findBlocks(css(), NO_PREFERENCE);
    expect(blocks.length).toBeGreaterThan(0);
    const body = blocks.map((b) => b.body).join("\n");
    expect(body).toContain(".reveal");
    expect(body).toMatch(/animation/);
  });

  it("outside that block, no .reveal or aria-busy rule animates", () => {
    let rest = css();
    // Remove from the end so earlier offsets stay valid.
    for (const b of findBlocks(rest, NO_PREFERENCE).reverse()) rest = rest.slice(0, b.start) + rest.slice(b.end);
    const offenders = styleRules(rest)
      .filter((r) => r.selector.includes(".reveal") || r.selector.includes("aria-busy"))
      .filter((r) => /animation/.test(r.body))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("does not rely on a prefers-reduced-motion: reduce override to stop animations", () => {
    for (const b of findBlocks(css(), REDUCE)) expect(b.body).not.toMatch(/animation/);
  });
});
