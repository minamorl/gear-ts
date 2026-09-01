# Gear の Vultr デプロイ

`deploy-vultr.sh` は Vultr 上の source checkout から exact commit を archive し、同一 filesystem 内で build した immutable release へ `current` symlink を原子的に切り替えます。systemd は user manager を使い、スクリプト内で `sudo` は使いません。

## 前提

- `/home/minamorl/repos/gear-ts` が Git checkout であり、既定デプロイでは `origin/main` を fetch できること。
- `/home/minamorl/repos/gear-ts/.env` が存在し、mode が**正確に `0600`**であること。
- `git`、`tar`、`flock`、user systemd が利用できること。
- `/usr/bin/node` と `/usr/bin/pnpm` が executable であること。
- user service をログアウト後も維持する場合は、管理者が必要に応じて linger を有効化していること。

2026-08-25 の read-only 実測では、Node は `/usr/bin/node` v20.20.2、直接指定した `/usr/bin/pnpm` は v10.33.4 です。事前提示の pnpm 10.8.2 とは異なりますが、現在の直接実測を採用しました。PATH 上の `/home/minamorl/.local/bin/pnpm` v11.21.0 は Node 20 で `ERR_UNKNOWN_BUILTIN_MODULE node:sqlite` になるため、デプロイスクリプトは `/usr/bin/pnpm` を hard-code し、PATH も `/usr/bin` 優先にします。

## 初回セットアップ

Vultr 上で、環境ファイルと user unit を用意します。unit の `EnvironmentFile` は `current/.env` を読みます。この `.env` は各 release から canonical `/home/minamorl/repos/gear-ts/.env` への symlink なので、secret を release 内へコピーしません。

```bash
cd /home/minamorl/repos/gear-ts
chmod 0600 .env
install -d -m 0700 ~/.config/systemd/user
install -m 0644 deploy/gear-host.service ~/.config/systemd/user/gear-host.service
systemctl --user daemon-reload
systemctl --user enable gear-host.service
./deploy/deploy-vultr.sh
```

スクリプトは deploy root、`releases`、`shared` を必要に応じて作ります。スクリプト自身は FIFO を作りません。health check は service 起動後に host が FIFO を作成・提供することを期待しますが、実際の作成と mode は **未実測** です。unit の `UMask=0077` は service が新規作成する filesystem object の permission を制約します。既存の `shared/intake` が FIFO でなければ、安全のためデプロイを拒否します。

## デプロイと更新

既定は最新の `origin/main` です。

```bash
cd /home/minamorl/repos/gear-ts
./deploy/deploy-vultr.sh
```

review 済みの別 ref を指定する場合も、最終的には `git rev-parse` で exact 40-character lowercase commit SHA に解決できる必要があります。

```bash
./deploy/deploy-vultr.sh <reviewed-ref-or-sha>
```

unit ファイル自体を更新した場合は、再配置して user manager を reload してからデプロイします。

```bash
install -m 0644 deploy/gear-host.service ~/.config/systemd/user/gear-host.service
systemctl --user daemon-reload
./deploy/deploy-vultr.sh
```

`.deploy.lock` は nonblocking `flock` で取得します。同時デプロイは待たずに失敗します。release は `git archive`、canonical env symlink、`/usr/bin/pnpm install`、`/usr/bin/pnpm run build`、`REVISION` と ready marker の順で staging され、完成後だけ exact-SHA 名へ rename されます。ready な同一 SHA は再利用し、不完全・不正な既存 release は上書きしません。

fetch/build より前に、loaded user unit の `WorkingDirectory` を `systemctl --user show` で読み、`/home/minamorl/deploy/gear/current` と完全一致することを要求します。これにより、`current` の切替が service の実行元に反映されない構成ではデプロイを拒否します。

## 状態とログ

```bash
systemctl --user status gear-host.service
journalctl --user -u gear-host.service -f
readlink /home/minamorl/deploy/gear/current
```

永続状態は `/home/minamorl/deploy/gear/shared` に置かれ、release の切替や pruning では削除されません。service の標準出力・標準エラーは user journal で確認します。

## ヘルスチェックと rollback

ヘルスチェックは次の2条件**だけ**です。

1. `systemctl --user is-active --quiet gear-host.service`
2. `/home/minamorl/deploy/gear/shared/intake` が FIFO であること (`test -p`)

最大40回、各失敗後1秒 sleep します。HTTP server はなく、nginx・port・HTTP probe は一切使いません。FIFO へ health request を書き込むこともしません。

