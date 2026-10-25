/**
 * Model families, in the spelling they are shown in. The provider reports a
 * full id (`claude-opus-5-5`, `claude-haiku-4-5-20251001`); the label keeps the
 * family and its version, and the exact id stays in the tooltip.
 */
const MODEL_FAMILY_LABELS: ReadonlyArray<readonly [token: string, label: string]> = [
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
  ['mythos', 'Mythos'],
];

/**
 * One version component: one or two digits that are not the start of a longer
 * number or word, so a release date (`20250929`) or a suffix such as `1m` or
 * `v1` ends the version instead of joining it.
 */
const VERSION_PART = String.raw`\d{1,2}(?![0-9a-z])`;

/**
 * Reads the version written after the family (`claude-opus-4-5`), or before it
 * in the older `claude-3-5-sonnet` order. Parts are separated by `-` in
 * Anthropic, Bedrock and Vertex ids and by `.` in some gateway ids
 * (`claude-opus-4.5`). Returns `null` for an id with no version, such as the
 * bare `opus` alias.
 */
const readModelVersion = (normalizedModel: string, familyToken: string): string | null => {
  const versionAfterFamily = new RegExp(`${familyToken}((?:[-.]${VERSION_PART})+)`).exec(normalizedModel);
  const versionBeforeFamily = versionAfterFamily
    ? null
    : new RegExp(`(?:^|[^0-9a-z.])(${VERSION_PART}(?:[-.]${VERSION_PART})*)[-.]${familyToken}`).exec(normalizedModel);
  const versionParts = (versionAfterFamily ?? versionBeforeFamily)?.[1]
    .split(/[-.]/)
    .filter(Boolean);

  return versionParts && versionParts.length > 0 ? versionParts.join('.') : null;
};

/**
 * Shortens a reported model id to a readable "family version" label, or
 * returns `null` when there is nothing to show. Used by chat's
 * MessageModelLabel under each reply, and by ComposerModelMenu to name a model
 * that is missing from the provider's catalog.
 *
 * Release dates and provider prefixes are dropped
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0` reads "Sonnet 4.5"). An id
 * from no known family is shown verbatim rather than dropped, so an
 * unrecognized model still reports itself honestly. A `[1m]` suffix is kept as
 * "1M" instead of being folded into the base model: Claude Code writes the
 * base id on assistant rows today, but if a provider ever reports the 1M
 * variant it must not read as the 200K one.
 */
export const formatAnsweringModelLabel = (model: string | undefined): string | null => {
  const reportedModel = model?.trim();
  if (!reportedModel) {
    return null;
  }

  const normalized = reportedModel.toLowerCase();
  const family = MODEL_FAMILY_LABELS.find(([token]) => normalized.includes(token));
  if (!family) {
    return reportedModel;
  }

  const [familyToken, familyLabel] = family;
  const version = readModelVersion(normalized, familyToken);
  const versionedLabel = version ? `${familyLabel} ${version}` : familyLabel;
  return normalized.endsWith('[1m]') ? `${versionedLabel} 1M` : versionedLabel;
};
