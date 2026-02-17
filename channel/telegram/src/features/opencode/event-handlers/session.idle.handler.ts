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

    stopTypingIndicator();
    await finalizeTextMessage(ctx);
    await cleanupReasoningMessages(ctx);
    clearToolCallMessages();
    
    return null;
}
