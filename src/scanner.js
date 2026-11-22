import { classifyChanges, isListHidden, isMassDrop } from './engine';
import {
    applyChanges,
    clearHiddenList,
    edgesOf,
    finishRun,
    friendsAddedSince,
    lastRunStart,
    loadHiddenLists,
    setHiddenList,
    startRun
} from './db';
import { checkDepartures } from './integrity';
import { refreshUnseen } from './notify';
import { fetchMutualIds } from './mutualsApi';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ein Scan-Lauf: holt fuer jeden Freund dessen aktuelle Mutuals und schreibt
 * die Unterschiede fort.
 *
 * Bewusst langsam: VRChat rate-limitet hart. Wir nutzen VRCXs eigene Abfrage
 * (fetchSingleFriendMutuals), damit VRCXs Mutual-Graph mit aktuell bleibt.
 *
 * Gegen Fehleintraege (ab 0.3.0):
 *  - Wer nicht mehr MEIN Freund ist, faellt aus allen Listen - kein Entfernen.
 *  - Neue Freunde von mir tauchen ueberall auf - kein "dazu".
 *  - Jede Entfernung wird sofort mit einer zweiten Abfrage gegengeprueft.
 *  - Verliert ein Freund auf einmal sehr viele, zaehlt das erst, wenn auch der
 *    naechste Scan es bestaetigt (unvollstaendige API-Antworten).
 */
export async function runScan(ctx, { onProgress, shouldStop, gapMs = 1500 } = {}) {
    const charts = ctx.stores.charts;
    if (!charts?.fetchSingleFriendMutuals) {
        throw new Error('VRCX-Funktion fuer Mutual-Abfragen nicht verfuegbar');
    }

    const friends = [...(ctx.stores.friends?.friends?.keys?.() ?? [])];
    if (!friends.length) throw new Error('Keine Freunde geladen');

    const myFriends = new Set(friends);
    const newFriends = await friendsAddedSince(ctx, await lastRunStart(ctx));
    const hiddenLists = new Set((await loadHiddenLists(ctx)).map((h) => h.userId));

    const runId = await startRun(ctx);
    let scanned = 0;
    let optedOut = 0;
    let changes = 0;
    let held = 0;
    let rejected = 0;

    for (let i = 0; i < friends.length; i++) {
        if (shouldStop?.()) break;
        const friendId = friends[i];

        try {
            const res = await charts.fetchSingleFriendMutuals(friendId);
            if (res?.optedOut) {
                optedOut++;
            } else if (res?.success) {
                const current = (res.mutuals || []).map((m) => m?.id).filter(Boolean);
                const r = await scanOne(ctx, friendId, current, { myFriends, newFriends, runId, gapMs, hiddenLists });
                changes += r.changes;
                held += r.held;
                rejected += r.rejected;
                scanned++;
            }
        } catch (err) {
            ctx.warn('Scan fehlgeschlagen fuer', friendId, err);
        }

        onProgress?.({ done: i + 1, total: friends.length, scanned, optedOut, changes, held, rejected });
        if (i < friends.length - 1) await sleep(gapMs);
    }

    await finishRun(ctx, runId, scanned, optedOut);

    // Wer seit dem letzten Mal aus meiner Liste verschwunden ist: dessen eigene
    // Mutuals einmal nachsehen - DAS zeigt eine echte Aufraeumaktion.
    let departures = 0;
    if (!shouldStop?.()) {
        try {
            departures = (await checkDepartures(ctx, { myFriends, shouldStop, gapMs })).checked;
        } catch (err) {
            ctx.warn('Pruefung der Ex-Freunde fehlgeschlagen:', err);
        }
    }

    await refreshUnseen(ctx);
    return { runId, scanned, optedOut, changes, held, rejected, departures };
}

async function scanOne(ctx, friendId, current, { myFriends, newFriends, runId, gapMs, hiddenLists }) {
    const edges = await edgesOf(ctx, friendId);
    const known = edges.filter((e) => e.active).map((e) => e.mutualId);
    const hidden = new Set(edges.filter((e) => e.hidden).map((e) => e.mutualId));
    const missCount = new Map(edges.map((e) => [e.mutualId, e.missCount]));

    // Ploetzlich komplett leer: fast immer auf privat gestellt. Nichts als
    // Entfernung werten, letzten Stand einfrieren und nur melden.
    if (isListHidden(known.length, current.length)) {
        if (!hiddenLists.has(friendId)) {
            await setHiddenList(ctx, friendId, new Date().toISOString(), known.length);
            hiddenLists.add(friendId);
        }
        return { changes: 0, held: 0, rejected: 0 };
    }
    if (current.length && hiddenLists.has(friendId)) {
        await clearHiddenList(ctx, friendId);
        hiddenLists.delete(friendId);
    }

    const c = classifyChanges({
        known,
        current,
        myFriends,
        newFriends,
        hidden,
        // Neuer Freund oder noch nie gesehen: seine Liste ist Ausgangszustand
        friendIsNew: newFriends.has(friendId) || edges.length === 0
    });

    const heldMap = new Map();
    let rejected = 0;

    if (c.removed.length) {
        // Gegenprobe: zweite, unabhaengige Abfrage
        await sleep(gapMs * 2);
        const again = await fetchMutualIds(friendId);
        if (!again.ok) {
            // nicht pruefbar -> nichts behaupten, beim naechsten Scan wieder
            for (const id of c.removed) heldMap.set(id, (missCount.get(id) || 0) + 1);
            c.removed = [];
        } else {
            const present = new Set(again.ids);
            rejected = c.removed.filter((id) => present.has(id)).length;
            c.removed = c.removed.filter((id) => !present.has(id));
        }

        if (isMassDrop(c.removed.length, known.length)) {
            const confirmed = [];
            for (const id of c.removed) {
                if ((missCount.get(id) || 0) >= 1) confirmed.push(id);
                else heldMap.set(id, (missCount.get(id) || 0) + 1);
            }
            if (heldMap.size) ctx.log(`Massenabgang bei ${friendId} zurueckgestellt: ${heldMap.size}`);
            c.removed = confirmed;
        }
    }

    const touched = c.added.length + c.silentAdded.length + c.removed.length + c.hidden.length + heldMap.size;
    if (touched || known.length) {
        await applyChanges(ctx, friendId, { ...c, held: heldMap }, runId);
    }
    return { changes: c.added.length + c.removed.length, held: heldMap.size, rejected };
}
