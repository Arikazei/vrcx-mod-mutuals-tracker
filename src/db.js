/**
 * Datenschicht des Mutuals-Trackers.
 *
 * Wichtig: VRCX selbst haelt nur den AKTUELLEN Mutual-Stand - saveMutualGraphSnapshot
 * loescht die Kanten und schreibt sie neu. Historie entsteht erst hier.
 */

const EDGES = (ctx) => `${ctx.db.prefix()}_edges`;
const EVENTS = (ctx) => `${ctx.db.prefix()}_events`;
const RUNS = (ctx) => `${ctx.db.prefix()}_runs`;

export async function initTables(ctx) {
    await ctx.db.exec(
        `CREATE TABLE IF NOT EXISTS ${EDGES(ctx)} (
            friend_id TEXT NOT NULL,
            mutual_id TEXT NOT NULL,
            first_seen TEXT,
            last_seen TEXT,
            active INTEGER DEFAULT 1,
            PRIMARY KEY (friend_id, mutual_id)
        )`
    );
    await ctx.db.exec(
        `CREATE TABLE IF NOT EXISTS ${EVENTS(ctx)} (
            id INTEGER PRIMARY KEY,
            friend_id TEXT NOT NULL,
            mutual_id TEXT NOT NULL,
            type TEXT NOT NULL,
            detected_at TEXT NOT NULL,
            run_id INTEGER
        )`
    );
    await ctx.db.exec(
        `CREATE INDEX IF NOT EXISTS ${ctx.db.prefix()}_events_mutual_idx ON ${EVENTS(ctx)} (mutual_id, detected_at)`
    );
    await ctx.db.exec(
        `CREATE TABLE IF NOT EXISTS ${RUNS(ctx)} (
            id INTEGER PRIMARY KEY,
            started_at TEXT,
            finished_at TEXT,
            scanned INTEGER DEFAULT 0,
            opted_out INTEGER DEFAULT 0,
            baseline INTEGER DEFAULT 0
        )`
    );
}

/** Ist ueberhaupt schon etwas aufgezeichnet? */
export async function hasBaseline(ctx) {
    const rows = await ctx.db.query(`SELECT COUNT(*) FROM ${EDGES(ctx)}`);
    return (rows[0]?.[0] ?? 0) > 0;
}

/**
 * Uebernimmt VRCXs vorhandenen Mutual-Graph als Ausgangszustand. Ohne diesen
 * Schritt wuerde der erste Scan jede bestehende Verbindung als "neu" melden.
 */
export async function importBaseline(ctx) {
    const core = ctx.db.corePrefix();
    const now = new Date().toISOString();
    const rows = await ctx.db.query(`SELECT friend_id, mutual_id FROM ${core}_mutual_graph_links`);
    if (!rows.length) return 0;

    const runId = await startRun(ctx, true);
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values = chunk
            .map((r) => `('${String(r[0]).replace(/'/g, "''")}','${String(r[1]).replace(/'/g, "''")}','${now}','${now}',1)`)
            .join(',');
        await ctx.db.exec(
            `INSERT OR REPLACE INTO ${EDGES(ctx)} (friend_id, mutual_id, first_seen, last_seen, active) VALUES ${values}`
        );
    }
    await finishRun(ctx, runId, rows.length, 0);
    return rows.length;
}

export async function startRun(ctx, baseline = false) {
    const now = new Date().toISOString();
    await ctx.db.exec(
        `INSERT INTO ${RUNS(ctx)} (started_at, baseline) VALUES (@started, @baseline)`,
        { '@started': now, '@baseline': baseline ? 1 : 0 }
    );
    const rows = await ctx.db.query(`SELECT MAX(id) FROM ${RUNS(ctx)}`);
    return rows[0]?.[0] ?? 0;
}

export async function finishRun(ctx, runId, scanned, optedOut) {
    await ctx.db.exec(
        `UPDATE ${RUNS(ctx)} SET finished_at = @finished, scanned = @scanned, opted_out = @opted WHERE id = @id`,
        { '@finished': new Date().toISOString(), '@scanned': scanned, '@opted': optedOut, '@id': runId }
    );
}

