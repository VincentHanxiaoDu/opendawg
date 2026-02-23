import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionDiffEvent = Extract<Event, { type: "session.diff" }>;

export default async function sessionDiffHandler(
    event: SessionDiffEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
