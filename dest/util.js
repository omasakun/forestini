"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.never = exports.bug = exports.invalid = exports.error = exports.isSameFS = exports.clearDir = exports.mkdtempIn = exports.mkdirpSync = exports.mkdirp = exports.cp = exports.rmSync = exports.rm = exports.every = exports.oneAtATime = exports.debounce = exports.onExit = exports.date = exports.uniq = exports.isStringArray = exports.padZero = exports.clearConsole = exports.filterUndefined = exports.PropContext = exports.makeGetter = exports.captureOutputStreams = exports.InterleavedStreams = void 0;
const async_hooks_1 = require("async_hooks");
const fs_1 = require("fs");
const ncpBase = require("ncp");
const path_1 = require("path");
const rimrafBase = require("rimraf");
const stream_1 = require("stream");
const { mkdir, mkdtemp, readdir, readFile, stat } = fs_1.promises;
class InterleavedStreams {
    constructor() {
        this.outputs = [];
        const self = this;
        const streamFactory = (source) => new stream_1.Writable({
            write(chunk, encoding, cb) {
                const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                self.outputs.push({ source, text });
                cb();
            },
            decodeStrings: false,
            defaultEncoding: "utf8",
            objectMode: false,
        });
        this.stdout = streamFactory("out");
        this.stderr = streamFactory("err");
    }
    isEmpty() {
        return this.outputs.every(o => o.text.length === 0);
    }
    isOutEmpty() {
        return this.outputs.every(o => o.source === "err" || o.text.length === 0);
    }
    isErrEmpty() {
        return this.outputs.every(o => o.source === "out" || o.text.length === 0);
    }
    output() {
        this.outputs.forEach(o => {
            if (o.source === "out")
                process.stdout.write(o.text);
            if (o.source === "err")
                process.stderr.write(o.text);
        });
    }
}
exports.InterleavedStreams = InterleavedStreams;
async function captureOutputStreams(fn, debug = false) {
    const streams = new InterleavedStreams();
    const originalOutWrite = process.stdout.write;
    const originalErrWrite = process.stderr.write;
    const targets = new Set();
    let indent = 2;
    const hook = async_hooks_1.createHook({
        init: (asyncId, type, triggerAsyncId) => {
            if (!targets.has(triggerAsyncId))
                return;
            targets.add(asyncId);
            if (debug) {
                fs_1.writeSync(1, `${' '.repeat(indent)}${triggerAsyncId} -> ${asyncId} [exec ${async_hooks_1.executionAsyncId()}] ${type}\n`);
            }
        },
        before: (asyncId) => {
            if (!targets.has(asyncId))
                return;
            if (debug) {
                fs_1.writeSync(1, `${' '.repeat(indent)}${asyncId} {\n`);
                indent += 2;
            }
            //@ts-ignore
            process.stdout.write = streams.stdout.write.bind(streams.stdout);
            //@ts-ignore
            process.stderr.write = streams.stderr.write.bind(streams.stderr);
        },
        after: (asyncId) => {
            if (!targets.has(asyncId))
                return;
            if (debug) {
                indent -= 2;
                fs_1.writeSync(1, `${' '.repeat(indent)}} ${asyncId}\n`);
            }
            process.stdout.write = originalOutWrite;
            process.stderr.write = originalErrWrite;
        },
    });
    hook.enable();
    await Promise.resolve(); // request new executionAsyncId
    targets.add(async_hooks_1.executionAsyncId());
    if (debug) {
        fs_1.writeSync(1, `[exec ${async_hooks_1.executionAsyncId()}]\n`);
    }
    const res = await fn();
    hook.disable();
    process.stdout.write = originalOutWrite;
    process.stderr.write = originalErrWrite;
    return { streams, res };
}
exports.captureOutputStreams = captureOutputStreams;
function makeGetter(getter) {
    return new Proxy({}, {
        get: (_, name) => {
            if (typeof name !== "string")
                error("makeGetter: prop not found");
            return getter(name);
        }
    });
}
exports.makeGetter = makeGetter;
class PropContext {
    constructor() {
        // private getter: (name: string) => T = () => error("PropContext: not initialized");
        this.getters = new Map();
        /** readable for debug purpose */
        this.masterAsyncId = new Map();
        this.placeholders = new Map();
        this.placeholderSet = new WeakSet();
        this.hook = async_hooks_1.createHook({
            init: (asyncId, type, triggerAsyncId) => {
                if (!this.masterAsyncId.has(triggerAsyncId))
                    return;
                if (this.masterAsyncId.has(asyncId))
                    bug();
                this.masterAsyncId.set(asyncId, this.masterAsyncId.get(triggerAsyncId));
            } // TODO: use AsyncLocalStorage
        });
    }
    getPlaceholder(name) {
        const item = this.placeholders.get(name);
        if (item)
            return item;
        const newItem = () => {
            const eid = async_hooks_1.executionAsyncId();
            if (!this.masterAsyncId.has(eid))
                error("PropContext: out of context");
            const getter = this.getters.get(this.masterAsyncId.get(eid));
            if (!getter)
                bug();
            return getter(name);
        };
        this.placeholders.set(name, newItem);
        this.placeholderSet.add(newItem);
        return newItem;
    }
    async run(getter, fn) {
        this.hook.enable();
        await Promise.resolve(); // request new executionAsyncId
        const eid = async_hooks_1.executionAsyncId();
        if (this.getters.has(eid))
            bug();
        if (this.masterAsyncId.has(eid))
            bug();
        this.getters.set(eid, getter);
        this.masterAsyncId.set(eid, eid);
        const res = await fn();
        this.hook.disable();
        this.getters.delete(eid);
        this.masterAsyncId.delete(eid);
        const keysToRemove = Array.from(this.masterAsyncId.entries()).filter(o => o[1] === eid).map(o => o[0]);
        keysToRemove.forEach(id => this.masterAsyncId.delete(id));
        return res;
    }
    resolvePlaceholder(placeholder) {
        if (!this.placeholderSet.has(placeholder))
            error("PropContext: prop not found");
        return placeholder();
    }
}
exports.PropContext = PropContext;
function filterUndefined(items) {
    // @ts-ignore
    return items.filter(o => typeof o !== "undefined");
}
exports.filterUndefined = filterUndefined;
function clearConsole() {
    // console.clear();
    process.stdout.write('\u001bc');
}
exports.clearConsole = clearConsole;
function padZero(num, max) {
    const digits = max.toFixed(0).length;
    return num.toFixed(0).padStart(digits, "0");
}
exports.padZero = padZero;
function isStringArray(arr) {
    return Array.isArray(arr) && arr.every(o => typeof o === "string");
}
exports.isStringArray = isStringArray;
function uniq(arr) {
    return arr.filter((o, i) => arr.findIndex(oo => oo === o) === i);
}
exports.uniq = uniq;
function date() {
    return new Date().toISOString();
}
exports.date = date;
const onExitFn = [];
setupExitHandler();
function setupExitHandler() {
    ["exit", "SIGINT", "SIGTERM"].forEach(type => {
        process.on(type, () => {
            if (type === "exit")
                onExitFn.forEach(fn => fn());
            else
                process.exit(1);
        });
    });
}
function onExit(fn) {
    onExitFn.push(fn);
    const cancel = () => onExitFn.splice(onExitFn.findIndex(o => o === fn), 1);
    return { cancel };
}
exports.onExit = onExit;
function debounce(fn, delay) {
    let timeout;
    let items = [];
    return newItems => {
        items.push(...newItems);
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            const args = items;
            items = [];
            fn(args);
        }, delay);
    };
}
exports.debounce = debounce;
function oneAtATime(fn) {
    let isRunning = false;
    let shouldRerun = false;
    let stack = [];
    let runner = async () => {
        if (isRunning) {
            shouldRerun = true;
            return; // execution continues from (1) below
        }
        isRunning = true;
        let items = stack;
        stack = [];
        await fn(items);
        isRunning = false;
        if (shouldRerun) {
            shouldRerun = false;
            await runner(); // (1)
        }
    };
    return newItems => {
        stack.push(...newItems);
        runner();
    };
}
exports.oneAtATime = oneAtATime;
function every(promises) {
    let remaining = promises.length;
    if (remaining === 0)
        return Promise.resolve(true);
    return new Promise(res => {
        promises.forEach(o => o.then(result => {
            remaining--;
            if (!result)
                res(false);
            else if (remaining === 0)
                res(true);
        }));
    });
}
exports.every = every;
function rm(path) {
    return new Promise((resolve, rejected) => {
        rimrafBase(path, { disableGlob: true }, err => {
            if (err)
                rejected(err);
            else
                resolve();
        });
    });
}
exports.rm = rm;
function rmSync(path) {
    rimrafBase.sync(path, { disableGlob: true });
}
exports.rmSync = rmSync;
async function cp(src, dest) {
    await mkdirp(path_1.dirname(dest));
    return new Promise((res, rej) => ncpBase.ncp(src, dest, { dereference: true, clobber: false }, err => {
        if (err)
            rej(err);
        else
            res();
    }));
}
exports.cp = cp;
function mkdirp(dir) {
    return mkdir(dir, { recursive: true }).then();
}
exports.mkdirp = mkdirp;
function mkdirpSync(dir) {
    fs_1.mkdirSync(dir, { recursive: true });
}
exports.mkdirpSync = mkdirpSync;
async function mkdtempIn(dir) {
    await mkdirp(dir);
    const tmpDir = await mkdtemp(dir + path_1.sep);
    return tmpDir;
}
exports.mkdtempIn = mkdtempIn;
async function clearDir(dir) {
    try {
        const files = await readdir(dir);
        await Promise.all(files.map(file => rm(path_1.join(dir, file))));
    }
    catch (e) {
        if (e.code === "ENOENT")
            return;
        throw e; // TODO: better error handling
    }
}
exports.clearDir = clearDir;
async function isSameFS(entry1, entry2) {
    try {
        const [stat1, stat2] = await Promise.all([stat(entry1), stat(entry2)]);
        if (!stat1.isDirectory() && !stat1.isFile())
            throw new Error("unexpected..."); // TODO: implement
        if (!stat2.isDirectory() && !stat2.isFile())
            throw new Error("unexpected...");
        if (stat1.isFile() && stat2.isFile()) {
            const [file1, file2] = await Promise.all([readFile(entry1), readFile(entry2)]);
            return file1.equals(file2);
        }
        else if (stat1.isDirectory() && stat2.isDirectory()) {
            const [files1, files2] = await Promise.all([readdir(entry1), readdir(entry2)]);
            if (files1.length !== files2.length)
                return false;
            const [sorted1, sorted2] = [files1.sort(), files2.sort()];
            if (!sorted1.every((o1, i) => o1 === sorted2[i]))
                return false;
            const checkers = sorted1.map((o1, i) => isSameFS(path_1.join(entry1, o1), path_1.join(entry2, sorted2[i])));
            return await every(checkers);
        }
        else {
            return false;
        }
    }
    catch (e) {
        console.error("isSameFS", { entry1, entry2 }, e);
        throw e; // TODO: better error handling
    }
}
exports.isSameFS = isSameFS;
function error(message) {
    throw new Error(message);
}
exports.error = error;
function invalid() {
    throw new Error("invalid");
}
exports.invalid = invalid;
function bug() {
    throw new Error("BUG");
}
exports.bug = bug;
function never(a) {
    throw new Error("BUG (never)");
}
exports.never = never;