新 release が healthy にならなければ、`current` を直前の relative exact-SHA target へ原子的に戻して service を再起動し、同じ上限で rollback health check を行います。rollback が回復したかどうかを明示して、デプロイ自体は失敗終了します。直前 target がない初回デプロイでは rollback できません。失敗時は release を prune しません。

成功したときだけ、ready な exact-SHA release を新しい順に既定3世代残して prune します。現在の release と直前の rollback candidate は世代数の外に出ても必ず保護します。

## 決定値

| 項目 | 値 | 状態・補足 |
|---|---|---|
| Source checkout | `/home/minamorl/repos/gear-ts` | 既定値 |
| Deploy root | `/home/minamorl/deploy/gear` | 既定値 |
| Releases | `/home/minamorl/deploy/gear/releases` | 同一 filesystem staging |
| Current | `/home/minamorl/deploy/gear/current` | `releases/<40hex>` への relative symlink |
| Persistent state/shared | `/home/minamorl/deploy/gear/shared` | release 外 |
| FIFO | `/home/minamorl/deploy/gear/shared/intake` | health が存在と FIFO type を要求 |
| FIFO creation | **未実測** | deploy script は作成せず、host による作成・提供を期待 |
| FIFO actual mode | **未実測** | `UMask=0077` は新規 object の permission を制約 |
| Canonical env | `/home/minamorl/repos/gear-ts/.env` | mode は正確に `0600` |
| Release env | `<release>/.env` | canonical env への absolute symlink |
| User service | `gear-host.service` | `sudo` 不使用 |
| Unit source | `/home/minamorl/repos/gear-ts/deploy/gear-host.service` | repository 内 |
| Unit install path | `~/.config/systemd/user/gear-host.service` | user manager |
| Unit WorkingDirectory | `/home/minamorl/deploy/gear/current` | 固定 |
| Unit Environment | `NODE_ENV=production`; `GEAR_STATE_DIR=/home/minamorl/deploy/gear/shared` | 固定 |
| Unit EnvironmentFile | `/home/minamorl/deploy/gear/current/.env` | canonical release symlink 経由、必須 |
| Canonical env の systemd 構文互換性 | **未実測** | `EnvironmentFile` としての実 load は未実行 |
| Unit ExecStart | `/usr/bin/node dist/bin/host.js` | 固定 |
| Restart policy | `always`; `RestartSec=5` | 固定 |
| Process hardening | `UMask=0077`; `NoNewPrivileges=true` | 固定 |
| Node | `/usr/bin/node` v20.20.2 | 2026-08-25 実測 |
| pnpm | `/usr/bin/pnpm` v10.33.4 | 2026-08-25 直接実測、hard-code |
| Default ref | `origin/main` | deploy 前に fetch |
| Release name | exact 40-character lowercase commit SHA | 非 SHA は拒否 |
| Install/build | `/usr/bin/pnpm install`; `/usr/bin/pnpm run build` | server-side |
| Ready artifact | `dist/bin/host.js` | regular file 必須 |
| Revision file | `<release>/REVISION` | exact SHA を記録 |
| Ready marker | `<release>/.gear-release-ready` | build 後に作成 |
| Staging | `releases/.<SHA>.tmp.<PID>` | release と同一 filesystem、trap cleanup |
| Deploy lock | `/home/minamorl/deploy/gear/.deploy.lock` | nonblocking `flock`、新規 mode `0600` |
| Keep count | 3 generations | current と previous は追加保護 |
| Health conditions | user service active AND FIFO `test -p` | HTTP 条件なし |
| WorkingDirectory preflight | `systemctl --user show --property=WorkingDirectory --value gear-host.service` | `current` と完全一致必須 |
| Health attempts | 40 | rollback も同じ |
| Health interval | 1 second | 各失敗後 sleep |
| Health total sleep budget | 40 seconds | service command 自体の時間は除く |
| 新規 directory mode | `0700` | `umask 077` 下で作成。既存 mode は強制変更しない |
| systemd UMask | `0077` | unit 固定 |
| Unit install mode | `0644` | setup 手順の値 |
| FIFO request/response protocol | **未実測** | protocol probe は行わない |
| 実デプロイ結果 | **未実測** | この文書作成時は deploy script 未実行 |
| 実 service 起動・常駐結果 | **未実測** | unit の install/start 未実行 |
| 実 rollback 結果 | **未実測** | failure injection 未実施 |

nginx 設定、listen port、HTTP endpoint はありません。したがって port 公開や HTTP health probe もありません。

