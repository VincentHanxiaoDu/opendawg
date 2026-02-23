import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionDeletedEvent = Extract<Event, { type: "session.deleted" }>;

export default async function sessionDeletedHandler(
    event: SessionDeletedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
