/**
 * Flattens Markdown into a single line of readable plain text.
 *
 * For one-line surfaces that render text verbatim — session-list previews,
 * sidebar narration — where unrendered syntax like `[title](url)` would leak
 * to the user. Lossy by design: it drops fenced code entirely and keeps only
 * link/image text, so it must not be used where the Markdown is rendered.
 */
export function flattenMarkdownToPlainText(text: string): string {
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1");
  return stripInlineLinks(withoutCode)
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/(\*{1,2})(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}])(_{1,2})(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}])/gu, "$1$3")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Maps each `[` to its balanced `]`, and each `(` to its balanced `)` within the same
 * whitespace-free run, skipping backslash-escaped characters.
 */
function matchDelimiters(text: string): Map<number, number> {
  const closers = new Map<number, number>();
  const brackets: number[] = [];
  const parens: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 1;
    } else if (/\s/.test(char)) {
      parens.length = 0;
    } else if (char === "[") {
      brackets.push(index);
    } else if (char === "(") {
      parens.push(index);
    } else {
      const opener = char === "]" ? brackets.pop() : char === ")" ? parens.pop() : undefined;
      if (opener !== undefined) {
        closers.set(opener, index);
      }
    }
  }
  return closers;
}

const TITLE_CLOSERS: Record<string, string> = { '"': '"', "'": "'", "(": ")" };

function skipSpaces(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** Returns the index of the `)` closing `(destination "title")` opened at `open`. */
function findDestinationEnd(
  text: string,
  open: number,
  closers: Map<number, number>,
): number | undefined {
  let index = skipSpaces(text, open + 1);
  if (text.charAt(index) === "<") {
    index += 1;
    while (index < text.length && !"<>\n".includes(text.charAt(index))) {
      index += text.charAt(index) === "\\" ? 2 : 1;
    }
    if (text.charAt(index) !== ">") {
      return undefined;
    }
    index += 1;
  } else {
    while (index < text.length && text.charAt(index) !== ")" && !/\s/.test(text.charAt(index))) {
      if (text.charAt(index) === "(") {
        const closer = closers.get(index);
        if (closer === undefined) {
          return undefined;
        }
        index = closer + 1;
      } else {
        index += text.charAt(index) === "\\" ? 2 : 1;
      }
    }
  }
  const titleStart = skipSpaces(text, index);
  const titleCloser = TITLE_CLOSERS[text.charAt(titleStart)];
  if (titleStart > index && titleCloser) {
    index = titleStart + 1;
    while (index < text.length && text.charAt(index) !== titleCloser) {
      if (titleCloser === ")" && text.charAt(index) === "(") {
        return undefined;
      }
      index += text.charAt(index) === "\\" ? 2 : 1;
    }
    index = skipSpaces(text, index + 1);
  } else {
    index = titleStart;
  }
  return text.charAt(index) === ")" ? index : undefined;
}

/** Replaces `[label](destination)` and `![label](destination)` with the label, nested labels included. */
function stripInlineLinks(text: string): string {
  const closers = matchDelimiters(text);
  const suffixEnds = new Map<number, number>();
  let output = "";
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    const suffixEnd = suffixEnds.get(index);
    if (suffixEnd !== undefined) {
      output += text.slice(cursor, index);
      cursor = suffixEnd;
      index = suffixEnd - 1;
      continue;
    }
    const labelEnd = text[index] === "[" ? closers.get(index) : undefined;
    const destinationEnd =
      labelEnd !== undefined && text[labelEnd + 1] === "("
        ? findDestinationEnd(text, labelEnd + 1, closers)
        : undefined;
    if (labelEnd === undefined || destinationEnd === undefined) {
      continue;
    }
    const isImage = index > cursor && text[index - 1] === "!";
    if (!isImage && labelEnd === index + 1) {
      continue;
    }
    output += text.slice(cursor, isImage ? index - 1 : index);
    cursor = index + 1;
    suffixEnds.set(labelEnd, destinationEnd + 1);
  }
  return output + text.slice(cursor);
}
