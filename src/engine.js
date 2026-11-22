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

// ---------------------------------------------------------------------------
// Plausibilitaet (ab 0.3.0)
//
// Wichtig: VRChats "mutuals"-Liste eines Freundes F enthaelt nur Leute, die
// mit F UND mit MIR befreundet sind. Endet MEINE Freundschaft mit X, faellt X
// automatisch aus allen Listen - das ist kein Entfernen zwischen F und X.
// Genauso taucht ein neuer Freund von mir ploetzlich bei allen gemeinsamen
// Freunden auf. Beides darf nicht als Veraenderung gemeldet werden.
// ---------------------------------------------------------------------------

/**
 * Teilt einen Diff in echte und scheinbare Veraenderungen.
 *
 * @param {object} p
 * @param {string[]} p.known        aktive Kanten des Freundes
 * @param {string[]} p.current      frisch abgerufene Mutuals
 * @param {Set<string>} p.myFriends meine aktuellen Freunde
 * @param {Set<string>} p.newFriends seit dem letzten Lauf neu befreundet
 * @param {Set<string>} [p.hidden]  Kanten, die nur wegen meiner Freundschaft verschwanden
 * @param {boolean} [p.friendIsNew] der Freund selbst ist neu - seine ganze Liste ist Ausgangszustand
 */
export function classifyChanges({ known, current, myFriends, newFriends, hidden = new Set(), friendIsNew = false }) {
    const { added: rawAdded, removed: rawRemoved } = diffMutuals(known, current);
    const added = [];
    const silentAdded = [];
    const removed = [];
    const hide = [];

    for (const id of rawAdded) {
        if (friendIsNew || newFriends.has(id) || hidden.has(id)) silentAdded.push(id);
        else added.push(id);
    }
    for (const id of rawRemoved) {
        if (!myFriends.has(id)) hide.push(id);
        else removed.push(id);
    }
    return { added, silentAdded, removed, hidden: hide };
}

/** Faellt bei EINEM Freund auf einmal ein grosser Teil weg, ist eher die Abfrage unvollstaendig. */
export function isMassDrop(removedCount, knownCount, minCount = 5, minShare = 0.3) {
    if (removedCount < minCount || knownCount <= 0) return false;
    return removedCount / knownCount >= minShare;
}

