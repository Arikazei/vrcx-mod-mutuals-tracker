const MESSAGES = {
    en: { 'mods.mutualstracker.nav': 'Mutuals Tracker' },
    de: { 'mods.mutualstracker.nav': 'Mutuals-Tracker' }
};

function locale() {
    const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    return MESSAGES[lang] ? lang : 'en';
}

export function t(key) {
    return MESSAGES[locale()]?.[key] ?? MESSAGES.en[key] ?? key;
}
