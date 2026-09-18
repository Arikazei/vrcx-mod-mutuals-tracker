import { hasBaseline, importBaseline, initTables } from './db';
import { initSettings } from './settings';
import { startSchedule } from './schedule';
import { setCtx } from './runtime';
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
