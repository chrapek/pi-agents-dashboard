import { randomBytes } from "node:crypto";

export const MAX_SLUG_LENGTH = 32;
const FALLBACK_SLUG = "agent";
const HEX4_RE = /^[0-9a-f]{4}$/;

// Latin letters that NFKD does not decompose into base letter + combining mark.
const LATIN_EXTRAS: Record<string, string> = {
  "ł": "l", "ø": "o", "đ": "d", "ð": "d", "þ": "th", "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i",
};

/** Spec §3 slug: lowercase [a-z0-9-], ≤ 32 chars cut at a word boundary where possible, no edge dashes, "agent" if empty. */
export function slugify(prompt: string): string {
  const ascii = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøđðþßæœı]/g, (ch) => LATIN_EXTRAS[ch] ?? "");
  const words = ascii.split(/[^a-z0-9]+/).filter((w) => w.length > 0);

  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG_LENGTH) {
      if (!slug) slug = word.slice(0, MAX_SLUG_LENGTH);
      break;
    }
    slug = next;
  }
  return slug || FALLBACK_SLUG;
}

function randomHex4(): string {
  return randomBytes(2).toString("hex");
}

/** Agent id = slug + "-" + 4 lowercase hex chars. `randHex` is injectable for tests. */
export function makeId(prompt: string, randHex: () => string = randomHex4): string {
  const suffix = randHex();
  if (!HEX4_RE.test(suffix)) throw new Error(`makeId: random suffix must be 4 lowercase hex chars, got "${suffix}"`);
  return `${slugify(prompt)}-${suffix}`;
}

/** Display name: the slug with "-" replaced by spaces. */
export function nameFromSlug(slug: string): string {
  return slug.replace(/-/g, " ");
}

/** Display name from an id (strips the "-xxxx" suffix). */
export function nameFromId(id: string): string {
  return nameFromSlug(id.replace(/-[0-9a-f]{4}$/, ""));
}
