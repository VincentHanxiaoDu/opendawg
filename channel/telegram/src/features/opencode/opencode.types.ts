import type { Session } from "@opencode-ai/sdk/v2";

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
    lastTitle?: string;
    /** Whether this is the currently active session for the user */
    isActive: boolean;
    /** Server-side run status, updated from SSE events */
    serverStatus: "idle" | "busy" | "error";
}

export interface UserState {
    userId: number;
    /** All attached sessions for the current server (sessionId → UserSession) */
    sessions: Map<string, UserSession>;
    /** ID of the currently active session, or null if detached */
    activeSessionId: string | null;
    /** ID of the currently active server (from ServerRegistry) */
    activeServerId: string | null;
}
