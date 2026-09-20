import { isAbsolute, relative, sep } from "path";
import ts from "typescript";
import { applicationRole, findErrorTemplate, SourceScope } from "@boringapi/core/conventions";
import { AnalyzedProject } from "./project";
import { serviceSources } from "./services";
import { declarationOf, exported, isTypeOnlyExport, moduleExports, originalSymbol, symbolType } from "@boringapi/compiler";

export interface SourceLocation { file: string; line: number; column: number; }
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ExportValue = { kind: "literal"; value: JsonValue; source: SourceLocation } |
    { kind: "undefined"; source: SourceLocation } |
    { kind: "expression"; expression: string; type: string; source: SourceLocation };

const UNKNOWN = Symbol("not a static literal");

function initializer(node: ts.Node | undefined): ts.Expression | undefined {
    if (!node) return undefined;
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isParameter(node)) return node.initializer;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return node.right;
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isBinaryExpression(node.parent)) {
        return initializer(node.parent);
    }
    return undefined;
}

/** Only literal syntax and const references; never call functions or evaluate JS. */
function literal(checker: ts.TypeChecker, expression: ts.Expression, seen = new Set<ts.Symbol>()): JsonValue | undefined | typeof UNKNOWN {
    if (seen.size > 32) return UNKNOWN;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
        ts.isSatisfiesExpression(expression)) return literal(checker, expression.expression, seen);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isNumericLiteral(expression)) return Number.isFinite(Number(expression.text)) ? Number(expression.text) : UNKNOWN;
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand)) {
        if (!Number.isFinite(Number(expression.operand.text))) return UNKNOWN;
        if (expression.operator === ts.SyntaxKind.MinusToken) return -Number(expression.operand.text);
        if (expression.operator === ts.SyntaxKind.PlusToken) return Number(expression.operand.text);
    }
    if (ts.isArrayLiteralExpression(expression)) {
        const values = expression.elements.map(element => literal(checker, element, seen));
        return values.some(value => value === UNKNOWN || value === undefined) ? UNKNOWN : values as JsonValue[];
    }
    if (ts.isObjectLiteralExpression(expression)) {
        const entries: [string, JsonValue][] = [];
        for (const property of expression.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return UNKNOWN;
            if (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name) && !ts.isNumericLiteral(property.name)) return UNKNOWN;
            let value: JsonValue | undefined | typeof UNKNOWN;
            if (ts.isShorthandPropertyAssignment(property)) {
                const found = checker.getShorthandAssignmentValueSymbol(property);
                const symbol = found && originalSymbol(checker, found);
                const declaration = symbol && declarationOf(checker, symbol);
                const valueExpression = initializer(declaration);
                value = symbol && !seen.has(symbol) && declaration && ts.isVariableDeclaration(declaration) &&
                    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) && valueExpression
                    ? literal(checker, valueExpression, new Set([...seen, symbol])) : UNKNOWN;
            } else value = literal(checker, property.initializer, seen);
            if (value === UNKNOWN || value === undefined) return UNKNOWN;
            entries.push([property.name.text, value]);
        }
        return Object.fromEntries(entries);
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
        const found = checker.getSymbolAtLocation(expression);
        const symbol = found && originalSymbol(checker, found);
        const declaration = symbol && declarationOf(checker, symbol);
        if (ts.isIdentifier(expression) && expression.text === "undefined" && (!declaration || declaration.getSourceFile().isDeclarationFile)) return undefined;
        if (!symbol || !declaration || seen.has(symbol)) return UNKNOWN;
        if (ts.isVariableDeclaration(declaration) && !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return UNKNOWN;
        const value = initializer(declaration);
        return value ? literal(checker, value, new Set([...seen, symbol])) : UNKNOWN;
    }
    return UNKNOWN;
}

