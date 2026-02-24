import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml } from "./utils.js";
import {
    getActiveQuestionMessageId,
    setActiveQuestionMessageId,
    makeQCallback,
} from "./message-part-updated/tool-part.handler.js";

type QuestionAskedEvent = Extract<Event, { type: "question.asked" }>;

export default async function questionAskedHandler(
    event: QuestionAskedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const { id: requestID, sessionID, questions } = event.properties;
        if (!questions || questions.length === 0) return null;
        if (getActiveQuestionMessageId(userSession.sessionId)) return null;

        for (let qIdx = 0; qIdx < questions.length; qIdx++) {
            const q = questions[qIdx];
            const questionText = q.question || "Question";
            const header = q.header || "";
            const options: any[] = q.options || [];

            let msg = `❓ <b>${escapeHtml(header)}</b>\n\n${escapeHtml(questionText)}`;

            for (let i = 0; i < options.length; i++) {
                const opt = options[i];
                msg += `\n\n<b>${i + 1}. ${escapeHtml(opt.label)}</b>`;
                if (opt.description) {
                    msg += `\n${escapeHtml(opt.description)}`;
                }
            }

            const buttons = options.map((opt: any, i: number) => ({
                text: opt.label,
                callback_data: makeQCallback(sessionID, requestID, qIdx, String(i), opt.label),
            }));

            const rows: any[][] = [];
            for (let i = 0; i < buttons.length; i += 2) {
                rows.push(buttons.slice(i, i + 2));
            }
            rows.push([
                { text: "\u270d\ufe0f Custom", callback_data: makeQCallback(sessionID, requestID, qIdx, "custom", "") },
                { text: "\u23ed Skip", callback_data: makeQCallback(sessionID, requestID, qIdx, "skip", "") },
            ]);

            const sentMessage = await ctx.reply(msg, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: rows },
            });
            setActiveQuestionMessageId(userSession.sessionId, sentMessage.message_id);
        }
    } catch (error) {
        console.log("Error in question.asked handler:", error);
    }

    return null;
}
