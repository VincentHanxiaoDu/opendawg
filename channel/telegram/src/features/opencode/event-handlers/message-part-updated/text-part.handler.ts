import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
import { formatAsHtml } from "../utils.js";

let updateMessageId: number | null = null;
let lastUpdateTime = 0;
let finalizeTimeout: NodeJS.Timeout | null = null;
let latestFullText = "";

export async function handleTextPart(ctx: Context, text: string, userSession?: UserSession): Promise<void> {
    try {
        const now = Date.now();
        
        if (finalizeTimeout) {
            clearTimeout(finalizeTimeout);
            finalizeTimeout = null;
        }

        latestFullText = text;

        // Limit to last 50 lines during streaming to avoid Telegram 4096-char limit
        const lines = text.split('\n');
        const limitedText = lines.length > 50 
            ? lines.slice(-50).join('\n')
            : text;

        const streamingText = `[Streaming] ✍️\n${formatAsHtml(limitedText)}`;

        if (!updateMessageId) {
            // First message - send new message
            const sentMessage = await ctx.reply(streamingText, { parse_mode: "HTML" });
            updateMessageId = sentMessage.message_id;
            lastUpdateTime = now;
        } else {
            // Throttle: Check if 2 seconds have passed since last update
            const timeSinceLastUpdate = now - lastUpdateTime;
            if (timeSinceLastUpdate < 2000) {
                finalizeTimeout = setTimeout(() => {
                    finalizeTextMessage(ctx);
                }, 5000);
                return;
            }
            
            // Update immediately if enough time has passed
            await ctx.api.editMessageText(
                ctx.chat!.id,
                updateMessageId,
                streamingText,
                { parse_mode: "HTML" }
            );
            lastUpdateTime = now;
        }

        finalizeTimeout = setTimeout(() => {
            finalizeTextMessage(ctx);
        }, 5000);

    } catch (error) {
        console.log("Error in text part handler:", error);
    }
}

async function finalizeTextMessage(ctx: Context): Promise<void> {
    const msgId = updateMessageId;
    const savedText = latestFullText;
    updateMessageId = null;
    latestFullText = "";

    if (!msgId) return;

    try {
        let finalText = savedText;
        if (finalText.length > 4000) {
            finalText = '… (truncated)\n' + finalText.split('\n').slice(-50).join('\n');
            if (finalText.length > 4000) {
                finalText = finalText.slice(-4000);
            }
        }

        if (!finalText.trim()) {
            await ctx.api.deleteMessage(ctx.chat!.id, msgId);
            return;
        }

        await ctx.api.editMessageText(
            ctx.chat!.id,
            msgId,
            formatAsHtml(finalText),
            { parse_mode: "HTML" }
        );
    } catch {
        try { await ctx.api.deleteMessage(ctx.chat!.id, msgId); } catch {}
    }
}