/** Build the versioned catalog from the same validated project used by check. */
export function inspectProject(project: AnalyzedProject) {
    if (project.diagnostics.length || project.architecture.length) throw new Error("Cannot inspect a project with check errors.");
    const checker = project.program.getTypeChecker();
    const printer = ts.createPrinter({ removeComments: true });
    const path = (file: string) => relative(project.projectRoot, file).split(sep).join("/") || ".";
    const location = (node: ts.Node): SourceLocation => {
        const source = node.getSourceFile();
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        return { file: path(source.fileName), line: position.line + 1, column: position.character + 1 };
    };
    const sourceFile = (file: string) => {
        const source = project.program.getSourceFile(file);
        if (!source) throw new Error(`Cannot inspect source file: ${file}`);
        return source;
    };
    const relativeImports = (text: string): string =>
        text.replace(/import\("([^"]+)"\)/g, (match, file: string) => isAbsolute(file) ? `import(${JSON.stringify(`./${path(file)}`)})` : match);
    const formatType = (type: ts.Type, node: ts.Node, expand = false): string =>
        relativeImports(checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | (expand ? ts.TypeFormatFlags.InTypeAlias : 0)));
    function schema(symbol: ts.Symbol, fallback: ts.Node) {
        const type = symbolType(checker, symbol, fallback);
        const input = type.getProperty("_input");
        const output = type.getProperty("_output");
        if (!input || !output) return null;
        const node = declarationOf(checker, symbol) ?? fallback;
        return { source: location(node), inputType: formatType(checker.getTypeOfSymbolAtLocation(input, node), node, true),
            outputType: formatType(checker.getTypeOfSymbolAtLocation(output, node), node, true) };
    }
    function signatures(type: ts.Type, node: ts.Node) {
        return type.getCallSignatures().map(signature => ({
            typeParameters: signature.typeParameters?.map(parameter => {
                // Build from the instantiated type, preserving constraints on sibling
                // type parameters instead of copying the factory's original AST.
                const declaration = checker.typeParameterToDeclaration(parameter, node, ts.NodeBuilderFlags.NoTruncation);
                return declaration ? relativeImports(printer.printNode(ts.EmitHint.Unspecified, declaration, node.getSourceFile())) : formatType(parameter, node);
            }) ?? [],
            parameters: signature.getParameters().map(parameter => {
                const declaration = parameter.valueDeclaration;
                const parameterNode = declaration && ts.isParameter(declaration) ? declaration : undefined;
                return { name: parameterNode?.name.getText() ?? parameter.name,
                    type: formatType(checker.getTypeOfSymbolAtLocation(parameter, declaration ?? node), declaration ?? node),
                    optional: !!(parameter.flags & ts.SymbolFlags.Optional) || !!parameterNode?.questionToken || !!parameterNode?.initializer,
                    rest: !!parameterNode?.dotDotDotToken };
            }),
            returnType: formatType(signature.getReturnType(), node),
        }));
    }
    function operation(symbol: ts.Symbol, fallback: ts.Node) {
        let implementation = originalSymbol(checker, symbol);
        let node = declarationOf(checker, implementation) ?? fallback;
        const seen = new Set<ts.Symbol>();
        while (!seen.has(implementation)) {
            seen.add(implementation);
            const expression = initializer(node);
            const next = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node) :
                expression && (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) ? checker.getSymbolAtLocation(expression) : undefined;
            if (!next) break;
            implementation = originalSymbol(checker, next);
            node = declarationOf(checker, implementation) ?? node;
        }
        return { source: location(node), description: ts.displayPartsToString(implementation.getDocumentationComment(checker)),
            signatures: signatures(symbolType(checker, symbol, node), node) };
    }
    function hook(file: string | undefined, name = "handler"): SourceLocation | null {
        if (!file) return null;
        const source = sourceFile(file);
        const symbol = exported(checker, source, name);
        return location(symbol ? declarationOf(checker, symbol) ?? source : source);
    }
    function value(source: ts.SourceFile, name: string): ExportValue | null {
        const symbol = exported(checker, source, name);
        if (!symbol) return null;
        let declaration: ts.Node = declarationOf(checker, symbol) ?? source;
        if (ts.isShorthandPropertyAssignment(declaration)) {
            const target = checker.getShorthandAssignmentValueSymbol(declaration);
            if (target) declaration = declarationOf(checker, target) ?? declaration;
        }
        const expression = initializer(declaration);
        const mutable = ts.isVariableDeclaration(declaration) && !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const);
        const result = expression && !mutable ? literal(checker, expression) : UNKNOWN;
        if (result === undefined) return { kind: "undefined", source: location(declaration) };
        if (result !== UNKNOWN) {
            return { kind: "literal", value: result, source: location(declaration) };
        }
        return { kind: "expression", expression: expression?.getText() ?? symbol.name,
            type: formatType(symbolType(checker, symbol, declaration), declaration), source: location(declaration) };
    }
    function errors(scope: SourceScope) {
        const statuses = [...new Set(scope.errors.flatMap(layer => [...layer.statuses.keys()]))].sort((a, b) => a - b);
        return { generic: hook(findErrorTemplate(scope.errors, 0)), server: hook(findErrorTemplate(scope.errors, 500)),
            statuses: Object.fromEntries(statuses.map(status => [String(status), hook(findErrorTemplate(scope.errors, status))])) };
    }
    const routes = project.sources.routes.map(route => {
        const source = sourceFile(route.file);
        const handler = exported(checker, source, "handler");
        const authentication = value(source, "authentication");
        const authorization = value(source, "authorization");
        const envelope = value(source, "envelope");
        const session = authentication?.kind === "literal" && authentication.value === true || authorization?.kind === "literal"
            ? "required" : authentication?.kind === "expression" || authorization?.kind === "expression" ? "conditional" : "optional";
        const routeSchema = (name: string) => {
            const symbol = exported(checker, source, name);
            return symbol ? schema(symbol, source) : null;
        };
        return { method: route.method.toUpperCase(), path: route.path, source: location(source),
            handler: handler ? { source: operation(handler, source).source,
                returnTypes: symbolType(checker, handler, source).getCallSignatures().map(signature => formatType(signature.getReturnType(), source)) } : null,
            input: { params: routeSchema("params"), query: routeSchema("query"), body: routeSchema("body") },
            output: routeSchema("output"),
            access: { session, authentication, authorization },
            hooks: { middleware: route.scope.middleware.map(file => hook(file)!),
                envelope: { source: hook(route.scope.envelope), enabled: envelope?.kind === "expression" ? "conditional" :
                    !(envelope?.kind === "literal" && envelope.value === false), declaration: envelope }, errors: errors(route.scope) } };
    });
    function publicFile(source: ts.SourceFile) {
        return { source: location(source), exports: moduleExports(checker, source).map(symbol => {
            const node = declarationOf(checker, symbol) ?? source;
            const original = originalSymbol(checker, symbol);
            const typeOnly = isTypeOnlyExport(checker, symbol);
            const type = typeOnly && (original.flags & ts.SymbolFlags.Type) ? checker.getDeclaredTypeOfSymbol(original) : symbolType(checker, symbol, node);
            const contract = typeOnly ? null : schema(symbol, source);
            const calls = typeOnly ? [] : signatures(type, node);
            return { name: symbol.name, kind: typeOnly ? "type" : contract ? "schema" : calls.length ? "function" : "value",
                source: location(node), description: ts.displayPartsToString(original.getDocumentationComment(checker)),
                type: contract ? null : formatType(type, node, typeOnly), schema: contract, signatures: calls };
        }) };
    }
    const modules = new Map<string, { name: string; facade: ReturnType<typeof publicFile> | null; schemas: ReturnType<typeof publicFile> | null }>();
    for (const source of project.program.getSourceFiles()) {
        const entry = applicationRole(project.apiDirectory, source.fileName);
        if (!entry.public || !entry.module || entry.role !== "facade" && entry.role !== "schemas") continue;
        const module = modules.get(entry.module) ?? { name: entry.module, facade: null, schemas: null };
        module[entry.role] = publicFile(source);
        modules.set(entry.module, module);
    }
    return {
        schemaVersion: 2 as const, apiDirectory: path(project.apiDirectory),
        setup: hook(project.sources.setup, "setup"),
        auth: project.sources.auth ? { source: location(sourceFile(project.sources.auth)),
            authenticate: exported(checker, sourceFile(project.sources.auth), "authenticate") ? hook(project.sources.auth, "authenticate") : null,
            authorize: exported(checker, sourceFile(project.sources.auth), "authorize") ? hook(project.sources.auth, "authorize") : null } : null,
        unmatchedErrors: errors(project.sources.rootScope),
        routes,
        services: serviceSources(project.program, project.apiDirectory).map(service => ({ name: service.name, access: service.access,
            operations: service.operations.map(entry => ({ name: entry.name, access: entry.access,
                ...operation(entry.symbol, entry.declaration ?? sourceFile(project.sources.setup!)) })) })),
        roles: project.roles.map(source => ({ ...source, file: path(source.file),
            dependencies: source.dependencies.map(edge => ({ ...edge, file: edge.file ? path(edge.file) : undefined })) })),
        modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
}

