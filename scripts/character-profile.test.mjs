import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertAsciiEnglish, composeCharacterPrompt, loadCharacterProfile, validateCharacterProfile } from "./character-profile.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goglow-character-"));
  const refs = path.join(root, "refs");
  fs.mkdirSync(refs);
  fs.writeFileSync(path.join(refs, "mai.png"), "not a real image; loader checks path and extension only");
  const profilePath = path.join(root, "mai.json");
  const profile = {
    id: "mai",
    name: "Mai",
    fixed_appearance: "Adult woman with long dark hair and a consistent facial identity.",
    default_wardrobe: "Fitted black athletic top and high-waisted black leggings.",
    rules: ["Keep the chest fully covered.", "Keep the waist slim and clearly defined."],
    reference_images: ["refs/mai.png"]
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  return { root, profilePath, profile };
}

test("loads a profile and resolves one local reference image", () => {
  const f = fixture();
  const profile = loadCharacterProfile(f.profilePath, "mai");
  assert.equal(profile.id, "mai");
  assert.equal(profile.reference_images.length, 1);
  assert.equal(path.basename(profile.reference_images[0]), "mai.png");
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("rejects scene/profile ID mismatch", () => {
  const f = fixture();
  assert.throws(() => loadCharacterProfile(f.profilePath, "linh"), /id mismatch/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("rejects missing reference images and more than three references", () => {
  const f = fixture();
  const missing = { ...f.profile, reference_images: ["refs/missing.png"] };
  assert.throws(() => validateCharacterProfile(missing, f.profilePath), /does not exist/);
  const tooMany = { ...f.profile, reference_images: ["refs/mai.png", "refs/mai.png", "refs/mai.png", "refs/mai.png"] };
  assert.throws(() => validateCharacterProfile(tooMany, f.profilePath), /1 to 3/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("rejects non-ASCII character descriptions and composed prompts", () => {
  const f = fixture();
  assert.throws(() => assertAsciiEnglish("Mai có tóc dài", "profile"), /ASCII characters only/);
  const profile = { ...f.profile, reference_images: [] };
  assert.throws(() => composeCharacterPrompt("Perform yoga", profile), /Composed prompt/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("composes a complete ASCII prompt with wardrobe and character rules", () => {
  const f = fixture();
  const profile = loadCharacterProfile(f.profilePath, "mai");
  const prompt = composeCharacterPrompt("Perform one controlled yoga flow.", profile);
  assert.match(prompt, /CHARACTER IDENTITY/);
  assert.match(prompt, /DEFAULT WARDROBE/);
  assert.match(prompt, /Keep the chest fully covered/);
  assert.match(prompt, /SCENE ACTION AND SETTING/);
  assert.match(prompt, /^[\x00-\x7F]+$/);
  fs.rmSync(f.root, { recursive: true, force: true });
});
