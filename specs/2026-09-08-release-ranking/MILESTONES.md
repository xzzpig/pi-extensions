# Implementation log

- Inspected the website ranking script and this repository’s publishing workflow. The website ranks extensions by downloads and displays the best recorded rank.
- Initially placed refresh after publication; user clarified that it must happen before release. Updated PRODUCT and TECH before changing the workflow.
- Added a ranking preparation job before publication, with no schedule. It validates the release tag and ancestry, records ranking data, commits badges and README to main, and passes the observation to the publishing job before packing. Dry runs do not update rankings.
- Added badge assets to the npm package allowlist so README images are included.
- Added five focused tests covering pagination, malformed/unsorted/duplicate/missing catalog results, changing totals, synchronized badge rendering, retries, and validation before writes. Tests pass; read-only live catalog parsing succeeds. No live ranking files were changed and no release was triggered.
- Prepared patch version 0.31.2 and changelog. Local type check, lint, full suite, runner self-check, context gate, provider cross-check, production dependency audit, NAF benchmark gate, ranking tests, and package contents checks pass. Publishing authorized by the user.
