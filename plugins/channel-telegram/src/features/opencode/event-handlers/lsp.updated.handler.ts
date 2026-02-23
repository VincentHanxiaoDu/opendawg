import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type LspUpdatedEvent = Extract<Event, { type: "lsp.updated" }>;

export default async function lspUpdatedHandler(
    event: LspUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
