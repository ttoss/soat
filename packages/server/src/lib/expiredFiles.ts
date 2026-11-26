/**
 * Spread into a file read that must see rows past `expires_at`, which the
 * `File` model's find hook hides from every other read: the sweep, a settle,
 * project teardown.
 */
export const INCLUDING_EXPIRED_FILES = { hooks: false };
