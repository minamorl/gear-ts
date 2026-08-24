import { z } from 'zod';
import { Adapter } from './core.js';

export const TIME_NOW_TAG = 'time_now' as const;
export const TimeNowPayload = z.object({});
export const TimeNowResult = z.object({ epoch_seconds: z.number() });

export function buildTimeAdapter(now: () => number = () => Date.now() / 1000): Adapter {
  return new Adapter('time').operation(TIME_NOW_TAG, TimeNowPayload, TimeNowResult, () => ({
    epoch_seconds: now(),
  }));
}

export const TimeAdapter = buildTimeAdapter();
export const TimeNow = Object.freeze({
  TAG: TIME_NOW_TAG,
  PAYLOAD: TimeNowPayload,
  RESULT: TimeNowResult,
  build: buildTimeAdapter,
  ADAPTER: TimeAdapter,
});
