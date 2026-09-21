import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject, inspectProject, formatArchitectureDiagnostics } from "../src";
const jobDeclaration = `import { input } from "$modules/orders/schemas";
import type { JobHandler } from "./$types";
export const payload = input;
export const version = 1;
export const policy = {maxAttempts:3,retryDelayMs:10,timeoutMs:1000} as const;
export const handler: JobHandler = async ctx => { await ctx.services.orders.create(ctx.execution, ctx.payload); };`;
function fixture(run: (root: string, write: (name: string, content: string) => void) => void) {
    const root = mkdtempSync(join(tmpdir(), "boring-job-check-"));
    const write = (name: string, content: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
    try {
        mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
        symlinkSync(dirname(require.resolve("@boringapi/core/package.json")), join(root, "node_modules/@boringapi/core"), "dir");
        symlinkSync(join(__dirname, "../node_modules/zod"), join(root, "node_modules/zod"), "dir");
        symlinkSync(join(__dirname, "../node_modules/@types"), join(root, "node_modules/@types"), "dir");
        write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: { strict: true, skipLibCheck: true, target: "ES2020", module: "commonjs", esModuleInterop: true }, include: ["**/*.ts"] }));
        write("api/+setup.ts", 'import { createOrders } from "$modules/orders/facade"; export const setup = () => ({ orders: createOrders() });');
        write("modules/orders/schemas.ts", 'import { z } from "zod"; export const input = z.object({ value: z.string() });');
        write("modules/orders/facade.ts", 'import type { ExecutionContext } from "@boringapi/core"; export function createOrders() { return { create(execution: ExecutionContext, input: {value:string}) { execution.throwIfAborted(); return input; } }; }');
        write("jobs/orders/create/job.ts", jobDeclaration + '\nthrow new Error("Inspection must never execute jobs");');
        run(root, write);
    } finally { rmSync(root, { recursive: true, force: true }); }
}
function messages(root: string) { const p = analyzeProject(root, "api"); return { p, text: formatArchitectureDiagnostics(p.architecture, root) }; }

for (const kind of ["schedule", "event", "command"] as const) {
    const title = kind[0].toUpperCase() + kind.slice(1);
    const declaration = kind === "command" ? jobDeclaration.replace('export const payload = input;', 'export const input = contract; export const output = contract;').replace('{ input }', '{ input as contract }').replace('export const version = 1;', 'export const timeoutMs = 1000;').replace('export const policy = {maxAttempts:3,retryDelayMs:10,timeoutMs:1000} as const;', '').split('JobHandler').join('CommandHandler').replace('async ctx => { await ctx.services.orders.create(ctx.execution, ctx.payload); }', 'ctx => ctx.services.orders.create(ctx.execution, ctx.input)') : jobDeclaration.split('JobHandler').join(`${title}Handler`).replace('{ input }', '{ input as contract }').replace('payload = input', 'payload = contract') + (kind === "event" ? '\nexport const event = {type:"created",version:1} as const;' : '\nexport const input = {value:"x"}; export const timing = {startAt:0,everyMs:1000,missed:"latest",maxCatchUp:1,overlap:"skip"} as const;');
    it(`discovers ${kind} contracts, generated types and operations statically`, () => fixture((root, write) => {
        write(`${kind}s/create/${kind}.ts`, declaration + '\nthrow new Error("never execute during inspection");');
        const {p,text} = messages(root); assert.equal(text, "");
        assert.equal(p.diagnostics.length, 0, p.diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
        const entry = inspectProject(p).triggers.find(entry => entry.kind === kind)!;
        assert.equal(entry.name, "create"); assert.deepEqual(entry.operations, ["ctx.services.orders.create"]); assert.ok(entry.input?.inputType.includes("value"));
    }));
    it(`enforces indirect role, context, admission and mutation boundaries for unused ${kind} entries`, () => fixture((root, write) => {
        write("modules/orders/service.ts", 'export function raw() {return "private";}');
        write("infra/db.ts", 'export const raw=()=>"db";');
        const cases: [string,string][] = [
            ['import {raw} from "$modules/orders/service";', "BORING102"],
            ['import type {raw} from "$modules/orders/service";', "BORING102"],
            ['const raw=require("../../../infra/db");', "BORING101"],
            ['export {raw} from "$infra/db";', "BORING101"],
            ['import {createOrders} from "$modules/orders/facade";', "BORING101"],
            ['import * as core from "@boringapi/core"; const Factory=core["BoringApi"];', "BORING116"],
            ['const core=require("@boringapi/core");', "BORING116"],
            ['import type {ExecutionContext} from "@boringapi/core"; const saved=new Map<string,Readonly<ExecutionContext>[]>();', "BORING115"],
            ['const {defineProperty: replace}=Reflect;', "BORING113"],
            ['const del=Reflect.deleteProperty;', "BORING113"],
            ['class State { static execution: import("@boringapi/core").ExecutionContext | undefined; }', "BORING115"],
            ['let saved: () => import("@boringapi/core").ExecutionContext | undefined = () => undefined;', "BORING115"],
            ['const obj=Object; const replace=obj["defineProperty"];', "BORING113"],
            ['import type {ExecutionContext} from "@boringapi/core"; function replace(orders:{create:(execution:ExecutionContext,input:{value:string})=>{value:string}}){orders.create=(_execution,input)=>input;}', "BORING113"],
            ['function replace(orders:{create?:()=>string}){delete orders.create;}', "BORING113"],
            ['function replace(orders:{create:()=>string}){[orders.create]=[()=>"changed"];}', "BORING113"],
            ['function replace(orders:{create:()=>string}){({nested:{callback:orders.create}}={nested:{callback:()=>"changed"}});}', "BORING113"],
            ['function replace(orders:{create:()=>string}){[orders["create"]=()=>"changed"]=[undefined];}', "BORING113"],
            ['function replace(orders:{callbacks:Array<()=>string>}){[...orders.callbacks]=[()=>"changed"];}', "BORING113"],
            ['function replace(orders:{create:()=>string}){for([orders.create] of [[()=>"changed"]]){}}', "BORING113"],
            ['const load=require; load("../../../infra/db");', "BORING106"],
        ];
        cases.forEach(([code],i)=>write(`${kind}s/bypass/case-${i}/${kind}.ts`,declaration+"\n"+code));
        const {text}=messages(root);
        cases.forEach(([,code],i)=>assert.match(text,new RegExp(`${kind}s/bypass/case-${i}/${kind}.ts.*${code}`)));
        write(`api/get.ts`, `export {handler} from "../${kind}s/create/${kind}";`);
        write(`${kind}s/create/${kind}.ts`,declaration);
        assert.match(messages(root).text,/BORING104/);
    }));
    it(`rejects invalid ${kind} declarations and erases no handler capabilities`, () => fixture((root,write)=>{
        write(`${kind}s/invalid/${kind}.ts`, declaration.replace('z.object', 'z.object') + '\nexport const unchecked = () => {};');
        assert.match(messages(root).text,/BORING117/);
        write(`${kind}s/invalid/${kind}.ts`, declaration.replace(`handler: ${title}Handler`, 'handler: any'));
        assert.match(messages(root).text,/BORING117/);
        if(kind === "schedule") {write(`${kind}s/invalid/${kind}.ts`,declaration.replace('everyMs:1000','everyMs:0')); assert.match(messages(root).text,/BORING117/);}
    }));
}

it("rejects cyclic and excessive schedule constants without recursive traversal failure", () => fixture((root,write)=>{
    write("schedules/cycle/schedule.ts", jobDeclaration.replace('{ input }','{ input as contract }').replace('payload = input','payload = contract').split('JobHandler').join('ScheduleHandler') + '\nconst circular = {value:"x", next: circular}; export const input=circular; export const timing={startAt:0,everyMs:1,missed:"latest",maxCatchUp:1,overlap:"skip"} as const;');
    assert.match(messages(root).text,/BORING117/);
}));

const commandDeclaration = `import {z} from "zod";
import type {CommandHandler,CommandContext} from "./$types";
export const input=z.object({}); export const output=z.boolean(); export const timeoutMs=1000;
let saved:()=>boolean=()=>false;
function read(ctx:CommandContext){return ctx.execution.signal.aborted;}
export const handler:CommandHandler=ctx=>{const previous=saved(); OPERATION return previous;};`;

it("rejects retention through nested destructuring assignments, defaults, rest and subsequent local aliases", () => fixture((root,write)=>{
    const cases = [
        '[saved]=[()=>ctx.execution.signal.aborted];',
        '({callback:saved}={callback:()=>ctx.execution.signal.aborted});',
        '({saved}={saved:()=>ctx.execution.signal.aborted});',
        '({nested:[saved]}={nested:[()=>ctx.execution.signal.aborted]});',
        '[saved=()=>ctx.execution.signal.aborted]=[];',
        '({saved=()=>ctx.execution.signal.aborted}={});',
        '({callback:saved=()=>ctx.execution.signal.aborted}={});',
        'let callback:()=>boolean=()=>false; [callback]=[()=>ctx.execution.signal.aborted]; saved=callback;',
        'let callback:()=>boolean=()=>false; ({callback}={callback:()=>ctx.execution.signal.aborted}); saved=callback;',
        'const key="callback"; ({[key]:saved}={callback:()=>ctx.execution.signal.aborted});',
        'let callbacks:Array<()=>boolean>=[]; [, ...callbacks]=[()=>false,()=>ctx.execution.signal.aborted]; saved=callbacks[0];',
        'let callbacks:{callback:()=>boolean}={callback:()=>false}; ({...callbacks}={callback:()=>ctx.execution.signal.aborted}); saved=callbacks.callback;',
        'const result={callback:()=>ctx.execution.signal.aborted}; ({callback:saved}=result);',
        'const result={callback:()=>ctx.execution.signal.aborted}; let callback:()=>boolean=()=>false; ({callback}=result); saved=callback;',
    ];
    cases.forEach((operation,i)=>write(`commands/pattern-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/pattern-${i}/command.ts.*BORING115`)));
}));

