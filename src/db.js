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

    // 0.3.0: Plausibilitaets-Spalten. ALTER schlaegt fehl, wenn es die Spalte
    // schon gibt - das ist gewollt und wird geschluckt.
    const addColumn = async (table, def) => {
        try {
            await ctx.db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
        } catch {
            /* existiert bereits */
        }
    };
    await addColumn(EDGES(ctx), 'hidden INTEGER DEFAULT 0');
    await addColumn(EDGES(ctx), 'miss_count INTEGER DEFAULT 0');
    await addColumn(EVENTS(ctx), "source TEXT DEFAULT 'scan'");
    await addColumn(EVENTS(ctx), 'verified_at TEXT');

    await ctx.db.exec(
        `CREATE TABLE IF NOT EXISTS ${DEPARTURES(ctx)} (
            user_id TEXT PRIMARY KEY,
            ended_at TEXT,
            checked_at TEXT,
            status TEXT,
            known INTEGER DEFAULT 0,
            kept INTEGER DEFAULT 0,
            removed INTEGER DEFAULT 0
        )`
    );
    await ctx.db.exec(`CREATE TABLE IF NOT EXISTS ${META(ctx)} (key TEXT PRIMARY KEY, value TEXT)`);
    // 0.4.0: Freunde, deren Mutual-Liste ploetzlich komplett leer ist (meist privat gestellt)
    await ctx.db.exec(
        `CREATE TABLE IF NOT EXISTS ${HIDDEN_LISTS(ctx)} (
            user_id TEXT PRIMARY KEY,
            since TEXT,
            known INTEGER DEFAULT 0
        )`
    );
}

const HIDDEN_LISTS = (ctx) => `${ctx.db.prefix()}_hidden_lists`;

export async function setHiddenList(ctx, userId, since, known) {
    await ctx.db.exec(
        `INSERT INTO ${HIDDEN_LISTS(ctx)} (user_id, since, known) VALUES (@u, @s, @k)
         ON CONFLICT(user_id) DO UPDATE SET since = MAX(since, @s), known = MAX(known, @k)`,
        { '@u': userId, '@s': since, '@k': known }
    );
}

export async function clearHiddenList(ctx, userId) {
    await ctx.db.exec(`DELETE FROM ${HIDDEN_LISTS(ctx)} WHERE user_id = @u`, { '@u': userId });
}

export async function loadHiddenLists(ctx) {
    const rows = await ctx.db.query(`SELECT user_id, since, known FROM ${HIDDEN_LISTS(ctx)} ORDER BY since DESC`);
    return rows.map((r) => ({ userId: r[0], since: r[1], known: r[2] }));
}

/** Kanten wieder als "zuletzt bekannt" aktiv setzen (eingefrorene Liste). */
export async function reactivateEdges(ctx, friendId, mutualIds, myFriends) {
    for (const m of mutualIds) {
        const visible = myFriends.has(m);
        await ctx.db.exec(
            `UPDATE ${EDGES(ctx)} SET active = @a, hidden = @h, miss_count = 0 WHERE friend_id = @f AND mutual_id = @m`,
            { '@a': visible ? 1 : 0, '@h': visible ? 0 : 1, '@f': friendId, '@m': m }
        );
    }
}

export async function countActive(ctx, friendId) {
    const rows = await ctx.db.query(`SELECT COUNT(*) FROM ${EDGES(ctx)} WHERE friend_id = @f AND active = 1`, {
        '@f': friendId
    });
    return rows[0]?.[0] ?? 0;
}

const DEPARTURES = (ctx) => `${ctx.db.prefix()}_departures`;
const META = (ctx) => `${ctx.db.prefix()}_meta`;

export async function getMeta(ctx, key) {
    const rows = await ctx.db.query(`SELECT value FROM ${META(ctx)} WHERE key = @k`, { '@k': key });
    return rows[0]?.[0] ?? null;
}

