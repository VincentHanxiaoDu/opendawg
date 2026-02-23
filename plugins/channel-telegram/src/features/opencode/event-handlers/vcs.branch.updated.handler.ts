import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type VcsBranchUpdatedEvent = Extract<Event, { type: "vcs.branch.updated" }>;

export default async function vcsBranchUpdatedHandler(
    event: VcsBranchUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