it("rejects bound execution callbacks and extracted execution capabilities after forwarding or aliasing", () => fixture((root,write)=>{
    const cases = [
        'saved=read.bind(null,ctx);',
        'saved=read["bind"](null,ctx);',
        'function readThis(this:CommandContext){return this.execution.signal.aborted;} saved=readThis.bind(ctx);',
        'const {signal}=ctx.execution; saved=()=>signal.aborted;',
        'const {execution:{signal:cancel}}=ctx; saved=()=>cancel.aborted;',
        'let signal:AbortSignal|undefined; ({signal}=ctx.execution); const cancel=signal; saved=()=>cancel.aborted;',
        'const signal=ctx.execution.signal; saved=()=>signal.aborted;',
        'const {...execution}=ctx.execution; saved=()=>execution.signal.aborted;',
        'const {throwIfAborted}=ctx.execution; saved=()=>{throwIfAborted();return false;};',
        'function bind(context:CommandContext){return read.bind(null,context);} saved=bind(ctx);',
        'function take({signal}:{signal:AbortSignal}){return ()=>signal.aborted;} saved=take(ctx.execution);',
        'function take(signal:AbortSignal){return ()=>signal.aborted;} saved=take(ctx.execution.signal);',
        'function signal(context:CommandContext){return context.execution.signal;} const cancel=signal(ctx); saved=()=>cancel.aborted;',
        'const callbacks:Array<()=>boolean>=[]; callbacks.push(read.bind(null,ctx)); saved=callbacks[0];',
        'for(const signal of [ctx.execution.signal]) saved=()=>signal.aborted;',
        'for([saved] of [[read.bind(null,ctx)]]) {}',
    ];
    // These collections are invocation-local; transfer of their content
    // still must not extend that callback's lifetime.
    cases.forEach((operation,i)=>write(`commands/capability-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/capability-${i}/command.ts.*BORING115`)));
}));

