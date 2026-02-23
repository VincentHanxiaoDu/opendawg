import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionCompactedEvent = Extract<Event, { type: "session.compacted" }>;

export default async function sessionCompactedHandler(
    event: SessionCompactedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
