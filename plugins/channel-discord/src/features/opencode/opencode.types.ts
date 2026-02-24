import type { Session } from "@opencode-ai/sdk/v2";

export type VerbosityLevel = 0 | 1 | 2 | 3;

export interface UserSession {
    userId: string;
    sessionId: string;
    session: Session;
    createdAt: Date;
    /** Discord channel ID where the user last interacted */
    channelId?: string;
    /** Last Discord message ID sent by the bot */
    lastMessageId?: string;
    currentAgent?: string;
    verbosity: VerbosityLevel;
    stream: boolean;
    lastTitle?: string;
    /** Whether this is the currently active session for the user */
    isActive: boolean;
    /** Server-side run status, updated from SSE events */
    serverStatus: "idle" | "busy" | "error";
    /** Last error message from a session.error event */
    lastError?: string;
    /** Whether TTS mode is enabled for this session (AI replies sent as voice messages) */
    ttsEnabled: boolean;
    /** Accumulated text for TTS synthesis, reset after each session.idle */
    pendingTtsText: string;
    /** Discord guild ID where the user is interacting (for voice channel routing) */
    guildId?: string;
}

export interface UserState {
    userId: string;
    /** All attached sessions for the current server (sessionId → UserSession) */
    sessions: Map<string, UserSession>;
    /** ID of the currently active session, or null if detached */
    activeSessionId: string | null;
    /** ID of the currently active server (from ServerRegistry) */
    activeServerId: string | null;
}
