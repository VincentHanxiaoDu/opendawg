import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionCreatedEvent = Extract<Event, { type: "session.created" }>;

export default async function sessionCreatedHandler(
    event: SessionCreatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
