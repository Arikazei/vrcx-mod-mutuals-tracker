<template>
    <div class="mt-root">
        <div class="mt-head">
            <h2 class="mt-title">{{ t('mods.mutualstracker.nav') }}</h2>
            <div class="mt-seg">
                <button
                    v-for="tab in TABS"
                    :key="tab.key"
                    class="mt-tab"
                    :class="{ 'mt-tab--active': view === tab.key }"
                    @click="view = tab.key">
                    {{ tab.label }}
                </button>
            </div>
            <input v-model="search" class="mt-search" type="text" placeholder="Suche…" />
            <button class="mt-btn" :class="{ 'mt-btn--on': showPicker }" @click="showPicker = !showPicker">
                Personen ({{ visibleCountLabel }})
            </button>
            <span class="mt-muted">{{ statusLine }}</span>
            <span class="mt-hint">v{{ MOD_VERSION }}</span>
        </div>

        <!-- Personenauswahl: reiner Anzeigefilter, gescannt wird weiterhin alles -->
        <div v-if="showPicker" class="mt-picker">
            <div class="mt-picker-head">
                <input v-model="pickerSearch" class="mt-search" type="text" placeholder="Person suchen…" />
                <button class="mt-btn" @click="selectAll">Alle</button>
                <button class="mt-btn" @click="selectNone">Keine</button>
                <span class="mt-muted">
                    {{ settings.visible === null ? 'alle sichtbar' : settings.visible.length + ' ausgewählt' }}
                </span>
                <button class="mt-btn mt-btn--on" @click="applyPicker">Übernehmen</button>
            </div>
            <div class="mt-picker-list">
                <label v-for="p in pickerPeople" :key="p.userId" class="mt-picker-item">
                    <input type="checkbox" :checked="isPicked(p.userId)" @change="togglePick(p.userId)" />
                    <span>{{ p.name }}</span>
                </label>
                <span v-if="!pickerPeople.length" class="mt-muted">Keine Treffer.</span>
            </div>
        </div>

        <!-- Scan-Leiste -->
        <div class="mt-scanbar">
            <button v-if="!scanning" class="mt-btn" @click="startScan">Scan starten</button>
            <button v-else class="mt-btn mt-btn--on" @click="stopScan">Stopp</button>
            <span v-if="scanning" class="mt-muted">
                {{ progress.done }}/{{ progress.total }} · {{ progress.changes }} Änderungen ·
                {{ progress.optedOut }} nicht einsehbar
            </span>
            <span v-else-if="lastRun" class="mt-muted">
                zuletzt: {{ formatDate(lastRun.finishedAt || lastRun.startedAt) }}
                <template v-if="lastRun.baseline"> (Ausgangszustand)</template>
                <template v-else> · {{ lastRun.scanned }} Freunde geprüft</template>
            </span>
            <label class="mt-muted mt-auto">
                <input type="checkbox" :checked="settings.autoScan.enabled" @change="toggleAuto" />
                automatisch alle
                <input
                    class="mt-num"
                    type="number"
                    min="1"
                    max="48"
                    :value="settings.autoScan.hours"
                    @change="setAutoHours($event)" />
                Stunden
            </label>
            <span v-if="scanSource === 'auto'" class="mt-muted">(läuft gerade automatisch)</span>
            <span class="mt-hint">
                Ein Scan fragt jeden Freund einzeln ab (1 Anfrage / 1,5 s) — bei {{ friendCount }} Freunden also
                rund {{ Math.ceil((friendCount * 1.5) / 60) }} Minuten.
            </span>
        </div>

        <!-- Tab: eigene Liste -->
        <div v-if="view === 'own'" class="mt-scroll">
            <table class="mt-table">
                <thead>
                    <tr>
                        <th>Person</th>
                        <th>Ereignis</th>
                        <th>Wann</th>
                        <th>Dauer der Freundschaft</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in visibleOwn" :key="row.userId + row.at">
                        <td>
                            <a class="mt-link" @click="openUser(row.userId)">{{ row.displayName || row.userId }}</a>
                        </td>
                        <td>
                            <span class="mt-badge" :class="row.type === 'unfriend' ? 'mt-badge--out' : 'mt-badge--in'">
                                {{ row.type === 'unfriend' ? 'entfreundet' : 'hinzugefügt' }}
                            </span>
                        </td>
                        <td>{{ formatDate(row.at) }}<span class="mt-muted"> · {{ ago(row.at) }}</span></td>
                        <td class="mt-muted">{{ spanLabel(row) }}</td>
                    </tr>
                    <tr v-if="!visibleOwn.length">
                        <td colspan="4" class="mt-empty">Keine Einträge.</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Tab: Veraenderungen bei Freunden -->
        <div v-else-if="view === 'changes'" class="mt-scroll">
            <p v-if="!events.length" class="mt-empty">
                Noch keine Veränderungen aufgezeichnet. Der erste Scan legt den Ausgangszustand fest, ab dem zweiten
                werden Unterschiede sichtbar.
            </p>
            <table v-else class="mt-table">
                <thead>
                    <tr>
                        <th>Bei wem</th>
                        <th>Wer</th>
                        <th>Was</th>
                        <th>Erkannt</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(row, i) in visibleEvents" :key="i">
                        <td>
                            <a class="mt-link" @click="openUser(row.friendId)">{{ nameOf(row.friendId) }}</a>
                        </td>
                        <td>
                            <a class="mt-link" @click="openUser(row.mutualId)">{{ nameOf(row.mutualId) }}</a>
                        </td>
                        <td>
                            <span class="mt-badge" :class="row.type === 'removed' ? 'mt-badge--out' : 'mt-badge--in'">
                                {{ row.type === 'removed' ? 'raus' : 'dazu' }}
                            </span>
                        </td>
                        <td>{{ formatDate(row.detectedAt) }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Tab: Aufraeumaktionen -->
        <div v-else class="mt-scroll">
            <p v-if="!purges.length" class="mt-empty">
                Keine Aufräumaktionen erkannt. Dafür müssen mindestens zwei deiner Freunde dieselbe Person im selben
                Zeitraum verloren haben.
            </p>
            <div v-for="(g, i) in visiblePurges" :key="i" class="mt-card">
                <div class="mt-card-head">
                    <a class="mt-link mt-strong" @click="openUser(g.mutualId)">{{ nameOf(g.mutualId) }}</a>
                    <span class="mt-muted">
                        hat sich bei {{ g.friendIds.length }} deiner Freunde entfernt ·
                        {{ formatDate(g.from) }}<template v-if="g.to !== g.from"> bis {{ formatDate(g.to) }}</template>
                    </span>
                </div>
                <div class="mt-card-body">
                    <div>
                        <span class="mt-muted">Weg bei:</span>
                        <a v-for="id in g.friendIds" :key="id" class="mt-chip" @click="openUser(id)">{{ nameOf(id) }}</a>
                    </div>
                    <div v-if="contextFor(g.mutualId).stillWith.length">
                        <span class="mt-muted">Noch drin bei:</span>
                        <a
                            v-for="id in contextFor(g.mutualId).stillWith.slice(0, 12)"
                            :key="id"
                            class="mt-chip mt-chip--soft"
                            @click="openUser(id)">
                            {{ nameOf(id) }}
                        </a>
                        <span v-if="contextFor(g.mutualId).stillWith.length > 12" class="mt-muted">
                            +{{ contextFor(g.mutualId).stillWith.length - 12 }}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed, onActivated, onMounted, ref } from 'vue';

    import { buildOwnTimeline, friendshipSpans, groupPurges, purgeContext } from './engine';
    import { loadEdges, loadEvents, loadOwnHistory, loadRuns } from './db';
    import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
    import { runScan } from './scanner';
    import { getCtx, scanState } from './runtime';
    import { MOD_VERSION } from './version';
    import { t } from './i18n';

    const TABS = [
        { key: 'own', label: 'Meine Liste' },
        { key: 'changes', label: 'Veränderungen' },
        { key: 'purges', label: 'Aufräumaktionen' }
    ];

    const view = ref('own');
    const search = ref('');
    const ownTimeline = ref([]);
    const spans = ref([]);
    const events = ref([]);
    const edges = ref([]);
    const runs = ref([]);
    const names = ref(new Map());
    const settings = ref(structuredClone(DEFAULT_SETTINGS));
    const showPicker = ref(false);
    const pickerSearch = ref('');
    const pickerDraft = ref(null); // null = alle

    // Scan-Zustand liegt im Modul, nicht in der View: so sieht man auch einen
    // Lauf, der im Hintergrund vom Zeitplan gestartet wurde.
    const scanning = computed(() => scanState.running);
    const scanSource = computed(() => scanState.source);
    const progress = computed(() => scanState.progress);

    const lastRun = computed(() => runs.value[0] || null);
    const friendCount = computed(() => getCtx().stores.friends?.friends?.size ?? 0);

    const statusLine = computed(() => {
        if (view.value === 'own') return `${visibleOwn.value.length} Ereignisse`;
        if (view.value === 'changes') return `${visibleEvents.value.length} Veränderungen`;
        return `${visiblePurges.value.length} Aktionen`;
    });

    /** Namen aus der Freundesliste und aus der eigenen Historie. */
    function buildNames() {
        const map = new Map();
        const friends = getCtx().stores.friends?.friends;
        if (friends) {
            for (const [id, f] of friends) {
                const n = f?.ref?.displayName || f?.displayName;
                if (n) map.set(id, n);
            }
        }
        for (const row of ownTimeline.value) {
            if (row.displayName && !map.has(row.userId)) map.set(row.userId, row.displayName);
        }
        names.value = map;
    }

    function nameOf(userId) {
        return names.value.get(userId) || (userId || '').slice(0, 12) + '…';
    }

    function openUser(userId) {
        try {
            getCtx().ui.showUserDialog(userId);
        } catch (err) {
            getCtx().error('showUserDialog:', err);
        }
    }

    function formatDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('de-AT', {
            year: '2-digit',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function ago(iso) {
        const days = (Date.now() - new Date(iso)) / 86400000;
        if (days < 1) return 'heute';
        if (days < 60) return `vor ${Math.floor(days)} Tagen`;
        return `vor ${(days / 30.44).toFixed(1)} Monaten`;
    }

    function spanLabel(row) {
        const entry = spans.value.find((s) => s.userId === row.userId);
        const span = entry?.spans?.find((s) => s.endedAt === row.at || (!s.endedAt && row.type === 'friend'));
        if (!span?.startedAt) return row.type === 'unfriend' ? 'Beginn unbekannt' : 'läuft';
        const end = span.endedAt ? new Date(span.endedAt) : new Date();
        const days = (end - new Date(span.startedAt)) / 86400000;
        return days < 60 ? `${Math.round(days)} Tage` : `${(days / 30.44).toFixed(1)} Monate`;
    }

    const purges = computed(() => groupPurges(events.value.filter((e) => e.type === 'removed')));

    const ctxCache = new Map();
    function contextFor(mutualId) {
        if (!ctxCache.has(mutualId)) ctxCache.set(mutualId, purgeContext(mutualId, edges.value));
        return ctxCache.get(mutualId);
    }

    function matches(...parts) {
        const q = search.value.trim().toLowerCase();
        if (!q) return true;
        return parts.some((p) => String(p || '').toLowerCase().includes(q));
    }

    /** null = kein Filter. Sonst Menge der sichtbaren userIds. */
    const visibleSet = computed(() => (settings.value.visible === null ? null : new Set(settings.value.visible)));

    function shown(...ids) {
        const set = visibleSet.value;
        if (!set) return true;
        return ids.some((id) => id && set.has(id));
    }

    const visibleCountLabel = computed(() =>
        settings.value.visible === null ? 'alle' : String(settings.value.visible.length)
    );

    const visibleOwn = computed(() =>
        ownTimeline.value.filter((r) => shown(r.userId) && matches(r.displayName, r.userId))
    );
    const visibleEvents = computed(() =>
        events.value.filter(
            (r) => shown(r.friendId, r.mutualId) && matches(nameOf(r.friendId), nameOf(r.mutualId), r.friendId, r.mutualId)
        )
    );
    const visiblePurges = computed(() =>
        purges.value.filter((g) => shown(g.mutualId, ...g.friendIds) && matches(nameOf(g.mutualId), g.mutualId))
    );

    // ----------------------------------------------------------- Personenwahl
    /** Alle Personen, die irgendwo vorkommen - Freunde plus Namen aus der Historie. */
    const allPeople = computed(() => {
        const map = new Map();
        for (const [id, name] of names.value) map.set(id, name);
        for (const row of ownTimeline.value) if (!map.has(row.userId)) map.set(row.userId, row.displayName || row.userId);
        return [...map.entries()]
            .map(([userId, name]) => ({ userId, name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });

    const pickerPeople = computed(() => {
        const q = pickerSearch.value.trim().toLowerCase();
        const list = q ? allPeople.value.filter((p) => p.name.toLowerCase().includes(q)) : allPeople.value;
        return list.slice(0, 400);
    });

    function isPicked(userId) {
        return pickerDraft.value === null || pickerDraft.value.has(userId);
    }

    function togglePick(userId) {
        // Aus "alle" wird beim ersten Abwaehlen eine echte Auswahl
        if (pickerDraft.value === null) pickerDraft.value = new Set(allPeople.value.map((p) => p.userId));
        if (pickerDraft.value.has(userId)) pickerDraft.value.delete(userId);
        else pickerDraft.value.add(userId);
        pickerDraft.value = new Set(pickerDraft.value);
    }

    function selectAll() {
        pickerDraft.value = null;
    }

    function selectNone() {
        pickerDraft.value = new Set();
    }

    async function applyPicker() {
        settings.value.visible = pickerDraft.value === null ? null : [...pickerDraft.value];
        showPicker.value = false;
        await persist();
    }

    async function persist() {
        try {
            await saveSettings(getCtx(), JSON.parse(JSON.stringify(settings.value)));
        } catch (err) {
            getCtx().error('Einstellungen nicht gespeichert:', err);
        }
    }

    async function toggleAuto(event) {
        settings.value.autoScan.enabled = event.target.checked;
        await persist();
    }

    async function setAutoHours(event) {
        const n = Number(event.target.value);
        settings.value.autoScan.hours = Math.min(48, Math.max(1, Number.isFinite(n) ? n : 6));
        await persist();
    }

    async function refresh() {
        const ctx = getCtx();
        try {
            ownTimeline.value = buildOwnTimeline(await loadOwnHistory(ctx));
            spans.value = friendshipSpans(ownTimeline.value);
            events.value = await loadEvents(ctx);
            edges.value = await loadEdges(ctx);
            runs.value = await loadRuns(ctx);
            settings.value = await loadSettings(ctx);
            pickerDraft.value = settings.value.visible === null ? null : new Set(settings.value.visible);
            ctxCache.clear();
            buildNames();
        } catch (err) {
            ctx.error('Laden fehlgeschlagen:', err);
        }
    }

    async function startScan() {
        const ctx = getCtx();
        if (scanState.running) return; // laeuft schon - z.B. automatisch im Hintergrund

        scanState.running = true;
        scanState.source = 'manual';
        scanState.stopRequested = false;
        scanState.progress = { done: 0, total: friendCount.value, changes: 0, optedOut: 0 };
        try {
            await runScan(ctx, {
                onProgress: (p) => (scanState.progress = p),
                shouldStop: () => scanState.stopRequested
            });
        } catch (err) {
            ctx.error('Scan abgebrochen:', err);
        } finally {
            scanState.running = false;
            scanState.source = null;
            await refresh();
        }
    }

    function stopScan() {
        scanState.stopRequested = true;
    }

    onMounted(refresh);
    onActivated(refresh);
</script>

<style scoped>
    .mt-root {
        padding: 16px;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .mt-head {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 10px;
    }
    .mt-title {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
    }
    .mt-seg {
        display: inline-flex;
        gap: 2px;
        border: 1px solid var(--border, #4443);
        border-radius: 8px;
        padding: 2px;
    }
    .mt-tab,
    .mt-btn {
        padding: 4px 10px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--muted-foreground, #9f9fa5);
        cursor: pointer;
        font-size: 12px;
    }
    .mt-tab--active,
    .mt-btn--on {
        background: var(--accent, #3f3f46);
        color: inherit;
    }
    .mt-btn {
        border-color: var(--border, #4443);
    }
    .mt-btn:hover {
        color: inherit;
    }
    .mt-search {
        padding: 4px 8px;
        border: 1px solid var(--border, #4443);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-size: 12px;
        min-width: 160px;
    }
    .mt-scanbar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 12px;
        padding: 8px 10px;
        border: 1px solid var(--border, #4443);
        border-radius: 8px;
    }
    .mt-muted {
        font-size: 12px;
        opacity: 0.68;
    }
    .mt-hint {
        font-size: 11px;
        opacity: 0.5;
        margin-left: auto;
    }
    .mt-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
    }
    .mt-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        min-width: 640px;
    }
    .mt-table th,
    .mt-table td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border, #4442);
        text-align: left;
    }
    .mt-table thead th {
        position: sticky;
        top: 0;
        background: var(--background, #18181b);
        font-weight: 500;
        opacity: 0.8;
    }
    .mt-badge {
        display: inline-block;
        padding: 1px 7px;
        border: 1px solid;
        border-radius: 10px;
        font-size: 11px;
    }
    .mt-badge--in {
        border-color: #51e57e88;
        color: #51e57e;
    }
    .mt-badge--out {
        border-color: #e64a4a88;
        color: #e64a4a;
    }
    .mt-link {
        cursor: pointer;
    }
    .mt-link:hover {
        text-decoration: underline;
    }
    .mt-strong {
        font-weight: 600;
        font-size: 14px;
    }
    .mt-card {
        border: 1px solid var(--border, #4443);
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 10px;
    }
    .mt-card-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 6px;
    }
    .mt-card-body {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12px;
    }
    .mt-chip {
        display: inline-block;
        margin: 2px 4px 0 0;
        padding: 1px 8px;
        border: 1px solid var(--border, #4443);
        border-radius: 10px;
        cursor: pointer;
    }
    .mt-chip--soft {
        opacity: 0.6;
    }
    .mt-empty {
        text-align: center;
        opacity: 0.6;
        padding: 24px;
        font-size: 13px;
    }
    .mt-picker {
        border: 1px solid var(--border, #4443);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 10px;
    }
    .mt-picker-head {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 8px;
    }
    .mt-picker-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 2px 12px;
        max-height: 220px;
        overflow: auto;
    }
    .mt-picker-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        padding: 2px 0;
        cursor: pointer;
    }
    .mt-num {
        width: 48px;
        padding: 2px 4px;
        border: 1px solid var(--border, #4443);
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font-size: 12px;
    }
    .mt-auto {
        display: inline-flex;
        align-items: center;
        gap: 5px;
    }
</style>
