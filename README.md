# jevtophoto — Using Jev to find junk in a photo library

An experiment in what [Jev](https://typesafe.ai) (TypeSafe's structured-decision model, served via OpenRouter) is actually good for, using a concrete task: **deciding which photos in a phone's library are junk** — chat screenshots, saved memes, burst rejects, accidental shots, duplicates.

**Short answer:** once the deletion policy is written down clearly, Jev adds surprisingly little over plain rules. It is most useful as a *tool for writing the rules*, and optionally as a second opinion on the "not sure" pile. The details, and how we got there, are below.

![Per-record report for the synthetic bank](docs/report.png)

> **About the numbers.** Every result in this repo was measured with an earlier, Chinese-language version of the question text. The questions have since been translated to English (`tools/capability/items.js`) with the records, states and answer key unchanged, but the English prompts have **not** been rerun yet — `node tools/capability/run.js` measures them. The recorded results (`results*.json`, `.raw*.json`) keep the Chinese prompts that were actually sent.

## The pattern

**Code extracts structured features from each photo → Jev judges "delete or keep, and what kind of photo is it", returning a probability distribution and a confidence → a human confirms before anything is deleted.**

Jev never sees pixels. It only receives a JSON `state` built from on-device metadata and on-device ML results.

## What Jev is (and isn't) good at

These come from ~740 probe calls against Jev on questions with known answers (a separate capability study), plus the experiments in this repo.

- **Good at:** reading structured fields against written criteria, combining several weak signals, classifying free text, and reporting a confidence that is genuinely informative (on the probe set: 99.6% accurate when confidence ≥ 0.9; mean confidence 0.50 on the answers it got wrong).
- **Bad at:** arithmetic, counting, sums, date differences, similarity. **Compute all of these in code and pass the result in.**
- **Watch out:** an instruction written *inside a field value* gets obeyed (3/3 in probes). So never pass OCR text verbatim into the state — only derived features such as character count or "contains an amount".
- A similarly named field will stand in for a missing one (e.g. `box_color` is read as the product's `color`). Pass `null` for missing values and avoid ambiguous names.
- **API:** `POST https://openrouter.ai/api/alpha/decisions`, model `~typesafe/jev-latest` (resolved to `typesafe/jev-1.13-20260917` during these tests), body `{ model, state, questions }`. Each question returns `probabilities` + `confidence`. About $0.00015 per call, ~230 ms median latency; multiple questions in one request don't interfere with each other.

## Feature schema (the `state` Jev receives)

The synthetic question bank and the real-photo extractor share one schema (`SHAPE` in `tools/capability/items.js`). Field names, enum values and ranges are copied from Apple's APIs and were checked against the macOS 27 SDK headers.

| Block | Fields | Source |
|---|---|---|
| `asset` | `mediaType`, `mediaSubtypes` (`photoScreenshot` / `photoLive` / `photoPanorama` / `photoDepthEffect` / `photoAnimation` = GIF / `photoHDR` / `videoTimelapse` / `videoScreenRecording` …), `playbackStyle`, `pixelWidth`, `pixelHeight`, `duration`, `hasLocation` (= `location != nil`; coordinates are never sent), `isFavorite`, `isHidden`, `hasAdjustments` + `adjustmentsState` (`none` / `userAdjusted` / `cameraAutoAdjusted`, 15+), `sourceType` (`typeUserLibrary` / `typeCloudShared` / `typeiTunesSynced`), `burstIdentifier`, `representsBurst`, `burstSelectionTypes` (`autoPick` / `userPick`) | `PHAsset` |
| `resource` | `contentType` (UTI), `dataSize` (27+; previously KVC `fileSize`) | `PHAssetResource` |
| `imageProperties` | `TIFF.Make`, `TIFF.Model`, `Exif.LensModel`, `Exif.ISOSpeedRatings`, `Exif.ExposureTime`, `Exif.FNumber`. `Model == null` ≈ not taken by a camera | ImageIO `CGImageSourceCopyPropertiesAtIndex` |
| `vision` | `faceCount`, `recognizedTextCharCount`, `barcodeCount`, `aesthetics.overallScore` (−1…1), `aesthetics.isUtility` (15+ / iOS 18+). Videos use the poster frame | Vision `VNDetectFaceRectanglesRequest` / `VNRecognizeTextRequest` / `VNDetectBarcodesRequest` / `VNCalculateImageAestheticsScoresRequest` |
| `derived` | `daysSinceCreation`, `daysSinceAdded`, `sharpness` (Laplacian variance, normalized 0–1), `meanLuminance` (0–1), `ocrHasAmount`, `ocrDocType` (rough keyword classification; the text itself is not sent), `exactDuplicateCount` (file hash), `nearDuplicateCount` (`VNGenerateImageFeaturePrintRequest` distance), `isSharpestInBurst` | Code |

Notes:

- `creationDate` and `addedDate` (26+) are read and shown in the review page, but **not** sent to Jev — only the day counts computed in `derived` are. An ablation on an earlier version of the bank showed that including the raw date strings made no difference, so this is about saving tokens and sticking to "compute differences in code", not accuracy.
- PhotoKit does **not** expose last-viewed time or which app a saved image came from. "Not taken by a camera" has to be inferred from `Model == null`, `mediaSubtypes`, `contentType`, and `addedDate − creationDate`.
- The default fetch excludes hidden assets and does not expand bursts (`includeHiddenAssets` / `includeAllBurstAssets`); shared-album photos have `sourceType == typeCloudShared`. All three are skipped by the product.
- `extendedMetadata.caption / originalFilename / keywords` (27+) are free text and are **not sent** (the question bank contains one injection probe for this).
- Android is out of scope for now; the PhotoKit path comes first.

## Questions asked of Jev

The first draft asked three questions:

```
junk_likelihood  score  ['clearly delete', 'probably delete', 'not sure', 'keep']
kind             choice { chat_screenshot, receipt, saved_meme, burst_reject, accidental,
                          exact_duplicate, document_to_keep, normal_photo, unsure }
keep_reason      choice { has_people, favorited, edited, only_copy, none }
```

After phase A, `keep_reason` was dropped and `kind` was reduced to four classes (98% correct); the cases it was meant to cover are now hard rules (see below).

Instructions describe **criteria only** (e.g. "a screenshot with no faces that is over 90 days old leans toward delete; screenshots containing boarding-pass / ID / receipt text lean toward keep"). **Don't put category answers into the instructions** — in earlier work that inflated the measured signal by a third to a half. Let the criteria text define the levels, and read the modal level rather than the expected score.

## Phase A — synthetic feature bank (done 2026-09-21)

Hand-written feature records with known correct answers: chat screenshots, receipts, saved memes, burst rejects, accidental black frames, exact duplicates, screenshots with faces (keep), boarding-pass screenshots (keep), document photos, normal photos, and many borderline cases. The questions: is it accurate, can confidence pick out the ambiguous cases, and is it stable across reruns?

The bank, runner, hard rules, baseline, ablations and report are in `tools/capability/`; results are in [RESULTS.md](RESULTS.md) (generated by `report.js`).

- **78 records (33 borderline) × 2 questions × 3 runs.**
- `rules.js` handles hard cases before Jev: favorited, user-edited, `userPick`, exact duplicates, non-sharpest burst frames, hidden, shared-album, and screenshots under 14 days old.
- **End to end (rules + Jev, confidence gate 0.3): 0 harmful deletions, 1 missed, 21/78 handed to a human.** `isUtility` + three simple rules: 18 wrong, 3 harmful.
- Ablations (measured on the earlier three-question version of the bank): including PhotoKit's raw date strings makes no difference; category words inside the scale's criteria drop accuracy on clear cases by 14 points. `ablate.js` reruns them against the current bank.
- Earlier versions (a hand-written schema, then a three-question version) are in the git history.

```bash
node tools/capability/items.js      # bank statistics
node tools/capability/run.js        # all items × 3 runs → results.json (REPS= / ONLY=chat,receipt / EDGE=1 / PROFILE=aggressive)
node tools/capability/rules.js      # which items the hard rules take over
node tools/capability/baseline.js   # rules-only baseline against the answer key
node tools/capability/ablate.js     # two ablations (rawdates / anchors) → results-ablation-*.json, picked up by report.js
node tools/capability/report.js     # regenerate RESULTS.md + report.html
node tools/capability/serve.js      # http://localhost:8790 interactive playground: edit a state, rerun
node tools/extract/local-baseline.js --bank   # the policy as plain threshold rules, scored against the answer key
```

`items.js`, `rules.js`, `baseline.js`, `report.js` and `local-baseline.js` run offline — no API key needed.

## Phase B — real images on a Mac (done 2026-09-21, folder mode)

`tools/extract/extract.swift` is a single file using ImageIO + Vision + AVFoundation. It writes `features.json` in the `SHAPE` format plus 256 px thumbnails. `tools/extract/ask.js` applies `rules.js` first; a dry run writes the exact JSON that *would* be sent to `to-send.json` for a human to inspect, and only `--send` actually calls Jev. It then produces `review.html` with three columns: **suggest delete / not sure / keep. Nothing is ever deleted.**

Smoke test on a Downloads folder: 26 files in 21 s; 3 near-duplicates taken over by rules. Vision `overallScore` on real images: normal photos 0.5–0.86, screenshots 0.0, a black video −0.14 (the bank's value of 0.2 for normal photos was too low and should be re-labelled). Mac screenshots carry no EXIF `UserComment`, so folder mode can't recognise them; PhotoKit mode uses the `photoScreenshot` subtype.

One run through Jev (24 images × 2 questions × 1 run): 19 suggest delete, 4 not sure, 3 keep. A Downloads folder is mostly non-camera images, so the direction was right, but confidence was mostly 0.35–0.6. Two lessons carried forward:

1. **Videos are judged on one frame.** A 71-second iPhone video (`IMG_7349.MOV`) was rated "clearly delete" because Vision marked its poster frame as utility. Either sample more frames or be conservative about camera videos in code.
2. **Conflicting signals produce honest uncertainty.** An image with no EXIF but an aesthetic score of 0.86 (a stock photo) got confidence 0.00 and landed in "not sure" — the model declined to decide, and the gate worked as intended.

```bash
swiftc -O -o tools/extract/extract tools/extract/extract.swift   # build once
tools/extract/extract --folder ~/Downloads --out out/downloads   # extract features (no Photos permission needed)
node tools/extract/ask.js out/downloads                           # dry run: rules + to-send.json + review.html without Jev
node tools/extract/ask.js out/downloads --send                    # real run (1 call per image, 2 questions)
node tools/extract/serve-out.js                                   # http://localhost:8791/downloads/review.html
node tools/extract/local-baseline.js out/downloads/decisions.json # where local rules and Jev disagree on real photos
```

Good sources of test photos: a dedicated album in Photos (drag in 100–300 images, deliberately mixing junk and keepers so you know the answers), or an AirDropped batch from an iPhone (HEIC/PNG keep their EXIF). For Android, copy `DCIM/`, `Pictures/Screenshots/` and `WhatsApp Images/`; during feasibility testing the features can still be extracted on a Mac with Vision.

## Phase C — on the phone (from 2026-09-21)

`ios/JevPhoto/` is a minimal SwiftUI app: PhotoKit reads the library, Vision extracts features on the device, the phone calls Jev directly, and results are shown in three columns. 👍 / 👎 labels can be exported as JSON for analysis on a Mac. Setup: [ios/README.md](ios/README.md).

Tested on an iPhone 15 Pro Max (iOS 27): the most recent 100 photos (all within 31 days) took about half a minute.

- **Conservative profile:** 46 keep / 28 not sure / 26 delete — too timid. The cause was not the confidence gate but the "over 90 days" condition in the junk criteria.
- **Aggressive profile** (`PROFILES.aggressive` in `items.js`, the app default): 39 keep / 11 not sure / 50 delete; mean confidence 0.49 → 0.63. On the bank: 0 harmful, 0 missed. Details in RESULTS.md §7.

Regenerate `Model/Questions.swift` with `node tools/capability/export-questions.js` after changing the bank, then rebuild the app. Results and labels are written to the app's `Documents/last-run.json`; pull them with `xcrun devicectl device copy from … --domain-type appDataContainer --domain-identifier <your bundle id>`. On the simulator only build / install / launch / the Photos permission prompt were verified; the device run was the first full end-to-end run.

## The question that matters: what does Jev add over rules?

Build a rules-only baseline (screenshot > 90 days and no faces → delete; non-sharpest burst frame → delete; exact duplicate → delete) and compare it with Jev on the same cases. Expect them to agree on clear cases — any value shows up only on the borderline ones, so the bank deliberately contains many.

**Answer (2026-09-22): once the policy is written clearly, very little.**

- On the bank, `isUtility` + three rules: 18 wrong, 3 harmful. Rules + Jev: 4 wrong, 0 harmful. But all 3 harmful cases were favorited photos, and a single hard rule removes them.
- The aggressive policy transcribed as threshold rules (`tools/extract/local-baseline.js`): on the bank 0 harmful, 0 missed, 6 wrong (Jev: 5). On the phone's 100 photos, 94 landed in the same column; the other 6 were all faceless camera photos with middling sharpness and aesthetics — Jev said "not sure", the rules picked a side.
- In this design Jev sees exactly what the rules see (no pixels, no OCR text). What it adds is a distribution and confidence in the grey zone, and the ability to change policy by editing a paragraph instead of a row of thresholds.
- Giving Jev a signal the rules lacked — Vision scene labels (`VNClassifyImageRequest` top 5: document / screenshot / people / printed_page …) — changed Jev's column for only 3 of 100 photos; it agreed with the local rules on 92/100, and all 8 disagreements were again faceless, middling camera photos.
- Cost for 100 photos: 83 Jev calls, $0.012, 556 KB sent, ~5 s wall clock at 4-way concurrency.

**Conclusion: at runtime you can do without Jev.** The local rule set was itself distilled from Jev's behaviour; Jev is worth more as a tool for *writing* the rules than as the decision layer. If you keep it, keep it for the "not sure" column as a second opinion (the app's "disagreement" view does exactly that).

## Ground rules

- Deletion is always confirmed by a human; the model only produces a "suggest delete" list.
- Pixels never leave the device. Location and OCR text are not sent by default. The user can see the exact JSON that is sent.
- Anything below the confidence gate goes to "not sure", never to an automatic suggestion.

## Setup

- Node 20+ (no dependencies) for `tools/`; Xcode + [XcodeGen](https://github.com/yonaskolb/XcodeGen) for `ios/`.
- Copy `.env.example` to `.env` and put your own OpenRouter key in it (or export `OPENROUTER_API_KEY`). The key is read only when a script actually calls Jev. `.env`, `ios/…/Secrets.plist`, `out/` (your photos' thumbnails and features) and the built extractor are all git-ignored.
- `ios/JevPhoto/project.yml` reads the signing team from `DEVELOPMENT_TEAM` in the environment; replace the placeholder bundle ID `com.example.jevphoto` with your own before building.

## Repository layout

```
tools/capability/   synthetic feature bank, runner, rules, baseline, ablations, report, playground
tools/extract/      Mac feature extractor (Swift), Jev caller, local-rules baseline, review server
ios/JevPhoto/       SwiftUI app for running the pipeline on an iPhone
RESULTS.md          phase A results (generated by tools/capability/report.js)
docs/               README screenshot
```

Everything is in English except two deliberate cases: the recorded results files, which keep the Chinese question text that was actually sent, and the OCR keyword lists in the extractors, which include Chinese terms so that Chinese-language receipts, IDs and tickets are recognised.

## License

[MIT](LICENSE)
