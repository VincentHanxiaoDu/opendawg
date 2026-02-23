import type { DefaultServer } from "./server-registry.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Channel configuration interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Voice-related configuration values.
 */
export interface VoiceConfig {
    provider: string;
    sttModel: string;
    ttsModel: string;
    ttsVoice: string;
    enabled: boolean;
}

/**
 * Platform-agnostic channel configuration.
 *
 * Each channel adapter (Telegram, Discord, …) should construct this from its
 * own environment variables and pass it to the shared services.  The shared
 * ConfigService never reads `process.env` directly — it only works with this
 * typed interface.
 */
export interface ChannelConfigInit {
    /** IDs of users allowed to interact with the bot (string form). */
    allowedUserIds: string[];
    /** Optional admin user ID (receives security notifications, etc.). */
    adminUserId?: string;
    /** Kill the worker on unauthorized access? */
    autoKill?: boolean;

    /** Directory for temporary media files. */
    mediaTmpLocation?: string;
    /** Delete media temp dir on cleanup? */
    cleanUpMediaDir?: boolean;

    /** Auto-delete notification messages after this many ms (0 = never). */
    messageDeleteTimeout?: number;

    /** User's HOME directory (used for child process env). */
    homeDirectory?: string;

    /** Pre-parsed default server list. */
    defaultServers?: DefaultServer[];

    /** Voice feature config. */
    voice?: Partial<VoiceConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared ConfigService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Platform-agnostic configuration service.
 *
 * Channels instantiate this with a {@link ChannelConfigInit} built from their
 * own env vars / framework config.  All shared logic (server-registry, voice,
 * access-control) consumes this service — **not** raw `process.env`.
 */
export class ConfigService {
    private readonly allowedUserIds: string[];
    private readonly adminUserId: string | undefined;
    private readonly autoKill: boolean;

    private readonly mediaTmpLocation: string;
    private readonly cleanUpMediaDir: boolean;

    private readonly messageDeleteTimeout: number;

    private readonly homeDirectory: string;

    private readonly defaultServers: DefaultServer[];

    private readonly voiceProvider: string;
    private readonly voiceSttModel: string;
    private readonly voiceTtsModel: string;
    private readonly voiceTtsVoice: string;
    private readonly voiceEnabled: boolean;

    constructor(init: ChannelConfigInit) {
        this.allowedUserIds = [...init.allowedUserIds];
        this.adminUserId = init.adminUserId;
        this.autoKill = init.autoKill ?? false;

        this.mediaTmpLocation = init.mediaTmpLocation ?? "/tmp/channel_media";
        this.cleanUpMediaDir = init.cleanUpMediaDir ?? false;

        this.messageDeleteTimeout = init.messageDeleteTimeout ?? 10_000;

        this.homeDirectory = init.homeDirectory ?? "/tmp";

        this.defaultServers = init.defaultServers
            ? [...init.defaultServers]
            : ConfigService.parseDefaultServersFromEnv();

        this.voiceProvider = (init.voice?.provider ?? "openai").toLowerCase();
        this.voiceSttModel = init.voice?.sttModel ?? "whisper-1";
        this.voiceTtsModel = init.voice?.ttsModel ?? "tts-1";
        this.voiceTtsVoice = init.voice?.ttsVoice ?? "alloy";
        this.voiceEnabled = init.voice?.enabled ?? false;
    }

    // ── Static helper: parse OPENCODE_SERVER_URLS / OPENCODE_SERVER_URL ──────

    /**
     * Parse default servers from well-known environment variables.
     * Channels can call this if they don't want to do their own parsing.
     *
     * Format for `OPENCODE_SERVER_URLS`:
     *   `url1|name1|user1|pass1,url2|name2`
     *
     * Falls back to `OPENCODE_SERVER_URL` (single), then `http://localhost:4096`.
     */
    static parseDefaultServersFromEnv(): DefaultServer[] {
        const urlsEnv = process.env.OPENCODE_SERVER_URLS ?? "";
        if (urlsEnv.trim()) {
            return urlsEnv
                .split(",")
                .map(entry => entry.trim())
                .filter(entry => entry.length > 0)
                .map(entry => {
                    const parts = entry.split("|");
                    const url = parts[0].trim();
                    const name = parts[1]?.trim() || (() => {
                        try { return new URL(url).host; } catch { return url; }
                    })();
                    const username = parts[2]?.trim() || undefined;
                    const password = parts[3]?.trim() || undefined;
                    return { url, name, username, password };
                });
        }

        // Legacy single-server variable
        const singleUrl = process.env.OPENCODE_SERVER_URL ?? "";
        const envUsername = process.env.OPENCODE_SERVER_USERNAME?.trim() || undefined;
        const envPassword = process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined;
        if (singleUrl.trim()) {
            try {
                const parsed = new URL(singleUrl.trim());
                return [{ url: singleUrl.trim(), name: parsed.host, username: envUsername, password: envPassword }];
            } catch {
                return [{ url: singleUrl.trim(), name: "Default", username: envUsername, password: envPassword }];
            }
        }

        return [{ url: "http://localhost:4096", name: "Local", username: envUsername, password: envPassword }];
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    getAllowedUserIds(): string[] {
        return [...this.allowedUserIds];
    }

    getAdminUserId(): string | undefined {
        return this.adminUserId;
    }

    isAutoKillEnabled(): boolean {
        return this.autoKill;
    }

    getMediaTmpLocation(): string {
        return this.mediaTmpLocation;
    }

    shouldCleanUpMediaDir(): boolean {
        return this.cleanUpMediaDir;
    }

    getMessageDeleteTimeout(): number {
        return this.messageDeleteTimeout;
    }

    getHomeDirectory(): string {
        return this.homeDirectory;
    }

    getDefaultServers(): DefaultServer[] {
        return [...this.defaultServers];
    }

    getVoiceProvider(): string {
        return this.voiceProvider;
    }

    getVoiceSttModel(): string {
        return this.voiceSttModel;
    }

    getVoiceTtsModel(): string {
        return this.voiceTtsModel;
    }

    getVoiceTtsVoice(): string {
        return this.voiceTtsVoice;
    }

    isVoiceEnabled(): boolean {
        return this.voiceEnabled;
    }

    // ── Validation ───────────────────────────────────────────────────────────

    /**
     * Validates shared configuration.  Channel adapters should call this after
     * construction to surface misconfigurations early.
     */
    validate(): void {
        if (this.allowedUserIds.length === 0) {
            console.warn("Warning: No allowed user IDs configured. Consider setting ALLOWED_USER_IDS.");
        }
    }

    // ── Debug ────────────────────────────────────────────────────────────────

    getDebugInfo(): string {
        return [
            "ConfigService:",
            `  - Allowed Users: ${this.allowedUserIds.length}`,
            `  - Admin User ID: ${this.adminUserId ?? "Not set"}`,
            `  - Auto Kill: ${this.autoKill}`,
            `  - Media Location: ${this.mediaTmpLocation}`,
            `  - Clean Up Media Dir: ${this.cleanUpMediaDir}`,
            `  - Message Delete Timeout: ${this.messageDeleteTimeout}ms`,
            `  - Default Servers: ${this.defaultServers.map(s => `${s.name}(${s.url})`).join(", ")}`,
            `  - Voice Provider: ${this.voiceProvider}`,
            `  - Voice Enabled: ${this.voiceEnabled}`,
        ].join("\n");
    }
}
