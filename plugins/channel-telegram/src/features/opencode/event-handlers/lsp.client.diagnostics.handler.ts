import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type LspClientDiagnosticsEvent = Extract<Event, { type: "lsp.client.diagnostics" }>;

export default async function lspClientDiagnosticsHandler(
    event: LspClientDiagnosticsEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