/** Zuletzt bekannte, noch aktive Mutuals eines Freundes. */
export async function activeMutualsOf(ctx, friendId) {
    const rows = await ctx.db.query(`SELECT mutual_id FROM ${EDGES(ctx)} WHERE friend_id = @f AND active = 1`, {
        '@f': friendId
    });
    return rows.map((r) => r[0]);
}

/** Schreibt das Ergebnis eines Scans fuer EINEN Freund fort. */
export async function applyDiff(ctx, friendId, { added, removed }, runId) {
    const now = new Date().toISOString();

    for (const mutualId of added) {
        await ctx.db.exec(
            `INSERT INTO ${EDGES(ctx)} (friend_id, mutual_id, first_seen, last_seen, active)
             VALUES (@f, @m, @now, @now, 1)
             ON CONFLICT(friend_id, mutual_id) DO UPDATE SET active = 1, last_seen = @now`,
            { '@f': friendId, '@m': mutualId, '@now': now }
        );
        await ctx.db.exec(
            `INSERT INTO ${EVENTS(ctx)} (friend_id, mutual_id, type, detected_at, run_id)
             VALUES (@f, @m, 'added', @now, @run)`,
            { '@f': friendId, '@m': mutualId, '@now': now, '@run': runId }
        );
    }

    for (const mutualId of removed) {
        await ctx.db.exec(
            `UPDATE ${EDGES(ctx)} SET active = 0, last_seen = @now WHERE friend_id = @f AND mutual_id = @m`,
            { '@f': friendId, '@m': mutualId, '@now': now }
        );
        await ctx.db.exec(
            `INSERT INTO ${EVENTS(ctx)} (friend_id, mutual_id, type, detected_at, run_id)
             VALUES (@f, @m, 'removed', @now, @run)`,
            { '@f': friendId, '@m': mutualId, '@now': now, '@run': runId }
        );
    }

    // Unveraenderte Kanten nur "frisch gesehen" markieren
    await ctx.db.exec(`UPDATE ${EDGES(ctx)} SET last_seen = @now WHERE friend_id = @f AND active = 1`, {
        '@f': friendId,
        '@now': now
    });
}

export async function loadEvents(ctx, type = null, limit = 500) {
    const where = type ? `WHERE type = '${type === 'removed' ? 'removed' : 'added'}'` : '';
    const rows = await ctx.db.query(
        `SELECT friend_id, mutual_id, type, detected_at FROM ${EVENTS(ctx)} ${where}
         ORDER BY detected_at DESC LIMIT ${Number(limit) || 500}`
    );
    return rows.map((r) => ({ friendId: r[0], mutualId: r[1], type: r[2], detectedAt: r[3] }));
}

export async function loadEdges(ctx) {
    const rows = await ctx.db.query(`SELECT friend_id, mutual_id, active FROM ${EDGES(ctx)}`);
    return rows.map((r) => ({ friendId: r[0], mutualId: r[1], active: r[2] }));
}

export async function loadRuns(ctx, limit = 20) {
    const rows = await ctx.db.query(
        `SELECT id, started_at, finished_at, scanned, opted_out, baseline FROM ${RUNS(ctx)}
         ORDER BY id DESC LIMIT ${Number(limit) || 20}`
    );
    return rows.map((r) => ({
        id: r[0],
        startedAt: r[1],
        finishedAt: r[2],
        scanned: r[3],
        optedOut: r[4],
        baseline: !!r[5]
    }));
}

/** Eigene Freundschaftshistorie - liegt schon in VRCXs Kerntabelle. */
export async function loadOwnHistory(ctx) {
    const core = ctx.db.corePrefix();
    const rows = await ctx.db.query(
        `SELECT type, user_id, display_name, created_at FROM ${core}_friend_log_history
         WHERE type IN ('Friend','Unfriend') ORDER BY created_at DESC`
    );
    return rows.map((r) => ({ type: r[0], userId: r[1], displayName: r[2], createdAt: r[3] }));
}