/** friend_log_history -> Map userId -> [{at, type}] aufsteigend sortiert. */
export function buildHistoryIndex(rows) {
    const map = new Map();
    for (const r of rows) {
        if (r.type !== 'Friend' && r.type !== 'Unfriend') continue;
        if (!map.has(r.userId)) map.set(r.userId, []);
        map.get(r.userId).push({ at: r.createdAt, type: r.type });
    }
    for (const list of map.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return map;
}

/** War userId zum Zeitpunkt iso mit mir befreundet? */
export function wasFriendAt(history, userId, iso, currentFriends) {
    const list = history.get(userId) || [];
    let state = null;
    for (const e of list) {
        if (e.at <= iso) state = e.type === 'Friend';
        else break;
    }
    if (state !== null) return state;
    const later = list.find((e) => e.at > iso);
    if (later) return later.type === 'Unfriend';
    return currentFriends.has(userId);
}

// VRCX notiert ein Unfriend erst, wenn es die Freundesliste neu abgleicht -
// das kann spaeter sein als der Scan, der den Abgang schon sieht.
export const UNFRIEND_LAG_HOURS = 24;
const ADD_LAG_HOURS = 2;

export function shiftIso(iso, hours) {
    return new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString();
}

/** Hat mich userId kurz nach iso entfreundet (bzw. ich ihn)? */
export function unfriendedSoonAfter(history, userId, iso, hours = UNFRIEND_LAG_HOURS) {
    const until = shiftIso(iso, hours);
    return (history.get(userId) || []).some((e) => e.type === 'Unfriend' && e.at > iso && e.at <= until);
}

/** Wurde userId im Zeitraum (from, to] mein Freund? */
export function becameFriendBetween(history, userId, from, to) {
    const list = history.get(userId) || [];
    return list.some((e) => e.type === 'Friend' && (!from || e.at > from) && e.at <= to);
}

/**
 * Findet bereits gespeicherte Fehleintraege (Altdaten vor 0.3.0).
 *
 * @param {Array<{id, friendId, mutualId, type, detectedAt, runId}>} events
 * @param {Map} history            aus buildHistoryIndex
 * @param {Set<string>} currentFriends
 * @param {Map<number, string>} prevStartByRun runId -> started_at des Laufs davor
 * @returns {{removed: Array, added: Array}} zu verwerfende Events
 */
export function findFalseEvents(events, history, currentFriends, prevStartByRun) {
    const removed = [];
    const added = [];
    for (const e of events) {
        if (e.type === 'removed') {
            if (
                !wasFriendAt(history, e.mutualId, e.detectedAt, currentFriends) ||
                unfriendedSoonAfter(history, e.mutualId, e.detectedAt)
            ) {
                removed.push(e);
            }
        } else if (e.type === 'added') {
            const from = prevStartByRun.get(e.runId) || null;
            const to = shiftIso(e.detectedAt, ADD_LAG_HOURS);
            if (
                becameFriendBetween(history, e.mutualId, from, to) ||
                becameFriendBetween(history, e.friendId, from, to)
            ) {
                added.push(e);
            }
        }
    }
    return { removed, added };
}

/**
 * Plant die Abfragen fuer eine Nachpruefung. Ob A und B befreundet sind, sieht
 * man in der Mutual-Liste von A - aber nur, wenn B mein Freund ist (und
 * umgekehrt). Wer in vielen Paaren vorkommt, wird bevorzugt abgefragt.
 *
 * @returns {{plan: Map<string, Array<{pair, other}>>, unknown: Array}}
 */
export function planVerification(pairs, myFriends) {
    const count = new Map();
    for (const p of pairs) {
        count.set(p.friendId, (count.get(p.friendId) || 0) + 1);
        count.set(p.mutualId, (count.get(p.mutualId) || 0) + 1);
    }
    const plan = new Map();
    const unknown = [];
    for (const pair of pairs) {
        const a = pair.friendId;
        const b = pair.mutualId;
        const options = [];
        if (myFriends.has(b)) options.push({ target: a, other: b });
        if (myFriends.has(a)) options.push({ target: b, other: a });
        if (!options.length) {
            unknown.push(pair);
            continue;
        }
        options.sort((x, y) => (count.get(y.target) || 0) - (count.get(x.target) || 0));
        const { target, other } = options[0];
        if (!plan.has(target)) plan.set(target, []);
        plan.get(target).push({ pair, other });
    }
    return { plan, unknown };
}

// ---------------------------------------------------------------------------
// Leere Listen (ab 0.4.0)
//
// Liefert VRChat fuer jemanden ploetzlich GAR KEINE Mutuals mehr, hat die
// Person fast immer ihre Verbindungen auf privat gestellt - nicht alle
// Freunde geloescht. Unterscheiden laesst sich das von aussen nicht, darum
// gibt es dafuer nur eine Meldung "privat oder Liste komplett leer" statt
// einer Aufraeumaktion.
// ---------------------------------------------------------------------------

export const HIDDEN_LIST_MIN = 3;

export function isListHidden(knownCount, currentCount, min = HIDDEN_LIST_MIN) {
    return currentCount === 0 && knownCount >= min;
}

/**
 * Altdaten: Laeufe, in denen ein Freund ALLE bekannten Mutuals auf einmal
 * verloren hat.
 *
 * @param {Array<{id, friendId, mutualId, type, detectedAt, runId, source}>} events
 * @param {Array<{friendId, mutualId, firstSeen}>} edges
 * @returns {Array<{friendId, runId, detectedAt, removedIds: number[], mutualIds: string[], returnIds: number[]}>}
 */
export function findWholeListDrops(events, edges, min = HIDDEN_LIST_MIN) {
    const scan = events
        .filter((e) => (e.source || 'scan') === 'scan')
        .sort((a, b) => (a.detectedAt < b.detectedAt ? -1 : a.detectedAt > b.detectedAt ? 1 : a.id - b.id));

    const byFriend = new Map();
    for (const e of scan) {
        if (!byFriend.has(e.friendId)) byFriend.set(e.friendId, []);
        byFriend.get(e.friendId).push(e);
    }
    const edgesByFriend = new Map();
    for (const e of edges) {
        if (!edgesByFriend.has(e.friendId)) edgesByFriend.set(e.friendId, []);
        edgesByFriend.get(e.friendId).push(e);
    }

    const result = [];
    for (const [friendId, list] of byFriend) {
        const runs = new Map();
        for (const e of list) {
            if (e.type !== 'removed') continue;
            if (!runs.has(e.runId)) runs.set(e.runId, []);
            runs.get(e.runId).push(e);
        }

        for (const [runId, removed] of runs) {
            if (removed.length < min) continue;
            const at = removed[0].detectedAt;

            // Wer war direkt vor diesem Lauf bekannt?
            let known = 0;
            for (const edge of edgesByFriend.get(friendId) || []) {
                if (!edge.firstSeen || edge.firstSeen > at) continue;
                // verdeckt = Person ist nicht mehr MEIN Freund; zaehlt fuer "ganze Liste" nicht
                if (edge.hidden && !edge.active) continue;
                const before = list.filter((e) => e.mutualId === edge.mutualId && e.runId !== runId && e.detectedAt < at);
                const last = before[before.length - 1];
                if (!last || last.type === 'added') known++;
            }
            if (removed.length < known) continue;

            const ids = new Set(removed.map((e) => e.mutualId));
            // Kam die Liste spaeter zurueck, sind die ersten "dazu" danach ebenfalls falsch
            const returnIds = [];
            const seen = new Set();
            for (const e of list) {
                if (e.detectedAt <= at || !ids.has(e.mutualId) || seen.has(e.mutualId)) continue;
                seen.add(e.mutualId);
                if (e.type === 'added') returnIds.push(e.id);
            }

            result.push({
                friendId,
                runId,
                detectedAt: at,
                removedIds: removed.map((e) => e.id),
                mutualIds: [...ids],
                returnIds
            });
        }
    }
    return result;
}

/**
 * Juengster Zeitpunkt, zu dem in "Aufraeumaktionen" etwas Neues auftauchte.
 * Grundlage fuer den roten Punkt.
 */
export function latestPurgeEntry({ departures = [], groups = [], hiddenLists = [] }) {
    let latest = null;
    const take = (iso) => {
        if (iso && (!latest || iso > latest)) latest = iso;
    };
    for (const d of departures) if (d.status !== 'failed') take(d.checkedAt);
    for (const g of groups) take(g.to);
    for (const h of hiddenLists) take(h.since);
    return latest;
}
