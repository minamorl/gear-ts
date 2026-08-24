import type { EffectRequestLike } from './request.js';
import { Request } from './request.js';
import type { Policy } from './policy.js';

export { Request, type EffectRequestLike } from './request.js';
export { Grant, Admitted, Denied, Verdict, type VerdictValue } from './verdict.js';
export { AllowAll, DenyAll, ByKit, All, Policy, type KitAuthority } from './policy.js';
export type { Policy as PolicyContract } from './policy.js';

export function judge(request: Request, policy: Policy): ReturnType<Policy['judge']> {
  return policy.judge(request);
}

export function judgeEffect(effect: EffectRequestLike, policy: Policy): ReturnType<Policy['judge']> {
  return judge(Request.fromEffect(effect), policy);
}
