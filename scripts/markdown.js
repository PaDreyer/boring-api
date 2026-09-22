const { readFileSync } = require("node:fs");

function withoutFencedCode(markdown) {
    let fence;
    return markdown.split("\n").map(line => {
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (fence) {
            const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(text);
            if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length &&
                [...closing[1]].every(character => character === fence.character)) fence = undefined;
            return "";
        }
        const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
        if (!opening || opening[1][0] === "`" && opening[2].includes("`")) return line;
        fence = { character: opening[1][0], length: opening[1].length };
        return "";
    }).join("\n");
}

function inlineCode(markdown, keepContent) {
    let result = "";
    for (let index = 0; index < markdown.length;) {
        if (markdown[index] !== "`") { result += markdown[index++]; continue; }
        let length = 1;
        while (markdown[index + length] === "`") length++;
        let closing = index + length;
        while (closing < markdown.length) {
            closing = markdown.indexOf("`", closing);
            if (closing < 0) break;
            let closingLength = 1;
            while (markdown[closing + closingLength] === "`") closingLength++;
            if (closingLength === length) break;
            closing += closingLength;
        }
        if (closing < 0) { result += markdown.slice(index, index + length); index += length; continue; }
        const source = markdown.slice(index + length, closing);
        if (keepContent) {
            let content = source.replace(/\r?\n/g, " ");
            if (/^ .* $/.test(content) && /[^ ]/.test(content)) content = content.slice(1, -1);
            result += content;
        } else result += source.replace(/[^\n]/g, "");
        index = closing + length;
    }
    return result;
}

function markdownProse(markdown, keepInlineCode = false) {
    return inlineCode(withoutFencedCode(markdown), keepInlineCode);
}

function prose(file) { return markdownProse(readFileSync(file, "utf8")); }

function anchors(file) {
    const counts = new Map();
    const markdown = markdownProse(readFileSync(file, "utf8"), true);
    return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) => {
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
        const count = counts.get(slug) || 0;
        counts.set(slug, count + 1);
        return count ? `${slug}-${count}` : slug;
    });
}

module.exports = { anchors, markdownProse, prose };
