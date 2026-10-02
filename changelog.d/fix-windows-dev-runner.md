### Fixed

- On Windows, an agent that starts from a `.cmd` or `.bat` file now gets each argument as written.
  Before, the command processor split or changed an argument with a space, a quote, `&` or `%`.
