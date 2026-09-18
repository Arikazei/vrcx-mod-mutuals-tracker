import { loadRuns } from './db';
import { loadSettings } from './settings';
import { runScan } from './scanner';
import { scanState } from './runtime';

const CHECK_EVERY_MS = 10 * 60 * 1000; // alle 10 Minuten nachsehen, ob faellig

/**
 * Haelt den Mutual-Stand von selbst aktuell.
 *
 * Der Zeitplan laeuft im Mod-Setup, nicht in der View - sonst wuerde nur
 * gescannt, solange die Seite offen ist. Ein Lauf dauert bei ~360 Freunden rund
 * 9 Minuten; deshalb wird nicht nach der Uhr gestartet, sondern gemessen am
 * Abstand zum letzten abgeschlossenen Lauf.
 */
export function startSchedule(ctx) {
    let timer = null;

    async function dueSince() {
        const runs = await loadRuns(ctx, 10);
        const last = runs.find((r) => !r.baseline && r.finishedAt);
        return last ? Date.now() - new Date(last.finishedAt).getTime() : Infinity;
    }

    async function check() {
        try {
            if (scanState.running) return;

            const settings = await loadSettings(ctx);
            if (!settings.autoScan?.enabled) return;

            const gapMs = Math.max(1, Number(settings.autoScan.hours) || 6) * 3600 * 1000;
            if ((await dueSince()) < gapMs) return;

            ctx.log('automatischer Scan startet');
            scanState.running = true;
            scanState.source = 'auto';
            scanState.stopRequested = false;
            try {
                const res = await runScan(ctx, {
                    onProgress: (p) => (scanState.progress = p),
                    shouldStop: () => scanState.stopRequested
                });
                ctx.log(`automatischer Scan fertig: ${res.scanned} geprueft, ${res.changes} Aenderungen`);
            } finally {
                scanState.running = false;
                scanState.source = null;
            }
        } catch (err) {
            ctx.warn('automatischer Scan fehlgeschlagen:', err);
            scanState.running = false;
            scanState.source = null;
        }
    }

    // Erster Blick mit Verzoegerung: nach dem Login ist VRCX ohnehin beschaeftigt.
    setTimeout(check, 2 * 60 * 1000);
    timer = setInterval(check, CHECK_EVERY_MS);

    return () => clearInterval(timer);
}
