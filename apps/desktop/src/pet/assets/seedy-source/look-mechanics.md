# Pixel Seedy look mechanics

Pixel Seedy is a tiny rigid sprout bot with a flat inset face panel. For the complete 16-direction look loop, the cream pod-screen head, body, chest emblem, hands, and feet stay fully front-facing, planted, and pixel-identical. Do not turn the screen into a side profile and do not change bezel thickness. This simplified construction is intentional: direction is carried by the two tiny dark square eye pixels moving together on the fixed face panel, plus the brown sprout stem and attached leaves bending toward the same target.

The pink cheek pixels, upper-left cream highlight, larger-left/smaller-right leaf identity, head dimensions, body dimensions, feet, baseline, outline and palette remain fixed. Every 22.5-degree step uses an even one- or two-pixel eye shift and a gradual sprout bend. The face panel never yaws, rotates, scales, skews, or becomes three-quarter/profile view.

Cardinal pose families in viewer/screen coordinates:

- `000 up`: both square eye pixels sit high on the face panel; stem straightens upward and leaves lift.
- `090 screen-right`: both square eye pixels sit on the screen-right half of the panel; stem and leaves bend toward the image's right edge.
- `180 down`: both square eye pixels sit low on the face panel; stem bows forward/down and leaves settle.
- `270 screen-left`: both square eye pixels sit on the screen-left half of the panel; stem and leaves bend toward the image's left edge.

Diagonals interpolate the eye-pixel position and sprout aim evenly while the full sprite stays front-facing. `157.5 -> 180` and `337.5 -> 000` are each exactly one step. No side profiles, changing bezel thickness, whole-body rotation, scale popping, leaf swaps, replacement round eyes, antialiasing, smoothing, text, labels, arrows, shadows, scenery, or detached effects.
