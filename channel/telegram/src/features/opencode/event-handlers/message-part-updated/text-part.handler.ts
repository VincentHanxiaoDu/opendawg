import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
import { formatAsHtml } from "../utils.js";

interface TextPartState {
    updateMessageId: number | null;
    lastUpdateTime: number;
    finalizeTimeout: NodeJS.Timeout | null;
    latestFullText: string;
    latestCtx: Context | null;
    isStreaming: boolean;
}

const sessionTextState = new Map<string, TextPartState>();

function getState(sessionId: string): TextPartState {
    let state = sessionTextState.get(sessionId);
    if (!state) {
        state = {
            updateMessageId: null,
            lastUpdateTime: 0,
            finalizeTimeout: null,
            latestFullText: "",
            latestCtx: null,
            isStreaming: true,
        };
        sessionTextState.set(sessionId, state);
    }
    return state;
}

export async function handleTextPart(ctx: Context, text: string, userSession: UserSession): Promise<void> {
    try {
        const sessionId = userSession.sessionId;
        const stream = userSession.stream ?? true;
        const now = Date.now();
        const state = getState(sessionId);

        if (state.finalizeTimeout) {
            clearTimeout(state.finalizeTimeout);
            state.finalizeTimeout = null;
        }

        state.latestFullText = text;
        state.latestCtx = ctx;
        state.isStreaming = stream;

        if (!stream) {
            state.finalizeTimeout = setTimeout(() => {
                finalizeTextMessage(sessionId, ctx);
            }, 5000);
            return;
        }

        const lines = text.split('\n');
        const limitedText = lines.length > 50
            ? lines.slice(-50).join('\n')
            : text;

        const streamingText = `[Streaming] ✍️\n${formatAsHtml(limitedText)}`;

        if (!state.updateMessageId) {
            const sentMessage = await ctx.reply(streamingText, { parse_mode: "HTML" });
            state.updateMessageId = sentMessage.message_id;
            state.lastUpdateTime = now;
        } else {
            const timeSinceLastUpdate = now - state.lastUpdateTime;
            if (timeSinceLastUpdate < 2000) {
                state.finalizeTimeout = setTimeout(() => {
                    finalizeTextMessage(sessionId, ctx);
                }, 5000);
                return;
            }

            const chatId = ctx.chat?.id;
            if (!chatId) return;
            try {
                await ctx.api.editMessageText(
                    chatId,
                    state.updateMessageId,
                    streamingText,
                    { parse_mode: "HTML" }
                );
            } catch {}
            state.lastUpdateTime = now;
        }

        state.finalizeTimeout = setTimeout(() => {
            finalizeTextMessage(sessionId, ctx);
        }, 5000);

    } catch (error) {
        console.log("Error in text part handler:", error);
    }
}

export async function finalizeTextMessage(sessionId: string, ctx?: Context): Promise<void> {
    const state = sessionTextState.get(sessionId);
    if (!state) return;

    if (state.finalizeTimeout) {
        clearTimeout(state.finalizeTimeout);
        state.finalizeTimeout = null;
    }

    const msgId = state.updateMessageId;
    const savedText = state.latestFullText;
    const resolvedCtx = ctx || state.latestCtx;
    state.updateMessageId = null;
    state.latestFullText = "";
    state.latestCtx = null;

    if (!resolvedCtx) return;
    const chatId = resolvedCtx.chat?.id;
    if (!chatId) return;

    let finalText = savedText;
    if (finalText.length > 4000) {
        finalText = '… (truncated)\n' + finalText.split('\n').slice(-50).join('\n');
        if (finalText.length > 4000) {
            finalText = finalText.slice(-4000);
        }
    }

    if (!finalText.trim()) {
        if (msgId) {
            try { await resolvedCtx.api.deleteMessage(chatId, msgId); } catch {}
        }
        return;
    }

    if (msgId) {
        try {
            await resolvedCtx.api.editMessageText(
                chatId,
                msgId,
                formatAsHtml(finalText),
                { parse_mode: "HTML" }
            );
        } catch {
            try { await resolvedCtx.api.deleteMessage(chatId, msgId); } catch {}
            try { await resolvedCtx.reply(formatAsHtml(finalText), { parse_mode: "HTML" }); } catch {}
        }
    } else {
        try { await resolvedCtx.reply(formatAsHtml(finalText), { parse_mode: "HTML" }); } catch {}
    }
}

export function cleanupTextState(sessionId: string): void {
    const state = sessionTextState.get(sessionId);
    if (state?.finalizeTimeout) {
        clearTimeout(state.finalizeTimeout);
    }
    sessionTextState.delete(sessionId);
}