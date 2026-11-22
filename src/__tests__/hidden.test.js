import { describe, expect, it } from 'vitest';

import { findWholeListDrops, isListHidden, latestPurgeEntry } from '../engine';

describe('isListHidden', () => {
    it('nur komplett leer bei vorher mehreren gilt als privat/leer', () => {
        expect(isListHidden(10, 0)).toBe(true);
        expect(isListHidden(10, 1)).toBe(false);
        expect(isListHidden(2, 0)).toBe(false);
    });
});

describe('findWholeListDrops', () => {
    const t0 = '2026-11-01T00:00:00.000Z';
    const edges = ['a', 'b', 'c', 'd'].map((m) => ({ friendId: 'icu', mutualId: m, firstSeen: t0 }));
    edges.push({ friendId: 'bob', mutualId: 'a', firstSeen: t0 }, { friendId: 'bob', mutualId: 'b', firstSeen: t0 });
    edges.push({ friendId: 'bob', mutualId: 'c', firstSeen: t0 }, { friendId: 'bob', mutualId: 'd', firstSeen: t0 });
    const ev = (id, friendId, mutualId, type, detectedAt, runId) => ({
        id,
        friendId,
        mutualId,
        type,
        detectedAt,
        runId,
        source: 'scan'
    });

    it('ganze Liste auf einmal weg = Treffer, Rueckkehr-"dazu" werden mit erkannt', () => {
        const events = [
            ev(1, 'icu', 'a', 'removed', '2026-11-10T00:00:00.000Z', 5),
            ev(2, 'icu', 'b', 'removed', '2026-11-10T00:00:00.000Z', 5),
            ev(3, 'icu', 'c', 'removed', '2026-11-10T00:00:00.000Z', 5),
            ev(4, 'icu', 'd', 'removed', '2026-11-10T00:00:00.000Z', 5),
            ev(5, 'icu', 'a', 'added', '2026-11-12T00:00:00.000Z', 7),
            ev(6, 'icu', 'b', 'added', '2026-11-12T00:00:00.000Z', 7)
        ];
        const drops = findWholeListDrops(events, edges);
        expect(drops).toHaveLength(1);
        expect(drops[0].friendId).toBe('icu');
        expect(drops[0].removedIds).toEqual([1, 2, 3, 4]);
        expect(drops[0].returnIds).toEqual([5, 6]);
    });

    it('verdeckte Kanten (kein Freund mehr) zaehlen nicht zur bekannten Liste', () => {
        const withHidden = [...edges, { friendId: 'icu', mutualId: 'x', firstSeen: t0, active: 0, hidden: 1 }];
        const events = ['a', 'b', 'c', 'd'].map((m, i) => ev(i + 1, 'icu', m, 'removed', '2026-11-10T00:00:00.000Z', 5));
        expect(findWholeListDrops(events, withHidden)).toHaveLength(1);
    });

    it('nur ein Teil weg = echte Veraenderung, kein Treffer', () => {
        const events = [
            ev(1, 'bob', 'a', 'removed', '2026-11-10T00:00:00.000Z', 5),
            ev(2, 'bob', 'b', 'removed', '2026-11-10T00:00:00.000Z', 5),
            ev(3, 'bob', 'c', 'removed', '2026-11-10T00:00:00.000Z', 5)
        ];
        expect(findWholeListDrops(events, edges)).toHaveLength(0);
    });
});

describe('latestPurgeEntry', () => {
    it('nimmt den juengsten Eintrag, fehlgeschlagene Pruefungen zaehlen nicht', () => {
        const latest = latestPurgeEntry({
            departures: [
                { status: 'ok', checkedAt: '2026-11-10T00:00:00Z' },
                { status: 'failed', checkedAt: '2026-11-20T00:00:00Z' }
            ],
            groups: [{ to: '2026-11-12T00:00:00Z' }],
            hiddenLists: [{ since: '2026-11-11T00:00:00Z' }]
        });
        expect(latest).toBe('2026-11-12T00:00:00Z');
        expect(latestPurgeEntry({})).toBe(null);
    });
});
