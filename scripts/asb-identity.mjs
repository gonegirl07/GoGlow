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
export function firstThreeThumbnailTokensMatch(
  baselineTokens, currentTokens, baselineImageTokens = [], baselineVerifiedAliases = [],
) {
  const validThumbnail = value => typeof value === "string" && (
    /^(?:media:[0-9a-f-]{36}|asb:.+|\/(?:asb|image)\/.+|https?:\/\/.*)$/i.test(value)
    || /^failed-policy:.{20,}$/i.test(value)
  );
  const imageUuid = value => typeof value === "string"
    ? value.match(/^image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1]?.toLowerCase() || null
    : null;
  return Array.isArray(baselineTokens) && Array.isArray(currentTokens)
    && baselineTokens.length >= 3 && currentTokens.length >= 3
    && baselineTokens.slice(0, 3).every((token, index) => {
      const current = currentTokens[index];
      if (!validThumbnail(token) || !validThumbnail(current)) return false;
      if (normalizeAsbIdentityToken(token) === normalizeAsbIdentityToken(current)) return true;
      // The baseline key may be a verified media UUID while the live DOM exposes
      // only the ASB thumbnail URL. Accept that alias only when preflight captured
      // the exact ASB token for this same independently UUID-verified tile.
      const verifiedAlias = baselineVerifiedAliases[index];
      if (typeof verifiedAlias === "string" && verifiedAlias.startsWith("asb:")
        && normalizeAsbIdentityToken(verifiedAlias) === normalizeAsbIdentityToken(current)) return true;
      // Flow's /image/<uuid> is a separate poster identity, not a video UUID.
      // Accept it only as an explicitly captured alias for this same baseline tile,
      // and only when the other first-row identities also match.
      const posterUuid = imageUuid(baselineImageTokens[index]);
      return Boolean(posterUuid && current === \`media:\${posterUuid}\`);
    });
}
