function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

/** Reject a UTF-16 page offset that would begin inside a Unicode code point. */
export function assertSafeTextOffset(text: string, offset: number): void {
  if (offset <= 0 || offset >= text.length) return;
  if (isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset))) {
    throw new Error(`offset ${offset} splits a Unicode surrogate pair; continue from the exact nextOffset returned by the previous page.`);
  }
}

/** Bound a UTF-16 page without ending between the halves of a surrogate pair. */
export function safeTextPageEnd(text: string, start: number, requestedEnd: number): number {
  let end = Math.min(text.length, requestedEnd);
  if (end > start && end < text.length
    && isHighSurrogate(text.charCodeAt(end - 1))
    && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }
  return end;
}

export function safeTextPrefix(text: string, maxChars: number): string {
  return text.slice(0, safeTextPageEnd(text, 0, maxChars));
}
