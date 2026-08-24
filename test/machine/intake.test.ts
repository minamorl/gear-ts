import { describe, expect, it } from 'vitest';
import { Kit, MachineIntake, PROGRAM_SUBMIT_TAG } from '../../src/index.js';

function kit(): Kit {
  return Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['double'], depth: 1 });
}

describe('Machine.Intake', () => {
  it('issues sequential reproducible tickets', () => {
    const first = new MachineIntake();
    const second = new MachineIntake();
    const names = ['a', 'b', 'c'];
    const issuedFirst = names.map((name) => first.offer({ name }).ticket);
    const issuedSecond = names.map((name) => second.offer({ name }).ticket);

    expect(issuedFirst).toEqual([1, 2, 3]);
    expect(issuedSecond).toEqual(issuedFirst);
    expect(first.issued).toBe(3);
  });

  it('takes submissions in FIFO order', () => {
    const intake = new MachineIntake();
    intake.offer({ name: 'first' });
    intake.offer({ name: 'second' });

    expect(intake.take()?.name).toBe('first');
    expect(intake.take()?.name).toBe('second');
    expect(intake.take()).toBeUndefined();
    expect(intake.empty).toBe(true);
  });

  it('only queues when offering', () => {
    const intake = new MachineIntake();
    const granted = kit();
    const submission = intake.offer({ name: 'double', focus: { n: 2 }, kit: granted });

    expect(intake.size).toBe(1);
    expect(submission.name).toBe('double');
    expect(submission.focus).toEqual({ n: 2 });
    expect(submission.kit).toBe(granted);
  });

  it('defaults the seed to the ticket number', () => {
    const intake = new MachineIntake();
    expect(intake.offer({ name: 'a' }).seed).toBe(1);
    expect(intake.offer({ name: 'b', seed: 7 }).seed).toBe(7);
    expect(intake.offer({ name: 'zero', seed: 0 }).seed).toBe(0);
  });

  it('detaches and deeply freezes the accepted focus', () => {
    const intake = new MachineIntake();
    const source = { nested: { values: [1, 2] } };
    const submission = intake.offer({ name: 'deep', focus: source });
    source.nested.values[0] = 99;

    expect(submission.focus).toEqual({ nested: { values: [1, 2] } });
    expect(Object.isFrozen((submission.focus as { nested: object }).nested)).toBe(true);
  });

  it('serializes accepted submissions as JSON-safe plain data', () => {
    const intake = new MachineIntake();
    const record = intake.offer({ name: 'double', focus: { n: 2 }, kit: kit() }).toJSON();

    expect(record.ticket).toBe(1);
    expect(record.name).toBe('double');
    expect(record.kit).toEqual({
      ports: ['probe', PROGRAM_SUBMIT_TAG].sort(), programs: ['double'], depth: 1,
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('exposes pending as a detached view', () => {
    const intake = new MachineIntake();
    intake.offer({ name: 'a' });
    const pending = intake.pending as unknown[];
    pending.length = 0;
    expect(intake.size).toBe(1);
  });
});
