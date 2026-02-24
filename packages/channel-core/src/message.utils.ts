// ─────────────────────────────────────────────────────────────────────────────
// Generic message formatting and splitting utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape characters that are special in Markdown.
 *
 * This covers the union of characters that Telegram MarkdownV2 and Discord
 * Markdown treat as formatting triggers.  Channel adapters can use this
 * directly or provide their own platform-specific variant.
 */
export function escapeMarkdown(text: string): string {
    // Covers: _ * [ ] ( ) ~ ` > # + - = | { } . ! \ ~
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/**
 * Split a long message into chunks that fit within a maximum character limit.
 *
 * Splitting strategy (in order of preference):
 * 1. Newline boundaries
 * 2. Sentence-ending punctuation (`.`, `!`, `?`, CJK equivalents)
 * 3. Space boundaries
 * 4. Hard cut at `maxLength`
 *
 * @param text       The text to split.
 * @param maxLength  Maximum characters per chunk (default 4000, safe for
 *                   both Telegram 4096 and Discord 2000 — caller can override).
 * @returns An array of non-empty string chunks.
 */
export function splitMessage(text: string, maxLength = 4000): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIdx = -1;

        // Try to split at last newline within limit
        const newlineIdx = remaining.lastIndexOf("\n", maxLength);
        if (newlineIdx > 0) {
            splitIdx = newlineIdx + 1; // include the newline in the first chunk
        }

        // Try sentence boundary
        if (splitIdx <= 0) {
            const sentenceRe = /[.!?。！？]\s*/g;
            let lastMatch = -1;
            let m: RegExpExecArray | null;
            while ((m = sentenceRe.exec(remaining)) !== null) {
                if (m.index + m[0].length <= maxLength) {
                    lastMatch = m.index + m[0].length;
                } else {
                    break;
                }
            }
            if (lastMatch > 0) splitIdx = lastMatch;
        }

        // Try space
        if (splitIdx <= 0) {
            const spaceIdx = remaining.lastIndexOf(" ", maxLength);
            if (spaceIdx > 0) splitIdx = spaceIdx + 1;
        }

        // Hard cut
        if (splitIdx <= 0) {
            splitIdx = maxLength;
        }

        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx);
    }

    return chunks.filter(c => c.length > 0);
}
