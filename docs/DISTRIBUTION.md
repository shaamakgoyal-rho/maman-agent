# Distributing Maman

How a build reaches someone else's Mac, what it costs them in clicks, and the one
thing that would remove most of that cost.

## Cutting a release

```bash
bash scripts/build-release-dmg.sh          # → dist/Maman.dmg
gh release create vX.Y.Z-preview.N dist/Maman.dmg#"Maman.dmg (universal, macOS 14+)" \
  --repo shaamakgoyal-rho/maman-releases --title "…" --notes-file notes.md
```

The download page reads `releases/latest/download/Maman.dmg`, so publishing a new
release with that asset name is all that is needed — the page needs no redeploy.

Source stays in the private repo; `maman-releases` holds **artifacts only**, and is
public so the download works without a GitHub account.

## Three build facts that are easy to get wrong

**The sidecar needs THREE filenames, not one.** `tauri build --target
universal-apple-darwin` compiles each architecture as its own sub-build, and each
one validates the sidecar named for _its_ triple before `lipo`-ing the Rust binary.
Staging only `maman-observer-universal-apple-darwin` fails with `resource path
binaries/maman-observer-x86_64-apple-darwin doesn't exist`. `build-observer.sh
UNIVERSAL=1` stages arm64, x86_64 and the fat binary.

**`swift build --arch arm64 --arch x86_64` needs full Xcode.** With Command Line
Tools only it fails on `-arch` handling, so the script cross-compiles each slice
separately (`--triple`, into `.build-x86`) and `lipo`s them. That path works with
either toolchain.

**`dmg` is deliberately NOT in `tauri.conf.json` bundle targets.** Tauri's DMG step
runs `bundle_dmg.sh`, which drives Finder over AppleScript; without Finder
automation permission it fails _after_ the `.app` succeeded, taking the whole build
down. Adding the target breaks every ordinary `pnpm tauri build`. The release script
uses `hdiutil` instead, which needs no AppleScript and works in CI.

## Signing: why self-signed, not ad-hoc

The preview is **not notarized**, so Gatekeeper rejects it either way. What differs
is the message the user gets and whether they have a way through:

| Signature                | `spctl`               | What macOS shows                       | Right-click → Open |
| ------------------------ | --------------------- | -------------------------------------- | ------------------ |
| ad-hoc (Tauri default)   | `no usable signature` | "Maman is damaged and can't be opened" | often fails        |
| self-signed "Maman Dev"  | `origin=Maman Dev`    | "developer cannot be verified"         | works              |
| Developer ID + notarized | `accepted`            | nothing                                | not needed         |

So the release script signs with the same stable dev identity used locally
(`scripts/dev-codesign.sh`). That identity conveys **no trust** — it is self-signed
— it only puts the user on the recoverable path the download page documents.

For users who still hit the "damaged" message (quarantine), the page gives
`xattr -dr com.apple.quarantine /Applications/Maman.app`.

## The one change that removes a step

An **Apple Developer ID** ($99/yr) collapses install from five steps to four and
removes every scary dialog:

```bash
codesign --deep --force --options runtime --timestamp \
  --sign "Developer ID Application: NAME (TEAMID)" Maman.app
xcrun notarytool submit dist/Maman.dmg --apple-id … --team-id … --password … --wait
xcrun stapler staple dist/Maman.dmg
```

Then delete the "unsigned developer preview" callout from the download page and
step 3 from its install list — both are written to be removed.

## What cannot be removed

- **Accessibility permission.** macOS reserves TCC grants for the user; no app can
  grant its own. The app deep-links the settings pane, which is as far as it goes.
- **The keychain prompt.** The encrypted store's key lives in the login keychain.
  A rebuild changes the app's CDHash and macOS may re-ask; the app reports
  `keychain_access_required` honestly rather than hanging.
- **Consent before observation.** Nothing is watched until the user chooses. That is
  the product's premise, not an onboarding cost to optimise away.
- **Screen Recording permission, if the user wants Teach Mode.** Same as
  Accessibility: macOS reserves the grant for the user.

## Teach Mode sends pictures of the screen to Anthropic

This is the only part of Maman where data leaves the device as PIXELS rather than as
a derived shape, so it is called out separately rather than buried in a permissions
list. It supersedes the earlier claim that raw pixels never cross the device
boundary, which was true until M33.

- Off until the user enables it, and enabling it only makes a session _possible_.
- A session is scoped to chosen apps, lasts at most 15 minutes, and stops itself.
- Before any frame leaves, an on-device pass masks anything credential-shaped and
  **withholds the whole frame** if a secure field has focus, the app is denied or
  private, the window is incognito, or more of the frame would be masked than left.
- Keystrokes are never read — in Teach Mode or anywhere. That one has no exception.
- Frames are never written to disk and never synced; they are read once and dropped.
- What the model reports can be _wrong_, unlike the rest of the observation, so
  low-confidence readings are discarded and the rest are shown to the user.

## The download page

Static HTML at `apps/site/index.html`, deployed to Vercel (project `maman`,
production). No framework, no build step, dark-mode aware.

**Vercel Authentication must stay OFF** for this project. It defaults to
`all_except_custom_domains`, which redirects every `.vercel.app` visitor to a Vercel
login — a status-code check still returns 200 because the _login page_ returns 200,
so verify page CONTENT after deploying, not the status.
