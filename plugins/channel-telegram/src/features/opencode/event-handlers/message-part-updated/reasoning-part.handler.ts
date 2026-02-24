import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";

interface ReasoningState {
    messageId: number | null;
    deleteTimeout: NodeJS.Timeout | null;
}

const sessionReasoningState = new Map<string, ReasoningState>();

function getState(sessionId: string): ReasoningState {
    let state = sessionReasoningState.get(sessionId);
    if (!state) {
        state = { messageId: null, deleteTimeout: null };
        sessionReasoningState.set(sessionId, state);
    }
    return state;
}

export async function handleReasoningPart(ctx: Context, userSession: UserSession): Promise<void> {
    try {
        const { verbosity, stream, sessionId } = userSession;

        if (verbosity < 1) return;
        if (!stream) return;

        const state = getState(sessionId);

        if (state.deleteTimeout) {
            clearTimeout(state.deleteTimeout);
            state.deleteTimeout = null;
        }

        if (!state.messageId) {
            const sentMessage = await ctx.reply("[Thinking] 💭");
            state.messageId = sentMessage.message_id;
        }

        const chatId = ctx.chat?.id;
        if (!chatId) return;

        state.deleteTimeout = setTimeout(async () => {
            try {
                if (state.messageId) {
                    await ctx.api.deleteMessage(chatId, state.messageId);
                    state.messageId = null;
                }
            } catch {}
        }, 2500);

    } catch (error) {
        console.log("Error in reasoning part handler:", error);
    }
}

export async function cleanupReasoningMessages(sessionId: string, ctx: Context): Promise<void> {
    const state = sessionReasoningState.get(sessionId);
    if (!state) return;

    if (state.deleteTimeout) {
        clearTimeout(state.deleteTimeout);
        state.deleteTimeout = null;
    }
    if (state.messageId) {
        const chatId = ctx.chat?.id;
        if (chatId) {
            try {
                await ctx.api.deleteMessage(chatId, state.messageId);
            } catch {}
        }
        state.messageId = null;
    }
}

export function cleanupReasoningState(sessionId: string): void {
    const state = sessionReasoningState.get(sessionId);
    if (state?.deleteTimeout) {
        clearTimeout(state.deleteTimeout);
    }
    sessionReasoningState.delete(sessionId);
}