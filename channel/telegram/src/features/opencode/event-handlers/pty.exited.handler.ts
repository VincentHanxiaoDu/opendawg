import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type PtyExitedEvent = Extract<Event, { type: "pty.exited" }>;

export default async function ptyExitedHandler(
    event: PtyExitedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
