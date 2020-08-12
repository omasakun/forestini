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

## 予め用意されているタスク (構想段階でのバージョン)

- `src` : 外部のフォルダーからファイルツリーをコピー
- `dest` : 外部のフォルダーにファイルツリーをコピー
- `copy` : 一つ以上のファイルツリーから条件に合うファイルをコピー
- `cache` : ファイルツリーに変更が無い時に以降の処理を行わない
- `exec` : 外部プログラムを呼び出し
- `browserSync` : ファイルツリーを BrowserSync のローカルサーバーでサーブ

## 使用例 (構想段階でのバージョン)

```typescript
import { Forestini, exec, cmd } from "./forestini";
import { join } from "path";
const fo = new Forestini({ tmpRoot: ".tmp" });

// complex task configs can be defined separately
const tsc = exec(({ i, o, c }) => [
  // cmd: space-separated text -> array of text
  ...cmd`tsc ${join(i!, "index.ts")} --rootDir ${i!} --outDir ${o!}`,
  ...cmd`--incremental --tsBuildInfoFile ${join(c!, ".tsbuildinfo")} --pretty`],
  { persistentOutput: true });

const source = fo
  .src("src");

const scripts = source
  .copy({ map: [{ filter: /^.*\.tsx?$/ }], name: "copy (scripts)" })
  .cache("cache (scripts)") // if files are unchanged, `tsc` will not be executed
  .then(tsc);

const assets = source
  .copy({ map: [{ filter: file => ! /^.*\.tsx?$/.test(file) }], name: "copy (assets)" });

const compiled = fo
  .copy([scripts, assets], { name: "copy (dest)" }); // merge

compiled.dest("dest");
compiled.browserSync({
  config: {
    logPrefix: "BS",
    open: false,
    port: 8137,
    ui: { port: 8138 },
    logFileChanges: false,
    https: false,
    notify: false,
    reloadOnRestart: true,
  } // my favorite configs
});

// because the tasks are executed in parallel,
// the output of `echo` will be shown before the output of `dest`
compiled.exec("echo finished! compiled files & dirs @ [in]"); // short style

fo.freeze() // freeze the task dependency graph
  .watch(); // no additional configs for watch is required
```

## License

Copyright (C) 2020 [omasakun](https://github.com/omasakun)

Licensed under the [MIT](LICENSE).
