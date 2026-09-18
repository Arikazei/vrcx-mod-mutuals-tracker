/**
 * Reine Rechenlogik des Mutuals-Trackers - keine DB, kein Vue, keine API.
 * Alles hier ist testbar ohne laufendes VRCX.
 */

/**
 * Vergleicht den frisch abgerufenen Mutual-Stand eines Freundes mit dem zuletzt
 * gespeicherten und liefert die Veraenderungen.
 *
 * @param {string[]} known   zuletzt gespeicherte mutual_ids (active = 1)
 * @param {string[]} current frisch abgerufene mutual_ids
 * @returns {{added: string[], removed: string[], unchanged: number}}
 */
export function diffMutuals(known, current) {
    const before = new Set(known);
    const after = new Set(current);
    const added = [];
    const removed = [];

    for (const id of after) if (!before.has(id)) added.push(id);
    for (const id of before) if (!after.has(id)) removed.push(id);

    return { added, removed, unchanged: before.size - removed.length };
}

/**
 * Gruppiert Entfernungen zu "Aufraeumaktionen": verliert dieselbe Person
 * innerhalb eines Zeitfensters bei mehreren Freunden ihren Platz, war das
 * hoechstwahrscheinlich eine einzelne Aufraeumrunde dieser Person.
 *
 * @param {Array<{friendId: string, mutualId: string, detectedAt: string}>} events
 * @param {number} windowHours
 * @returns {Array<{mutualId: string, from: string, to: string, friendIds: string[]}>}
 */
export function groupPurges(events, windowHours = 48) {
    const byMutual = new Map();
    for (const e of events) {
        if (!byMutual.has(e.mutualId)) byMutual.set(e.mutualId, []);
        byMutual.get(e.mutualId).push(e);
    }

    const windowMs = windowHours * 3600 * 1000;
    const groups = [];

    for (const [mutualId, list] of byMutual) {
        list.sort((a, b) => new Date(a.detectedAt) - new Date(b.detectedAt));
        let bucket = [];

        const flush = () => {
            if (bucket.length < 2) {
                bucket = [];
                return;
            }
            groups.push({
                mutualId,
                from: bucket[0].detectedAt,
                to: bucket[bucket.length - 1].detectedAt,
                friendIds: [...new Set(bucket.map((x) => x.friendId))]
            });
            bucket = [];
        };

        for (const e of list) {
            if (bucket.length === 0) {
                bucket.push(e);
                continue;
            }
            const gap = new Date(e.detectedAt) - new Date(bucket[bucket.length - 1].detectedAt);
            if (gap <= windowMs) bucket.push(e);
            else flush(), bucket.push(e);
        }
        flush();
    }

    groups.sort((a, b) => new Date(b.to) - new Date(a.to));
    return groups;
}

/**
 * Kernfrage des Mods: Person X hat mich entfreundet - war das persoenlich oder
 * hat X gerade generell aufgeraeumt? Dafuer zaehlen wir, bei welchen meiner
 * verbliebenen Freunde X noch in deren Mutuals steht und bei welchen nicht mehr.
 *
 * @param {string} mutualId          die Person, die mich entfreundet hat
 * @param {Array<{friendId: string, mutualId: string, active: number}>} edges
 * @returns {{stillWith: string[], goneFrom: string[], ratio: number}}
 */
export function purgeContext(mutualId, edges) {
    const stillWith = [];
    const goneFrom = [];

    for (const edge of edges) {
        if (edge.mutualId !== mutualId) continue;
        if (edge.active) stillWith.push(edge.friendId);
        else goneFrom.push(edge.friendId);
    }

    const total = stillWith.length + goneFrom.length;
    return { stillWith, goneFrom, ratio: total === 0 ? 0 : goneFrom.length / total };
}

/**
 * Wandelt VRCXs friend_log_history in eine Zeitleiste um. Diese Daten liegen
 * unabhaengig vom Mod vor - sie reichen so weit zurueck wie VRCX mitschreibt.
 *
 * @param {Array<{type: string, userId: string, displayName: string, createdAt: string}>} rows
 * @returns {Array<{type: 'friend'|'unfriend', userId, displayName, at}>}
 */
export function buildOwnTimeline(rows) {
    const out = [];
    for (const r of rows) {
        const type = r.type === 'Friend' ? 'friend' : r.type === 'Unfriend' ? 'unfriend' : null;
        if (!type) continue;
        out.push({ type, userId: r.userId, displayName: r.displayName, at: r.createdAt });
    }
    out.sort((a, b) => new Date(b.at) - new Date(a.at));
    return out;
}

/**
 * Wie lange eine Freundschaft gehalten hat: paart Friend- und Unfriend-Events
 * pro Person. Laufende Freundschaften bekommen endedAt = null.
 */
export function friendshipSpans(timeline) {
    const byUser = new Map();
    for (const e of [...timeline].reverse()) {
        if (!byUser.has(e.userId)) byUser.set(e.userId, { userId: e.userId, displayName: e.displayName, spans: [] });
        const entry = byUser.get(e.userId);
        entry.displayName = e.displayName || entry.displayName;
        const open = entry.spans[entry.spans.length - 1];

        if (e.type === 'friend') {
            if (!open || open.endedAt) entry.spans.push({ startedAt: e.at, endedAt: null });
        } else if (open && !open.endedAt) {
            open.endedAt = e.at;
        } else {
            // Unfriend ohne bekannten Start - VRCX hat den Beginn nie gesehen
            entry.spans.push({ startedAt: null, endedAt: e.at });
        }
    }
    return [...byUser.values()];
}
