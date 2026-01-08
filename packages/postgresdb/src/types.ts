import { DataType } from '@ttoss/postgresdb';

export class VectorType extends DataType.ABSTRACT {
  constructor(private dimension: number) {
    super();
  }

  toSql() {
    return `VECTOR(${this.dimension})`;
  }

  sanitize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // ignore
      }
    }
    return value;
  }

  validate(value: unknown): void {
    if (!Array.isArray(value)) {
      throw new Error('Value must be an array');
    }
    if (value.length !== this.dimension) {
      throw new Error(`Vector must have ${this.dimension} dimensions`);
    }
    for (const v of value) {
      if (typeof v !== 'number') {
        throw new Error('All elements must be numbers');
      }
    }
  }

  parseDatabaseValue(value: unknown): number[] {
    if (typeof value === 'string') {
      // Assuming it's stored as JSON string
      return JSON.parse(value);
    }
    return value as number[];
  }

  toBindableValue(value: number[]): unknown {
    return JSON.stringify(value);
  }
}

export const VECTOR = (dimension: number) => {
  return new VectorType(dimension);
};
