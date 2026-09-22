const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { anchors, markdownProse, prose } = require("./markdown");

test("ignores links in backtick and tilde fenced code of any supported length", () => {
    const markdown = [
        "```ts", "[triple](missing-triple)", "```",
        "````ts", "[long](missing-long)", "`````",
        "~~~ts", "[tilde](missing-tilde)", "~~~~",
        "[real](docs/real.md)",
    ].join("\n");
    const links = [...markdownProse(markdown).matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].map(match => match[1]);
    assert.deepEqual(links, ["docs/real.md"]);
});

test("ignores links in code spans but retains their text for heading anchors", () => {
    const root = mkdtempSync(join(tmpdir(), "boring-markdown-"));
    const file = join(root, "document.md");
    try {
        writeFileSync(file, "## API `foo()` and `` `[not](missing)` `` contract\n\n`[hidden](missing)`\n[real](ok.md)\n");
        assert.deepEqual([...prose(file).matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].map(match => match[1]), ["ok.md"]);
        assert.deepEqual(anchors(file), ["api-foo-and-notmissing-contract"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
