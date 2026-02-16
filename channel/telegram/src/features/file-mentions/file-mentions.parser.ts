import type { FileMention } from "./file-mentions.types.js";

export class FileMentionParser {
    private readonly MENTION_PATTERN = /(?:^|(?<=\s))@(?:"([^"]+)"|([^\s]+))/g;

    parse(text: string): FileMention[] {
        const mentions: FileMention[] = [];
        let match: RegExpExecArray | null;

        this.MENTION_PATTERN.lastIndex = 0;

        while ((match = this.MENTION_PATTERN.exec(text)) !== null) {
            const raw = match[0].trimStart();
            const query = match[1] || match[2];

            const rawStart = match.index + (match[0].length - raw.length);

            mentions.push({
                raw,
                query,
                startIndex: rawStart,
                endIndex: rawStart + raw.length
            });
        }

        return mentions;
    }
    
    replace(text: string, replacements: Map<string, string>): string {
        let result = text;
        
        // Sort replacements by position (descending) to avoid offset issues
        const sorted = Array.from(replacements.entries())
            .sort((a, b) => b[0].length - a[0].length);
        
        for (const [mention, replacement] of sorted) {
            result = result.replace(mention, replacement);
        }
        
        return result;
    }
    
    hasMentions(text: string): boolean {
        this.MENTION_PATTERN.lastIndex = 0;
        return this.MENTION_PATTERN.test(text);
    }
}
