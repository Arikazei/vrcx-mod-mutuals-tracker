import { diffMutuals } from './engine';
import { activeMutualsOf, applyDiff, finishRun, startRun } from './db';

/**
 * Ein Scan-Lauf: holt fuer jeden Freund dessen aktuelle Mutuals und schreibt
 * die Unterschiede fort.
 *
 * Bewusst langsam: VRChat rate-limitet hart, und ein Vollscan ueber alle
 * Freunde ist nichts, was im Hintergrund durchrauschen soll. Wir nutzen VRCXs
 * eigene Abfrage (fetchSingleFriendMutuals), damit Opt-out-Freunde und VRCXs
 * Cache korrekt behandelt werden.
 */
export async function runScan(ctx, { onProgress, shouldStop, gapMs = 1500 } = {}) {
    const charts = ctx.stores.charts;
    if (!charts?.fetchSingleFriendMutuals) {
        throw new Error('VRCX-Funktion fuer Mutual-Abfragen nicht verfuegbar');
    }

    const friends = [...(ctx.stores.friends?.friends?.keys?.() ?? [])];
    if (!friends.length) throw new Error('Keine Freunde geladen');

    const runId = await startRun(ctx);
    let scanned = 0;
    let optedOut = 0;
    let changes = 0;

    for (let i = 0; i < friends.length; i++) {
        if (shouldStop?.()) break;
        const friendId = friends[i];

        try {
            const res = await charts.fetchSingleFriendMutuals(friendId);
            if (res?.optedOut) {
                optedOut++;
            } else if (res?.success) {
                const current = (res.mutuals || []).map((m) => m?.id).filter(Boolean);
                const known = await activeMutualsOf(ctx, friendId);
                const diff = diffMutuals(known, current);
                if (diff.added.length || diff.removed.length) {
                    await applyDiff(ctx, friendId, diff, runId);
                    changes += diff.added.length + diff.removed.length;
                }
                scanned++;
            }
        } catch (err) {
            ctx.warn('Scan fehlgeschlagen fuer', friendId, err);
        }

        onProgress?.({ done: i + 1, total: friends.length, scanned, optedOut, changes });
        if (i < friends.length - 1) await new Promise((r) => setTimeout(r, gapMs));
    }

    await finishRun(ctx, runId, scanned, optedOut);
    return { runId, scanned, optedOut, changes };
}