export type Inspection = ReturnType<typeof inspectProject>;

export function formatInspection(inspection: Inspection): string {
    const at = (source: SourceLocation | null) => source ? `${source.file}:${source.line}:${source.column}` : "framework default";
    const printValue = (value: ExportValue | null) => !value ? "none" : value.kind === "literal" ? JSON.stringify(value.value) :
        value.kind === "undefined" ? "undefined" : `${value.expression} (runtime expression; type: ${value.type})`;
    const lines = [`Boring API — ${inspection.apiDirectory}`, `Setup: ${inspection.setup ? at(inspection.setup) : "none"}`,
        `Authentication: ${inspection.auth?.authenticate ? at(inspection.auth.authenticate) : "none"}`,
        `Authorization: ${inspection.auth?.authorize ? at(inspection.auth.authorize) : "none"}`, "", "Routes"];
    for (const route of inspection.routes) {
        lines.push(`  ${route.method} ${route.path} — ${at(route.handler?.source ?? route.source)}`,
            `    Session: ${route.access.session}; authentication: ${printValue(route.access.authentication)}; authorization: ${printValue(route.access.authorization)}`);
        for (const [name, schema] of Object.entries(route.input)) {
            if (schema) lines.push(`    ${name}: ${schema.inputType} -> ${schema.outputType} — ${at(schema.source)}`);
        }
        lines.push(route.output ? `    Output: ${route.output.inputType} -> ${route.output.outputType} — ${at(route.output.source)}` :
            `    Return: ${route.handler?.returnTypes.join(" | ") || "unknown"} (no output schema)`);
        lines.push(`    Middleware: ${route.hooks.middleware.map(at).join(" -> ") || "none"}`,
            `    Envelope: ${route.hooks.envelope.enabled === false ? "disabled" : route.hooks.envelope.enabled === "conditional" ? "conditional" : "enabled"} — ${at(route.hooks.envelope.source)}`,
            `    Errors: default=${at(route.hooks.errors.generic)}, 5xx=${at(route.hooks.errors.server)}`);
        for (const [status, source] of Object.entries(route.hooks.errors.statuses)) lines.push(`      ${status}: ${at(source)}`);
    }
    lines.push("", "Services (available through ctx.services)");
    if (!inspection.services.length) lines.push("  none inferred from +setup");
    function printOperation(name: string, signatures: Inspection["services"][number]["operations"][number]["signatures"], source: SourceLocation) {
        for (const signature of signatures) {
            const generics = signature.typeParameters.length ? `<${signature.typeParameters.join(", ")}>` : "";
            const params = signature.parameters.map(parameter => `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}`).join(", ");
            lines.push(`  ${name}${generics}(${params}): ${signature.returnType} — ${at(source)}`);
        }
    }
    for (const service of inspection.services) for (const operation of service.operations) printOperation(operation.access, operation.signatures, operation.source);
    lines.push("", "Public modules");
    if (!inspection.modules.length) lines.push("  none");
    for (const module of inspection.modules) {
        for (const name of ["facade", "schemas"] as const) {
            const file = module[name];
            if (!file) continue;
            lines.push(`  ${module.name}/${name} — ${at(file.source)}`);
            for (const entry of file.exports) {
                if (entry.signatures.length) printOperation(`  ${entry.name}`, entry.signatures, entry.source);
                else lines.push(`    ${entry.kind} ${entry.name}: ${entry.schema ? `${entry.schema.inputType} -> ${entry.schema.outputType}` : entry.type} — ${at(entry.source)}`);
            }
        }
    }
    lines.push("", "Application roles");
    for (const source of inspection.roles) lines.push(`  ${source.role}${source.module ? ` (${source.module})` : ""}: ${source.file}`);
    return lines.join("\n");
}
