import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";

let reasoningMessageId: number | null = null;
let reasoningDeleteTimeout: NodeJS.Timeout | null = null;

export async function handleReasoningPart(ctx: Context, userSession: UserSession): Promise<void> {
    try {
        const { verbosity, stream } = userSession;

        if (verbosity < 1) return;
        if (!stream) return;

        if (reasoningDeleteTimeout) {
            clearTimeout(reasoningDeleteTimeout);
            reasoningDeleteTimeout = null;
        }

        if (!reasoningMessageId) {
            const sentMessage = await ctx.reply("[Thinking] 💭");
            reasoningMessageId = sentMessage.message_id;
        }

        reasoningDeleteTimeout = setTimeout(async () => {
            try {
                if (reasoningMessageId) {
                    await ctx.api.deleteMessage(ctx.chat!.id, reasoningMessageId);
                    reasoningMessageId = null;
                }
            } catch {}
        }, 2500);

    } catch (error) {
        console.log("Error in reasoning part handler:", error);
    }
}

export async function cleanupReasoningMessages(ctx: Context): Promise<void> {
    if (reasoningDeleteTimeout) {
        clearTimeout(reasoningDeleteTimeout);
        reasoningDeleteTimeout = null;
    }
    if (reasoningMessageId) {
        try {
            await ctx.api.deleteMessage(ctx.chat!.id, reasoningMessageId);
        } catch {}
        reasoningMessageId = null;
    }
}