### Fixed

- When the Dynamic Island width or height changes, the logo and the greeting now move with the black
  island, on the same curve and at the same distance from each edge. Before, they got to their new
  place first and showed outside the island while it grew.
- Settings → Dynamic Island → Size: the built-in display preview now draws the island that display
  shows. On a built-in display with no notch, it no longer draws a notch.

### Changed

- The logo and the greeting blur while the Dynamic Island changes size. The logo rounds its corners
  a little and half closes its eyes, then settles square and sharp. With Reduce motion on, none of
  this happens.
- Below 100%, the idle Dynamic Island width now changes with each step of the width setting, from
  the smallest island at 20% to the default at 100%. Before, the lowest steps gave the same island.
  On a built-in display with no notch, the smallest idle island is now 82px, with a 16px gap between
  the logo and the greeting. It was 120px. The same percent can give a different width than before.
  Beside a physical notch, the width does not change.
