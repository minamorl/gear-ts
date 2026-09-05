export interface KitOptions {
  readonly ports?: Iterable<string>;
  readonly programs?: Iterable<string>;
  readonly depth?: number;
}

export interface KitDeclaration {
  readonly ports: readonly string[];
  readonly programs: readonly string[];
  readonly depth: number;
}

function names(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(Array.from(values, String))].sort());
}

function depthOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('depth must be a non-negative safe integer');
  }
  return value;
}

/** JSON-safe authority handed to a program. It can only be attenuated. */
export class Kit {
  static readonly FOCUS_KEY = 'gear_kit' as const;

  readonly ports: readonly string[];
  readonly programs: readonly string[];
  readonly depth: number;

  private constructor(options: Required<KitOptions>) {
    this.ports = names(options.ports);
    this.programs = names(options.programs);
    this.depth = depthOf(options.depth);
    Object.freeze(this);
  }

  static of(options: KitOptions = {}): Kit {
    return new Kit({
      ports: options.ports ?? [],
      programs: options.programs ?? [],
      depth: options.depth ?? 0,
    });
  }

  static nothing(): Kit {
    return Kit.of();
  }

  static fromJSON(value: unknown): Kit {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Kit declaration must be an object');
    }
    const declaration = value as Partial<Record<keyof KitDeclaration, unknown>>;
    if (declaration.ports !== undefined && !Array.isArray(declaration.ports)) {
      throw new TypeError('Kit ports must be an array');
    }
    if (declaration.programs !== undefined && !Array.isArray(declaration.programs)) {
      throw new TypeError('Kit programs must be an array');
    }
    return Kit.of({
      ports: (declaration.ports ?? []) as readonly string[],
      programs: (declaration.programs ?? []) as readonly string[],
      depth: declaration.depth === undefined ? 0 : Number(declaration.depth),
    });
  }

  static fromObject(value: unknown): Kit {
    return Kit.fromJSON(value);
  }

  port(tag: string): boolean {
    return this.ports.includes(String(tag));
  }

  program(name: string): boolean {
    return this.programs.includes(String(name));
  }

  submit(): boolean {
    return this.depth > 0 && this.programs.length > 0;
  }

  narrow(options: KitOptions = {}): Kit {
    const requestedPorts = options.ports === undefined ? this.ports : names(options.ports);
    const requestedPrograms =
      options.programs === undefined ? this.programs : names(options.programs);
    return Kit.of({
      ports: requestedPorts.filter((tag) => this.ports.includes(tag)),
      programs: requestedPrograms.filter((name) => this.programs.includes(name)),
      depth: Math.min(options.depth ?? this.depth, this.depth),
    });
  }

  descend(options: Omit<KitOptions, 'depth'> = {}): Kit {
    return this.narrow({ ...options, depth: Math.max(this.depth - 1, 0) });
  }

  toJSON(): KitDeclaration {
    return {
      ports: [...this.ports],
      programs: [...this.programs],
      depth: this.depth,
    };
  }
}

export const FOCUS_KEY = Kit.FOCUS_KEY;
