# Third-party notices

## lavish-axi (MIT) — design lineage and vendored logic

planboard was designed after studying [lavish-axi](https://github.com/kunchenguid/lavish-axi)
by Kun Chen (MIT License), the agent-operated HTML review loop. The following ideas are
borrowed from it wholesale and re-implemented here in a plan-centric form:

- the long poll that returns the user's own words to the agent, consumed on delivery and
  restored when the client disappears;
- queue-then-send notes so a reviewer can walk a whole artifact before waking the agent;
- agent presence derived from poll state (waiting / listening / working);
- anchoring notes to Mermaid nodes by node identity rather than by SVG structure
  (`diagramNodeId` / `diagramNodeLabel` in `client/main.js` follow `src/mermaid-node.js`);
- confining served assets to the artifact's directory by lexical *and* real-path checks;
- a Host allowlist plus an Origin guard on mutating routes as the DNS-rebinding defence;
- an installable skill that stays a stub and points at the CLI for current guidance.

lavish-axi's MIT notice (from the installed package):

```text
MIT License

Copyright (c) 2026 Kun Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Whiteboard frame (vendored build from lavish-axi)

`npm run build` copies lavish-axi's prebuilt whiteboard frame (`dist/whiteboard/` of the
`lavish-axi` npm package, MIT) into planboard's `dist/whiteboard/`; the board embeds it as the
Excalidraw editor behind the **✎ Whiteboard** button and speaks its `lavish-whiteboard:*`
postMessage protocol (`client/whiteboard.js`). That bundle contains, under their own licenses:

| Package | License | Copyright |
| --- | --- | --- |
| `@excalidraw/excalidraw` | MIT | Copyright (c) 2020 Excalidraw |
| `@excalidraw/mermaid-to-excalidraw` | MIT | Copyright (c) 2023 Excalidraw |
| `mermaid` (pinned copy inside the converter) | MIT | Copyright (c) 2014 - 2022 Knut Sveidqvist |
| `react`, `react-dom` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| Fonts: Excalifont, Virgil, Comic Shanns | MIT | see the bundled upstream notices |
| Fonts: Cascadia Code, Liberation Sans, Lilita One, Nunito, Assistant | SIL Open Font License 1.1 | see the bundled upstream notices |

The build preserves upstream notices alongside the frame as `dist/whiteboard/LICENSE.lavish-axi`
and `dist/whiteboard/THIRD-PARTY-NOTICES.lavish-axi.md`, in addition to bundled license comments
and font assets. These files are included in the npm package even when dev dependencies are omitted.

The edit summary the frame produces (added / removed / moved / relabeled elements) is
lavish-axi's `summarizeSceneEdits`; planboard stores it as the text of a "sketch" note.

## Runtime dependencies

- [markdown-it](https://github.com/markdown-it/markdown-it) — MIT
- [express](https://expressjs.com) — MIT
- [ws](https://github.com/websockets/ws) — MIT
- [chokidar](https://github.com/paulmillr/chokidar) — MIT
- [open](https://github.com/sindresorhus/open) — MIT
- [mermaid](https://mermaid.js.org) — MIT (bundled into `dist/client/app.js` by esbuild)
