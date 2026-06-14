import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { FieldEditor } from '@/engine/fieldEditor';
import type { OpenApiSchema } from '@/engine/types';

const renderField = (schema: OpenApiSchema, props = {}) => {
  const onChange = vi.fn();
  render(
    <FieldEditor
      name="agent_name"
      schema={schema}
      value=""
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
};

describe('FieldEditor', () => {
  test('renders a humanized label', () => {
    renderField({ type: 'string' });
    expect(screen.getByText('Agent Name')).toBeInTheDocument();
  });

  test('marks required fields with an asterisk', () => {
    renderField({ type: 'string' }, { required: true });
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  test('renders a text input and reports typing', async () => {
    const { onChange } = renderField({ type: 'string' });
    await userEvent.type(screen.getByLabelText(/agent name/i), 'x');
    expect(onChange).toHaveBeenCalledWith('x');
  });

  test('renders a number input for integer schemas', () => {
    renderField({ type: 'integer' });
    expect(screen.getByLabelText(/agent name/i)).toHaveAttribute(
      'type',
      'number'
    );
  });

  test('renders a select for enum schemas', () => {
    renderField({ type: 'string', enum: ['a', 'b'] });
    expect(screen.getByRole('option', { name: 'a' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'b' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: '— select —' })
    ).toBeInTheDocument();
  });

  test('renders a checkbox for boolean schemas and emits true/false', async () => {
    const { onChange } = renderField({ type: 'boolean' });
    const checkbox = screen.getByRole('checkbox');
    await userEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith('true');
  });

  test('renders a textarea for object schemas', () => {
    renderField({ type: 'object' });
    expect(screen.getByLabelText(/agent name/i).tagName).toBe('TEXTAREA');
  });
});
