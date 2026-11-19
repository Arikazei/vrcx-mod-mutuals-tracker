import { UNFRIEND_LAG_HOURS, buildHistoryIndex, findFalseEvents, planVerification, shiftIso } from './engine';
import {
    applyChanges,
    dropRemovalsOf,
    clearReturnedDepartures,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEANUP_VERSION = '1';

/**
 * Einmalige Bereinigung der Altdaten (vor 0.3.0 aufgezeichnet):
 *  - "raus", obwohl nur MEINE Freundschaft mit der Person endete
 *  - "dazu", obwohl nur ich die Person (oder den Freund) neu hatte
 */
export async function cleanupFalseEvents(ctx, { force = false } = {}) {
    if (!force && (await getMeta(ctx, 'cleanup')) === CLEANUP_VERSION) return null;

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
    await setMeta(ctx, 'cleanup', CLEANUP_VERSION);

    const res = { removed: found.removed.length, added: found.added.length };
    ctx.log(`Altdaten bereinigt: ${res.removed} falsche "raus", ${res.added} falsche "dazu"`);
    return res;
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
