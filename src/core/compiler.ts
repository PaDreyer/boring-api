import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import ts from "typescript";

export const moduleAlias = "$modules/*";

export function modulePaths(apiDirectory: string, configDirectory?: string): Record<string, string[]> {
    const target = join(dirname(apiDirectory), "modules", "*");
    return { [moduleAlias]: [(configDirectory ? relative(configDirectory, target) : target).split(sep).join("/")] };
}

export function inside(parent: string, file: string): boolean {
    const path = relative(parent, file);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function compilerOptions(options: ts.CompilerOptions, apiDirectory: string): ts.CompilerOptions {
    const paths = Object.fromEntries(Object.entries(options.paths ?? {}).filter(([name]) => name !== "$modules" && !name.startsWith("$modules/")));
    return { ...options, paths: { ...paths, ...modulePaths(apiDirectory) } };
}

function moduleLiteral(node: ts.StringLiteralLike): boolean {
    const parent = node.parent;
    return (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node ||
        ts.isExternalModuleReference(parent) && parent.expression === node ||
        ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent) ||
        ts.isCallExpression(parent) && parent.arguments[0] === node &&
            (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                ts.isIdentifier(parent.expression) && parent.expression.text === "require" && !shadowsLoader(parent, "require") ||
                (ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "require" ||
                    ts.isElementAccessExpression(parent.expression) && ts.isStringLiteralLike(parent.expression.argumentExpression) && parent.expression.argumentExpression.text === "require") &&
                    ts.isIdentifier(parent.expression.expression) && parent.expression.expression.text === "module" && !shadowsLoader(parent, "module"));
}

/** The CLI, language service and emitter all use TypeScript's module resolver. */
export function resolveImport(specifier: string, file: string, options: ts.CompilerOptions): ts.ResolvedModuleFull | undefined {
    return ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
}

/** TypeScript prefers declarations over their executable JavaScript companions. */
function runtimeSource(file: string): string {
    const javascript = file.replace(/\.d\.([cm]?)ts$/, ".$1js");
    if (file.endsWith(".d.ts") && !ts.sys.fileExists(javascript) && ts.sys.fileExists(`${javascript}x`)) return `${javascript}x`;
    return javascript;
}

export function aliasDiagnostics(program: ts.Program, configured: ts.CompilerOptions): ts.Diagnostic[] {
    const diagnostics: ts.Diagnostic[] = [];
    for (const source of program.getSourceFiles()) {
        if (source.isDeclarationFile) continue;
        const visit = (node: ts.Node) => {
            if (ts.isStringLiteralLike(node) && node.text.startsWith("$modules/") && moduleLiteral(node)) {
                const expected = resolveImport(node.text, source.fileName, program.getCompilerOptions());
                const actual = resolveImport(node.text, source.fileName, configured);
                if (node.text.slice("$modules/".length).split(/[\\/]/).some(part => !part || part === "." || part === "..")) {
                    diagnostics.push({ category: ts.DiagnosticCategory.Error, code: 98001,
                        file: source, start: node.getStart(source), length: node.getWidth(source),
                        messageText: "BORING108: Invalid $modules import. Use a module name and file path without traversal segments." });
                } else if (expected && actual?.resolvedFileName !== expected.resolvedFileName) {
                    diagnostics.push({ category: ts.DiagnosticCategory.Error, code: 98001,
                        file: source, start: node.getStart(source), length: node.getWidth(source),
                        messageText: "BORING108: The editor configuration does not resolve $modules to the API's sibling modules directory. Extend .boring/tsconfig.json, or include its $modules/* mapping in your own compilerOptions.paths. A local paths object replaces inherited paths." });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return diagnostics;
}

export interface ImportTransformOptions {
    options: ts.CompilerOptions;
    /** Map an input file to its emitted location; omitted for ts-node. */
    outputFile?: (file: string) => string;
    /** Declaration copies also relocate relative imports from generated files. */
    relocateRelative?: boolean;
}

function bindingNames(node: ts.BindingName, names: Set<string>): void {
    if (ts.isIdentifier(node)) names.add(node.text);
    else for (const element of node.elements) if (ts.isBindingElement(element)) bindingNames(element.name, names);
}

/** Track lexical bindings so a user's function named require is never rewritten. */
function shadowsLoader(node: ts.Node, name: string): boolean {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
        if (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isFunctionLike(scope) &&
            !ts.isCatchClause(scope) && !ts.isCaseBlock(scope) && !ts.isForStatement(scope) && !ts.isForOfStatement(scope) && !ts.isForInStatement(scope)) continue;
        const names = new Set<string>();
        if (ts.isFunctionLike(scope)) {
            for (const parameter of scope.parameters) bindingNames(parameter.name, names);
            if ((ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) && scope.name) names.add(scope.name.text);
        }
        const collect = (child: ts.Node) => {
            if (ts.isVariableDeclaration(child) || ts.isParameter(child) || ts.isBindingElement(child)) bindingNames(child.name, names);
            if ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child) || ts.isImportEqualsDeclaration(child)) && child.name) names.add(child.name.text);
            if (ts.isImportClause(child) && child.name) names.add(child.name.text);
            if (ts.isImportSpecifier(child) || ts.isNamespaceImport(child)) names.add(child.name.text);
            if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
            // Block-scoped declarations in nested blocks do not shadow outer code.
            if (ts.isBlock(child) || ts.isCatchClause(child) || ts.isCaseBlock(child) || ts.isForStatement(child) || ts.isForOfStatement(child) || ts.isForInStatement(child)) {
                const collectVar = (nested: ts.Node) => {
                    if (ts.isFunctionLike(nested) || ts.isClassLike(nested)) return;
                    if (ts.isVariableDeclarationList(nested) && !(nested.flags & ts.NodeFlags.BlockScoped)) {
                        for (const declaration of nested.declarations) bindingNames(declaration.name, names);
                    }
                    ts.forEachChild(nested, collectVar);
                };
                if (ts.isSourceFile(scope!) || ts.isFunctionLike(scope!)) collectVar(child);
                return;
            }
            ts.forEachChild(child, collect);
        };
        ts.forEachChild(scope, collect);
        if (names.has(name)) return true;
    }
    return false;
}

export function importTransformer(settings: ImportTransformOptions): ts.TransformerFactory<ts.SourceFile | ts.Bundle> {
    return context => {
        const transformSource = (source: ts.SourceFile): ts.SourceFile => {
            const rewrite = (literal: ts.Expression): ts.Expression => {
                if (!ts.isStringLiteralLike(literal)) return literal;
                const alias = literal.text.startsWith("$modules/");
                if (!alias && !(settings.relocateRelative && literal.text.startsWith("."))) return literal;
                if (alias && literal.text.slice("$modules/".length).split(/[\\/]/).some(part => !part || part === "." || part === "..")) {
                    throw new Error(`${source.fileName}: BORING108: Invalid $modules import '${literal.text}'.`);
                }
                const resolved = resolveImport(literal.text, source.fileName, settings.options);
                if (!resolved) throw new Error(`${source.fileName}: BORING106: Cannot resolve '${literal.text}'.`);
                const from = settings.outputFile?.(source.fileName) ?? source.fileName;
                const runtime = runtimeSource(resolved.resolvedFileName);
                const target = settings.outputFile?.(runtime) ?? runtime;
                let path = relative(dirname(from), target).split(sep).join("/");
                if (!path.startsWith(".")) path = `./${path}`;
                return ts.setTextRange(context.factory.createStringLiteral(path), literal);
            };
            const visitor: ts.Visitor = node => {
                const original = node;
                // Traverse every child, including nested import-type arguments,
                // before rewriting the enclosing import or call.
                node = ts.visitEachChild(node, visitor, context);
                if (ts.isImportDeclaration(node)) return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause, rewrite(node.moduleSpecifier), node.assertClause);
                if (ts.isExportDeclaration(node) && node.moduleSpecifier) return context.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, rewrite(node.moduleSpecifier), node.assertClause);
                if (ts.isExternalModuleReference(node) && node.expression) return context.factory.updateExternalModuleReference(node, rewrite(node.expression));
                if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
                    return context.factory.updateImportTypeNode(node, context.factory.createLiteralTypeNode(rewrite(node.argument.literal) as ts.StringLiteral), node.assertions, node.qualifier, node.typeArguments, node.isTypeOf);
                }
                if (ts.isCallExpression(node) && node.arguments.length) {
                    const callee = node.expression;
                    const requireCall = ts.isIdentifier(callee) && callee.text === "require" && !shadowsLoader(original, "require");
                    const moduleCall = (ts.isPropertyAccessExpression(callee) && callee.name.text === "require" ||
                        ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === "require") &&
                        ts.isIdentifier(callee.expression) && callee.expression.text === "module" && !shadowsLoader(original, "module");
                    if (callee.kind === ts.SyntaxKind.ImportKeyword || requireCall || moduleCall) {
                        return context.factory.updateCallExpression(node, callee, node.typeArguments,
                            [rewrite(node.arguments[0]), ...node.arguments.slice(1)]);
                    }
                }
                return node;
            };
            return ts.visitNode(source, visitor) as ts.SourceFile;
        };
        return node => ts.isBundle(node)
            ? context.factory.updateBundle(node, node.sourceFiles.map(transformSource)) : transformSource(node);
    };
}

export function emittedPath(file: string, rootDir: string, outDir: string, options: ts.CompilerOptions): string {
    const extension = /\.[jt]sx$/.test(file) && options.jsx === ts.JsxEmit.Preserve ? "jsx"
        : /\.[cm]ts$/.test(file) ? file.slice(-3, -2) + "js" : "js";
    const path = file.replace(/(?:\.d)?\.(?:[cm]?ts|[jt]sx)$/, `.${extension}`);
    return resolve(outDir, relative(rootDir, path));
}
