const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

function packages() {
    const root = join(__dirname, "../packages");
    const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
        const directory = join(root, entry.name);
        return { directory, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) };
    }).filter(entry => !entry.manifest.private);
    const byName = new Map(entries.map(entry => [entry.manifest.name, entry]));
    const visiting = new Set();
    const ordered = new Map();
    function visit(entry) {
        const { name, dependencies, devDependencies, peerDependencies, optionalDependencies } = entry.manifest;
        if (ordered.has(name)) return;
        if (visiting.has(name)) throw new Error(`Cyclic workspace dependency involving ${name}`);
        visiting.add(name);
        for (const dependency of Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies, ...optionalDependencies }).sort()) {
            if (byName.has(dependency)) visit(byName.get(dependency));
        }
        visiting.delete(name);
        ordered.set(name, entry);
    }
    for (const entry of entries) visit(entry);
    return [...ordered.values()];
}

module.exports = { packages };
