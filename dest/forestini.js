"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exec = exports.customBuild = exports.path = exports.browserSync = exports.filterFiles = exports.merge = exports.cache = exports.dest = exports.src = exports.buildDirPlaceholders = exports.Builder = void 0;
const BS = require("browser-sync");
const child_process_1 = require("child_process");
const chokidar = require("chokidar");
const glob = require("glob");
const os_1 = require("os");
const path_1 = require("path");
const perf_hooks_1 = require("perf_hooks");
const process_1 = require("process");
const util_1 = require("./util");
//#region Builder
class Builder {
    constructor(config) {
        this.config = config;
        this.tasks = [];
        this.frozen = false;
    }
    task(deps, task) {
        if (deps.some(o => o._builder !== this, this))
            util_1.invalid();
        if (this.tasks.some(o => o.task === task))
            util_1.invalid();
        const instance = new TaskInstance(task, deps.map(o => o._instance), this.tasks.length);
        const node = new TaskNode(this, instance);
        this.tasks.push(instance);
        return node;
    }
    freeze() {
        if (this.frozen)
            util_1.invalid();
        this.frozen = true;
        return new Runner(this.tasks, this.config);
    }
    src(...args) {
        return this.task([], src(...args));
    }
    merge(deps, ...args) {
        return this.task(deps, merge(...args));
    }
    asyncBuild(deps, ...args) {
        return this.task(deps, customBuild(...args));
    }
}
exports.Builder = Builder;
class TaskNode {
    constructor(_builder, _instance) {
        this._builder = _builder;
        this._instance = _instance;
    }
    then(task) {
        return this._builder.task([this], task);
    }
    if(condition, task) {
        if (condition)
            return this.then(task);
        else
            return this;
    }
    dest(...args) {
        return this.then(dest(...args));
    }
    cache(...args) {
        return this.then(cache(...args));
    }
    filterFiles(...args) {
        return this.then(filterFiles(...args));
    }
    browserSync(...args) {
        return this.then(browserSync(...args));
    }
    asyncBuild(...args) {
        return this.then(customBuild(...args));
    }
}
//#endregion
//#region Runner
class Runner {
    /** @param tasks topologically sorted DAG */
    constructor(tasks, config) {
        this.tasks = tasks;
        this.isRunning = false;
        this.config = { tmpDir: os_1.tmpdir(), watchDebounce: 100, ...config };
    }
    dotGraph() {
        // TODO: according to graphviz.org, layout engines may apply additional escape sequences.
        const name = (o) => o.task.displayName.replace(/"/g, '\\"');
        const id = (o) => "task" + util_1.padZero(o.i, this.tasks.length);
        return [
            "strict digraph {",
            ...this.tasks.map(o => `\t${id(o)}[label="${name(o)}"];`),
            ...this.tasks.flatMap(o1 => o1.deps.map(o2 => `\t${id(o2)} -> ${id(o1)};`)),
            "}"
        ].join("\n");
    }
    async clear() {
        await Promise.all(this.tasks.map(o => { var _a, _b; return (_b = (_a = o.task).clear) === null || _b === void 0 ? void 0 : _b.call(_a); }));
    }
    async build() {
        if (this.isRunning)
            util_1.error("The Forestini is already running");
        this.isRunning = true;
        console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${util_1.date()}`);
        const { dispose, rootDir } = await this.prepareTaskNodes();
        const { cancel } = util_1.onExit(() => dispose());
        await this.runTaskNodes(rootDir);
        cancel();
        dispose();
        console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${util_1.date()}`);
        this.isRunning = false;
        return { err: this.tasks.some(o => o.isError()) };
    }
    async watch() {
        if (this.isRunning)
            util_1.error("The Forestini is already running");
        this.isRunning = true;
        const { dispose, rootDir } = await this.prepareTaskNodes();
        let isFirstRun = true;
        let rebuild = util_1.debounce(util_1.oneAtATime(async (updates) => {
            if (isFirstRun)
                isFirstRun = false;
            else
                util_1.clearConsole();
            console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${util_1.date()}`);
            this.makeDependentsWaiting(updates);
            await this.runTaskNodes(rootDir);
            console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${util_1.date()}`);
        }), this.config.watchDebounce);
        await this.beginWatching(task => rebuild([task]));
        util_1.onExit(() => dispose());
        rebuild([]);
        // this.running = false; // watch task is continuing
    }
    async prepareTaskNodes() {
        const rootDir = await util_1.mkdtempIn(this.config.tmpDir);
        this.tasks.forEach(o => {
            o.state = "WAITING";
            o.outDir = undefined;
        });
        const dispose = () => util_1.rmSync(rootDir);
        return { dispose, rootDir };
    }
    async runTaskNodes(rootDir) {
        if (this.tasks.every(o => o.isDone()))
            return;
        const promises = [];
        this.tasks.forEach(o => {
            if (!o.isWaiting())
                return;
            if (o.deps.some(o => o.isError())) {
                o.state = "REJECTED";
                taskReporter(o, "ERR_SKIPPED");
                return;
            }
            if (!o.task.volatile && o.deps.every(o => o.isNotChanged())) {
                o.state = "NOCHANGE";
                taskReporter(o, "SKIPPED");
                return;
            }
            if (o.deps.every(o => o.isDone())) {
                o.state = "PENDING";
                const inDirs = o.deps.map(o => o.outDir);
                const getDir = (name) => this.getDirForTask(rootDir, o, name);
                const args = { inDirs, getDir };
                const build = async () => {
                    o.outDir = undefined; // TODO: should it be preserved?
                    const { streams, res } = await o.run(args);
                    if (res.ok) {
                        const { outDir, notChanged } = res.res;
                        o.outDir = outDir;
                        o.state = notChanged ? "NOCHANGE" : "RESOLVED";
                        taskReporter(o, "OK", res.time, streams);
                    }
                    else {
                        o.state = "REJECTED";
                        taskReporter(o, "ERR", res.time, streams);
                    }
                    await this.runTaskNodes(rootDir); // note: since promises are asynchronous, stack overflow will not occur
                };
                promises.push(build());
            }
        });
        await Promise.all(promises);
    }
    makeDependentsWaiting(o) {
        o.forEach(o => o.state = "WAITING");
        this.tasks.forEach(o => {
            if (o.deps.some(o => o.isWaiting())) {
                o.state = "WAITING";
            }
        });
    }
    beginWatching(cb) {
        return Promise.all(this.tasks.map(o => { var _a, _b; return (_b = (_a = o.task).watch) === null || _b === void 0 ? void 0 : _b.call(_a, () => cb(o)); })).then();
    }
    getDirForTask(rootDir, task, name) {
        const basename = `${util_1.padZero(task.i, this.tasks.length)}-${task.task.name}-${name.toLowerCase()}`;
        const path = path_1.normalize(path_1.join(rootDir, basename));
        util_1.mkdirpSync(path);
        return path;
    }
}
class TaskInstance {
    constructor(task, deps, i) {
        this.task = task;
        this.deps = deps;
        this.i = i;
        this.state = "WAITING";
    }
    isWaiting() { return this.state === "WAITING"; }
    isRunning() { return this.state === "PENDING"; }
    isError() { return this.state === "REJECTED"; }
    isNotChanged() { return this.state === "NOCHANGE"; }
    isDone() { return this.state === "RESOLVED" || this.state === "REJECTED" || this.state === "NOCHANGE"; }
    isReady() { return this.deps.every(o => o.isDone()) || this.deps.some(o => o.isError()); }
    run(args) {
        return util_1.captureOutputStreams(async () => {
            const start = perf_hooks_1.performance.now();
            try {
                const res = await this.task.build(args);
                const time = perf_hooks_1.performance.now() - start;
                return { res, ok: true, time };
            }
            catch (e) {
                console.error(e);
                const time = perf_hooks_1.performance.now() - start;
                return { ok: false, time };
            }
        });
    }
}
function taskReporter(node, execResult, duration_ms = 0, outputs) {
    const color = (() => {
        switch (execResult) {
            case "OK": return "\u001b[32m";
            case "ERR": return "\u001b[31m";
            case "SKIPPED": return "\u001b[33m";
            case "ERR_SKIPPED": return "\u001b[33m";
            default: util_1.never(execResult);
        }
    })();
    const status = (() => {
        switch (execResult) {
            case "OK": return "done";
            case "ERR": return "error";
            case "SKIPPED": return "skipped";
            case "ERR_SKIPPED": return "skipped (due to error)";
            default: util_1.never(execResult);
        }
    })();
    const header = `\u001b[m${color}\u001b[1m[ ${node.task.displayName} ]\u001b[m`;
    console.log(`${header} ${(duration_ms / 1000).toFixed(3)}s ${status}`);
    if (outputs)
        outputs.output();
}
function task(opts) {
    return { displayName: opts.name, volatile: false, ...opts };
}
function easyTask(name, config, opts) {
    var _a;
    const build = easyBuild(config.build);
    return { name, displayName: (_a = opts === null || opts === void 0 ? void 0 : opts.displayName) !== null && _a !== void 0 ? _a : name, volatile: false, ...config, build };
}
const buildDirContext = new util_1.PropContext();
exports.buildDirPlaceholders = util_1.makeGetter(name => buildDirContext.getPlaceholder(name));
function easyBuild(fn) {
    return async ({ inDirs, getDir }) => {
        var _a;
        let hasOutDir = false;
        let hasGetInDirsCalled = false;
        let usedInDirs = [];
        // const raw: EasyBuildArgs["raw"] = { console: new Console(stdout, stderr), stdout, stderr };
        const getInDirs = () => { hasGetInDirsCalled = true; return inDirs; };
        const getValidInDirs = () => util_1.filterUndefined(getInDirs());
        const getOutDir = () => { hasOutDir = true; return getDir("out"); };
        const getCacheDir = (name) => getDir(name ? `cache-${name}` : "cache");
        const dirGetter = name => {
            if (name === "o")
                return getOutDir();
            if (name.startsWith("i")) {
                const i = parseInt(name.substr(1), 10);
                if (isNaN(i))
                    util_1.invalid();
                const path = inDirs[i];
                if (typeof path !== "string")
                    util_1.invalid();
                usedInDirs.push(i);
                return path;
            }
            if (name.startsWith("c")) {
                return getCacheDir(name.substr(1));
            }
            util_1.invalid();
        };
        const dir = util_1.makeGetter(dirGetter);
        const result = await buildDirContext.run(dirGetter, () => fn({ getInDirs, getValidInDirs, getOutDir, getCacheDir, dir }));
        if (!hasGetInDirsCalled && util_1.uniq(usedInDirs).length !== inDirs.filter(o => typeof o === "string").length) {
            console.warn("some inDirs were not used");
        }
        const outDir = hasOutDir ? getOutDir() : undefined;
        const notChanged = (_a = result.notChanged) !== null && _a !== void 0 ? _a : false;
        return { outDir, notChanged };
    };
}
//#endregion
//#region Impl of Tasks
function src(path, opts) {
    var _a;
    return task({
        name: "src",
        displayName: (_a = opts === null || opts === void 0 ? void 0 : opts.displayName) !== null && _a !== void 0 ? _a : `src (${path_1.relative(process_1.cwd(), path)})`,
        volatile: true,
        build: async () => ({ notChanged: false, outDir: path_1.normalize(path) }),
        watch: async (cb) => { chokidar.watch(path_1.normalize(path), { disableGlobbing: true, ignoreInitial: true }).on("all", () => cb()); },
    });
}
exports.src = src;
function dest(path, opts) {
    return easyTask("dest", {
        displayName: `dest (${path_1.relative(process_1.cwd(), path)})`,
        async clear() {
            await util_1.mkdirp(path);
            await util_1.clearDir(path);
        },
        async build({ getValidInDirs }) {
            await util_1.mkdirp(path);
            await util_1.clearDir(path);
            await Promise.all(getValidInDirs().map(o => util_1.cp(o, path)));
            return {};
        },
    }, opts);
}
exports.dest = dest;
function cache(opts) {
    return easyTask("cache", {
        async build({ dir: { i0, o } }) {
            const notChanged = await util_1.isSameFS(i0, o); // TODO: what happens if inDirs[0] is modified while isSameFS is running?
            if (!notChanged) {
                await util_1.clearDir(o);
                await util_1.cp(i0, o);
            }
            return { notChanged };
        }
    }, opts);
}
exports.cache = cache;
function merge(opts) {
    return easyTask("merge", {
        async build({ getInDirs, getOutDir }) {
            const inDirs = getInDirs(), o = getOutDir();
            const pairs = opts === null || opts === void 0 ? void 0 : opts.pairs;
            if (pairs && pairs.length !== inDirs.length)
                util_1.invalid();
            if (!util_1.isStringArray(inDirs))
                util_1.invalid();
            await util_1.clearDir(o);
            if (!pairs)
                await Promise.all(inDirs.map(i => util_1.cp(i, o)));
            else
                await Promise.all(inDirs.map((inDir, i) => { var _a, _b; return util_1.cp(path_1.join(inDir, (_a = pairs[i].from) !== null && _a !== void 0 ? _a : ""), path_1.join(o, (_b = pairs[i].to) !== null && _b !== void 0 ? _b : "")); }));
            return {};
        }
    }, opts);
}
exports.merge = merge;
function filterFiles(pattern, opts) {
    return easyTask("filterFiles", {
        async build({ dir: { i0, o } }) {
            await util_1.clearDir(o);
            const paths = await new Promise((res, rej) => glob(pattern, { cwd: i0, nodir: true, nomount: true }, (err, o) => err ? rej(err) : res(o)));
            await Promise.all(paths.map(i => util_1.cp(path_1.join(i0, i), path_1.join(o, i))));
            return {};
        }
    }, opts); // TODO: filter directories
}
exports.filterFiles = filterFiles;
function browserSync(opts) {
    let bs; // assumption: `watch` only be called once at most
    return easyTask("browserSync", {
        watch: async () => { bs = BS.create(); },
        async build({ dir: { i0 } }) {
            if (bs) {
                if (!bs.active) {
                    await new Promise((res, rej) => bs.init({ server: i0, ...opts }, err => err ? rej(err) : res()));
                }
                bs.reload();
            }
            return { notChanged: true };
        },
    }, opts);
}
exports.browserSync = browserSync;
//#endregion
//#region Impl of Highly Configurable Tasks (also related to `buildDirContext`)
/** placeholders will be resolved using `buildDirContext` */
function path(literals, ...placeholders) {
    let paths = [];
    for (let i = 0; i < literals.length; i++) {
        paths.push(literals[i]);
        const ph = placeholders[i];
        if (typeof ph === "string") {
            paths.push(ph);
        }
        else if (typeof ph === "function") {
            paths.push(buildDirContext.resolvePlaceholder(ph));
        }
        else if (ph) {
            paths.push(...ph);
        }
    }
    return path_1.resolve(path_1.join(...paths));
}
exports.path = path;
/** @param build use `buildDirPlaceholder` to get directories */
function customBuild(build, opts) {
    return easyTask("customBuild", { volatile: opts === null || opts === void 0 ? void 0 : opts.volatile, build: () => build().then(() => ({})) }, opts);
}
exports.customBuild = customBuild;
/** placeholders will be resolved using `buildDirContext` */
function cmdParser(literals, ...placeholders) {
    let parts = [];
    let wasPlaceholder = false, joinNext = false;
    for (let i = 0; i < literals.length; i++) {
        let l = literals[i], ls = l.trim().split(" ");
        if (l === l.trimLeft() && i !== 0) {
            if (!wasPlaceholder)
                util_1.invalid();
            const last = parts.length - 1;
            parts[last] = path_1.join(parts[last], ls[0]);
            ls.shift();
        }
        wasPlaceholder = false;
        joinNext = l === l.trimRight();
        parts.push(...ls);
        const ph = placeholders[i];
        if (typeof ph === "function") {
            if (joinNext) {
                const last = parts.length - 1;
                // parts[last] = join(parts[last], buildDirContext.resolvePlaceholder(ph));
                parts[last] = path_1.join(parts[last], ph());
            }
            else {
                // parts.push(buildDirContext.resolvePlaceholder(ph));
                parts.push(ph());
            }
            wasPlaceholder = true;
        }
        else {
            if (joinNext && typeof ph !== "undefined")
                util_1.invalid();
            if (typeof ph === "string") {
                parts.push(ph);
            }
            else if (ph) {
                parts.push(...ph);
            }
        }
    }
    return parts;
}
/** placeholders will be resolved using `buildDirContext` */
function exec(opts = {}) {
    return (literals, ...placeholders) => easyTask("exec", {
        volatile: opts.volatile,
        displayName: `exec (${literals[0].split(" ")[0]})`,
        async build(args) {
            const parts = cmdParser(literals, ...placeholders);
            if (opts.persistentOutput !== true)
                await util_1.clearDir(args.getOutDir());
            const cp = await child_process_1.spawn(parts[0], parts.slice(1), { windowsHide: true });
            cp.stdout.on("data", data => process.stdout.write(data));
            cp.stderr.on("data", data => process.stderr.write(data));
            try {
                await new Promise((res, rej) => cp.on("close", code => code === 0 ? res() : rej(`exit with code ${code} `)));
            }
            catch (e) {
                if (opts.neverFails === true)
                    console.error(e);
                else
                    throw e;
            }
            return {};
        }
    }, opts);
}
exports.exec = exec;
//#endregion
