import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionUpdatedEvent = Extract<Event, { type: "session.updated" }>;

export default async function sessionUpdatedHandler(
    event: SessionUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    return null;
}
