import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type PtyCreatedEvent = Extract<Event, { type: "pty.created" }>;

export default async function ptyCreatedHandler(
    event: PtyCreatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
