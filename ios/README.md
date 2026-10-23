# JevPhoto — a minimal app that runs the pipeline on an iPhone

On the phone, code extracts structured features from each photo (PhotoKit fields as-is, ImageIO EXIF, Vision faces / text / barcodes / aesthetics / feature prints, plus code-computed sharpness / luminance / duplicates). The same hard rules as `rules.js` run first; everything else goes from the phone directly to Jev (`~typesafe/jev-latest`, two questions: delete or keep, and what kind of photo it is). Results are shown in three columns: suggest delete / not sure / keep.

**Nothing is deleted.** Pixels, file names and OCR text never leave the phone; each photo's detail page shows the exact state that was sent.

Question text and key order are generated from `tools/capability/items.js` (`node tools/capability/export-questions.js` → `Model/Questions.swift`). Regenerate after changing the bank.

## Installing on a phone

1. Generate the Xcode project (it is git-ignored): `cd ios/JevPhoto && DEVELOPMENT_TEAM=<your team ID> xcodegen generate`. The team ID comes from the environment and is not stored in the repo; without it, pick a team under Signing & Capabilities in Xcode. First replace the placeholder `com.example` in `project.yml` (`bundleIdPrefix` and `PRODUCT_BUNDLE_IDENTIFIER`) with your own prefix — signing fails with `com.example`.
2. API key: `./ios/gen-secrets.sh` writes `Secrets.plist` from the project's `.env` (git-ignored). Or skip it and paste the key into the app's Settings after installing.
3. `open ios/JevPhoto/JevPhoto.xcodeproj`, pick your iPhone as the destination, ⌘R.
   - Enable Developer Mode on the iPhone first: Settings › Privacy & Security › Developer Mode, then restart.
   - With a free Apple account, trust the certificate once under Settings › General › VPN & Device Management.
   - If Xcode reports a CodeSign "detritus" error, the project is probably in an iCloud-synced folder: run `xattr -cr ios/JevPhoto`, or put DerivedData outside it (`-derivedDataPath`).
4. In the app: allow Photos access → choose a source (latest 50 / 100 / 300, or one of your albums) → Start. 100 photos take a minute or two; Jev is called once per photo (about $0.00015).
5. Tap into any column to see the distribution and the state; mark 👍 "correct" or 👎 "wrong". "Export" (top right) shares the JSON, e.g. via AirDrop to a Mac. The format matches `out/*/decisions.json`; your labels are in the `feedback` field.

## Limitations

- Photos whose originals live only in iCloud ("Optimize iPhone Storage") are not downloaded by default, so EXIF and exact duplicates can't be computed; the detail page notes this, and there is a toggle on the home screen.
- Videos are judged on their poster frame only.
- The confidence gate τ is adjustable on the home screen (default 0.3).
