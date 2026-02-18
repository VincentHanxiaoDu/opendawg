import type { DefaultServer } from "./server-registry.service.js";

/**
 * Configuration Service
 * 
 * Centralizes all environment variable access and provides type-safe
 * configuration management for bot instances.
 */
export class ConfigService {
    // Telegram Configuration
    private readonly telegramBotTokens: string[];
    private readonly allowedUserIds: number[];
    private readonly adminUserId: number | undefined;
    private readonly autoKill: boolean;

    // Media Configuration
    private readonly mediaTmpLocation: string;
    private readonly cleanUpMediaDir: boolean;

    // Message Configuration
    private readonly messageDeleteTimeout: number;

    // System Environment
    private readonly homeDirectory: string;
    private readonly systemEnv: { [key: string]: string };

    // Server Configuration
    private readonly defaultServers: DefaultServer[];

    constructor() {
        // Load and parse Telegram bot tokens
        this.telegramBotTokens = (process.env.TELEGRAM_BOT_TOKENS || '')
            .split(',')
            .map(token => token.trim())
            .filter(token => token.length > 0);

        // Load and parse allowed user IDs
        const allowedIds = process.env.ALLOWED_USER_IDS || '';
        this.allowedUserIds = allowedIds
            .split(',')
            .map(id => id.trim())
            .filter(id => id.length > 0)
            .map(id => parseInt(id, 10))
            .filter(id => !isNaN(id));

        // Load admin user ID
        const adminId = process.env.ADMIN_USER_ID || '';
        this.adminUserId = adminId.trim().length > 0 ? parseInt(adminId.trim(), 10) : undefined;
        if (this.adminUserId && isNaN(this.adminUserId)) {
            this.adminUserId = undefined;
        }

        // Load auto-kill setting
        const autoKillValue = process.env.AUTO_KILL?.toLowerCase();
        this.autoKill = autoKillValue === 'true' || autoKillValue === '1';

        // Load media configuration
        this.mediaTmpLocation = process.env.MEDIA_TMP_LOCATION || '/tmp/telegramcoder_media';
        const cleanUpValue = process.env.CLEAN_UP_MEDIADIR?.toLowerCase();
        this.cleanUpMediaDir = cleanUpValue === 'true' || cleanUpValue === '1';

        // Load message configuration
        this.messageDeleteTimeout = parseInt(process.env.MESSAGE_DELETE_TIMEOUT || '10000', 10);

        // Load system environment
        this.homeDirectory = process.env.HOME || '/tmp';
        this.systemEnv = process.env as { [key: string]: string };

        // Load default servers from environment variables
        // OPENCODE_SERVER_URLS takes precedence, falls back to OPENCODE_SERVER_URL
        this.defaultServers = this.parseDefaultServers();
    }

    private parseDefaultServers(): DefaultServer[] {
        const urlsEnv = process.env.OPENCODE_SERVER_URLS || '';
        if (urlsEnv.trim()) {
            // Format: "url1|name1,url2|name2" or just "url1,url2"
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

        // Fallback: OPENCODE_SERVER_URL (legacy single-server variable)
        const singleUrl = process.env.OPENCODE_SERVER_URL || '';
        if (singleUrl.trim()) {
            try {
                const parsed = new URL(singleUrl.trim());
                return [{ url: singleUrl.trim(), name: parsed.host }];
            } catch {
                return [{ url: singleUrl.trim(), name: 'Default' }];
            }
        }

        // Final fallback
        return [{ url: 'http://localhost:4096', name: 'Local' }];
    }

    // Telegram Configuration Getters
    getTelegramBotTokens(): string[] {
        return [...this.telegramBotTokens];
    }

    getAllowedUserIds(): number[] {
        return [...this.allowedUserIds];
    }

    getAdminUserId(): number | undefined {
        return this.adminUserId;
    }

    isAutoKillEnabled(): boolean {
        return this.autoKill;
    }

    // Media Configuration Getters
    getMediaTmpLocation(): string {
        return this.mediaTmpLocation;
    }

    shouldCleanUpMediaDir(): boolean {
        return this.cleanUpMediaDir;
    }

    // Message Configuration Getters
    getMessageDeleteTimeout(): number {
        return this.messageDeleteTimeout;
    }

    // System Environment Getters
    getHomeDirectory(): string {
        return this.homeDirectory;
    }

    getSystemEnv(): { [key: string]: string } {
        return { ...this.systemEnv };
    }

    // Validation
    validate(): void {
        if (this.telegramBotTokens.length === 0) {
            throw new Error('No bot tokens found in TELEGRAM_BOT_TOKENS environment variable');
        }

        if (this.allowedUserIds.length === 0) {
            console.warn('Warning: No allowed user IDs configured. Consider setting ALLOWED_USER_IDS.');
        }
    }

    getDefaultServers(): DefaultServer[] {
        return [...this.defaultServers];
    }

    // Debug information
    getDebugInfo(): string {
        return `ConfigService:
  - Bot Tokens: ${this.telegramBotTokens.length}
  - Allowed Users: ${this.allowedUserIds.length}
  - Admin User ID: ${this.adminUserId || 'Not set'}
  - Auto Kill: ${this.autoKill}
  - Media Location: ${this.mediaTmpLocation}
  - Clean Up Media Dir: ${this.cleanUpMediaDir}
  - Message Delete Timeout: ${this.messageDeleteTimeout}ms
  - Default Servers: ${this.defaultServers.map(s => `${s.name}(${s.url})`).join(', ')}`;
    }
}
