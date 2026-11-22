import {
    UNFRIEND_LAG_HOURS,
    buildHistoryIndex,
    findFalseEvents,
    findWholeListDrops,
    isListHidden,
    planVerification,
    shiftIso
} from './engine';
import {
    applyChanges,
    dropRemovalsOf,
    clearReturnedDepartures,
    countActive,
    loadDepartures,
    loadEdges,
    reactivateEdges,
    setHiddenList,
    currentFriendIds,
    deleteEvents,
    departureCandidates,
    edgesOf,
    getMeta,
    hideEdge,
    lastUnfriendAt,
    loadEvents,
    loadOwnHistory,
    markVerified,
    prevStartByRun,
    restoreEdge,
    saveDeparture,
    setMeta
} from './db';
import { fetchMutualIds } from './mutualsApi';
import { refreshUnseen } from './notify';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEANUP_VERSION = 2;

/**
 * Einmalige Bereinigung der Altdaten, stufenweise:
 *  1 (0.3.0): "raus", obwohl nur MEINE Freundschaft mit der Person endete;
 *             "dazu", obwohl nur ich die Person (oder den Freund) neu hatte
 *  2 (0.4.0): ganze Liste auf einmal "raus" = privat gestellt / leer
 */
export async function cleanupFalseEvents(ctx, { force = false } = {}) {
    const done = force ? 0 : Number(await getMeta(ctx, 'cleanup')) || 0;
    if (done >= CLEANUP_VERSION) return null;
    const res = {};

    if (done < 1) {
        const history = buildHistoryIndex(await loadOwnHistory(ctx));
        const current = await currentFriendIds(ctx);
        const events = await loadEvents(ctx, null, 1000000);
        const prev = await prevStartByRun(ctx);
        const found = findFalseEvents(
            events.filter((e) => e.source !== 'departure'),
            history,
            current,
            prev
        );
        for (const e of found.removed) await hideEdge(ctx, e.friendId, e.mutualId);
        await deleteEvents(ctx, [...found.removed, ...found.added].map((e) => e.id));
        res.removed = found.removed.length;
        res.added = found.added.length;
        ctx.log(`Altdaten bereinigt: ${res.removed} falsche "raus", ${res.added} falsche "dazu"`);
        await setMeta(ctx, 'cleanup', 1);
    }

    if (done < 2) {
        res.hiddenLists = await cleanupWholeListDrops(ctx);
        await setMeta(ctx, 'cleanup', 2);
    }
    return res;
}

async function cleanupWholeListDrops(ctx) {
    const current = await currentFriendIds(ctx);
    const events = await loadEvents(ctx, null, 1000000);
    const edges = await loadEdges(ctx);
    const drops = findWholeListDrops(events, edges);

    let removedEvents = 0;
    for (const d of drops) {
        await deleteEvents(ctx, [...d.removedIds, ...d.returnIds]);
        removedEvents += d.removedIds.length + d.returnIds.length;
        // Liste ist immer noch leer: letzten Stand einfrieren und als "privat/leer" melden
        if ((await countActive(ctx, d.friendId)) === 0) {
            await reactivateEdges(ctx, d.friendId, d.mutualIds, current);
            await setHiddenList(ctx, d.friendId, d.detectedAt, d.mutualIds.length);
        }
    }

    // Ex-Freunde, deren Liste bei der Nachpruefung leer war
    let departures = 0;
    for (const dep of await loadDepartures(ctx)) {
        if (dep.status !== 'ok' || dep.removed === 0 || dep.kept > 0 || !isListHidden(dep.known, 0)) continue;
        const own = events.filter((e) => e.source === 'departure' && e.friendId === dep.userId && e.type === 'removed');
        await deleteEvents(ctx, own.map((e) => e.id));
        await reactivateEdges(ctx, dep.userId, own.map((e) => e.mutualId), current);
        await saveDeparture(ctx, { ...dep, status: 'empty', kept: dep.known, removed: 0 });
        departures++;
    }

    ctx.log(
        `Leere Listen bereinigt: ${drops.length} Freunde (${removedEvents} Eintraege), ${departures} Ex-Freunde`
    );
    return { friends: drops.length, events: removedEvents, departures };
}

/**
 * Ex-Freunde nachpruefen: deren eigene Mutual-Liste (jetzt) gegen die zuletzt
 * bekannte. Wer fehlt und weiterhin MEIN Freund ist, wurde von ihnen entfernt
 * (oder hat sie entfernt). Genau das ist die Aufraeumaktion.
 */