export async function setMeta(ctx, key, value) {
    await ctx.db.exec(
        `INSERT INTO ${META(ctx)} (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value = @v`,
        { '@k': key, '@v': String(value) }
    );
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

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

/** Alle bekannten Kanten eines Freundes inkl. Plausibilitaets-Status. */
export async function edgesOf(ctx, friendId) {
    const rows = await ctx.db.query(
        `SELECT mutual_id, active, hidden, miss_count FROM ${EDGES(ctx)} WHERE friend_id = @f`,
        { '@f': friendId }
    );
    return rows.map((r) => ({ mutualId: r[0], active: !!r[1], hidden: !!r[2], missCount: Number(r[3]) || 0 }));
}

async function insertEvent(ctx, friendId, mutualId, type, now, runId, source) {
    await ctx.db.exec(
        `INSERT INTO ${EVENTS(ctx)} (friend_id, mutual_id, type, detected_at, run_id, source)
         VALUES (@f, @m, @t, @now, @run, @src)`,
        { '@f': friendId, '@m': mutualId, '@t': type, '@now': now, '@run': runId, '@src': source }
    );
}

/**
 * Schreibt das Ergebnis einer Abfrage fuer EINEN Freund fort.
 *
 * added       echte Neuzugaenge (Event)
 * silentAdded Kante aktiv, aber kein Event (neuer Freund von mir / war nur verdeckt)
 * removed     bestaetigte Entfernungen (Event)
 * hidden      verschwunden, weil ICH mit der Person nicht mehr befreundet bin (kein Event)
 * held        Map mutualId -> neuer miss_count (noch unbestaetigt, Kante bleibt aktiv)
 */
export async function applyChanges(ctx, friendId, changes, runId, source = 'scan') {
    const { added = [], silentAdded = [], removed = [], hidden = [], held = new Map() } = changes;
    const now = new Date().toISOString();

    // Erst alles Aktive als gesehen markieren - Entfernte/Verdeckte werden gleich wieder abgeschaltet
    await ctx.db.exec(
        `UPDATE ${EDGES(ctx)} SET last_seen = @now, miss_count = 0 WHERE friend_id = @f AND active = 1`,
        { '@f': friendId, '@now': now }
    );

    for (const mutualId of [...added, ...silentAdded]) {
        await ctx.db.exec(
            `INSERT INTO ${EDGES(ctx)} (friend_id, mutual_id, first_seen, last_seen, active, hidden, miss_count)
             VALUES (@f, @m, @now, @now, 1, 0, 0)
             ON CONFLICT(friend_id, mutual_id) DO UPDATE SET active = 1, hidden = 0, miss_count = 0, last_seen = @now`,
            { '@f': friendId, '@m': mutualId, '@now': now }
        );
    }
    for (const mutualId of added) await insertEvent(ctx, friendId, mutualId, 'added', now, runId, source);

    for (const mutualId of removed) {
        await ctx.db.exec(
            `UPDATE ${EDGES(ctx)} SET active = 0, hidden = 0, miss_count = 0 WHERE friend_id = @f AND mutual_id = @m`,
            { '@f': friendId, '@m': mutualId }
        );
        await insertEvent(ctx, friendId, mutualId, 'removed', now, runId, source);
    }

    for (const mutualId of hidden) {
        await ctx.db.exec(
            `UPDATE ${EDGES(ctx)} SET active = 0, hidden = 1, miss_count = 0 WHERE friend_id = @f AND mutual_id = @m`,
            { '@f': friendId, '@m': mutualId }
        );
    }

    for (const [mutualId, n] of held) {
        await ctx.db.exec(`UPDATE ${EDGES(ctx)} SET miss_count = @n WHERE friend_id = @f AND mutual_id = @m`, {
            '@f': friendId,
            '@m': mutualId,
            '@n': n
        });
    }
}

export async function loadEvents(ctx, type = null, limit = 5000) {
    const where = type ? `WHERE type = '${type === 'removed' ? 'removed' : 'added'}'` : '';
    const rows = await ctx.db.query(
        `SELECT id, friend_id, mutual_id, type, detected_at, run_id, source, verified_at FROM ${EVENTS(ctx)} ${where}
         ORDER BY detected_at DESC LIMIT ${Number(limit) || 5000}`
    );
    return rows.map((r) => ({
        id: r[0],
        friendId: r[1],
        mutualId: r[2],
        type: r[3],
        detectedAt: r[4],
        runId: r[5],
        source: r[6] || 'scan',
        verifiedAt: r[7] || null
    }));
}

export async function loadEdges(ctx) {
    const rows = await ctx.db.query(`SELECT friend_id, mutual_id, active, hidden, first_seen FROM ${EDGES(ctx)}`);
    return rows.map((r) => ({ friendId: r[0], mutualId: r[1], active: r[2], hidden: r[3], firstSeen: r[4] }));
}

/** Start des letzten abgeschlossenen Laufs (inkl. Ausgangszustand). */
export async function lastRunStart(ctx) {
    const rows = await ctx.db.query(
        `SELECT started_at FROM ${RUNS(ctx)} WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`
    );
    return rows[0]?.[0] ?? null;
}

/** runId -> started_at des davor abgeschlossenen Laufs. */
export async function prevStartByRun(ctx) {
    const rows = await ctx.db.query(`SELECT id, started_at FROM ${RUNS(ctx)} ORDER BY id`);
    const map = new Map();
    let prev = null;
    for (const r of rows) {
        map.set(r[0], prev);
        prev = r[1];
    }
    return map;
}

/** Wer ist seit iso mein Freund geworden (laut VRCXs Freundes-Log)? */
export async function friendsAddedSince(ctx, iso) {
    if (!iso) return new Set();
    const core = ctx.db.corePrefix();
    const rows = await ctx.db.query(
        `SELECT user_id FROM ${core}_friend_log_history WHERE type = 'Friend' AND created_at > @t`,
        { '@t': iso }
    );
    return new Set(rows.map((r) => r[0]));
}

/** Aktuelle Freunde laut DB - unabhaengig davon, ob der Store schon geladen ist. */
export async function currentFriendIds(ctx) {
    const core = ctx.db.corePrefix();
    const rows = await ctx.db.query(`SELECT user_id FROM ${core}_friend_log_current`);
    return new Set(rows.map((r) => r[0]));
}

export async function deleteEvents(ctx, ids) {
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200).map(Number).filter(Number.isFinite);
        if (chunk.length) await ctx.db.exec(`DELETE FROM ${EVENTS(ctx)} WHERE id IN (${chunk.join(',')})`);
    }
}

