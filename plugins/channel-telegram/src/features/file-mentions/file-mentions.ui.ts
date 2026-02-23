import type { Context } from "grammy";
import type { FileMention, FileMatch } from "./file-mentions.types.js";
import { escapeHtml } from "../opencode/event-handlers/utils.js";

export class FileMentionUI {
    async confirmAllMatches(
        ctx: Context,
        matches: Map<FileMention, FileMatch[]>
    ): Promise<Map<FileMention, FileMatch> | null> {
        const resolved = new Map<FileMention, FileMatch>();
        
        for (const [mention, fileMatches] of matches.entries()) {
            if (fileMatches.length === 0) {
                await ctx.reply(`❌ No files found matching: ${mention.raw}`);
                return null;
            }
            
            resolved.set(mention, fileMatches[0]);

            const matchInfo = fileMatches.length > 1
                ? ` (best of ${fileMatches.length})`
                : "";
            await ctx.reply(
                `✅ <code>${escapeHtml(mention.raw)}</code> → <code>${escapeHtml(fileMatches[0].path)}</code>${matchInfo}`,
                { parse_mode: "HTML" }
            );
        }
        
        return resolved;
    }
    
    async showSearching(ctx: Context, mentionCount: number): Promise<any> {
        return await ctx.reply(
            `🔍 Searching for ${mentionCount} file${mentionCount > 1 ? 's' : ''}...`
        );
    }
}
