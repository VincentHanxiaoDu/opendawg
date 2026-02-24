/**
 * Telegram inline-keyboard pagination utility.
 *
 * Callback data format:  pg:<listId>:<page>
 *   e.g.  pg:sessions:2   (0-indexed page)
 *
 * Middle button "2/5" sends a force-reply prompt so the user can type a page
 * number.  The reply is intercepted by handlePageJumpReply().
 */

export const PAGE_SIZE = 8;
const CALLBACK_PREFIX = "pg:";
const JUMP_PREFIX = "pgj:"; // pgj:<listId>  — marks a pending jump

// ─── Page-jump state (user waiting to type a page number) ────────────────────
interface JumpState { listId: string; expiresAt: number }
const pendingJumps = new Map<number, JumpState>();
const JUMP_TTL_MS = 60_000; // 1 minute

export function setPendingJump(userId: number, listId: string): void {
    pendingJumps.set(userId, { listId, expiresAt: Date.now() + JUMP_TTL_MS });
}

export function consumePendingJump(userId: number): string | null {
    const entry = pendingJumps.get(userId);
    if (!entry) return null;
    pendingJumps.delete(userId);
    if (Date.now() > entry.expiresAt) return null;
    return entry.listId;
}

// ─── Keyboard builder ─────────────────────────────────────────────────────────

export function buildPageKeyboard(listId: string, page: number, totalPages: number) {
    if (totalPages <= 1) return undefined; // no keyboard needed

    const prevBtn = page > 0
        ? { text: "◀", callback_data: `${CALLBACK_PREFIX}${listId}:${page - 1}` }
        : { text: "·", callback_data: "pg_noop" };

    const jumpBtn = { text: `${page + 1}/${totalPages}`, callback_data: `${JUMP_PREFIX}${listId}` };

    const nextBtn = page < totalPages - 1
        ? { text: "▶", callback_data: `${CALLBACK_PREFIX}${listId}:${page + 1}` }
        : { text: "·", callback_data: "pg_noop" };

    return { inline_keyboard: [[prevBtn, jumpBtn, nextBtn]] };
}

// ─── Callback data parsers ────────────────────────────────────────────────────

/** Returns { listId, page } if data is a page-turn callback, else null */
export function parsePageCallback(data: string): { listId: string; page: number } | null {
    if (!data.startsWith(CALLBACK_PREFIX)) return null;
    const rest = data.slice(CALLBACK_PREFIX.length); // "sessions:2"
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) return null;
    const listId = rest.slice(0, lastColon);
    const page = parseInt(rest.slice(lastColon + 1), 10);
    if (isNaN(page)) return null;
    return { listId, page };
}

/** Returns listId if data is a page-jump trigger, else null */
export function parseJumpCallback(data: string): string | null {
    if (!data.startsWith(JUMP_PREFIX)) return null;
    return data.slice(JUMP_PREFIX.length);
}

export function totalPages(itemCount: number, pageSize = PAGE_SIZE): number {
    return Math.max(1, Math.ceil(itemCount / pageSize));
}

export function getPageSlice<T>(items: T[], page: number, pageSize = PAGE_SIZE): T[] {
    const start = page * pageSize;
    return items.slice(start, start + pageSize);
}
