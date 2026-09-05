# gear-ts

**時間を進める機械。** berylx の program を、中断して再開できて、後から何が起きたか
説明できる形で走らせる。

作用はデータであり、journal だけが真である。

Ruby 実装 [`minamorl/gear`](https://github.com/minamorl/gear) の TypeScript 移植。
`prohibitions.pin@1.1` 面 C による Ruby 廃止を受けて移した。**移植であって作り直しではない。**

## 五点セット

中核はこの五つだけで、これ以外を中核に増やさない。

| | |
|---|---|
| **Clock** | 効果ひとつにつき 1 tick 進む離散した時間。乱数は tick に紐づく seed から取るので、実時刻もプロセス由来の乱数も走行に混ざらない。 |
| **Admission** | 全ての副作用の手前に立つゲート。拒否は例外ではなく検査できる値として返る。判定基準は policy として差し替える。 |
| **Executor** | berylx の program を darkcore の Effect 木として走らせる本体。予算 (`maxEffects`) で任意の一歩手前まで走らせて中断し、その journal を渡して再開できる。 |
| **Journal** | 状態の正本。追記しかしない。現在状態はその畳み込みとして得る。記録済みの外界結果は再実行せず読み戻す。 |
| **Receipt** | 実行された効果に必ず出る根拠。「何が起きたか」と「何が許可したか」を持ち、先行 receipt を指して鎖になる。 |

## 層

```
darkcore = 作用の共通語彙 (単一 tagged effect)     -> berylx-ts が内包する
berylx   = 接続の文法 (Task : Lay -> Result[Lay])  -> github:minamorl/berylx-ts
gear     = 時間を進める機械                         -> ここ
```

## 使う

外界は port adapter を通してしか触れない。素の Task は実行機に乗らない。
権限は policy が覗くフィールドではなく、program へ渡す物 (Kit) として運ぶ。

```js
import { Task } from '@minamorl/berylx';
import { z } from 'zod';
import {
  Machine, PortAdapter, PortRegistry, ProgramRegistry, Kit,
  PROGRAM_SUBMIT_TAG, projectView,
} from '@minamorl/gear';

// 1. 外界は port adapter を通る。境界の形は zod schema で名乗る。
const GREET_TAG = 'greet_upcase';
const ports = new PortRegistry();
ports.register(
  new PortAdapter('greet').operation(
    GREET_TAG,
    z.object({ name: z.string() }),
    z.object({ shout: z.string() }),
    ({ name }) => ({ shout: `HELLO, ${name.toUpperCase()}` }),
  ),
);

// 2. 素の Task は実行機に乗らない。名前と入出力を名乗って登録する。
const programs = new ProgramRegistry().register({
  name: 'greet',
  task: Task.of('greet', (lay, io) =>
    lay.put('shout', io.perform(GREET_TAG, { name: lay.at('name').fetch() }).shout)),
  input: z.object({ name: z.string() }).describe('GreetIn'),
  output: z.object({ shout: z.string() }).describe('GreetOut'),
});

// 3. 渡していない port も program も呼べない。迂回は policy の書き漏れでなく構造で塞がる。
const kit = Kit.of({ ports: [GREET_TAG, PROGRAM_SUBMIT_TAG], programs: ['greet'], depth: 1 });

const machine = new Machine({ programs, ports });
machine.submit({ name: 'greet', focus: { name: 'yui' }, kit });
const [done] = await machine.drain();

console.log(done.produced);                                 // { name: 'yui', shout: 'HELLO, YUI' }
console.log(done.outcome.receipts.length);                  // 2
console.log(projectView(done.outcome.journal).toJSON());
```

最後の行が出す journal の眺め:

```json
{
  "last_tick": 2,
  "effects": [{ "tick": 2, "port": "greet_upcase" }],
  "denials": [],
  "receipts": [
    { "tick": 2, "id": "908b6751a149700e", "tag": "greet_upcase", "predecessor": null },
    { "tick": 1, "id": "34b1f866cc456663", "tag": "program_submit", "predecessor": "908b6751a149700e" }
  ]
}
```

`Kit.of({ ports: [], programs: [], depth: 0 })` を渡すと同じ program は走らない。
`produced` は `null`、`receipts` は空、`denials` に拒否した tick と理由が 1 件残る。
拒否も走行の記録であって、握り潰される失敗ではない。

`Machine` は呼ばれた分だけ進む。内側に実時刻を待つ loop を持たないので、暗黙の実時間が
走行へ混ざらない。実時間で起こすのは埋め込む側の仕事である。

## 入れる

npm には未公開なので git 依存で参照する。

```json
"dependencies": {
  "@minamorl/gear": "github:minamorl/gear-ts"
}
```

`@minamorl/berylx` も同様に git 依存で参照している。npm 公開版は 0.2.0 のままで、
gear が要る `ControlSignal` / `Perform` / `effectful()` を含まないため。

Node 20 以上。

## 開発

```bash
pnpm install
pnpm run check   # build + typecheck + test
```

## 常駐

FIFO host を `dist/bin/host.js` に持つ。核へ外から到達する経路は作らないので、
HTTP は listen しない。配備手順は `deploy/README.md`。

## 正本

コードと spec が食い違ったら spec が勝つ。spec は別リポジトリ `spec-system` の
`pins/domains/gear.spec` にあり、この repo には含まれない。

## License

MIT
