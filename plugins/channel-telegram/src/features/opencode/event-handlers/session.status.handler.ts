import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionStatusEvent = Extract<Event, { type: "session.status" }>;

export default async function sessionStatusHandler(
    event: SessionStatusEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);

    // serverStatus is updated in processEvent before this handler is called.
    // Send typing indicator to keep the chat feeling responsive.
    try {
        if (userSession.chatId) {
            await ctx.api.sendChatAction(userSession.chatId, "typing");
        }
    } catch {}
    
    return null;
}
