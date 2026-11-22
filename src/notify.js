import { reactive } from 'vue';

import { groupPurges, latestPurgeEntry } from './engine';
import { getMeta, loadDepartures, loadEvents, loadHiddenLists, setMeta } from './db';

/**
 * Roter Punkt fuer neue Eintraege in "Aufraeumaktionen" - am Reiter in der
 * Ansicht und am Eintrag in VRCXs Navigation.
 */
export const notifyState = reactive({ unseen: false });

const SEEN_KEY = 'purgesSeenAt';
const NAV_KEY = 'mutuals';
let navTimer = null;

export async function refreshUnseen(ctx) {
    try {
        const departures = await loadDepartures(ctx);
        const hiddenLists = await loadHiddenLists(ctx);
        const removals = (await loadEvents(ctx, 'removed')).filter((e) => e.source !== 'departure');
        const latest = latestPurgeEntry({ departures, groups: groupPurges(removals), hiddenLists });

        let seen = await getMeta(ctx, SEEN_KEY);
        if (!seen) {
            // Erster Start mit dieser Version: Bestehendes gilt als gesehen
            seen = new Date().toISOString();
            await setMeta(ctx, SEEN_KEY, seen);
        }
        notifyState.unseen = !!latest && latest > seen;
    } catch (err) {
        ctx.warn('Benachrichtigung nicht berechnet:', err);
    }
    applyNavDot();
}

export async function markSeen(ctx) {
    await setMeta(ctx, SEEN_KEY, new Date().toISOString());
    notifyState.unseen = false;
    applyNavDot();
}

/** Punkt am Nav-Eintrag - VRCXs Optik (gleiche Klasse wie bei den Original-Eintraegen). */
export function applyNavDot() {
    const icon = document.querySelector(`li[data-vrcx-mod="${NAV_KEY}"] i[class*="ri-"]`);
    if (!icon) return;
    let dot = icon.querySelector('[data-vrcx-mods-dot]');

    if (!notifyState.unseen) {
        dot?.remove();
        // Vom Klonen mitgeschleppter Original-Punkt darf nicht stehen bleiben
        icon.querySelectorAll('.notify-dot-not-collapsed').forEach((n) => n.remove());
        return;
    }
    if (dot) return;

    dot = document.createElement('span');
    dot.setAttribute('data-vrcx-mods-dot', '');
    dot.setAttribute('aria-hidden', 'true');
    dot.className = 'bg-red-500';
    Object.assign(dot.style, {
        position: 'absolute',
        top: '4px',
        right: '0',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        transform: 'translateY(-50%)',
        background: '#ef4444'
    });
    icon.style.position ||= 'relative';
    icon.appendChild(dot);
}

/** Der Nav-Eintrag wird bei Layout-Wechseln neu erzeugt - Punkt regelmaessig nachziehen. */
export function startNavDot() {
    if (navTimer) return;
    navTimer = setInterval(applyNavDot, 2000);
}