it("preserves local binding, selected data copies and unrelated callbacks alongside execution capabilities", () => fixture((root,write)=>{
    const cases = [
        'const local=read.bind(null,ctx); local();',
        'let local=saved; [local]=[read.bind(null,ctx)]; local();',
        'saved=((value:boolean)=>value).bind(null,ctx.execution.signal.aborted);',
        'const {signal}=ctx.execution; const local=()=>signal.aborted; local();',
        'const aborted=ctx.execution.signal.aborted; saved=()=>aborted;',
        'const {aborted}=ctx.execution.signal; saved=()=>aborted;',
        'const {identity}=ctx.execution; saved=()=>identity.id.length>0;',
        'const value={signal:ctx.execution.signal,callback:()=>false}; const {callback}=value; saved=callback;',
        'const {signal,callback}= {signal:ctx.execution.signal,callback:()=>false}; saved=callback; signal.throwIfAborted();',
        'let callback=()=>false; [callback]=[()=>ctx.execution.signal.aborted]; callback();',
        'const local=()=>ctx.execution.signal.aborted; let callback=()=>false; ({callback}={callback:local}); callback();',
        'let callback=()=>false; const values:[AbortSignal,()=>boolean]=[ctx.execution.signal,()=>false]; [,callback]=values; saved=callback;',
        'let callback=()=>false; let local=()=>false; [callback,local]=[()=>false,()=>ctx.execution.signal.aborted]; saved=callback;local();',
        'const callback=()=>false; const values={callback,signal:ctx.execution.signal}; ({callback:saved}=values);',
        'function invoke(context:CommandContext){return read(context);} const result=invoke(ctx); saved=()=>result;',
        'const controller=new AbortController(); saved=()=>controller.signal.aborted;',
        'const {services}=ctx; const operation=services.orders.create; void operation;',
    ];
    cases.forEach((operation,i)=>write(`commands/local-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.equal(result.text,"");
}));

it("preserves context provenance through default parameters and positional rest/spread bindings", () => fixture((root,write)=>{
    const cases = [
        'function capture(...callbacks:Array<()=>boolean>){saved=callbacks[0];} capture(()=>ctx.execution.signal.aborted);',
        'function capture(_label:string,...callbacks:Array<()=>boolean>){saved=callbacks[1];} capture("x",()=>false,()=>ctx.execution.signal.aborted);',
        'function capture(...callbacks:[()=>boolean,()=>boolean]){saved=callbacks[1];} capture(()=>false,()=>ctx.execution.signal.aborted);',
        'function capture(...[callback]:[()=>boolean]){saved=callback;} capture(()=>ctx.execution.signal.aborted);',
        'function capture(...callbacks:Array<()=>boolean>){saved=callbacks[0];} const callbacks=[()=>ctx.execution.signal.aborted]; capture(...callbacks);',
        'function capture(...callbacks:Array<()=>boolean>){saved=callbacks[1];} const callbacks=[()=>false,()=>ctx.execution.signal.aborted] as const; capture(...callbacks);',
        'function capture(_label:string,callback:()=>boolean){saved=callback;} capture(...["x",()=>ctx.execution.signal.aborted] as const);',
        'function capture(...callbacks:Array<()=>boolean>){saved=callbacks[1];} capture(...[()=>false,()=>ctx.execution.signal.aborted]);',
        'function capture(...callbacks:Array<()=>boolean>){return callbacks[0];} saved=capture(()=>ctx.execution.signal.aborted);',
        'function capture(callback=()=>ctx.execution.signal.aborted){saved=callback;} capture();',
        'function capture(callback=()=>ctx.execution.signal.aborted){saved=callback;} capture(undefined);',
        'function capture(signal=ctx.execution.signal){saved=()=>signal.aborted;} capture();',
        'function capture({callback=()=>ctx.execution.signal.aborted}={}){saved=callback;} capture();',
        'class Capture {constructor(...callbacks:Array<()=>boolean>){saved=callbacks[0];}} new Capture(()=>ctx.execution.signal.aborted);',
        'class Capture {constructor(callback=()=>ctx.execution.signal.aborted){saved=callback;}} new Capture();',
    ];
    cases.forEach((operation,i)=>write(`commands/parameters-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/parameters-${i}/command.ts.*BORING115`)));
}));

it("preserves execution callback provenance through native array element and array returns", () => fixture((root,write)=>{
    const cases = [
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.pop()!;',
        'const callbacks=[read.bind(null,ctx)]; saved=callbacks["shift"]()!;',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.slice()[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; saved=callbacks.slice(1).pop()!;',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.splice(0,1)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.find(()=>true)!;',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.filter(()=>true)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.reverse()[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.sort()[0];',
        'const callbacks:Array<()=>boolean>=[]; saved=callbacks.concat(()=>ctx.execution.signal.aborted)[0];',
        'const callbacks=[[()=>ctx.execution.signal.aborted]]; saved=callbacks.flat()[0];',
        'const callbacks:Array<()=>boolean>=[]; callbacks.push(()=>ctx.execution.signal.aborted); saved=callbacks.pop()!;',
        'function take(callbacks:Array<()=>boolean>){return callbacks.pop()!;} saved=take([()=>ctx.execution.signal.aborted]);',
    ];
    cases.forEach((operation,i)=>write(`commands/array-return-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/array-return-${i}/command.ts.*BORING115`)));
}));

it("allows local parameter/array use and retains only the selected rest argument", () => fixture((root,write)=>{
    const cases = [
        'const aborted=ctx.execution.signal.aborted; function capture(...callbacks:Array<()=>boolean>){saved=callbacks[0];} capture(()=>aborted);',
        'const aborted=ctx.execution.signal.aborted; function capture(callback=()=>aborted){saved=callback;} capture();',
        'function invoke(callback=()=>ctx.execution.signal.aborted){return callback();} const result=invoke(); saved=()=>result;',
        'function capture(...callbacks:[()=>boolean,()=>boolean]){saved=callbacks[0];callbacks[1]();} capture(()=>false,()=>ctx.execution.signal.aborted);',
        'function capture(_label:string,...callbacks:[()=>boolean,()=>boolean]){saved=callbacks[1];callbacks[0]();} capture("x",()=>ctx.execution.signal.aborted,()=>false);',
        'function capture(...callbacks:[()=>boolean,()=>boolean]){saved=callbacks[0];callbacks[1]();} const callbacks=[()=>false,()=>ctx.execution.signal.aborted] as const; capture(...callbacks);',
        'function capture(...callbacks:Array<()=>boolean>){saved=callbacks[0];callbacks[1]();} capture(...[()=>false,()=>ctx.execution.signal.aborted]);',
        'const aborted=ctx.execution.signal.aborted; const callbacks=[()=>aborted]; saved=callbacks.pop()!;',
        'const aborted=ctx.execution.signal.aborted; const callbacks=[()=>aborted]; saved=callbacks.shift()!;',
        'const aborted=ctx.execution.signal.aborted; const callbacks=[()=>aborted]; saved=callbacks.slice()[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; const local=callbacks.pop()!; local();',
        'const callbacks=[()=>ctx.execution.signal.aborted]; const local=callbacks.slice().shift()!; local();',
        'const callbacks=shared.slice();callbacks.push(()=>ctx.execution.signal.aborted);callbacks[0]();',
        'const value={callback:()=>ctx.execution.signal.aborted,pop(){return ()=>false;}};saved=value.pop();',
    ];
    cases.forEach((operation,i)=>write(`commands/local-parameters-${i}/command.ts`,commandDeclaration.replace('let saved:', 'const shared:Array<()=>boolean>=[];let saved:').replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.equal(result.text,"");
}));

it("tracks overloaded function, method and constructor implementations through arguments and results", () => fixture((root,write)=>{
    const cases = [
        'function capture(callback:()=>boolean):void; function capture(callback:()=>boolean){saved=callback;} capture(()=>ctx.execution.signal.aborted);',
        'function capture(callback:()=>boolean):()=>boolean; function capture(actual:()=>boolean){return actual;} saved=capture(()=>ctx.execution.signal.aborted);',
        'function capture(callback:()=>boolean):void; function capture(...actual:Array<()=>boolean>){saved=actual[0];} capture(()=>ctx.execution.signal.aborted);',
        'function capture(callback:()=>boolean):void; function capture(callback:()=>boolean){saved=callback;} const alias=capture; alias(()=>ctx.execution.signal.aborted);',
        'class Capture {save(callback:()=>boolean):void; save(actual:()=>boolean){saved=actual;}} new Capture().save(()=>ctx.execution.signal.aborted);',
        'class Capture {static save(callback:()=>boolean):void; static save(actual:()=>boolean){saved=actual;}} Capture.save(()=>ctx.execution.signal.aborted);',
        'class Capture {other(){return false;} constructor(callback:()=>boolean); constructor(actual:()=>boolean){saved=actual;}} new Capture(()=>ctx.execution.signal.aborted);',
        'class Capture {constructor(callback:()=>boolean); constructor(...actual:Array<()=>boolean>){saved=actual[0];}} new Capture(()=>ctx.execution.signal.aborted);',
        'function capture(callback?:()=>boolean):void; function capture(actual=()=>ctx.execution.signal.aborted){saved=actual;} capture();',
        'const capture:(callback:()=>boolean)=>void=actual=>{saved=actual;}; capture(()=>ctx.execution.signal.aborted);',
        'const helper:{capture:(callback:()=>boolean)=>void}={capture:actual=>{saved=actual;}}; helper.capture(()=>ctx.execution.signal.aborted);',
    ];
    cases.forEach((operation,i)=>write(`commands/overload-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/overload-${i}/command.ts.*BORING115`)));
}));

it("preserves storage identity and writes through native array aliases in both directions", () => fixture((root,write)=>{
    const cases = [
        'shared.reverse().push(()=>ctx.execution.signal.aborted);',
        'const callbacks=shared.sort(); callbacks.push(()=>ctx.execution.signal.aborted);',
        'const callbacks=shared["reverse"]().sort(); callbacks.unshift(()=>ctx.execution.signal.aborted);',
        'shared.copyWithin(0,0).push(()=>ctx.execution.signal.aborted);',
        'shared.fill(()=>ctx.execution.signal.aborted);',
        'const callbacks:Array<()=>boolean>=[]; const alias=callbacks.reverse(); alias.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const alias=callbacks.sort(); callbacks.push(()=>ctx.execution.signal.aborted); saved=alias[0];',
        'const callbacks:Array<()=>boolean>=[]; callbacks.reverse().sort().push(()=>ctx.execution.signal.aborted); saved=callbacks.pop()!;',
        'const callbacks:Array<()=>boolean>=[]; let alias=callbacks; alias=alias.reverse(); alias.splice(0,0,()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks=[()=>false]; callbacks.fill(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const alias=callbacks.copyWithin(0,0); alias.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; put(callbacks.reverse(),()=>ctx.execution.signal.aborted); saved=callbacks[0]; function put(target:Array<()=>boolean>,callback:()=>boolean){target.push(callback);}',
        'const callbacks:Array<()=>boolean>=[]; function alias(target:Array<()=>boolean>){return target.reverse();} alias(callbacks).push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const state={callbacks:[] as Array<()=>boolean>}; const alias=state.callbacks.reverse(); alias.push(()=>ctx.execution.signal.aborted); saved=state.callbacks[0];',
        'const callbacks=shared.slice(); const alias=callbacks.reverse(); alias.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
    ];
    cases.forEach((operation,i)=>write(`commands/array-identity-${i}/command.ts`,commandDeclaration.replace('let saved:', 'const shared:Array<()=>boolean>=[];let saved:').replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/array-identity-${i}/command.ts.*BORING115`)));
}));

