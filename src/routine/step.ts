import { z } from 'zod';

const EffectSummarySchema = z.object({
  tag: z.string(),
  payload: z.json(),
});

export const StepRecordSchema = z.object({
  tick: z.number().int(),
  tag: z.string(),
  payload: z.json(),
});

export interface StepRecord {
  readonly tick: number;
  readonly tag: string;
  readonly payload: z.infer<typeof StepRecordSchema>['payload'];
}

/** One journal-derived effect invocation in its original encounter position. */
export class Step implements StepRecord {
  readonly tick: number;
  readonly tag: string;
  readonly payload: StepRecord['payload'];

  constructor(record: StepRecord) {
    const parsed = StepRecordSchema.parse(record);
    this.tick = parsed.tick;
    this.tag = parsed.tag;
    this.payload = parsed.payload;
    Object.freeze(this);
  }

  static fromEffect(tick: number, effect: unknown): Step {
    const parsed = EffectSummarySchema.parse(effect);
    return new Step({ tick, tag: parsed.tag, payload: parsed.payload });
  }

  static fromObject(value: unknown): Step {
    return new Step(StepRecordSchema.parse(value));
  }

  with(input: Partial<StepRecord>): Step {
    return new Step({
      tick: input.tick ?? this.tick,
      tag: input.tag ?? this.tag,
      payload: Object.prototype.hasOwnProperty.call(input, 'payload')
        ? input.payload as StepRecord['payload']
        : this.payload,
    });
  }

  toJSON(): StepRecord {
    return { tick: this.tick, tag: this.tag, payload: this.payload };
  }
}
