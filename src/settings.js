/**
 * Einstellungen des Mods, abgelegt in einer eigenen Tabelle.
 * Bewusst als key/value: neue Optionen brauchen keine Migration.
 */
const TABLE = (ctx) => `${ctx.db.prefix()}_settings`;

export const DEFAULT_SETTINGS = {
    // null = alle Personen anzeigen. Sonst Liste der sichtbaren userIds.
    visible: null,
    autoScan: {
        enabled: true,
        hours: 6
    }
};

export async function initSettings(ctx) {
    await ctx.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE(ctx)} (key TEXT PRIMARY KEY, value TEXT)`);
}

export async function loadSettings(ctx) {
    try {
        const rows = await ctx.db.query(`SELECT value FROM ${TABLE(ctx)} WHERE key = 'settings'`);
        if (!rows.length) return structuredClone(DEFAULT_SETTINGS);
        const parsed = JSON.parse(rows[0][0]);
        return {
            ...structuredClone(DEFAULT_SETTINGS),
            ...parsed,
            autoScan: { ...DEFAULT_SETTINGS.autoScan, ...(parsed.autoScan || {}) }
        };
    } catch (err) {
        ctx.warn('Einstellungen nicht lesbar, nehme Standardwerte:', err);
        return structuredClone(DEFAULT_SETTINGS);
    }
}

export async function saveSettings(ctx, settings) {
    await ctx.db.exec(
        `INSERT INTO ${TABLE(ctx)} (key, value) VALUES ('settings', @v)
         ON CONFLICT(key) DO UPDATE SET value = @v`,
        { '@v': JSON.stringify(settings) }
    );
}
