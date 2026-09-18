import { hasBaseline, importBaseline, initTables } from './db';
import { setCtx } from './runtime';
import MutualsView from './MutualsView.vue';

export default {
    id: 'mutualstracker',
    name: 'Mutuals Tracker',
    version: '0.1.0',

    async setup(ctx) {
        setCtx(ctx);

        ctx.onLogin(async () => {
            try {
                await initTables(ctx);
                // Beim ersten Start VRCXs vorhandenen Mutual-Graph als
                // Ausgangszustand uebernehmen - sonst waere der erste Scan ein
                // Meer aus falschen "neu dazugekommen"-Meldungen.
                if (!(await hasBaseline(ctx))) {
                    const n = await importBaseline(ctx);
                    ctx.log(`Ausgangszustand uebernommen: ${n} Verbindungen`);
                }
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
