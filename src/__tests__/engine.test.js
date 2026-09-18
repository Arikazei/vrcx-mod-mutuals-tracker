import { describe, expect, it } from 'vitest';

import { buildOwnTimeline, diffMutuals, friendshipSpans, groupPurges, purgeContext } from '../engine';

describe('diffMutuals', () => {
    it('erkennt neue und entfernte Verbindungen', () => {
        const d = diffMutuals(['a', 'b', 'c'], ['b', 'c', 'd']);
        expect(d.added).toEqual(['d']);
        expect(d.removed).toEqual(['a']);
        expect(d.unchanged).toBe(2);
    });

    it('meldet nichts bei unveraendertem Stand', () => {
        const d = diffMutuals(['a', 'b'], ['b', 'a']);
        expect(d.added).toHaveLength(0);
        expect(d.removed).toHaveLength(0);
    });

    it('behandelt den leeren Ausgangszustand als lauter Neuzugaenge', () => {
        expect(diffMutuals([], ['a', 'b']).added).toEqual(['a', 'b']);
    });
});

describe('groupPurges', () => {
    const ev = (friendId, mutualId, detectedAt) => ({ friendId, mutualId, detectedAt });

    it('fasst Entfernungen derselben Person im Zeitfenster zusammen', () => {
        const groups = groupPurges([
            ev('f1', 'x', '2026-09-01T10:00:00Z'),
            ev('f2', 'x', '2026-09-01T11:00:00Z'),
            ev('f3', 'x', '2026-09-02T09:00:00Z')
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].friendIds).toEqual(['f1', 'f2', 'f3']);
    });

    it('trennt Ereignisse ausserhalb des Fensters', () => {
        const groups = groupPurges(
            [ev('f1', 'x', '2026-09-01T10:00:00Z'), ev('f2', 'x', '2026-09-20T10:00:00Z')],
            48
        );
        expect(groups).toHaveLength(0); // je ein Einzelereignis, keine Aktion
    });

    it('ignoriert Einzelentfernungen', () => {
        expect(groupPurges([ev('f1', 'x', '2026-09-01T10:00:00Z')])).toHaveLength(0);
    });
});

describe('purgeContext', () => {
    it('zeigt, bei wem die Person noch drin ist und bei wem nicht mehr', () => {
        const edges = [
            { friendId: 'f1', mutualId: 'x', active: 1 },
            { friendId: 'f2', mutualId: 'x', active: 0 },
            { friendId: 'f3', mutualId: 'x', active: 0 },
            { friendId: 'f4', mutualId: 'y', active: 1 }
        ];
        const res = purgeContext('x', edges);
        expect(res.stillWith).toEqual(['f1']);
        expect(res.goneFrom).toEqual(['f2', 'f3']);
        expect(res.ratio).toBeCloseTo(2 / 3);
    });
});

describe('eigene Freundschaftshistorie', () => {
    const rows = [
        { type: 'Friend', userId: 'u1', displayName: 'Ana', createdAt: '2025-01-01T00:00:00Z' },
        { type: 'Unfriend', userId: 'u1', displayName: 'Ana', createdAt: '2026-01-01T00:00:00Z' },
        { type: 'DisplayName', userId: 'u1', displayName: 'Ana', createdAt: '2025-06-01T00:00:00Z' }
    ];

    it('filtert auf Freundschaftsereignisse und sortiert neueste zuerst', () => {
        const t = buildOwnTimeline(rows);
        expect(t).toHaveLength(2);
        expect(t[0].type).toBe('unfriend');
    });

    it('paart Beginn und Ende zu Zeitspannen', () => {
        const spans = friendshipSpans(buildOwnTimeline(rows));
        expect(spans[0].spans[0].startedAt).toBe('2025-01-01T00:00:00Z');
        expect(spans[0].spans[0].endedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('kommt mit einem Unfriend ohne bekannten Beginn zurecht', () => {
        const spans = friendshipSpans(
            buildOwnTimeline([{ type: 'Unfriend', userId: 'u9', displayName: 'X', createdAt: '2026-05-05T00:00:00Z' }])
        );
        expect(spans[0].spans[0].startedAt).toBeNull();
        expect(spans[0].spans[0].endedAt).toBe('2026-05-05T00:00:00Z');
    });
});
