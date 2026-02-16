import type { Session } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";

export type VerbosityLevel = 0 | 1 | 2 | 3;

export interface UserSession {
    userId: number;
    sessionId: string;
    session: Session;
    createdAt: Date;
    chatId?: number;
    lastMessageId?: number;
    currentAgent?: string;
    verbosity: VerbosityLevel;
    stream: boolean;
}
