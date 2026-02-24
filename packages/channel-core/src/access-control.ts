// ─────────────────────────────────────────────────────────────────────────────
// Platform-agnostic access control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of an access check.
 *
 * Channel adapters inspect `allowed` and use the other fields to decide
 * how to respond (deny message, admin notification, auto-kill, etc.).
 */
export interface AccessResult {
    /** Whether the user is allowed to proceed. */
    allowed: boolean;
    /** Whether the user is the admin. */
    isAdmin: boolean;
    /** If denied — should the worker self-terminate? */
    autoKill: boolean;
}

/**
 * Pure, framework-agnostic access check.
 *
 * @param userId      The user ID to check (string form — works for any platform).
 * @param allowedIds  The set of allowed user IDs.
 * @param adminId     Optional admin user ID. If not provided, the first
 *                    entry in `allowedIds` is treated as the admin.
 * @param autoKill    Whether the bot should self-terminate on unauthorized access.
 * @returns An {@link AccessResult} describing the decision.
 *
 * @example
 * ```ts
 * const result = checkAccess(userId, config.getAllowedUserIds(), config.getAdminUserId(), config.isAutoKillEnabled());
 * if (!result.allowed) {
 *   // send platform-specific denial message …
 *   if (result.autoKill) process.exit(1);
 * }
 * ```
 */
export function checkAccess(
    userId: string,
    allowedIds: string[],
    adminId?: string,
    autoKill = false,
): AccessResult {
    const allowedSet = new Set(allowedIds);
    const resolvedAdmin = adminId ?? allowedIds[0] ?? undefined;
    const isAdmin = resolvedAdmin !== undefined && userId === resolvedAdmin;

    if (allowedSet.has(userId)) {
        return { allowed: true, isAdmin, autoKill: false };
    }

    return { allowed: false, isAdmin: false, autoKill };
}

/**
 * Convenience: check if a user ID is the admin.
 */
export function isAdmin(userId: string, allowedIds: string[], adminId?: string): boolean {
    const resolvedAdmin = adminId ?? allowedIds[0] ?? undefined;
    return resolvedAdmin !== undefined && userId === resolvedAdmin;
}

/**
 * Convenience: check if a user ID is in the allowed list.
 */
export function isAllowed(userId: string, allowedIds: string[]): boolean {
    return allowedIds.includes(userId);
}
