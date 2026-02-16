import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
import { formatAsHtml } from "../utils.js";

let updateMessageId: number | null = null;
let lastUpdateTime = 0;
let finalizeTimeout: NodeJS.Timeout | null = null;
let latestFullText = "";
let latestCtx: Context | null = null;
let isStreaming = true;

export async function handleTextPart(ctx: Context, text: string, userSession?: UserSession): Promise<void> {
    try {
        const stream = userSession?.stream ?? true;
        const now = Date.now();

        if (finalizeTimeout) {
            clearTimeout(finalizeTimeout);
            finalizeTimeout = null;
        }

        latestFullText = text;
        latestCtx = ctx;
        isStreaming = stream;

        if (!stream) {
            finalizeTimeout = setTimeout(() => {
                finalizeTextMessage(ctx);
            }, 5000);
            return;
        }

        const lines = text.split('\n');
        const limitedText = lines.length > 50
            ? lines.slice(-50).join('\n')
            : text;

        const streamingText = `[Streaming] ✍️\n${formatAsHtml(limitedText)}`;

        if (!updateMessageId) {
            const sentMessage = await ctx.reply(streamingText, { parse_mode: "HTML" });
            updateMessageId = sentMessage.message_id;
            lastUpdateTime = now;
        } else {
            const timeSinceLastUpdate = now - lastUpdateTime;
            if (timeSinceLastUpdate < 2000) {
                finalizeTimeout = setTimeout(() => {
                    finalizeTextMessage(ctx);
                }, 5000);
                return;
            }

            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    updateMessageId,
                    streamingText,
                    { parse_mode: "HTML" }
                );
            } catch {}
            lastUpdateTime = now;
        }

        finalizeTimeout = setTimeout(() => {
            finalizeTextMessage(ctx);
        }, 5000);

    } catch (error) {
        console.log("Error in text part handler:", error);
    }
}

export async function finalizeTextMessage(ctx?: Context): Promise<void> {
    if (finalizeTimeout) {
        clearTimeout(finalizeTimeout);
        finalizeTimeout = null;
    }

    const msgId = updateMessageId;
    const savedText = latestFullText;
    const resolvedCtx = ctx || latestCtx;
    updateMessageId = null;
    latestFullText = "";
    latestCtx = null;

    if (!resolvedCtx) return;

    let finalText = savedText;
    if (finalText.length > 4000) {
        finalText = '… (truncated)\n' + finalText.split('\n').slice(-50).join('\n');
        if (finalText.length > 4000) {
            finalText = finalText.slice(-4000);
        }
    }

    if (!finalText.trim()) {
        if (msgId) {
            try { await resolvedCtx.api.deleteMessage(resolvedCtx.chat!.id, msgId); } catch {}
        }
        return;
    }

    if (msgId) {
        try {
            await resolvedCtx.api.editMessageText(
                resolvedCtx.chat!.id,
                msgId,
                formatAsHtml(finalText),
                { parse_mode: "HTML" }
            );
        } catch {
            try { await resolvedCtx.api.deleteMessage(resolvedCtx.chat!.id, msgId); } catch {}
            try { await resolvedCtx.reply(formatAsHtml(finalText), { parse_mode: "HTML" }); } catch {}
        }
    } else {
        try { await resolvedCtx.reply(formatAsHtml(finalText), { parse_mode: "HTML" }); } catch {}
    }
}