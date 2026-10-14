### Added

- Continue open agent work in fresh background sessions while preserving its chat, constraints and completed work. Later session changes require new progress and stop at a bounded local limit. Stops and newer messages take priority, and uncertain starts remain held after restart.

### Fixed

- Keep delegated results and routine settlement attached to their original request across background session changes. Finished continuations no longer block new messages after restart.
