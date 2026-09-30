# Third-party notices

Shiplet Core is licensed under Apache-2.0. The following notices cover
third-party material that is bundled into committed generated browser assets or
used to generate committed raster assets. Exact dependency versions and the
complete install graph are recorded in `package-lock.json`.

## Browser bundles

`src/generated-platform-client.ts` contains minified browser bundles generated
from these MIT-licensed packages:

- `react` 19.2.7, `react-dom` 19.2.7, and `scheduler` 0.27.0 — Copyright (c) Meta
  Platforms, Inc. and affiliates.
- @tanstack/query-core 5.101.0 and @tanstack/react-query 5.101.0 — Copyright
  (c) 2021-present Tanner Linsley.
- @tanstack/table-core 8.21.3 and @tanstack/react-table 8.21.3 — Copyright (c)
  2016 Tanner Linsley.
- `zustand` 5.0.14 — Copyright (c) 2019 Paul Henschel.

`src/generated-plugin-app.ts` contains the ChatGPT MCP App, a minified browser
bundle generated from `react`, `react-dom`, and `scheduler` (listed above) and
these packages:

- @modelcontextprotocol/ext-apps 1.7.5 — Copyright (c) 2024-2025 Model Context
  Protocol a Series of LF Projects, LLC. Licensed under the MIT License, with new
  contributions under the Apache License, Version 2.0.
- @modelcontextprotocol/sdk 1.30.0 — Copyright (c) 2024 Anthropic, PBC. MIT
  License.
- @openai/mcp-extensions 0.1.0 — Copyright OpenAI. Licensed under the Apache
  License, Version 2.0 ([license text](https://www.apache.org/licenses/LICENSE-2.0)).
  The bundle includes its `styles.css` stylesheet.
- `zod` 4.4.3 — Copyright (c) 2025 Colin McDonnell. MIT License.

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Raster-asset build inputs

The brand-asset generator downloads font files to an ignored build cache; font
files are not committed or distributed by this repository. The committed raster
images are generated with:

- Bricolage Grotesque — Copyright 2022 The Bricolage Grotesque Project Authors;
  licensed under the SIL Open Font License, Version 1.1.
- IBM Plex Mono — Copyright 2017 IBM Corp., with Reserved Font Name "Plex";
  licensed under the SIL Open Font License, Version 1.1.

The upstream license texts are available from the
[Bricolage Grotesque project](https://github.com/ateliertriay/bricolage/blob/main/OFL.txt)
and the [IBM Plex project](https://github.com/IBM/plex/blob/master/LICENSE.txt).

The raster generator uses `@resvg/resvg-js` 2.6.2 under MPL-2.0. That build
dependency and its platform packages are installed from npm with their license
files; their source is not copied into this repository's generated assets.

## Wizard interaction library

`scripts/self-host-setup.sh` includes an adapted copy of the interaction
library from [mattpocock/skills](https://github.com/mattpocock/skills),
Copyright (c) 2026 Matt Pocock, distributed under the MIT License reproduced
above.

## Other dependencies

The source depends on additional packages under MIT, Apache-2.0, ISC, BSD,
MPL-2.0, LGPL-3.0-or-later, CC-BY-4.0, CC0-1.0, Python-2.0, 0BSD, and Unlicense
terms. They are installed from npm and are not vendored into this repository.
`package-lock.json` records the exact package, version, and declared license for
every install-graph entry; installed packages retain their own license files.
