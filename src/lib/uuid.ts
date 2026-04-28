/**
 * Geração e validação de UUID v4 sem depender exclusivamente de `crypto.randomUUID`
 * (alguns WebViews / navegadores antigos não expõem essa API).
 */

/** Formato UUID (8-4-4-4-12 hex). */
export function isValidUuid(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/** RFC 4122 versão 4 com `crypto.getRandomValues` ou, em último caso, `Math.random`. */
function uuidV4Fallback(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * UUID v4 em formato canônico. Prefere `crypto.randomUUID` quando existir e for válido.
 */
export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      const id = crypto.randomUUID();
      if (isValidUuid(id)) {
        if (import.meta.env.DEV) {
          console.debug('[uuid] usando crypto.randomUUID');
        }
        return id;
      }
    } catch {
      /* continua para fallback */
    }
  }

  if (import.meta.env.DEV) {
    console.debug('[uuid] usando fallback');
  }

  const id = uuidV4Fallback();
  if (!isValidUuid(id)) {
    throw new Error('generateUuid: falha ao construir UUID v4');
  }
  return id;
}
