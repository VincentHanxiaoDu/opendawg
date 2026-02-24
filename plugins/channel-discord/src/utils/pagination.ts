import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/**
 * Discord button-based pagination utility.
 *
 * CustomId format: pg:<listId>:<page>
 *   e.g. pg:sessions:2 (0-indexed page)
 */

export const PAGE_SIZE = 8;
const CALLBACK_PREFIX = "pg:";
const JUMP_PREFIX = "pgj:";

// Page-jump state (user waiting to type a page number)
interface JumpState { listId: string; expiresAt: number }
const pendingJumps = new Map<string, JumpState>();
const JUMP_TTL_MS = 60_000;

export function setPendingJump(userId: string, listId: string): void {
    pendingJumps.set(userId, { listId, expiresAt: Date.now() + JUMP_TTL_MS });
}

export function consumePendingJump(userId: string): string | null {
    const entry = pendingJumps.get(userId);
    if (!entry) return null;
    pendingJumps.delete(userId);
    if (Date.now() > entry.expiresAt) return null;
    return entry.listId;
}

/**
 * Builds a pagination row of buttons for Discord.
 * Returns undefined if only 1 page.
 */
export function buildPageButtons(
    listId: string,
    page: number,
    totalPagesCount: number
): ActionRowBuilder<ButtonBuilder> | undefined {
    if (totalPagesCount <= 1) return undefined;

    const prevBtn = new ButtonBuilder()
        .setCustomId(page > 0 ? `${CALLBACK_PREFIX}${listId}:${page - 1}` : "pg_noop")
        .setLabel("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0);

    const jumpBtn = new ButtonBuilder()
        .setCustomId(`${JUMP_PREFIX}${listId}`)
        .setLabel(`${page + 1}/${totalPagesCount}`)
        .setStyle(ButtonStyle.Secondary);

    const nextBtn = new ButtonBuilder()
        .setCustomId(page < totalPagesCount - 1 ? `${CALLBACK_PREFIX}${listId}:${page + 1}` : "pg_noop")
        .setLabel("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPagesCount - 1);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, jumpBtn, nextBtn);
}

/** Returns { listId, page } if customId is a page-turn callback, else null */
export function parsePageCallback(data: string): { listId: string; page: number } | null {
    if (!data.startsWith(CALLBACK_PREFIX)) return null;
    const rest = data.slice(CALLBACK_PREFIX.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) return null;
    const listId = rest.slice(0, lastColon);
    const page = parseInt(rest.slice(lastColon + 1), 10);
    if (isNaN(page)) return null;
    return { listId, page };
}

/** Returns listId if customId is a page-jump trigger, else null */
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