export async function hideEdge(ctx, friendId, mutualId) {
    await ctx.db.exec(
        `UPDATE ${EDGES(ctx)} SET hidden = 1, miss_count = 0 WHERE friend_id = @f AND mutual_id = @m AND active = 0`,
        { '@f': friendId, '@m': mutualId }
    );
}

/** Nachpruefung hat ergeben: die Verbindung besteht noch. */
export async function restoreEdge(ctx, friendId, mutualId) {
    const now = new Date().toISOString();
    await ctx.db.exec(
        `UPDATE ${EDGES(ctx)} SET active = 1, hidden = 0, miss_count = 0, last_seen = @now
         WHERE friend_id = @f AND mutual_id = @m`,
        { '@f': friendId, '@m': mutualId, '@now': now }
    );
}

/**
 * Endete MEINE Freundschaft mit userId, sind dessen "raus"-Eintraege bei meinen
 * Freunden ab kurz vorher nur Folgen davon - wegraeumen, Kanten verdecken.
 */
export async function dropRemovalsOf(ctx, userId, sinceIso) {
    const rows = await ctx.db.query(
        `SELECT id, friend_id FROM ${EVENTS(ctx)}
         WHERE type = 'removed' AND mutual_id = @u AND COALESCE(source, 'scan') = 'scan' AND detected_at >= @t`,
        { '@u': userId, '@t': sinceIso }
    );
    for (const r of rows) await hideEdge(ctx, r[1], userId);
    await deleteEvents(
        ctx,
        rows.map((r) => r[0])
    );
    return rows.length;
}

export async function markVerified(ctx, eventIds) {
    const now = new Date().toISOString();
    const ids = eventIds.map(Number).filter(Number.isFinite);
    if (!ids.length) return;
    await ctx.db.exec(`UPDATE ${EVENTS(ctx)} SET verified_at = @now WHERE id IN (${ids.join(',')})`, { '@now': now });
}

// ------------------------------------------------------------ Ex-Freunde

/** Ex-Freunde, deren letzte bekannte Mutual-Liste noch nicht nachgeprueft wurde. */
export async function departureCandidates(ctx, myFriends) {
    const rows = await ctx.db.query(`SELECT DISTINCT friend_id FROM ${EDGES(ctx)} WHERE active = 1`);
    const done = await ctx.db.query(`SELECT user_id, status FROM ${DEPARTURES(ctx)}`);
    const checked = new Set(done.filter((r) => r[1] !== 'failed').map((r) => r[0]));
    return rows.map((r) => r[0]).filter((id) => !myFriends.has(id) && !checked.has(id));
}

/** Wieder befreundet? Dann gilt die alte Pruefung nicht mehr. */
export async function clearReturnedDepartures(ctx, myFriends) {
    const rows = await ctx.db.query(`SELECT user_id FROM ${DEPARTURES(ctx)}`);
    const back = rows.map((r) => r[0]).filter((id) => myFriends.has(id));
    for (const id of back) await ctx.db.exec(`DELETE FROM ${DEPARTURES(ctx)} WHERE user_id = ${q(id)}`);
}

export async function lastUnfriendAt(ctx, userId) {
    const core = ctx.db.corePrefix();
    const rows = await ctx.db.query(
        `SELECT MAX(created_at) FROM ${core}_friend_log_history WHERE type = 'Unfriend' AND user_id = @u`,
        { '@u': userId }
    );
    return rows[0]?.[0] ?? null;
}

export async function saveDeparture(ctx, d) {
    await ctx.db.exec(
        `INSERT INTO ${DEPARTURES(ctx)} (user_id, ended_at, checked_at, status, known, kept, removed)
         VALUES (@u, @e, @c, @s, @k, @kept, @r)
         ON CONFLICT(user_id) DO UPDATE SET ended_at = @e, checked_at = @c, status = @s, known = @k, kept = @kept, removed = @r`,
        {
            '@u': d.userId,
            '@e': d.endedAt,
            '@c': d.checkedAt,
            '@s': d.status,
            '@k': d.known,
            '@kept': d.kept,
            '@r': d.removed
        }
    );
}

export async function loadDepartures(ctx) {
    const rows = await ctx.db.query(
        `SELECT user_id, ended_at, checked_at, status, known, kept, removed FROM ${DEPARTURES(ctx)}
         ORDER BY COALESCE(ended_at, checked_at) DESC`
    );
    return rows.map((r) => ({
        userId: r[0],
        endedAt: r[1],
        checkedAt: r[2],
        status: r[3],
        known: r[4],
        kept: r[5],
        removed: r[6]
    }));
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
