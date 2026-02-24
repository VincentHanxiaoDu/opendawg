import type { DefaultServer } from "./server-registry.service.js";

/**
 * Configuration Service for the Discord connector.
 * Centralizes all environment variable access and provides type-safe
 * configuration management.
 */
export class ConfigService {
    private readonly discordBotToken: string;
    private readonly discordAppId: string;
    private readonly allowedUserIds: string[];
    private readonly adminUserId: string | undefined;
    private readonly autoKill: boolean;

    private readonly mediaTmpLocation: string;
    private readonly cleanUpMediaDir: boolean;

    private readonly messageDeleteTimeout: number;

    private readonly homeDirectory: string;

    private readonly defaultServers: DefaultServer[];

    // Voice Configuration
    private readonly voiceProvider: string;
    private readonly voiceSttModel: string;
    private readonly voiceTtsModel: string;
    private readonly voiceTtsVoice: string;
    private readonly voiceEnabled: boolean;

    constructor() {
        this.discordBotToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
        this.discordAppId = (process.env.DISCORD_APP_ID || '').trim();

        this.allowedUserIds = (process.env.ALLOWED_USER_IDS || '')
            .split(',')
            .map(id => id.trim())
            .filter(id => id.length > 0);

        const adminId = (process.env.ADMIN_USER_ID || '').trim();
        this.adminUserId = adminId.length > 0 ? adminId : undefined;

        const autoKillValue = process.env.AUTO_KILL?.toLowerCase();
        this.autoKill = autoKillValue === 'true' || autoKillValue === '1';

        this.mediaTmpLocation = process.env.MEDIA_TMP_LOCATION || '/tmp/discordcoder_media';
        const cleanUpValue = process.env.CLEAN_UP_MEDIADIR?.toLowerCase();
        this.cleanUpMediaDir = cleanUpValue === 'true' || cleanUpValue === '1';

        this.messageDeleteTimeout = parseInt(process.env.MESSAGE_DELETE_TIMEOUT || '10000', 10);

        this.homeDirectory = process.env.HOME || '/tmp';

        this.defaultServers = this.parseDefaultServers();

        // Load voice configuration
        this.voiceProvider = (process.env.VOICE_PROVIDER || 'openai').trim().toLowerCase();
        this.voiceSttModel = (process.env.VOICE_STT_MODEL || 'whisper-1').trim();
        this.voiceTtsModel = (process.env.VOICE_TTS_MODEL || 'tts-1').trim();
        this.voiceTtsVoice = (process.env.VOICE_TTS_VOICE || 'alloy').trim();
        const hasApiKey = !!(
            process.env.OPENAI_API_KEY ||
            process.env.AZURE_OPENAI_API_KEY ||
            process.env.GOOGLE_API_KEY ||
            process.env.GOOGLE_APPLICATION_CREDENTIALS
        );
        this.voiceEnabled = hasApiKey;
    }

    private parseDefaultServers(): DefaultServer[] {
        const urlsEnv = process.env.OPENCODE_SERVER_URLS || '';
        if (urlsEnv.trim()) {
            // Format: "url1|name1|username1|password1,url2|name2" or just "url1,url2"
            return urlsEnv
                .split(',')
                .map(entry => entry.trim())
                .filter(entry => entry.length > 0)
                .map(entry => {
                    const parts = entry.split('|');
                    const url = parts[0].trim();
                    const name = parts[1]?.trim() || (() => {
                        try { return new URL(url).host; } catch { return url; }
                    })();
                    const username = parts[2]?.trim() || undefined;
                    const password = parts[3]?.trim() || undefined;
                    return { url, name, username, password };
                });
        }

        // Fallback: OPENCODE_SERVER_URL (legacy single-server variable)
        // Also read OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD for auth
        const singleUrl = process.env.OPENCODE_SERVER_URL || '';
        const envUsername = process.env.OPENCODE_SERVER_USERNAME?.trim() || undefined;
        const envPassword = process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined;
        if (singleUrl.trim()) {
            try {
                const parsed = new URL(singleUrl.trim());
                return [{ url: singleUrl.trim(), name: parsed.host, username: envUsername, password: envPassword }];
            } catch {
                return [{ url: singleUrl.trim(), name: 'Default', username: envUsername, password: envPassword }];
            }
        }

        // Final fallback — still apply env credentials if set
        return [{ url: 'http://localhost:4096', name: 'Local', username: envUsername, password: envPassword }];
    }

    getDiscordBotToken(): string {
        return this.discordBotToken;
    }

    getDiscordAppId(): string {
        return this.discordAppId;
    }

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

    // Voice Configuration Getters
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

    validate(): void {
        if (!this.discordBotToken) {
            throw new Error('No bot token found in DISCORD_BOT_TOKEN environment variable');
        }

        if (this.allowedUserIds.length === 0) {
            console.warn('Warning: No allowed user IDs configured. Consider setting ALLOWED_USER_IDS.');
        }
    }

    getDebugInfo(): string {
        return `ConfigService:
  - Bot Token: ${this.discordBotToken ? 'set' : 'NOT SET'}
  - App ID: ${this.discordAppId || 'Not set'}
  - Allowed Users: ${this.allowedUserIds.length}
  - Admin User ID: ${this.adminUserId || 'Not set'}
  - Auto Kill: ${this.autoKill}
  - Media Location: ${this.mediaTmpLocation}
  - Clean Up Media Dir: ${this.cleanUpMediaDir}
  - Message Delete Timeout: ${this.messageDeleteTimeout}ms
  - Default Servers: ${this.defaultServers.map(s => `${s.name}(${s.url})`).join(', ')}`;
    }
}
