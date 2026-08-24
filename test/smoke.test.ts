import { describe, it, expect } from 'vitest';

// 移植前の足場。--passWithNoTests は使わない —— テストが一本も無い状態が
// 緑になると「移植したがテストを書いていない」を検出できなくなるため。
// 本物のテスト (Ruby 側 test/spec の移植) が入った時点でこのファイルは消す。
describe('@minamorl/gear', () => {
  it('パッケージが読み込める', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeTypeOf('object');
  });
});
