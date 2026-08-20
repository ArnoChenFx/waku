Builds clean. Here's what changed in `Sources/Screenflare/UI/Editor/EditorTitlebar.swift:199`:

**Before** — the copy button was invisible-until-hover: no resting fill at all (`white @ 0.0`) and a `.secondaryLabelColor` glyph, which in this app's forced dark mode is white at ~55% against a near-black background.

**After** — it's a proper neutral chip:

| State | Fill | Icon |
|---|---|---|
| Rest | white @ 0.12 | `.labelColor` (~85%) |
| Hover | white @ 0.20 | pure white |
| Pressed | white @ 0.26 | pure white |
| Copied | green @ 0.12 | `.systemGreen` |

It now reads as a real button sitting beside Export, but stays neutral-toned so Export keeps sole ownership of the accent color and remains the primary call-to-action. Size stays at 28×28 with a 12.5pt glyph — brightness was the problem, not scale. The confirmation flash also picks up a matching green wash instead of just a green glyph on a bare background.

Undo/redo still use `.secondaryLabelColor` with no fill. That's deliberate — they're intermittently disabled and shouldn't crowd the copy/Export pair — but say the word if you want them brought up to match.
