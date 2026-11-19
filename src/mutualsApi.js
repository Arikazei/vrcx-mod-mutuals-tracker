/**
 * Direkte Mutual-Abfrage ueber VRCXs HTTP-Kanal - ohne VRCXs eigenen
 * Mutual-Graph anzufassen. Funktioniert auch fuer Leute, die nicht (mehr) mit
 * mir befreundet sind: VRChat liefert dann deren Freunde, die auch meine sind.
 */
const BASE = 'https://api.vrchat.cloud/api/1/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<{ok: boolean, ids: string[], optedOut?: boolean, status?: number}>} */
export async function fetchMutualIds(userId) {
    const svc = window.webApiService;
    if (!svc) return { ok: false, ids: [] };

    const ids = [];
    let offset = 0;
    for (let page = 0; page < 30; page++) {
        const url = `${BASE}users/${encodeURIComponent(userId)}/mutuals/friends?n=100&offset=${offset}`;
        let res = await svc.execute({ url, method: 'GET' });
        if (res?.status === 429) {
            await sleep(5000);
            res = await svc.execute({ url, method: 'GET' });
        }
        if (res?.status === 403 || res?.status === 404) return { ok: false, ids: [], optedOut: true, status: res.status };
        if (res?.status !== 200) return { ok: false, ids: [], status: res?.status };

        let json;
        try {
            json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        } catch {
            return { ok: false, ids: [] };
        }
        if (!Array.isArray(json)) return { ok: false, ids: [] };

        for (const entry of json) if (entry?.id) ids.push(entry.id);
        if (json.length < 100) break;
        offset += json.length;
        await sleep(600);
    }
    return { ok: true, ids };
}
