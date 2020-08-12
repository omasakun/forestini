"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmd = exports.disposable = exports.browserSync = exports.cache = exports.copy = exports.exec = exports.dest = exports.src = exports.Forestini = void 0;
const BS = require("browser-sync");
const child_process_1 = require("child_process");
const chokidar = require("chokidar");
const console_1 = require("console");
const fs_1 = require("fs");
const ncpBase = require("ncp");
const os_1 = require("os");
const path_1 = require("path");
const perf_hooks_1 = require("perf_hooks");
const process_1 = require("process");
const rimrafSource = require("rimraf");
const stream_1 = require("stream");
const { mkdir, mkdtemp, readdir, readFile, stat } = fs_1.promises;
// #region core
class Forestini {
    constructor(opts = {}) {
        var _a, _b;
        this.frozen = false;
        this.running = false;
        this.taskNodes = [];
        this.tmpRoot = (_a = opts.tmpRoot) !== null && _a !== void 0 ? _a : path_1.join(os_1.tmpdir(), "forestini");
        this.watchDebounce = (_b = opts.debounce) !== null && _b !== void 0 ? _b : 100;
    }
    task(deps, task) {
        this.assertNotFrozen();
        if (!this.isRegisteredTaskNodes(deps)) {
            throw new Error("Illegal dependencies");
        }
        if (this.isRegisteredTask(task)) {
            throw new Error("Same task cannot be used more than once");
        }
        const node = new InternalTaskNode(this, task, deps);
        this.taskNodes.push(node);
        return node;
    }
    freeze() {
        this.assertNotFrozen();
        //   verify that taskNodes are topologically sorted
        // & verify that taskNodes have no circular dependencies
        if (!this.taskNodes.every((o, i) => o.deps.every(oo => this.node2index(oo) < i))) {
            throw new Error("BUG"); // this will never happen unless there's a bug
        }
        this.frozen = true;
        return this;
    }
    dotGraph() {
        this.assertFrozen();
        const escape = name => name.replace(/"/g, '\\"'); // TODO: better escaping
        // According to graphviz.org, layout engines may apply additional escape sequences.
        const lines = [
            "strict digraph {",
            ...this.taskNodes.map((o, i) => `\tnode_${i}[label="${escape(o.task.displayName)}"];`),
            ...this.taskNodes.flatMap((o, i) => o.deps.map(o => `\tnode_${this.node2index(o)} -> node_${i};`)),
            "}"
        ];
        return lines.join("\n");
    }
    async clearDest() {
        this.assertFrozen();
        this.assertNotRunning();
        this.running = true;
        await Promise.all(this.taskNodes.map(o => { var _a, _b; return (_b = (_a = o.task).clearDest) === null || _b === void 0 ? void 0 : _b.call(_a); }));
        this.running = false;
    }
    async build() {
        this.assertFrozen();
        this.assertNotRunning();
        this.running = true;
        console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${date()}`);
        const disposable = await this.prepareTaskNodes();
        await this.runTaskNodes(taskNodeReporter);
        await disposable.dispose();
        console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${date()}`);
        // this.taskNodes.forEach(o => console.log(o.task.name + ": " + o.state));
        this.running = false;
    }
    async watch() {
        this.assertFrozen();
        this.assertNotRunning();
        this.running = true;
        const disposable = await this.prepareTaskNodes();
        let isBuilding = false;
        let updatedNodes = [];
        let rebuild = debounce(async () => {
            if (isBuilding)
                return; // execution continues from (1) below
            isBuilding = true;
            if (updatedNodes.length !== 0) { // if it's not the first run
                // console.clear();
                process.stdout.write('\u001bc');
            }
            console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${date()}`);
            this.makeDependentsWaiting(updatedNodes);
            updatedNodes = [];
            await this.runTaskNodes(taskNodeReporter);
            console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${date()}`);
            // this.taskNodes.forEach(o => console.log(o.task.name + ": " + o.state));
            isBuilding = false;
            if (updatedNodes.length !== 0)
                await rebuild(); // (1)
        }, this.watchDebounce);
        await this.beginWatching(taskNode => {
            updatedNodes.push(taskNode);
            rebuild();
        });
        ["exit", "SIGINT", "SIGTERM"].forEach(type => {
            process.on(type, () => {
                // console.log(type);
                disposable.dispose();
                if (type !== "exit")
                    process.exit(1);
            });
        });
        rebuild();
        // this.running = false; // watch task is continuing
    }
    async prepareTaskNodes() {
        this.assertFrozen();
        await mkdir(this.tmpRoot, { recursive: true });
        const rootDir = await mkdtemp(path_1.normalize(this.tmpRoot) + path_1.sep);
        const promises = [];
        const taskCount = this.taskNodes.length;
        this.taskNodes.forEach((o, i) => {
            const { task } = o;
            const dir = o => path_1.join(rootDir, `${padZero(i, taskCount)}-${task.name}-${o}`);
            const inDirs = o.deps.map(o => o.outDir); // assumption: taskNodes are topologically sorted
            if (!isStrings(inDirs))
                throw new Error("The task does not have output");
            o.state = "WAITING";
            o.inDirs = inDirs;
            o.outDir = task.hasOutput ? dir("out") : undefined;
            o.cacheDir = task.needsCache ? dir("cache") : undefined;
            if (o.outDir)
                promises.push(mkdir(o.outDir));
            if (o.cacheDir)
                promises.push(mkdir(o.cacheDir));
        });
        await Promise.all(promises);
        return {
            disposeAsync: () => rimraf(rootDir),
            dispose: () => rimrafSync(rootDir),
        };
    }
    async runTaskNodes(reporter) {
        this.assertFrozen();
        const isFinished = this.taskNodes.every(o => o.state === "REJECTED" || o.state === "RESOLVED" || o.state === "NOCHANGE");
        if (isFinished)
            return;
        const promises = [];
        this.taskNodes.forEach(o => {
            if (o.state !== "WAITING")
                return;
            if (o.deps.some(o => o.state === "REJECTED")) {
                o.state = "REJECTED";
                reporter(o, [], 0, "ERR_SKIPPED");
                return;
            }
            if (!o.task.volatile && o.deps.every(o => o.state === "NOCHANGE")) {
                o.state = "NOCHANGE";
                reporter(o, [], 0, "SKIPPED");
                return;
            }
            if (o.deps.every(o => o.state === "RESOLVED" || o.state === "NOCHANGE")) {
                o.state = "PENDING";
                const { inDirs, outDir, cacheDir } = o;
                const streams = new InterleavedStreams();
                const { stdout, stderr } = streams;
                const console = new console_1.Console({ stdout, stderr, colorMode: true });
                const args = { inDirs, outDir, cacheDir, console, stderr, stdout };
                const build = async () => {
                    const startTime = perf_hooks_1.performance.now();
                    if (o.outDir && !o.task.persistentOutput) {
                        await clearDir(o.outDir);
                    }
                    try {
                        const result = await o.task.build(args);
                        if (result.notChanged === true) {
                            o.state = "NOCHANGE";
                        }
                        else {
                            o.state = "RESOLVED";
                        }
                        reporter(o, streams.outputs, perf_hooks_1.performance.now() - startTime, "OK");
                    }
                    catch (e) {
                        o.state = "REJECTED";
                        console.error(e); // console for this task (not global one)
                        reporter(o, streams.outputs, perf_hooks_1.performance.now() - startTime, "ERR");
                    }
                    await this.runTaskNodes(reporter); // note: since promises are asynchronous, stack overflow will not occur
                };
                promises.push(build());
            }
        });
        await Promise.all(promises);
    }
    makeDependentsWaiting(o) {
        this.assertFrozen();
        o.forEach(o => o.state = "WAITING");
        this.taskNodes.forEach(o => {
            if (o.deps.some(o => o.state === "WAITING")) {
                o.state = "WAITING";
            }
        });
    }
    async beginWatching(cb) {
        this.assertFrozen();
        await Promise.all(this.taskNodes.map(o => { var _a, _b; return (_b = (_a = o.task).beginWatching) === null || _b === void 0 ? void 0 : _b.call(_a, o, () => cb(o)); }));
    }
    // #region utility
    assertFrozen() {
        if (!this.frozen)
            throw new Error("The Forestini is not frozen yet");
    }
    assertNotFrozen() {
        if (this.frozen)
            throw new Error("The Forestini is already frozen");
    }
    assertNotRunning() {
        if (this.running)
            throw new Error("The Forestini is already running");
    }
    isRegisteredTask(task) {
        return this.taskNodes.some(o => o.task === task);
    }
    isRegisteredTaskNodes(nodes) {
        return nodes.every(o => this.taskNodes.some(oo => oo === o));
    }
    node2index(node) {
        const i = this.taskNodes.findIndex(oo => node === oo);
        if (i < 0)
            throw new Error("BUG");
        return i;
    }
    // #endregion
    // #region syntax sugar
    src(...args) {
        return this.task([], src(...args));
    }
    dest(deps, ...args) {
        return this.task(deps, dest(...args));
    }
    exec(deps, ...args) {
        return this.task(deps, exec(...args));
    }
    copy(deps, ...args) {
        return this.task(deps, copy(...args));
    }
    cache(deps, ...args) {
        return this.task(deps, cache(...args));
    }
    browserSync(deps, ...args) {
        return this.task(deps, browserSync(...args));
    }
}
exports.Forestini = Forestini;
function taskNodeReporter(node, outputs, duration_ms, status) {
    let color = "";
    if (status === "OK")
        color = "\u001b[32m";
    else if (status === "ERR_SKIPPED" || status === "SKIPPED")
        color = "\u001b[33m";
    else if (status === "ERR")
        color = "\u001b[31m";
    else {
        const o = status;
    }
    let header = `\u001b[m${color}\u001b[1m[ ${node.task.displayName} ]\u001b[m`;
    let out = outputs.filter(o => o.source === "out").join("");
    let err = outputs.filter(o => o.source === "err").join("");
    const statusText = execResultText(status);
    console.log(`${header} ${(duration_ms / 1000).toFixed(3)}s ${statusText}`);
    // if (err !== "") process.stderr.write(header+"\n");
    outputs.forEach(o => {
        if (o.source === "out") {
            process.stdout.write(o.text);
            return;
        }
        if (o.source === "err") {
            process.stderr.write(o.text);
            return;
        }
        throw new Error("BUG");
    });
    if (out !== "" && !out.endsWith("\n"))
        process.stdout.write("\n");
    if (err !== "" && !err.endsWith("\n"))
        process.stderr.write("\n");
}
function execResultText(result) {
    if (result === "ERR")
        return "error";
    if (result === "ERR_SKIPPED")
        return "skipped (due to error)";
    if (result === "SKIPPED")
        return "skipped";
    if (result === "OK")
        return "done";
    const o = result;
    return result;
}
class InternalTaskNode {
    constructor(fo, task, deps) {
        this.fo = fo;
        this.task = task;
        this.deps = deps;
        this.state = "WAITING";
        this.inDirs = [];
    }
    // #region syntax sugar
    then(task) {
        return this.fo.task([this], task);
    }
    dest(...args) {
        return this.fo.task([this], dest(...args));
    }
    exec(...args) {
        return this.fo.task([this], exec(...args));
    }
    copy(...args) {
        return this.fo.task([this], copy(...args));
    }
    cache(...args) {
        return this.fo.task([this], cache(...args));
    }
    browserSync(...args) {
        return this.fo.task([this], browserSync(...args));
    }
}
function task(template) {
    const { name, displayName, needsCache, hasOutput, persistentOutput, volatile, beginWatching, build, clearDest } = template;
    return {
        name,
        displayName,
        needsCache: needsCache !== null && needsCache !== void 0 ? needsCache : false,
        hasOutput: hasOutput !== null && hasOutput !== void 0 ? hasOutput : true,
        persistentOutput: persistentOutput !== null && persistentOutput !== void 0 ? persistentOutput : false,
        volatile: volatile !== null && volatile !== void 0 ? volatile : false,
        build: build !== null && build !== void 0 ? build : (() => Promise.resolve({})),
        beginWatching,
        clearDest,
    };
}
// #endregion
// #region task
function src(path, name = `src (${path_1.relative(process_1.cwd(), path)})`) {
    return task({
        name: "src",
        displayName: name,
        volatile: true,
        async beginWatching(args, cb) {
            chokidar.watch(path, {
                disableGlobbing: true,
                ignoreInitial: true,
            }).on("all", () => cb());
        },
        async build({ inDirs, outDir }) {
            if (inDirs.length !== 0)
                throw new Error("invalid");
            if (!outDir)
                throw new Error("BUG");
            await ncp(path, outDir, {
                clobber: false,
                dereference: true,
            }); // TODO: symlink?
            return {};
        },
    });
}
exports.src = src;
function dest(path, name = `dest (${path_1.relative(process_1.cwd(), path)})`) {
    return task({
        name: "dest",
        displayName: name,
        hasOutput: false,
        async clearDest() {
            await clearDir(path);
        },
        async build({ inDirs, console }) {
            // if (inDirs.length === 0) throw new Error("invalid");
            await mkdir(path, { recursive: true });
            await clearDir(path);
            await Promise.all(inDirs.map(inDir => ncp(inDir, path, {
                clobber: false,
                dereference: true,
            })));
            return {};
        },
    });
}
exports.dest = dest;
function exec(cmd, opts = {}) {
    var _a, _b, _c, _d, _e;
    let command;
    if (typeof cmd === "string") {
        command = ({ inDirs, outDir, cacheDir }) => {
            let command = cmd.split(" ");
            if (inDirs.length > 1)
                throw new Error("BUG");
            if (inDirs.length !== 0) {
                command = command.map(o => o !== "[in]" ? o : inDirs[0]);
            }
            if (cacheDir) {
                command = command.map(o => o !== "[cache]" ? o : cacheDir);
            }
            if (outDir) {
                command = command.map(o => o !== "[out]" ? o : outDir);
            }
            return command;
        };
    }
    else {
        command = ({ inDirs, outDir, cacheDir }) => {
            return cmd({
                i: inDirs[0], is: inDirs, inDirs,
                o: outDir, outDir,
                c: cacheDir, cacheDir,
            });
        };
    }
    // TODO: better detection
    const argsBase = { inDirs: ["foo"], cacheDir: "foo", outDir: "foo" };
    const argsIn = { inDirs: ["bar"], cacheDir: "foo", outDir: "foo" };
    const argsCache = { inDirs: ["foo"], cacheDir: "bar", outDir: "foo" };
    const argsOut = { inDirs: ["foo"], cacheDir: "foo", outDir: "bar" };
    return task({
        name: "exec",
        displayName: (_a = opts.name) !== null && _a !== void 0 ? _a : `exec (${command(argsBase)[0]})`,
        hasOutput: (_b = opts.hasOutput) !== null && _b !== void 0 ? _b : command(argsBase).join() !== command(argsOut).join(),
        needsCache: (_c = opts.needsCache) !== null && _c !== void 0 ? _c : command(argsBase).join() !== command(argsCache).join(),
        persistentOutput: (_d = opts.persistentOutput) !== null && _d !== void 0 ? _d : false,
        volatile: (_e = opts.volatile) !== null && _e !== void 0 ? _e : false,
        async build(args) {
            if (opts.verify) {
                if (!opts.verify(args))
                    throw new Error("invalid");
            }
            const cmd = command(args);
            if (cmd.length < 1)
                throw new Error("invalid");
            // args.console.log(cmd);
            const cp = await child_process_1.spawn(cmd[0], cmd.slice(1), {
                windowsHide: true,
                shell: false,
            });
            cp.stdout.on("data", data => args.stdout.write(data));
            cp.stderr.on("data", data => args.stderr.write(data));
            return new Promise((resolve, reject) => {
                cp.on("close", (code) => {
                    if (code !== 0)
                        reject(`exited with code ${code}`);
                    else
                        resolve({});
                });
            });
        },
    });
}
exports.exec = exec;
function copy(opts = {}) {
    var _a;
    return task({
        name: "copy",
        displayName: (_a = opts.name) !== null && _a !== void 0 ? _a : "copy",
        async build({ inDirs, outDir }) {
            // if (inDirs.length === 0) throw new Error("invalid");
            if (!outDir)
                throw new Error("BUG");
            const map = opts.map;
            if (map && map.length !== inDirs.length)
                throw new Error("invalid");
            await Promise.all(inDirs.map((inDir, i) => {
                var _a, _b, _c;
                let inDirPath = inDir;
                let outDirPath = outDir;
                const from = (_a = map === null || map === void 0 ? void 0 : map[i]) === null || _a === void 0 ? void 0 : _a.from;
                const to = (_b = map === null || map === void 0 ? void 0 : map[i]) === null || _b === void 0 ? void 0 : _b.to;
                const filter = (_c = map === null || map === void 0 ? void 0 : map[i]) === null || _c === void 0 ? void 0 : _c.filter;
                if (from)
                    inDirPath = path_1.join(inDirPath, from);
                if (to)
                    outDirPath = path_1.join(outDirPath, to);
                return ncp(inDirPath, outDirPath, {
                    clobber: false,
                    dereference: true,
                    filter: filter === undefined ? undefined : path => {
                        if (fs_1.statSync(path).isDirectory()) {
                            return true;
                        }
                        else {
                            if (typeof filter === "function") {
                                return filter(path);
                            }
                            else {
                                return filter.test(path);
                            }
                        }
                    },
                });
            }));
            return {};
        },
    });
}
exports.copy = copy;
function cache(name) {
    return task({
        name: "cache",
        displayName: name !== null && name !== void 0 ? name : "cache",
        persistentOutput: true,
        async build({ inDirs, outDir }) {
            if (inDirs.length !== 1)
                throw new Error("invalid");
            if (!outDir)
                throw new Error("BUG");
            const notChanged = await isSameFS(inDirs[0], outDir); // TODO: what happens if inDirs[0] is modified while isSameFS is running?
            if (!notChanged) {
                await clearDir(outDir);
                await ncp(inDirs[0], outDir, { clobber: false });
            }
            return { notChanged };
        },
    });
}
exports.cache = cache;
function browserSync(opts = {}) {
    var _a;
    let bs;
    let path;
    return task({
        name: "browserSync",
        displayName: (_a = opts.name) !== null && _a !== void 0 ? _a : "browserSync",
        hasOutput: false,
        beginWatching({ inDirs }, cb) {
            if (inDirs.length !== 1)
                throw new Error("invalid");
            path = inDirs[0];
            bs = BS.create();
            return new Promise((res, rej) => bs.init({
                server: inDirs[0],
                ...opts.config,
            }, err => {
                if (err)
                    rej(err);
                else
                    res();
            }));
        },
        async build({ inDirs }) {
            if (!bs)
                return {};
            if (inDirs[0] !== path)
                throw new Error("BUG");
            bs.reload();
            return {};
        },
    });
}
exports.browserSync = browserSync;
// TODO: ファイルツリー内のファイル数に応じてタスクグラフを動的に追加するとかは、複数のエントリーポイントがあるJSファイルをコンパイルするときにエントリーポイントをわざわざ列挙する手間が省けたりするから有用かも。各部分タスクの入力ファイルツリーと出力ファイルツリーをキャッシュする独自の機構を備えていて、タスクの実行時に内部でForestiniインスタンスを作ってそれにビルドさせる感じのタスクで、ファイルツリーを受け取ってビルドタスクチェーンの配列を返す関数(F)を受け取るタスクを作るのが、今の設計を維持したままで実現する簡単な方法。問題点があるとするなら、dotGraphが全体像を表示できなくなることくらいかな？まぁ、動的に追加される部分があるグラフを表示するいい方法が思いつかないからこれでもいい気はする。まぁ、(F)のドメインを制限すれば行けるだろうけど不自由になる
// #endregion
// #region utility
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
}
function disposable(dispose) {
    return { dispose };
}
exports.disposable = disposable;
function padZero(num, max) {
    const digits = max.toFixed(0).length;
    return num.toFixed(0).padStart(digits, "0");
}
function isStrings(arr) {
    return Array.isArray(arr) && arr.every(o => typeof o === "string");
}
function date() {
    return new Date().toISOString();
}
function debounce(fn, delay) {
    let timeout;
    return () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            fn();
        }, delay);
    };
}
function rimraf(path, options = { disableGlob: true }) {
    return new Promise((resolve, rejected) => {
        rimrafSource(path, options, err => {
            if (err)
                rejected(err);
            else
                resolve();
        });
    });
}
function rimrafSync(path, options = { disableGlob: true }) {
    rimrafSource.sync(path, options);
}
function ncp(src, dest, opts = {}) {
    return new Promise((res, rej) => ncpBase.ncp(src, dest, opts, err => {
        if (err)
            rej(err);
        else
            res();
    }));
}
async function clearDir(dir) {
    // console.error("clear: ", dir);
    try {
        const files = await readdir(dir);
        await Promise.all(files.map(file => rimraf(path_1.join(dir, file), { disableGlob: true })));
    }
    catch (e) {
        if (e.code === "ENOENT")
            return; // TODO: better error handling
    }
    // await rimraf(dir, { disableGlob: true });
    // await mkdir(dir);
    // TODO: `rm -rf dir/*` != `rm -r dir && mkdir dir`
}
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
            if (files1.length === 0)
                return true;
            const [sorted1, sorted2] = [files1.sort(), files2.sort()];
            if (sorted1.some((o1, i) => o1 !== sorted2[i]))
                return false;
            const checkers = sorted1.map((o1, i) => isSameFS(path_1.join(entry1, o1), path_1.join(entry2, sorted2[i])));
            let remaining = checkers.length;
            return await new Promise(res => {
                checkers.forEach(o => o.then(result => {
                    remaining--;
                    if (!result)
                        res(false);
                    else if (remaining === 0)
                        res(true);
                }));
            });
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
function cmd(literals, ...placeholders) {
    let result = [];
    for (let i = 0; i < literals.length; i++) {
        const o = literals[i].split(" ");
        if (o[0] === "")
            o.shift();
        if (o[o.length - 1] === "")
            o.pop();
        if (o.some(o => o === ""))
            throw new Error("invalid");
        result.push(...o);
        const ph = placeholders[i];
        if (typeof ph === "string") {
            result.push(ph);
        }
        else if (ph) {
            result.push(...ph);
        }
    }
    return result;
}
exports.cmd = cmd;
// #endregion
