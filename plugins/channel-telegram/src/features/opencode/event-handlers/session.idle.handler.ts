import type { Event } from "@opencode-ai/sdk/v2";
import { InputFile, type Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { cleanupReasoningMessages } from "./message-part-updated/reasoning-part.handler.js";
import { finalizeTextMessage } from "./message-part-updated/text-part.handler.js";
import { clearToolCallMessages } from "./message-part-updated/tool-part.handler.js";
import { stopTypingIndicator } from "./utils.js";
import { splitForTts, type VoiceProvider } from "../../../services/voice.service.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

type SessionIdleEvent = Extract<Event, { type: "session.idle" }>;

/** Module-level voice provider registry, set by OpenCodeBot on initialization */
let _voiceProvider: VoiceProvider | null = null;

export function setVoiceProvider(vp: VoiceProvider | null): void {
    _voiceProvider = vp;
}

export default async function sessionIdleHandler(
    event: SessionIdleEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);

    const { sessionId } = userSession;
    stopTypingIndicator(sessionId);
    await finalizeTextMessage(sessionId, ctx);
    await cleanupReasoningMessages(sessionId, ctx);

    // Delay clearing tool messages to allow in-flight "completed" part events to
    // arrive and edit their existing Telegram messages before the map is wiped.
    setTimeout(() => clearToolCallMessages(sessionId), 3000);

    // ── TTS synthesis ──────────────────────────────────────────────────────
    if (userSession.ttsEnabled && _voiceProvider && userSession.pendingTtsText.trim()) {
        const textToSpeak = userSession.pendingTtsText;
        userSession.pendingTtsText = "";

        // Run TTS async — don't block the session.idle completion
        synthesizeAndSend(ctx, textToSpeak, _voiceProvider).catch(err => {
            console.error("[TTS] synthesis error:", err);
        });
    } else {
        userSession.pendingTtsText = "";
    }

    return null;
}

async function synthesizeAndSend(ctx: Context, text: string, voiceProvider: VoiceProvider): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const replyToMessageId = ctx.message?.message_id;

    const chunks = splitForTts(text);
    const tmpFiles: string[] = [];

    try {
        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const mp3Buffer = await voiceProvider.synthesize(chunk);
            const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
            fs.writeFileSync(tmpPath, mp3Buffer);
            tmpFiles.push(tmpPath);
            await ctx.api.sendVoice(chatId, new InputFile(tmpPath), {
                reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
            });
        }
    } finally {
        // Clean up temp files
        for (const f of tmpFiles) {
            try { fs.unlinkSync(f); } catch {}
        }
    }
}
