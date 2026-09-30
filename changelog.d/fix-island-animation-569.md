### Fixed

- When the Dynamic Island width or height changes, the logo and the greeting now move with the black
  island, on the same curve and at the same distance from each edge. Before, they got to their new
  place first and showed outside the island while it grew.
- Settings → Dynamic Island → Size: the built-in display preview now draws the island that display
  shows. On a built-in display with no notch, it no longer draws a notch.

### Changed

- The logo and the greeting blur while the Dynamic Island changes size. The logo rounds into a ball,
  turns once (clockwise as the island grows, back as it shrinks), shrinks a little and half closes
  its eyes, then settles square and sharp. With Reduce motion on, none of this happens.
- The Dynamic Island width setting now goes down to 15%. On a built-in display with no notch, the
  smallest idle island is 82px: the logo and the greeting have a 16px gap between them. It was
  120px. Beside a physical notch, the smallest width does not change.
