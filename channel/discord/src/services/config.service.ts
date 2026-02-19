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
    }

    private parseDefaultServers(): DefaultServer[] {
        const urlsEnv = process.env.OPENCODE_SERVER_URLS || '';
        if (urlsEnv.trim()) {
            return urlsEnv
                .split(',')
                .map(entry => entry.trim())
                .filter(entry => entry.length > 0)
                .map(entry => {
                    const pipeIdx = entry.indexOf('|');
                    if (pipeIdx > 0) {
                        return { url: entry.substring(0, pipeIdx).trim(), name: entry.substring(pipeIdx + 1).trim() };
                    }
                    try {
                        const parsed = new URL(entry);
                        return { url: entry, name: parsed.host };
                    } catch {
                        return { url: entry, name: entry };
                    }
                });
        }

        const singleUrl = process.env.OPENCODE_SERVER_URL || '';
        if (singleUrl.trim()) {
            try {
                const parsed = new URL(singleUrl.trim());
                return [{ url: singleUrl.trim(), name: parsed.host }];
            } catch {
                return [{ url: singleUrl.trim(), name: 'Default' }];
            }
        }

        return [{ url: 'http://localhost:4096', name: 'Local' }];
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
