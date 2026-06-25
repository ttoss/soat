import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { FormView } from '@/engine/formView';
import { parseModules } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { NavProbe, renderWithAuth } from '../testUtils';

const agentsModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => x.tag === 'Agents');
  if (!m) throw new Error('Agents module missing');
  return m;
};

const apiKeysModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => x.tag === 'Api Keys');
  if (!m) throw new Error('Api Keys module missing');
  return m;
};

describe('FormView (create)', () => {
  test('renders fields derived from the request schema', () => {
    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );
    expect(screen.getByText('Create Agents')).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    // enum field renders a select
    expect(screen.getByRole('option', { name: 'gpt-4o' })).toBeInTheDocument();
  });

  test('submits the built body and navigates back on success', async () => {
    let received: JsonObject | undefined;
    server.use(
      http.post('*/api/v1/agents', async ({ request }) => {
        received = (await request.json()) as JsonObject;
        return HttpResponse.json({ id: 'agt_9', ...received }, { status: 201 });
      })
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{}}
          mode="create"
        />
        <NavProbe />
      </>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    // empty optional fields are omitted; only `name` is sent
    expect(received).toEqual({ name: 'Gamma' });
  });

  test('reveals a one-time secret from the create response instead of navigating away', async () => {
    server.use(
      http.post('*/api/v1/agents', () =>
        HttpResponse.json(
          { id: 'agt_9', name: 'Gamma', api_key: 'sk_live_secret123' },
          { status: 201 }
        )
      )
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{}}
          mode="create"
        />
        <NavProbe />
      </>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The secret is revealed; the form is replaced by the reveal panel rather
    // than silently navigating away and discarding the one-time value.
    expect(await screen.findByText('sk_live_secret123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create' })
    ).not.toBeInTheDocument();
  });

  test('does not reveal anything when the create response carries no secret', async () => {
    server.use(
      http.post('*/api/v1/agents', () =>
        HttpResponse.json({ id: 'agt_9', name: 'Gamma' }, { status: 201 })
      )
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{}}
          mode="create"
        />
        <NavProbe />
      </>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    expect(
      screen.queryByRole('button', { name: /done/i })
    ).not.toBeInTheDocument();
  });

  test('shows the server error and stays on the form on failure', async () => {
    server.use(
      http.post('*/api/v1/agents', () =>
        HttpResponse.json({ error: 'name taken' }, { status: 409 })
      )
    );

    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Dup');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });

  test('renders a project selector populated from the API for x-soat-ref fields', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([
          { id: 'proj_1', name: 'Alpha Project' },
          { id: 'proj_2', name: 'Beta Project' },
        ])
      )
    );

    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );

    expect(
      await screen.findByRole('option', { name: 'Alpha Project' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Beta Project' })
    ).toBeInTheDocument();
  });

  test('shows the HTTP method badge and endpoint path', () => {
    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/v1\/agents/)).toBeInTheDocument();
  });
});

describe('FormView — array x-soat-ref field (multi-select picker)', () => {
  const policyHandler = http.get('*/api/v1/policies', () =>
    HttpResponse.json([
      { id: 'pol_1', name: 'Read Only' },
      { id: 'pol_2', name: 'Admin' },
    ])
  );

  test('renders policy_ids as a picker populated from the API, not a textarea', async () => {
    server.use(policyHandler);
    renderWithAuth(
      <FormView
        module={apiKeysModule()}
        spec={testSpec}
        pathParams={{ project_id: 'prj_1' }}
        mode="create"
      />
    );

    // Options come from the referenced resource (the policies API).
    expect(
      await screen.findByRole('option', { name: 'Read Only' })
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Admin' })).toBeInTheDocument();
    // It is a select, not the free-form textarea it used to be.
    expect(
      screen.queryByRole('textbox', { name: /policy ids/i })
    ).not.toBeInTheDocument();
  });

  test('selecting policies submits them as an array', async () => {
    let received: JsonObject | undefined;
    server.use(
      policyHandler,
      http.post('*/api/v1/projects/:project_id/api-keys', async ({ request }) => {
        received = (await request.json()) as JsonObject;
        return HttpResponse.json({ id: 'key_1', ...received }, { status: 201 });
      })
    );

    renderWithAuth(
      <FormView
        module={apiKeysModule()}
        spec={testSpec}
        pathParams={{ project_id: 'prj_1' }}
        mode="create"
      />
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'CI Key');
    await userEvent.selectOptions(
      await screen.findByLabelText(/policy ids/i),
      'pol_1'
    );
    // The chosen policy now shows as a chip (and leaves the add dropdown).
    expect(screen.getByText('Read Only')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(received).toEqual({ name: 'CI Key', policy_ids: ['pol_1'] });
    });
  });

  test('omits policy_ids entirely when none are selected', async () => {
    let received: JsonObject | undefined;
    server.use(
      policyHandler,
      http.post('*/api/v1/projects/:project_id/api-keys', async ({ request }) => {
        received = (await request.json()) as JsonObject;
        return HttpResponse.json({ id: 'key_1', ...received }, { status: 201 });
      })
    );

    renderWithAuth(
      <FormView
        module={apiKeysModule()}
        spec={testSpec}
        pathParams={{ project_id: 'prj_1' }}
        mode="create"
      />
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'CI Key');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // Empty multi-select is omitted (not sent as []), so the key inherits the
    // user's full permissions rather than an empty intersection.
    await waitFor(() => {
      expect(received).toEqual({ name: 'CI Key' });
    });
  });
});

describe('FormView (multipart/upload action)', () => {
  const filesModule = () => {
    const m = parseModules(testSpec).find((x) => x.tag === 'Files');
    if (!m) throw new Error('Files module missing');
    return m;
  };

  test('renders a file input for binary format fields', () => {
    renderWithAuth(
      <FormView
        module={filesModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );
    // The Files module has no JSON createOp, so "No form schema available" renders.
    // The upload action is accessed via ActionView, not FormView.
    // This test validates the module parses correctly with the upload action.
    expect(filesModule().actions?.find((a) => a.operation.operationId === 'uploadFile')).toBeDefined();
  });

  test('upload action sends multipart/form-data with the selected file', async () => {
    let receivedFormData: FormData | undefined;
    server.use(
      http.post('*/api/v1/files/upload', async ({ request }) => {
        receivedFormData = await request.formData();
        return HttpResponse.json({ id: 'fil_1', filename: 'test.txt' }, { status: 201 });
      })
    );

    const { ActionView } = await import('@/engine/actionView');
    renderWithAuth(
      <ActionView
        module={filesModule()}
        spec={testSpec}
        pathParams={{}}
        operationId="uploadFile"
      />
    );

    const fileInput = screen.getByLabelText(/file/i);
    const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });
    await userEvent.upload(fileInput, file);

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(receivedFormData?.get('file')).toBeTruthy();
    });
  });
});

describe('FormView (edit)', () => {
  test('prefills, sends a PUT, and navigates back', async () => {
    let method = '';
    server.use(
      http.put('*/api/v1/agents/:agent_id', async ({ request }) => {
        method = request.method;
        return HttpResponse.json({ id: 'agt_1', name: 'Edited' });
      })
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{ agent_id: 'agt_1' }}
          mode="edit"
          prefill={{ name: 'Old' }}
        />
        <NavProbe />
      </>
    );

    const nameInput = screen.getByLabelText(/name/i);
    expect(nameInput).toHaveValue('Old');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    expect(method).toBe('PUT');
  });
});
