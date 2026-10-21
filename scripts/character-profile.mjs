import fs from "node:fs";
import path from "node:path";

const ASCII_ONLY = /^[\x00-\x7F]*$/;

export function assertAsciiEnglish(value, label) {
  if (typeof value !== "string" || !ASCII_ONLY.test(value)) {
    throw new Error(`${label} must contain ASCII characters only (English text only).`);
  }
  return value;
}

export function validateCharacterProfile(profile, profilePath) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Character profile must be a JSON object.");
  }
  for (const key of ["id", "name", "fixed_appearance", "default_wardrobe", "rules", "reference_images"]) {
    if (!(key in profile)) throw new Error(`Character profile is missing required field '${key}'.`);
  }
  if (typeof profile.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile.id)) {
    throw new Error("Character profile id must use only letters, digits, underscore, and hyphen.");
  }
  if (typeof profile.name !== "string" || !profile.name.trim()) throw new Error("Character profile name must be non-empty.");
  assertAsciiEnglish(profile.name, "Character name");
  assertAsciiEnglish(profile.fixed_appearance, "Character fixed_appearance");
  assertAsciiEnglish(profile.default_wardrobe, "Character default_wardrobe");
  if (!Array.isArray(profile.rules) || profile.rules.length < 1 || profile.rules.some(rule => typeof rule !== "string" || !rule.trim())) {
    throw new Error("Character profile rules must contain at least one non-empty string.");
  }
  profile.rules.forEach((rule, i) => assertAsciiEnglish(rule, `Character rule ${i + 1}`));
  if (!Array.isArray(profile.reference_images) || profile.reference_images.length < 1 || profile.reference_images.length > 3) {
    throw new Error("Character profile must define 1 to 3 local reference_images.");
  }
  const baseDir = path.dirname(path.resolve(profilePath));
  const references = profile.reference_images.map((entry, i) => {
    const localPath = typeof entry === "string" ? entry : entry?.path;
    if (typeof localPath !== "string" || !localPath.trim()) {
      throw new Error(`Reference image ${i + 1} must provide a local path.`);
    }
    const absolute = path.resolve(baseDir, localPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Reference image ${i + 1} does not exist or is not a file: ${absolute}`);
    }
    const ext = path.extname(absolute).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
      throw new Error(`Reference image ${i + 1} must be PNG, JPG, JPEG, or WEBP: ${absolute}`);
    }
    return absolute;
  });
  return { ...profile, reference_images: references };
}

export function loadCharacterProfile(profilePath, expectedId) {
  if (!profilePath) throw new Error("Scene must use character_id and --character-profile must point to that character's local profile JSON.");
  const absolutePath = path.resolve(profilePath);
  const profile = validateCharacterProfile(JSON.parse(fs.readFileSync(absolutePath, "utf8")), absolutePath);
  if (profile.id !== expectedId) {
    throw new Error(`Character profile id mismatch: scene requests ${JSON.stringify(expectedId)}, profile is ${JSON.stringify(profile.id)}.`);
  }
  return profile;
}

export function composeCharacterPrompt(scenePrompt, profile) {
  assertAsciiEnglish(scenePrompt, "Scene prompt");
  const sections = [
    `CHARACTER IDENTITY (KEEP CONSISTENT): ${profile.name}. ${profile.fixed_appearance.trim()}`,
    `DEFAULT WARDROBE: ${profile.default_wardrobe.trim()}`,
    `CHARACTER-SPECIFIC RULES: ${profile.rules.map(rule => rule.trim()).join(" ")}`,
    `SCENE ACTION AND SETTING: ${scenePrompt.trim()}`,
    "Preserve the same person's identity and facial features as the attached reference images. Do not substitute a different person. Keep the full body visible when the scene requires it."
  ];
  const prompt = sections.join("\n\n");
  assertAsciiEnglish(prompt, "Composed prompt");
  return prompt;
}
