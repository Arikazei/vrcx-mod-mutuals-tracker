import { hasBaseline, importBaseline, initTables } from './db';
import { initSettings } from './settings';
import { startSchedule } from './schedule';
import { scanState, setCtx } from './runtime';
import { checkDepartures, cleanupFalseEvents } from './integrity';
import { refreshUnseen, startNavDot } from './notify';
import { MOD_VERSION } from './version';
import MutualsView from './MutualsView.vue';

export { MOD_VERSION };

export default {
    id: 'mutualstracker',
    name: 'Mutuals Tracker',
    version: MOD_VERSION,

    async setup(ctx) {
        setCtx(ctx);

        ctx.onLogin(async () => {
            try {
                await initTables(ctx);
                await initSettings(ctx);

                // Beim ersten Start VRCXs vorhandenen Mutual-Graph als
                // Ausgangszustand uebernehmen - sonst waere der erste Scan ein
                // Meer aus falschen "neu dazugekommen"-Meldungen.
                if (!(await hasBaseline(ctx))) {
                    const n = await importBaseline(ctx);
                    ctx.log(`Ausgangszustand uebernommen: ${n} Verbindungen`);
                }

                // 0.3.0: Fehleintraege aus frueheren Versionen einmalig entfernen
                try {
                    await cleanupFalseEvents(ctx);
                } catch (err) {
                    ctx.warn('Bereinigung fehlgeschlagen:', err);
                }

                startNavDot();
                await refreshUnseen(ctx);

                // Ex-Freunde nachsehen, sobald die Freundesliste da ist - wenige Anfragen
                setTimeout(async () => {
                    if (scanState.running) return;
                    if (!(ctx.stores.friends?.friends?.size > 0)) return;
                    scanState.running = true;
                    scanState.source = 'departures';
                    try {
                        const r = await checkDepartures(ctx, { shouldStop: () => scanState.stopRequested });
                        if (r.checked) ctx.log(`Ex-Freunde nachgeprueft: ${r.checked}`);
                    } catch (err) {
                        ctx.warn('Ex-Freunde-Pruefung fehlgeschlagen:', err);
                    } finally {
                        scanState.running = false;
                        scanState.source = null;
                        scanState.stopRequested = false;
                    }
                }, 60 * 1000);

                startSchedule(ctx);
            } catch (err) {
                ctx.error('Initialisierung fehlgeschlagen:', err);
            }
        });

        ctx.ui.addNavView({
            key: 'mutuals',
            component: MutualsView,
            icon: 'ri-group-2-line',
            label: { en: 'Mutuals Tracker', de: 'Mutuals-Tracker' }
        });
    }
};
