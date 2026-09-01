# gear-ts

時間を進める機械。Clock / Admission / Executor / Journal / Receipt。
作用はデータであり、journal だけが真である。

Ruby 実装 [`minamorl/gear`](https://github.com/minamorl/gear) の TypeScript 移植。
Ruby の廃止 (`prohibitions.pin@1.1` 面 C) を受けて移した。**移植であって作り直しではない。**

正本は spec-system の pin である。コードと spec が食い違ったら spec が勝つ。

- `pins/domains/gear.spec`

## 由来

2026-08-25 に `ore-ts` workspace として berylx / gear / corundum を同居させたが、
berylx は既に `berylx-ts` として独立しており、workspace が berylx を subtree で
抱えたことで**二重管理と双方向の分岐**が発生した。
御主人様 2026-09-02 の判断で workspace を解体し、層ごとに独立 repo へ戻す。
gear の履歴は `git subtree split` で保存されている。

## 層

```
berylx  = 接続の文法 (Task : S -> Outcome<S>)  -> github:minamorl/berylx-ts
gear    = 時間を進める機械                      -> ここ
```

`@minamorl/berylx` は npm 公開版 0.2.0 に `ControlSignal` / `Perform` /
`effectful()` が無いため、当面 git 依存で参照する。

## 開発

```bash
pnpm install
pnpm run check   # build + typecheck + test
```

## 常駐

FIFO host を `dist/bin/host.js` に持つ。配備は `deploy/README.md`。
