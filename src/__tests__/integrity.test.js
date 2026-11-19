import { describe, expect, it } from 'vitest';

import {
    buildHistoryIndex,
    classifyChanges,
    findFalseEvents,
    isMassDrop,
    planVerification,
    wasFriendAt
} from '../engine';

const hist = buildHistoryIndex([
    { type: 'Friend', userId: 'squad', createdAt: '2026-10-11T04:22:57.622Z' },
    { type: 'Unfriend', userId: 'squad', createdAt: '2026-11-15T22:33:34.903Z' },
    { type: 'Friend', userId: 'neu', createdAt: '2026-11-10T10:00:00.000Z' }
]);

describe('classifyChanges', () => {
    it('Ex-Freund faellt nur verdeckt raus, echte Entfernung bleibt', () => {
        const c = classifyChanges({
            known: ['squad', 'bob'],
            current: [],
            myFriends: new Set(['bob']),
            newFriends: new Set()
        });
        expect(c.hidden).toEqual(['squad']);
        expect(c.removed).toEqual(['bob']);
    });

    it('neuer Freund von mir taucht still auf', () => {
        const c = classifyChanges({
            known: [],
            current: ['neu', 'alt'],
            myFriends: new Set(['neu', 'alt']),
            newFriends: new Set(['neu']),
            hidden: new Set()
        });
        expect(c.silentAdded).toEqual(['neu']);
        expect(c.added).toEqual(['alt']);
    });

    it('verdeckte Kante kommt still zurueck, neuer Freund liefert nur Ausgangszustand', () => {
        const a = classifyChanges({
            known: [],
            current: ['x'],
            myFriends: new Set(['x']),
            newFriends: new Set(),
            hidden: new Set(['x'])
        });
        expect(a.added).toEqual([]);
        const b = classifyChanges({
            known: [],
            current: ['x', 'y'],
            myFriends: new Set(['x', 'y']),
            newFriends: new Set(),
            friendIsNew: true
        });
        expect(b.added).toEqual([]);
        expect(b.silentAdded).toHaveLength(2);
    });
});

describe('isMassDrop', () => {
    it('erkennt grosse Abgaenge, nicht einzelne', () => {
        expect(isMassDrop(1, 10)).toBe(false);
        expect(isMassDrop(5, 100)).toBe(false);
        expect(isMassDrop(30, 60)).toBe(true);
    });
});

describe('wasFriendAt', () => {
    it('folgt der Freundes-Historie', () => {
        const cur = new Set();
        expect(wasFriendAt(hist, 'squad', '2026-11-01T00:00:00Z', cur)).toBe(true);
        expect(wasFriendAt(hist, 'squad', '2026-11-15T22:34:00Z', cur)).toBe(false);
        expect(wasFriendAt(hist, 'squad', '2026-10-01T00:00:00Z', cur)).toBe(false);
        expect(wasFriendAt(hist, 'ohne', '2026-10-01T00:00:00Z', new Set(['ohne']))).toBe(true);
    });
});

describe('findFalseEvents', () => {
    it('TheSquad-Fall: Entfernungen nach dem Unfriend sind Fehleintraege', () => {
        const events = [
            { id: 1, friendId: 'lilith', mutualId: 'squad', type: 'removed', detectedAt: '2026-11-15T22:34:00Z', runId: 159 },
            { id: 2, friendId: 'hiro', mutualId: 'squad', type: 'removed', detectedAt: '2026-11-16T04:48:00Z', runId: 160 },
            { id: 3, friendId: 'hiro', mutualId: 'bob', type: 'removed', detectedAt: '2026-11-16T04:48:00Z', runId: 160 },
            { id: 4, friendId: 'hiro', mutualId: 'neu', type: 'added', detectedAt: '2026-11-10T12:00:00Z', runId: 140 },
            { id: 5, friendId: 'hiro', mutualId: 'bob', type: 'added', detectedAt: '2026-11-10T12:00:00Z', runId: 140 },
            // Scan sah es Minuten bevor VRCX das Unfriend notierte
            { id: 6, friendId: 'yana', mutualId: 'squad', type: 'removed', detectedAt: '2026-11-15T22:30:48.186Z', runId: 159 }
        ];
        const prev = new Map([
            [140, '2026-11-10T04:00:00Z'],
            [159, '2026-11-15T16:00:00Z'],
            [160, '2026-11-15T22:00:00Z']
        ]);
        const res = findFalseEvents(events, hist, new Set(['bob', 'hiro', 'lilith', 'neu']), prev);
        expect(res.removed.map((e) => e.id)).toEqual([1, 2, 6]);
        expect(res.added.map((e) => e.id)).toEqual([4]);
    });
});

describe('planVerification', () => {
    it('fragt die gemeinsame Person nur einmal ab', () => {
        const pairs = [
            { friendId: 'f1', mutualId: 'm' },
            { friendId: 'f2', mutualId: 'm' },
            { friendId: 'f3', mutualId: 'm' }
        ];
        const { plan, unknown } = planVerification(pairs, new Set(['f1', 'f2', 'f3', 'm']));
        expect(unknown).toEqual([]);
        expect([...plan.keys()]).toEqual(['m']);
        expect(plan.get('m').map((x) => x.other)).toEqual(['f1', 'f2', 'f3']);
    });

    it('ohne Freund auf einer Seite: nicht pruefbar', () => {
        const { plan, unknown } = planVerification([{ friendId: 'a', mutualId: 'b' }], new Set());
        expect(plan.size).toBe(0);
        expect(unknown).toHaveLength(1);
    });
});
