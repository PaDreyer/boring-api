import ts from "typescript";
import { applicationRole, RoleSource } from "@boringapi/core/conventions";
import { declarationOf, isTypeOnlyExport, moduleExports, originalSymbol, symbolType } from "@boringapi/compiler";
import type { ArchitectureDiagnostic } from "./architecture";
import { typeOnlyDependency } from "./type-dependencies";

type FunctionBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/** Value boundaries are deliberately a small, inspectable composition language. */
export function checkBoundaries(program: ts.Program, apiDirectory: string, sources: ts.SourceFile[]): ArchitectureDiagnostic[] {
    const checker = program.getTypeChecker();
    const diagnostics: ArchitectureDiagnostic[] = [];
    const checked = new Set<ts.Node>();
    const operations = new Set<ts.Node>();
    const factoryReturns = new Set<ts.Node>();
    const roleCache = new Map<string, RoleSource>();
    const dataCache = new Map<ts.Type, boolean>();
    const role = (node: ts.Node) => {
        const file = node.getSourceFile().fileName;
        let entry = roleCache.get(file);
        if (!entry) { entry = applicationRole(apiDirectory, file); roleCache.set(file, entry); }
        return entry;
    };
    const report = (node: ts.Node, code: ArchitectureDiagnostic["code"], message: string) =>
        diagnostics.push({ code, file: node.getSourceFile(), start: node.getStart(), length: node.getWidth(), message });
    const isFunction = (node: ts.Node): node is FunctionBody => ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

    function unwrap(node: ts.Node): ts.Node {
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
        return node;
    }
    function value(node: ts.Node, seen = new Set<ts.Node>()): ts.Node {
        node = unwrap(node);
        if (seen.has(node)) return node;
        seen.add(node);
        if (ts.isVariableDeclaration(node) && node.initializer && ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) return value(node.initializer, seen);
        if (ts.isPropertyAssignment(node)) return value(node.initializer, seen);
        const found = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node) :
            ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node) : undefined;
        const declaration = found && declarationOf(checker, originalSymbol(checker, found));
        return declaration && declaration !== node ? value(declaration, seen) : node;
    }
    function returns(fn: FunctionBody): ts.Expression[] {
        if (!fn.body) return [];
        const branches = (expression: ts.Expression): ts.Expression[] => {
            const node = unwrap(expression);
            return ts.isConditionalExpression(node) ? [...branches(node.whenTrue), ...branches(node.whenFalse)] : [expression];
        };
        if (!ts.isBlock(fn.body)) return branches(fn.body);
        const result: ts.Expression[] = [];
        function visit(node: ts.Node) {
            if (ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node) && node.expression) result.push(...branches(node.expression));
            else ts.forEachChild(node, visit);
        }
        ts.forEachChild(fn.body, visit);
        return result;
    }
    function data(type: ts.Type, seen = new Set<ts.Type>()): boolean {
        const cached = dataCache.get(type);
        if (cached !== undefined) return cached;
        const root = !seen.size;
        const result = dataShape(type, seen);
        // Cache complete root traversals only. A recursive back edge is provisional.
        if (root) dataCache.set(type, result);
        return result;
    }
    function dataShape(type: ts.Type, seen: Set<ts.Type>): boolean {
        if (seen.has(type)) return true;
        if (seen.size > 2048) return false;
        seen.add(type);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return false;
        if (type.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(type);
            return !!constraint && data(constraint, seen);
        }
        if (type.isUnionOrIntersection()) return type.types.every(part => data(part, seen));
        if (!(type.flags & ts.TypeFlags.Object)) return true;
        if (type.getCallSignatures().length || type.getConstructSignatures().length) return false;
        const reference = type as ts.TypeReference;
        const builtinContainer = ["Array", "ReadonlyArray", "Promise", "PromiseLike"].includes(type.getSymbol()?.name ?? "") &&
            type.getSymbol()?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
        if (reference.target?.objectFlags & ts.ObjectFlags.Tuple || builtinContainer) return checker.getTypeArguments(reference).every(part => data(part, seen));
        return checker.getIndexInfosOfType(type).every(info => data(info.type, seen)) && type.getProperties().every(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && data(checker.getTypeOfSymbolAtLocation(property, declaration), seen);
        });
    }
    function dependency(type: ts.Type, owner: RoleSource, seen = new Set<ts.Type>()): boolean {
        if (data(type)) return true;
        if (seen.has(type)) return true;
        if (seen.size > 2048) return false;
        seen.add(type);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
        if (type.isUnionOrIntersection()) return type.types.every(part => dependency(part, owner, seen));
        const allowed = (node: ts.Node) => {
            const source = role(node);
            return source.role === "port" && source.module === owner.module || source.role === "facade" &&
                (isFunction(node) && !!node.body || ts.isPropertyAssignment(node) && isFunction(value(node)));
        };
        if (type.getCallSignatures().length) return type.getCallSignatures().every(signature => !!signature.declaration && allowed(signature.declaration));
        return type.getProperties().length > 0 && type.getProperties().every(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && (allowed(declaration) || dependency(checker.getTypeOfSymbolAtLocation(property, declaration), owner, seen));
        });
    }
    function serviceType(type: ts.Type, seen = new Set<ts.Type>()): boolean {
        if (seen.has(type) || data(type)) return false;
        seen.add(type);
        if (type.isUnionOrIntersection()) return type.types.some(part => serviceType(part, seen));
        if (type.getCallSignatures().some(signature => signature.declaration && role(signature.declaration).role === "service")) return true;
        return type.getProperties().some(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && serviceType(checker.getTypeOfSymbolAtLocation(property, declaration), seen);
        });
    }
    function operation(fn: FunctionBody) {
        if (checked.has(fn)) return;
        checked.add(fn);
        operations.add(fn);
        for (const parameter of fn.parameters) {
            if (!data(checker.getTypeAtLocation(parameter))) report(parameter, "BORING112", "Public operations accept data, not callable capabilities, any or unknown. Inject typed ports into the facade factory.");
        }
        const signature = checker.getSignatureFromDeclaration(fn);
        const output = signature?.getReturnType();
        if (output && !data(output)) report(fn, "BORING112", "Public operations return data, not services, adapters, callbacks, any or unknown.");
        // Check the actual expressions too: a broad return annotation must not hide a capability.
        for (const expression of returns(fn)) {
            const actual = checker.getTypeAtLocation(value(expression));
            if (actual && !data(actual)) report(expression, "BORING112", "This return exposes a callable or unchecked value. Return a data result from the public operation.");
        }
    }
    function boundary(fn: FunctionBody) {
        if (!fn.body || checked.has(fn)) return;
        const expressions = returns(fn);
        const objects = expressions.map(expression => value(expression));
        const factory = objects.length > 0 && objects.every(object => ts.isObjectLiteralExpression(object) &&
            (!object.properties.length || object.properties.some(property => ts.isMethodDeclaration(property) || isFunction(value(property)))));
        if (!factory) { operation(fn); return; }
        checked.add(fn);
        for (const expression of expressions) factoryReturns.add(expression);
        function markReturns(node: ts.Node) {
            if (ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node) && node.expression) factoryReturns.add(node.expression);
            else ts.forEachChild(node, markReturns);
        }
        if (fn.body) ts.forEachChild(fn.body, markReturns);
        for (const parameter of fn.parameters) {
            if (!dependency(checker.getTypeAtLocation(parameter), role(fn))) report(parameter, "BORING112", "Facade factories receive data, own typed ports or public facades. Define effect contracts in repository.ts or ports/.");
        }
        for (const object of objects as ts.ObjectLiteralExpression[]) {
            for (const property of object.properties) {
                const target = value(property);
                const owner = role(target);
                const here = role(fn);
                if (!isFunction(target) || !target.body || owner.role !== here.role || owner.module !== here.module ||
                    ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name)) {
                    report(property, "BORING112", "Factory results contain named operations defined in this facade (or page), never raw services, ports, spreads or getters.");
                } else operation(target);
            }
        }
    }
    function exposed(node: ts.Node): boolean {
        const target = value(node);
        if (ts.isCallExpression(target)) {
            const callee = value(target.expression);
            return isFunction(callee) && ["facade", "page"].includes(role(callee).role);
        }
        if (isFunction(target)) {
            const signature = checker.getSignatureFromDeclaration(target);
            return ["facade", "page"].includes(role(target).role) && !!signature && data(signature.getReturnType());
        }
        if (ts.isVariableDeclaration(target)) return false;
        return data(checker.getTypeAtLocation(unwrap(target)));
    }
    function publicCapability(type: ts.Type): boolean {
        const owned = (value: ts.Type) => value.getCallSignatures().some(signature =>
            signature.declaration && ["facade", "page"].includes(role(signature.declaration).role));
        if (owned(type)) return true;
        return type.getProperties().some(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && owned(checker.getTypeOfSymbolAtLocation(property, declaration));
        });
    }
    function servicesAccess(node: ts.Node, seen = new Set<ts.Node>()): boolean {
        node = unwrap(node);
        if (seen.has(node)) return false;
        seen.add(node);
        if (ts.isPropertyAccessExpression(node)) return node.name.text === "services" || servicesAccess(node.expression, seen);
        if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "services" || servicesAccess(node.expression, seen);
        if (ts.isIdentifier(node)) {
            const symbol = checker.getSymbolAtLocation(node);
            const declaration = symbol && declarationOf(checker, symbol);
            if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return servicesAccess(declaration.initializer, seen);
        }
        return false;
    }
    function setup(fn: FunctionBody) {
        for (const expression of returns(fn)) {
            exposureObject(expression);
        }
    }
    function exposureObject(expression: ts.Expression) {
        const object = value(expression);
        if (!ts.isObjectLiteralExpression(object)) {
            report(expression, "BORING113", "Setup returns an explicit object of public facade/page operations and data.");
            return;
        }
        for (const property of object.properties) {
            if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) ||
                ts.isComputedPropertyName(property.name) || !exposed(property)) {
                report(property, "BORING113", "Setup may expose only traced public facade/page operations and data. Inject raw adapters into facade factories; do not expose them or inline wrappers through ctx.services.");
            }
        }
    }
    function setupSetter(type: ts.Type): "set" | "assign" | undefined {
        for (const signature of type.getCallSignatures()) {
            const declaration = signature.declaration;
            if (declaration && ts.isMethodDeclaration(declaration) && ts.isClassDeclaration(declaration.parent) &&
                declaration.parent.name?.text === "SetupContext" && ts.isIdentifier(declaration.name) &&
                (declaration.name.text === "set" || declaration.name.text === "assign")) return declaration.name.text;
        }
        return undefined;
    }
    type CapabilityLoss = "data" | "setter" | undefined;
    interface ConversionState { active: Map<ts.Type, Set<ts.Type>>; remaining: number; }
    function capabilityLoss(actual: ts.Type, expected: ts.Type, seen: ConversionState = { active: new Map(), remaining: 2048 }): CapabilityLoss {
        if (actual === expected || data(actual) || seen.active.get(actual)?.has(expected)) return;
        if (--seen.remaining < 0) return "data";
        const targets = seen.active.get(actual) ?? new Set<ts.Type>();
        targets.add(expected);
        seen.active.set(actual, targets);
        // Back edges are provisional, not cached successes for a later union branch.
        try { return compareCapabilities(actual, expected, seen); }
        finally { targets.delete(expected); }
    }
    function promiseValue(type: ts.Type): ts.Type | undefined {
        const symbol = type.getSymbol();
        return symbol && ["Promise", "PromiseLike"].includes(symbol.name) && symbol.declarations?.some(declaration =>
            program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
    }
    function zodSchema(type: ts.Type): boolean {
        return !!type.getProperty("_def")?.declarations?.some(declaration =>
            /[/\\]node_modules[/\\]zod[/\\]/.test(declaration.getSourceFile().fileName));
    }
    function arrayType(type: ts.Type): boolean {
        return !!((type as ts.TypeReference).target?.objectFlags & ts.ObjectFlags.Tuple) ||
            ["Array", "ReadonlyArray"].includes(type.getSymbol()?.name ?? "") && !!type.getSymbol()?.declarations?.some(declaration =>
                program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    }
    function compareCapabilities(actual: ts.Type, expected: ts.Type, seen: ConversionState): CapabilityLoss {
        if (data(expected)) return "data";
        // Both sides retain the supported Zod capability. Its recursive SDK internals
        // are not application data fields and must not exhaust the comparison budget.
        if (zodSchema(actual) && zodSchema(expected)) return;
        if (actual.isUnion()) {
            for (const part of actual.types) { const loss = capabilityLoss(part, expected, seen); if (loss) return loss; }
            return;
        }
        if (expected.isUnion()) {
            const losses = expected.types.map(part => capabilityLoss(actual, part, seen));
            return losses.every(Boolean) ? losses.find(loss => loss === "setter") ?? "data" : undefined;
        }
        if (expected.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(expected);
            return constraint ? capabilityLoss(actual, constraint, seen) : undefined;
        }
        const setter = setupSetter(actual);
        if (setter && setupSetter(expected) !== setter) return "setter";
        if (expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
        const promisedSource = promiseValue(actual);
        const promisedTarget = promiseValue(expected);
        if (promisedSource && promisedTarget) return capabilityLoss(promisedSource, promisedTarget, seen);
        for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
            const target = checker.getIndexTypeOfType(expected, kind);
            if (!target) continue;
            const source = checker.getIndexTypeOfType(actual, kind);
            if (source) { const loss = capabilityLoss(source, target, seen); if (loss) return loss; }
            for (const property of actual.getProperties()) {
                if (kind === ts.IndexKind.Number && !/^\d+$/.test(property.name)) continue;
                const declaration = property.valueDeclaration ?? property.declarations?.[0];
                if (declaration) { const loss = capabilityLoss(checker.getTypeOfSymbolAtLocation(property, declaration), target, seen); if (loss) return loss; }
            }
        }
        for (const property of expected.getProperties()) {
            // Array operations are shared library machinery; compare indexed slots,
            // not a recursive graph of concat/map/etc. signatures.
            if (arrayType(actual) && arrayType(expected) && !/^\d+$/.test(property.name)) continue;
            const source = actual.getProperty(property.name);
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            const sourceDeclaration = source?.valueDeclaration ?? source?.declarations?.[0];
            if (!declaration) continue;
            const sourceType = source && sourceDeclaration ? checker.getTypeOfSymbolAtLocation(source, sourceDeclaration) :
                checker.getIndexTypeOfType(actual, /^\d+$/.test(property.name) ? ts.IndexKind.Number : ts.IndexKind.String);
            if (sourceType) {
                const loss = capabilityLoss(sourceType, checker.getTypeOfSymbolAtLocation(property, declaration), seen);
                if (loss) return loss;
            }
        }
        // Callback values flow out through results and in through parameters.
        for (const target of expected.getCallSignatures()) {
            for (const source of actual.getCallSignatures()) {
                if (!(target.getReturnType().flags & ts.TypeFlags.Void)) {
                    const loss = capabilityLoss(source.getReturnType(), target.getReturnType(), seen);
                    if (loss) return loss;
                }
                for (const [index, parameter] of source.getParameters().entries()) {
                    const incoming = target.getParameters()[index];
                    const destination = parameter.valueDeclaration ?? parameter.declarations?.[0];
                    const origin = incoming?.valueDeclaration ?? incoming?.declarations?.[0];
                    if (!incoming || !destination || !origin) continue;
                    const input = checker.getTypeOfSymbolAtLocation(incoming, origin);
                    // The instantiated signature supplies unconstrained generic inputs.
                    if (input.flags & ts.TypeFlags.TypeParameter && !checker.getBaseConstraintOfType(input)) continue;
                    const loss = capabilityLoss(input, checker.getTypeOfSymbolAtLocation(parameter, destination), seen);
                    if (loss) return loss;
                }
            }
        }
    }
    function checkConversion(node: ts.Node, actual: ts.Type, expected: ts.Type) {
        const loss = capabilityLoss(actual, expected);
        if (loss) report(node, loss === "setter" ? "BORING113" : "BORING112", loss === "setter"
            ? "Do not hide setup setters behind another callable contract. Preserve SetupContext and call its setters directly."
            : "A type conversion must not erase a callable capability into data, including nested properties, callbacks and tuple elements. Keep typed ports explicit.");
    }
    function setterPattern(pattern: ts.Node, type: ts.Type) {
        const object = ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern);
        const array = ts.isArrayBindingPattern(pattern) || ts.isArrayLiteralExpression(pattern);
        if (!object && !array) return;
        const entries = ts.isObjectLiteralExpression(pattern) ? pattern.properties : pattern.elements;
        entries.forEach((entry, index) => {
            if (ts.isOmittedExpression(entry) || ts.isSpreadAssignment(entry) || ts.isSpreadElement(entry) ||
                ts.isBindingElement(entry) && entry.dotDotDotToken) return;
            const target = ts.isBindingElement(entry) ? entry.name : ts.isPropertyAssignment(entry) ? entry.initializer : entry;
            const name = ts.isBindingElement(entry) ? entry.propertyName ?? entry.name :
                ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined;
            const key = array ? String(index) : name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text :
                name && ts.isComputedPropertyName(name) ? checker.getTypeAtLocation(name.expression) : undefined;
            const property = typeof key === "string" ? type.getProperty(key) : key?.isStringLiteral() ? type.getProperty(key.value) : undefined;
            const member = property ? checker.getTypeOfSymbolAtLocation(property, entry) :
                array ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) : undefined;
            if (!member) return;
            if (setupSetter(member)) report(entry, "BORING113", "Do not destructure or alias setup setters. Call ctx.set or ctx.assign directly with approved operations or data.");
            else setterPattern(target, member);
        });
    }
    function checkArguments(node: ts.CallExpression | ts.NewExpression) {
        const signature = checker.getResolvedSignature(node);
        if (!signature) return;
        const parameters = signature.getParameters();
        for (const [index, argument] of (node.arguments ?? []).entries()) {
            if (data(checker.getTypeAtLocation(unwrap(argument)))) continue;
            const parameter = parameters[Math.min(index, parameters.length - 1)];
            if (!parameter) continue;
            const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
            if (index >= parameters.length && !(declaration && ts.isParameter(declaration) && declaration.dotDotDotToken)) continue;
            // Check instantiated slots and declared constraints, including each rest-tuple position.
            const actual = checker.getTypeAtLocation(unwrap(argument));
            const targets = [checker.getTypeOfSymbolAtLocation(parameter, node), ...(declaration ? [checker.getTypeAtLocation(declaration)] : [])];
            for (let target of targets) {
                if (declaration && ts.isParameter(declaration) && declaration.dotDotDotToken && !ts.isSpreadElement(argument)) {
                    const property = target.getProperty(String(index - parameters.length + 1));
                    target = property ? checker.getTypeOfSymbolAtLocation(property, node) : checker.getIndexTypeOfType(target, ts.IndexKind.Number) ?? target;
                }
                const count = diagnostics.length;
                checkConversion(argument, actual, target);
                if (diagnostics.length !== count) break;
            }
        }
    }
    function errorClass(node: ts.Node): boolean {
        if (!ts.isClassDeclaration(node)) return false;
        const seen = new Set<ts.Type>();
        function error(type: ts.Type): boolean {
            if (seen.has(type) || seen.size > 32) return false;
            seen.add(type);
            if (type.getSymbol()?.name === "Error" && type.getSymbol()?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return true;
            return !!(type.flags & ts.TypeFlags.Object) && checker.getBaseTypes(type as ts.InterfaceType)?.some(error);
        }
        const instance = checker.getTypeAtLocation(node);
        return error(instance) && data(instance) && node.members.every(member => ts.isConstructorDeclaration(member) ||
            data(checker.getTypeAtLocation(member)) && (!ts.isPropertyDeclaration(member) || !member.initializer ||
                data(checker.getTypeAtLocation(unwrap(member.initializer)))));
    }
    for (const source of sources) {
        const owner = role(source);
        if (!["facade", "page", "setup", "service", "port", "schemas", "endpoint", "hook"].includes(owner.role)) continue;
        if (owner.role === "schemas") {
            for (const symbol of moduleExports(checker, source)) {
                if (isTypeOnlyExport(checker, symbol)) continue;
                const type = symbolType(checker, symbol, source);
                if (!zodSchema(type) && !data(type)) report(symbol.declarations?.[0] ?? source, "BORING112",
                    "Schemas export data, types and Zod schemas, not executable helpers or capability objects. Put business operations behind a facade.");
            }
        }
        if (owner.role === "port") {
            for (const statement of source.statements) {
                if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
                    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && typeOnlyDependency(statement))) {
                    report(statement, "BORING111", "Ports contain only type imports, interfaces, type aliases and type exports. Put implementations in infra/.");
                }
            }
        }
        if (owner.role === "service") {
            for (const symbol of moduleExports(checker, source)) {
                if (isTypeOnlyExport(checker, symbol)) continue;
                const type = symbolType(checker, symbol, source);
                const declaration = declarationOf(checker, symbol);
                if (!type.getCallSignatures().length && !data(type) && !(declaration && errorClass(value(declaration)))) {
                    report(symbol.declarations?.[0] ?? source, "BORING114", "Export service operations as named functions, not callable containers, service classes or unchecked values. Domain error classes may carry data but no methods.");
                }
            }
        }
        if (["facade", "page", "setup"].includes(owner.role)) {
            if (source.isDeclarationFile) report(source, "BORING112", "Public operation boundaries require an implementation, not an ambient declaration.");
            for (const symbol of moduleExports(checker, source)) {
                const declaration = declarationOf(checker, symbol);
                if (!declaration) continue;
                const declaredSite = symbol.declarations?.[0] ?? declaration;
                const site = declaredSite.getSourceFile() === source ? declaredSite :
                    source.statements.find(ts.isExportDeclaration) ?? source;
                if (isTypeOnlyExport(checker, symbol)) {
                    const original = originalSymbol(checker, symbol);
                    const type = original.flags & ts.SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(original) : symbolType(checker, original, declaration);
                    if (role(declaration).role === "service" || serviceType(type)) report(site, "BORING112", "Service types stay private. Publish data in schemas and dependency contracts in ports.");
                    continue;
                }
                const target = value(declaration);
                if (symbol.name === "default" || !isFunction(target) || role(target).role !== owner.role || role(target).module !== owner.module) {
                    report(site, owner.role === "setup" ? "BORING113" : "BORING112", "Export named functions owned by this facade/page. Re-export only same-role facade parts; service and adapter values stay private.");
                    continue;
                }
                if (owner.role === "setup") setup(target); else boundary(target);
            }
        }
        function visit(node: ts.Node) {
            if ((owner.role === "service" || owner.role === "schemas") && isFunction(node) && node.body) {
                const output = checker.getSignatureFromDeclaration(node)?.getReturnType();
                if (output) {
                    for (const expression of returns(node)) {
                        const actual = checker.getTypeAtLocation(value(expression));
                        checkConversion(expression, promiseValue(actual) ?? actual, promiseValue(output) ?? output);
                    }
                }
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) checkArguments(node);
            if (ts.isVariableDeclaration(node) && node.initializer && !ts.isIdentifier(node.name)) setterPattern(node.name, checker.getTypeAtLocation(node.initializer));
            if (ts.isParameter(node) && !ts.isIdentifier(node.name)) setterPattern(node.name, checker.getTypeAtLocation(node));
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) setterPattern(unwrap(node.left), checker.getTypeAtLocation(node.right));
            if (["facade", "page", "setup"].includes(owner.role) && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                let root: ts.Expression = node.left;
                while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
                if (ts.isIdentifier(root) && ["module", "exports"].includes(root.text)) {
                    const symbol = checker.getSymbolAtLocation(root);
                    if (!symbol?.declarations?.some(declaration => !declaration.getSourceFile().isDeclarationFile &&
                        (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isBindingElement(declaration)))) {
                        report(node, "BORING112", "Public facade/page/setup boundaries use named ES exports. CommonJS boundary exports are unsupported; literal CommonJS dependencies elsewhere remain checked.");
                    }
                }
            }
            if (["facade", "page", "setup"].includes(owner.role) && ts.isExportAssignment(node)) {
                report(node, "BORING112", "Public boundaries use named ES exports, not export assignments or default exports.");
            }
            if (["facade", "page", "setup", "service", "schemas"].includes(owner.role) && ts.isVariableDeclaration(node) && node.initializer && node.type) {
                checkConversion(node, checker.getTypeAtLocation(unwrap(node.initializer)), checker.getTypeAtLocation(node));
            }
            if (["facade", "page"].includes(owner.role) && ts.isReturnStatement(node) && node.expression &&
                !factoryReturns.has(node.expression) && !data(checker.getTypeAtLocation(value(node.expression)))) {
                report(node, "BORING112", "Helpers cannot return hidden capabilities. Only an explicit facade factory exposes its own operation object.");
            }
            if (["facade", "page"].includes(owner.role) && ts.isArrowFunction(node) && !ts.isBlock(node.body) &&
                !checked.has(node) && !data(checker.getTypeAtLocation(value(node.body)))) {
                report(node, "BORING112", "Helpers cannot return hidden capabilities. Return data or expose explicit facade-owned operations.");
            }
            if (["facade", "page", "setup", "service", "schemas"].includes(owner.role) && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                checkConversion(node, checker.getTypeAtLocation(unwrap(node.right)), checker.getTypeAtLocation(node.left));
            }
            if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
                const setter = setupSetter(checker.getTypeAtLocation(node));
                if (setter) {
                    const call = node.parent;
                    if (!ts.isCallExpression(call) || call.expression !== node) {
                        report(node, "BORING113", "Do not alias setup setters. Use explicit ctx.set or ctx.assign with approved public operations or data.");
                    } else if (setter === "assign" && call.arguments[0]) exposureObject(call.arguments[0]);
                    else if (!call.arguments[1] || !exposed(call.arguments[1])) {
                        report(call, "BORING113", "Imperative setup writes obey the same exposure contract: public facade/page operations or data, never raw adapters or wrappers.");
                    }
                }
            }
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
                (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
                (["facade", "page", "setup"].includes(owner.role) && !data(checker.getTypeAtLocation(node.left.expression)) ||
                    ["endpoint", "hook"].includes(owner.role) && (publicCapability(checker.getTypeAtLocation(node.left.expression)) || servicesAccess(node.left.expression)))) {
                report(node, "BORING113", "Do not mutate capability objects or their exports. Compose explicit facade operations in setup.");
            }
            if (["facade", "page", "setup"].includes(owner.role) && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
                ts.isIdentifier(node.expression) && ["Object", "Reflect"].includes(node.expression.text) &&
                ["assign", "defineProperty", "defineProperties", "setPrototypeOf", "set"].includes(ts.isPropertyAccessExpression(node) ? node.name.text :
                    ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "set")) {
                report(node, "BORING113", "Dynamic capability composition is unsupported. Use explicit operation objects and setup properties.");
            }
            if (["facade", "page", "setup"].includes(owner.role) && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
                node.initializer && ts.isIdentifier(node.initializer) && ["Object", "Reflect"].includes(node.initializer.text)) {
                report(node, "BORING113", "Do not destructure reflection APIs at application boundaries. Use explicit operation objects.");
            }
            if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
                checkConversion(node, checker.getTypeAtLocation(unwrap(node.expression)), checker.getTypeAtLocation(node));
            }
            if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) &&
                !ts.isExportSpecifier(node.parent) && !ts.isTypeNode(node.parent)) {
                const symbol = checker.getSymbolAtLocation(node);
                const original = symbol && originalSymbol(checker, symbol);
                const declaration = original && declarationOf(checker, original);
                if (declaration && !ts.isParameter(declaration) && role(declaration).role === "service" && symbolType(checker, original!, declaration).getCallSignatures().length) {
                    const defining = (ts.isFunctionDeclaration(node.parent) || ts.isVariableDeclaration(node.parent)) && node.parent.name === node;
                    const calling = ts.isCallExpression(node.parent) && node.parent.expression === node;
                    let caller: ts.Node | undefined = node.parent;
                    while (caller && !operations.has(caller)) caller = caller.parent;
                    if (!defining && !(calling && caller && owner.role === "facade" && owner.module === role(declaration).module)) {
                        report(node, "BORING114", "Only an operation in the owning facade calls a service. Do not invoke it during module loading/composition, alias, pass, return, re-export or call a peer service.");
                    }
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return diagnostics;
}
