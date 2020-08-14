# Forestini - The Simple Asset Pipeline

予め設定した手順に従ってファイルツリーを変換していくプログラムです。Grunt, Gulp, Broccoli のような類のものです。

当初は、[Typing Tutor](https://github.com/omasakun/typing-tutor) をビルドする目的で作られました。

## 解決する従来の問題

- コンパイラーやオプティマイザー毎にタスクランナー専用のプラグインを用意しないといけない (Gulp, Broccoli, ...)
- 複雑なパイプラインを書きにくい (npm-scripts, shell script, ...)
- ボイラープレートが多い (即席自作タスクランナー)
- 依存関係が増えすぎて心配事が増える (Gulp, Webpack, ...)
- ファイル更新があった時に実行すべきタスクを手動で書くのがだるい (Gulp, ...)

## 特徴

- TypeScript 製なので、型定義のおかげでエディターの自動補完を有効活用できる  
  理由: TypeScript に触れすぎて、型定義なしでは安心して夜も眠れなくなったから。

- タスクの実行順序ではなく、タスク間のファイル受け渡しの有向グラフを指定する  
  理由: 並列実行可能かどうかを見極めたり実行順序を決めたりするのは機械的な作業だから。

- タスク間でのファイルの受け渡しに生のファイルシステムを使う (Broccoli 似)  
  理由: 標準対応していないコンパイラーはないだろうと言えるほどに普遍的なインターフェースだから。

- タスクの呼び出しに CLI を使う (npm-scripts 似)  
  理由: 標準対応していないコンパイラーはないだろうと言えるほどに普遍的なインターフェースだから。

- どうしても速さやカスタマイズ性が足りないときは、JS API を使う  
  理由: 自明。

- 並列して実行できるタスクは並列して実行する  
  理由: すごそうだから。容易にできるから。

- タスクの実行前後でタスクの出力が同じ時、例外を除きそれ以降のタスクは実行しない  
  理由: 容易にできて、ビルドが速くなるから。

- Promise チェーンのように簡潔にタスク間でのファイルの流れを記述できる (Gulp 似)  
  理由: 勝手にビルド方法が決定されてしまうような不透明さを避けつつも可読性を維持するため。

- 標準では差分だけビルドするような高速化はされないので、 **最速タスクランナーではない**  
  理由: タスク定義の単純さを重視しているため。コンパイラーが差分ビルドに標準対応していたり最適化するためのコードを手動で書いたりすれば高速化できます。

- タスク毎にログ出力がまとめてなされる  
  理由: タスクが並列して実行されるため、直接垂れ流すと複数タスクの出力が混ざってしまうから。

## 補足とか

ディスクへのファイルの書き込みが気になるときは、Linux では tmpfs を使うなどするとメモリ上で完結してくれて安心感が増します。

ですが、このプログラムは速さよりもタスク定義やコンパイラー呼び出しの単純さを重視して作られているため、本当にビルドの速さが求められている場面では Gulp のような他のタスクランナーのほうが適しているのではないかとも思います。

## 使用方法

下の使用例のコードを見たり、Forestini の短いソースコードを読んだり、型定義と入力補完に身を任せたりしていい感じに使ってください。

別の言葉で言うと、十分な時間が取れなかったため使用方法を説明する文書は用意できませんでした。

## 予め用意されているタスク

- `src` : 外部のフォルダーからファイルツリーをコピー
- `dest` : 外部のフォルダーにファイルツリーをコピー
- `cache` : ファイルツリーに変更が無い時に以降の処理を行わない
- `merge` : 一つ以上のファイルツリーをマージ
- `filterFiles` : 指定した Glob を満たすファイルだけをコピー
- `browserSync` : ファイルツリーを BrowserSync のローカルサーバーでサーブ
- `customBuild` : 非同期関数から簡単にタスクを作成
- `exec` : 外部プログラムを呼び出し

## 使用例

`scripts/build.ts`
```typescript
import { notify } from "node-notifier";
import { buildDirPlaceholders, Builder as Forestini, exec, filterFiles } from "./forestini";

const fo = new Forestini({ tmpDir: ".tmp" });
const { i0, o, c } = buildDirPlaceholders; // i0: inputDir[0] / o: outputDir / c: cacheDir
const isProd = process.argv.some(o => o === "--prod");

// complex task configs can be defined separately
const tsc = exec({ persistentOutput: true, displayName: "tsc" })
  `tsc ${i0}/index.ts --rootDir ${i0} --outDir ${o} --incremental --tsBuildInfoFile ${c}/.tsbuildinfo --pretty`;

const source = fo.src("src"); // read from `./src`

const scripts = source
  .filterFiles("**/@(*.ts|*.tsx)")
  .cache() // if files are unchanged, `tsc` will not be executed
  .then(tsc)
  .if(isProd, filterFiles("**/!(*.js.map|*.d.ts)")); // execute a task conditionally

const assets = source.filterFiles("**/!(*.ts|*.tsx)");

const compiled = fo.merge([scripts, assets]);

compiled.dest("dest"); // write to `./dest`
compiled.browserSync({
  logPrefix: "BS",
  open: false,
  port: 8137,
  ui: { port: 8138 },
  logFileChanges: false,
  https: false,
  notify: false,
  reloadOnRestart: true,
}); // my favorite configs

// because the tasks are executed in parallel,
// the output of `echo` will be shown before the output of `dest`
compiled.then(exec()`echo compiled files & dirs @ ${i0}`);
compiled.asyncBuild(async () => notify("Compiled!")); // custom task

fo.freeze() // freeze the task dependency graph
  .watch(); // no additional configs for watch is required
```

`package.json`
``` jsonc
{
  "scripts": {
    "build": "ts-node scripts/build.ts"
  },
  "devDependencies": {
    // ...
    "forestini": "github:omasakun/forestini#semver:^2.0.0",
    // ...
  }
  // ...
}
```

Real-World Example: [Typing Tutor](https://github.com/omasakun/typing-tutor) is using Forestini.

## License

Copyright (C) 2020 [omasakun](https://github.com/omasakun)

Licensed under the [MIT](LICENSE).
