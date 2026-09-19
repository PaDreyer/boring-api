import { basename, dirname, resolve } from "path";
import ts from "typescript";
import { declarationOf, exported, symbolType } from "@boringapi/compiler";

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
