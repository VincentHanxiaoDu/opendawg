import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type TuiToastShowEvent = Extract<Event, { type: "tui.toast.show" }>;

export default async function tuiToastShowHandler(
    event: TuiToastShowEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
