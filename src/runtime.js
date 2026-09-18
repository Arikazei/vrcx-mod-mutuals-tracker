// ctx-Singleton, damit die View den Kontext nicht durchgereicht bekommen muss.
let ctx = null;

export function setCtx(value) {
    ctx = value;
}

export function getCtx() {
    if (!ctx) throw new Error('Mod-Kontext noch nicht gesetzt');
    return ctx;
}
