/**
 * Normalize Flow /asb/ identity tokens. Google image URLs may append
 * transform parameters such as "=mm,18,15"; these do not change asset identity.
 */
export function normalizeAsbIdentityToken(value) {
  const token = String(value || "");
  if (!token.startsWith("asb:")) return token;
  return `asb:${token.slice(4).split("=", 1)[0]}`;
}

/**
 * Fail-closed comparison for the first three thumbnail identities.
 * Nulls and genuinely different asset IDs must never be accepted.
 */
export function firstThreeThumbnailTokensMatch(baselineTokens, currentTokens) {
  const validThumbnail = value => typeof value === "string"
    && /^(?:asb:.+|\/(?:asb|image)\/.+|https?:\/\/.*)$/i.test(value);
  return Array.isArray(baselineTokens) && Array.isArray(currentTokens)
    && baselineTokens.length >= 3 && currentTokens.length >= 3
    && baselineTokens.slice(0, 3).every((token, index) => {
      const current = currentTokens[index];
      if (!validThumbnail(token) || !validThumbnail(current)) return false;
      return normalizeAsbIdentityToken(token) === normalizeAsbIdentityToken(current);
    });
}