export async function checkDepartures(ctx, { myFriends, shouldStop, gapMs = 1500, only = null } = {}) {
    const friends = myFriends || new Set(ctx.stores.friends?.friends?.keys?.() ?? []);
    if (!friends.size) return { checked: 0 };

    await clearReturnedDepartures(ctx, friends);
    const targets = only ? only.filter((id) => !friends.has(id)) : await departureCandidates(ctx, friends);

    let checked = 0;
    for (const userId of targets) {
        if (shouldStop?.()) break;
        await checkOneDeparture(ctx, userId, friends);
        checked++;
        await sleep(gapMs);
    }
    if (checked) await refreshUnseen(ctx);
    return { checked };
}

async function checkOneDeparture(ctx, userId, friends) {
    const edges = await edgesOf(ctx, userId);
    const known = edges.filter((e) => e.active).map((e) => e.mutualId);
    const endedAt = (await lastUnfriendAt(ctx, userId)) || null;
    const checkedAt = new Date().toISOString();

    // Sein Verschwinden bei meinen Freunden war nur die Folge des Endes
    const dropped = await dropRemovalsOf(ctx, userId, shiftIso(endedAt || checkedAt, -UNFRIEND_LAG_HOURS));
    if (dropped) ctx.log(`${dropped} Folge-Eintraege zu ${userId} verworfen`);

    const res = await fetchMutualIds(userId);
    if (!res.ok) {
        await saveDeparture(ctx, {
            userId,
            endedAt,
            checkedAt,
            status: res.optedOut ? 'hidden' : 'failed',
            known: known.length,
            kept: 0,
            removed: 0
        });
        return;
    }

    // Komplett leer: privat gestellt oder wirklich alle weg - nicht als Aufraeumaktion werten
    if (isListHidden(known.length, res.ids.length)) {
        await saveDeparture(ctx, {
            userId,
            endedAt,
            checkedAt,
            status: 'empty',
            known: known.length,
            kept: known.length,
            removed: 0
        });
        return;
    }

    const present = new Set(res.ids);
    const removed = [];
    const hidden = [];
    for (const id of known) {
        if (present.has(id)) continue;
        if (friends.has(id)) removed.push(id);
        else hidden.push(id);
    }
    const activeSet = new Set(known);
    const silentAdded = res.ids.filter((id) => !activeSet.has(id));

    await applyChanges(ctx, userId, { added: [], silentAdded, removed, hidden }, null, 'departure');
    await saveDeparture(ctx, {
        userId,
        endedAt,
        checkedAt,
        status: 'ok',
        known: known.length,
        kept: known.length - removed.length - hidden.length,
        removed: removed.length
    });
}

/**
 * Nachpruefung einzelner "raus"-Eintraege. Besteht die Verbindung noch, wird
 * der Eintrag geloescht und die Kante wieder aktiv.
 *
 * @param {Array<{id, friendId, mutualId}>} events
 */
export async function verifyRemovals(ctx, events, { onProgress, gapMs = 1500 } = {}) {
    const myFriends = new Set(ctx.stores.friends?.friends?.keys?.() ?? []);
    if (!myFriends.size) throw new Error('Freundesliste noch nicht geladen');

    // gleiche Paare nur einmal pruefen
    const byPair = new Map();
    for (const e of events) {
        const k = `${e.friendId}|${e.mutualId}`;
        if (!byPair.has(k)) byPair.set(k, { friendId: e.friendId, mutualId: e.mutualId, ids: [] });
        byPair.get(k).ids.push(e.id);
    }

    const { plan, unknown } = planVerification([...byPair.values()], myFriends);
    const result = { restored: 0, confirmed: 0, unknown: unknown.length, failed: 0 };
    let done = 0;

    for (const [target, checks] of plan) {
        const res = await fetchMutualIds(target);
        if (!res.ok) {
            result.failed += checks.length;
        } else {
            const present = new Set(res.ids);
            const confirmedIds = [];
            for (const { pair, other } of checks) {
                if (present.has(other)) {
                    await restoreEdge(ctx, pair.friendId, pair.mutualId);
                    await deleteEvents(ctx, pair.ids);
                    result.restored++;
                } else {
                    confirmedIds.push(...pair.ids);
                    result.confirmed++;
                }
            }
            await markVerified(ctx, confirmedIds);
        }
        done++;
        onProgress?.({ done, total: plan.size });
        if (done < plan.size) await sleep(gapMs);
    }
    return result;
}
