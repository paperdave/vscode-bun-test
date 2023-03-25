# vscode + "bun test" integration

This integrates tests with `bun test` with the vscode built in unit testing tools.

It uses `acorn` to parse files, and then a [sneaky trick](src/runner.test.js) to run tests with a filter.
