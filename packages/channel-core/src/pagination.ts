// ─────────────────────────────────────────────────────────────────────────────
// Generic pagination utilities (no UI framework dependency)
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 8;

const CALLBACK_PREFIX = "pg:";
const JUMP_PREFIX = "pgj:";

// ─── Page-jump state ─────────────────────────────────────────────────────────

interface JumpState {
    listId: string;
    expiresAt: number;
}

const pendingJumps = new Map<string, JumpState>();
const JUMP_TTL_MS = 60_000; // 1 minute

/**
 * Record that a user is about to type a page number.
 * @param userId  The user ID (string — works for any platform).
 * @param listId  Identifies which paginated list this jump is for.
 */
export function setPendingJump(userId: string, listId: string): void {
    pendingJumps.set(userId, { listId, expiresAt: Date.now() + JUMP_TTL_MS });
}

/**
 * Consume (and clear) a pending page-jump for the user.
 * @returns The `listId` if a valid pending jump exists, otherwise `null`.
 */
export function consumePendingJump(userId: string): string | null {
    const entry = pendingJumps.get(userId);
    if (!entry) return null;
    pendingJumps.delete(userId);
    if (Date.now() > entry.expiresAt) return null;
    return entry.listId;
}

// ─── Data-only button descriptors ────────────────────────────────────────────

/**
 * A platform-agnostic description of a pagination button.
 * Channel adapters convert these into framework-specific UI elements
 * (Telegram InlineKeyboard, Discord ButtonBuilder, etc.).
 */
export interface PageButton {
    /** Display label. */
    label: string;
    /** Callback data string attached to the button. */
    callbackData: string;
    /** If true the button should appear greyed-out / non-interactive. */
    disabled: boolean;
}

/**
 * Build pagination button descriptors (prev, counter, next).
 *
 * Returns `null` when there is only one page (no buttons needed).
 *
 * @param listId      Identifies the paginated list.
 * @param page        Current 0-indexed page number.
 * @param totalPages  Total number of pages.
 */
export function buildPageButtons(
    listId: string,
    page: number,
    totalPagesCount: number,
): PageButton[] | null {
    if (totalPagesCount <= 1) return null;

    const prevBtn: PageButton = {
        label: "\u25C0", // ◀
        callbackData: page > 0 ? `${CALLBACK_PREFIX}${listId}:${page - 1}` : "pg_noop",
        disabled: page <= 0,
    };

    const jumpBtn: PageButton = {
        label: `${page + 1}/${totalPagesCount}`,
        callbackData: `${JUMP_PREFIX}${listId}`,
        disabled: false,
    };

    const nextBtn: PageButton = {
        label: "\u25B6", // ▶
        callbackData: page < totalPagesCount - 1
            ? `${CALLBACK_PREFIX}${listId}:${page + 1}`
            : "pg_noop",
        disabled: page >= totalPagesCount - 1,
    };

    return [prevBtn, jumpBtn, nextBtn];
}

// ─── Callback data parsers ───────────────────────────────────────────────────

/** Returns `{ listId, page }` if `data` is a page-turn callback, else `null`. */
export function parsePageCallback(data: string): { listId: string; page: number } | null {
    if (!data.startsWith(CALLBACK_PREFIX)) return null;
    const rest = data.slice(CALLBACK_PREFIX.length); // e.g. "sessions:2"
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) return null;
    const listId = rest.slice(0, lastColon);
    const page = parseInt(rest.slice(lastColon + 1), 10);
    if (isNaN(page)) return null;
    return { listId, page };
}

/** Returns `listId` if `data` is a page-jump trigger, else `null`. */
export function parseJumpCallback(data: string): string | null {
    if (!data.startsWith(JUMP_PREFIX)) return null;
    return data.slice(JUMP_PREFIX.length);
}

// ─── Arithmetic helpers ──────────────────────────────────────────────────────

export function totalPages(itemCount: number, pageSize = PAGE_SIZE): number {
    return Math.max(1, Math.ceil(itemCount / pageSize));
}

export function getPageSlice<T>(items: T[], page: number, pageSize = PAGE_SIZE): T[] {
    const start = page * pageSize;
    return items.slice(start, start + pageSize);
}
