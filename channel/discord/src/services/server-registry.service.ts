import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

export interface ServerRecord {
    id: string;
    userId: string;
    url: string;
    name: string;
    isActive: boolean;
    createdAt: number;
    username?: string;
    password?: string;
}

export interface DefaultServer {
    url: string;
    name: string;
    username?: string;
    password?: string;
}

/**
 * ServerRegistry persists per-user opencode server lists in SQLite.
 * Falls back to in-memory mode if the /data directory is not writable.
 */
export class ServerRegistry {
    private db: import("better-sqlite3").Database | null = null;
    private memoryStore: Map<string, ServerRecord[]> = new Map();
    private isMemoryMode = false;
    private defaultServers: DefaultServer[];
    private dbPath: string;

    constructor(defaultServers: DefaultServer[], dbPath = "/data/discordcoder.db") {
        this.defaultServers = defaultServers;
        this.dbPath = dbPath;
        this.init();
    }

    private init(): void {
        const dataDir = path.dirname(this.dbPath);
        try {
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const testFile = path.join(dataDir, ".write_test");
            fs.writeFileSync(testFile, "");
            fs.unlinkSync(testFile);

            const Database = _require("better-sqlite3") as typeof import("better-sqlite3");
            this.db = new Database(this.dbPath);
            this.createSchema();
            console.log(`[ServerRegistry] SQLite DB at ${this.dbPath}`);
        } catch (err) {
            console.warn(`[ServerRegistry] Cannot open SQLite DB (${err}), using in-memory mode`);
            this.isMemoryMode = true;
        }
    }

    private createSchema(): void {
        if (!this.db) return;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS servers (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                url        TEXT NOT NULL,
                name       TEXT NOT NULL,
                is_active  INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);
        `);
        // Migrate: add credential columns if they don't exist (safe for existing DBs)
        try { this.db.exec("ALTER TABLE servers ADD COLUMN username TEXT"); } catch {}
        try { this.db.exec("ALTER TABLE servers ADD COLUMN password TEXT"); } catch {}
    }

    private ensureUserDefaults(userId: string): void {
        const existing = this.listByUser(userId);
        if (existing.length > 0) return;

        const servers = this.defaultServers.length > 0
            ? this.defaultServers
            : [{ url: "http://localhost:4096", name: "Local" }];

        servers.forEach((s, i) => {
            this.add(userId, s.url, s.name, i === 0, s.username, s.password);
        });
    }

    listByUser(userId: string): ServerRecord[] {
        if (this.isMemoryMode) {
            return this.memoryStore.get(userId) ?? [];
        }
        if (!this.db) return [];
        const rows = this.db.prepare(
            "SELECT id, user_id, url, name, is_active, created_at, username, password FROM servers WHERE user_id = ? ORDER BY created_at ASC"
        ).all(userId) as any[];
        return rows.map(r => ({
            id: r.id,
            userId: r.user_id,
            url: r.url,
            name: r.name,
            isActive: r.is_active === 1,
            createdAt: r.created_at,
            username: r.username || undefined,
            password: r.password || undefined,
        }));
    }

    listByUserWithDefaults(userId: string): ServerRecord[] {
        this.ensureUserDefaults(userId);
        return this.listByUser(userId);
    }

    getActive(userId: string): ServerRecord | null {
        this.ensureUserDefaults(userId);
        const servers = this.listByUser(userId);
        return servers.find(s => s.isActive) ?? null;
    }

    getById(userId: string, serverId: string): ServerRecord | null {
        const servers = this.listByUser(userId);
        const exact = servers.find(s => s.id === serverId);
        if (exact) return exact;
        if (serverId.length >= 4) {
            const prefix = servers.filter(s => s.id.startsWith(serverId));
            if (prefix.length === 1) return prefix[0];
        }
        return null;
    }

    add(userId: string, url: string, name?: string, makeActive = false, username?: string, password?: string): ServerRecord {
        const { nanoid } = _require("nanoid") as typeof import("nanoid");
        const id = nanoid(8);
        const resolvedName = name || new URL(url).host;
        const now = Math.floor(Date.now() / 1000);

        const record: ServerRecord = {
            id,
            userId,
            url,
            name: resolvedName,
            isActive: makeActive,
            createdAt: now,
            username: username || undefined,
            password: password || undefined,
        };

        if (this.isMemoryMode) {
            const list = this.memoryStore.get(userId) ?? [];
            if (makeActive) list.forEach(s => (s.isActive = false));
            list.push(record);
            this.memoryStore.set(userId, list);
            return record;
        }

        if (!this.db) return record;
        if (makeActive) {
            this.db.prepare("UPDATE servers SET is_active = 0 WHERE user_id = ?").run(userId);
        }
        this.db.prepare(
            "INSERT INTO servers (id, user_id, url, name, is_active, created_at, username, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, userId, url, resolvedName, makeActive ? 1 : 0, now, username || null, password || null);
        return record;
    }

    remove(userId: string, serverId: string): boolean {
        const record = this.getById(userId, serverId);
        if (!record) return false;

        if (this.isMemoryMode) {
            const list = (this.memoryStore.get(userId) ?? []).filter(s => s.id !== record.id);
            this.memoryStore.set(userId, list);
            return true;
        }
        if (!this.db) return false;
        this.db.prepare("DELETE FROM servers WHERE id = ? AND user_id = ?").run(record.id, userId);
        return true;
    }

    setActive(userId: string, serverId: string): ServerRecord | null {
        const record = this.getById(userId, serverId);
        if (!record) return null;

        if (this.isMemoryMode) {
            const list = this.memoryStore.get(userId) ?? [];
            list.forEach(s => (s.isActive = s.id === record.id));
            this.memoryStore.set(userId, list);
            return { ...record, isActive: true };
        }
        if (!this.db) return null;
        this.db.prepare("UPDATE servers SET is_active = 0 WHERE user_id = ?").run(userId);
        this.db.prepare("UPDATE servers SET is_active = 1 WHERE id = ? AND user_id = ?").run(record.id, userId);
        return { ...record, isActive: true };
    }

    findByUrl(userId: string, url: string): ServerRecord | null {
        const servers = this.listByUser(userId);
        return servers.find(s => s.url === url) ?? null;
    }

    findByIdPrefix(userId: string, prefix: string): ServerRecord[] {
        const servers = this.listByUser(userId);
        return servers.filter(s => s.id.startsWith(prefix));
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