it("preserves safe overload calls, local array aliases and separate copy storage", () => fixture((root,write)=>{
    const cases = [
        'const aborted=ctx.execution.signal.aborted; function capture(callback:()=>boolean):void; function capture(actual:()=>boolean){saved=actual;} capture(()=>aborted);',
        'function invoke(callback:()=>boolean):boolean; function invoke(actual:()=>boolean){return actual();} const result=invoke(()=>ctx.execution.signal.aborted); saved=()=>result;',
        'const invoke:(callback:()=>boolean)=>boolean=actual=>actual(); const result=invoke(()=>ctx.execution.signal.aborted); saved=()=>result;',
        'class Capture {constructor(callback:()=>boolean); constructor(actual:()=>boolean){saved=actual;}} const aborted=ctx.execution.signal.aborted; new Capture(()=>aborted);',
        'const callbacks=shared.slice(); callbacks.reverse().push(()=>ctx.execution.signal.aborted); callbacks[0]();',
        'const callbacks=shared.slice(); const alias=callbacks.sort(); alias.push(()=>ctx.execution.signal.aborted); alias[0]();',
        'const callbacks=[()=>false]; const copy=callbacks.slice(); copy.reverse().push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks=[()=>false]; const copy=callbacks.filter(()=>true); copy.sort().push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const alias=callbacks.reverse(); alias.push(()=>ctx.execution.signal.aborted); callbacks[0]();',
        'const callbacks:Array<()=>boolean>=[]; const alias=callbacks.reverse(); const aborted=ctx.execution.signal.aborted; alias.push(()=>aborted); saved=callbacks[0];',
        'const state={left:[()=>false],right:[] as Array<()=>boolean>}; state.right.reverse().push(()=>ctx.execution.signal.aborted); saved=state.left[0];',
        'const callbacks=[()=>false]; const value={reverse(){return [] as Array<()=>boolean>;}};value.reverse().push(()=>ctx.execution.signal.aborted);saved=callbacks[0];',
    ];
    cases.forEach((operation,i)=>write(`commands/local-identity-${i}/command.ts`,commandDeclaration.replace('let saved:', 'const shared:Array<()=>boolean>=[];let saved:').replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.equal(result.text,"");
}));

it("tracks existing elements after native array mutations through the original and aliased storage", () => fixture((root,write)=>{
    const cases = [
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.reverse(); saved=callbacks[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.sort(()=>-1); saved=callbacks[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.copyWithin(0,1); saved=callbacks[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.shift(); saved=callbacks[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted,()=>false]; callbacks.unshift(()=>false); saved=callbacks[1];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.splice(0,1); saved=callbacks[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; const alias=callbacks; alias["reverse"](); saved=callbacks[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; reorder(callbacks); saved=callbacks[0]; function reorder(target:Array<()=>boolean>){target.reverse();}',
        'const callbacks:Array<()=>boolean>=[()=>false,()=>false]; callbacks[1]=()=>ctx.execution.signal.aborted; callbacks.reverse(); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested=[[] as Array<()=>boolean>,callbacks]; nested.reverse(); nested[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
    ];
    cases.forEach((operation,i)=>write(`commands/reorder-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/reorder-${i}/command.ts.*BORING115`)));
}));

it("tracks callable implementations through mutable bindings and native call/apply", () => fixture((root,write)=>{
    const cases = [
        'let capture:(callback:()=>boolean)=>void=actual=>{saved=actual;}; capture(()=>ctx.execution.signal.aborted);',
        'let capture:(callback:()=>boolean)=>void=()=>{}; capture=actual=>{saved=actual;}; capture(()=>ctx.execution.signal.aborted);',
        'let capture:(callback:()=>boolean)=>void=()=>{}; function assign(){capture=actual=>{saved=actual;};} assign(); capture(()=>ctx.execution.signal.aborted);',
        'let capture:(callback:()=>boolean)=>void=actual=>{saved=actual;}; const alias=capture; alias(()=>ctx.execution.signal.aborted);',
        'let helper:{capture:(callback:()=>boolean)=>void}={capture:actual=>{saved=actual;}}; helper.capture(()=>ctx.execution.signal.aborted);',
        'let capture:(callback:()=>boolean)=>()=>boolean=actual=>actual; saved=capture(()=>ctx.execution.signal.aborted);',
        'function capture(actual:()=>boolean){saved=actual;} capture.call(undefined,()=>ctx.execution.signal.aborted);',
        'function capture(actual:()=>boolean){saved=actual;} capture["apply"](undefined,[()=>ctx.execution.signal.aborted]);',
        'function capture(actual:()=>boolean){saved=actual;} const args:[()=>boolean]=[()=>ctx.execution.signal.aborted]; capture.apply(undefined,args);',
        'function capture(...actual:Array<()=>boolean>){saved=actual[0];} capture.apply(undefined,[()=>ctx.execution.signal.aborted]);',
        'function capture(actual:()=>boolean):void; function capture(actual:()=>boolean){saved=actual;} capture.call(undefined,()=>ctx.execution.signal.aborted);',
        'function capture(actual:()=>boolean){return actual;} saved=capture.apply(undefined,[()=>ctx.execution.signal.aborted]);',
        'function invoke(fn:(callback:()=>boolean)=>void,callback:()=>boolean){fn(callback);} invoke(actual=>{saved=actual;},()=>ctx.execution.signal.aborted);',
    ];
    cases.forEach((operation,i)=>write(`commands/callable-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/callable-${i}/command.ts.*BORING115`)));
}));

it("preserves inner array identity through shallow copies and native element returns", () => fixture((root,write)=>{
    const cases = [
        'const callbacks:Array<()=>boolean>=[]; const nested=[callbacks]; const copy=nested.slice(); copy[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested=[[],callbacks]; nested.slice(1)[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; [callbacks].filter(()=>true)[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested:Array<Array<()=>boolean>>=[]; nested.concat([callbacks])[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; [callbacks].splice(0,1)[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; [callbacks].pop()!.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested=[{callbacks}]; nested.slice()[0].callbacks.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested=[callbacks]; const copy=[...nested]; copy[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested=[callbacks]; function copy(input:Array<Array<()=>boolean>>){return input.slice();} copy(nested)[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const nested:Array<Array<()=>boolean>>=[]; nested.push(callbacks); nested.slice()[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const nested=[shared]; nested.slice()[0].push(()=>ctx.execution.signal.aborted);',
    ];
    cases.forEach((operation,i)=>write(`commands/shallow-${i}/command.ts`,commandDeclaration.replace('let saved:', 'const shared:Array<()=>boolean>=[];let saved:').replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/shallow-${i}/command.ts.*BORING115`)));
}));

it("allows safe data capture and invocation-local use through mutation, mutable callables and shallow copies", () => fixture((root,write)=>{
    const cases = [
        'const aborted=ctx.execution.signal.aborted; const callbacks=[()=>false,()=>aborted]; callbacks.reverse(); saved=callbacks[0];',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.sort(()=>-1); callbacks[0]();',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.copyWithin(0,1); callbacks[0]();',
        'const callbacks=[()=>false,()=>ctx.execution.signal.aborted]; callbacks.shift(); callbacks[0]();',
        'const callbacks=[()=>false]; const copy=callbacks.slice(); copy.unshift(()=>ctx.execution.signal.aborted); copy.reverse(); saved=callbacks[0];',
        'const aborted=ctx.execution.signal.aborted; let capture:(callback:()=>boolean)=>void=actual=>{saved=actual;}; capture(()=>aborted);',
        'let invoke:(callback:()=>boolean)=>boolean=actual=>actual(); const result=invoke(()=>ctx.execution.signal.aborted); saved=()=>result;',
        'function invoke(actual:()=>boolean){return actual();} const result=invoke.call(undefined,()=>ctx.execution.signal.aborted); saved=()=>result;',
        'function capture(...actual:[()=>boolean,()=>boolean]){saved=actual[0];actual[1]();} capture.apply(undefined,[()=>false,()=>ctx.execution.signal.aborted]);',
        'const helper={call(_this:undefined,actual:()=>boolean){return actual();}}; const result=helper.call(undefined,()=>ctx.execution.signal.aborted); saved=()=>result;',
        'const callbacks:Array<()=>boolean>=[]; const nested=[callbacks]; const copy=nested.slice(); copy[0].push(()=>ctx.execution.signal.aborted); callbacks[0]();',
        'const callbacks:Array<()=>boolean>=[]; const nested=[callbacks]; const copy=nested.slice(); const aborted=ctx.execution.signal.aborted; copy[0].push(()=>aborted); saved=callbacks[0];',
        'const callbacks=[()=>false]; const nested=[callbacks]; const detached=nested.slice()[0].slice(); detached.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks=[()=>false]; const nested=[callbacks]; nested.slice().push([()=>ctx.execution.signal.aborted]); saved=callbacks[0];',
        'const nested=[shared.slice()]; nested.slice()[0].push(()=>ctx.execution.signal.aborted);',
    ];
    cases.forEach((operation,i)=>write(`commands/safe-flow-${i}/command.ts`,commandDeclaration.replace('let saved:', 'const shared:Array<()=>boolean>=[];let saved:').replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.equal(result.text,"");
}));

it("resolves callable array elements using the shared mutation and return flow", () => fixture((root,write)=>{
    const cases = [
        'const captures:Array<(cb:()=>boolean)=>void>=[]; captures.push(cb=>{saved=cb;}); captures[0](()=>ctx.execution.signal.aborted);',
        'const captures:Array<(cb:()=>boolean)=>void>=[cb=>{saved=cb;}]; captures.slice()[0](()=>ctx.execution.signal.aborted);',
        'const captures:Array<(cb:()=>boolean)=>void>=[cb=>{},cb=>{saved=cb;}]; captures.reverse(); captures[0](()=>ctx.execution.signal.aborted);',
        'const captures:Array<(cb:()=>boolean)=>void>=[]; fill(captures); captures.pop()!(()=>ctx.execution.signal.aborted); function fill(target:typeof captures){target.push(cb=>{saved=cb;});}',
        'const captures:Array<(cb:()=>boolean)=>void>=[]; const aliases=[captures].slice(); aliases[0].push(cb=>{saved=cb;}); captures[0](()=>ctx.execution.signal.aborted);',
        'function create(){return (cb:()=>boolean)=>{saved=cb;};} const captures=[create()]; captures.filter(()=>true)[0](()=>ctx.execution.signal.aborted);',
        'const captures:Array<(cb:()=>boolean)=>void>=[cb=>{},cb=>{saved=cb;}]; captures.sort(()=>-1); captures[0].call(undefined,()=>ctx.execution.signal.aborted);',
        'const captures:Array<(cb:()=>boolean)=>void>=[cb=>{},cb=>{saved=cb;}]; captures.shift(); captures[0].apply(undefined,[()=>ctx.execution.signal.aborted]);',
        'const captures:Array<(cb:()=>boolean)=>void>=[]; const install=[()=>captures.push(cb=>{saved=cb;})]; install.slice()[0](); captures[0](()=>ctx.execution.signal.aborted);',
        'const captures=[0].map(()=>(cb:()=>boolean)=>{saved=cb;}); captures[0](()=>ctx.execution.signal.aborted);',
        'const captures=Array.from([0],()=>(cb:()=>boolean)=>{saved=cb;}); captures[0](()=>ctx.execution.signal.aborted);',
    ];
    cases.forEach((operation,i)=>write(`commands/callable-array-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/callable-array-${i}/command.ts.*BORING115`)));
}));

it("preserves native mapping results, callback inputs and returned inner storage", () => fixture((root,write)=>{
    const cases = [
        'const callbacks=[0].map(()=>()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks=Array.from([0],()=>()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks=[0].flatMap(()=>[()=>ctx.execution.signal.aborted]); saved=callbacks[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.map(cb=>cb)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=Array.from(callbacks,cb=>cb)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=Array.from(callbacks)[0];',
        'const callbacks:Array<()=>boolean>=[]; const aliases=[callbacks].map(value=>value); aliases[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks:Array<()=>boolean>=[]; const aliases=Array.from([callbacks],value=>value); aliases[0].push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'let mapper:(value:number)=>()=>boolean=()=>()=>false; mapper=()=>()=>ctx.execution.signal.aborted; saved=[0].map(mapper)[0];',
        'function mapper(value:()=>boolean){return ()=>value();} saved=[()=>ctx.execution.signal.aborted].map(mapper)[0];',
        'const mappers=[(value:()=>boolean)=>value]; saved=[()=>ctx.execution.signal.aborted].map(mappers.slice()[0])[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; callbacks.map(cb=>{saved=cb;return false;});',
        'const callbacks=[()=>ctx.execution.signal.aborted]; Array.from(callbacks,cb=>{saved=cb;return false;});',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.map((_cb,_index,array)=>array[0])[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.map((...args)=>args[0])[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; callbacks.forEach(cb=>{saved=cb;});',
        'const callbacks=[()=>ctx.execution.signal.aborted]; callbacks.filter(cb=>{saved=cb;return true;});',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.reduce((_previous,cb)=>cb,()=>false);',
        'const callbacks:Array<()=>boolean>=[]; saved=callbacks.reduce(()=>()=>false,()=>ctx.execution.signal.aborted);',
        'saved=Array.of(()=>ctx.execution.signal.aborted)[0];',
    ];
    cases.forEach((operation,i)=>write(`commands/native-mapping-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/native-mapping-${i}/command.ts.*BORING115`)));
}));

it("allows copied data and local callbacks through callable arrays and native mappings", () => fixture((root,write)=>{
    const cases = [
        'const captures:Array<(cb:()=>boolean)=>boolean>=[]; captures.push(cb=>cb()); const result=captures[0](()=>ctx.execution.signal.aborted); saved=()=>result;',
        'const captures:Array<(cb:()=>boolean)=>void>=[]; captures.push(cb=>{saved=cb;}); const aborted=ctx.execution.signal.aborted; captures[0](()=>aborted);',
        'const callbacks=[0].map(()=>()=>ctx.execution.signal.aborted); callbacks[0]();',
        'const callbacks=Array.from([0],()=>()=>ctx.execution.signal.aborted); callbacks[0]();',
        'const aborted=ctx.execution.signal.aborted; saved=[0].map(()=>()=>aborted)[0];',
        'const aborted=ctx.execution.signal.aborted; saved=Array.from([0],()=>()=>aborted)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; const result=callbacks.map(cb=>cb())[0]; saved=()=>result;',
        'const callbacks=[()=>ctx.execution.signal.aborted]; const result=Array.from(callbacks,cb=>cb())[0]; saved=()=>result;',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.map((_cb,index)=>()=>index===0)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.flatMap(cb=>{const result=cb();return [()=>result];})[0];',
        'const callbacks=[()=>false]; const copy=callbacks.map(cb=>cb); copy.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const callbacks=[()=>false]; const copy=Array.from(callbacks); copy.push(()=>ctx.execution.signal.aborted); saved=callbacks[0];',
        'const custom={map(_callback:()=>()=>boolean){return [()=>false];}}; saved=custom.map(()=>()=>ctx.execution.signal.aborted)[0];',
        'const custom={from(_values:number[],_callback:()=>()=>boolean){return [()=>false];}}; saved=custom.from([0],()=>()=>ctx.execution.signal.aborted)[0];',
        'const callbacks=[()=>ctx.execution.signal.aborted]; callbacks.forEach(cb=>cb());',
        'const callbacks=[()=>ctx.execution.signal.aborted]; const result=callbacks.reduce((previous,cb)=>previous||cb(),false); saved=()=>result;',
    ];
    cases.forEach((operation,i)=>write(`commands/safe-mapping-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.equal(result.text,"");
}));

it("rejects retention through indirect native mapping, callback thisArg and bound local callbacks", () => fixture((root,write)=>{
    const cases = [
        'const callbacks=[0].map.call([0],()=>()=>ctx.execution.signal.aborted); saved=callbacks[0] as ()=>boolean;',
        'const callbacks=[0].map.apply([0],[()=>()=>ctx.execution.signal.aborted]); saved=callbacks[0] as ()=>boolean;',
        'const args:[(value:number)=>()=>boolean]=[()=>()=>ctx.execution.signal.aborted]; const callbacks=[0].map.apply([0],args); saved=callbacks[0] as ()=>boolean;',
        'const mapper=[0].map.bind([0]); const callbacks=mapper(()=>()=>ctx.execution.signal.aborted); saved=callbacks[0] as ()=>boolean;',
        'const callbacks=Array.from.call(Array,[0],()=>()=>ctx.execution.signal.aborted); saved=callbacks[0] as ()=>boolean;',
        'const carrier={callback:()=>ctx.execution.signal.aborted}; const callbacks=[0].map(function(this:typeof carrier){return this.callback;},carrier); saved=callbacks[0];',
        'const carrier={callback:()=>ctx.execution.signal.aborted}; const callbacks=Array.from([0],function(this:typeof carrier){return this.callback;},carrier); saved=callbacks[0];',
        'const capture=(cb:()=>boolean)=>{saved=cb;}; const bound=capture.bind(undefined); [()=>ctx.execution.signal.aborted].forEach(bound);',
        'const capture=(_label:string,cb:()=>boolean)=>{saved=cb;}; const bound=capture.bind(undefined,"retained"); [()=>ctx.execution.signal.aborted].forEach(bound);',
    ];
    cases.forEach((operation,i)=>write(`commands/indirect-native-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>assert.match(result.text,new RegExp(`commands/indirect-native-${i}/command.ts.*BORING115`)));
}));

it("rejects native callback calls whose dynamic arguments cannot be analyzed", () => fixture((root,write)=>{
    const cases = [
        'function makeArgs():[(value:number)=>()=>boolean]{return [()=>()=>ctx.execution.signal.aborted];} const args=makeArgs(); const callbacks=[0].map.apply([0],args); saved=callbacks[0] as ()=>boolean;',
        'const aborted=ctx.execution.signal.aborted; function makeArgs():[(value:number)=>()=>boolean]{return [()=>()=>aborted];} const callbacks=[0].map.apply([0],makeArgs()); saved=callbacks[0] as ()=>boolean;',
        'const args:[(value:number)=>()=>boolean]=[()=>()=>false]; const callbacks=[0].map.apply([0],[...args]); saved=callbacks[0] as ()=>boolean;',
        'const args:[(value:number)=>()=>boolean]=[()=>()=>false]; const callbacks=[0].map(...args); saved=callbacks[0] as ()=>boolean;',
        'function makeArgs():[number[],(value:unknown)=>unknown]{return [[0],value=>value];} Array.from.apply(Array,makeArgs());',
    ];
    cases.forEach((operation,i)=>write(`commands/unsupported-native-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const {p,text}=messages(root);
    assert.equal(p.diagnostics.length,0,p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    cases.forEach((_,i)=>{
        const source=p.architecture.find(d=>d.file.fileName.endsWith(`commands/unsupported-native-${i}/command.ts`) &&
            d.code==="BORING115" && d.message.includes("dynamic apply or spread"));
        assert.ok(source,text);
        assert.ok(source.start>0 && source.length>0);
        assert.match(text,new RegExp(`commands/unsupported-native-${i}/command\\.ts:[0-9]+:[0-9]+ - error BORING115`));
        assert.match(source.message,/Call (?:the array method|Array\.from) directly with explicit arguments/);
    });
}));

it("diagnoses native array calls beyond the supported alias depth", () => fixture((root,write)=>{
    const aliases=Array.from({length:34},(_,i)=>`const mapper${i+1}=mapper${i};`).join(" ");
    write("commands/deep-native/command.ts",commandDeclaration.replace("OPERATION",
        `const mapper0=[0].map.bind([0]); ${aliases} const callbacks=mapper34(()=>()=>false); saved=callbacks[0];`));
    const {p,text}=messages(root);
    assert.equal(p.diagnostics.length,0,p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.match(text,/commands\/deep-native\/command\.ts:[0-9]+:[0-9]+ - error BORING115: Indirect native array call exceeds the supported alias\/bind depth/);
}));

it("preserves copied data, invocation-local callbacks and custom methods with matching names", () => fixture((root,write)=>{
    const cases = [
        'const aborted=ctx.execution.signal.aborted; const callbacks=[0].map.call([0],()=>()=>aborted); saved=callbacks[0] as ()=>boolean;',
        'const aborted=ctx.execution.signal.aborted; const carrier={callback:()=>aborted}; const callbacks=[0].map(function(this:typeof carrier){return this.callback;},carrier); saved=callbacks[0];',
        'const aborted=ctx.execution.signal.aborted; const capture=(cb:()=>boolean)=>{saved=cb;}; const bound=capture.bind(undefined); [()=>aborted].forEach(bound);',
        'const bound=((cb:()=>boolean)=>cb()).bind(undefined); [()=>ctx.execution.signal.aborted].forEach(bound);',
        'const custom={map(_callback:()=>()=>boolean){return [()=>false];}}; saved=custom.map.call(custom,()=>()=>ctx.execution.signal.aborted)[0];',
        'const custom={map(_callback:(value:number)=>()=>boolean){return [()=>false];}}; function makeArgs():[(value:number)=>()=>boolean]{return [()=>()=>ctx.execution.signal.aborted];} custom.map.apply(custom,makeArgs());',
        'const args:[(value:number)=>()=>boolean]=[()=>()=>ctx.execution.signal.aborted]; [0].map.apply([0],args);',
    ];
    cases.forEach((operation,i)=>write(`commands/indirect-safe-${i}/command.ts`,commandDeclaration.replace('OPERATION',operation)));
    const result=messages(root);
    assert.equal(result.p.diagnostics.length,0,result.p.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n"));
    assert.equal(result.text,"");
}));

it("rejects callback capture escapes with data-only return types and preserves invocation-local callbacks", () => fixture((root,write)=>{
    const declaration = jobDeclaration.split('JobHandler').join('EventHandler') + '\nexport const event={type:"created",version:1} as const;';
    const cases = [
        ['let saved:()=>string|undefined=()=>undefined;', 'saved=()=>ctx.execution.identity?.id;'],
        ['let saved:(()=>string)|undefined;', 'saved ??= ()=>ctx.execution.identity.id;'],
        ['let saved:(()=>string)|undefined;', 'saved ||= ()=>ctx.execution.identity.id;'],
        ['let saved:(()=>string)|undefined;', 'saved &&= ()=>ctx.execution.identity.id;'],
        ['let saved:()=>string|undefined=()=>undefined;', 'const callback=()=>ctx.execution.identity?.id; saved=callback;'],
        ['const saved:Array<()=>string|undefined>=[];', 'saved.push(()=>ctx.execution.identity?.id);'],
        ['let saved:()=>string=()=>""; function save(callback:()=>string){saved=callback;}', 'save(()=>ctx.execution.identity.id);'],
        ['let saved:()=>string=()=>""; function save({callback}:{callback:()=>string}){saved=callback;}', 'save({callback:()=>ctx.execution.identity.id});'],
        ['let saved:()=>string=()=>""; class Save {constructor(callback:()=>string){saved=callback;}}', 'new Save(()=>ctx.execution.identity.id);'],
        ['let saved:()=>string=()=>""; function save(callback:()=>string){saved=callback;} function forward(callback:()=>string){save(callback);}', 'forward(()=>ctx.execution.identity.id);'],
        ['class State {static saved:()=>string=()=>""; static save(callback:()=>string){this.saved=callback;}}', 'State.save(()=>ctx.execution.identity.id);'],
        ['const saved:Array<()=>string>=[];', 'let alias=saved; alias.push(()=>ctx.execution.identity.id);'],
        ['const saved:Array<()=>string>=[];', 'let alias:Array<()=>string>=[]; alias=saved; alias.push(()=>ctx.execution.identity.id);'],
        ['const saved:Array<()=>string>=[];', '(saved).push(()=>ctx.execution.identity.id);'],
        ['const saved:Array<()=>string>=[]; function save(target:Array<()=>string>,callback:()=>string){target.push(callback);}', 'save(saved,()=>ctx.execution.identity.id);'],
        ['const saved=new Map<string,()=>void>();', 'saved.set("a",()=>ctx.execution.throwIfAborted());'],
        ['class State {static execution:import("@boringapi/core").ExecutionContext|undefined;}', 'State.execution=ctx.execution;'],
        ['', 'Reflect.deleteProperty(ctx.services.orders,"create");'],
        ['', 'delete (ctx.services.orders as Partial<typeof ctx.services.orders>).create;'],
    ];
    for(const [i,[state,operation]] of cases.entries()) write(`events/case-${i}/event.ts`,state+'\n'+declaration.replace('await ctx.services.orders.create(ctx.execution, ctx.payload);',operation));
    const {text}=messages(root);cases.forEach((_,i)=>assert.match(text,new RegExp(`events/case-${i}/event.ts.*BORING11[35]`)));
    write('events/local/event.ts',declaration.replace('await ctx.services.orders.create(ctx.execution, ctx.payload);','const callbacks=[()=>ctx.execution.identity?.id]; callbacks[0]();'));
    assert.doesNotMatch(messages(root).text,/events\/local\/event.ts/);
    write('events/local-helper/event.ts','let last=""; function invoke(callback:()=>string){return callback();} function fill(target:Array<()=>string>,callback:()=>string){target.push(callback);} function edit(data:{value:string}){data.value="ok";}\n'+declaration.replace('await ctx.services.orders.create(ctx.execution, ctx.payload);','const callbacks:Array<()=>string>=[]; fill(callbacks,()=>ctx.execution.identity.id); last=invoke(()=>ctx.execution.identity.id); edit(ctx.payload);'));
    const local=messages(root); assert.doesNotMatch(local.text,/events\/local-helper\/event.ts/);
}));
it("accepts negative JSON numbers in schedules consistently with runtime", () => fixture((root,write)=>{
    write('schedules/negative/schedule.ts',`import {z} from "zod"; import type {ScheduleHandler} from "./$types"; export const payload=z.object({value:z.number(),items:z.array(z.number())}); export const input={value:-1,items:[-2,3]}; export const version=1; export const timing={startAt:0,everyMs:1,missed:"latest",maxCatchUp:1,overlap:"skip"} as const; export const policy={maxAttempts:1,retryDelayMs:1,timeoutMs:1}; export const handler:ScheduleHandler=ctx=>{void ctx.payload;};`);
    const {p,text}=messages(root); assert.equal(text,"");assert.equal(p.diagnostics.length,0);
}));

it("protects structural operation parameters in HTTP helpers while preserving HTTP payload writes", () => fixture((root,write)=>{
    write('api/get.ts', `import type {GetHandler} from "./$types"; import type {ExecutionContext} from "@boringapi/core";
function replace(orders:{create:(execution:ExecutionContext,input:{value:string})=>{value:string}}){orders.create=(_execution,input)=>input;}
export const handler:GetHandler=ctx=>{replace(ctx.services.orders);ctx.payload={value:"ok"};return ctx.services.orders.create(ctx.execution,{value:"ok"});};`);
    const result=messages(root); assert.match(result.text,/api\/get.ts.*BORING113/);
    assert.equal(result.p.architecture.filter(d=>d.code==="BORING113").length,1,result.text);
    assert.equal(result.p.diagnostics.length,0);
}));
