import { basename, dirname, resolve } from "path";
import ts from "typescript";

export function moduleExports(checker: ts.TypeChecker, source: ts.SourceFile): ts.Symbol[] {
    // TS 4.9 binds CommonJS exports to SourceFile.symbol but does not return that
    // symbol from getSymbolAtLocation(source). Use the binder's module symbol so
    // JS consumers and unused CommonJS facades have the same catalog as TS files.
    const symbol = checker.getSymbolAtLocation(source) ?? (source as ts.SourceFile & { symbol?: ts.Symbol }).symbol;
    if (!symbol) return [];
    const exports = symbol.exports?.has(ts.InternalSymbolName.ExportEquals)
        ? checker.getTypeOfSymbolAtLocation(symbol, source).getProperties()
        : checker.getExportsOfModule(symbol);
    return exports.sort((a, b) => a.name.localeCompare(b.name));
}

export function originalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Retain erased imports/exports along the alias chain before resolving its value. */
export function isTypeOnlyExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
    const seen = new Set<ts.Symbol>();
    while (symbol.flags & ts.SymbolFlags.Alias) {
        if (symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return true;
        if (seen.has(symbol)) break;
        seen.add(symbol);
        const target = checker.getImmediateAliasedSymbol(symbol);
        if (!target) break;
        symbol = target;
    }
    return !(originalSymbol(checker, symbol).flags & ts.SymbolFlags.Value);
}

export function declarationOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Declaration | undefined {
    const original = originalSymbol(checker, symbol);
    return original.declarations?.find(declaration =>
        (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) ??
        original.valueDeclaration ?? original.declarations?.[0];
}

export function exported(checker: ts.TypeChecker, source: ts.SourceFile, name: string): ts.Symbol | undefined {
    return moduleExports(checker, source).find(symbol => symbol.name === name);
}

export function symbolType(checker: ts.TypeChecker, symbol: ts.Symbol, fallback: ts.Node): ts.Type {
    const original = originalSymbol(checker, symbol);
    return checker.getTypeOfSymbolAtLocation(original, declarationOf(checker, original) ?? fallback);
}

function property(name: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function isServiceObject(type: ts.Type): boolean {
    return type.isUnionOrIntersection() ? type.types.every(isServiceObject) : !!(type.flags & ts.TypeFlags.Object);
}

function isPublicMember(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
    return checker.getRootSymbols(symbol).every(root => !root.declarations?.some(declaration => {
        const name = (declaration as ts.NamedDeclaration).name;
        return !!(ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) ||
            !!name && ts.isPrivateIdentifier(name);
    }));
}

export interface ServiceOperation {
    name: string;
    access: string;
    symbol: ts.Symbol;
    type: ts.Type;
    declaration?: ts.Declaration;
}

export interface ServiceSource {
    name: string;
    access: string;
    operations: ServiceOperation[];
}

/** Derive the same callable services for diagnostics and the inspect catalog. */
export function serviceSources(program: ts.Program, apiDirectory: string): ServiceSource[] {
    const checker = program.getTypeChecker();
    const setup = program.getSourceFiles().find(source => resolve(dirname(source.fileName)) === resolve(apiDirectory) &&
        /^\+setup\.[jt]s$/.test(basename(source.fileName)));
    if (!setup) return [];
    const setupExport = exported(checker, setup, "setup");
    const signature = setupExport && symbolType(checker, setupExport, setup).getCallSignatures()[0];
    if (!signature) return [];
    let type = signature.getReturnType();
    if (["Promise", "PromiseLike"].includes(type.getSymbol()?.name ?? "")) {
        type = checker.getTypeArguments(type as ts.TypeReference)[0] ?? type;
    }
    return type.getProperties().flatMap(service => {
        const value = symbolType(checker, service, setup);
        if (!isServiceObject(value) || !isPublicMember(checker, service)) return [];
        const access = `ctx.services${property(service.name)}`;
        const direct = value.getCallSignatures().length > 0;
        const operations = (direct ? [service] : value.getProperties()).flatMap(operation => {
            if (!isPublicMember(checker, operation)) return [];
            const operationType = symbolType(checker, operation, setup);
            if (!operationType.getCallSignatures().length) return [];
            return [{ name: operation.name, access: direct ? access : `${access}${property(operation.name)}`,
                symbol: operation, type: operationType, declaration: declarationOf(checker, operation) }];
        }).sort((a, b) => a.name.localeCompare(b.name));
        return operations.length ? [{ name: service.name, access, operations }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
}
