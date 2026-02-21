import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { cleanupReasoningMessages } from "./message-part-updated/reasoning-part.handler.js";
import { finalizeTextMessage } from "./message-part-updated/text-part.handler.js";
import { clearToolCallMessages } from "./message-part-updated/tool-part.handler.js";
import { stopTypingIndicator } from "./utils.js";

type SessionIdleEvent = Extract<Event, { type: "session.idle" }>;

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
    // Without this delay, session.idle can race ahead of the final tool part
    // update, causing the completed event to re-send a duplicate message.
    setTimeout(() => clearToolCallMessages(sessionId), 3000);
    
    return null;
}
