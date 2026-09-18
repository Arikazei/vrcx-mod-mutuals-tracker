import { reactive } from 'vue';

// ctx-Singleton, damit die View den Kontext nicht durchgereicht bekommen muss.
let ctx = null;

export function setCtx(value) {
    ctx = value;
}

export function getCtx() {
    if (!ctx) throw new Error('Mod-Kontext noch nicht gesetzt');
    return ctx;
}

/**
 * Gemeinsamer Scan-Zustand fuer View und Hintergrund-Zeitplan. Ohne den wuerden
 * ein manueller und ein automatischer Lauf gleichzeitig starten und sich
 * gegenseitig die Rate-Limit-Bremse ruinieren.
 */
export const scanState = reactive({
    running: false,
    source: null,
    progress: { done: 0, total: 0, changes: 0, optedOut: 0 },
    stopRequested: false
});
