import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type PtyUpdatedEvent = Extract<Event, { type: "pty.updated" }>;

export default async function ptyUpdatedHandler(
    event: PtyUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
