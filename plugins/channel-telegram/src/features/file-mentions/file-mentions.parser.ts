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
    

}
