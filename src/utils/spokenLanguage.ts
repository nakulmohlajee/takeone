/** Map short/BCP-47 language codes for STT / UI defaults. */

const TO_BCP47: Record<string, string> = {
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-GB',
  es: 'es-ES',
  'es-es': 'es-ES',
  'es-mx': 'es-MX',
  fr: 'fr-FR',
  de: 'de-DE',
  hi: 'hi-IN',
  'hi-in': 'hi-IN',
  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  ar: 'ar-SA',
  it: 'it-IT',
  nl: 'nl-NL',
  id: 'id-ID',
  vi: 'vi-VN',
  th: 'th-TH',
  tr: 'tr-TR',
  pl: 'pl-PL',
  ru: 'ru-RU',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  pa: 'pa-IN',
};

/** Normalize to a short UI code (e.g. en, hi, es). */
export function normalizeSpokenLanguage(raw: string | undefined | null): string {
  const s = String(raw || 'en').trim().toLowerCase().replace('_', '-');
  if (!s) return 'en';
  if (s.includes('-')) return s.split('-')[0] || 'en';
  return s.slice(0, 8);
}

/** BCP-47 for Google Cloud Speech / Web Speech API. */
export function toSttLanguageCode(raw: string | undefined | null): string {
  const s = String(raw || 'en').trim().toLowerCase().replace('_', '-');
  if (!s) return 'en-US';
  if (TO_BCP47[s]) return TO_BCP47[s];
  const base = s.split('-')[0] || 'en';
  return TO_BCP47[base] || (s.includes('-') ? s : `${base}-${base.toUpperCase()}`);
}

/** Lightweight script detection when Gemini omits spokenLanguage. */
export function detectSpokenLanguageFromText(text: string): string {
  const t = String(text || '');
  if (/[\u0900-\u097F]/.test(t)) return 'hi'; // Devanagari
  if (/[\u0980-\u09FF]/.test(t)) return 'bn';
  if (/[\u0B80-\u0BFF]/.test(t)) return 'ta';
  if (/[\u0C00-\u0C7F]/.test(t)) return 'te';
  if (/[\u0A80-\u0AFF]/.test(t)) return 'gu';
  if (/[\u0A00-\u0A7F]/.test(t)) return 'pa';
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  if (/[\u3040-\u30FF]/.test(t)) return 'ja';
  if (/[\uAC00-\uD7AF]/.test(t)) return 'ko';
  if (/[\u4E00-\u9FFF]/.test(t)) return 'zh';
  if (/[àâçéèêëîïôùûüœæ]/i.test(t) && /\b(le|la|les|des|une|pour|avec)\b/i.test(t)) return 'fr';
  if (/[áéíóúñ¿¡]/i.test(t) && /\b(el|la|los|las|para|con|una)\b/i.test(t)) return 'es';
  if (/[äöüß]/i.test(t) && /\b(der|die|das|und|mit|für)\b/i.test(t)) return 'de';
  if (/\b(o|a|os|as|para|com|uma|você)\b/i.test(t) && /[ãõç]/i.test(t)) return 'pt';
  return 'en';
}

/** True when this device is set up for India (locale or time zone). Browser-only; false on the server. */
export function deviceLooksIndian(): boolean {
  if (typeof navigator === 'undefined') return false;
  const langs = [navigator.language, ...(navigator.languages || [])].map((l) => String(l || '').toLowerCase());
  if (langs.some((l) => l.endsWith('-in'))) return true;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta';
  } catch {
    return false;
  }
}

/**
 * Locale for live (streaming) recognition on this device. English speakers in India get the
 * Indian-English model, which is far more accurate for their accent than en-US.
 */
export function liveSttLanguageCode(raw: string | undefined | null): string {
  const code = toSttLanguageCode(raw);
  if (code === 'en-US' && !String(raw || '').toLowerCase().includes('-') && deviceLooksIndian()) {
    return 'en-IN';
  }
  return code;
}
